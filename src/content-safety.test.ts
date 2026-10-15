import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublicContentSafety, renderContentSafety, safetyAssetVerified, safetySummary, standaloneSafetySettings } from './content-safety.ts';
import type { PublicContentSafetyEvidence } from './content-safety.ts';
import { observedRequestPath } from './request-path.ts';
import { journeyFacts } from './request-journey.ts';
import { gatewayOutcome } from '../server/request-evidence.ts';
import type { CallResult } from '../server/gateway.ts';

const signature = { status: 400, code: 'ContentSafetyBlocked', message: 'Content Safety blocklist rejection.' };
const evidence: PublicContentSafetyEvidence = {
  schemaVersion: 1, gatewayId: 'ai-gateway', marker: 'POC_CONTENT_SAFETY_BLOCK', capturedAt: '2026-10-14T00:00:00Z',
  backend: { resourceId: '/backend', endpoint: 'https://fixture.cognitiveservices.azure.com', sku: 'F0', blocklistName: 'poc-demo-blocklist' },
  policies: [{ resourceId: '/asset', assetName: 'safe-model', assetType: 'model', configuration: { native: true }, capturedAt: '2026-10-14T00:00:00Z' }],
  coverage: [{ resourceId: '/asset', assetName: 'safe-model', assetType: 'model', policyConfigured: true, rejectionVerified: true }],
  attempts: [
    { app: 'A', assetName: 'safe-model', action: 'reject', status: 400, headers: {}, modelResponse: false, tokens: null,
      latencyMs: 12, correlationId: '12345678-1234-1234-1234-123456789abc', at: '2026-10-14T00:00:00Z', rejectionSignature: signature },
    { app: 'A', assetName: 'safe-model', action: 'allow', status: 200, headers: {}, modelResponse: true, tokens: null,
      latencyMs: 12, correlationId: '22345678-1234-1234-1234-123456789abc', at: '2026-10-14T00:00:00Z' }
  ],
  proof: { attributable: true, allowedVerified: true, explanation: 'Fixture native proof.', rejectionSignature: signature }
};
test('Content Safety stays in Gateway controls without a separate main-diagram node or connection', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /id="(?:node-safety|edge-safety|safety-badge)"|updateSafetyConnection/);
  assert.match(main, /renderContentSafety\(/);
  assert.match(main, /executeRequest\('\/api\/content-safety\/request'/);
});
test('safety summary separates configuration and runtime proof and never inherits standalone evidence in Premium v2', () => {
  assert.match(safetySummary(evidence, 'ai-gateway'), /1 model route: marker rejected HTTP 400; clean response verified.*Saved.*not the current request/);
  assert.match(safetySummary({ ...evidence, coverage: [{ ...evidence.coverage[0], rejectionVerified: false }] }, 'ai-gateway'), /1 configured assets; 0 verified blocklist rejections/);
  assert.match(safetySummary({ ...evidence, coverage: [{ ...evidence.coverage[0], rejectionVerified: false }],
    backend: { ...evidence.backend, connected: false },
    integrationBlocker: 'MethodNotAllowedInPricingTier',
    proof: { ...evidence.proof, attributable: false, allowedVerified: false,
      explanation: 'Native backend integration blocked: MethodNotAllowedInPricingTier.', rejectionSignature: { status: 400 } },
    attempts: [] }, 'ai-gateway'), /Backend integration unverified\/MethodNotAllowedInPricingTier/);
  assert.match(safetySummary({ ...evidence, backend: { ...evidence.backend, connected: false },
    integrationBlocker: 'MethodNotAllowedInPricingTier' }, 'ai-gateway'), /0 verified blocklist rejections.*Backend integration unverified\/MethodNotAllowedInPricingTier/);
  assert.match(safetySummary({ ...evidence, backend: { ...evidence.backend, connected: true } }, 'ai-gateway'),
    /1 model route: marker rejected HTTP 400/);
  assert.match(safetySummary(undefined, 'ai-gateway'), /unavailable.*No safety enforcement/);
  assert.match(safetySummary(evidence, 'apim-v2'), /not configured.*No standalone evidence inheritance/);
  assert.equal(safetyAssetVerified({ ...evidence, attempts: [] }, 'safe-model'), false);
  assert.equal(safetyAssetVerified({ ...evidence, proof: { ...evidence.proof, rejectionSignature: { status: 400, code: 'content_filter' } } }, 'safe-model'), false);
  assert.equal(parsePublicContentSafety(evidence, 'ai-gateway'), evidence);
  const apim = { ...evidence, gatewayId: 'apim-v2' as const,
    proof: { ...evidence.proof, rejectionSignature: { ...signature, status: 403 } },
    attempts: evidence.attempts.map(attempt => attempt.action === 'reject'
      ? { ...attempt, status: 403, rejectionSignature: { ...signature, status: 403 } } : attempt) };
  assert.equal(parsePublicContentSafety(apim, 'apim-v2'), apim);
  assert.match(safetySummary(apim, 'apim-v2'), /1 model route: marker rejected HTTP 403; clean response verified/);
  const shared = { ...apim,
    policies: ['safe-model', 'second-alias'].map(assetName => ({ ...apim.policies[0], assetName })),
    coverage: [apim.coverage[0], { ...apim.coverage[0], assetName: 'second-alias', rejectionVerified: false }] };
  assert.match(safetySummary(shared, 'apim-v2'),
    /1 model route: marker rejected HTTP 403/);
  const sharedRejected = { ...shared,
    coverage: shared.coverage.map(asset => ({ ...asset, rejectionVerified: true })),
    attempts: [...shared.attempts, { ...shared.attempts[0], assetName: 'second-alias' }] };
  assert.equal(safetyAssetVerified(sharedRejected, 'second-alias'), true);
  assert.match(safetySummary(sharedRejected, 'apim-v2'), /2 model routes: marker rejected HTTP 403/);
  assert.match(safetySummary({ ...evidence, backend: { ...evidence.backend, connected: false },
    policies: [{ ...evidence.policies[0], configuration: { type: 'contentSafety', hateSeverity: 2 } }] }, 'ai-gateway'),
    /1 category-config assets; 0 verified blocklist rejections.*Backend integration unverified/);
  assert.throws(() => parsePublicContentSafety(evidence, 'apim-v2'), /another profile/);
  assert.throws(() => parsePublicContentSafety({ ...evidence, gatewayOrigin: 'hidden' }, 'ai-gateway'));
});
test('compact APIM status distinguishes four rejected routes from one clean Luna baseline', () => {
  const aliases = ['ai-cost-economy-current', 'demo-chat-secondary', 'ai-cost-premium-current', 'demo-databricks-gpt-oss-20b'];
  const apim: PublicContentSafetyEvidence = { ...evidence, gatewayId: 'apim-v2',
    proof: { ...evidence.proof, rejectionSignature: { ...signature, status: 403 } },
    coverage: aliases.map(assetName => ({ ...evidence.coverage[0], assetName })),
    policies: aliases.map(assetName => ({ ...evidence.policies[0], assetName })),
    attempts: [...aliases.map(assetName => ({ ...evidence.attempts[0], assetName, status: 403,
      rejectionSignature: { ...signature, status: 403 } })), { ...evidence.attempts[1], assetName: aliases[0] }] };
  const status = safetySummary(apim, 'apim-v2');
  assert.match(status, /^4 model routes: marker rejected HTTP 403; clean Luna response verified\. Saved/);
  assert.doesNotMatch(status, /4\/4|healthy|allowed verifications|policy scope|backend|ai-cost/);
  assert.equal(apim.attempts.filter(attempt => attempt.action === 'allow').length, 1);
});
test('Gateway controls places native Content Safety before governance without changing request wiring', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /readiness\.replaceChildren\(safety, governance, other\)/);
  assert.match(main, /executeRequest\('\/api\/content-safety\/request', \{ gatewayId, app, modelId, action \}/);
});
class Element {
  children: Element[] = [];
  id = ''; className = ''; textContent = ''; disabled = false; open = false; value = ''; type = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, callback: () => void) { this.listeners[name] = callback; }
  querySelector(selector: string): Element | undefined {
    for (const child of this.children) {
      if (selector === `#${child.id}` || selector === `.${child.className}`) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return undefined;
  }
}
test('standalone settings expose exact typed-asset categories without inventing thresholds or inheriting APIM proof', () => {
  const model = { ...evidence.policies[0], configuration: [{ type: 'contentSafety', hateSeverity: 'Medium', violenceSeverity: 'Low',
    sexualSeverity: 'High', selfHarmSeverity: 0 }, { type: 'costLimit' }] };
  const alias = { ...model, assetType: 'alias' as const, resourceId: '/alias', configuration: [{ type: 'contentSafety', hateSeverity: 'High' }] };
  const settingsEvidence = { ...evidence, policies: [model, alias],
    coverage: [evidence.coverage[0], { ...evidence.coverage[0], assetType: 'alias' as const, resourceId: '/alias' }] };
  const settings = standaloneSafetySettings(settingsEvidence, 'safe-model')!;
  assert.equal(settings.asset?.assetType, 'alias');
  assert.equal(settings.categories[0].threshold, 'High');
  assert.equal(settings.categories[1].threshold, 'Not reported');
  assert.equal(settings.modelCount, 1);
  assert.equal(settings.aliasCount, 1);
  assert.deepEqual(standaloneSafetySettings({ ...evidence, policies: [model] }, 'safe-model')?.categories.map(item => item.threshold),
    ['Medium', 'Low', 'High', '0']);
  assert.equal(standaloneSafetySettings({ ...evidence, gatewayId: 'apim-v2' }, 'safe-model'), undefined);
  assert.equal(standaloneSafetySettings(undefined, 'safe-model'), undefined);
  assert.equal(standaloneSafetySettings(evidence, 'unknown')?.configured, false);
  assert.equal(standaloneSafetySettings({ ...evidence, policies: [{ ...model, configuration: [model.configuration[0], model.configuration[0]] }] },
    'safe-model')?.configured, false);
});
test('standalone category settings are visible, follow the selected alias and keep enforcement controls conservative', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  try {
    const first = { ...evidence.policies[0], configuration: [{ type: 'contentSafety', hateSeverity: 'Medium', violenceSeverity: 'Medium',
      sexualSeverity: 'Medium', selfHarmSeverity: 'Medium' }] };
    const second = { ...first, assetName: 'second-model', resourceId: '/second', assetType: 'alias' as const,
      configuration: [{ type: 'contentSafety', hateSeverity: 'High', violenceSeverity: 'Medium', sexualSeverity: 'Medium', selfHarmSeverity: 'Medium' }] };
    const snapshot = { ...evidence, backend: { ...evidence.backend, connected: false }, policies: [first, second],
      coverage: [evidence.coverage[0], { ...evidence.coverage[0], assetName: 'second-model', resourceId: '/second', assetType: 'alias' as const }] };
    const target = new Element('section');
    const state = { gatewayId: 'ai-gateway' as const, evidence: snapshot, loading: false, busy: false,
      models: ['safe-model', 'second-model'].map((name, index) => ({ id: `model-${index}`, name, cloud: 'azure' as const, format: 'openai-chat' as const })),
      applications: [{ id: 'A' as const, ready: true }], app: 'A' as const, modelId: 'model-0' };
    renderContentSafety(target as unknown as HTMLElement, state, () => assert.fail('Rendering must not send requests'), () => {});
    assert.ok(target.children.includes(target.querySelector('#content-safety-category-settings')!));
    assert.equal(target.querySelector('#safety-threshold-hateSeverity')!.textContent, 'Medium');
    assert.match(target.querySelector('#content-safety-category-coverage')!.textContent, /2 assets.*1 model entries \+ 1 aliases.*not automatically/);
    const picker = target.querySelector('#safety-model')!;
    picker.value = 'model-1'; picker.listeners.change();
    assert.equal(target.querySelector('#safety-threshold-hateSeverity')!.textContent, 'High');
    assert.equal(target.querySelector('#safety-reject')!.disabled, true);
    assert.equal(target.querySelector('.safety-details')!.open, false);
    renderContentSafety(target as unknown as HTMLElement, { ...state, gatewayId: 'apim-v2', evidence: { ...snapshot, gatewayId: 'apim-v2' } },
      () => {}, () => {});
    assert.equal(target.querySelector('#content-safety-category-settings')!.children.length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
test('fixed safety controls require verified selected asset/caller, preserve collapsed evidence and respect shared pending', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  try {
    const state = { gatewayId: 'ai-gateway' as const, evidence, loading: false, busy: false,
      models: [{ id: 'model-1', name: 'safe-model', cloud: 'azure' as const, format: 'openai-chat' as const }],
      applications: [{ id: 'A' as const, ready: true }], app: 'A' as const, modelId: 'model-1' };
    for (const changes of [
      { evidence: undefined }, { busy: true }, { loading: true }, { gatewayId: 'apim-v2' as const },
      { applications: [{ id: 'A' as const, ready: false }] },
      { evidence: { ...evidence, backend: { ...evidence.backend, connected: false } } },
      { evidence: { ...evidence, coverage: [{ ...evidence.coverage[0], rejectionVerified: false }] } }
    ]) {
      const target = new Element('section');
      renderContentSafety(target as unknown as HTMLElement, { ...state, ...changes }, () => assert.fail('Disabled'), () => {});
      assert.equal(target.querySelector('#safety-reject')!.disabled, true);
      assert.equal(target.querySelector('#safety-allow')!.disabled, true);
      assert.equal(target.querySelector('.safety-details')!.open, false);
      if (changes.evidence?.backend.connected === false) {
        assert.match(target.querySelector('#content-safety-boundary')!.textContent,
          /Supported standalone-tier capability; this demo’s backend\/blocklist binding remains unverified/);
      }
    }
    const target = new Element('section');
    const sent: string[] = [];
    renderContentSafety(target as unknown as HTMLElement, state, (app, model, action) => sent.push(`${app}:${model}:${action}`), () => {});
    assert.deepEqual(sent, []);
    assert.equal(target.querySelector('#safety-app')!.value, 'A');
    assert.equal(target.querySelector('#safety-model')!.value, 'model-1');
    assert.ok(target.querySelector('#safety-refresh'));
    assert.equal(target.querySelector('#content-safety-boundary')!.textContent, 'Input/blocklist proof only; no output or classifier-accuracy claim.');
    const raw = target.querySelector('.safety-details')!;
    for (const id of ['content-safety-coverage', 'content-safety-provenance', 'content-safety-limitations']) {
      const node = target.querySelector(`#${id}`)!;
      assert.ok(raw.children.includes(node));
      assert.ok(!target.children.includes(node));
    }
    assert.equal(raw.open, false);
    target.querySelector('#safety-reject')!.listeners.click();
    target.querySelector('#safety-allow')!.listeners.click();
    assert.deepEqual(sent, ['A:model-1:reject', 'A:model-1:allow']);
    target.querySelector('.safety-details')!.open = true;
    renderContentSafety(target as unknown as HTMLElement, state, () => {}, () => {});
    assert.equal(target.querySelector('.safety-details')!.open, true);
    const apimTarget = new Element('section');
    renderContentSafety(apimTarget as unknown as HTMLElement, { ...state, gatewayId: 'apim-v2',
      evidence: { ...evidence, gatewayId: 'apim-v2',
        proof: { ...evidence.proof, rejectionSignature: { ...signature, status: 403 } },
        attempts: evidence.attempts.map(attempt => attempt.action === 'reject'
          ? { ...attempt, status: 403, rejectionSignature: { ...signature, status: 403 } } : attempt) } }, () => {}, () => {});
    assert.equal(apimTarget.querySelector('#safety-reject')!.disabled, false);
    assert.equal(apimTarget.querySelector('#safety-allow')!.disabled, false);
    assert.match(apimTarget.querySelector('#safety-reject')!.textContent, /HTTP 403/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
test('shared path and immutable journey explicitly stop at native safety rather than showing provider execution', () => {
  const base: CallResult = { gatewayId: 'ai-gateway', source: 'gateway-response', status: 400, model: 'safe-model',
    cloud: 'azure', provider: 'foundry', latencyMs: 12, response: 'Content Safety blocked.', modelResponse: false,
    tokens: null, headers: {}, raw: {}, request: { model: 'safe-model', messages: [] } };
  const result = { ...base, outcome: gatewayOutcome(base, 'content-safety') };
  const path = observedRequestPath({ phase: 'result', request: { application: 'A' }, result });
  assert.equal(path.length, 2);
  assert.match(path[1].detail, /native Content Safety stop.*model not called/);
  assert.ok(!path.some(step => step.kind === 'model'));
  const facts = journeyFacts(result, { gatewayId: 'ai-gateway', application: 'A', workload: 'governance-proof' });
  assert.match(facts.winnerLabel, /Not executed.*native safety/);
  assert.match(facts.outcomeLabel, /Blocked by native Content Safety/);
  assert.equal(facts.policyLabel, 'Not a workload selection');
});
