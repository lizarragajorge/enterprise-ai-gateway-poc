import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { databricksText } from '../server/databricks-response.ts';
import { inventory } from '../server/databricks-inventory.ts';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = config.resourceGroup;
const gatewayName = config.gatewayName;
const gateway = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.ApiManagement/aigateways/${gatewayName}`;
const workspace = `/subscriptions/${subscription}/resourceGroups/${config.databricksResourceGroup}/providers/Microsoft.Databricks/workspaces/${config.databricksWorkspaceName}`;
const provider = `${gateway}/workspaces/default/modelProviders/databricks-models`;
const modelResource = `${provider}/models/gpt-oss-20b`;
const publishedName = 'demo-databricks-gpt-oss-20b';
const alias = `${gateway}/workspaces/default/aliases/${publishedName}`;
const backendModel = 'databricks-gpt-oss-20b';
const backendAudience = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d';
const description = 'enterprise-ai-gateway-demo: Databricks inference-only backend';
const principalName = 'enterprise-ai-gateway-databricks-backend-demo';
const applicationDescription = 'enterprise-ai-gateway-demo: scoped Databricks backend identity';
const templateFile = fileURLToPath(new URL('../infra/databricks-gateway.bicep', import.meta.url));
const reportFile = '.local/databricks-gateway.json';
const authFile = '.local/databricks-gateway-auth.json';
const secrets: string[] = [];
const args = process.argv.slice(2);
if (args.some(arg => !['--plan', '--apply', '--verify', '--rotate'].includes(arg))
  || args.filter(arg => ['--plan', '--apply', '--verify'].includes(arg)).length > 1
  || (args.includes('--rotate') && !args.includes('--apply'))) {
  throw new Error('Usage: npm run configure:databricks -- [--plan | --apply [--rotate] | --verify]');
}
const action = args.includes('--apply') ? 'apply' : args.includes('--verify') ? 'verify' : 'plan';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected API object; stopped.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Required API field missing; stopped.');
  return value;
}
function redact(value: string): string {
  for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
  return value;
}
function az(parameters: string[]): unknown {
  try {
    return JSON.parse(execFileSync('az', [...parameters, ...(parameters.includes('--subscription') ? [] : ['--subscription', subscription]), '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 300000
    }));
  } catch {
    throw new Error(`Azure CLI ${parameters.slice(0, 2).join(' ')} failed; stopped without logging CLI payloads.`);
  }
}
function armGet(id: string, version = '2026-05-01'): Record<string, unknown> {
  return record(az(['rest', '--method', 'get', '--url', `https://management.azure.com${id}?api-version=${version}`]));
}
function armList(id: string): Record<string, unknown>[] {
  const result = armGet(id);
  if (!Array.isArray(result.value) || result.nextLink) throw new Error('Unexpected/paginated Azure inventory; stopped.');
  return result.value.map(record);
}
function save(path: string, value: unknown): void {
  mkdirSync('.local', { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
async function request(origin: string, path: string, token: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin), {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000)
  });
  const raw = redact(await response.text());
  if (raw.length > 1024 * 1024) throw new Error('API response exceeded the 1 MiB limit.');
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} failed: HTTP ${response.status}. ${raw.slice(0, 1000)}`);
  return raw.trim() ? record(JSON.parse(raw)) : {};
}
function listPrincipals(result: Record<string, unknown>): Record<string, unknown>[] {
  if (typeof result.totalResults !== 'number' || result.totalResults < 0
    || (result.Resources !== undefined && !Array.isArray(result.Resources))) throw new Error('Invalid SCIM collection.');
  const values = (result.Resources === undefined ? [] : result.Resources as unknown[]).map(record);
  if (values.length !== result.totalResults) throw new Error('Incomplete SCIM inventory; stopped.');
  return values;
}
function checkPrincipal(value: Record<string, unknown>, applicationId: string, expectedName = principalName): void {
  if (value.applicationId !== applicationId || value.displayName !== expectedName || value.active !== true
    || !Array.isArray(value.entitlements) || value.entitlements.length !== 1
    || record(value.entitlements[0]).value !== 'workspace-access'
    || (Array.isArray(value.roles) && value.roles.length > 0)
    || (Array.isArray(value.groups) && value.groups.some(item => record(item).display === 'admins'))) {
    throw new Error('Databricks service-principal ownership/entitlements differ; refusing to change privileges.');
  }
}
function checkResources(): boolean {
  const existingProvider = armList(`${gateway}/workspaces/default/modelProviders`).find(item => item.id === provider);
  const existingAlias = armList(`${gateway}/workspaces/default/aliases`).find(item => item.id === alias);
  if (existingProvider) {
    const props = record(existingProvider.properties);
    const custom = record(props.custom);
    if (props.kind !== 'Custom' || props.description !== description || custom.endpoint !== `${workspaceOrigin}/serving-endpoints`
      || record(custom.authentication).kind !== 'ApiKey'
      || record(record(custom.authentication).apiKey).headerName !== 'Authorization') {
      throw new Error('Databricks provider collision; refusing overwrite.');
    }
    const models = armList(`${provider}/models`);
    if (models.some(item => item.id !== modelResource)) throw new Error('Provider contains another model; refusing credential changes.');
    for (const item of models) {
      const props = record(item.properties);
      if (record(props.deployment).modelName !== backendModel || !Array.isArray(props.supportedEndpoints)
        || props.supportedEndpoints.length !== 1 || props.supportedEndpoints[0] !== `/${backendModel}/invocations`) {
        throw new Error('Databricks model collision; refusing overwrite.');
      }
    }
  }
  if (existingAlias) {
    const props = record(existingAlias.properties);
    if (props.aliasName !== publishedName || !Array.isArray(props.backendModels) || props.backendModels.length !== 1
      || record(props.backendModels[0]).resourceId !== modelResource) throw new Error('Databricks alias collision; refusing overwrite.');
  }
  return Boolean(existingProvider && existingAlias);
}
function preview(): void {
  const parameters = [
    '--subscription', subscription, '--resource-group', group, '--template-file', templateFile, '--parameters',
    `gatewayName=${gatewayName}`, `workspaceOrigin=${workspaceOrigin}`, `backendModelName=${backendModel}`,
    `publishedName=${publishedName}`, 'backendToken=VALIDATION_ONLY_NOT_A_CREDENTIAL'
  ];
  az(['deployment', 'group', 'validate', ...parameters]);
  const result = record(az(['deployment', 'group', 'what-if', ...parameters, '--no-pretty-print']));
  if (result.status !== 'Succeeded' || !Array.isArray(result.changes)) throw new Error('Gateway what-if did not succeed.');
  const changes = result.changes.map(record).filter(item => item.changeType !== 'Ignore' && item.changeType !== 'NoChange');
  if (changes.some(item => ![provider, modelResource, alias].includes(text(item.resourceId))
    || !['Create', 'Modify'].includes(text(item.changeType)))) throw new Error('What-if changed an unexpected resource; stopped.');
  console.log(JSON.stringify({ action: 'validated-plan', changes: changes.map(({ resourceId, changeType }) => ({ resourceId, changeType })),
    credential: 'Seven-day service-principal PAT; model-serving-inference scope; stored only in gateway',
    limitation: 'Workspace access is required; per-model/tool authorization is not demonstrated.',
    compute: 'No new clusters, SQL warehouses or dedicated serving' }));
}
async function verify(): Promise<Record<string, unknown>> {
  const runtimeKey = text(values.APP_A_KEY);
  const started = performance.now();
  const response = await fetch(new URL(`/default/models/${backendModel}/invocations`, gatewayOrigin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': runtimeKey },
    body: JSON.stringify({ model: publishedName, messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
      max_tokens: 256, stream: false }), redirect: 'error', signal: AbortSignal.timeout(60000)
  });
  const raw = redact(await response.text());
  if (!response.ok) throw new Error(`Real Databricks gateway call failed: HTTP ${response.status}. ${raw.slice(0, 1000)}`);
  if (raw.length > 1024 * 1024) throw new Error('Gateway response exceeded 1 MiB.');
  const result = record(JSON.parse(raw));
  const choice = Array.isArray(result.choices) ? record(result.choices[0]) : {};
  const output = databricksText(record(choice.message).content);
  const usage = record(result.usage);
  if (result.model !== 'gpt-oss-20b-080525' || output.trim() !== 'READY'
    || ['prompt_tokens', 'completion_tokens', 'total_tokens'].some(key => !Number.isInteger(usage[key]) || Number(usage[key]) < 0)) {
    throw new Error('Gateway returned unexpected Databricks model/text/usage; no proof claimed.');
  }
  const proof = {
    capturedAt: new Date().toISOString(), source: 'real-gateway-call', callPath: 'local verification script -> APIM AI Gateway -> Databricks',
    gatewayOrigin, workspaceOrigin, providerResourceId: provider, publishedName, returnedModel: result.model,
    gatewayPath: `/default/models/${backendModel}/invocations`,
    status: response.status, response: output, latencyMs: Math.round(performance.now() - started),
    tokens: { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens },
    timingScope: 'Local end-to-end timing; not native gateway telemetry', apimIntegrationVerified: true
  };
  console.log(JSON.stringify(proof));
  return proof;
}
function enableModel(): void {
  let contents = readFileSync('.env', 'utf8');
  const current = parseEnv(contents);
  for (const [key, value] of Object.entries(fields)) {
    if (current[key] && current[key] !== value) throw new Error(`${key} changed during configuration; refusing overwrite.`);
  }
  if (current.MODEL_4_REASONING_EFFORT) throw new Error('Slot 4 reasoning setting changed; refusing overwrite.');
  for (const [key, value] of Object.entries(fields)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    contents = pattern.test(contents) ? contents.replace(pattern, () => `${key}=${value}`)
      : `${contents}${contents.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  }
  writeFileSync('.env.tmp', contents, { mode: 0o600 });
  renameSync('.env.tmp', '.env');
}

const values = parseEnv(readFileSync('.env', 'utf8'));
for (const key of ['APP_A_KEY', 'APP_B_KEY']) if (values[key]) secrets.push(values[key]);
const fields = { MODEL_4_NAME: publishedName, MODEL_4_CLOUD: 'azure', MODEL_4_FORMAT: 'openai-chat', MODEL_4_PROVIDER: 'databricks' };
for (const [key, value] of Object.entries(fields)) {
  if (values[key] && values[key] !== value) throw new Error(`${key} differs; refusing to overwrite model slot 4.`);
}
if (values.MODEL_4_REASONING_EFFORT) throw new Error('Databricks slot 4 must not inherit another model reasoning setting.');
const groupResource = record(az(['group', 'show', '--name', group, '--subscription', subscription]));
const workspaceResource = armGet(workspace, '2026-01-01');
const gatewayResource = armGet(gateway);
const workspaceProperties = record(workspaceResource.properties);
const gatewayProperties = record(gatewayResource.properties);
if (record(groupResource.tags).purpose !== 'enterprise-ai-gateway-demo'
  || record(workspaceResource.tags).purpose !== 'enterprise-ai-gateway-demo'
  || workspaceProperties.computeMode !== 'Serverless' || record(workspaceResource.sku).name !== 'premium'
  || workspaceProperties.provisioningState !== 'Succeeded' || gatewayProperties.provisioningState !== 'Succeeded') {
  throw new Error('Owned gateway and Premium Serverless workspace must be ready.');
}
const hostname = text(workspaceProperties.workspaceUrl);
if (!/^adb-\d+\.\d+\.azuredatabricks\.net$/.test(hostname)) throw new Error('Unexpected workspace hostname.');
const workspaceOrigin = `https://${hostname}`;
const gatewayOrigin = `https://${text(record(gatewayProperties.frontend).defaultHostname)}`;
if (values.GATEWAY_ORIGIN !== gatewayOrigin) throw new Error('Local runtime origin differs from the owned gateway.');
const applications = az(['ad', 'app', 'list', '--display-name', principalName]);
if (!Array.isArray(applications)) throw new Error('Invalid Entra application inventory.');
const matches = applications.map(record).filter(item => item.displayName === principalName);
if (matches.length > 1 || (matches[0] && matches[0].description !== applicationDescription)) {
  throw new Error('Entra application collision; refusing to modify another identity.');
}
let application = matches[0];
let applicationId = application ? text(application.appId) : undefined;
const adminToken = text(record(az(['account', 'get-access-token', '--subscription', subscription,
  '--resource', backendAudience])).accessToken);
secrets.push(adminToken);
const principalPath = `/api/2.0/preview/scim/v2/ServicePrincipals`;
const filter = applicationId ? `applicationId eq "${applicationId}"` : `displayName eq "${principalName}"`;
const principals = listPrincipals(await request(workspaceOrigin, `${principalPath}?filter=${encodeURIComponent(filter)}`, adminToken));
if (principals.length > 1) throw new Error('Multiple workspace principals match the gateway identity.');
let principal = principals[0];
if (principal) {
  if (!applicationId) throw new Error('Workspace principal exists without the expected Entra application; stopped.');
  checkPrincipal(principal, applicationId);
}
const endpoints = await request(workspaceOrigin, '/api/2.0/serving-endpoints', adminToken);
if (!Array.isArray(endpoints.endpoints) || !endpoints.endpoints.map(record).some(item => item.name === backendModel
  && item.endpoint_type === 'FOUNDATION_MODEL_API' && record(item.state).ready === 'READY')) {
  throw new Error('GPT OSS 20B is not a ready pay-per-token endpoint.');
}
if (inventory(await request(workspaceOrigin, '/api/2.0/clusters/list', adminToken), 'clusters').length
  || inventory(await request(workspaceOrigin, '/api/2.0/sql/warehouses', adminToken), 'warehouses').length) {
  throw new Error('Unexpected compute exists; stopped rather than claiming model-access-only deployment.');
}
const configured = checkResources();
const oldAuth = existsSync(authFile) ? record(JSON.parse(readFileSync(authFile, 'utf8'))) : undefined;
if (oldAuth && (!applicationId || !principal || oldAuth.applicationId !== applicationId || oldAuth.principalId !== principal.id)) {
  throw new Error('Saved token ownership differs; refusing configuration or rotation.');
}
if (action === 'plan') {
  preview();
} else if (action === 'verify') {
  if (!configured) throw new Error('Databricks provider and alias are not configured.');
  await verify();
} else {
  if (configured && !args.includes('--rotate')) {
    if (!existsSync(authFile) || !applicationId || !principal) throw new Error('Credential ownership evidence missing; inspect before rotating.');
    const auth = record(JSON.parse(readFileSync(authFile, 'utf8')));
    if (auth.applicationId !== applicationId || auth.principalId !== principal.id) throw new Error('Credential ownership evidence differs.');
    save(reportFile, { ...await verify(), authentication: auth });
    enableModel();
    console.log('Existing gateway integration verified; slot 4 enabled without rotating keys.');
    process.exit(0);
  }
  preview();
  const graphToken = text(record(az(['account', 'get-access-token', '--subscription', subscription,
    '--resource', 'https://graph.microsoft.com/'])).accessToken);
  secrets.push(graphToken);
  if (!application) {
    application = await request('https://graph.microsoft.com', '/v1.0/applications', graphToken, 'POST', {
      displayName: principalName, signInAudience: 'AzureADMyOrg', description: applicationDescription
    });
    applicationId = text(application.appId);
  }
  if (!applicationId) throw new Error('Backend service-principal application ID is missing.');
  const entraPrincipals = await request('https://graph.microsoft.com',
    `/v1.0/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${applicationId}'`)}`, graphToken);
  if (!Array.isArray(entraPrincipals.value) || entraPrincipals['@odata.nextLink'] || entraPrincipals.value.length > 1) {
    throw new Error('Invalid Entra service-principal inventory.');
  }
  const entraPrincipal = entraPrincipals.value[0] ? record(entraPrincipals.value[0])
    : await request('https://graph.microsoft.com', '/v1.0/servicePrincipals', graphToken, 'POST', { appId: applicationId });
  save('.local/databricks-gateway-bootstrap.json', {
    applicationId, applicationObjectId: application.id, servicePrincipalObjectId: entraPrincipal.id
  });
  if (!principal) {
    principal = await request(workspaceOrigin, principalPath, adminToken, 'POST', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal'],
      applicationId, displayName: principalName, active: true, entitlements: [{ value: 'workspace-access' }]
    });
    checkPrincipal(principal, applicationId);
  }
  const permissionPath = '/api/2.0/permissions/authorization/tokens';
  function canUseTokens(permissions: Record<string, unknown>): boolean {
    if (!Array.isArray(permissions.access_control_list)) throw new Error('Invalid token permission inventory.');
    const own = permissions.access_control_list.map(record).find(item => item.service_principal_name === applicationId);
    return Boolean(own && Array.isArray(own.all_permissions)
      && own.all_permissions.map(record).some(item => item.permission_level === 'CAN_USE'));
  }
  if (!canUseTokens(await request(workspaceOrigin, permissionPath, adminToken))) {
    await request(workspaceOrigin, permissionPath, adminToken, 'PATCH', {
      access_control_list: [{ service_principal_name: applicationId, permission_level: 'CAN_USE' }]
    });
    if (!canUseTokens(await request(workspaceOrigin, permissionPath, adminToken))) {
      throw new Error('Dedicated principal token-use permission was not confirmed.');
    }
  }
  const tenant = text(record(az(['account', 'show', '--subscription', subscription])).tenantId);
  if (!/^[0-9a-f-]{36}$/i.test(tenant)) throw new Error('Unexpected Entra tenant identifier.');
  const applicationPath = `/v1.0/applications/${encodeURIComponent(text(application.id))}`;
  const bootstrapCredential = await request('https://graph.microsoft.com', `${applicationPath}/addPassword`, graphToken, 'POST', {
    passwordCredential: {
      displayName: 'Temporary Databricks PAT bootstrap',
      endDateTime: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    }
  });
  const clientSecret = text(bootstrapCredential.secretText);
  secrets.push(clientSecret);
  const credentialKeyId = text(bootstrapCredential.keyId);
  let principalToken: string | undefined;
  let createdTokenId: string | undefined;
  let verified = false;
  try {
    for (let attempt = 0; attempt < 24; attempt++) {
      const oauthResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: applicationId,
          client_secret: clientSecret, resource: backendAudience }),
        redirect: 'error', signal: AbortSignal.timeout(60000)
      });
      const oauthBody = record(await oauthResponse.json());
      if (oauthResponse.ok) {
        principalToken = text(oauthBody.access_token);
        break;
      }
      const propagating = Array.isArray(oauthBody.error_codes)
        && oauthBody.error_codes.some(code => code === 7000215 || code === 700016);
      if (!propagating || attempt === 23) {
        throw new Error(`Entra service-principal authentication failed: HTTP ${oauthResponse.status}, ${redact(JSON.stringify(oauthBody)).slice(0, 800)}`);
      }
      console.log(`New Entra bootstrap credential is still propagating; provisioning check ${attempt + 1}/24. No model request retried.`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!principalToken) throw new Error('Entra bootstrap credential never became ready.');
    secrets.push(principalToken);
    const credential = await request(workspaceOrigin, '/api/2.0/token/create', principalToken, 'POST', {
      lifetime_seconds: 7 * 24 * 60 * 60, comment: 'enterprise-ai-gateway-demo: seven-day inference-only backend',
      scopes: ['model-serving-inference'], autoscope_enabled: false
    });
    const backendToken = text(credential.token_value);
    secrets.push(backendToken);
    const tokenInfo = record(credential.token_info);
    createdTokenId = text(tokenInfo.token_id);
    const expiry = tokenInfo.expiry_time;
    if (typeof expiry !== 'number' || expiry <= Date.now() || expiry > Date.now() + 7 * 86400000 + 60000
      || !Array.isArray(tokenInfo.scopes) || tokenInfo.scopes.length !== 1 || tokenInfo.scopes[0] !== 'model-serving-inference') {
      throw new Error('Databricks did not confirm seven-day inference-only token scope; refusing to publish.');
    }
    const denied = await fetch(new URL('/api/2.0/sql/warehouses', workspaceOrigin), {
      headers: { Authorization: `Bearer ${backendToken}` }, redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    await denied.body?.cancel();
    if (denied.status !== 403) throw new Error(`Inference credential SQL exclusion not proven (HTTP ${denied.status}); stopped.`);
    const direct = await request(workspaceOrigin, `/serving-endpoints/${backendModel}/invocations`, backendToken, 'POST', {
      model: backendModel, messages: [{ role: 'user', content: 'Reply with the single word READY.' }], max_tokens: 128
    });
    const choices = direct.choices;
    if (direct.model !== 'gpt-oss-20b-080525' || !Array.isArray(choices)
      || databricksText(record(record(choices[0]).message).content).trim() !== 'READY') throw new Error('Service-principal inference failed verification.');
    const armToken = text(record(az(['account', 'get-access-token', '--subscription', subscription,
      '--resource', 'https://management.azure.com/'])).accessToken);
    secrets.push(armToken);
    const template = JSON.parse(execFileSync('az', ['bicep', 'build', '--file', templateFile, '--stdout'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
    }));
    const deploymentPath = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Resources/deployments/databricks-gateway-demo?api-version=2025-04-01`;
    let deployment = await request('https://management.azure.com', deploymentPath, armToken, 'PUT', {
      properties: { mode: 'Incremental', template, parameters: {
        gatewayName: { value: gatewayName }, workspaceOrigin: { value: workspaceOrigin },
        backendModelName: { value: backendModel }, publishedName: { value: publishedName }, backendToken: { value: backendToken }
      } }
    });
    const deadline = Date.now() + 300000;
    while (['Accepted', 'Running'].includes(text(record(deployment.properties).provisioningState)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      deployment = await request('https://management.azure.com', deploymentPath, armToken);
    }
    if (record(deployment.properties).provisioningState !== 'Succeeded') {
      throw new Error(`Scoped gateway deployment did not succeed: ${redact(JSON.stringify(record(deployment.properties).error ?? {}))}`);
    }
    if (!checkResources()) throw new Error('Deployment completed without the expected gateway resources.');
    const proof = await verify();
    verified = true;
    const auth = {
      applicationId, principalId: principal.id, kind: 'service-principal-PAT', tokenId: createdTokenId,
      expiresAt: new Date(expiry).toISOString(), scopes: tokenInfo.scopes, entitlements: ['workspace-access'],
      storedIn: 'gateway backend only', sqlApiExcluded: true,
      endpointAuthorization: 'Workspace-level Foundation Model API access; per-model/tool authorization not demonstrated'
    };
    save(authFile, auth);
    save(reportFile, { ...proof, authentication: auth });
    enableModel();
    if (oldAuth?.tokenId && oldAuth.tokenId !== createdTokenId) {
      await request(workspaceOrigin, '/api/2.0/token/delete', principalToken, 'POST', { token_id: text(oldAuth.tokenId) });
    }
    console.log(JSON.stringify({ status: 'gateway-verified', modelSlot: 4, credentialExpiresAt: auth.expiresAt,
      backendSecretPersistedLocally: false, additionalCompute: false }));
  } catch (error) {
    if (createdTokenId && principalToken && !verified) {
      try {
        await request(workspaceOrigin, '/api/2.0/token/delete', principalToken, 'POST', { token_id: createdTokenId });
      } catch (cleanupError) {
        throw new Error(`Integration failed and token revocation failed for token ID ${createdTokenId}. ${redact(String(error))}; ${redact(String(cleanupError))}`);
      }
    }
    throw new Error(redact(String(error)));
  } finally {
    await request('https://graph.microsoft.com', `${applicationPath}/removePassword`, graphToken, 'POST', { keyId: credentialKeyId });
    console.log('Removed the temporary Entra bootstrap secret; no OAuth client secret was stored locally.');
  }
}
