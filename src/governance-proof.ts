import type { GatewayId } from '../server/gateway.ts';

export interface GovernanceProof {
  schemaVersion: 1;
  gatewayId: GatewayId;
  capturedAt: string;
  kind: 'caller-request-limit' | 'model-allowlist';
  alias: string;
  allowedAlias: string;
  policy: { source: 'azure-control-plane'; resourceId: string; configuration: unknown; capturedAt: string };
  proof: {
    attributable: boolean; aRejected: boolean; bAllowed: boolean; explanation: string;
    rejectionSignature: { status: number; code?: string; message?: string };
  };
  attempts: { app: 'A' | 'B'; gatewayId?: GatewayId; status: number; headers: Record<string, string>; modelResponse: boolean;
    returnedModel?: string; tokens: unknown; latencyMs: number; correlationId: string; at: string }[];
  standaloneBlocker?: unknown;
}
export function parseGovernanceProof(value: unknown, gatewayId: GatewayId): GovernanceProof {
  const proof = value as GovernanceProof;
  if (!proof || proof.schemaVersion !== 1 || proof.gatewayId !== gatewayId
    || !Number.isFinite(Date.parse(proof.capturedAt))
    || !['caller-request-limit', 'model-allowlist'].includes(proof.kind)
    || typeof proof.alias !== 'string' || typeof proof.allowedAlias !== 'string'
    || proof.policy?.source !== 'azure-control-plane' || typeof proof.policy.resourceId !== 'string'
    || !proof.proof || typeof proof.proof.attributable !== 'boolean'
    || typeof proof.proof.aRejected !== 'boolean' || typeof proof.proof.bAllowed !== 'boolean'
    || typeof proof.proof.explanation !== 'string' || !Array.isArray(proof.attempts)
    || !Number.isFinite(Date.parse(proof.policy.capturedAt)) || proof.policy.configuration === undefined
    || !Number.isInteger(proof.proof.rejectionSignature?.status)
    || proof.proof.rejectionSignature.status !== (proof.kind === 'caller-request-limit' ? 429 : 400)
    || proof.attempts.some(attempt => !attempt || !['A', 'B'].includes(attempt.app)
      || !Number.isInteger(attempt.status) || typeof attempt.modelResponse !== 'boolean'
      || !Number.isFinite(Date.parse(attempt.at)) || typeof attempt.correlationId !== 'string'
      || (attempt.gatewayId !== undefined && !['ai-gateway', 'apim-v2'].includes(attempt.gatewayId)))) {
    throw new Error('Governance proof missing, unsupported or bound to another profile.');
  }
  return proof;
}
export function governanceVerified(proof: GovernanceProof): boolean {
  if (!proof.proof.attributable || !proof.proof.aRejected) return false;
  const attempts = proof.attempts.filter(attempt => !attempt.gatewayId || attempt.gatewayId === proof.gatewayId);
  const rejected = attempts.some(attempt => attempt.app === 'A'
    && attempt.status === proof.proof.rejectionSignature.status && !attempt.modelResponse);
  const allowed = attempts.some(attempt => attempt.status === 200 && attempt.modelResponse
    && (proof.kind === 'model-allowlist' || attempt.app === 'B'));
  return rejected && allowed && (proof.kind === 'model-allowlist' || proof.proof.bAllowed);
}
export function governanceCallersReady(proof: GovernanceProof | undefined,
  applications: readonly { id: 'A' | 'B'; ready: boolean }[]): boolean {
  if (!proof || !applications.some(app => app.id === 'A' && app.ready)) return false;
  return proof.kind === 'model-allowlist' || applications.some(app => app.id === 'B' && app.ready);
}
export function governanceCopy(proof: GovernanceProof) {
  return proof.kind === 'caller-request-limit' ? {
    title: 'Native caller request limit',
    boundary: 'Native gateway policy · repeat A until limited, then test B. Each click sends one fixed real request; no automatic loop or retry.',
    reject: 'Test A · repeat until limited', allow: 'Test B · allowed caller',
    saved: governanceVerified(proof)
      ? 'Saved verification: A rejected and B allowed under the attributable caller-limit policy.'
      : 'Saved verification does not establish caller isolation.'
  } : {
    title: 'Native model allowlist',
    boundary: 'Native gateway model-allowlist policy · fixed rejected alias then allowed Luna, both using caller A. This is NOT caller-isolation proof.',
    reject: 'Test rejected alias · A', allow: 'Test allowed Luna · A',
    saved: governanceVerified(proof)
      ? 'Saved verification: disallowed alias rejected and allowed alias responded. Not caller isolation.'
      : 'Saved verification does not establish model-allowlist enforcement.'
  };
}
export function gatewayPortal(gatewayId: GatewayId): string {
  return gatewayId === 'apim-v2' ? 'https://portal.azure.com/' : 'https://ai.gateway.azure.com/';
}
export function gatewayPolicyDocumentation(gatewayId: GatewayId): string {
  return gatewayId === 'apim-v2' ? 'https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-policies'
    : 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-govern-secure-assets';
}
export function renderGovernanceProof(target: HTMLElement, state: {
  proof?: GovernanceProof; error?: string; loading: boolean; busy: boolean; ready: boolean; gatewayId: GatewayId;
}, send: (app: 'A' | 'B', action: 'reject' | 'allow') => void) {
  const expanded = target.querySelector<HTMLDetailsElement>('.governance-details')?.open || false;
  target.replaceChildren();
  target.classList.add('governance-proof');
  const title = document.createElement('h3');
  title.textContent = state.proof ? governanceCopy(state.proof).title : 'Native governance proof';
  const boundary = document.createElement('p');
  boundary.id = 'native-proof-boundary';
  boundary.textContent = state.proof ? governanceCopy(state.proof).boundary
    : 'Native gateway enforcement requires this profile’s genuine verified proof. No simulation or inference from HTTP status.';
  const status = document.createElement('p');
  status.id = 'native-proof-status';
  status.setAttribute('role', state.error ? 'alert' : 'status');
  status.textContent = state.loading ? 'Loading saved profile proof…' : state.error || (state.proof
    ? `${governanceCopy(state.proof).saved} Saved at ${new Date(state.proof.capturedAt).toLocaleString()}; not the current request.`
    : 'Verified proof unavailable. Live native tests disabled.');
  const actions = document.createElement('div');
  actions.className = 'native-proof-actions';
  const verified = Boolean(state.proof && governanceVerified(state.proof));
  const allowApp = state.proof?.kind === 'model-allowlist' ? 'A' : 'B';
  for (const [id, app, action] of [['native-reject', 'A', 'reject'], ['native-allow', allowApp, 'allow']] as const) {
    const button = document.createElement('button');
    button.type = 'button'; button.id = id;
    button.textContent = state.proof ? governanceCopy(state.proof)[action] : action === 'reject' ? 'Test rejection · unavailable' : 'Test allowed request · unavailable';
    button.disabled = state.busy || !state.ready || !verified || state.loading;
    button.addEventListener('click', () => send(app, action));
    actions.append(button);
  }
  const raw = document.createElement('details');
  raw.className = 'governance-details'; raw.open = expanded;
  const summary = document.createElement('summary');
  summary.textContent = 'Saved policy configuration & attempts';
  const pre = document.createElement('pre');
  pre.textContent = state.proof ? JSON.stringify(state.proof, null, 2) : 'No profile-specific proof loaded.';
  raw.append(summary, pre);
  const link = document.createElement('a');
  link.href = gatewayPortal(state.gatewayId); link.target = '_blank'; link.rel = 'noreferrer';
  link.textContent = state.gatewayId === 'apim-v2' ? 'Inspect APIM policy XML in Azure portal ↗' : 'Inspect standalone policy cards ↗';
  target.append(title, boundary, status, actions, raw, link);
}
