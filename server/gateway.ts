import { databricksText } from './databricks-response.ts';

export type Cloud = 'azure' | 'aws' | 'gcp';
export type Format = 'openai-chat' | 'anthropic-messages';
export type Provider = 'foundry' | 'databricks' | 'bedrock' | 'vertex';
export type AppId = 'A' | 'B';
export type GatewayId = 'ai-gateway' | 'apim-v2';
export type GatewayType = 'standalone-ai-gateway' | 'apim-premium-v2';
export interface Model { id: string; name: string; cloud: Cloud; provider?: Provider; format: Format; reasoningEffort?: 'none' | 'low'; path?: string }
export function modelProvider(model: Model): Provider {
  return model.provider || ({ azure: 'foundry', aws: 'bedrock', gcp: 'vertex' } as const)[model.cloud];
}
export interface Config {
  gatewayId?: GatewayId;
  gatewayType?: GatewayType;
  authHeader?: 'api-key' | 'Ocp-Apim-Subscription-Key';
  foundryAssociated?: boolean;
  origin?: string;
  keys: Partial<Record<AppId, string>>;
  models: Model[];
}
export interface CallInput { app: AppId; modelId: string; prompt: string }
export interface CallResult {
  correlationId?: string;
  decisionId?: string;
  outcome?: RequestOutcome;
  evidence?: RequestEvent;
  estimatedTokenCostUsd?: number | null;
  transportFailure?: 'timeout' | 'cancelled' | 'network-or-response';
  gatewayId?: GatewayId;
  gatewayType?: GatewayType;
  source: 'gateway-response' | 'local-error';
  status: number;
  model: string;
  returnedModel?: string;
  cloud: Cloud;
  provider?: Provider;
  latencyMs: number;
  response: string;
  modelResponse: boolean;
  tokens: { input?: number; output?: number; total?: number; reasoning?: number; cachedInput?: number } | null;
  headers: Record<string, string>;
  raw: unknown;
  request: { model: string; messages: { role: string; content: string }[]; max_completion_tokens?: number; max_tokens?: number; reasoning_effort?: 'none' | 'low' };
  routing?: RoutingDecision;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const origin = env.GATEWAY_ORIGIN?.trim();
  if (origin) {
    const url = new URL(origin);
    const approvedHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+\.aigateway)?\.azure-api\.net$/i.test(url.hostname)
      || /^[a-z0-9-]+\.[a-z0-9-]+\.ai\.gateway\.azure\.com$/i.test(url.hostname);
    if (url.protocol !== 'https:' || !approvedHost
      || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('GATEWAY_ORIGIN must be an approved Azure AI Gateway HTTPS origin, with no path, port or credentials.');
    }
  }
  const models: Model[] = [];
  for (const i of [1, 2, 3, 4]) {
    const name = env[`MODEL_${i}_NAME`]?.trim();
    if (!name) continue;
    const cloud = env[`MODEL_${i}_CLOUD`] || 'azure';
    const format = env[`MODEL_${i}_FORMAT`] || 'openai-chat';
    const reasoningEffort = env[`MODEL_${i}_REASONING_EFFORT`];
    if (cloud !== 'azure' && cloud !== 'aws' && cloud !== 'gcp') throw new Error(`Invalid MODEL_${i}_CLOUD`);
    const provider = env[`MODEL_${i}_PROVIDER`]?.trim() || { azure: 'foundry', aws: 'bedrock', gcp: 'vertex' }[cloud];
    if (format !== 'openai-chat' && format !== 'anthropic-messages') throw new Error(`Invalid MODEL_${i}_FORMAT`);
    if (!['foundry', 'databricks', 'bedrock', 'vertex'].includes(provider || '')) throw new Error(`Invalid MODEL_${i}_PROVIDER`);
    if (provider === 'databricks' && (cloud !== 'azure' || format !== 'openai-chat')) throw new Error(`MODEL_${i}_PROVIDER=databricks requires Azure and OpenAI chat.`);
    if (models.some(model => model.name === name)) throw new Error('Published model names must be unique.');
    if (reasoningEffort && ((reasoningEffort !== 'none' && reasoningEffort !== 'low') || format !== 'openai-chat')) throw new Error(`Invalid MODEL_${i}_REASONING_EFFORT; only none/low on OpenAI chat are supported.`);
    models.push({ id: `model-${i}`, name, cloud, provider: provider as Provider, format,
      ...(reasoningEffort === 'none' || reasoningEffort === 'low' ? { reasoningEffort } : {}) });
  }
  return { origin, keys: { A: env.APP_A_KEY, B: env.APP_B_KEY }, models };
}

export function publicConfig(config: Config) {
  return {
    gatewayId: config.gatewayId || 'ai-gateway',
    gatewayType: config.gatewayType || 'standalone-ai-gateway',
    label: config.gatewayId === 'apim-v2' ? 'APIM Premium v2' : 'Standalone AI Gateway',
    lifecycle: config.gatewayId === 'apim-v2' ? 'Premium v2 infrastructure GA · Foundry integration preview' : 'Public preview · No SLA',
    foundryAssociated: config.foundryAssociated === true,
    authHeader: config.authHeader || 'api-key',
    gatewayConfigured: Boolean(config.origin),
    applications: (['A', 'B'] as const).map(id => ({ id, ready: Boolean(config.origin && config.keys[id]) })),
    models: config.models,
    sameKey: Boolean(config.keys.A && config.keys.A === config.keys.B)
  };
}

export function validateInput(value: unknown, config: Config): CallInput {
  if (!value || typeof value !== 'object') throw new Error('Expected a JSON request object.');
  const input = value as Record<string, unknown>;
  if (input.app !== 'A' && input.app !== 'B') throw new Error('Select application A or B.');
  if (typeof input.modelId !== 'string' || !config.models.some(model => model.id === input.modelId)) {
    throw new Error('Select a configured model.');
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) {
    throw new Error('Prompt must contain 1-8000 characters.');
  }
  return { app: input.app, modelId: input.modelId, prompt: input.prompt };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function modelText(raw: unknown, model: Model): string | undefined {
  const body = object(raw);
  if (Array.isArray(body.choices) && model.format === 'openai-chat') {
    const content = object(object(body.choices[0]).message).content;
    if (modelProvider(model) === 'databricks') return databricksText(content);
    if (typeof content === 'string' && content.trim()) return content;
  }
  if (Array.isArray(body.content) && model.format === 'anthropic-messages') {
    const text = body.content.map(part => object(part).text).filter(part => typeof part === 'string').join('\n');
    if (text) return text;
  }
  return undefined;
}

function extractResponse(raw: unknown, text?: string): string {
  if (text !== undefined) return text;
  const body = object(raw);
  const error = object(body.error);
  if (typeof error.message === 'string') return error.message;
  if (typeof body.message === 'string') return body.message;
  if (typeof raw === 'string') return raw;
  return 'No displayable text returned. Inspect the raw response.';
}

export async function callGateway(
  config: Config, input: CallInput, fetcher: typeof fetch = fetch,
  options: { maxCompletionTokens?: number; signal?: AbortSignal; correlationId?: string } = {}
): Promise<CallResult> {
  const correlationId = options.correlationId || crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlationId)) throw new Error('Invalid server correlation ID.');
  const model = config.models.find(item => item.id === input.modelId);
  if (!model) throw new Error('Model not configured.');
  const key = config.keys[input.app];
  if (!config.origin || !key) throw new Error(`Gateway origin and application ${input.app} runtime key are required.`);
  const anthropic = model.format === 'anthropic-messages';
  const provider = modelProvider(model);
  if (options.maxCompletionTokens !== undefined
    && (!Number.isInteger(options.maxCompletionTokens) || options.maxCompletionTokens < 1 || options.maxCompletionTokens > 2048 || anthropic)) {
    throw new Error('Explicit output limit must be 1-2048 tokens on OpenAI chat.');
  }
  const request = {
    model: model.name, messages: [{ role: 'user', content: input.prompt }],
    ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
    ...(provider === 'databricks' ? { max_tokens: options.maxCompletionTokens ?? 256 }
      : options.maxCompletionTokens !== undefined ? { max_completion_tokens: options.maxCompletionTokens } : {})
  };
  const path = model.path || (provider === 'databricks' ? '/default/models/databricks-gpt-oss-20b/invocations'
    : anthropic ? '/default/models/anthropic/v1/messages' : '/default/models/openai/v1/chat/completions');
  const started = performance.now();
  try {
    const response = await fetcher(new URL(path, config.origin), {
      method: 'POST',
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
      headers: {
        'Content-Type': 'application/json', [config.authHeader || 'api-key']: key, 'x-correlation-id': correlationId,
        ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {})
      },
      body: JSON.stringify(anthropic ? { ...request, max_tokens: 256 } : { ...request, stream: false })
    });
    // Bound upstream bodies without reading an arbitrarily large response into memory.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error('Gateway response exceeded the 1 MiB demo limit.');
        }
        chunks.push(value);
      }
    }
    let text = Buffer.concat(chunks).toString('utf8');
    // Never expose configured runtime keys, even if an upstream error echoes one.
    for (const secret of Object.values(config.keys)) {
      if (secret) text = text.replaceAll(secret, '[redacted]');
    }
    let raw: unknown = text;
    try { raw = JSON.parse(text); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Non-JSON gateway errors are retained as text rather than converted to success.
    }
    const usage = object(object(raw).usage);
    const returnedModel = object(raw).model;
    const inputTokens = count(anthropic ? usage.input_tokens : usage.prompt_tokens);
    const outputTokens = count(anthropic ? usage.output_tokens : usage.completion_tokens);
    const total = count(usage.total_tokens);
    const reasoning = anthropic ? undefined : count(object(usage.completion_tokens_details).reasoning_tokens);
    const cachedInput = anthropic ? undefined : count(object(usage.prompt_tokens_details).cached_tokens);
    const headers: Record<string, string> = {};
    for (const name of ['retry-after', 'retry-after-ms', 'remaining-tokens', 'consumed-tokens', 'remaining-quota-tokens',
      'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
      'x-request-id', 'apim-request-id', 'traceparent', 'x-ms-request-id']) {
      const value = response.headers.get(name);
      if (value !== null) {
        headers[name] = Object.values(config.keys).reduce((safe, secret) => secret ? safe.replaceAll(secret, '[redacted]') : safe, value);
      }
    }
    let extractedText: string | undefined;
    let extractionError: string | undefined;
    try { extractedText = modelText(raw, model); } catch (error) {
      extractionError = error instanceof Error ? error.message : 'Unsupported model response.';
    }
    return {
      gatewayId: config.gatewayId || 'ai-gateway', gatewayType: config.gatewayType || 'standalone-ai-gateway', correlationId,
      source: 'gateway-response', status: response.status, model: model.name, cloud: model.cloud, provider,
      ...(typeof returnedModel === 'string' && returnedModel.trim() ? { returnedModel } : {}),
      latencyMs: Math.round(performance.now() - started), response: extractionError || extractResponse(raw, extractedText),
      modelResponse: response.ok && extractedText !== undefined,
      tokens: [inputTokens, outputTokens, total, reasoning, cachedInput].every(value => value === undefined) ? null
        : { input: inputTokens, output: outputTokens, total: total ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
          ...(reasoning === undefined ? {} : { reasoning }), ...(cachedInput === undefined ? {} : { cachedInput }) },
      headers, raw, request
    };
  } catch (error) {
    const message = Object.values(config.keys).reduce((safe, secret) => secret ? safe.replaceAll(secret, '[redacted]') : safe,
      error instanceof Error ? error.message : 'Unknown gateway transport error');
    return {
      gatewayId: config.gatewayId || 'ai-gateway', gatewayType: config.gatewayType || 'standalone-ai-gateway', correlationId,
      transportFailure: options.signal?.aborted ? 'cancelled' : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network-or-response',
      source: 'local-error', status: 502, model: model.name, cloud: model.cloud, provider,
      latencyMs: Math.round(performance.now() - started),
      response: `Local proxy could not complete the gateway call: ${message}`,
      modelResponse: false,
      tokens: null, headers: {}, raw: null, request
    };
  }
}
import type { RoutingDecision } from './routing.ts';
import type { RequestEvent, RequestOutcome } from './request-evidence.ts';
