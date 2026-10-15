import assert from 'node:assert/strict';
import test from 'node:test';
import { isRoutingJourney, journeyFacts, policyVersionLabel, routingRequest } from './request-journey.ts';
import type { SubmittedRequest } from './request-journey.ts';
import type { RoutingSnapshot } from '../server/routing.ts';
import type { CallResult } from '../server/gateway.ts';
import { modelPrices } from '../server/model-pricing.ts';
import { getWorkload } from '../server/workloads.ts';
import { readFileSync } from 'node:fs';

const policy = { id: 'economy-first' as const, label: 'Economy-first', version: 'economy-first:v1:r0', owner: 'custom-poc' as const };
const snapshot: RoutingSnapshot = {
  gatewayId: 'apim-v2', application: 'A', ready: true, busy: false, policy,
  priceVersion: 'verified-price', priceReviewedAt: '2026-10-12', priceValidUntil: '2026-11-11',
  priceSource: 'https://prices.azure.com', pricesCurrent: true, candidates: [],
  workload: getWorkload('reconcile-records'),
  evaluation: { runId: 'genuine-run', suiteVersion: 'suite', completedAt: '2026-10-13', expiresAt: '2026-10-14', current: true }
};
const submitted: SubmittedRequest = Object.freeze({ gatewayId: 'apim-v2', application: 'A',
  workload: 'reconcile-records', policyVersion: policy.version });
test('Architecture Live PoC and Selection use the same routing journey; reference and model cards do not', () => {
  assert.equal(isRoutingJourney('architecture', 'live'), true);
  assert.equal(isRoutingJourney('routing', 'reference'), true);
  for (const [tab, view] of [['architecture', 'reference'], ['multi-cloud', 'live'], ['reliability', 'live']]) {
    assert.equal(isRoutingJourney(tab, view), false);
  }
});
test('submitted payload captures the original prompt, workload, profile and policy version without client model selection', () => {
  const originalPrompt = 'Synthetic reconciliation input';
  const payload = routingRequest(snapshot, 'apim-v2', 'A', 'reconcile-records', originalPrompt, 1000);
  const newSnapshot = { ...snapshot, policy: { ...policy, id: 'premium-required-reconciliation' as const, version: 'new' } };
  assert.equal(payload.prompt, originalPrompt);
  assert.equal(payload.policyVersion, policy.version);
  assert.equal(payload.workload, 'reconcile-records');
  assert.equal(payload.gatewayId, 'apim-v2');
  assert.equal(payload.evaluationId, 'genuine-run');
  assert.equal('modelId' in payload, false);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(routingRequest(newSnapshot, 'apim-v2', 'A', 'reconcile-records', originalPrompt, 1000).prompt, payload.prompt);
});
test('routing submissions reject missing policy/evaluation and mismatched profile, caller or workload', () => {
  for (const candidate of [
    { ...snapshot, gatewayId: 'ai-gateway' as const }, { ...snapshot, application: 'B' as const },
    { ...snapshot, policy: undefined }, { ...snapshot, evaluation: undefined },
    { ...snapshot, workload: getWorkload('extract-record') }
  ]) assert.throws(() => routingRequest(candidate, 'apim-v2', 'A', 'reconcile-records', 'input', 1000));
});
test('actual refusal distinguishes captured authoritative policy from submitted stale-version metadata', () => {
  const actualPolicy = { ...policy, id: 'premium-required-reconciliation' as const, label: 'Premium required', version: 'premium:v1:r1' };
  const actual = {
    correlationId: 'correlation-actual', decisionId: 'decision-actual',
    outcome: { kind: 'local-refusal' as const, enforcementBoundary: 'local-poc' as const, gatewayCallMade: false, recovery: 'Obtain genuine approval.' },
    rejection: {
      owner: 'local-node-backend' as const, workload: 'reconcile-records' as const, decisionId: 'decision-actual',
      evaluationId: 'run', decidedAt: '2026-10-13', gatewayCallMade: false as const, policy: actualPolicy,
      decisiveReason: 'All candidates excluded.',
      candidates: [{
        price: modelPrices[0], eligible: false, plannedCostUsd: 1, reason: 'Business restriction',
        approval: { approved: true, passed: 3, total: 3, reason: 'All checks passed', samples: [] },
        exclusions: [{ boundary: 'custom-poc' as const, kind: 'business-policy' as const, reason: 'Premium required for reconciliation.' }]
      }]
    }
  };
  const facts = journeyFacts(actual, submitted);
  assert.match(facts.policy, /Premium required.*premium:v1:r1.*custom PoC/);
  assert.match(facts.exclusions, /business-policy.*custom PoC/);
  assert.match(facts.winner, /No winner.*All candidates excluded/);
  assert.match(facts.outcome, /local-poc.*no gateway call/);
  assert.equal(facts.correlationId, 'correlation-actual');
  assert.equal(facts.decisionId, 'decision-actual');
  assert.match(facts.policy, /^Premium required · premium:v1:r1 · custom PoC/);
  assert.match(facts.policy, /submitted version economy-first:v1:r0 differs.*no accepted selection implied/);
  assert.equal(actual.rejection.policy.version, 'premium:v1:r1');
});
test('a successful actual winner/reason remains bound to its submitted policy when a later preview changes', () => {
  const payload = routingRequest(snapshot, 'apim-v2', 'A', 'reconcile-records', 'Keep this exact synthetic input', 1000);
  const actual: CallResult = {
    source: 'gateway-response', status: 200, model: modelPrices[0].publishedName, cloud: 'azure',
    latencyMs: 10, response: '{}', modelResponse: true, tokens: null, headers: {}, raw: {},
    request: { model: modelPrices[0].publishedName, messages: [] },
    routing: {
      owner: 'local-node-backend', strategy: 'lowest-cost-approved-workload', decisionId: 'immutable-decision',
      application: 'A', selectedModelId: 'model-1', selectedPrice: modelPrices[0], workload: 'reconcile-records',
      requirement: snapshot.workload.requirement, evaluationId: 'genuine-run', plannedInputTokens: 1000,
      maxOutputTokens: 256, plannedCostUsd: 0.000228, decidedAt: '2026-10-13T01:00:00Z',
      priceVersion: snapshot.priceVersion, priceSource: snapshot.priceSource, candidates: [],
      policy, decisiveReason: 'Economy won after the original eligible-cost comparison.', usageCostUsd: null
    }
  };
  const expectedNow = { ...snapshot, policy: { ...policy, id: 'premium-required-reconciliation' as const,
    label: 'Premium required', version: 'premium-required-reconciliation:v1:r1' } };
  const next = routingRequest(expectedNow, 'apim-v2', 'A', 'reconcile-records', payload.prompt, 1000);
  const facts = journeyFacts(actual, submitted);
  assert.equal(next.prompt, payload.prompt);
  assert.notEqual(next.policyVersion, payload.policyVersion);
  assert.match(facts.policy, /Economy-first.*economy-first:v1:r0/);
  assert.match(facts.winner, /GPT-6 Luna.*Economy won after the original/);
  assert.doesNotMatch(facts.policy, /Premium required/);
  assert.equal(facts.decisionId, 'immutable-decision');
});
test('successful outcomes use concise copy without changing structured evidence or implying policy tracing', () => {
  const outcome = { kind: 'model-response' as const, enforcementBoundary: 'none' as const, gatewayCallMade: true, recovery: null };
  const record = { outcome };
  assert.equal(journeyFacts(record, submitted).outcome, 'Response received through gateway · No rejection');
  assert.equal(record.outcome.kind, 'model-response');
  assert.equal(record.outcome.enforcementBoundary, 'none');
  for (const other of [
    { ...outcome, kind: 'unsupported-response' as const },
    { ...outcome, kind: 'gateway-error' as const, enforcementBoundary: 'unknown-upstream' as const },
    { ...outcome, kind: 'timeout' as const },
    { ...outcome, gatewayCallMade: false }
  ]) {
    const facts = journeyFacts({ outcome: other }, submitted);
    assert.doesNotMatch(facts.outcome, /Response received through gateway|No rejection/);
    assert.match(facts.outcome, new RegExp(other.kind));
  }
});
test('HTTP status alone never implies native enforcement and missing correlation is not invented', () => {
  const result = { status: 429 } as CallResult;
  const facts = journeyFacts(result, { ...submitted, workload: 'manual', policyVersion: undefined });
  assert.match(facts.outcome, /provenance unavailable.*no native enforcement inferred/);
  assert.equal(facts.correlationId, undefined);
  const verified = journeyFacts({
    ...result, outcome: { kind: 'gateway-error', enforcementBoundary: 'native-gateway-policy', gatewayCallMade: true, recovery: 'Wait.' }
  }, submitted);
  assert.match(verified.outcome, /native-gateway-policy/);
  assert.equal(verified.recovery, 'Wait.');
});
test('stale-policy refusal preserves submitted version alongside server version', () => {
  const record = {
    evidence: {
      policy: { ...policy, version: 'server-new-version' },
      outcome: { kind: 'local-validation-error', enforcementBoundary: 'local-poc', gatewayCallMade: false, recovery: 'Review current policy.' }
    }
  } as Parameters<typeof journeyFacts>[0];
  const facts = journeyFacts(record, submitted);
  assert.match(facts.policy, /server-new-version.*submitted version economy-first:v1:r0.*no accepted selection/);
  assert.match(facts.outcome, /no gateway call/);
});
test('compact journey retains authoritative versions, exclusions and known outcome boundaries', () => {
  assert.equal(policyVersionLabel('economy-first:v1:r10'), 'v1 / r10');
  assert.equal(policyVersionLabel('server-new-version'), 'server-new-version');
  const facts = journeyFacts({ outcome: { kind: 'local-refusal', enforcementBoundary: 'local-poc', gatewayCallMade: false, recovery: null } }, submitted);
  assert.equal(facts.outcomeLabel, 'Stopped by PoC');
  assert.match(facts.policy, /Submitted economy-first:v1:r0/);
  const native = journeyFacts({ outcome: { kind: 'gateway-error', enforcementBoundary: 'native-gateway-policy', gatewayCallMade: true, recovery: null } }, submitted);
  assert.equal(native.outcomeLabel, 'Rejected at gateway');
  const unknown = journeyFacts({ outcome: { kind: 'gateway-error', enforcementBoundary: 'unknown-upstream', gatewayCallMade: true, recovery: null } }, submitted);
  assert.equal(unknown.outcomeLabel, 'Error · origin unconfirmed');
});
test('frontend boot initializes form controls before opening the Architecture routing journey', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const initialView = source.indexOf("\nselectTab('architecture');\nvoid load();");
  assert.ok(initialView > source.indexOf('const prompt = document.querySelector'));
  assert.ok(initialView > source.indexOf('const send = document.querySelector'));
  assert.match(source, /let selectedGateway: GatewayId = 'ai-gateway'/);
  const policyChange = source.slice(source.indexOf("('#routing-policy')!.addEventListener('change'"), source.indexOf('async function reloadEvidence()'));
  assert.match(policyChange, /expectedVersion/);
  assert.doesNotMatch(policyChange, /prompt\.value\s*=/);
});
