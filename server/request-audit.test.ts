import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestAudit } from './request-audit.ts';
import { requestEvent, localOutcome, gatewayOutcome } from './request-evidence.ts';
import { RoutingPolicyStore } from './routing-policy.ts';
import type { CallResult } from './gateway.ts';

const context = () => ({ correlationId: crypto.randomUUID(), decisionId: crypto.randomUUID(), policy: new RoutingPolicyStore().current() });
test('local audit is bounded, profile-isolated, newest first and resets with the process store', () => {
  const audit = new RequestAudit();
  for (let i = 0; i < 42; i++) audit.record(requestEvent(context(), { gatewayId: 'ai-gateway',
    status: 409, outcome: localOutcome('local-refusal', 'No approved model satisfies this workload.') }));
  const event = requestEvent(context(), { gatewayId: 'apim-v2', status: 409,
    outcome: localOutcome('local-refusal', 'No approved model satisfies this workload.') });
  audit.record(event);
  assert.equal(audit.snapshot('ai-gateway').events.length, 39);
  assert.equal(audit.snapshot('apim-v2').events.length, 1);
  assert.equal(audit.snapshot('apim-v2').events[0].correlationId, event.correlationId);
  assert.equal(new RequestAudit().snapshot('ai-gateway').events.length, 0);
  event.outcome.kind = 'model-response';
  assert.equal(audit.snapshot('apim-v2').events[0].outcome.kind, 'local-refusal');
  const snapshot = audit.snapshot('apim-v2');
  snapshot.events[0].outcome.kind = 'model-response';
  assert.equal(audit.snapshot('apim-v2').events[0].outcome.kind, 'local-refusal');
});
test('audit retains the existing content-free structured event, not raw model messages or keys', () => {
  const result: CallResult = { gatewayId: 'ai-gateway', source: 'gateway-response', status: 200, model: 'fixture',
    cloud: 'azure', provider: 'foundry', modelResponse: true, response: 'completion-canary', latencyMs: 12,
    tokens: { input: 3, output: 4, total: 7, reasoning: 2 }, headers: { Authorization: 'key-canary' },
    raw: { messages: 'completion-canary' }, request: { model: 'fixture', messages: [{ role: 'user', content: 'prompt-canary' }] } };
  const audit = new RequestAudit();
  audit.record(requestEvent(context(), { application: 'A', workload: 'manual', status: 200, outcome: gatewayOutcome(result), result }));
  const snapshot = audit.snapshot('ai-gateway');
  assert.equal(snapshot.events[0].tokens?.reasoning, 2);
  for (const canary of ['completion-canary', 'prompt-canary', 'key-canary']) assert.ok(!JSON.stringify(snapshot).includes(canary));
});
