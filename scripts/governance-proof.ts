// Run with the approved CA bundle: node scripts/governance-proof.ts --configure --verify
// If attribution is blocked: node scripts/governance-proof.ts --verify --apim-allowlist
// Re-read matching Azure configuration without model calls: --readback
// Complete an existing allowlist proof with one parent-authorized B call: --verify-allowed-b
// This script never provisions a model, deployment, key, capacity, or APIM policy.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = `/subscriptions/${subscription}/resourceGroups/${config.resourceGroup}`;
const gateway = `${group}/providers/Microsoft.ApiManagement/aigateways/${config.gatewayName}`;
const workspace = `${gateway}/workspaces/default`;
const model = `${workspace}/modelProviders/azure-models/models/ai-cost-economy-current`;
const aliasName = 'demo-governance-proof';
const alias = `${workspace}/aliases/${aliasName}`;
const standaloneOrigin = config.gatewayOrigin;
const apimOrigin = config.comparisonGatewayOrigin;
const apim = `/subscriptions/${subscription}/resourceGroups/${config.comparisonResourceGroup}/providers/Microsoft.ApiManagement/service/${config.comparisonGatewayName}`;
const apimPolicy = `${apim}/apis/gateway-comparison/operations/openai-chat/policies/policy`;
const artifact = '.local/gateway-governance-proof.json';
const runtimePath = '/default/models/openai/v1/chat/completions';
const maxCalls = 12;
const maxConfigurations = 2;
const periodSeconds = 120;
const headerAllowlist = ['retry-after', 'retry-after-ms', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests', 'apim-request-id', 'x-request-id', 'request-id', 'x-ms-request-id', 'x-correlation-id'];
type Json = Record<string, unknown>;
type Attempt = {
  app: 'A' | 'B'; gatewayId: 'ai-gateway' | 'apim-v2'; alias: string; status: number;
  headers: Record<string, string>; modelResponse: boolean; returnedModel?: string;
  tokens?: { input: number; output: number }; latencyMs: number; correlationId: string; at: string;
  rejectionSignature?: { status: number; code?: string; message?: string };
};
type Evidence = {
  schemaVersion: 1; gatewayId: 'ai-gateway' | 'apim-v2'; gatewayOrigin: string; capturedAt: string;
  kind: 'caller-request-limit' | 'model-allowlist'; alias: string; allowedAlias: string;
  runtimePath: string; policy?: { source: 'azure-control-plane'; resourceId: string; configuration: unknown; capturedAt: string };
  proof: { attributable: boolean; aRejected: boolean; bAllowed: boolean; explanation: string;
    rejectionSignature?: Attempt['rejectionSignature']; callerIsolation?: boolean };
  attempts: Attempt[]; configurationAttempts: number; configurationHistory: Json[];
  standaloneBlocker?: string; accounting?: Json;
};

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected API object; no payload logged.');
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Required safe configuration field is missing.');
  return value;
}
function cli(args: string[]): unknown {
  try {
    return JSON.parse(execFileSync('az', [...args, '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 2 * 1024 * 1024
    }));
  } catch {
    throw new Error('Azure CLI authentication/read failed; no CLI payload logged.');
  }
}
const options = new Set(process.argv.slice(2));
if (!options.size || [...options].some(option => !['--configure', '--verify', '--apim-allowlist', '--readback', '--verify-allowed-b'].includes(option))
  || (options.has('--readback') && options.size !== 1)
  || (options.has('--verify-allowed-b') && options.size !== 1)
  || (options.has('--apim-allowlist') && (options.has('--configure') || !options.has('--verify')))) {
  throw new Error('Usage: governance-proof.ts [--configure] [--verify] | --verify --apim-allowlist | --readback | --verify-allowed-b');
}
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.NODE_EXTRA_CA_CERTS || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('Use NODE_EXTRA_CA_CERTS with the approved public CA bundle; insecure TLS is forbidden.');
}
const account = object(cli(['account', 'show']));
if (account.id !== subscription) throw new Error('Active subscription differs from the explicitly authorized demo subscription.');
const token = string(object(cli(['account', 'get-access-token', '--subscription', subscription,
  '--resource', 'https://management.azure.com/'])).accessToken);
const secrets = [token, process.env.APP_A_KEY, process.env.APP_B_KEY, process.env.APIM_V2_APP_A_KEY,
  process.env.APIM_V2_APP_B_KEY].filter((value): value is string => Boolean(value));

async function arm(path: string, api = '2026-05-01', method = 'GET', body?: unknown, etag?: string): Promise<{ status: number; value: Json; etag: string | null }> {
  let response: Response;
  try {
    response = await fetch(`https://management.azure.com${path}?api-version=${api}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(etag ? { [method === 'PUT' ? 'If-None-Match' : 'If-Match']: etag } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000)
    });
  } catch {
    throw new Error('Azure control-plane request failed; no request or credential payload logged.');
  }
  let value: Json = {};
  const raw = await response.text();
  if (raw.trim().startsWith('<policies>') && path === apimPolicy && method === 'GET') {
    value = { properties: { value: raw, format: 'rawxml' } };
  } else if (raw.trim()) {
    try { value = object(JSON.parse(raw)); } catch { throw new Error('Azure returned an unsupported control-plane response; no payload logged.'); }
  }
  if (!response.ok && response.status !== 404) throw new Error(`Azure control-plane ${method} failed: HTTP ${response.status}; no payload logged.`);
  return { status: response.status, value, etag: response.headers.get('etag') };
}
function properties(value: Json): Json { return object(value.properties); }
function initialEvidence(): Evidence {
  return {
    schemaVersion: 1, gatewayId: 'ai-gateway', gatewayOrigin: standaloneOrigin, capturedAt: new Date().toISOString(),
    kind: 'caller-request-limit', alias: aliasName, allowedAlias: 'ai-cost-economy-current', runtimePath,
    proof: { attributable: false, aRejected: false, bAllowed: false, callerIsolation: false,
      explanation: 'No runtime proof captured yet.' },
    attempts: [], configurationAttempts: 0, configurationHistory: []
  };
}
const evidence: Evidence = existsSync(artifact) ? JSON.parse(readFileSync(artifact, 'utf8')) as Evidence : initialEvidence();
if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.attempts) || !Array.isArray(evidence.configurationHistory)
  || !Number.isInteger(evidence.configurationAttempts) || evidence.attempts.length > maxCalls) {
  throw new Error('Existing evidence ledger is incompatible; refusing to replace or reset its bounded call count.');
}
if (evidence.proof.attributable && !options.has('--readback') && !options.has('--verify-allowed-b')) {
  throw new Error('Persistent governance proof is already attributable; stopped without additional mutations or live calls.');
}
if (options.has('--verify-allowed-b') && evidence.attempts.some(attempt => attempt.gatewayId === 'apim-v2'
  && attempt.app === 'B' && attempt.alias === 'ai-cost-economy-current')) {
  throw new Error('The single authorized B follow-up was already attempted; stopped without additional calls or evidence changes.');
}
function save(): void {
  evidence.capturedAt = new Date().toISOString();
  const successes = evidence.attempts.filter(attempt => attempt.modelResponse);
  const priced = successes.filter(attempt => attempt.returnedModel === 'gpt-6-luna-2026-09-22' && attempt.tokens);
  const knownCost = priced.reduce((sum, attempt) => sum + (attempt.tokens!.input * 0.1 + attempt.tokens!.output * 0.5) / 1_000_000, 0);
  evidence.accounting = {
    liveCallAttempts: evidence.attempts.length, liveCallLimit: maxCalls,
    successfulModelResponses: successes.length,
    observedInputTokens: priced.reduce((sum, attempt) => sum + attempt.tokens!.input, 0),
    observedOutputTokens: priced.reduce((sum, attempt) => sum + attempt.tokens!.output, 0),
    observedSuccessfulModelCostUsd: Number(knownCost.toFixed(9)),
    pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, returnedModel: 'gpt-6-luna-2026-09-22', reviewedAt: '2026-10-12' },
    unknownUsageAttempts: evidence.attempts.filter(attempt => !priced.includes(attempt)).length,
    limitation: 'Observed successful-response token estimate, not billed cost. Rejections have no observed model usage; no invented zero-cost backend claim.'
  };
  mkdirSync('.local', { recursive: true });
  const safe = JSON.stringify(evidence, null, 2);
  if (secrets.some(secret => safe.includes(secret))) throw new Error('Credential detected in evidence; refusing to persist.');
  writeFileSync(`${artifact}.pending`, safe, { mode: 0o600 });
  renameSync(`${artifact}.pending`, artifact);
}
function checkTarget(value: Json): void {
  const p = properties(value);
  if (p.aliasName !== aliasName || !Array.isArray(p.backendModels) || p.backendModels.length !== 1
    || object(p.backendModels[0]).resourceId !== model) throw new Error('Dedicated alias has conflicting targets; refusing mutation or probe.');
}
function safePolicies(value: unknown): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid policy array; refusing mutation.');
  return value.map(policy => {
    const p = object(policy);
    const allowed = ['type', 'callsPerPeriod', 'periodSeconds', 'counterKey', 'scope', 'count', 'period'];
    return Object.fromEntries(allowed.filter(key => p[key] !== undefined).map(key => [key, p[key]]));
  });
}
async function configure(): Promise<void> {
  if (evidence.configurationAttempts >= maxConfigurations) throw new Error('Two configuration attempts exhausted; no additional mutation permitted.');
  const rg = await arm(group, '2024-03-01');
  const tags = object(rg.value.tags);
  if (rg.status !== 200 || tags.purpose !== 'enterprise-ai-gateway-demo' || tags.environment !== 'demo') {
    throw new Error('Exact demo resource-group ownership tags do not match; refusing mutation.');
  }
  const gatewayRead = await arm(gateway);
  if (properties(gatewayRead.value).provisioningState !== 'Succeeded') throw new Error('Authorized demo gateway is not ready.');
  const target = await arm(model);
  const deployment = object(properties(target.value).deployment);
  if (deployment.resourceId !== `${group}/providers/Microsoft.CognitiveServices/accounts/${config.modelAccountName}/deployments/ai-cost-economy-current`
    || deployment.modelName !== 'ai-cost-economy-current' || deployment.modelVersion !== '2026-09-22') {
    throw new Error('Existing Luna target is not the expected pinned demo deployment.');
  }
  const existing = await arm(alias);
  const policy = { type: 'requestRateLimit', callsPerPeriod: 1, periodSeconds, counterKey: ['Identity'], scope: 'resource' };
  evidence.configurationAttempts++;
  evidence.configurationHistory.push({ attempt: evidence.configurationAttempts, at: new Date().toISOString(),
    resourceId: alias, requestedPolicy: policy, backingModelResourceId: model,
    backingModelPolicies: safePolicies(properties(target.value).policies) });
  save();
  if (existing.status === 404) {
    await arm(alias, '2026-05-01', 'PUT', {
      properties: { aliasName, description: 'Dedicated bounded native governance proof; existing Luna target, no new deployment.',
        backendModels: [{ resourceId: model }], policies: [policy] }
    }, '*');
  } else {
    checkTarget(existing.value);
    if (!existing.etag) throw new Error('Dedicated alias did not return an ETag; refusing unconditional update.');
    const current = properties(existing.value).policies ?? [];
    if (!Array.isArray(current)) throw new Error('Invalid existing policies; refusing overwrite.');
    const preserved = current.filter(item => object(item).type !== 'requestRateLimit');
    await arm(alias, '2026-05-01', 'PATCH', { properties: { policies: [...preserved, policy] } }, existing.etag);
  }
  await snapshotStandalone();
  save();
  console.log(JSON.stringify({ configuredAlias: aliasName, configurationAttempt: evidence.configurationAttempts,
    resourceId: alias, configuration: evidence.policy?.configuration }));
}
async function snapshotStandalone(): Promise<void> {
  const read = await arm(alias);
  if (read.status !== 200) throw new Error('Dedicated governance alias does not exist; run --configure first.');
  checkTarget(read.value);
  const p = properties(read.value);
  const policies = safePolicies(p.policies);
  const rate = policies.find(policy => policy.type === 'requestRateLimit');
  if (!rate || rate.callsPerPeriod !== 1 || rate.periodSeconds !== periodSeconds) {
    throw new Error('Read-back dedicated native request limit does not match the bounded proof configuration.');
  }
  evidence.gatewayId = 'ai-gateway'; evidence.gatewayOrigin = standaloneOrigin;
  evidence.kind = 'caller-request-limit'; evidence.alias = aliasName;
  evidence.policy = { source: 'azure-control-plane', resourceId: alias,
    configuration: { aliasName: p.aliasName, backendModels: p.backendModels, policies }, capturedAt: new Date().toISOString() };
  const history = evidence.configurationHistory.at(-1);
  if (history) history.readbackPolicies = policies;
}
function rejection(status: number, value: Json): Attempt['rejectionSignature'] {
  if (status < 400) return undefined;
  const error = value.error && typeof value.error === 'object' ? object(value.error) : value;
  const code = typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  // Only fixed native policy signatures are retained, never arbitrary provider text.
  const matched = message === 'Select a configured comparison model.' ? message
    : /^Rate limit is exceeded\. Try again in \d+ seconds\.$/i.test(message) ? message
      : /^Request rate limit (?:is )?exceeded\.?$/i.test(message) ? message : undefined;
  return { status, ...(code ? { code } : {}), ...(matched ? { message: matched } : {}) };
}
async function probe(app: 'A' | 'B', profile: 'ai-gateway' | 'apim-v2', selectedAlias: string): Promise<Attempt> {
  if (evidence.attempts.length >= maxCalls) throw new Error('Twelve live call attempts exhausted; explicit parent permission required.');
  const prefix = profile === 'apim-v2' ? 'APIM_V2_' : '';
  const a = process.env[`${prefix}APP_A_KEY`];
  const b = process.env[`${prefix}APP_B_KEY`];
  if (!a || !b || a === b) throw new Error('Distinct existing gateway A/B keys are required; no keys created.');
  const key = app === 'A' ? a : b;
  const origin = profile === 'apim-v2' ? apimOrigin : standaloneOrigin;
  if (process.env[`${prefix}GATEWAY_ORIGIN`]?.replace(/\/$/, '') !== origin) throw new Error('Configured runtime origin differs from the authorized gateway.');
  const authHeader = profile === 'apim-v2' ? process.env.APIM_V2_AUTH_HEADER || 'Ocp-Apim-Subscription-Key' : 'api-key';
  if (!['api-key', 'Ocp-Apim-Subscription-Key'].includes(authHeader)) throw new Error('Unsupported runtime authentication header.');
  const attempt: Attempt = { app, gatewayId: profile, alias: selectedAlias, status: 0, headers: {},
    modelResponse: false, latencyMs: 0, correlationId: randomUUID(), at: new Date().toISOString() };
  evidence.attempts.push(attempt);
  save(); // Reserve the live attempt before sending; interrupted requests remain counted.
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${runtimePath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', [authHeader]: key, 'x-correlation-id': attempt.correlationId },
      body: JSON.stringify({ model: selectedAlias, messages: [{ role: 'user', content: 'Say ready.' }],
        reasoning_effort: 'none', max_completion_tokens: 32, stream: false }),
      redirect: 'error', signal: AbortSignal.timeout(45000)
    });
    attempt.status = response.status;
    for (const name of headerAllowlist) {
      const value = response.headers.get(name);
      if (value && value.length <= 256 && !secrets.some(secret => value.includes(secret))) attempt.headers[name] = value;
    }
    let result: Json = {};
    try { result = object(await response.json()); } catch { /* No arbitrary response is logged or persisted. */ }
    attempt.modelResponse = response.ok && Array.isArray(result.choices) && result.choices.some(choice => {
      const message = object(object(choice).message);
      return typeof message.content === 'string' && message.content.trim().length > 0;
    });
    if (typeof result.model === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(result.model)) attempt.returnedModel = result.model;
    if (result.usage && typeof result.usage === 'object') {
      const usage = object(result.usage);
      if ([usage.prompt_tokens, usage.completion_tokens].every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
        attempt.tokens = { input: usage.prompt_tokens as number, output: usage.completion_tokens as number };
      }
    }
    attempt.rejectionSignature = rejection(attempt.status, result);
  } catch {
    // status 0 means transport or response parsing failed, not a policy rejection.
  } finally {
    attempt.latencyMs = Math.round(performance.now() - started);
    save();
  }
  console.log(JSON.stringify(attempt));
  return attempt;
}
function isNativeRateRejection(attempt: Attempt): boolean {
  return attempt.status === 429 && Boolean(attempt.headers['retry-after'])
    && Boolean(attempt.rejectionSignature?.message && /rate limit/i.test(attempt.rejectionSignature.message));
}
async function verifyStandalone(): Promise<void> {
  await snapshotStandalone();
  if (evidence.attempts.length + 3 > maxCalls) throw new Error('Insufficient remaining budget for the three-call caller-isolation probe.');
  // Allow control-plane propagation and an empty 120-second counter window without model calls.
  await new Promise(resolve => setTimeout(resolve, (periodSeconds + 10) * 1000));
  const allowedA = await probe('A', 'ai-gateway', aliasName);
  const rejectedA = await probe('A', 'ai-gateway', aliasName);
  const allowedB = await probe('B', 'ai-gateway', aliasName);
  const sameWindow = Date.parse(allowedB.at) - Date.parse(allowedA.at) < periodSeconds * 1000;
  const attributable = allowedA.status === 200 && allowedA.modelResponse && isNativeRateRejection(rejectedA)
    && allowedB.status === 200 && allowedB.modelResponse && sameWindow;
  evidence.proof = { attributable, aRejected: isNativeRateRejection(rejectedA),
    bAllowed: allowedB.status === 200 && allowedB.modelResponse, callerIsolation: attributable,
    rejectionSignature: rejectedA.rejectionSignature,
    explanation: attributable ? 'A succeeded, then received the native request-policy signature with Retry-After; B succeeded within the same configured counter window.'
      : `Dedicated alias policy read-back did not yield caller isolation: A first HTTP ${allowedA.status}, A next HTTP ${rejectedA.status}, B HTTP ${allowedB.status}; same-window=${sameWindow}. Generic upstream 429 does not establish native caller-specific enforcement.` };
  if (!attributable) evidence.standaloneBlocker = evidence.proof.explanation;
  save();
}
function safePolicyXml(xml: string): string {
  // The exact allowlist block is relevant evidence; other operation policy blocks
  // may include authentication headers and are deliberately not persisted.
  const blocks = [...xml.matchAll(/<choose>[\s\S]*?<\/choose>/g)]
    .map(match => match[0]).filter(block => block.includes('Select a configured comparison model.'));
  if (xml.length > 30000 || blocks.length !== 1) throw new Error('Expected single native operation allowlist block is missing.');
  const relevant = blocks[0]!;
  if (/(?:subscription-key|api-key|Bearer\s+[A-Za-z0-9]|password|client_secret)/i.test(relevant)
    || secrets.some(secret => relevant.includes(secret))) throw new Error('Operation allowlist cannot be safely captured.');
  return relevant;
}
async function verifyApim(): Promise<void> {
  if (!evidence.standaloneBlocker) throw new Error('Fallback requires a recorded standalone attribution blocker.');
  if (evidence.attempts.length + 2 > maxCalls) throw new Error('Insufficient remaining budget for the two-call allowlist proof.');
  const service = await arm(apim, '2024-05-01');
  if (object(service.value.sku).name !== 'PremiumV2' || object(service.value.tags).purpose !== 'enterprise-ai-gateway-comparison'
    || properties(service.value).provisioningState !== 'Succeeded') throw new Error('Existing APIM comparison service identity or readiness differs.');
  const read = await arm(apimPolicy, '2024-05-01');
  const xml = safePolicyXml(string(properties(read.value).value));
  if (!xml.includes('ai-cost-economy-current') || !xml.includes('return-response') || !xml.includes('code="400"')) {
    throw new Error('Actual operation policy does not contain the expected model allowlist refusal.');
  }
  evidence.gatewayId = 'apim-v2'; evidence.gatewayOrigin = apimOrigin; evidence.kind = 'model-allowlist';
  evidence.alias = 'demo-policy-refusal';
  evidence.policy = { source: 'azure-control-plane', resourceId: apimPolicy,
    configuration: xml, capturedAt: new Date().toISOString() };
  save();
  const rejected = await probe('A', 'apim-v2', 'demo-policy-refusal');
  const allowed = await probe('A', 'apim-v2', 'ai-cost-economy-current');
  const aRejected = rejected.status === 400 && rejected.rejectionSignature?.message === 'Select a configured comparison model.';
  const allowedResponse = allowed.status === 200 && allowed.modelResponse && allowed.returnedModel === 'gpt-6-luna-2026-09-22';
  const finalRead = await arm(apimPolicy, '2024-05-01');
  const unchanged = safePolicyXml(string(properties(finalRead.value).value)) === xml;
  evidence.proof = { attributable: aRejected && allowedResponse && unchanged, aRejected, bAllowed: false, callerIsolation: false,
    rejectionSignature: rejected.rejectionSignature,
    explanation: aRejected && allowedResponse && unchanged
      ? 'Actual APIM operation policy rejected the fixed unknown model with its exact native 400 message; the same A caller received a real Luna response for the configured model. Model allowlist proof only, not caller isolation.'
      : 'APIM allowlist probe did not produce both the exact configured native refusal and a real allowed Luna response; no enforcement claim.' };
  save();
}
async function verifyAllowedB(): Promise<void> {
  if (evidence.gatewayId !== 'apim-v2' || evidence.gatewayOrigin !== apimOrigin || evidence.kind !== 'model-allowlist'
    || evidence.alias !== 'demo-policy-refusal' || evidence.allowedAlias !== 'ai-cost-economy-current'
    || !evidence.policy || evidence.policy.resourceId !== apimPolicy || evidence.proof.bAllowed) {
    throw new Error('Single B follow-up requires an existing matching allowlist proof without a successful B observation.');
  }
  const rejected = evidence.attempts.find(attempt => attempt.gatewayId === 'apim-v2' && attempt.app === 'A'
    && attempt.alias === 'demo-policy-refusal' && attempt.status === 400
    && attempt.rejectionSignature?.message === 'Select a configured comparison model.');
  if (!rejected) throw new Error('No actual matching A allowlist rejection is recorded; refusing a B follow-up.');
  const read = await arm(apimPolicy, '2024-05-01');
  const xml = safePolicyXml(string(properties(read.value).value));
  if (xml !== evidence.policy.configuration) throw new Error('Current APIM policy differs from the rejection evidence; refusing follow-up.');
  const allowed = await probe('B', 'apim-v2', 'ai-cost-economy-current');
  const finalRead = await arm(apimPolicy, '2024-05-01');
  const unchanged = safePolicyXml(string(properties(finalRead.value).value)) === xml;
  const bAllowed = allowed.status === 200 && allowed.modelResponse && allowed.returnedModel === 'gpt-6-luna-2026-09-22';
  evidence.proof = {
    attributable: bAllowed && unchanged, aRejected: true, bAllowed, callerIsolation: false,
    rejectionSignature: rejected.rejectionSignature,
    explanation: bAllowed && unchanged
      ? 'Actual APIM operation policy rejected fixed unknown demo-policy-refusal for A with its exact native 400 message; B received a real Luna response for configured ai-cost-economy-current. Model allowlist proof only, not caller isolation.'
      : 'Recorded A native allowlist rejection remains valid, but the single B follow-up did not establish a real allowed Luna response under unchanged policy; no A-rejected/B-allowed proof claim.'
  };
  save();
}
try {
  if (options.has('--readback')) {
    if (!evidence.policy) throw new Error('No captured policy is available to compare.');
    const read = await arm(evidence.policy.resourceId, evidence.gatewayId === 'apim-v2' ? '2024-05-01' : '2026-05-01');
    const configuration = evidence.gatewayId === 'apim-v2' ? safePolicyXml(string(properties(read.value).value))
      : { aliasName: properties(read.value).aliasName, backendModels: properties(read.value).backendModels,
        policies: safePolicies(properties(read.value).policies) };
    if (JSON.stringify(configuration) !== JSON.stringify(evidence.policy.configuration)) {
      throw new Error('Actual Azure policy differs from the captured evidence; stopped without live calls or updates.');
    }
    console.log(JSON.stringify({ matchingControlPlanePolicy: true, resourceId: evidence.policy.resourceId,
      liveCallsThisRun: 0, recordedLiveCalls: evidence.attempts.length }));
  }
  if (options.has('--configure')) await configure();
  if (options.has('--verify-allowed-b')) await verifyAllowedB();
  if (options.has('--verify')) {
    if (options.has('--apim-allowlist')) await verifyApim();
    else await verifyStandalone();
  }
  console.log(JSON.stringify({ artifact, gatewayId: evidence.gatewayId, kind: evidence.kind,
    proof: evidence.proof, accounting: evidence.accounting }));
} catch (error) {
  save();
  console.error(error instanceof Error && !secrets.some(secret => error.message.includes(secret))
    ? error.message : 'Governance proof failed; no credential or response payload logged.');
  process.exitCode = 1;
}
