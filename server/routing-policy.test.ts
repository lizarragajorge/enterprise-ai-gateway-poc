import assert from 'node:assert/strict';
import test from 'node:test';
import { RoutingPolicyStore, PolicyConflict } from './routing-policy.ts';
import { CostRouter, RoutingError, validateCostInput } from './routing.ts';
import { evaluationFixture } from './evaluation-fixtures.ts';
import { modelPrices, PRICE_VERSION } from './model-pricing.ts';
import { getWorkload } from './workloads.ts';
import type { CallResult, Config } from './gateway.ts';

const config: Config = {
  origin: 'https://test.azure-api.net', keys: { A: 'synthetic-key' },
  models: modelPrices.map((price, i) => ({ id: i ? 'model-3' : 'model-1', name: price.publishedName,
    cloud: 'azure', format: 'openai-chat', provider: 'foundry', reasoningEffort: price.reasoningEffort }))
};
const input = { app: 'A' as const, prompt: getWorkload('reconcile-records').exampleInput, workload: 'reconcile-records' as const,
  plannedInputTokens: 1000, priceVersion: PRICE_VERSION, evaluationId: 'synthetic-unit-test-run' };
const clock = () => Date.parse('2026-10-12T01:00:00Z');
function result(modelId: string): CallResult {
  const price = modelPrices[modelId === 'model-1' ? 0 : 1];
  return { source: 'gateway-response', status: 200, model: price.publishedName, returnedModel: price.reportedModel,
    cloud: 'azure', provider: 'foundry', latencyMs: 1, response: 'Synthetic unit test', modelResponse: true,
    tokens: { input: 10, output: 10, total: 20 }, headers: {}, raw: {}, request: { model: price.publishedName, messages: [] } };
}
test('only server presets are accepted; revisions reject stale writes and captured values cannot change', () => {
  const store = new RoutingPolicyStore();
  const first = store.current();
  assert.throws(() => store.select({ presetId: 'arbitrary', expectedVersion: first.version }));
  assert.throws(() => store.select({ presetId: 'economy-first', expectedVersion: first.version, prices: [] }));
  const next = store.select({ presetId: 'premium-required-reconciliation', expectedVersion: first.version });
  assert.notEqual(next.version, first.version);
  assert.equal(first.id, 'economy-first');
  assert.ok(Object.isFrozen(first));
  assert.throws(() => store.select({ presetId: 'economy-first', expectedVersion: first.version }), PolicyConflict);
});
test('same request changes winner solely through business policy; quality results stay unchanged', async () => {
  const store = new RoutingPolicyStore();
  const report = evaluationFixture();
  const before = JSON.stringify(report);
  const calls: string[] = [];
  const router = new CostRouter(config, async call => { calls.push(call.modelId); return result(call.modelId); }, clock, report, store);
  const economy = await router.route({ ...input, policyVersion: store.current().version });
  store.select({ presetId: 'premium-required-reconciliation', expectedVersion: store.current().version });
  const premium = await router.route({ ...input, policyVersion: store.current().version });
  assert.deepEqual(calls, ['model-1', 'model-3']);
  assert.ok(premium.routing?.candidates.every(candidate => candidate.approval.approved));
  assert.equal(premium.routing?.candidates[0].exclusions?.[0].kind, 'business-policy');
  assert.equal(economy.routing?.policy.id, 'economy-first');
  assert.equal(premium.routing?.policy.id, 'premium-required-reconciliation');
  assert.equal(JSON.stringify(report), before);
});
test('a policy change in flight cannot change the actual decision, and stale submissions call nothing', async () => {
  const store = new RoutingPolicyStore();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const router = new CostRouter(config, async call => { calls++; await pending; return result(call.modelId); }, clock, evaluationFixture(), store);
  const version = store.current().version;
  const operation = router.route({ ...input, policyVersion: version });
  store.select({ presetId: 'premium-required-reconciliation', expectedVersion: version });
  release();
  const response = await operation;
  assert.equal(response.routing?.policy.version, version);
  assert.equal(response.routing?.selectedModelId, 'model-1');
  await assert.rejects(router.route({ ...input, policyVersion: version }), RoutingError);
  assert.equal(calls, 1);
});
test('business policy never grants approval and never affects extraction', async () => {
  const store = new RoutingPolicyStore();
  store.select({ presetId: 'premium-required-reconciliation', expectedVersion: store.current().version });
  const router = new CostRouter(config, async call => result(call.modelId), clock, evaluationFixture(), store);
  assert.ok(router.snapshot('A', 'external-publication').candidates.every(candidate => !candidate.eligible));
  assert.ok(router.snapshot('A', 'extract-record').candidates.every(candidate => candidate.eligible));
});
test('existing application request shape need not know the policy; server always captures its active version', () => {
  assert.deepEqual(validateCostInput(input, config), input);
});
