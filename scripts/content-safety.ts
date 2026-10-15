import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = `/subscriptions/${subscription}/resourceGroups/${config.resourceGroup}`;
const gateway = `${group}/providers/Microsoft.ApiManagement/aigateways/${config.gatewayName}`;
const workspace = `${gateway}/workspaces/default`;
const accountId = `${group}/providers/Microsoft.CognitiveServices/accounts/${config.contentSafetyAccountName}`;
const apim = `/subscriptions/${subscription}/resourceGroups/${config.comparisonResourceGroup}/providers/Microsoft.ApiManagement/service/${config.comparisonGatewayName}`;
const apimApi = `${apim}/apis/gateway-comparison`;
const apimArtifact = '.local/apim-v2-content-safety.json';
const apimOrigin = config.comparisonGatewayOrigin;
const origin = config.gatewayOrigin;
const artifact = '.local/gateway-content-safety.json';
const marker = 'POC_CONTENT_SAFETY_BLOCK';
const pilotName = 'demo-content-safety-proof';
const categoryPolicy = { type: 'contentSafety', hateSeverity: 'Medium', violenceSeverity: 'Medium',
  sexualSeverity: 'Medium', selfHarmSeverity: 'Medium' };
type Json = Record<string, unknown>;
type Asset = { id: string; name: string; kind: 'model' | 'alias'; properties: Json };
type Attempt = { app: 'A'; assetName: string; action: 'reject' | 'allow'; status: number;
  headers: Record<string, string>; modelResponse: boolean; returnedModel?: string; tokens: Json | null;
  latencyMs: number; correlationId: string; at: string; rejectionSignature?: Json };
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object; payload not logged.');
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Required configuration string missing.');
  return value;
}
function cli(args: string[]): Json {
  try {
    return object(JSON.parse(execFileSync('az', [...args, ...(args.includes('--subscription') ? [] : ['--subscription', subscription]), '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
    })));
  } catch {
    throw new Error('Azure CLI operation failed; credential-bearing output withheld.');
  }
}
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.NODE_EXTRA_CA_CERTS || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('Use the approved NODE_EXTRA_CA_CERTS bundle; insecure TLS is forbidden.');
}
const mode = process.argv[2];
if (!['--inspect', '--configure', '--verify-pilot', '--baseline', '--configure-apim', '--verify-apim'].includes(mode || '') || process.argv.length !== 3) {
  throw new Error('Usage: content-safety.ts --inspect | --configure | --verify-pilot | --baseline | --configure-apim | --verify-apim');
}
if (cli(['account', 'show']).id !== subscription) throw new Error('Unexpected subscription; no mutation performed.');
const token = text(cli(['account', 'get-access-token', '--resource', 'https://management.azure.com/']).accessToken);
async function arm(path: string, method = 'GET', body?: unknown, api = '2026-05-01', tolerate = false): Promise<{status: number; value: Json; etag: string | null}> {
  const response = await fetch(`https://management.azure.com${path}?api-version=${api}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000)
  });
  const raw = await response.text();
  const value: Json = raw.trim().startsWith('<policies>')
    ? { properties: { value: raw, format: 'rawxml' } } : raw ? object(JSON.parse(raw)) : {};
  if (!response.ok && !(tolerate || response.status === 404)) {
    const code = value.error && object(value.error).code;
    throw new Error(`Azure ${method} failed: HTTP ${response.status}; code ${typeof code === 'string' ? code : 'unavailable'}.`);
  }
  return { status: response.status, value, etag: response.headers.get('etag') };
}
async function assets(): Promise<Asset[]> {
  const found: Asset[] = [];
  const providers = (await arm(`${workspace}/modelProviders`)).value.value;
  if (!Array.isArray(providers)) throw new Error('Model-provider inventory missing.');
  for (const item of providers) {
    const provider = object(item);
    const models = (await arm(`${text(provider.id)}/models`)).value.value;
    if (!Array.isArray(models)) throw new Error('Model inventory missing.');
    for (const item of models) {
      const model = object(item);
      found.push({ id: text(model.id), name: text(model.name), kind: 'model', properties: object(model.properties) });
    }
  }
  const aliases = (await arm(`${workspace}/aliases`)).value.value;
  if (!Array.isArray(aliases)) throw new Error('Alias inventory missing.');
  for (const item of aliases) {
    const alias = object(item);
    found.push({ id: text(alias.id), name: text(alias.name), kind: 'alias', properties: object(alias.properties) });
  }
  return found;
}
function save(evidence: Json, file = artifact) {
  mkdirSync('.local', { recursive: true });
  evidence.capturedAt = new Date().toISOString();
  writeFileSync(`${file}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
function load(file = artifact): Json {
  if (!existsSync(file)) throw new Error('Configure the profile safety evidence first.');
  return object(JSON.parse(readFileSync(file, 'utf8')));
}
async function configurePolicy(asset: Asset) {
  const current = await arm(asset.id);
  const properties = object(current.value.properties);
  const policies = properties.policies ?? [];
  if (!Array.isArray(policies)) throw new Error('Unexpected policy list; refusing to replace it.');
  const existing = policies.find(policy => object(policy).type === 'contentSafety');
  if (existing && !Object.entries(categoryPolicy).every(([name, value]) => object(existing)[name] === value)) {
    throw new Error('Existing safety policy differs; refusing to replace it.');
  }
  if (!existing) {
    const response = await fetch(`https://management.azure.com${asset.id}?api-version=2026-05-01`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(current.etag ? { 'If-Match': current.etag } : {}) },
      body: JSON.stringify({ properties: { policies: [...policies, categoryPolicy] } }),
      redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Native safety policy PATCH failed: HTTP ${response.status}.`);
  }
  const readback = await arm(asset.id);
  const actual = object(readback.value.properties).policies;
  if (!Array.isArray(actual) || !actual.some(policy =>
    Object.entries(categoryPolicy).every(([name, value]) => object(policy)[name] === value))) {
    throw new Error('Native safety policy fields did not match on readback.');
  }
  return { resourceId: asset.id, assetName: asset.name, assetType: asset.kind,
    configuration: actual, capturedAt: new Date().toISOString() };
}
async function assignSafetyRole(principalId: string, principalType: 'User' | 'ServicePrincipal') {
  const role = 'a97b65f3-24c7-4388-baec-2e87135dc908';
  const digest = createHash('sha256').update(`${accountId}|${principalId}|${role}`).digest('hex').slice(0, 32);
  const assignmentId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
  const assignment = await arm(`${accountId}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`, 'PUT',
    { properties: { principalId, roleDefinitionId: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
      principalType } }, '2022-04-01', true);
  if (![200, 201].includes(assignment.status) && object(assignment.value.error).code !== 'RoleAssignmentExists') {
    throw new Error(`Content Safety data-plane role assignment failed: HTTP ${assignment.status}.`);
  }
}
if (mode === '--inspect') {
  const inventory = await assets();
  const backend = await arm(`${gateway}/backends`, 'GET', undefined, '2026-05-01', true);
  console.log(JSON.stringify({ assets: inventory.map(asset => ({ id: asset.id, name: asset.name,
    kind: asset.kind, policies: asset.properties.policies || [] })), nativeBackendStatus: backend.status,
    nativeBackendError: backend.value.error }, null, 2));
}
if (mode === '--configure') {
  const existing = await arm(accountId, 'GET', undefined, '2024-04-01-preview');
  let account = existing.value;
  if (existing.status === 404) {
    account = cli(['cognitiveservices', 'account', 'create', '--name', config.contentSafetyAccountName,
      '--resource-group', config.resourceGroup, '--kind', 'ContentSafety', '--sku', 'F0',
      '--location', config.contentSafetyLocation, '--custom-domain', config.contentSafetyAccountName, '--yes']);
  }
  if (account.kind !== 'ContentSafety' || object(account.sku).name !== 'F0') throw new Error('Unexpected safety account; no paid tier allowed.');
  const endpoint = text(object(account.properties).endpoint);
  const claims = object(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
  const principalId = text(claims.oid);
  await assignSafetyRole(principalId, object(cli(['account', 'show']).user).type === 'user' ? 'User' : 'ServicePrincipal');
  const safetyToken = text(cli(['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com/']).accessToken);
  async function safety(path: string, method: string, body: unknown) {
    const response = await fetch(`${endpoint}contentsafety/${path}?api-version=2024-09-01`, {
      method, headers: { Authorization: `Bearer ${safetyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Content Safety service configuration failed: HTTP ${response.status}; payload withheld.`);
  }
  await safety('text/blocklists/poc-demo-blocklist', 'PATCH', { description: 'Harmless synthetic gateway demonstration marker.' });
  await safety('text/blocklists/poc-demo-blocklist:addOrUpdateBlocklistItems', 'POST', {
    blocklistItems: [{ description: 'Harmless synthetic control phrase.', text: marker }]
  });
  const pilot = `${workspace}/aliases/${pilotName}`;
  const current = await arm(pilot);
  if (current.status === 404) {
    await arm(pilot, 'PUT', { properties: { aliasName: pilotName,
      backendModels: [{ resourceId: `${workspace}/modelProviders/azure-models/models/ai-cost-economy-current` }],
      description: 'Isolated native Content Safety pilot; existing Luna model, no new deployment.',
      selectionOrder: ['routing'], supportedEndpoints: ['/openai/v1/chat/completions'],
      policies: [categoryPolicy] } });
  }
  const inventory = await assets();
  const pilotAsset = inventory.find(asset => asset.kind === 'alias' && asset.name === pilotName);
  if (!pilotAsset) throw new Error('New pilot alias missing from inventory.');
  const policy = await configurePolicy(pilotAsset);
  const backend = await arm(`${gateway}/backends`, 'GET', undefined, '2026-05-01', true);
  const evidence = existsSync(artifact) ? load() : {
    schemaVersion: 1, gatewayId: 'ai-gateway', gatewayOrigin: origin, marker, attempts: [],
    proof: { attributable: false, allowedVerified: false, explanation: 'No native blocklist rejection has been verified.',
      rejectionSignature: { status: 400 } }
  };
  evidence.backend = { resourceId: accountId, endpoint, sku: 'F0', blocklistName: 'poc-demo-blocklist', connected: false };
  evidence.integrationBlocker = backend.status === 400
    ? 'Native backend API returned MethodNotAllowedInPricingTier. The native category card has no verified Content Safety backend/blocklist binding; resource creation is not integration proof.'
    : 'Backend/blocklist binding is not yet verified for this standalone tier.';
  evidence.policies = [policy];
  evidence.coverage = inventory.map(asset => ({ assetName: asset.name, resourceId: asset.id, assetType: asset.kind,
    policyConfigured: asset.name === pilotName && asset.kind === 'alias', rejectionVerified: false }));
  save(evidence);
  console.log(JSON.stringify({ resourceCreatedOrReused: accountId, sku: 'F0', blocklistConfigured: true,
    pilotAlias: pilotName, nativeCategoryPolicyReadback: true, backendConnected: false, integrationBlocker: evidence.integrationBlocker }));
}
if (mode === '--verify-pilot') {
  const evidence = load();
  const attempts = evidence.attempts;
  if (!Array.isArray(attempts) || attempts.length) throw new Error('Pilot was already attempted; no repeat calls or replacement samples.');
  console.log('Live pilot batch: TWO standalone gateway requests, one harmless marker and one allowed prompt. At most two real Luna calls, estimated total model cost under $0.001. No retries; requests spaced 61 seconds.');
  const key = text(process.env.APP_A_KEY);
  for (const action of ['reject', 'allow'] as const) {
    if (attempts.length) await delay(61000);
    const correlationId = randomUUID(), at = new Date().toISOString(), start = performance.now();
    const response = await fetch(`${origin}/default/models/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', 'x-correlation-id': correlationId },
      body: JSON.stringify({ model: pilotName, messages: [{ role: 'user',
        content: action === 'reject' ? `${marker}. Reply exactly SAFETY_OK.` : 'Reply exactly SAFETY_OK.' }],
        max_completion_tokens: 64, reasoning_effort: 'none' }),
      redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    const body = object(await response.json());
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const modelResponse = response.status === 200 && choices.some(choice => {
      const content = object(object(choice).message).content;
      return typeof content === 'string' && content.trim().length > 0;
    });
    const headers: Record<string, string> = {};
    for (const name of ['apim-request-id', 'x-request-id', 'x-ms-request-id', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const usage = body.usage ? object(body.usage) : undefined;
    const signature = body.error ? object(body.error) : undefined;
    const attempt: Attempt = { app: 'A', assetName: pilotName, action, status: response.status, headers, modelResponse,
      ...(typeof body.model === 'string' ? { returnedModel: body.model } : {}),
      tokens: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens } : null,
      latencyMs: Math.round(performance.now() - start), correlationId, at,
      ...(signature ? { rejectionSignature: { status: response.status, code: signature.code,
        message: typeof signature.message === 'string' ? signature.message.slice(0, 500) : undefined } } : {}) };
    attempts.push(attempt);
    const allowedVerified = attempts.some(item => object(item).action === 'allow' && object(item).modelResponse === true);
    evidence.proof = { attributable: false, allowedVerified,
      explanation: 'Native category configuration is not native blocklist integration proof. Inspect the genuine pilot observations.',
      rejectionSignature: { status: 400 } };
    save(evidence);
    console.log(JSON.stringify(attempt));
  }
}
if (mode === '--baseline') {
  const evidence = load();
  const attempts = evidence.attempts;
  if (!Array.isArray(attempts) || !attempts.some(item => object(item).action === 'allow' && object(item).modelResponse === true)) {
    throw new Error('An allowed pilot response is required before changing other assets.');
  }
  const inventory = await assets();
  const policies = [];
  for (const asset of inventory) policies.push(await configurePolicy(asset));
  evidence.policies = policies;
  evidence.coverage = inventory.map(asset => ({ assetName: asset.name, resourceId: asset.id, assetType: asset.kind,
    policyConfigured: true, rejectionVerified: false }));
  save(evidence);
  console.log(JSON.stringify({ nativeCategoryPolicyAssets: policies.length, runtimeRejectionVerified: false,
    futureAssetsCovered: false, backendConnected: false }));
}
{
  const apimAliases = ['ai-cost-economy-current', 'demo-chat-secondary', 'ai-cost-premium-current', 'demo-databricks-gpt-oss-20b'];
  if (mode === '--configure-apim') {
    if (existsSync(apimArtifact) && object(load(apimArtifact).proof).attributable === true) {
      throw new Error('Native APIM safety proof already verified; no configuration or evidence was replaced.');
    }
    const account = (await arm(accountId, 'GET', undefined, '2024-04-01-preview')).value;
    if (account.kind !== 'ContentSafety' || object(account.sku).name !== 'F0') throw new Error('Expected the approved existing F0 safety resource.');
    const endpoint = text(object(account.properties).endpoint).replace(/\/$/, '');
    const identity = object((await arm(apim, 'GET', undefined, '2025-09-01-preview')).value.identity);
    await assignSafetyRole(text(identity.principalId), 'ServicePrincipal');
    const backendId = `${apim}/backends/content-safety-backend`;
    const backend = await arm(backendId, 'GET', undefined, '2025-09-01-preview');
    if (backend.status === 404) {
      await arm(backendId, 'PUT', { properties: { description: 'Native Azure AI Content Safety; shared F0 demo resource.',
        url: endpoint, protocol: 'http', credentials: { managedIdentity: { resource: 'https://cognitiveservices.azure.com' } } } }, '2025-09-01-preview');
    } else if (object(backend.value.properties).url !== endpoint) {
      throw new Error('Existing APIM safety backend targets another resource; refusing to replace it.');
    }
    for (const operation of ['openai-chat', 'databricks-invocations']) {
      const policy = (await arm(`${apimApi}/operations/${operation}/policies/policy`, 'GET', undefined, '2025-09-01-preview')).value;
      if (!/<inbound>[\s\S]*?<base\s*\/>/.test(text(object(policy.properties).value))) {
        throw new Error('An operation does not inherit API policy; refusing to claim all-model coverage.');
      }
    }
    const path = `${apimApi}/policies/policy`;
    const original = await arm(path, 'GET', undefined, '2025-09-01-preview');
    const originalXml = original.status === 404
      ? '<policies><inbound><base /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
      : text(object(original.value.properties).value);
    const nativeXml = `<llm-content-safety backend-id="content-safety-backend" shield-prompt="false" enforce-on-completions="false">
        <categories output-type="FourSeverityLevels">
          <category name="Hate" threshold="4" />
          <category name="SelfHarm" threshold="4" />
          <category name="Sexual" threshold="4" />
          <category name="Violence" threshold="4" />
        </categories>
        <blocklists><id>poc-demo-blocklist</id></blocklists>
      </llm-content-safety>`;
    if (originalXml.includes('llm-content-safety') && !originalXml.includes('poc-demo-blocklist')) {
      throw new Error('Another safety baseline already exists; refusing to overwrite it.');
    }
    if (!originalXml.includes('poc-demo-blocklist')) {
      const updated = originalXml.replace(/<inbound>(\s*<base\s*\/>)?/, `<inbound><base />\n${nativeXml}`);
      if (updated === originalXml) throw new Error('API policy inbound section missing.');
      mkdirSync('.local', { recursive: true });
      const backup = '.local/content-safety-apim-original-policy.json';
      if (!existsSync(backup)) writeFileSync(backup, JSON.stringify({ resourceId: path, existed: original.status !== 404, xml: originalXml }), { mode: 0o600 });
      const response = await fetch(`https://management.azure.com${path}?api-version=2025-09-01-preview`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          ...(original.etag ? { 'If-Match': original.etag } : { 'If-None-Match': '*' }) },
        body: JSON.stringify({ properties: { format: 'rawxml', value: updated } }),
        redirect: 'error', signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) throw new Error(`APIM native Content Safety policy failed: HTTP ${response.status}.`);
    }
    const readback = text(object((await arm(path, 'GET', undefined, '2025-09-01-preview')).value.properties).value);
    if (!readback.includes('llm-content-safety') || !readback.includes('poc-demo-blocklist')) throw new Error('Native safety XML missing on readback.');
    const evidence = existsSync(apimArtifact) ? load(apimArtifact) : { schemaVersion: 1, gatewayId: 'apim-v2',
      gatewayOrigin: apimOrigin, marker, attempts: [], proof: { attributable: false, allowedVerified: false,
        explanation: 'Native API-level Content Safety baseline configured; runtime verification pending.', rejectionSignature: { status: 403 } } };
    evidence.backend = { resourceId: accountId, endpoint: `${endpoint}/`, sku: 'F0', blocklistName: 'poc-demo-blocklist', connected: true };
    evidence.policies = apimAliases.map(assetName => ({ resourceId: path, assetName, assetType: 'model',
      configuration: readback, capturedAt: new Date().toISOString() }));
    evidence.coverage = apimAliases.map(assetName => ({ resourceId: path, assetName, assetType: 'model',
      policyConfigured: true, rejectionVerified: false }));
    save(evidence, apimArtifact);
    console.log(JSON.stringify({ gatewayId: 'apim-v2', nativeApiPolicyReadback: true, configuredAliases: apimAliases,
      backend: 'Managed identity to existing F0 account', promptInspection: true, completionInspection: false, runtimeProof: false }));
  }
  if (mode === '--verify-apim') {
    const evidence = load(apimArtifact);
    const attempts = evidence.attempts;
    if (!Array.isArray(attempts) || attempts.length) throw new Error('APIM batch already attempted; no retries or replacement observations.');
    console.log('Live APIM batch: FOUR harmless-marker rejection probes (one per configured model, including Databricks), then ONE allowed Luna request. Expected: one model inference, priced Luna cost under $0.001; Content Safety uses F0 allowance. Unexpected status aborts the batch; rejected requests have unknown model usage, not invented zero cost. No Databricks inference expected; its model cost is unavailable if protection fails.');
    const key = text(process.env.APIM_V2_APP_A_KEY);
    for (const [index, name] of [...apimAliases, apimAliases[0]].entries()) {
      if (index) await delay(3000);
      const action = index < apimAliases.length ? 'reject' : 'allow';
      const correlationId = randomUUID(), at = new Date().toISOString(), start = performance.now();
      const databricks = name === 'demo-databricks-gpt-oss-20b';
      const response = await fetch(`${apimOrigin}/default/models/${databricks ? 'databricks-gpt-oss-20b/invocations' : 'openai/v1/chat/completions'}`, {
        method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json', 'x-correlation-id': correlationId },
        body: JSON.stringify({ model: name, messages: [{ role: 'user',
          content: action === 'reject' ? `${marker}. Reply exactly SAFETY_OK.` : 'Reply exactly SAFETY_OK.' }],
          ...(databricks ? { max_tokens: 64 } : { max_completion_tokens: 64 }),
          ...(name === 'ai-cost-economy-current' ? { reasoning_effort: 'none' } : name === 'ai-cost-premium-current' ? { reasoning_effort: 'low' } : {}) }),
        redirect: 'error', signal: AbortSignal.timeout(60000)
      });
      const body = object(await response.json());
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const modelResponse = response.status === 200 && choices.some(choice => {
        const content = object(object(choice).message).content;
        return typeof content === 'string' && content.trim().length > 0;
      });
      const headers: Record<string, string> = {};
      for (const header of ['apim-request-id', 'x-request-id', 'x-ms-request-id', 'retry-after']) {
        const value = response.headers.get(header); if (value) headers[header] = value;
      }
      const usage = body.usage ? object(body.usage) : undefined;
      const error = body.error ? object(body.error) : body;
      const code = typeof error.code === 'string' ? error.code : undefined;
      const message = typeof error.message === 'string' ? error.message.slice(0, 500) : undefined;
      const signature = { status: response.status, ...(code ? { code } : {}), ...(message ? { message } : {}) };
      const attempt: Attempt = { app: 'A', assetName: name, action, status: response.status, headers, modelResponse,
        ...(typeof body.model === 'string' ? { returnedModel: body.model } : {}), tokens: usage
          ? { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens } : null,
        latencyMs: Math.round(performance.now() - start), correlationId, at, ...(action === 'reject' ? { rejectionSignature: signature } : {}) };
      attempts.push(attempt);
      save(evidence, apimArtifact);
      console.log(JSON.stringify(attempt));
      const safetySignature = /content.?safety|block.?list|content.?filter|filtered/i.test(`${code || ''} ${message || ''}`)
        && !/unauthorized|authentication|permission|quota|throttl/i.test(`${code || ''} ${message || ''}`);
      if (action === 'reject' && (response.status !== 403 || modelResponse || !safetySignature)) {
        throw new Error('Expected native safety signature not observed; stopped without further requests.');
      }
      if (action === 'allow' && !modelResponse) throw new Error('Allowed request failed; stopped without retries.');
    }
    const rejected = attempts.filter(item => object(item).action === 'reject');
    const first = object(object(rejected[0]).rejectionSignature);
    if (!rejected.every(item => JSON.stringify(object(item).rejectionSignature) === JSON.stringify(first))) {
      throw new Error('Native rejection signatures differ across models; no uniform enforcement claim.');
    }
    evidence.proof = { attributable: true, allowedVerified: true,
      explanation: 'Actual native API-level llm-content-safety blocklist rejected the harmless marker for all four published model aliases; clean Luna request received a real response. Prompt inspection only; no caller-isolation or output-safety proof.',
      rejectionSignature: first };
    evidence.coverage = apimAliases.map(assetName => ({ assetName, resourceId: `${apimApi}/policies/policy`,
      assetType: 'model', policyConfigured: true, rejectionVerified: true }));
    save(evidence, apimArtifact);
  }
}
