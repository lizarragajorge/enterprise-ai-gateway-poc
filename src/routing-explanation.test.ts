import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPrices, tokenCost } from '../server/model-pricing.ts';
import type { RoutingCandidate, RoutingSnapshot } from '../server/routing.ts';
import { explainRoutingChoice, routingGateFacts } from './routing-explanation.ts';
import { getWorkload } from '../server/workloads.ts';

function candidate(index: number, eligible: boolean): RoutingCandidate {
  const price = modelPrices[index];
  return {
    modelId: `model-${index + 1}`, price, eligible, reason: 'Synthetic unit-test fixture.',
    plannedCostUsd: tokenCost(price, 1000, 256),
    approval: { approved: eligible, passed: eligible ? 3 : 1, total: 3,
      reason: 'Synthetic unit-test fixture.', samples: [] }
  };
}
test('explanation uses the backend selector and quantifies planned savings, not actual savings', () => {
  const cheap = candidate(0, true), premium = candidate(1, true);
  const candidates = [premium, cheap];
  const explanation = explainRoutingChoice(candidates);
  assert.equal(explanation.selected, cheap);
  assert.match(explanation.summary, /planned token cost is 95% lower/);
  assert.match(explanation.condition, /new evaluation.*excludes.*still approves/);
  assert.equal(candidates[0], premium);
});
test('approval gate can choose premium without calling a failed sample poor quality', () => {
  const explanation = explainRoutingChoice([candidate(0, false), candidate(1, true)]);
  assert.equal(explanation.selected?.price.role, 'premium');
  assert.match(explanation.summary, /only model with current workload approval/);
  assert.match(explanation.condition, /lower price never overrides/);
  assert.doesNotMatch(explanation.summary, /quality|95%/);
});
test('no approval or missing callable models do not invent a selection', () => {
  for (const candidates of [
    [], [candidate(0, false), candidate(1, false)],
    [{ ...candidate(0, true), modelId: undefined }]
  ]) {
    const explanation = explainRoutingChoice(candidates);
    assert.equal(explanation.selected, undefined);
    assert.match(explanation.summary, /Refuse locally/);
    assert.match(explanation.condition, /prompt alone does not grant approval/);
  }
});
test('equal planned costs retain the backend deterministic tie-break, not fake savings', () => {
  const cheap = candidate(0, true), premium = { ...candidate(1, true), plannedCostUsd: cheap.plannedCostUsd };
  const explanation = explainRoutingChoice([premium, cheap]);
  assert.equal(explanation.selected, cheap);
  assert.match(explanation.summary, /equal planned costs/);
  assert.doesNotMatch(explanation.summary, /lower|%/);
});
test('business-policy elimination does not pretend that measured quality changed', () => {
  const economy = candidate(0, true);
  economy.eligible = false;
  economy.exclusions = [{ boundary: 'custom-poc', kind: 'business-policy',
    reason: 'Premium required for reconciliation; economy is excluded independently of quality.' }];
  const explanation = explainRoutingChoice([economy, candidate(1, true)]);
  assert.equal(explanation.selected?.price.role, 'premium');
  assert.match(explanation.summary, /Custom PoC business policy.*independently of quality/);
  assert.match(explanation.condition, /independent of measured quality.*not gateway enforcement/);
  assert.doesNotMatch(explanation.summary, /only model with current workload approval|savings|lower/);
});

function snapshot(): RoutingSnapshot {
  return {
    application: 'A', ready: true, busy: false, pricesCurrent: true,
    priceVersion: 'unit-test', priceSource: 'https://example.invalid/prices',
    priceReviewedAt: '2026-10-12T00:00:00Z', priceValidUntil: '2026-11-11T00:00:00Z',
    workload: getWorkload('reconcile-records'),
    candidates: [candidate(0, true), candidate(1, true)],
    policy: { id: 'premium-required-reconciliation', label: 'Premium required for reconciliation',
      version: 'premium-required-reconciliation:v1:r1', owner: 'custom-poc' },
    evaluation: { runId: 'unit-test', suiteVersion: 'unit-test', completedAt: '2026-10-14T00:00:00Z',
      expiresAt: '2026-10-15T00:00:00Z', current: true }
  };
}
test('routing gates distinguish workload approval from business eligibility', () => {
  const state = snapshot();
  state.candidates[0].eligible = false;
  const facts = routingGateFacts(state);
  assert.equal(facts.workload, 'Reconcile conflicting records');
  assert.equal(facts.approval, '2/2 models approved');
  assert.equal(facts.business, 'Economy excluded by policy');
  assert.match(facts.businessDetail, /even if its workload checks passed/);
});
test('premium business restriction applies only to reconciliation, not every workload', () => {
  const state = snapshot();
  state.workload = getWorkload('extract-record');
  assert.equal(routingGateFacts(state).business, 'No extra business exclusion');
  assert.match(routingGateFacts(state).businessDetail, /only for reconciliation/);
  state.policy = { id: 'economy-first', label: 'Economy-first', version: 'economy-first:v1:r2', owner: 'custom-poc' };
  state.workload = getWorkload('reconcile-records');
  assert.match(routingGateFacts(state).businessDetail, /adds no extra business exclusion/);
});
test('missing or expired evidence never advertises current workload approval', () => {
  const state = snapshot();
  assert.ok(state.evaluation);
  state.evaluation = { ...state.evaluation, current: false };
  assert.equal(routingGateFacts(state).approval, 'Current approval unavailable');
  state.evaluation = undefined;
  state.policy = undefined;
  assert.equal(routingGateFacts(state).approval, 'Current approval unavailable');
  assert.equal(routingGateFacts(state).business, 'Policy unavailable');
  assert.equal(routingGateFacts().approval, 'Current approval unavailable');
});
