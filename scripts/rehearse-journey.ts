import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { validateGatewayId } from '../server/profiles.ts';
import { getWorkload } from '../server/workloads.ts';
import type { CallResult } from '../server/gateway.ts';
import type { publicGovernanceProof } from '../server/governance.ts';
import type { RoutingSnapshot } from '../server/routing.ts';
import type { RoutingPolicy, RoutingPresetId } from '../server/routing-policy.ts';
import type { RequestEvent } from '../server/request-evidence.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--gateway')) throw new Error('Usage: node scripts/rehearse-journey.ts --gateway ai-gateway|apim-v2');
  const gatewayId = validateGatewayId(args[1] || 'ai-gateway');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local demo port.');
  const origin = `http://127.0.0.1:${port}`;
  async function read(path: string) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Preflight ${path.split('?')[0]} failed: HTTP ${response.status}. No simulated proof.`);
    return response.json();
  }
  const proof: ReturnType<typeof publicGovernanceProof> = await read(`/api/governance-proof?gateway=${gatewayId}`);
  assert.equal(proof.gatewayId, gatewayId);
  assert.equal(proof.proof.attributable, true);
  const start: RoutingSnapshot = await read(`/api/routing?gateway=${gatewayId}&app=A&workload=reconcile-records`);
  assert.ok(start.ready && start.evaluation?.current, 'Refresh genuine evaluations before rehearsal.');
  console.log(`Live rehearsal: ${proof.kind === 'caller-request-limit' ? 'at most 6' : '4'} gateway requests, plus one local no-eligible refusal. Estimated model cost under $0.01 with input <1000 tokens and existing output caps; infrastructure excluded.`);
  async function post(path: string, body: unknown) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
    const value = await response.json();
    return { status: response.status, correlationId: response.headers.get('x-correlation-id'), value };
  }
  const events: RequestEvent[] = [];
  function capture(response: Awaited<ReturnType<typeof post>>) {
    const event: RequestEvent = response.value.evidence;
    assert.equal(event.event, 'ai-request-outcome');
    assert.equal(event.correlationId, response.correlationId);
    assert.equal(event.correlationId, response.value.correlationId);
    assert.equal(event.decisionId, response.value.decisionId);
    assert.equal(event.gatewayId, gatewayId);
    assert.ok(!events.some(previous => previous.correlationId === event.correlationId));
    events.push(event);
  }
  async function select(presetId: RoutingPresetId): Promise<RoutingPolicy> {
    const current = await read('/api/routing-policy');
    const response = await post('/api/routing-policy', { presetId, expectedVersion: current.active.version });
    assert.equal(response.status, 200);
    assert.equal(response.value.active.id, presetId);
    return response.value.active;
  }
  const prompt = getWorkload('reconcile-records').exampleInput;
  const applicationRequest = Object.freeze({ gatewayId, app: 'A', prompt, workload: 'reconcile-records', plannedInputTokens: 1000,
    priceVersion: start.priceVersion, evaluationId: start.evaluation?.runId });
  async function routed(policy: RoutingPolicy, workload = 'reconcile-records') {
    const response = await post('/api/routing/request', { ...applicationRequest, workload });
    capture(response);
    assert.equal(response.value.routing?.policy.version || response.value.rejection?.policy.version, policy.version);
    return response;
  }
  const economy = await routed(await select('economy-first'));
  const economyCompletedAt = Date.now();
  const premium = await routed(await select('premium-required-reconciliation'));
  for (const response of [economy, premium]) {
    const result: CallResult = response.value;
    assert.equal(response.status, 200);
    assert.equal(result.source, 'gateway-response');
    assert.equal(result.status, 200);
    assert.equal(result.modelResponse, true);
    assert.equal(result.outcome?.kind, 'model-response');
    assert.equal(result.routing?.decisionId, result.decisionId);
    assert.equal(result.routing?.correlationId, result.correlationId);
    assert.equal(typeof result.routing?.usageCostUsd, 'number');
    assert.ok(result.routing?.candidates.every(candidate => candidate.approval.approved), 'Do not manufacture a quality exclusion.');
  }
  assert.equal(economy.value.routing.selectedPrice.role, 'economy');
  assert.equal(premium.value.routing.selectedPrice.role, 'premium');
  assert.ok(premium.value.routing.candidates.some((candidate: { exclusions?: { kind: string }[] }) =>
    candidate.exclusions?.some(exclusion => exclusion.kind === 'business-policy')));
  const refusal = await routed(premium.value.routing.policy, 'external-publication');
  assert.equal(refusal.status, 409);
  assert.equal(refusal.value.rejection.gatewayCallMade, false);
  assert.equal(refusal.value.outcome.enforcementBoundary, 'local-poc');
  assert.equal(refusal.value.evidence.selectedModel, null);
  assert.ok(refusal.value.outcome.recovery);
  let rejected: Awaited<ReturnType<typeof post>> | undefined;
  for (let i = 0; i < (proof.kind === 'caller-request-limit' ? 3 : 1); i++) {
    const response = await post('/api/governance/request', { gatewayId, app: 'A', action: 'reject' });
    capture(response);
    if (response.value.status === proof.proof.rejectionSignature.status) { rejected = response; break; }
    assert.equal(response.value.status, 200, 'Unexpected native probe response; no fallback.');
    assert.equal(response.value.modelResponse, true);
  }
  assert.ok(rejected, 'Native rejection was not reproduced within the bounded request count.');
  assert.equal(rejected.value.modelResponse, false);
  assert.equal(rejected.value.outcome.enforcementBoundary, 'native-gateway-policy');
  assert.equal(rejected.value.outcome.gatewayCallMade, true);
  if (proof.kind === 'model-allowlist') {
    const wait = economyCompletedAt + 61_000 - Date.now();
    if (wait > 0) {
      console.log('Reusing Luna: spacing this verification by one minute for existing deployment capacity. No retry, fallback or local governance substitute.');
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  const allowed = await post('/api/governance/request', { gatewayId, app: 'B', action: 'allow' });
  capture(allowed);
  assert.equal(allowed.value.status, 200);
  assert.equal(allowed.value.modelResponse, true);
  assert.equal(allowed.value.outcome.kind, 'model-response');
  await select('economy-first');
  const evidence = { gatewayId, capturedAt: new Date().toISOString(), sameApplicationRequest: true,
    governanceKind: proof.kind, callerIsolationDemonstrated: proof.kind === 'caller-request-limit',
    policyConfiguration: proof.policy, events };
  await mkdir('.local', { recursive: true });
  const file = '.local/demo-journey-rehearsal.json';
  await writeFile(`${file}.tmp`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  console.log(JSON.stringify({ verified: true, gatewayId, gatewayRequests: events.filter(event => event.outcome.gatewayCallMade).length,
    governanceKind: proof.kind, callerIsolationDemonstrated: evidence.callerIsolationDemonstrated,
    estimatedCostForPricedResponsesUsd: events.reduce((sum, event) => event.estimatedTokenCostUsd === null ? sum : sum + event.estimatedTokenCostUsd, 0),
    outcomesWithoutUsageCost: events.filter(event => event.estimatedTokenCostUsd === null).length,
    evidence: file, outcomes: events.map(event => ({ correlationId: event.correlationId, status: event.status, outcome: event.outcome.kind,
      boundary: event.outcome.enforcementBoundary, model: event.selectedModel, policy: event.policy?.id })) }, null, 2));
}
main().catch(error => {
  console.error('Live rehearsal failed:', error instanceof Error ? error.message : 'Unknown verification failure.');
  process.exitCode = 1;
});
