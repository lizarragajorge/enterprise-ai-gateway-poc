import type { AppId, CallResult, GatewayId, GatewayType } from './gateway.ts';
import type { RoutingCandidate, RoutingRejection } from './routing.ts';
import type { RoutingPolicy } from './routing-policy.ts';
import type { WorkloadId } from './workloads.ts';
import { hasModelResponse } from './model-response.ts';

export interface BoundaryContext {
  correlationId: string;
  decisionId: string;
  policy: RoutingPolicy;
}
export interface RequestOutcome {
  kind: 'model-response' | 'gateway-error' | 'unsupported-response' | 'local-refusal' | 'local-validation-error'
    | 'configuration-unavailable' | 'transport-error' | 'timeout' | 'cancelled';
  enforcementBoundary: 'none' | 'local-poc' | 'native-gateway-policy' | 'unknown-upstream';
  gatewayCallMade: boolean;
  nativeControl?: 'content-safety';
  recovery: string | null;
}
export function gatewayOutcome(result: CallResult, nativePolicyVerified: boolean | 'content-safety' = false): RequestOutcome {
  if (result.source === 'local-error') {
    return {
      kind: result.transportFailure === 'timeout' ? 'timeout' : result.transportFailure === 'cancelled' ? 'cancelled' : 'transport-error',
      enforcementBoundary: 'none', gatewayCallMade: true,
      recovery: result.transportFailure === 'timeout'
        ? 'The local 60-second timeout elapsed. Check gateway/backend health before retrying; model execution is unknown and there is no automatic retry.'
        : result.transportFailure === 'cancelled' ? 'The client disconnected. Check the correlated server event before resending; upstream execution is unknown.'
          : 'Check local TLS/network access and gateway availability. No retry or fallback occurred; upstream execution is unknown.'
    };
  }
  if (hasModelResponse(result)) return { kind: 'model-response', enforcementBoundary: 'none', gatewayCallMade: true, recovery: null };
  const safety = nativePolicyVerified === 'content-safety';
  const recovery = safety
    ? 'Native Content Safety blocked this request. Review the configured safety policy and use the fixed harmless allow test; do not bypass the policy or change aliases to evade it.'
    : result.status === 429
    ? `Wait ${result.headers['retry-after'] ? 'the returned Retry-After interval' : 'for capacity or the configured limit window'} before retrying. ${nativePolicyVerified ? 'This matches the verified native gateway policy.' : 'A gateway response alone does not identify which gateway/backend enforced this limit.'}`
    : result.status === 401 || result.status === 403
      ? 'Check the selected profile runtime key and backend identity permissions. Do not swap in backend credentials; the rejection origin is unknown unless separately verified.'
      : result.status === 504 || result.status === 408
        ? 'Check gateway/backend timeout settings and availability before retrying. This response does not prove where the timeout occurred.'
        : nativePolicyVerified ? 'Use the configured allowed alias, then rerun. This is native model-allowlist enforcement, not caller isolation.'
          : 'Inspect the collapsed response and upstream request IDs. Check the selected model configuration; no fallback was attempted.';
  return { kind: result.status >= 200 && result.status < 300 ? 'unsupported-response' : 'gateway-error',
    enforcementBoundary: nativePolicyVerified ? 'native-gateway-policy' : 'unknown-upstream', gatewayCallMade: true,
    ...(safety ? { nativeControl: 'content-safety' as const } : {}), recovery };
}
export function localOutcome(kind: 'local-refusal' | 'local-validation-error' | 'configuration-unavailable', message: string): RequestOutcome {
  const recovery = /^Evaluation changed\./i.test(message)
    ? 'Reload the genuine report and review its current run ID before resending. A stale client does not require another evaluation run.'
    : /evaluation.*(expired|missing|changed)/i.test(message) || /workload evaluation/i.test(message)
    ? 'Run evaluate:routing for this profile, then reload genuine evidence. Approvals expire after 24 hours; do not edit or extend them.'
    : /price/i.test(message) ? 'Review current prices and reload the current price version before resending.'
      : /policy.*changed/i.test(message) ? 'Reload the server policy and review the expected choice before resending the unchanged request.'
        : kind === 'configuration-unavailable' ? 'Configure this profile and caller key on the server; do not provide credentials in the browser.'
          : /no approved model/i.test(message) ? 'Choose an evaluated workload, or obtain genuine approval for an eligible model. Business policy cannot grant quality approval.'
            : /in progress/i.test(message) ? 'Wait for the existing request for this application to finish before resending.'
              : 'Review the declared workload and request fields. No gateway or model call was made.';
  return { kind, enforcementBoundary: 'local-poc', gatewayCallMade: false, recovery };
}
export interface RequestEvent {
  event: 'ai-request-outcome';
  recordedAt: string;
  correlationId: string;
  decisionId: string;
  gatewayId: GatewayId | null;
  gatewayType: GatewayType | null;
  application: AppId | null;
  workload: WorkloadId | 'manual' | 'governance-proof' | null;
  policy: RoutingPolicy | null;
  exclusions: { model: string; kinds: string[]; reasons: string[] }[];
  // Selection intent only; these fields do not establish provider/model execution.
  selectedProvider: string | null;
  selectedModel: string | null;
  requestedAlias: string | null;
  selectionReason: string | null;
  evaluationId: string | null;
  outcome: RequestOutcome;
  status: number;
  tokens: CallResult['tokens'];
  nodeToGatewayRoundTripMs: number | null;
  estimatedTokenCostUsd: number | null;
  upstreamRequestIds: Record<string, string>;
}
export function requestEvent(context: BoundaryContext, details: {
  gatewayId?: GatewayId; gatewayType?: GatewayType; application?: AppId;
  workload?: RequestEvent['workload']; status: number; outcome: RequestOutcome;
  result?: CallResult; rejection?: RoutingRejection;
}): RequestEvent {
  const result = details.result;
  const hideSelection = result?.model === 'demo-policy-refusal'
    || (details.outcome.nativeControl === 'content-safety' && !result?.routing);
  const candidates: RoutingCandidate[] = result?.routing?.candidates || details.rejection?.candidates || [];
  const upstreamRequestIds: Record<string, string> = {};
  for (const name of ['x-request-id', 'apim-request-id', 'traceparent', 'x-ms-request-id']) {
    const value = result?.headers[name];
    const valid = name === 'traceparent' ? /^[a-f0-9]{2}-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/i
      : /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{16,128}|req_[a-z0-9]{6,128})$/i;
    if (value && valid.test(value)) upstreamRequestIds[name] = value;
  }
  return {
    event: 'ai-request-outcome', recordedAt: new Date().toISOString(),
    correlationId: context.correlationId, decisionId: result?.routing?.decisionId || details.rejection?.decisionId || context.decisionId,
    gatewayId: details.gatewayId || result?.gatewayId || null, gatewayType: details.gatewayType || result?.gatewayType || null,
    application: details.application || null, workload: details.workload || null,
    policy: details.workload && !['manual', 'governance-proof'].includes(details.workload)
      ? result?.routing?.policy || details.rejection?.policy || context.policy : null,
    exclusions: candidates.filter(candidate => !candidate.eligible).map(candidate => ({
      model: candidate.price.publishedName, kinds: (candidate.exclusions || []).map(exclusion => exclusion.kind),
      reasons: (candidate.exclusions || []).map(exclusion => exclusion.reason)
    })),
    selectedProvider: hideSelection ? null : result?.provider || null,
    selectedModel: hideSelection ? null : result?.model || null, requestedAlias: result?.model || null,
    selectionReason: result?.routing?.decisiveReason || details.rejection?.decisiveReason || null,
    evaluationId: result?.routing?.evaluationId || details.rejection?.evaluationId || null,
    outcome: details.outcome, status: details.status, tokens: result?.tokens || null,
    nodeToGatewayRoundTripMs: result?.latencyMs ?? null, estimatedTokenCostUsd: result?.routing?.usageCostUsd ?? result?.estimatedTokenCostUsd ?? null, upstreamRequestIds
  };
}
export function logRequestEvent(event: RequestEvent): void {
  console.info(JSON.stringify(event));
}
