import assert from 'node:assert/strict';
import test from 'node:test';
import { governanceInput, nativePolicyMatched, parseGovernanceProof, publicGovernanceProof } from './governance.ts';
import type { GovernanceProof } from './governance.ts';
import type { CallResult, Config } from './gateway.ts';

const config: Config = { gatewayId: 'apim-v2', gatewayType: 'apim-premium-v2', origin: 'https://synthetic.azure-api.net',
  keys: { A: 'synthetic-A', B: 'synthetic-B' }, authHeader: 'Ocp-Apim-Subscription-Key',
  models: [{ id: 'model-1', name: 'ai-cost-economy-current', cloud: 'azure', provider: 'foundry', format: 'openai-chat', reasoningEffort: 'none' }] };
const at = '2026-10-14T00:00:00Z';
const proof: GovernanceProof = { schemaVersion: 1, gatewayId: 'apim-v2', gatewayOrigin: config.origin!, capturedAt: at,
  kind: 'model-allowlist', alias: 'demo-policy-refusal', allowedAlias: 'ai-cost-economy-current',
  policy: { source: 'azure-control-plane', resourceId: '/subscriptions/synthetic/resourceGroups/demo/providers/Microsoft.ApiManagement/service/synthetic/apis/demo/operations/chat/policies/policy',
    configuration: '<policies><inbound><return-response /></inbound></policies>', capturedAt: at },
  proof: { attributable: true, aRejected: true, bAllowed: true, explanation: 'Synthetic unit-test observation, not live proof.',
    rejectionSignature: { status: 400, message: 'Select a configured comparison model.' } },
  attempts: [{ app: 'A', status: 400, headers: {}, modelResponse: false, tokens: null, latencyMs: 10, correlationId: crypto.randomUUID(), at },
    { app: 'B', status: 200, headers: {}, modelResponse: true, tokens: { input: 1, output: 1 }, latencyMs: 10, correlationId: crypto.randomUUID(), at }] };
test('governance evidence is exact-profile/origin bound and must contain allowed and rejected observations', () => {
  assert.equal(parseGovernanceProof(proof, { ...config, origin: 'https://other.azure-api.net' }), undefined);
  assert.equal(parseGovernanceProof({ ...proof, gatewayId: 'ai-gateway' }, config), undefined);
  assert.equal(parseGovernanceProof({ ...proof, proof: { ...proof.proof, attributable: false } }, config), undefined);
  assert.throws(() => parseGovernanceProof({ ...proof, attempts: [] }, config));
  assert.throws(() => parseGovernanceProof({ ...proof, policy: { ...proof.policy, resourceId: proof.policy.resourceId.replace('/service/synthetic/', '/service/other/') } }, config));
  assert.deepEqual(parseGovernanceProof(proof, config), proof);
  assert.ok(!JSON.stringify(publicGovernanceProof(proof)).includes(config.origin!));
});
test('governance requests use one fixed model/path and server prompt, never browser overrides', () => {
  const rejected = governanceInput({ gatewayId: 'apim-v2', app: 'A', action: 'reject' }, config, proof);
  assert.equal(rejected.config.models[0].name, 'demo-policy-refusal');
  assert.equal(rejected.config.models[0].path, '/default/models/openai/v1/chat/completions');
  assert.equal(rejected.config.origin, config.origin);
  assert.equal(rejected.config.keys.B, 'synthetic-B');
  assert.equal(governanceInput({ gatewayId: 'apim-v2', app: 'B', action: 'allow' }, config, proof).config.models[0].name, proof.allowedAlias);
  for (const extra of [{ prompt: 'client override' }, { action: 'custom' }, { path: '/elsewhere' }, { url: 'https://evil.example' }]) {
    assert.throws(() => governanceInput({ gatewayId: 'apim-v2', app: 'A', action: 'reject', ...extra }, config, proof));
  }
});
test('only the exact verified native response signature marks known gateway enforcement', () => {
  const response: CallResult = { gatewayId: 'apim-v2', source: 'gateway-response', status: 400, model: 'demo-policy-refusal',
    provider: 'foundry', cloud: 'azure', latencyMs: 10, response: 'Select a configured comparison model.', modelResponse: false,
    tokens: null, headers: {}, raw: { error: { message: 'Select a configured comparison model.' } }, request: { model: 'demo-policy-refusal', messages: [] } };
  assert.equal(nativePolicyMatched(response, proof), true);
  assert.equal(nativePolicyMatched({ ...response, status: 429 }, proof), false);
  assert.equal(nativePolicyMatched({ ...response, raw: { error: { message: 'Backend input invalid' } } }, proof), false);
  assert.equal(nativePolicyMatched({ ...response, model: proof.allowedAlias }, proof), false);
  assert.equal(nativePolicyMatched({ ...response, source: 'local-error' }, proof), false);
});
test('same-caller allowlist evidence is valid without pretending it proves caller isolation; other profiles are filtered', () => {
  const sameCaller = { ...proof, proof: { ...proof.proof, bAllowed: false },
    attempts: [{ ...proof.attempts[0], gatewayId: 'apim-v2' }, { ...proof.attempts[1], app: 'A', gatewayId: 'apim-v2' },
      { ...proof.attempts[1], gatewayId: 'ai-gateway' }] };
  const actual = parseGovernanceProof(sameCaller, config);
  assert.equal(actual?.proof.bAllowed, false);
  assert.equal(actual?.attempts.length, 2);
  assert.ok(actual?.attempts.every(attempt => attempt.gatewayId === 'apim-v2'));
});
