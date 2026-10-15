import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayPolicyDocumentation, gatewayPortal, governanceCallersReady, governanceCopy, governanceVerified, parseGovernanceProof, renderGovernanceProof } from './governance-proof.ts';
import type { GovernanceProof } from './governance-proof.ts';

function fixture(kind: GovernanceProof['kind'] = 'model-allowlist'): GovernanceProof {
  return {
    schemaVersion: 1, gatewayId: 'apim-v2', capturedAt: '2026-10-13T01:00:00Z', kind,
    alias: kind === 'model-allowlist' ? 'demo-policy-refusal' : 'demo-governance-proof', allowedAlias: 'ai-cost-economy-current',
    policy: { source: 'azure-control-plane', resourceId: '/subscriptions/unit-test/resourceGroups/test/providers/Microsoft.ApiManagement/service/test/apis/proof/policies/policy',
      capturedAt: '2026-10-13T01:00:00Z', configuration: '<policies />' },
    proof: { attributable: true, aRejected: true, bAllowed: kind === 'caller-request-limit', explanation: 'Real saved verification',
      rejectionSignature: { status: kind === 'model-allowlist' ? 400 : 429, message: 'Verified signature' } },
    attempts: [
      { app: 'A', gatewayId: 'apim-v2', status: kind === 'model-allowlist' ? 400 : 429, headers: {}, modelResponse: false,
        tokens: null, latencyMs: 10, correlationId: '00000000-0000-4000-8000-000000000001', at: '2026-10-13T01:00:00Z' },
      { app: kind === 'model-allowlist' ? 'A' : 'B', gatewayId: 'apim-v2', status: 200, headers: {}, modelResponse: true,
        returnedModel: 'gpt-6-luna-2026-09-22', tokens: null, latencyMs: 10,
        correlationId: '00000000-0000-4000-8000-000000000002', at: '2026-10-13T01:00:01Z' }
    ]
  };
}
test('proof parsing is profile bound; unavailable/malformed proofs cannot masquerade as verified', () => {
  assert.equal(parseGovernanceProof(fixture(), 'apim-v2').kind, 'model-allowlist');
  for (const value of [undefined, {}, { ...fixture(), gatewayId: 'ai-gateway' },
    { ...fixture(), kind: 'unknown' }, { ...fixture(), capturedAt: 'invalid' }]) {
    assert.throws(() => parseGovernanceProof(value, 'apim-v2'));
  }
});
test('same-caller allowlist proof does not require B allowed, but caller-isolation proof does', () => {
  const allowlist = fixture();
  assert.equal(allowlist.proof.bAllowed, false);
  assert.equal(governanceVerified(allowlist), true);
  assert.match(governanceCopy(allowlist).saved, /disallowed alias rejected and allowed alias responded.*Not caller isolation/);
  assert.equal(governanceVerified({ ...allowlist, attempts: allowlist.attempts.slice(0, 1) }), false);
  assert.equal(governanceVerified({ ...allowlist, attempts: allowlist.attempts.map(attempt => ({ ...attempt, gatewayId: 'ai-gateway' })) }), false);
  const caller = fixture('caller-request-limit');
  assert.equal(governanceVerified(caller), true);
  assert.equal(governanceVerified({ ...caller, proof: { ...caller.proof, bAllowed: false } }), false);
  assert.equal(governanceVerified({ ...caller, attempts: caller.attempts.map(attempt => ({ ...attempt, app: 'A' })) }), false);
  const onlyAReady = [{ id: 'A' as const, ready: true }, { id: 'B' as const, ready: false }];
  assert.equal(governanceCallersReady(allowlist, onlyAReady), true);
  assert.equal(governanceCallersReady(caller, onlyAReady), false);
  assert.equal(governanceCallersReady(undefined, onlyAReady), false);
});
test('caller limit and allowlist descriptions preserve exact native boundaries and saved/current separation', () => {
  const allowlist = governanceCopy(fixture());
  assert.match(allowlist.boundary, /NOT caller-isolation proof/);
  assert.match(allowlist.saved, /Saved verification.*Not caller isolation/);
  assert.match(allowlist.reject, /rejected alias/);
  assert.match(allowlist.allow, /Luna/);
  const limit = governanceCopy(fixture('caller-request-limit'));
  assert.match(limit.boundary, /repeat A until limited.*test B.*one fixed real request/);
  assert.match(limit.saved, /A rejected and B allowed/);
});
test('portal and policy documentation distinguish APIM XML from standalone cards', () => {
  assert.equal(gatewayPortal('ai-gateway'), 'https://ai.gateway.azure.com/');
  assert.equal(gatewayPortal('apim-v2'), 'https://portal.azure.com/');
  assert.match(gatewayPolicyDocumentation('apim-v2'), /api-management-howto-policies/);
  assert.match(gatewayPolicyDocumentation('ai-gateway'), /ai-gateway-govern-secure-assets/);
});

class Element {
  children: Element[] = [];
  id = ''; className = ''; textContent = ''; disabled = false; open = false;
  classList = { add: (_name: string) => {} };
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
test('native proof buttons are disabled for unavailable, unverified, loading and pending states; raw proof stays collapsed', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  try {
    for (const state of [
      { proof: undefined, loading: false, busy: false, ready: true },
      { proof: { ...fixture(), proof: { ...fixture().proof, attributable: false } }, loading: false, busy: false, ready: true },
      { proof: fixture(), loading: true, busy: false, ready: true },
      { proof: fixture(), loading: false, busy: true, ready: true },
      { proof: fixture(), loading: false, busy: false, ready: false }
    ]) {
      const target = new Element('section');
      renderGovernanceProof(target as unknown as HTMLElement, { ...state, gatewayId: 'apim-v2' }, () => assert.fail('Must not send during rendering'));
      assert.equal(target.querySelector('#native-reject')!.disabled, true);
      assert.equal(target.querySelector('#native-allow')!.disabled, true);
      assert.equal(target.querySelector('.governance-details')!.open, false);
    }
    const target = new Element('section');
    const calls: string[] = [];
    renderGovernanceProof(target as unknown as HTMLElement, { proof: fixture(), loading: false, busy: false, ready: true, gatewayId: 'apim-v2' },
      (app, action) => calls.push(`${app}:${action}`));
    assert.deepEqual(calls, []);
    target.querySelector('#native-reject')!.listeners.click();
    target.querySelector('#native-allow')!.listeners.click();
    assert.deepEqual(calls, ['A:reject', 'A:allow']);
    assert.match(target.querySelector('#native-proof-status')!.textContent, /Saved at.*not the current request/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
