import assert from 'node:assert/strict';
import test from 'node:test';
import { CostRouter, RoutingError, validateCostInput } from './routing.ts';
import type { CostInput } from './routing.ts';
import { modelPrices, PRICE_VALID_UNTIL, PRICE_VERSION, tokenCost } from './model-pricing.ts';
import { evaluationFixture } from './evaluation-fixtures.ts';
import type { EvaluationReport } from './evaluation.ts';
import { getWorkload, workloadPrompt } from './workloads.ts';
import { evaluationBinding } from './evaluation.ts';
import type { CallInput, CallResult, Config } from './gateway.ts';

const config: Config = {
  origin: 'https://test.azure-api.net', keys: { A: 'test-a', B: 'test-b' },
  models: modelPrices.map((price, index) => ({
    id: index ? 'model-3' : 'model-1', name: price.publishedName, cloud: 'azure',
    format: 'openai-chat', reasoningEffort: price.reasoningEffort
  }))
};
const input: CostInput = {
  app: 'A', prompt: getWorkload('extract-record').exampleInput, workload: 'extract-record',
  plannedInputTokens: 1000, priceVersion: PRICE_VERSION, evaluationId: 'synthetic-unit-test-run', policyVersion: 'economy-first:v1:r0'
};
const clock = () => Date.parse('2026-10-12T01:00:00Z');
test('gateway profiles keep independent busy state and reject other-profile approvals', async () => {
  const standalone = { ...config, gatewayId: 'ai-gateway' as const, gatewayType: 'standalone-ai-gateway' as const };
  const apim = { ...config, origin: 'https://premium.azure-api.net', gatewayId: 'apim-v2' as const, gatewayType: 'apim-premium-v2' as const };
  const report = { ...evaluationFixture(), gatewayId: apim.gatewayId, gatewayType: apim.gatewayType, configBinding: evaluationBinding(apim) };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = new CostRouter(standalone, async call => { await gate; return result(call); }, clock, evaluationFixture());
  const premium = new CostRouter(apim, async call => result(call), clock, report);
  const operation = original.route(input);
  assert.equal(original.snapshot('A').busy, true);
  assert.equal(premium.snapshot('A').busy, false);
  const response = await premium.route(input);
  assert.equal(response.routing?.gatewayId, 'apim-v2');
  assert.equal(original.snapshot('A').busy, true);
  release();
  await operation;
  assert.equal(original.snapshot('A').busy, false);
  assert.equal(new CostRouter(standalone, undefined, clock, report).snapshot('A').evaluation, undefined);
});
function result(call: CallInput, status = 200): CallResult {
  const price = modelPrices.find(price => price.publishedName === config.models.find(model => model.id === call.modelId)!.name)!;
  return {
    source: 'gateway-response', status, model: price.publishedName, cloud: 'azure', latencyMs: 100,
    modelResponse: status === 200, returnedModel: price.reportedModel,
    response: 'Synthetic unit-test response', tokens: { input: 25, output: 10, total: 35 },
    headers: {}, raw: {}, request: { model: price.publishedName, messages: [] }
  };
}
function router(caller: (call: CallInput, limit: number, signal?: AbortSignal) => Promise<CallResult> = async call => result(call),
  report: EvaluationReport = evaluationFixture()) {
  return new CostRouter(config, caller, clock, report);
}
test('current per-million short-context standard prices retain exact cost math', () => {
  assert.equal(tokenCost(modelPrices[0], 1_000_000, 0), 0.1);
  assert.equal(tokenCost(modelPrices[0], 0, 1_000_000), 0.5);
  assert.equal(tokenCost(modelPrices[1], 1_000_000, 0), 2);
  assert.equal(tokenCost(modelPrices[1], 0, 1_000_000), 10);
  assert.equal(tokenCost(modelPrices[0], 1000, 256), 0.000228);
  assert.equal(tokenCost(modelPrices[1], 1000, 256), 0.00456);
  assert.throws(() => tokenCost(modelPrices[0], Number.NaN, 1));
  assert.throws(() => tokenCost(modelPrices[0], -1, 1));
});
test('both passing means cheapest wins, not a forced premium choice', async () => {
  const calls: CallInput[] = [];
  const response = await router(async (call, cap) => {
    assert.equal(cap, 256);
    calls.push(call);
    return result(call);
  }).route(input);
  assert.deepEqual(calls, [{ app: 'A', modelId: 'model-1', prompt: workloadPrompt(getWorkload(input.workload), input.prompt) }]);
  assert.equal(response.routing?.strategy, 'lowest-cost-approved-workload');
  assert.equal(response.routing?.evaluationId, input.evaluationId);
  assert.equal(response.routing?.selectedModelId, 'model-1');
  assert.equal(response.routing?.usageCostUsd, tokenCost(modelPrices[0], 25, 10));
  assert.ok(response.routing?.candidates.every(candidate => candidate.eligible));
});
test('failed cheap-model workload check changes the real decision to the approved premium target', async () => {
  const report = evaluationFixture();
  report.evaluations.find(item => item.workload === 'reconcile-records' && item.publishedName === modelPrices[0].publishedName)!.samples[0].response = '{}';
  const selected: string[] = [];
  const response = await router(async (call, cap) => {
    selected.push(call.modelId);
    assert.equal(cap, 512);
    return result(call);
  }, report).route({ ...input, workload: 'reconcile-records', prompt: getWorkload('reconcile-records').exampleInput });
  assert.deepEqual(selected, ['model-3']);
  assert.equal(response.routing?.selectedModelId, 'model-3');
  assert.equal(response.routing?.candidates[0].eligible, false);
  assert.equal(response.routing?.candidates[0].approval.passed, 2);
  assert.equal(response.routing?.maxOutputTokens, 512);
});
test('no passing model and an unevaluated workload refuse with a decision record and zero gateway calls', async () => {
  let calls = 0;
  const report = evaluationFixture();
  report.evaluations.filter(item => item.workload === 'extract-record').forEach(item => { item.samples[0].response = '{}'; });
  const route = router(async call => { calls++; return result(call); }, report);
  for (const workload of ['extract-record', 'external-publication'] as const) {
    await assert.rejects(route.route({ ...input, workload }), error => {
      assert.ok(error instanceof RoutingError);
      assert.equal(error.status, 409);
      assert.equal(error.rejection?.gatewayCallMade, false);
      assert.ok(error.rejection?.candidates.every(candidate => !candidate.eligible));
      return true;
    });
  }
  assert.equal(calls, 0);
});
test('missing evaluation, stale evidence and changed evaluation IDs reject before a call', async () => {
  let calls = 0;
  const caller = async (call: CallInput) => { calls++; return result(call); };
  await assert.rejects(new CostRouter(config, caller, clock).route(input), /evaluation missing/);
  await assert.rejects(new CostRouter(config, caller, () => Date.parse('2026-10-13T00:00:00Z'), evaluationFixture()).route(input), /evaluation missing/);
  await assert.rejects(router(caller).route({ ...input, evaluationId: 'old-run' }), /Evaluation changed/);
  assert.equal(calls, 0);
});
test('missing configuration, price expiry and changed prices still fail explicitly', async () => {
  let calls = 0;
  const caller = async (call: CallInput) => { calls++; return result(call); };
  const missing = new CostRouter({ ...config, models: config.models.slice(0, 1) }, caller, clock, evaluationFixture());
  assert.equal(missing.snapshot('A').ready, false);
  await assert.rejects(missing.route(input), /Configure both/);
  await assert.rejects(new CostRouter({ ...config, keys: {} }, caller, clock, evaluationFixture()).route(input), /runtime key/);
  await assert.rejects(new CostRouter(config, caller, () => Date.parse(PRICE_VALID_UNTIL), evaluationFixture()).route(input), /Price review expired/);
  await assert.rejects(router(caller).route({ ...input, priceVersion: 'old' }), /version changed/);
  assert.equal(calls, 0);
});
test('transport errors, throttles and unsupported bodies never trigger retries or a premium fallback', async () => {
  for (const change of [
    { status: 429, modelResponse: false }, { source: 'local-error' as const, status: 502, modelResponse: false },
    { status: 204, modelResponse: false }
  ]) {
    let calls = 0;
    const response = await router(async call => { calls++; return { ...result(call), ...change }; }).route(input);
    assert.equal(calls, 1);
    assert.equal(response.status, change.status);
    assert.equal(response.routing?.selectedModelId, 'model-1');
    assert.equal(response.routing?.usageCostUsd, null);
    assert.ok(response.routing?.usageCostUnavailableReason);
  }
});
test('usage cost still requires both valid token directions and exact model version', async () => {
  for (const change of [
    { tokens: null }, { tokens: { input: 25 } }, { returnedModel: undefined }, { returnedModel: 'different' },
    { tokens: { input: 1.5, output: 1 } }, { tokens: { input: 128001, output: 1 } }
  ]) assert.equal((await router(async call => ({ ...result(call), ...change })).route(input)).routing?.usageCostUsd, null);
  const zero = await router(async call => ({ ...result(call), tokens: { input: 0, output: 0 } })).route(input);
  assert.equal(zero.routing?.usageCostUsd, 0);
});
test('clients declare workloads; model, premium policy and generation overrides are rejected', () => {
  assert.deepEqual(validateCostInput(input, config), input);
  for (const change of [
    { modelId: 'model-3' }, { policy: 'premium-only' }, { maxOutputTokens: 256 }, { workload: 'unknown' },
    { policyVersion: '' }, { policyVersion: 123 },
    { evaluationId: '' }, { priceVersion: '' }, { prompt: '' }, { prompt: 'x'.repeat(8000) },
    { app: 'C' }, { plannedInputTokens: 0 }, { plannedInputTokens: 128001 }, { plannedInputTokens: '1000' }
  ]) assert.throws(() => validateCostInput({ ...input, ...change }, config));
});
test('old aliases and mismatched generation settings do not inherit measured approval', () => {
  const wrong = new CostRouter({ ...config, models: config.models.map(model => ({ ...model, reasoningEffort: undefined })) }, undefined, clock, evaluationFixture());
  assert.equal(wrong.snapshot('A').ready, false);
  assert.ok(wrong.snapshot('A').candidates.every(candidate => !candidate.eligible));
});
test('concurrent requests cannot alter an app decision; cancellation releases its lock', async () => {
  let release: (() => void) | undefined;
  const controller = new AbortController();
  const route = router(async call => { await new Promise<void>(resolve => { release = resolve; }); return result(call); });
  const request = route.route(input, controller.signal);
  const rejected = assert.rejects(request, /cancelled/);
  assert.equal(route.snapshot('A').busy, true);
  await assert.rejects(route.route(input), /in progress/);
  controller.abort();
  release!();
  await rejected;
  assert.equal(route.snapshot('A').busy, false);
});
