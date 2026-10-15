import { readFileSync, statSync } from 'node:fs';
import type { AppId, CallInput, CallResult, Config } from './gateway.ts';

export interface GovernanceProof {
  schemaVersion: 1;
  gatewayId: 'ai-gateway' | 'apim-v2';
  gatewayOrigin: string;
  capturedAt: string;
  kind: 'caller-request-limit' | 'model-allowlist';
  alias: 'demo-governance-proof' | 'demo-policy-refusal';
  allowedAlias: 'ai-cost-economy-current';
  policy: { source: 'azure-control-plane'; resourceId: string; configuration: unknown; capturedAt: string };
  proof: { attributable: boolean; aRejected: boolean; bAllowed: boolean; explanation: string;
    rejectionSignature: { status: number; code?: string; message?: string } };
  attempts: { app: AppId; gatewayId?: 'ai-gateway' | 'apim-v2'; status: number; headers: Record<string, string>; modelResponse: boolean; returnedModel?: string;
    tokens: CallResult['tokens']; latencyMs: number; correlationId: string; at: string }[];
  standaloneBlocker?: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native governance proof object.');
  return value as Record<string, unknown>;
}
export function parseGovernanceProof(value: unknown, config: Config): GovernanceProof | undefined {
  const evidence = record(value);
  if (!config.origin || evidence.gatewayId !== config.gatewayId || evidence.gatewayOrigin !== config.origin) return undefined;
  const expectedKind = config.gatewayId === 'ai-gateway' ? 'caller-request-limit' : 'model-allowlist';
  const expectedAlias = config.gatewayId === 'ai-gateway' ? 'demo-governance-proof' : 'demo-policy-refusal';
  const policy = record(evidence.policy);
  const proof = record(evidence.proof);
  const signature = record(proof.rejectionSignature);
  const runtimeName = new URL(config.origin).hostname.split('.')[0].toLowerCase();
  const armType = config.gatewayId === 'ai-gateway' ? 'aigateways' : 'service';
  if (evidence.schemaVersion !== 1 || evidence.kind !== expectedKind || evidence.alias !== expectedAlias
    || evidence.allowedAlias !== 'ai-cost-economy-current' || typeof evidence.capturedAt !== 'string' || !Number.isFinite(Date.parse(evidence.capturedAt))
    || policy.source !== 'azure-control-plane' || typeof policy.resourceId !== 'string'
    || !policy.resourceId.startsWith('/subscriptions/') || typeof policy.capturedAt !== 'string' || !Number.isFinite(Date.parse(policy.capturedAt))
    || !policy.resourceId.toLowerCase().includes(`/providers/microsoft.apimanagement/${armType}/${runtimeName}/`)
    || !policy.configuration || typeof proof.explanation !== 'string' || !Array.isArray(evidence.attempts)
    || signature.status !== (expectedKind === 'caller-request-limit' ? 429 : 400)
    || (signature.code !== undefined && typeof signature.code !== 'string')
    || (signature.message !== undefined && typeof signature.message !== 'string')
    || (!signature.code && !signature.message)) throw new Error('Invalid native governance proof provenance or policy signature.');
  if (proof.attributable !== true || proof.aRejected !== true || typeof proof.bAllowed !== 'boolean'
    || (expectedKind === 'caller-request-limit' && proof.bAllowed !== true)) return undefined;
  const attempts: GovernanceProof['attempts'] = evidence.attempts.map((attempt): GovernanceProof['attempts'][number] => {
    const item = record(attempt);
    if ((item.app !== 'A' && item.app !== 'B') || typeof item.status !== 'number' || !Number.isInteger(item.status) || typeof item.modelResponse !== 'boolean'
      || typeof item.correlationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.correlationId)
      || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))
      || typeof item.latencyMs !== 'number' || !Number.isFinite(item.latencyMs) || item.latencyMs < 0) throw new Error('Invalid native governance observation.');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(record(item.headers))) {
      if (['retry-after', 'x-request-id', 'apim-request-id', 'x-ms-request-id', 'remaining-tokens', 'consumed-tokens', 'traceparent'].includes(name)
        && typeof value === 'string') headers[name] = value;
    }
    let tokens: CallResult['tokens'] = null;
    if (item.tokens !== null && item.tokens !== undefined) {
      const counts = record(item.tokens);
      tokens = {};
      for (const name of ['input', 'output', 'total'] as const) {
        if (counts[name] !== undefined) {
          if (typeof counts[name] !== 'number' || !Number.isInteger(counts[name]) || counts[name] < 0) throw new Error('Invalid governance token count.');
          tokens[name] = counts[name];
        }
      }
    }
    if (item.gatewayId !== undefined && item.gatewayId !== 'ai-gateway' && item.gatewayId !== 'apim-v2') throw new Error('Invalid native governance observation profile.');
    return { app: item.app, status: item.status, modelResponse: item.modelResponse, correlationId: item.correlationId,
      ...(item.gatewayId === 'ai-gateway' || item.gatewayId === 'apim-v2' ? { gatewayId: item.gatewayId } : {}),
      at: item.at, latencyMs: item.latencyMs, headers, tokens,
      ...(typeof item.returnedModel === 'string' ? { returnedModel: item.returnedModel } : {}) };
  }).filter(attempt => !attempt.gatewayId || attempt.gatewayId === config.gatewayId);
  if (!attempts.some(item => item.app === 'A' && item.status === signature.status && item.modelResponse === false)
    || !attempts.some(item => (expectedKind === 'model-allowlist' || item.app === 'B') && item.status === 200 && item.modelResponse === true)) {
    throw new Error('Native governance proof lacks rejection or allowed observations.');
  }
  return { schemaVersion: 1, gatewayId: config.gatewayId === 'ai-gateway' ? 'ai-gateway' : 'apim-v2',
    gatewayOrigin: config.origin, capturedAt: evidence.capturedAt, kind: expectedKind, alias: expectedAlias, allowedAlias: 'ai-cost-economy-current',
    policy: { source: 'azure-control-plane', resourceId: policy.resourceId, configuration: policy.configuration, capturedAt: policy.capturedAt },
    proof: { attributable: true, aRejected: true, bAllowed: proof.bAllowed, explanation: proof.explanation, rejectionSignature: {
      status: expectedKind === 'caller-request-limit' ? 429 : 400,
      ...(typeof signature.code === 'string' ? { code: signature.code } : {}),
      ...(typeof signature.message === 'string' ? { message: signature.message } : {}) } },
    attempts, ...(typeof evidence.standaloneBlocker === 'string' ? { standaloneBlocker: evidence.standaloneBlocker } : {}) };
}
export function readGovernanceProof(config: Config, file = '.local/gateway-governance-proof.json'): GovernanceProof | undefined {
  try {
    if (statSync(file).size > 512 * 1024) throw new Error('Native governance proof exceeds 512 KiB.');
    return parseGovernanceProof(JSON.parse(readFileSync(file, 'utf8')), config);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function publicGovernanceProof(proof: GovernanceProof) {
  const { gatewayOrigin: _origin, ...safe } = proof;
  return safe;
}
export function governanceInput(value: unknown, config: Config, proof: GovernanceProof): { config: Config; input: CallInput } {
  const body = record(value);
  if ((body.app !== 'A' && body.app !== 'B') || (body.action !== 'reject' && body.action !== 'allow')
    || Object.keys(body).some(key => !['gatewayId', 'app', 'action'].includes(key))) {
    throw new Error('Select caller A or B and a fixed reject/allow governance test.');
  }
  const base = config.models.find(model => model.name === proof.allowedAlias && model.cloud === 'azure'
    && model.provider === 'foundry' && model.format === 'openai-chat' && model.reasoningEffort === 'none');
  if (!base) throw new Error('The verified governance proof has no configured economy backend.');
  const name = proof.kind === 'caller-request-limit' || body.action === 'reject' ? proof.alias : base.name;
  const model = { ...base, id: 'governance-proof', name, path: '/default/models/openai/v1/chat/completions' };
  return { config: { ...config, models: [model] }, input: {
    app: body.app, modelId: model.id, prompt: 'Return only READY. Synthetic gateway governance test.'
  } };
}
export function nativePolicyMatched(result: CallResult, proof: GovernanceProof): boolean {
  const signature = proof.proof.rejectionSignature;
  if (result.source !== 'gateway-response' || result.status !== signature.status || result.modelResponse || result.model !== proof.alias) return false;
  if (proof.kind === 'caller-request-limit' && !result.headers['retry-after']) return false;
  const raw = result.raw && typeof result.raw === 'object' && !Array.isArray(result.raw) ? result.raw as Record<string, unknown> : {};
  const nested = raw.error && typeof raw.error === 'object' && !Array.isArray(raw.error) ? raw.error as Record<string, unknown> : {};
  const code = nested.code ?? raw.code;
  const message = nested.message ?? raw.message;
  return Boolean((signature.code || signature.message)
    && (!signature.code || signature.code === code) && (!signature.message || signature.message === message));
}
