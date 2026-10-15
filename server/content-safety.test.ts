import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGateway } from './gateway.ts';
import type { CallResult, Config } from './gateway.ts';
import { contentSafetyInput, nativeSafetyMatched, nativeSafetySignature, parseContentSafetyEvidence,
  publicContentSafetyEvidence, readContentSafetyEvidence, SAFETY_MARKER, verifiedSafetyAsset } from './content-safety.ts';
import { gatewayOutcome, requestEvent } from './request-evidence.ts';
import { routingPresets } from './routing-policy.ts';

const config: Config = { gatewayId: 'ai-gateway', gatewayType: 'standalone-ai-gateway',
  origin: 'https://fixture.australiaeast.ai.gateway.azure.com', keys: { A: 'secret-fixture-key', B: 'other-fixture-key' },
  models: [{ id: 'model-1', name: 'safe-model', cloud: 'azure', provider: 'foundry', format: 'openai-chat' },
    { id: 'model-2', name: 'unverified-model', cloud: 'azure', provider: 'foundry', format: 'openai-chat' }] };
const at = '2026-10-14T00:00:00.000Z';
const resourceId = '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/aiGateways/fixture/workspaces/default/modelProviders/azure-models/models/safe-model';
const rejectionSignature = { status: 400, code: 'ContentSafetyBlocked', message: 'Request blocked by native Content Safety blocklist.' };
function fixture() {
  return {
    schemaVersion: 1, gatewayId: 'ai-gateway', gatewayOrigin: config.origin, capturedAt: at,
    backend: { resourceId: '/subscriptions/test/resourceGroups/demo/providers/Microsoft.CognitiveServices/accounts/safety',
      endpoint: 'https://fixture-safety.cognitiveservices.azure.com/', sku: 'F0', blocklistName: 'poc-demo-blocklist' },
    marker: SAFETY_MARKER,
    policies: [{ resourceId, assetName: 'safe-model', assetType: 'model', configuration: { native: { settings: { backendKey: 'never-public', enabled: true } } }, capturedAt: at }],
    coverage: [{ resourceId, assetName: 'safe-model', assetType: 'model', policyConfigured: true, rejectionVerified: true }],
    attempts: [
      { app: 'A', assetName: 'safe-model', action: 'reject', status: 400, headers: { 'api-key': 'never-public', 'x-request-id': 'req_abcdef' },
        modelResponse: false, tokens: null, latencyMs: 15, correlationId: '12345678-1234-1234-1234-123456789abc', at, rejectionSignature },
      { app: 'B', assetName: 'safe-model', action: 'allow', status: 200, headers: {}, modelResponse: true,
        tokens: { input: 4, output: 4, total: 8 }, latencyMs: 20, correlationId: '22345678-1234-1234-1234-123456789abc', at }
    ],
    proof: { attributable: true, allowedVerified: true, explanation: 'Native fixture policy matched.', rejectionSignature }
  };
}
function result(raw: unknown = { error: { code: rejectionSignature.code, message: rejectionSignature.message } }): CallResult {
  return { gatewayId: 'ai-gateway', gatewayType: 'standalone-ai-gateway', source: 'gateway-response', status: 400,
    model: 'safe-model', cloud: 'azure', provider: 'foundry', latencyMs: 12, response: rejectionSignature.message,
    modelResponse: false, tokens: null, headers: {}, raw, request: { model: 'safe-model', messages: [] } };
}
test('native safety evidence binds profile, origin, hostname and exact asset ARM path; public proof strips transport and keys', () => {
  const evidence = parseContentSafetyEvidence(fixture(), config)!;
  assert.equal(verifiedSafetyAsset(evidence, 'safe-model'), true);
  assert.equal(verifiedSafetyAsset(evidence, 'unverified-model'), false);
  assert.equal(parseContentSafetyEvidence(fixture(), { ...config, gatewayId: 'apim-v2' }), undefined);
  assert.equal(parseContentSafetyEvidence({ ...fixture(), gatewayOrigin: 'https://other.azure-api.net' }, config), undefined);
  const publicEvidence = JSON.stringify(publicContentSafetyEvidence(evidence));
  assert.ok(!publicEvidence.includes('gatewayOrigin') && !publicEvidence.includes('never-public'));
  for (const resourceId of [
    '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/aiGateways/not-fixture/models/safe-model',
    '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/aiGateways/fixture/models/safe-model',
    '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/aiGateways/fixture/workspaces/default/models/safe-model',
    '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/aiGateways/fixture/models/other',
    '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/service/fixture/models/safe-model'
  ]) {
    const value = fixture(); value.policies[0].resourceId = resourceId;
    assert.throws(() => parseContentSafetyEvidence(value, config), /evidence invalid/);
  }
});
test('inconsistent coverage, signature, attempts and validated scalar types are rejected', () => {
  const cases = [
    (value: ReturnType<typeof fixture>) => { value.attempts.pop(); },
    (value: ReturnType<typeof fixture>) => { value.attempts[0].rejectionSignature = { ...rejectionSignature, message: 'Different native message' }; },
    (value: ReturnType<typeof fixture>) => { value.proof.rejectionSignature = { status: 400, code: 'content_filter', message: 'Filtered' }; },
    (value: ReturnType<typeof fixture>) => { value.attempts[0].correlationId = 'not-a-uuid'; },
    (value: ReturnType<typeof fixture>) => { value.attempts[0].latencyMs = -1; },
    (value: ReturnType<typeof fixture>) => { value.attempts[1].modelResponse = false; },
    (value: ReturnType<typeof fixture>) => { value.coverage[0].policyConfigured = false; },
    (value: ReturnType<typeof fixture>) => { value.coverage.push({ ...value.coverage[0] }); },
    (value: ReturnType<typeof fixture>) => { value.policies[0].configuration.native.settings.backendKey = config.keys.A!; }
  ];
  for (const change of cases) {
    const value = fixture(); change(value);
    assert.throws(() => parseContentSafetyEvidence(value, config), /evidence invalid/);
  }
  assert.equal(nativeSafetySignature({ status: 400 }), false);
  assert.equal(nativeSafetySignature({ status: 400, code: 'content_filter', message: 'Rejected by provider' }), false);
});
test('absent, unbound and partial safety evidence never enables proof actions; Premium v2 cannot inherit evidence', () => {
  assert.equal(readContentSafetyEvidence(config, 'server/nonexistent-content-safety-fixture.json'), undefined);
  assert.equal(readContentSafetyEvidence({ ...config, gatewayId: 'apim-v2' }, 'server/content-safety.ts'), undefined);
  const partial = fixture();
  partial.coverage[0].rejectionVerified = false;
  partial.proof.attributable = false;
  partial.proof.allowedVerified = false;
  partial.attempts = [];
  const evidence = parseContentSafetyEvidence(partial, config)!;
  assert.equal(verifiedSafetyAsset(evidence, 'safe-model'), false);
  assert.throws(() => contentSafetyInput({ gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', action: 'reject' }, config, evidence), /no attributable/);
});
test('native severity-only configuration can remain partial with no rejection signature or integration proof', () => {
  const value = fixture();
  const partial = {
    ...value,
    backend: { ...value.backend, connected: false },
    integrationBlocker: 'Native /backends rejected: MethodNotAllowedInPricingTier.',
    policies: [{ ...value.policies[0], configuration: {
      type: 'contentSafety', hateSeverity: 2, violenceSeverity: 2, sexualSeverity: 2, selfHarmSeverity: 2
    } }],
    coverage: [{ ...value.coverage[0], rejectionVerified: false }],
    attempts: [],
    proof: { attributable: false, allowedVerified: false,
      explanation: 'Native backend integration blocked: MethodNotAllowedInPricingTier. No harmless-marker rejection.',
      rejectionSignature: { status: 400 } }
  };
  const evidence = parseContentSafetyEvidence(partial, config)!;
  assert.equal(evidence.coverage[0].policyConfigured, true);
  assert.equal(evidence.backend.connected, false);
  assert.equal(publicContentSafetyEvidence(evidence).integrationBlocker, partial.integrationBlocker);
  assert.deepEqual(evidence.policies[0].configuration, partial.policies[0].configuration);
  assert.equal(verifiedSafetyAsset(evidence, 'safe-model'), false);
  assert.throws(() => contentSafetyInput({ gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', action: 'reject' },
    config, evidence), /no attributable/);
  assert.throws(() => parseContentSafetyEvidence({ ...partial, backend: { ...partial.backend, connected: 'false' } }, config));
  assert.throws(() => parseContentSafetyEvidence({ ...partial, integrationBlocker: 123 }, config));
  assert.throws(() => parseContentSafetyEvidence({ ...partial, proof: { ...partial.proof, attributable: true } }, config));
  assert.throws(() => parseContentSafetyEvidence({ ...value, backend: { ...value.backend, connected: false } }, config));
});
test('fixed proof input rejects arbitrary prompts, transport overrides, asset substitutions and caller errors', () => {
  const evidence = parseContentSafetyEvidence(fixture(), config)!;
  const body = { gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', action: 'reject' };
  assert.equal(contentSafetyInput(body, config, evidence).prompt, `${SAFETY_MARKER}. Reply exactly SAFETY_OK.`);
  assert.equal(contentSafetyInput({ ...body, action: 'allow' }, config, evidence).prompt, 'Reply exactly SAFETY_OK.');
  for (const value of [{ ...body, prompt: 'Arbitrary' }, { ...body, origin: config.origin },
    { ...body, modelId: 'model-2' }, { ...body, app: 'C' }, { ...body, gatewayId: 'apim-v2' }]) {
    assert.throws(() => contentSafetyInput(value, config, evidence));
  }
});
test('one mocked upstream call propagates correlation; exact verified safety stop has safety-specific recovery and content-free event', async () => {
  const evidence = parseContentSafetyEvidence(fixture(), config)!;
  let calls = 0;
  const correlationId = '32345678-1234-1234-1234-123456789abc';
  const input = contentSafetyInput({ gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', action: 'reject' }, config, evidence);
  const observed = await callGateway(config, input, (async (_url: unknown, options: RequestInit) => {
    calls++;
    const headers = new Headers(options.headers);
    assert.equal(headers.get('x-correlation-id'), correlationId);
    assert.equal(headers.get('api-key'), config.keys.A);
    return new Response(JSON.stringify(result().raw), { status: 400 });
  }) as typeof fetch, { correlationId });
  assert.equal(calls, 1);
  assert.equal(nativeSafetyMatched(observed, config, evidence), true);
  const outcome = gatewayOutcome(observed, 'content-safety');
  assert.equal(outcome.nativeControl, 'content-safety');
  assert.equal(outcome.enforcementBoundary, 'native-gateway-policy');
  assert.match(outcome.recovery!, /Content Safety.*do not bypass/i);
  assert.doesNotMatch(outcome.recovery!, /allowed alias/);
  const event = requestEvent({ correlationId, decisionId: correlationId, policy: routingPresets[0] },
    { workload: 'governance-proof', status: observed.status, outcome, result: observed, application: 'A' });
  assert.equal(event.policy, null);
  assert.equal(event.selectedProvider, null);
  assert.equal(event.selectedModel, null);
  assert.equal(event.requestedAlias, 'safe-model');
  const logged = JSON.stringify(event);
  assert.ok(!logged.includes(SAFETY_MARKER) && !logged.includes(config.keys.A!) && !logged.includes(rejectionSignature.message));
});
test('normal and routed outcomes require exact native signature plus covered matching asset, never provider generic filters', () => {
  const evidence = parseContentSafetyEvidence(fixture(), config)!;
  assert.equal(nativeSafetyMatched(result(), config, evidence), true);
  for (const value of [
    result({ error: { code: 'content_filter', message: 'Blocked by provider' } }),
    result({ error: { code: rejectionSignature.code, message: 'Changed message' } }),
    { ...result(), model: 'unverified-model' },
    { ...result(), status: 403 },
    { ...result(), gatewayId: 'apim-v2' as const },
    { ...result(), modelResponse: true }
  ]) assert.equal(nativeSafetyMatched(value, config, evidence), false);
  assert.equal(nativeSafetyMatched(result(), { ...config, origin: 'https://other.azure-api.net' }, evidence), false);
  assert.match(gatewayOutcome(result(), true).recovery!, /allowed alias/);
  assert.equal(gatewayOutcome(result()).enforcementBoundary, 'unknown-upstream');
});
test('Premium v2 safety evidence is separately profile/service/API-bound, never inherited from standalone', async () => {
  const apim: Config = { ...config, gatewayId: 'apim-v2', gatewayType: 'apim-premium-v2',
    authHeader: 'Ocp-Apim-Subscription-Key', origin: 'https://fixture-apim.azure-api.net' };
  const value = fixture();
  const apiPolicy = '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/service/fixture-apim/apis/default/operations/chat-completions/policies/policy';
  const saved = {
    ...value, gatewayId: 'apim-v2', gatewayOrigin: apim.origin, backend: { ...value.backend, connected: true },
    policies: [{ ...value.policies[0], resourceId: apiPolicy,
      configuration: '<policies><inbound><llm-content-safety backend-id="safety-demo" /><set-header name="api-key"><value>xml-secret-not-public</value></set-header></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>' }],
    coverage: [{ ...value.coverage[0], resourceId: apiPolicy }],
    proof: { ...value.proof, rejectionSignature: { ...value.proof.rejectionSignature, status: 403 } },
    attempts: value.attempts.map(attempt => attempt.action === 'reject'
      ? { ...attempt, status: 403, rejectionSignature: { ...rejectionSignature, status: 403 } } : attempt)
  };
  const evidence = parseContentSafetyEvidence(saved, apim)!;
  assert.equal(evidence.gatewayId, 'apim-v2');
  assert.equal(verifiedSafetyAsset(evidence, 'safe-model'), true);
  assert.ok(!JSON.stringify(publicContentSafetyEvidence(evidence)).includes('xml-secret-not-public'));
  assert.equal(parseContentSafetyEvidence(saved, config), undefined);
  assert.equal(parseContentSafetyEvidence(value, apim), undefined);
  const input = contentSafetyInput({ gatewayId: 'apim-v2', app: 'A', modelId: 'model-1', action: 'reject' }, apim, evidence);
  let count = 0;
  const observed = await callGateway(apim, input, (async (_url: unknown, options: RequestInit) => {
    count++;
    assert.equal(new Headers(options.headers).get('Ocp-Apim-Subscription-Key'), apim.keys.A);
    return new Response(JSON.stringify(result().raw), { status: 403 });
  }) as typeof fetch);
  assert.equal(count, 1);
  assert.equal(nativeSafetyMatched(observed, apim, evidence), true);
  const outcome = gatewayOutcome(observed, 'content-safety');
  assert.equal(outcome.enforcementBoundary, 'native-gateway-policy');
  assert.match(outcome.recovery!, /Native Content Safety blocked/);
  assert.doesNotMatch(outcome.recovery!, /runtime key|identity permissions|allowed alias/);
  assert.equal(nativeSafetyMatched(observed, config, evidence), false);
  for (const resourceId of [
    apiPolicy.replace('/service/fixture-apim/', '/service/another/'),
    apiPolicy.replace('/apis/default/', '/products/default/'),
    apiPolicy.replace('/policies/policy', '/policies/other')
  ]) {
    assert.throws(() => parseContentSafetyEvidence({ ...saved,
      policies: [{ ...saved.policies[0], resourceId }], coverage: [{ ...saved.coverage[0], resourceId }] }, apim));
  }
  assert.throws(() => parseContentSafetyEvidence({ ...saved, policies: [{ ...saved.policies[0], assetName: 'unknown-model' }] }, apim));
  assert.throws(() => parseContentSafetyEvidence({ ...saved, policies: [{ ...saved.policies[0], configuration: { type: 'contentSafety' } }] }, apim));
  assert.throws(() => parseContentSafetyEvidence({ ...saved,
    proof: { ...saved.proof, rejectionSignature: { ...saved.proof.rejectionSignature, status: 400 } } }, apim));
});
test('one native APIM API policy can legitimately cover four distinct published aliases, without inheriting runtime proof', () => {
  const aliases = ['ai-cost-economy-current', 'demo-chat-secondary', 'ai-cost-premium-current', 'demo-databricks-gpt-oss-20b'];
  const apim: Config = { ...config, gatewayId: 'apim-v2', gatewayType: 'apim-premium-v2',
    origin: 'https://fixture-apim.azure-api.net',
    models: aliases.map((name, index) => ({ id: `model-${index + 1}`, name, cloud: 'azure', format: 'openai-chat' })) };
  const apiPolicy = '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/service/fixture-apim/apis/gateway-comparison/policies/policy';
  const value = fixture();
  const saved = { ...value, gatewayId: 'apim-v2', gatewayOrigin: apim.origin,
    backend: { ...value.backend, connected: true },
    policies: aliases.map(assetName => ({ resourceId: apiPolicy, assetName, assetType: 'model',
      configuration: '<policies><inbound><llm-content-safety backend-id="safety-demo" /></inbound></policies>', capturedAt: at })),
    coverage: aliases.map((assetName, index) => ({ resourceId: apiPolicy, assetName, assetType: 'model',
      policyConfigured: true, rejectionVerified: index === 0 })),
    proof: { ...value.proof, rejectionSignature: { ...rejectionSignature, status: 403 } },
    attempts: value.attempts.map(attempt => ({ ...attempt, assetName: aliases[0],
      ...(attempt.action === 'reject' ? { status: 403, rejectionSignature: { ...rejectionSignature, status: 403 } } : {}) }))
  };
  const evidence = parseContentSafetyEvidence(saved, apim)!;
  assert.equal(evidence.policies.length, 4);
  assert.equal(evidence.coverage.length, 4);
  assert.equal(new Set(evidence.policies.map(policy => policy.resourceId)).size, 1);
  assert.equal(verifiedSafetyAsset(evidence, aliases[0]), true);
  for (const name of aliases.slice(1)) assert.equal(verifiedSafetyAsset(evidence, name), false);
  assert.throws(() => contentSafetyInput({ gatewayId: 'apim-v2', app: 'A', modelId: 'model-2', action: 'reject' }, apim, evidence),
    /no attributable/);
  const nativeSignature = { status: 403, message: 'Request failed content safety check.' };
  const fullyRejected = {
    ...saved,
    proof: { ...saved.proof, rejectionSignature: nativeSignature },
    coverage: saved.coverage.map(entry => ({ ...entry, rejectionVerified: true })),
    attempts: [
      ...aliases.map((assetName, index) => ({ ...value.attempts[0], assetName, status: 403,
        correlationId: `${index + 3}2345678-1234-1234-1234-123456789abc`, rejectionSignature: nativeSignature })),
      { ...value.attempts[1], assetName: aliases[0], tokens: { input: 12, output: 7, total: 19 } }
    ]
  };
  const verified = parseContentSafetyEvidence(fullyRejected, apim)!;
  for (const name of aliases) {
    assert.equal(verifiedSafetyAsset(verified, name), true);
    assert.equal(nativeSafetyMatched({ ...result({ message: nativeSignature.message }), gatewayId: 'apim-v2',
      gatewayType: 'apim-premium-v2', model: name, status: 403 }, apim, verified), true);
  }
  assert.equal(verified.attempts.filter(attempt => attempt.action === 'allow').length, 1);
  const unrelated = { ...fullyRejected, policies: fullyRejected.policies.map((policy, index) => index === 1
    ? { ...policy, resourceId: apiPolicy.replace('/gateway-comparison/', '/another-api/') } : policy),
    coverage: fullyRejected.coverage.map((entry, index) => index === 1
      ? { ...entry, resourceId: apiPolicy.replace('/gateway-comparison/', '/another-api/') } : entry) };
  assert.throws(() => parseContentSafetyEvidence(unrelated, apim), /evidence invalid/);
});
test('genuine standalone workspace/provider model and alias readbacks remain separate category-only assets', () => {
  const value = fixture();
  const root = '/subscriptions/test/resourceGroups/demo/providers/Microsoft.ApiManagement/aiGateways/fixture/workspaces/default';
  const assets = [
    { assetName: 'safe-model', assetType: 'model', resourceId: `${root}/modelProviders/azure-models/models/safe-model` },
    { assetName: 'safe-model', assetType: 'alias', resourceId: `${root}/aliases/safe-model` },
    { assetName: 'safe-model', assetType: 'model', resourceId: `${root}/modelProviders/another-provider/models/safe-model` }
  ];
  const partial = { ...value, backend: { ...value.backend, connected: false },
    policies: assets.map(asset => ({ ...asset, configuration: [{ type: 'contentSafety', hateSeverity: 2 }], capturedAt: at })),
    coverage: assets.map(asset => ({ ...asset, policyConfigured: true, rejectionVerified: false })),
    attempts: value.attempts.map(attempt => ({ ...attempt, status: 200, modelResponse: true, rejectionSignature: undefined })),
    proof: { ...value.proof, attributable: false, rejectionSignature: { status: 400 } } };
  const evidence = parseContentSafetyEvidence(partial, config)!;
  assert.equal(evidence.coverage.length, 3);
  assert.equal(evidence.coverage[0].assetName, evidence.coverage[1].assetName);
  assert.equal(verifiedSafetyAsset(evidence, 'safe-model'), false);
  assert.equal(evidence.attempts[0].action, 'reject');
  assert.equal(evidence.attempts[0].status, 200);
  assert.equal(evidence.attempts[0].modelResponse, true);
  assert.throws(() => parseContentSafetyEvidence({ ...partial, policies: [...partial.policies, partial.policies[0]] }, config));
  assert.throws(() => parseContentSafetyEvidence({ ...partial, coverage: [...partial.coverage, partial.coverage[0]] }, config));
  assert.throws(() => parseContentSafetyEvidence({ ...partial, policies: [
    { ...partial.policies[0], resourceId: partial.policies[0].resourceId.replace('/default/', '/another-workspace/') },
    partial.policies[1]
  ] }, config));
});
