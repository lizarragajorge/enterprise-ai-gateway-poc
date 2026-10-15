import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { behaviorRows, learningSummary, parseRequestAudit } from './monitoring.ts';
import { RequestAudit } from '../server/request-audit.ts';
import { requestEvent, localOutcome } from '../server/request-evidence.ts';
import { RoutingPolicyStore } from '../server/routing-policy.ts';
import { CostRouter } from '../server/routing.ts';
test('monitoring rejects inherited or malformed local audit evidence', () => {
  const audit = new RequestAudit();
  audit.record(requestEvent({ correlationId: crypto.randomUUID(), decisionId: crypto.randomUUID(), policy: new RoutingPolicyStore().current() },
    { gatewayId: 'ai-gateway', status: 409, outcome: localOutcome('local-refusal', 'No approved model satisfies this workload.') }));
  const snapshot = audit.snapshot('ai-gateway');
  assert.equal(parseRequestAudit(snapshot, 'ai-gateway'), snapshot);
  for (const invalid of [null, {}, { ...snapshot, source: 'native-gateway' }, { ...snapshot, capacity: 100 },
    { ...snapshot, events: [{ ...snapshot.events[0], gatewayId: 'apim-v2' }] }]) {
    assert.throws(() => parseRequestAudit(invalid, 'ai-gateway'));
  }
  assert.throws(() => parseRequestAudit(snapshot, 'apim-v2'));
});
test('behavior views never turn missing approvals into failed quality scores or measured latency', () => {
  const router = new CostRouter({ gatewayId: 'ai-gateway', origin: 'https://fixture.azure-api.net', keys: {}, models: [] });
  const rows = behaviorRows([router.snapshot('A', 'extract-record')]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.checks === 'No current approval' && row.meanRoundTripMs === null));
  assert.deepEqual(rows.map(row => row.reasoningEffort), ['none', 'low']);
});
test('monitoring explicitly separates native counters, local audit, measured checks and private reasoning limits', () => {
  const source = readFileSync(new URL('./monitoring.ts', import.meta.url), 'utf8');
  for (const boundary of ['Gateway telemetry · native export', 'Request audit · custom PoC',
    'Model behavior · measured, not inferred', 'Configuration audit · Azure Activity Log',
    'Private chain-of-thought is not exposed', 'not durable or tamper-proof', 'Payload capture is off']) assert.ok(source.includes(boundary));
});
test('the learning takeaway never grades an unevaluated request using other workloads', () => {
  const event = requestEvent({ correlationId: crypto.randomUUID(), decisionId: crypto.randomUUID(), policy: new RoutingPolicyStore().current() },
    { gatewayId: 'ai-gateway', workload: 'external-publication', status: 409,
      outcome: localOutcome('local-refusal', 'No approved model satisfies this workload.') });
  const lesson = learningSummary([], event);
  assert.equal(lesson.title, 'No quality verdict for this request');
  assert.equal(lesson.sample, undefined);
});
test('the takeaway explains equal fixed-check results without manufacturing a premium quality advantage', () => {
  const router = new CostRouter({ gatewayId: 'ai-gateway', origin: 'https://fixture.azure-api.net', keys: {}, models: [] });
  const base = router.snapshot('A', 'reconcile-records');
  const snapshot = { ...base, evaluation: { runId: 'fixture-run', suiteVersion: 'fixture', completedAt: '2026-10-14T00:00:00Z',
    expiresAt: '2026-10-15T00:00:00Z', current: true },
    candidates: base.candidates.map(candidate => ({ ...candidate, approval: { approved: true, passed: 3, total: 3,
      reason: 'Fixture checks passed.', samples: [1, 2, 3].map(index => ({ caseId: `fixture-${index}`, passed: true,
        reason: 'Fixture match.', expected: { id: 'SYN' }, observation: { caseId: `fixture-${index}`,
          source: 'gateway-response' as const, status: 200, modelResponse: true, response: '{"id":"SYN"}', latencyMs: 12, tokens: null } })) } })) };
  const store = new RoutingPolicyStore();
  const policy = store.select({ presetId: 'premium-required-reconciliation', expectedVersion: store.current().version });
  const event = { ...requestEvent({ correlationId: crypto.randomUUID(), decisionId: crypto.randomUUID(), policy },
    { gatewayId: 'ai-gateway', workload: 'reconcile-records', status: 200,
      outcome: { kind: 'model-response', enforcementBoundary: 'none', gatewayCallMade: true, recovery: null } }),
    selectedModel: base.candidates[1].price.publishedName, evaluationId: 'fixture-run' };
  assert.match(learningSummary([snapshot], event).text, /Both models passed.*business policy.*not a demonstrated quality win/);
  assert.match(learningSummary([snapshot], { ...event, evaluationId: 'older-run' }).title, /approval report has changed/);
});
