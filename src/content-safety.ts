import type { GatewayId, Model } from '../server/gateway.ts';
import type { PublicContentSafetyEvidence } from '../server/content-safety.ts';
export type { PublicContentSafetyEvidence } from '../server/content-safety.ts';

export function safetyAssetVerified(evidence: PublicContentSafetyEvidence, assetName: string, assetType?: 'model' | 'alias', resourceId?: string): boolean {
  const asset = resourceId ? evidence.coverage.find(entry => entry.assetName === assetName && entry.resourceId === resourceId
    && (!assetType || entry.assetType === assetType))
    : assetType ? evidence.coverage.find(entry => entry.assetName === assetName && entry.assetType === assetType)
    : evidence.coverage.find(entry => entry.assetName === assetName && entry.assetType === 'alias')
      || evidence.coverage.find(entry => entry.assetName === assetName);
  const signature = evidence.proof.rejectionSignature;
  const allowed = evidence.attempts.some(entry => entry.action === 'allow' && entry.status >= 200 && entry.status < 300
    && entry.modelResponse && (entry.assetName === assetName || (evidence.gatewayId === 'apim-v2' && asset
      && evidence.coverage.some(other => other.assetName === entry.assetName && other.policyConfigured && other.resourceId === asset.resourceId))));
  return Boolean(evidence.backend.connected !== false && asset?.policyConfigured && asset.rejectionVerified && evidence.proof.attributable && evidence.proof.allowedVerified
    && signature.status === (evidence.gatewayId === 'apim-v2' ? 403 : 400)
    && /content[\s_-]*safety|block[\s_-]*list|POC_CONTENT_SAFETY_BLOCK|prompt[\s_-]*shield/i.test(`${signature.code || ''} ${signature.message || ''}`)
    && evidence.attempts.some(entry => entry.assetName === assetName && entry.action === 'reject'
      && entry.status === signature.status && !entry.modelResponse && entry.rejectionSignature
      && (!signature.code || entry.rejectionSignature.code === signature.code)
      && (!signature.message || entry.rejectionSignature.message === signature.message))
    && allowed);
}
export function safetySummary(evidence: PublicContentSafetyEvidence | undefined, gatewayId: GatewayId): string {
  if (gatewayId === 'apim-v2' && (!evidence || evidence.gatewayId !== gatewayId)) return 'Content Safety not configured for APIM Premium v2. No standalone evidence inheritance.';
  if (evidence && evidence.gatewayId !== gatewayId) return 'Native Content Safety evidence belongs to another profile. No evidence inheritance.';
  if (!evidence) return 'Native Content Safety evidence unavailable. No safety enforcement claimed.';
  const configured = evidence.coverage.filter(asset => asset.policyConfigured).length;
  const verified = evidence.coverage.filter(asset => safetyAssetVerified(evidence, asset.assetName, asset.assetType, asset.resourceId)).length;
  const categoryOnly = gatewayId === 'ai-gateway' && !verified
    && evidence.policies.some(policy => /"type"\s*:\s*"contentSafety"/i.test(JSON.stringify(policy.configuration)));
  const saved = ` Saved ${new Date(evidence.capturedAt).toLocaleString()}; not the current request.`;
  if (verified) {
    const lunaAllowed = evidence.attempts.some(attempt => attempt.action === 'allow'
      && attempt.assetName === 'ai-cost-economy-current' && attempt.status >= 200 && attempt.status < 300 && attempt.modelResponse);
    return `${verified} model route${verified === 1 ? '' : 's'}: marker rejected HTTP ${evidence.proof.rejectionSignature.status}; clean ${lunaAllowed ? 'Luna ' : ''}response verified.${saved}`;
  }
  const blocker = /MethodNotAllowedInPricingTier/.test(evidence.integrationBlocker || '')
    ? '/MethodNotAllowedInPricingTier' : '';
  return `${configured} ${categoryOnly ? 'category-config assets' : 'configured assets'}; 0 verified blocklist rejections. Backend integration unverified${blocker}.${saved}`;
}
export function parsePublicContentSafety(value: unknown, gatewayId: GatewayId): PublicContentSafetyEvidence {
  const evidence = value as PublicContentSafetyEvidence;
  if (!evidence || evidence.gatewayId !== gatewayId || evidence.schemaVersion !== 1
    || evidence.marker !== 'POC_CONTENT_SAFETY_BLOCK' || !Number.isFinite(Date.parse(evidence.capturedAt))
    || !Array.isArray(evidence.coverage) || !Array.isArray(evidence.policies) || !Array.isArray(evidence.attempts)
    || !evidence.proof || typeof evidence.proof.attributable !== 'boolean' || typeof evidence.proof.allowedVerified !== 'boolean'
    || !evidence.backend || (evidence.backend.connected !== undefined && typeof evidence.backend.connected !== 'boolean')
    || (evidence.integrationBlocker !== undefined && typeof evidence.integrationBlocker !== 'string')
    || !evidence.proof.rejectionSignature || 'gatewayOrigin' in evidence
    || evidence.coverage.some(asset => !asset || typeof asset.assetName !== 'string'
      || typeof asset.policyConfigured !== 'boolean' || typeof asset.rejectionVerified !== 'boolean')) {
    throw new Error('Native Content Safety response missing or bound to another profile.');
  }
  return evidence;
}
const safetyCategories = [
  ['Hate', 'hateSeverity'], ['Violence', 'violenceSeverity'],
  ['Sexual', 'sexualSeverity'], ['Self-harm', 'selfHarmSeverity']
] as const;
function categoryCard(configuration: unknown): Record<string, unknown> | undefined {
  const cards = (Array.isArray(configuration) ? configuration : [configuration]).filter(
    (value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'
      && !Array.isArray(value) && 'type' in value && value.type === 'contentSafety'));
  return cards.length === 1 ? cards[0] : undefined;
}
export function standaloneSafetySettings(evidence: PublicContentSafetyEvidence | undefined, assetName: string) {
  if (evidence?.gatewayId !== 'ai-gateway') return undefined;
  const configured = evidence.coverage.filter(asset => asset.policyConfigured && evidence.policies.some(policy =>
    policy.resourceId === asset.resourceId && policy.assetName === asset.assetName && policy.assetType === asset.assetType
    && categoryCard(policy.configuration)));
  const asset = evidence.coverage.find(asset => asset.assetName === assetName && asset.assetType === 'alias')
    || evidence.coverage.find(asset => asset.assetName === assetName && asset.assetType === 'model');
  const policy = asset?.policyConfigured ? evidence.policies.find(policy =>
    policy.resourceId === asset.resourceId && policy.assetName === asset.assetName && policy.assetType === asset.assetType) : undefined;
  const card = categoryCard(policy?.configuration);
  return {
    asset, capturedAt: policy?.capturedAt, configured: Boolean(card),
    modelCount: configured.filter(asset => asset.assetType === 'model').length,
    aliasCount: configured.filter(asset => asset.assetType === 'alias').length,
    categories: safetyCategories.map(([label, key]) => {
      const value = card?.[key];
      return { label, key, threshold: typeof value === 'string' && value.trim() ? value
        : typeof value === 'number' && Number.isFinite(value) ? String(value) : 'Not reported' };
    })
  };
}
function renderStandaloneSettings(target: HTMLElement, evidence: PublicContentSafetyEvidence | undefined, assetName: string) {
  target.replaceChildren();
  const settings = standaloneSafetySettings(evidence, assetName);
  if (!settings) return;
  const heading = document.createElement('h4'); heading.textContent = 'Standalone category policy';
  const scope = document.createElement('p');
  scope.textContent = settings.asset
    ? `Selected ${settings.asset.assetType}: ${settings.asset.assetName}`
    : 'No saved category-policy asset matches this model.';
  const categories = document.createElement('dl');
  for (const category of settings.categories) {
    const item = document.createElement('div');
    const label = document.createElement('dt'); label.textContent = category.label;
    const threshold = document.createElement('dd'); threshold.textContent = category.threshold;
    threshold.id = `safety-threshold-${category.key}`;
    item.append(label, threshold); categories.append(item);
  }
  const coverage = document.createElement('p'); coverage.id = 'content-safety-category-coverage';
  coverage.textContent = `${settings.modelCount + settings.aliasCount} assets with saved category cards: ${settings.modelCount} model entries + ${settings.aliasCount} aliases. New assets are not automatically covered.`;
  const note = document.createElement('p');
  note.textContent = settings.configured
    ? 'Values are the configured severity thresholds, not a verified runtime rejection. Prompt Shields and output filtering are not established by this evidence.'
    : 'No single native contentSafety card is recorded for this asset. No category enforcement is claimed.';
  target.append(heading, scope, categories, coverage, note);
  if (settings.capturedAt) {
    const timestamp = document.createElement('small');
    timestamp.textContent = `Read back ${new Date(settings.capturedAt).toLocaleString()} · saved configuration, not a live check`;
    target.append(timestamp);
  }
}
export function renderContentSafety(target: HTMLElement, state: {
  gatewayId: GatewayId; evidence?: PublicContentSafetyEvidence; error?: string; loading: boolean; busy: boolean;
  models: readonly Model[]; applications: readonly { id: 'A' | 'B'; ready: boolean }[];
  app: 'A' | 'B'; modelId: string;
}, send: (app: 'A' | 'B', modelId: string, action: 'reject' | 'allow') => void, reload: () => void) {
  const expanded = target.querySelector<HTMLDetailsElement>('.safety-details')?.open || false;
  target.replaceChildren();
  const title = document.createElement('h3'); title.textContent = 'Native Content Safety';
  const status = document.createElement('p');
  status.id = 'content-safety-status'; status.setAttribute('role', state.error ? 'alert' : 'status');
  status.textContent = state.loading ? 'Loading native safety evidence…' : state.error || safetySummary(state.evidence, state.gatewayId);
  const boundary = document.createElement('p');
  boundary.id = 'content-safety-boundary';
  const verified = state.evidence?.gatewayId === state.gatewayId && state.evidence.coverage.some(asset =>
    safetyAssetVerified(state.evidence!, asset.assetName, asset.assetType, asset.resourceId));
  boundary.textContent = verified ? 'Input/blocklist proof only; no output or classifier-accuracy claim.'
    : state.gatewayId === 'ai-gateway'
      ? 'Supported standalone-tier capability; this demo’s backend/blocklist binding remains unverified.'
      : 'No verified native safety proof loaded for this profile.';
  const controls = document.createElement('div'); controls.className = 'native-proof-actions';
  const app = document.createElement('select'); app.id = 'safety-app'; app.setAttribute('aria-label', 'Safety caller');
  for (const application of state.applications) {
    const option = document.createElement('option'); option.value = application.id;
    option.textContent = `Caller ${application.id}${application.ready ? '' : ' · unavailable'}`;
    app.append(option);
  }
  app.value = state.app;
  const model = document.createElement('select'); model.id = 'safety-model'; model.setAttribute('aria-label', 'Safety model asset');
  for (const asset of state.models) {
    const option = document.createElement('option'); option.value = asset.id;
    option.textContent = `${asset.name}${state.evidence && safetyAssetVerified(state.evidence, asset.name) ? ' · verified' : ' · unverified'}`;
    model.append(option);
  }
  model.value = state.modelId || state.models[0]?.id || '';
  app.disabled = model.disabled = state.busy || state.loading;
  const settings = document.createElement('div');
  settings.id = 'content-safety-category-settings'; settings.className = 'safety-category-settings';
  const buttons: HTMLButtonElement[] = [];
  const update = () => {
    const selected = state.models.find(asset => asset.id === model.value);
    renderStandaloneSettings(settings, state.gatewayId === 'ai-gateway' ? state.evidence : undefined, selected?.name || '');
    const ready = state.applications.some(application => application.id === app.value && application.ready);
    for (const button of buttons) button.disabled = state.evidence?.gatewayId !== state.gatewayId || state.busy || state.loading || !ready || !selected
      || !state.evidence || !safetyAssetVerified(state.evidence, selected.name);
  };
  for (const action of ['reject', 'allow'] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.id = `safety-${action}`;
    button.textContent = action === 'reject' ? `Test fixed block · expected HTTP ${state.gatewayId === 'apim-v2' ? 403 : 400}` : 'Test fixed allow';
    button.addEventListener('click', () => { if (!button.disabled) send(app.value as 'A' | 'B', model.value, action); });
    buttons.push(button); controls.append(button);
  }
  app.addEventListener('change', update); model.addEventListener('change', update); update();
  const refresh = document.createElement('button'); refresh.id = 'safety-refresh'; refresh.type = 'button'; refresh.textContent = 'Refresh safety evidence';
  refresh.disabled = state.busy || state.loading; refresh.addEventListener('click', reload);
  const coverage = document.createElement('p');
  coverage.id = 'content-safety-coverage';
  coverage.textContent = state.evidence ? state.evidence.coverage.map(asset =>
    `${asset.assetName} (${asset.assetType}): ${asset.policyConfigured ? 'configured' : 'not configured'} / ${safetyAssetVerified(state.evidence!, asset.assetName, asset.assetType, asset.resourceId) ? 'blocked + allowed-scope verified' : 'runtime proof unverified'}`).join(' · ') : 'No profile-specific safety coverage loaded.';
  const limitation = document.createElement('p');
  limitation.id = 'content-safety-limitations';
  limitation.textContent = 'Scope: harmless prompt/blocklist rejection only—not classifier accuracy, output filtering, Prompt Shields or caller isolation. Each rejected alias needs its own observation; APIM aliases sharing the exact API policy may share its genuine clean allow baseline.';
  const provenance = document.createElement('p');
  provenance.id = 'content-safety-provenance';
  provenance.textContent = `${state.gatewayId === 'apim-v2' ? 'Independent APIM native policy, not standalone proof' : 'Standalone category configuration does not prove external Content Safety/blocklist integration'}. Separate from custom routing. One fixed harmless real request per click; no local filter, retry or quality gate. ${state.evidence
    ? `${new Set(state.evidence.policies.map(policy => policy.resourceId.toLowerCase())).size} policy scope(s); coverage rows count assets, not physical policies. Backend resource presence is not gateway integration; connected: ${state.evidence.backend.connected === undefined ? 'unverified' : state.evidence.backend.connected}. ${state.evidence.integrationBlocker || ''} ${state.evidence.proof.explanation}`
    : 'No profile-specific integration or runtime proof loaded.'}`;
  const raw = document.createElement('details'); raw.className = 'safety-details'; raw.open = expanded;
  const summary = document.createElement('summary'); summary.textContent = 'Saved native safety configuration & attempts';
  const pre = document.createElement('pre'); pre.textContent = state.evidence ? JSON.stringify(state.evidence, null, 2) : 'No saved native safety evidence.';
  raw.append(summary, coverage, provenance, limitation, pre);
  target.append(title, status, boundary, app, model, settings, controls, refresh, raw);
}
