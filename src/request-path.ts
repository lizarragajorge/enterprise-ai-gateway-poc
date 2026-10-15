import type { CallResult, Model } from '../server/gateway.ts';
import { modelProvider } from '../server/gateway.ts';
import { hasModelResponse } from '../server/model-response.ts';
export { hasModelResponse } from '../server/model-response.ts';

export interface RequestContext {
  application: string;
  model?: Model;
  automatic?: boolean;
}
export type RequestObservation =
  | { phase: 'idle' }
  | { phase: 'pending'; request: RequestContext }
  | { phase: 'local-refusal'; request: RequestContext }
  | { phase: 'local-error'; request: RequestContext }
  | { phase: 'result'; request: RequestContext; result: CallResult };
export interface PathStep {
  kind: 'application' | 'gateway' | 'model' | 'proxy';
  label: string;
  detail: string;
  state: 'local' | 'observed' | 'error' | 'unknown';
}
export function modelPathNode(model: Model): 'azure' | 'aws' | 'gcp' | 'databricks' {
  return modelProvider(model) === 'databricks' ? 'databricks' : model.cloud;
}

export function modelCoverage(models: readonly Model[], successes?: ReadonlySet<string>) {
  const selected = successes ? models.filter(model => successes.has(model.id)) : models;
  return {
    models: selected.length,
    providers: new Set(selected.map(modelProvider)).size,
    clouds: new Set(selected.map(model => model.cloud)).size
  };
}

export function observedRequestPath(observation: RequestObservation): PathStep[] {
  if (observation.phase === 'idle') return [];
  const application: PathStep = {
    kind: 'application', label: `Application ${observation.request.application}`,
    detail: 'Local caller selection', state: 'local'
  };
  if (observation.phase === 'pending') {
    return [application, {
      kind: 'gateway', label: 'Gateway endpoint',
      detail: 'Receipt unconfirmed', state: 'unknown'
    }];
  }
  if (observation.phase === 'local-refusal') {
    return [application, {
      kind: 'proxy', label: 'Local router refused',
      detail: 'No gateway or model call made', state: 'error'
    }];
  }
  if (observation.phase === 'local-error' || observation.result.source === 'local-error') {
    return [application, {
      kind: 'proxy', label: 'Local request failed',
      detail: 'Gateway / model execution unknown', state: 'error'
    }];
  }
  const result = observation.result;
  if (result.outcome?.gatewayCallMade === false) return [application, {
    kind: 'proxy', label: 'Custom PoC refused', detail: 'No gateway or model call made', state: 'error'
  }];
  const success = hasModelResponse(result);
  const unsupported = result.status >= 200 && result.status < 300 && !success;
  const selection: PathStep[] = result.routing ? [{
    kind: 'proxy', label: 'Custom PoC selection',
    detail: `${result.routing.policy.label} · ${result.routing.policy.version} · ${result.routing.decisiveReason}`,
    state: 'local'
  }] : [];
  const gateway: PathStep = {
    kind: 'gateway', label: 'Gateway endpoint',
    detail: result.outcome?.enforcementBoundary === 'native-gateway-policy'
      ? `HTTP ${result.status} - verified native ${result.outcome.nativeControl === 'content-safety' ? 'Content Safety stop' : 'gateway policy rejection'}; model not called`
      : success ? `HTTP ${result.status}`
      : unsupported ? `HTTP ${result.status} - no supported model text`
        : `HTTP ${result.status} - origin unconfirmed`,
    state: success ? 'observed' : 'error'
  };
  if (!success) return [application, ...selection, gateway];
  return [application, ...selection, gateway, {
    kind: 'model',
    label: result.returnedModel || (observation.request.model
      ? `${observation.request.model.cloud.toUpperCase()} / ${observation.request.model.id}` : 'Model name unavailable'),
    detail: observation.request.model && modelProvider(observation.request.model) === 'databricks'
      ? 'Databricks on Azure; path inferred from configuration, not a gateway trace'
      : result.returnedModel ? 'Reported model; path inferred'
      : observation.request.model ? 'Configured model; name unavailable' : 'No reported or resolved configured name',
    state: 'observed'
  }];
}
