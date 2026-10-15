import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayOutcome, localOutcome, logRequestEvent, requestEvent } from './request-evidence.ts';
import { RoutingPolicyStore } from './routing-policy.ts';
import type { CallResult } from './gateway.ts';
import { modelPrices } from './model-pricing.ts';
import { observedRequestPath } from '../src/request-path.ts';
const context = { correlationId: crypto.randomUUID(), decisionId: crypto.randomUUID(), policy: new RoutingPolicyStore().current() };
const result: CallResult = { source: 'gateway-response', gatewayId: 'ai-gateway', status: 429, model: 'approved-alias',
  cloud: 'azure', provider: 'foundry', latencyMs: 20, response: 'sensitive completion canary', modelResponse: false,
  tokens: null, headers: { 'retry-after': 'sensitive completion canary', 'x-request-id': 'req_test123', Authorization: 'sensitive-key-canary' },
  raw: { secret: 'sensitive-key-canary' }, request: { model: 'approved-alias', messages: [{ role: 'user', content: 'sensitive-prompt-canary' }] } };
test('gateway status alone never claims a native enforcement boundary', () => {
  const outcome = gatewayOutcome(result);
  assert.equal(outcome.enforcementBoundary, 'unknown-upstream');
  assert.equal(outcome.gatewayCallMade, true);
  assert.ok(!outcome.recovery?.includes('sensitive completion canary'));
  assert.equal(gatewayOutcome(result, true).enforcementBoundary, 'native-gateway-policy');
});
test('one structured event includes joined IDs and safe metadata, never request/response or credentials', () => {
  const event = requestEvent(context, { gatewayId: 'ai-gateway', gatewayType: 'standalone-ai-gateway', application: 'A',
    workload: 'reconcile-records', status: 429, outcome: gatewayOutcome(result), result });
  assert.equal(event.policy?.version, context.policy.version);
  assert.equal(event.correlationId, context.correlationId);
  assert.equal(event.decisionId, context.decisionId);
  assert.equal(event.selectedModel, 'approved-alias');
  assert.equal(event.nodeToGatewayRoundTripMs, 20);
  assert.equal(event.estimatedTokenCostUsd, null);
  assert.deepEqual(event.upstreamRequestIds, { 'x-request-id': 'req_test123' });
  let entries = 0;
  let serialized = '';
  const original = console.info;
  try {
    console.info = value => { entries++; serialized = String(value); };
    logRequestEvent(event);
  } finally { console.info = original; }
  assert.equal(entries, 1);
  for (const secret of ['sensitive-prompt-canary', 'sensitive-key-canary', 'sensitive completion canary']) assert.ok(!serialized.includes(secret));
});
test('local refusals and approval expiry have explicit boundaries and recovery, never zero cost', () => {
  const event = requestEvent(context, { workload: 'external-publication', status: 409,
    outcome: localOutcome('local-refusal', 'No approved model satisfies this workload.') });
  assert.equal(event.outcome.gatewayCallMade, false);
  assert.equal(event.outcome.enforcementBoundary, 'local-poc');
  assert.equal(event.selectedModel, null);
  assert.equal(event.estimatedTokenCostUsd, null);
  assert.match(event.outcome.recovery!, /genuine approval/);
  assert.match(localOutcome('local-refusal', 'Workload evaluation missing, changed or expired.').recovery!, /24 hours/);
});
test('timeout and cancellation preserve unknown upstream execution', () => {
  for (const transportFailure of ['timeout', 'cancelled'] as const) {
    const outcome = gatewayOutcome({ ...result, source: 'local-error', transportFailure, status: 502 });
    assert.equal(outcome.kind, transportFailure);
    assert.equal(outcome.enforcementBoundary, 'none');
    assert.match(outcome.recovery!, /execution is unknown/);
  }
});
test('native safety rejection retains immutable routed selection intent, never provider execution', () => {
  const price = modelPrices[1];
  const capturedPolicy = { ...context.policy, id: 'premium-required-reconciliation' as const,
    version: 'premium-required-reconciliation:v1:r17', label: 'Premium required' };
  const rejected: CallResult = { ...result, gatewayId: 'apim-v2', status: 403, model: price.publishedName,
    request: { ...result.request, model: price.publishedName },
    raw: { message: 'Request failed content safety check.' },
    routing: {
      owner: 'local-node-backend', strategy: 'lowest-cost-approved-workload', decisionId: 'immutable-routing-selection',
      application: 'A', selectedModelId: 'model-3', selectedPrice: price, workload: 'reconcile-records',
      requirement: 'Premium required for reconciliation.', evaluationId: 'genuine-assessment',
      plannedInputTokens: 1000, maxOutputTokens: 256, plannedCostUsd: 0.00456,
      decidedAt: '2026-10-14T05:00:00Z', priceVersion: 'captured-price', priceSource: 'captured-source',
      candidates: [], policy: capturedPolicy, decisiveReason: 'Sol selected by captured premium requirement.', usageCostUsd: null
    } };
  const outcome = gatewayOutcome(rejected, 'content-safety');
  const event = requestEvent(context, { gatewayId: 'apim-v2', application: 'A', workload: 'reconcile-records',
    status: 403, outcome, result: rejected });
  assert.equal(event.selectedProvider, 'foundry');
  assert.equal(event.selectedModel, price.publishedName);
  assert.equal(event.requestedAlias, price.publishedName);
  assert.equal(event.decisionId, rejected.routing!.decisionId);
  assert.equal(event.policy?.version, capturedPolicy.version);
  assert.equal(event.selectionReason, rejected.routing!.decisiveReason);
  assert.equal(event.evaluationId, 'genuine-assessment');
  assert.equal(event.tokens, null);
  assert.equal(event.estimatedTokenCostUsd, null);
  assert.equal(event.outcome.nativeControl, 'content-safety');
  assert.equal(event.outcome.kind, 'gateway-error');
  assert.equal(rejected.modelResponse, false);
  const path = observedRequestPath({ phase: 'result', request: { application: 'A', automatic: true }, result: { ...rejected, outcome } });
  assert.deepEqual(path.map(step => step.kind), ['application', 'proxy', 'gateway']);
  assert.match(path[1].detail, /premium-required-reconciliation:v1:r17/);
  assert.match(path[2].detail, /native Content Safety stop.*model not called/);
  assert.ok(!path.some(step => step.kind === 'model'));
  const serialized = JSON.stringify(event);
  for (const secret of ['sensitive-prompt-canary', 'sensitive-key-canary', 'sensitive completion canary',
    'Request failed content safety check.']) assert.ok(!serialized.includes(secret));
});
test('unresolved model-allowlist aliases remain unselected; non-routed native safety behavior is unchanged', () => {
  const unknown = { ...result, status: 400, model: 'demo-policy-refusal' };
  const refused = requestEvent(context, { workload: 'governance-proof', status: 400,
    outcome: gatewayOutcome(unknown, true), result: unknown });
  assert.equal(refused.selectedProvider, null);
  assert.equal(refused.selectedModel, null);
  assert.equal(refused.requestedAlias, 'demo-policy-refusal');
  const blocked = { ...result, status: 403 };
  const safety = requestEvent(context, { workload: 'governance-proof', status: 403,
    outcome: gatewayOutcome(blocked, 'content-safety'), result: blocked });
  assert.equal(safety.selectedProvider, null);
  assert.equal(safety.selectedModel, null);
  assert.equal(safety.requestedAlias, 'approved-alias');
});
