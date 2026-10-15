import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { callGateway, validateInput } from './gateway.ts';
import { CostRouter, RoutingError, validateCostInput } from './routing.ts';
import type { CostInput, RoutingRejection } from './routing.ts';
import type { CallInput, CallResult, Config, AppId } from './gateway.ts';
import { readEvaluation, evaluationFile } from './evaluation.ts';
import { isWorkloadId } from './workloads.ts';
import { gatewayIds, loadProfiles, publicProfiles, validateGatewayId } from './profiles.ts';
import { readProfileEvidence } from './profile-evidence.ts';
import { PolicyConflict, RoutingPolicyStore } from './routing-policy.ts';
import { gatewayOutcome, localOutcome, logRequestEvent, requestEvent } from './request-evidence.ts';
import type { RequestEvent, RequestOutcome } from './request-evidence.ts';
import { RequestAudit } from './request-audit.ts';
import { governanceInput, nativePolicyMatched, publicGovernanceProof, readGovernanceProof } from './governance.ts';
import type { GovernanceProof } from './governance.ts';
import { contentSafetyInput, nativeSafetyMatched, publicContentSafetyEvidence, readContentSafetyEvidence } from './content-safety.ts';
import { modelPrices, pricedUsage, PRICE_VALID_UNTIL } from './model-pricing.ts';

const profiles = loadProfiles(process.env);
const requestAudit = new RequestAudit();
function recordRequestEvent(event: RequestEvent) {
  logRequestEvent(event);
  requestAudit.record(event);
}
const routingPolicies = new RoutingPolicyStore();
const routers = Object.fromEntries(gatewayIds.map(id => [id, new CostRouter(profiles[id], undefined, Date.now, readEvaluation(evaluationFile(id)), routingPolicies)]));
const evidence = Object.fromEntries(gatewayIds.map(id => [id, readProfileEvidence(profiles[id])]));
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
const root = resolve('dist');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const context = { correlationId: crypto.randomUUID(), decisionId: crypto.randomUUID(), policy: routingPolicies.current() };
  res.setHeader('x-correlation-id', context.correlationId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
    if (req.method === 'POST' && ['/api/request', '/api/routing/request', '/api/governance/request', '/api/content-safety/request'].includes((req.url || '').split('?')[0])) {
      recordRequestEvent(requestEvent(context, { status: 403, outcome: localOutcome('local-validation-error', 'Unapproved Host header.') }));
    }
    json(403, { error: 'Unapproved Host header.' }); return;
  }
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    json(200, publicProfiles(profiles)); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/routing-policy') {
    json(200, routingPolicies.snapshot()); return;
  }
  let selectedId;
  if (req.method === 'GET' && ['/api/gateway-policies', '/api/gateway-monitoring', '/api/request-audit', '/api/routing', '/api/governance-proof', '/api/content-safety'].includes(url.pathname)) {
    try { selectedId = validateGatewayId(url.searchParams.get('gateway')); }
    catch (error) { json(400, { error: (error as Error).message }); return; }
  }
  if (req.method === 'GET' && url.pathname === '/api/request-audit') {
    json(200, requestAudit.snapshot(selectedId!)); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/content-safety') {
    try {
      const proof = readContentSafetyEvidence(profiles[selectedId!]);
      if (!proof) {
        json(503, { gatewayId: selectedId, error: selectedId === 'apim-v2'
          ? 'Content Safety not configured or verified for APIM Premium v2. Standalone evidence is not inherited.'
          : 'Native Content Safety evidence unavailable for this standalone profile. Proof actions disabled.' });
      } else json(200, publicContentSafetyEvidence(proof));
    } catch {
      console.error('Native Content Safety evidence could not be validated.');
      json(500, { gatewayId: selectedId, error: 'Native Content Safety evidence invalid. Inspect profile, asset binding and genuine observations.' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/governance-proof') {
    try {
      const proof = readGovernanceProof(profiles[selectedId!]);
      if (!proof) {
        const alternative = selectedId === 'ai-gateway' ? readGovernanceProof(profiles['apim-v2']) : undefined;
        json(503, { gatewayId: selectedId, error: 'No attributable native governance proof for this profile.',
          ...(alternative ? { availableGatewayId: alternative.gatewayId, alternative: alternative.kind, standaloneBlocker: alternative.standaloneBlocker,
            guidance: 'Select APIM Premium v2 for the verified model-allowlist alternative. It is not caller-isolation proof.' } : {}) });
        return;
      }
      json(200, publicGovernanceProof(proof));
    } catch {
      console.error('Native governance evidence could not be validated.');
      json(500, { error: 'Native governance evidence invalid. Inspect its profile binding and matching policy before testing.' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/gateway-policies') {
    const policyEvidence = evidence[selectedId!].policy;
    if (!policyEvidence) { json(503, { gatewayId: selectedId, error: `${selectedId} policy snapshot missing. No policy proof available for this profile.` }); return; }
    json(200, { ...policyEvidence, gatewayId: selectedId, gatewayType: profiles[selectedId!].gatewayType }); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/gateway-monitoring') {
    const monitoringEvidence = evidence[selectedId!].monitoring;
    if (!monitoringEvidence) { json(503, { gatewayId: selectedId, error: `${selectedId} monitoring snapshot missing. No telemetry proof available for this profile.` }); return; }
    json(200, { ...monitoringEvidence, gatewayId: selectedId, gatewayType: profiles[selectedId!].gatewayType }); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/routing') {
    const app = url.searchParams.get('app');
    const workload = url.searchParams.get('workload') || 'extract-record';
    if (app !== 'A' && app !== 'B') {
      console.warn('Rejected routing snapshot: invalid application.');
      json(400, { error: 'Select application A or B.' }); return;
    }
    if (!isWorkloadId(workload)) {
      console.warn('Rejected routing snapshot: invalid workload.');
      json(400, { error: 'Select a supported workload.' }); return;
    }
    json(200, routers[selectedId!].snapshot(app, workload)); return;
  }
  if (req.method === 'POST' && ['/api/request', '/api/routing/request', '/api/routing-policy', '/api/reload-evidence', '/api/governance/request', '/api/content-safety/request'].includes(url.pathname)) {
    const modelRequest = ['/api/request', '/api/routing/request', '/api/governance/request', '/api/content-safety/request'].includes(url.pathname);
    let config: Config | undefined;
    let application: AppId | undefined;
    let workload: RequestEvent['workload'] = url.pathname === '/api/request' ? 'manual'
      : ['/api/governance/request', '/api/content-safety/request'].includes(url.pathname) ? 'governance-proof' : null;
    const refuse = (status: number, error: string, extra: { gatewayId?: string; gatewayType?: string; snapshot?: unknown; rejection?: RoutingRejection } = {}) => {
      const rejection = extra.rejection;
      const outcome = localOutcome(status === 503 ? 'configuration-unavailable' : status === 400 || status === 403 || status === 413 || status === 415 ? 'local-validation-error' : 'local-refusal', error);
      const event = requestEvent(context, { gatewayId: config?.gatewayId, gatewayType: config?.gatewayType, application, workload, status, outcome, rejection });
      if (modelRequest) recordRequestEvent(event);
      if (!res.destroyed) json(status, { error, ...extra, ...(modelRequest ? { correlationId: context.correlationId, decisionId: event.decisionId, outcome, evidence: event,
        policy: workload && !['manual', 'governance-proof'].includes(workload) ? context.policy : null } : {}) });
    };
    const classify = (result: CallResult): RequestOutcome => {
      if (config) {
        try {
          const proof = readContentSafetyEvidence(config);
          if (proof && nativeSafetyMatched(result, config, proof)) return gatewayOutcome(result, 'content-safety');
        } catch {
          console.error('Native Content Safety evidence invalid; upstream enforcement remains unknown.');
          const outcome = gatewayOutcome(result);
          if (outcome.enforcementBoundary === 'unknown-upstream') outcome.recovery += ' Native Content Safety evidence could not be validated; refresh safety evidence to inspect the error.';
          return outcome;
        }
      }
      return gatewayOutcome(result);
    };
    const respond = (result: CallResult, outcome: RequestOutcome = classify(result), localStatus?: number) => {
      const price = modelPrices.find(price => price.reportedModel === result.returnedModel);
      result = { ...result, estimatedTokenCostUsd: result.routing ? result.routing.usageCostUsd :
        (price && Date.now() < Date.parse(PRICE_VALID_UNTIL) ? pricedUsage(result, price).costUsd : null) };
      const event = requestEvent(context, { gatewayId: config?.gatewayId, gatewayType: config?.gatewayType, application, workload,
        status: result.status, outcome, result });
      recordRequestEvent(event);
      if (!res.destroyed) json(localStatus || (result.source === 'local-error' ? 502 : 200), { ...result, correlationId: context.correlationId,
        decisionId: event.decisionId, outcome, evidence: event });
    };
    const origin = req.headers.origin;
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      refuse(403, 'Requests must originate from the local demo page.'); return;
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      refuse(415, 'Content-Type must be application/json.'); return;
    }
    let input: CallInput;
    let costInput: CostInput | undefined;
    let router;
    let reloading = false;
    let nativeProof: GovernanceProof | undefined;
    let governanceTarget: Config | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 40000) {
          refuse(413, 'Request exceeds the 40 KB demo limit.'); return;
        }
        chunks.push(chunk);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/api/routing-policy') {
        try {
          routingPolicies.select(value);
          json(200, routingPolicies.snapshot());
        } catch (error) {
          console.warn('Routing policy selection rejected:', error instanceof Error ? error.message : 'Invalid selection.');
          json(error instanceof PolicyConflict ? 409 : 400, { error: error instanceof Error ? error.message : 'Invalid selection.', ...routingPolicies.snapshot() });
        }
        return;
      }
      selectedId = validateGatewayId(value && typeof value === 'object' ? (value as Record<string, unknown>).gatewayId : undefined);
      config = profiles[selectedId];
      router = routers[selectedId];
      if (['url', 'origin', 'headers', 'header', 'path', 'authHeader', 'gatewayOrigin'].some(key => key in (value as Record<string, unknown>))) {
        throw new Error('Browser requests cannot override server gateway transport configuration.');
      }
      const submittedApp = (value as Record<string, unknown>).app;
      if (submittedApp === 'A' || submittedApp === 'B') application = submittedApp;
      if (url.pathname === '/api/reload-evidence') {
        reloading = true;
        const refreshed = readEvaluation(evaluationFile(selectedId));
        const refreshedEvidence = readProfileEvidence(config);
        router.reloadEvaluation(refreshed);
        evidence[selectedId] = refreshedEvidence;
        json(200, { gatewayId: selectedId, reloadedAt: new Date().toISOString(), policy: context.policy,
          evaluation: router.snapshot('A').evaluation || null });
        return;
      }
      if (url.pathname === '/api/content-safety/request') {
        const proof = readContentSafetyEvidence(config);
        if (!proof) throw new RoutingError(503, selectedId === 'apim-v2'
          ? 'Content Safety not configured or verified for APIM Premium v2; no evidence inheritance.'
          : 'No matching native Content Safety evidence for this standalone profile.');
        input = contentSafetyInput(value, config, proof);
      } else if (url.pathname === '/api/governance/request') {
        nativeProof = readGovernanceProof(config);
        if (!nativeProof) throw new RoutingError(503, 'No verified native governance proof for this profile. Select the profile with matching saved policy evidence.');
        const test = governanceInput(value, config, nativeProof);
        governanceTarget = test.config;
        input = test.input;
      } else if (url.pathname === '/api/request') input = validateInput(value, config);
      else {
        costInput = validateCostInput(value, config);
        input = { app: costInput.app, prompt: costInput.prompt, modelId: config.models[0].id };
        workload = costInput.workload;
      }
      application = input.app;
    } catch (error) {
      if (reloading) {
        console.error('Saved evidence reload failed; existing state preserved.');
        json(500, { error: 'Saved evidence reload failed. Inspect the genuine report and profile binding; existing evidence remains unchanged.' }); return;
      }
      refuse(error instanceof RoutingError ? error.status : 400, error instanceof Error ? error.message : 'Invalid request.'); return;
    }
    if (!config.origin || !config.keys[input.app]) {
      refuse(503, `Configure the ${selectedId} gateway origin and application ${input.app} runtime key on the server.`,
        { gatewayId: selectedId, gatewayType: config.gatewayType }); return;
    }
    if (url.pathname === '/api/routing/request') {
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected.')); });
      try {
        const result = await router.route(costInput!, controller.signal, context);
        respond(result);
      } catch (error) {
        if (error instanceof RoutingError && error.result) {
          respond(error.result, { kind: 'cancelled', enforcementBoundary: 'none', gatewayCallMade: true,
            recovery: 'Client disconnected. Inspect this correlated outcome before resending; the gateway call was attempted and may have completed.' }, 499);
          return;
        }
        if (!(error instanceof RoutingError)) console.error('Unexpected local routing operation failure; no request content logged.');
        refuse(error instanceof RoutingError ? error.status : 500,
          error instanceof RoutingError ? error.message : 'Local routing operation failed. Inspect server logs.', {
          gatewayId: selectedId, gatewayType: config.gatewayType,
          snapshot: router.snapshot(input.app, costInput!.workload),
          ...(error instanceof RoutingError && error.rejection ? { rejection: error.rejection } : {})
        });
      }
      return;
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected.')); });
    const result = await callGateway(governanceTarget || config, input, fetch, { correlationId: context.correlationId, signal: controller.signal,
      ...(nativeProof ? { maxCompletionTokens: 32 } : {}) });
    // Use an envelope so even upstream 204/304 responses retain their actual status.
    respond(result, nativeProof && nativePolicyMatched(result, nativeProof) ? gatewayOutcome(result, true) : classify(result)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(404, { error: 'Unknown API route.' }); return;
  }
  if (req.method !== 'GET') { json(405, { error: 'Method not allowed.' }); return; }
  let file: string;
  try { file = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`); }
  catch { json(400, { error: 'Invalid URL encoding.' }); return; }
  if (!file.startsWith(root + sep)) { json(403, { error: 'Invalid asset path.' }); return; }
  try {
    const contents = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(contents);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      json(404, { error: 'Asset not found. Run npm run build before npm start.' });
    } else {
      console.error('Asset read failed:', error);
      json(500, { error: 'Unable to read local asset.' });
    }
  }
});
server.requestTimeout = 70000;
server.listen(port, '127.0.0.1', () => console.log(`PoC listening at http://127.0.0.1:${port}; server-bound gateway profiles. No simulated responses.`));
