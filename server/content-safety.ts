import { readFileSync, statSync } from 'node:fs';
import type { CallInput, CallResult, Config, GatewayId } from './gateway.ts';

export const SAFETY_MARKER = 'POC_CONTENT_SAFETY_BLOCK';
export interface SafetySignature { status: number; code?: string; message?: string }
export interface ContentSafetyEvidence {
  schemaVersion: 1;
  gatewayId: GatewayId;
  gatewayOrigin: string;
  capturedAt: string;
  backend: { resourceId: string; endpoint: string; sku: 'F0'; blocklistName: 'poc-demo-blocklist'; connected?: boolean };
  integrationBlocker?: string;
  marker: typeof SAFETY_MARKER;
  policies: { resourceId: string; assetName: string; assetType: 'model' | 'alias'; configuration: unknown; capturedAt: string }[];
  coverage: { resourceId: string; assetName: string; assetType: 'model' | 'alias'; policyConfigured: boolean; rejectionVerified: boolean }[];
  attempts: { app: 'A' | 'B'; assetName: string; action: 'reject' | 'allow'; status: number;
    headers: Record<string, string>; modelResponse: boolean; returnedModel?: string; tokens: CallResult['tokens'];
    latencyMs: number; correlationId: string; at: string; rejectionSignature?: SafetySignature }[];
  proof: { attributable: boolean; allowedVerified: boolean; explanation: string; rejectionSignature: SafetySignature };
}
export type PublicContentSafetyEvidence = Omit<ContentSafetyEvidence, 'gatewayOrigin'>;
const fail = (): never => { throw new Error('Native Content Safety evidence invalid: inspect profile, asset binding and genuine observations.'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) return fail();
  return value;
}
function date(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) return fail();
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail();
  return value;
}
function signature(value: unknown, expectedStatus: 400 | 403): SafetySignature {
  const item = object(value);
  if (item.status !== expectedStatus) return fail();
  const code = item.code === undefined ? undefined : text(item.code);
  const message = item.message === undefined ? undefined : text(item.message);
  return { status: expectedStatus, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}
export function nativeSafetySignature(signature: SafetySignature): boolean {
  // Generic provider content_filter and a bare 400 do not establish native attribution.
  return (signature.status === 400 || signature.status === 403) && /content[\s_-]*safety|block[\s_-]*list|POC_CONTENT_SAFETY_BLOCK|prompt[\s_-]*shield/i
    .test(`${signature.code || ''} ${signature.message || ''}`);
}
function sameSignature(actual: SafetySignature, expected: SafetySignature): boolean {
  return actual.status === expected.status
    && (!expected.code || actual.code === expected.code)
    && (!expected.message || actual.message === expected.message);
}
function safeConfiguration(value: unknown, depth = 0): unknown {
  if (depth > 30) return fail();
  if (typeof value === 'string' && value.trim().startsWith('<')) {
    return value
      .replace(/<(set-header|set-query-parameter|set-variable|set-body|authentication-basic|authentication-certificate|credential|credentials|password|secret|api-key)\b[^>]*(?:\/>|>[\s\S]*?<\/\1\s*>)/gi,
        '<redacted-sensitive-configuration />')
      .replace(/\b(api-key|key|password|secret|token|authorization|credential)\s*=\s*(["'])[\s\S]*?\2/gi, '$1="[redacted]"');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(item => safeConfiguration(item, depth + 1));
  const item = object(value);
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key,
    /(?:key|secret|password|token|authorization|credential|gatewayorigin)/i.test(key) ? '[redacted]' : safeConfiguration(value, depth + 1)]));
}
export function parseContentSafetyEvidence(value: unknown, config: Config): ContentSafetyEvidence | undefined {
  const item = object(value);
  const gatewayId = config.gatewayId;
  if (!gatewayId || !config.origin || item.gatewayId !== gatewayId || item.gatewayOrigin !== config.origin
    || (gatewayId === 'ai-gateway' ? config.gatewayType !== 'standalone-ai-gateway' : config.gatewayType !== 'apim-premium-v2')) return undefined;
  if (item.schemaVersion !== 1 || item.marker !== SAFETY_MARKER) return fail();
  const serialized = JSON.stringify(value);
  if (Object.values(config.keys).some(key => key && serialized.includes(key))) return fail();
  const host = new URL(config.origin).hostname.split('.')[0];
  const arm = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/aiGateways\/([^/]+)\/workspaces\/default\/(?:modelProviders\/[a-zA-Z0-9_-]+\/)?(models|aliases)\/([^/]+)$/i;
  const apimArm = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)\/apis\/[a-zA-Z0-9_-]+(?:\/operations\/[a-zA-Z0-9_-]+)?(?:\/policies\/policy)?$/i;
  const asset = (value: unknown): { resourceId: string; assetName: string; assetType: 'model' | 'alias' } => {
    const entry = object(value);
    const resourceId = text(entry.resourceId);
    const match = (gatewayId === 'ai-gateway' ? arm : apimArm).exec(resourceId);
    const assetName = text(entry.assetName);
    const assetType = entry.assetType;
    if (!match || match[1].toLowerCase() !== host.toLowerCase()
      || (assetType !== 'model' && assetType !== 'alias')
      || (gatewayId === 'ai-gateway' && (match[3] !== assetName || match[2].toLowerCase() !== (assetType === 'model' ? 'models' : 'aliases')))
      || (gatewayId === 'ai-gateway' && assetType === 'alias' && /\/modelProviders\//i.test(resourceId))
      || (gatewayId === 'ai-gateway' && assetType === 'model' && !/\/modelProviders\//i.test(resourceId))
      || (gatewayId === 'apim-v2' && !config.models.some(model => model.name === assetName))
      || !/^[a-zA-Z0-9_-]+$/.test(assetName)) return fail();
    return { resourceId, assetName, assetType };
  };
  const backend = object(item.backend);
  const endpoint = new URL(text(backend.endpoint));
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i.test(text(backend.resourceId))
    || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash
    || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(endpoint.hostname) || endpoint.pathname !== '/'
    || backend.sku !== 'F0' || backend.blocklistName !== 'poc-demo-blocklist') return fail();
  if (!Array.isArray(item.policies) || !Array.isArray(item.coverage) || !Array.isArray(item.attempts)
    || item.policies.length > 100 || item.coverage.length > 100 || item.attempts.length > 400) return fail();
  const policies = item.policies.map(value => {
    const entry = object(value);
    if (entry.configuration === undefined || entry.configuration === null) return fail();
    if (gatewayId === 'apim-v2' && (typeof entry.configuration !== 'string'
      || !entry.configuration.trim().startsWith('<policies') || !entry.configuration.trim().endsWith('</policies>'))) return fail();
    return { ...asset(value), configuration: safeConfiguration(entry.configuration), capturedAt: date(entry.capturedAt) };
  });
  const coverage = item.coverage.map(value => {
    const entry = object(value);
    return { ...asset(value), policyConfigured: boolean(entry.policyConfigured), rejectionVerified: boolean(entry.rejectionVerified) };
  });
  const assetKey = (entry: { assetName: string; resourceId: string }) => `${entry.assetName}\0${entry.resourceId.toLowerCase()}`;
  if (new Set(coverage.map(assetKey)).size !== coverage.length
    || new Set(policies.map(assetKey)).size !== policies.length) return fail();
  for (const entry of coverage) {
    const policy = policies.find(policy => assetKey(policy) === assetKey(entry));
    if (entry.policyConfigured !== Boolean(policy) || (policy && (policy.resourceId !== entry.resourceId || policy.assetType !== entry.assetType))
      || (entry.rejectionVerified && !entry.policyConfigured)) return fail();
  }
  if (policies.some(policy => !coverage.some(entry => assetKey(entry) === assetKey(policy)))) return fail();
  if (gatewayId === 'apim-v2' && policies.some(policy => policies.some(other =>
    other.resourceId === policy.resourceId && other.configuration !== policy.configuration))) return fail();
  const proof = object(item.proof);
  const expectedStatus = gatewayId === 'apim-v2' ? 403 : 400;
  const rejectionSignature = signature(proof.rejectionSignature, expectedStatus);
  if (proof.attributable === true && !rejectionSignature.code && !rejectionSignature.message) return fail();
  if (backend.connected !== undefined && typeof backend.connected !== 'boolean') return fail();
  const attempts: ContentSafetyEvidence['attempts'] = item.attempts.map(value => {
    const entry = object(value);
    const assetName = text(entry.assetName);
    if (!coverage.some(asset => asset.assetName === assetName) || (entry.app !== 'A' && entry.app !== 'B')
      || (entry.action !== 'reject' && entry.action !== 'allow') || typeof entry.status !== 'number'
      || !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599
      || typeof entry.latencyMs !== 'number' || !Number.isFinite(entry.latencyMs) || entry.latencyMs < 0
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(text(entry.correlationId))) return fail();
    if (entry.modelResponse === true && (entry.status < 200 || entry.status >= 300)) return fail();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(object(entry.headers))) {
      if (typeof value !== 'string') return fail();
      if (['x-correlation-id', 'x-request-id', 'apim-request-id', 'x-ms-request-id', 'traceparent', 'retry-after'].includes(key)
        && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)) headers[key] = value;
    }
    let tokens: CallResult['tokens'] = null;
    if (entry.tokens !== null) {
      const counts = object(entry.tokens);
      tokens = {};
      for (const key of ['input', 'output', 'total'] as const) {
        const count = counts[key];
        if (count !== undefined) {
          if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return fail();
          tokens[key] = count;
        }
      }
    }
    return { app: entry.app, assetName, action: entry.action, status: entry.status, headers,
      modelResponse: boolean(entry.modelResponse), tokens, latencyMs: entry.latencyMs,
      correlationId: text(entry.correlationId), at: date(entry.at),
      ...(entry.returnedModel === undefined ? {} : { returnedModel: text(entry.returnedModel) }),
      ...(entry.rejectionSignature === undefined ? {} : { rejectionSignature: signature(entry.rejectionSignature, expectedStatus) }) };
  });
  if (new Set(attempts.map(entry => entry.correlationId)).size !== attempts.length) return fail();
  const result: ContentSafetyEvidence = {
    schemaVersion: 1, gatewayId, gatewayOrigin: config.origin, capturedAt: date(item.capturedAt),
    backend: { resourceId: text(backend.resourceId), endpoint: endpoint.href, sku: 'F0', blocklistName: 'poc-demo-blocklist',
      ...(backend.connected === undefined ? {} : { connected: boolean(backend.connected) }) },
    ...(item.integrationBlocker === undefined ? {} : { integrationBlocker: text(item.integrationBlocker) }),
    marker: SAFETY_MARKER, policies, coverage, attempts,
    proof: { attributable: boolean(proof.attributable), allowedVerified: boolean(proof.allowedVerified),
      explanation: text(proof.explanation), rejectionSignature }
  };
  for (const entry of coverage) {
    if (entry.rejectionVerified && (result.backend.connected === false || !verifiedSafetyAsset(result, entry.assetName, entry.assetType, entry.resourceId))) return fail();
  }
  if (result.proof.allowedVerified && !attempts.some(entry => entry.action === 'allow' && entry.status >= 200 && entry.status < 300 && entry.modelResponse)) return fail();
  return result;
}
export function verifiedSafetyAsset(evidence: PublicContentSafetyEvidence, assetName: string, assetType?: 'model' | 'alias', resourceId?: string): boolean {
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
    && nativeSafetySignature(signature)
    && evidence.attempts.some(entry => entry.assetName === assetName && entry.action === 'reject'
      && !entry.modelResponse && entry.status === signature.status && entry.rejectionSignature
      && sameSignature(entry.rejectionSignature, signature))
    && allowed);
}
export function readContentSafetyEvidence(config: Config, file = config.gatewayId === 'apim-v2'
  ? '.local/apim-v2-content-safety.json' : '.local/gateway-content-safety.json'): ContentSafetyEvidence | undefined {
  if (!config.gatewayId || (config.gatewayId === 'ai-gateway'
    ? config.gatewayType !== 'standalone-ai-gateway' : config.gatewayType !== 'apim-premium-v2')) return undefined;
  try {
    if (statSync(file).size > 512 * 1024) throw new Error('Native Content Safety evidence exceeds 512 KiB.');
    return parseContentSafetyEvidence(JSON.parse(readFileSync(file, 'utf8')), config);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function publicContentSafetyEvidence(evidence: ContentSafetyEvidence): PublicContentSafetyEvidence {
  const { gatewayOrigin: _origin, ...safe } = evidence;
  return safe;
}
export function contentSafetyInput(value: unknown, config: Config, evidence: ContentSafetyEvidence): CallInput {
  const body = object(value);
  if (Object.keys(body).some(key => !['gatewayId', 'app', 'modelId', 'action'].includes(key))
    || body.gatewayId !== config.gatewayId || body.gatewayId !== evidence.gatewayId
    || config.origin !== evidence.gatewayOrigin || (body.app !== 'A' && body.app !== 'B')
    || (body.action !== 'reject' && body.action !== 'allow')) throw new Error('Select this profile, caller and a fixed block/allow safety test.');
  const model = config.models.find(model => model.id === body.modelId);
  if (!model || !verifiedSafetyAsset(evidence, model.name)) throw new Error('This configured asset has no attributable native safety rejection and allowed proof.');
  return { app: body.app, modelId: model.id,
    prompt: body.action === 'reject' ? `${SAFETY_MARKER}. Reply exactly SAFETY_OK.` : 'Reply exactly SAFETY_OK.' };
}
export function nativeSafetyMatched(result: CallResult, config: Config, evidence: ContentSafetyEvidence): boolean {
  if (config.gatewayId !== evidence.gatewayId || config.origin !== evidence.gatewayOrigin
    || result.gatewayId !== evidence.gatewayId || result.source !== 'gateway-response' || result.modelResponse
    || !config.models.some(model => model.name === result.model) || !verifiedSafetyAsset(evidence, result.model)) return false;
  const body = result.raw && typeof result.raw === 'object' && !Array.isArray(result.raw) ? result.raw as Record<string, unknown> : {};
  const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error as Record<string, unknown> : body;
  return sameSignature({ status: result.status,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}) }, evidence.proof.rejectionSignature);
}
