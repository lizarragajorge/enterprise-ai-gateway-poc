import test from 'node:test';
import assert from 'node:assert/strict';
import { workloadAssessment } from './model-assessment.ts';
import { getWorkload } from '../server/workloads.ts';
import { modelPrices } from '../server/model-pricing.ts';
import type { RoutingSnapshot } from '../server/routing.ts';
import type { Approval } from '../server/evaluation.ts';

function snapshot(): RoutingSnapshot {
  const workload = getWorkload('extract-record');
  return {
    application: 'A', ready: true, busy: false, priceVersion: 'test', priceReviewedAt: '2026-10-13',
    priceValidUntil: '2026-11-13', priceSource: 'https://prices.azure.com', pricesCurrent: true, workload,
    candidates: modelPrices.map((price, index) => ({
      modelId: `model-${index + 1}`, price, eligible: index === 0, reason: 'Test assessment',
      plannedCostUsd: 1, approval: { approved: index === 0, passed: index === 0 ? 3 : 2, total: 3,
        reason: 'Test assessment', samples: workload.cases.map((item, caseIndex): Approval['samples'][number] => ({
          caseId: item.id, passed: index === 0 || caseIndex !== 1, reason: 'Exact JSON comparison',
          expected: item.expected, observation: {
            caseId: item.id, source: 'gateway-response', status: 200, modelResponse: true,
            reportedModel: price.reportedModel, response: index === 1 && caseIndex === 1 ? '{"wrong":true}' : JSON.stringify(item.expected),
            latencyMs: 100, tokens: null
          }
        })).reverse() }
    }))
  };
}
test('assessment aligns the same fixed cases with each model by case ID, not sample position', () => {
  const rows = workloadAssessment(snapshot());
  assert.deepEqual(rows.map(row => row.label), ['Extract exact fields', 'Ignore misleading notes', 'Missing field becomes null']);
  assert.equal(rows[1].models[0].outcome, 'Pass');
  assert.equal(rows[1].models[1].outcome, 'Fail');
  assert.equal(rows[1].models[1].response, '{"wrong":true}');
  assert.deepEqual(rows[1].expected, getWorkload('extract-record').cases[1].expected);
  assert.equal(rows[1].input, getWorkload('extract-record').cases[1].input);
  assert.equal(rows[1].models[1].version, modelPrices[1].reportedModel);
});
test('absent or expired assessments never display assumed passes or captured answers', () => {
  const state = snapshot();
  state.candidates.forEach(candidate => {
    candidate.approval.samples = [];
    candidate.approval.reason = 'Evaluation missing, changed or expired.';
  });
  for (const row of workloadAssessment(state)) {
    for (const model of row.models) {
      assert.equal(model.outcome, 'Not assessed');
      assert.equal(model.response, undefined);
      assert.match(model.reason, /expired/);
    }
  }
});
test('an unevaluated workload has no invented checks', () => {
  const state = snapshot();
  state.workload = getWorkload('external-publication');
  assert.deepEqual(workloadAssessment(state), []);
});
