import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyEvidence, readPolicyEvidence } from './policy-evidence.ts';

const capturedAt = '2026-10-12T19:00:00Z';
test('Azure empty policy projection is explicit absence; policy fields are allowlisted', () => {
  const evidence = parsePolicyEvidence({ capturedAt, source: 'azure-control-plane', secret: 'not-public',
    models: [{ name: 'model-a', policies: null }, { name: 'model-b', credential: 'not-public',
      policies: [{ type: 'requestRateLimit', callsPerPeriod: 2, periodSeconds: 30, counterKey: ['identity'],
        scope: 'resource', token: 'not-public' }] }] });
  assert.deepEqual(evidence.models[0].policies, []);
  assert.equal(evidence.models[1].policies[0].callsPerPeriod, 2);
  assert.ok(!JSON.stringify(evidence).includes('not-public'));
});
test('malformed policy evidence fails, rather than claiming no configured policies', () => {
  for (const policies of [undefined, {}, [{ type: 'tokenLimit', count: -1 }], [{ type: 'tokenLimit', counterKey: 'identity' }]]) {
    assert.throws(() => parsePolicyEvidence({ capturedAt, source: 'azure-control-plane', models: [{ name: 'model', policies }] }));
  }
  assert.throws(() => parsePolicyEvidence({ capturedAt: 'invalid', source: 'azure-control-plane', models: [] }));
  assert.equal(readPolicyEvidence('/nonexistent-ai-gateway-poc-policy-evidence.json'), undefined);
});
