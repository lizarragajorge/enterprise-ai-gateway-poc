import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approval, EVALUATION_TTL_MS, evaluationCurrent, readEvaluation } from './evaluation.ts';
import { evaluationFixture } from './evaluation-fixtures.ts';
import { modelPrices } from './model-pricing.ts';
import { checkOutput, getWorkload } from './workloads.ts';

const now = Date.parse('2026-10-12T01:00:00Z');
test('objective JSON checks allow key order, reject extras, omissions, Markdown and incorrect record order', () => {
  const expected = { id: 'SYN-1', team: null, status: 'ready' };
  assert.equal(checkOutput('{"status":"ready","team":null,"id":"SYN-1"}', expected).passed, true);
  for (const text of ['{}', '```json\n{}\n```', '{"id":"SYN-1","team":null,"status":"ready","extra":1}', '{"id":"SYN-1","status":"ready"}']) {
    assert.equal(checkOutput(text, expected).passed, false);
  }
  assert.equal(checkOutput('{"records":[{"id":"B"},{"id":"A"}]}', { records: [{ id: 'A' }, { id: 'B' }] }).passed, false);
});
test('fixed reconciliation ground truth covers source precedence, voids, fallback, ties and ordering', () => {
  assert.deepEqual(getWorkload('reconcile-records').cases.map(test => test.expected), [
    { records: [{ id: 'SYN-01', status: 'ready' }, { id: 'SYN-02', status: 'queued' }] },
    { records: [{ id: 'SYN-01', status: 'ready' }, { id: 'SYN-03', status: 'ready' }] },
    { records: [{ id: 'SYN-01', status: 'ready' }, { id: 'SYN-02', status: 'queued' }, { id: 'SYN-04', status: 'cancelled' }] }
  ]);
});
test('approval is computed from exact captured outputs, never a stored score', () => {
  const report = evaluationFixture();
  assert.equal(approval(report, 'extract-record', modelPrices[0], now).approved, true);
  report.evaluations[0].samples[0].response = '{}';
  const checked = approval(report, 'extract-record', modelPrices[0], now);
  assert.equal(checked.approved, false);
  assert.equal(checked.passed, 2);
  assert.equal(checked.samples[0].passed, false);
});
test('failure, version mismatch, generation drift, missing or duplicate cases cannot approve', () => {
  for (const mutate of [
    (report: ReturnType<typeof evaluationFixture>) => { report.evaluations[0].samples[0].status = 429; },
    (report: ReturnType<typeof evaluationFixture>) => { report.evaluations[0].samples[0].reportedModel = 'other'; },
    (report: ReturnType<typeof evaluationFixture>) => { report.evaluations[0].maxOutputTokens = 16; },
    (report: ReturnType<typeof evaluationFixture>) => { report.evaluations[0].samples.pop(); },
    (report: ReturnType<typeof evaluationFixture>) => { report.evaluations[0].samples[0].caseId = report.evaluations[0].samples[1].caseId; },
    (report: ReturnType<typeof evaluationFixture>) => { report.evaluations.push(report.evaluations[0]); }
  ]) {
    const report = evaluationFixture();
    mutate(report);
    assert.equal(approval(report, 'extract-record', modelPrices[0], now).approved, false);
  }
});
test('evidence expires exactly at 24 hours; future, changed suites and untested workloads are not approved', () => {
  const report = evaluationFixture();
  const completed = Date.parse(report.completedAt);
  assert.equal(evaluationCurrent(report, completed + EVALUATION_TTL_MS - 1), true);
  assert.equal(evaluationCurrent(report, completed + EVALUATION_TTL_MS), false);
  assert.equal(evaluationCurrent(report, completed - 1), false);
  assert.equal(approval(report, 'external-publication', modelPrices[0], now).approved, false);
  report.suiteVersion = 'different';
  assert.equal(evaluationCurrent(report, now), false);
});
test('missing report is explicitly absent; corrupt evidence is an error, not a silently approved fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-evidence-'));
  const path = join(dir, 'report.json');
  try {
    assert.equal(readEvaluation(path), undefined);
    writeFileSync(path, '{');
    assert.throws(() => readEvaluation(path), SyntaxError);
    writeFileSync(path, '{}');
    assert.throws(() => readEvaluation(path), /metadata/);
    writeFileSync(path, JSON.stringify(evaluationFixture()));
    assert.equal(readEvaluation(path)?.runId, 'synthetic-unit-test-run');
  } finally {
    rmSync(path, { force: true });
    rmdirSync(dir);
  }
});
