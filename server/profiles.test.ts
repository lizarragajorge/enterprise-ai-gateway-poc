import assert from 'node:assert/strict';
import test from 'node:test';
import { callGateway, loadConfig } from './gateway.ts';
import { loadProfile, loadProfiles, publicProfiles, validateGatewayId } from './profiles.ts';
import { evaluationBinding, evaluationFile, profileEvaluation } from './evaluation.ts';
import { evaluationFixture } from './evaluation-fixtures.ts';
import { CostRouter } from './routing.ts';
import { apimDatabricksAuth, catalogEntries, requestContract } from '../src/model-catalog.ts';
import { parseProfileEvidence } from './profile-evidence.ts';
import { parsePolicyEvidence } from './policy-evidence.ts';

const env = {
  GATEWAY_ORIGIN: 'https://standalone.azure-api.net', APP_A_KEY: 'standalone-secret',
  MODEL_1_NAME: 'original',
  APIM_V2_GATEWAY_ORIGIN: 'https://premium.azure-api.net', APIM_V2_APP_A_KEY: 'premium-secret',
  APIM_V2_MODEL_1_NAME: 'premium-alias', APIM_V2_MODEL_4_NAME: 'demo-databricks-gpt-oss-20b',
  APIM_V2_MODEL_4_PROVIDER: 'databricks'
};
test('standalone loadConfig is unchanged and safe public profiles contain no credentials', () => {
  assert.equal(loadConfig(env).models[0].name, 'original');
  const profiles = loadProfiles(env);
  assert.equal(profiles['apim-v2'].models[0].name, 'premium-alias');
  const safe = publicProfiles(profiles);
  assert.equal(safe.profiles[1].foundryAssociated, false);
  assert.equal(publicProfiles(loadProfiles({ ...env, APIM_V2_FOUNDRY_ASSOCIATED: 'true' })).profiles[1].foundryAssociated, true);
  assert.match(safe.profiles[1].lifecycle, /infrastructure GA.*integration preview/);
  assert.ok(!JSON.stringify(safe).includes('secret'));
  assert.ok(!JSON.stringify(safe).includes('https://'));
  for (const id of [null, '', 'premium', 'https://evil.example']) assert.throws(() => validateGatewayId(id));
});
test('APIM rejects unapproved origins, authentication headers, path escape and invalid association flags', () => {
  for (const change of [
    { APIM_V2_GATEWAY_ORIGIN: 'https://evil.example' },
    { APIM_V2_AUTH_HEADER: 'Host' }, { APIM_V2_AUTH_HEADER: 'Authorization' },
    { APIM_V2_MODEL_1_PATH: '//evil.example/path' }, { APIM_V2_MODEL_1_PATH: '/default/models/../evil' },
    { APIM_V2_MODEL_1_PATH: '/default/models/openai?x=y' },
    { APIM_V2_MODEL_1_PATH: '/default/models/' + 'x'.repeat(200) },
    { APIM_V2_FOUNDRY_ASSOCIATED: 'yes' }
  ]) assert.throws(() => loadProfile({ ...env, ...change }, 'apim-v2'));
});
test('each real call captures profile credentials, defaults and native Databricks parsing without cross-profile retry', async () => {
  const profiles = loadProfiles(env);
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ model: 'gpt-oss-20b-080525', choices: [{ message: { content: 'READY' } }] }), { status: 200 });
  }) as typeof fetch;
  for (const id of ['ai-gateway', 'apim-v2'] as const) {
    const result = await callGateway(profiles[id], { app: 'A', modelId: 'model-1', prompt: 'hello' }, fetcher);
    assert.equal(result.gatewayId, id);
    assert.ok(calls.at(-1)!.url.endsWith('/default/models/openai/v1/chat/completions'));
  }
  assert.equal(calls[0].headers.get('api-key'), 'standalone-secret');
  assert.equal(calls[1].headers.get('Ocp-Apim-Subscription-Key'), 'premium-secret');
  assert.equal(calls[1].headers.get('api-key'), null);
  const native = await callGateway(profiles['apim-v2'], { app: 'A', modelId: 'model-4', prompt: 'hello' }, fetcher);
  assert.equal(native.response, 'READY');
  assert.equal(native.modelResponse, true);
  assert.ok(calls[2].url.endsWith('/default/models/databricks-gpt-oss-20b/invocations'));
  let attempts = 0;
  const failed = await callGateway(profiles['apim-v2'], { app: 'A', modelId: 'model-1', prompt: 'hello' },
    (async () => { attempts++; throw new Error('Synthetic failure'); }) as typeof fetch);
  assert.equal(attempts, 1);
  assert.equal(failed.gatewayId, 'apim-v2');
  assert.equal(failed.source, 'local-error');
});
test('APIM transport overrides are server validated and catalog displays the selected contract only', () => {
  const config = loadProfile({ ...env, APIM_V2_AUTH_HEADER: 'api-key', APIM_V2_MODEL_1_PATH: '/default/models/custom/v1/chat/completions', APIM_V2_FOUNDRY_ASSOCIATED: 'true' }, 'apim-v2');
  assert.equal(config.authHeader, 'api-key');
  assert.equal(config.foundryAssociated, true);
  assert.equal(config.models[0].path, '/default/models/custom/v1/chat/completions');
  const entries = catalogEntries([], new Set(), false);
  assert.ok(entries.every(entry => !('directVerification' in entry)));
  assert.match(apimDatabricksAuth, /managed identity.*workspace-access only/);
  assert.ok(!/expir|seven-day|inference.scoped/i.test(apimDatabricksAuth));
  assert.match(requestContract({ id: 'x', cloud: 'azure', label: 'x', status: 'Configured, unverified', model: config.models[0] }, 'Ocp-Apim-Subscription-Key'), /custom\/v1\/chat\/completions\nOcp-Apim-Subscription-Key/);
});
test('evaluation files and approvals are profile and exact configuration bound', () => {
  const profiles = loadProfiles(env);
  const legacy = evaluationFixture();
  assert.equal(profileEvaluation(profiles['ai-gateway'], legacy), legacy);
  assert.equal(profileEvaluation(profiles['apim-v2'], legacy), undefined);
  const bound = { ...legacy, gatewayId: 'apim-v2' as const, gatewayType: 'apim-premium-v2' as const, configBinding: evaluationBinding(profiles['apim-v2']) };
  assert.equal(profileEvaluation(profiles['apim-v2'], bound), bound);
  assert.equal(profileEvaluation(profiles['ai-gateway'], bound), undefined);
  assert.equal(profileEvaluation({ ...profiles['apim-v2'], origin: 'https://other.azure-api.net' }, bound), undefined);
  assert.notEqual(evaluationFile('ai-gateway'), evaluationFile('apim-v2'));
  const router = new CostRouter(profiles['apim-v2'], undefined, () => Date.parse(legacy.completedAt), legacy);
  assert.equal(router.snapshot('A').evaluation, undefined);
  assert.ok(router.snapshot('A').candidates.every(candidate => !candidate.approval.approved));
});
test('APIM policy evidence requires explicit matching profile and origin and preserves safe source validation', () => {
  const config = loadProfile(env, 'apim-v2');
  const evidence = { source: 'azure-control-plane', capturedAt: '2026-10-13T00:00:00Z', models: [] };
  const wrapped = { gatewayId: 'apim-v2', gatewayOrigin: config.origin, evidence };
  assert.deepEqual(parseProfileEvidence(config, wrapped, parsePolicyEvidence), evidence);
  assert.equal(parseProfileEvidence(config, evidence, parsePolicyEvidence), undefined);
  assert.equal(parseProfileEvidence(config, { ...wrapped, gatewayId: 'ai-gateway' }, parsePolicyEvidence), undefined);
  assert.equal(parseProfileEvidence(config, { ...wrapped, gatewayOrigin: 'https://other.azure-api.net' }, parsePolicyEvidence), undefined);
  assert.throws(() => parseProfileEvidence(config, { ...wrapped, evidence: { ...evidence, source: 'invented' } }, parsePolicyEvidence));
});
