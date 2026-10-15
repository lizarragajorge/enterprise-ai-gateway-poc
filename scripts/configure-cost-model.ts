// Run: node --use-system-ca scripts/configure-cost-model.ts
// Provision two current cost candidates without modifying existing deployments.
// Switch local slots only after both pinned model versions respond through APIM.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { modelPrices } from '../server/model-pricing.ts';
import type { ModelPrice } from '../server/model-pricing.ts';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = config.resourceGroup;
const accountName = config.modelAccountName;
const gatewayName = config.gatewayName;
const prefix = `/subscriptions/${subscription}/resourceGroups/${group}`;
const account = `${prefix}/providers/Microsoft.CognitiveServices/accounts/${accountName}`;
const gateway = `${prefix}/providers/Microsoft.ApiManagement/aigateways/${gatewayName}`;
const provider = `${gateway}/workspaces/default/modelProviders/azure-models`;
const template = fileURLToPath(new URL('../infra/current-cost-models.bicep', import.meta.url));
const candidates = modelPrices.map(price => ({
  price, slot: price.role === 'economy' ? 1 : 3,
  deploymentId: `${account}/deployments/${price.publishedName}`,
  model: `${provider}/models/${price.publishedName}`,
  alias: `${gateway}/workspaces/default/aliases/${price.publishedName}`
}));
type Candidate = typeof candidates[number];
const envValues: Record<string, string> = {};
for (const { price, slot } of candidates) {
  Object.assign(envValues, {
    [`MODEL_${slot}_NAME`]: price.publishedName, [`MODEL_${slot}_CLOUD`]: 'azure',
    [`MODEL_${slot}_FORMAT`]: 'openai-chat', [`MODEL_${slot}_REASONING_EFFORT`]: price.reasoningEffort
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Azure API object.');
  return value as Record<string, unknown>;
}
function az(args: string[]): unknown {
  try {
    return JSON.parse(execFileSync('az', [...args, '--subscription', subscription, '--output', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 300_000
    }));
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    const codes = [...stderr.matchAll(/(?:ERROR:\s*\(|["']code["']\s*:\s*["']|\bCode:\s*)([A-Za-z][A-Za-z0-9_.-]{0,100})/g)]
      .map(match => match[1]);
    const code = stderr.match(/\b(?:AuthorizationFailed|Forbidden|Unauthorized|DenyAssignmentAuthorizationFailed)\b/)?.[0]
      ?? codes[0]
      ?? (stderr.includes('content for this response was already consumed') ? 'AzureCliResponseAlreadyConsumed' : undefined)
      ?? (stderr.includes('unrecognized arguments') ? 'AzureCliInvalidArguments' : undefined)
      ?? (stderr.includes('Traceback (most recent call last)') ? 'AzureCliInternalError' : undefined);
    throw new Error(`Azure ${args.slice(0, 3).join(' ')} failed${code ? ` (${code})` : ''}; stopped without retries; no CLI payload logged.`);
  }
}
function rest(method: string, path: string, body?: unknown): unknown {
  return az(['rest', '--method', method, '--url', `https://management.azure.com${path}?api-version=2026-05-01`,
    ...(body === undefined ? [] : ['--body', JSON.stringify(body)])]);
}
function list(path: string): Record<string, unknown>[] {
  const result = record(rest('get', path));
  if (!Array.isArray(result.value) || result.nextLink) throw new Error('Unexpected or paginated Azure collection; refusing incomplete collision check.');
  return result.value.map(record);
}
function properties(value: unknown): Record<string, unknown> {
  return record(record(value).properties);
}
function checkDeployment(value: unknown, price: ModelPrice): void {
  const item = record(value);
  const props = properties(item);
  const physical = record(props.model);
  const sku = record(item.sku);
  if (physical.name !== price.modelName || physical.version !== price.modelVersion || physical.format !== 'OpenAI'
    || sku.name !== 'GlobalStandard' || sku.capacity !== 1 || props.versionUpgradeOption !== 'NoAutoUpgrade') {
    throw new Error(`${price.role} deployment collision: model/version/SKU/upgrade policy differs; refusing overwrite.`);
  }
}
function checkModel(value: unknown, candidate: Candidate): void {
  const props = properties(value);
  const target = record(props.deployment);
  if (target.resourceId !== candidate.deploymentId || target.modelName !== candidate.price.publishedName || target.modelVersion !== candidate.price.modelVersion
    || !Array.isArray(props.supportedEndpoints) || !props.supportedEndpoints.includes('/openai/v1/chat/completions')) {
    throw new Error('Premium gateway model collision: target or endpoint differs; refusing overwrite.');
  }
}
function checkAlias(value: unknown, candidate: Candidate): void {
  const props = properties(value);
  const targets = props.backendModels;
  if (props.aliasName !== candidate.price.publishedName || !Array.isArray(targets) || targets.length !== 1 || record(targets[0]).resourceId !== candidate.model) {
    throw new Error('Premium alias collision: target differs; refusing overwrite.');
  }
}
function checkEnv(text: string): void {
  const values = parseEnv(text);
  for (const [key, value] of Object.entries(envValues)) {
    const oldName = key === 'MODEL_1_NAME' ? 'demo-chat-mini' : key === 'MODEL_3_NAME' ? 'ai-cost-premium' : undefined;
    if (values[key] && values[key] !== value && values[key] !== oldName) {
      throw new Error(`${key} selects an unexpected target; refusing overwrite.`);
    }
  }
}
function listDeployments(): Record<string, unknown>[] {
  const values = az(['cognitiveservices', 'account', 'deployment', 'list', '--resource-group', group, '--name', accountName]);
  if (!Array.isArray(values)) throw new Error('Unexpected cognitive deployment collection.');
  return values.map(record);
}
async function verify(): Promise<void> {
  const { callGateway, loadConfig } = await import('../server/gateway.ts');
  const config = loadConfig({ ...process.env, ...envValues });
  for (const { price, slot } of candidates) {
    const result = await callGateway(config, { app: 'A', modelId: `model-${slot}`, prompt: 'Reply with the word ready.' },
      fetch, { maxCompletionTokens: 256 });
    console.log(JSON.stringify({
      status: result.status, model: result.returnedModel, latencyMs: result.latencyMs, tokens: result.tokens
    }));
    if (result.status !== 200 || !result.modelResponse || result.returnedModel !== price.reportedModel) {
      throw new Error(`${price.role} real gateway verification failed; local model configuration was not switched.`);
    }
  }
}
async function main(): Promise<void> {
  process.loadEnvFile('.env');
  if (process.argv.includes('--verify')) {
    await verify();
    return;
  }
  checkEnv(readFileSync('.env', 'utf8'));
  const tags = record(record(az(['group', 'show', '--name', group])).tags);
  if (tags.purpose !== 'enterprise-ai-gateway-demo') throw new Error('Refusing to modify a non-PoC resource group.');
  if (properties(rest('get', gateway)).provisioningState !== 'Succeeded') throw new Error('Gateway is not provisioned.');
  const foundry = record(properties(rest('get', provider)).foundry);
  if (!Array.isArray(foundry.resourceIds) || !foundry.resourceIds.includes(account)
    || record(foundry.authentication).kind !== 'ManagedIdentity') {
    throw new Error('Existing provider does not authorize this account through managed identity.');
  }
  const deployments = listDeployments();
  const models = list(`${provider}/models`);
  const aliases = list(`${gateway}/workspaces/default/aliases`);
  const missing: Candidate[] = [];
  for (const candidate of candidates) {
    const existingDeployment = deployments.find(item => item.name === candidate.price.publishedName);
    const existingModel = models.find(item => item.name === candidate.price.publishedName);
    const existingAlias = aliases.find(item => item.name === candidate.price.publishedName);
    if (existingDeployment) checkDeployment(existingDeployment, candidate.price);
    else missing.push(candidate);
    if (existingModel) checkModel(existingModel, candidate);
    if (existingAlias) checkAlias(existingAlias, candidate);
  }

  const compiled = record(az(['bicep', 'build', '--file', template, '--stdout']));
  const resources = compiled.resources;
  if (!Array.isArray(resources) || resources.length !== 1
    || record(resources[0]).type !== 'Microsoft.CognitiveServices/accounts/deployments') {
    throw new Error('Template must manage only the cognitive deployment loop.');
  }
  console.log('Bicep compilation passed; only missing current-model deployments will be managed.');
  const args = ['--resource-group', group, '--name', 'current-cost-models',
    '--mode', 'Incremental', '--template-file', template, '--parameters', `accountName=${accountName}`, `models=${JSON.stringify(missing.map(({ price }) => ({
      deploymentName: price.publishedName, modelName: price.modelName, modelVersion: price.modelVersion
    })))}`];
  az(['deployment', 'group', 'validate', ...args]);
  console.log('Azure deployment validation passed.');
  const preview = record(az(['deployment', 'group', 'what-if', ...args, '--no-pretty-print']));
  if (preview.status !== 'Succeeded' || !Array.isArray(preview.changes)) throw new Error('What-if did not succeed; deployment stopped.');
  for (const value of preview.changes) {
    const change = record(value);
    // Incremental what-if lists unrelated existing resources as Ignore; they are not modified.
    if (change.changeType === 'Ignore' || change.changeType === 'NoChange') continue;
    if (typeof change.resourceId !== 'string' || !missing.some(candidate => candidate.deploymentId.toLowerCase() === String(change.resourceId).toLowerCase())
      || change.changeType !== 'Create') {
      throw new Error('What-if proposes an unexpected resource/change; refusing deployment.');
    }
  }
  console.log(JSON.stringify({ whatIf: 'Succeeded', changes: preview.changes.map(value => {
    const change = record(value);
    return { resourceId: change.resourceId, changeType: change.changeType };
  }) }));
  if (process.argv.includes('--preview')) {
    console.log('Preview only; no deployments, gateway assets or local bindings changed.');
    return;
  }
  if (missing.length) az(['deployment', 'group', 'create', ...args, '--no-prompt', 'true']);
  for (const candidate of candidates) {
    const { price } = candidate;
    const provisioned = az(['cognitiveservices', 'account', 'deployment', 'show', '--resource-group', group,
      '--name', accountName, '--deployment-name', price.publishedName]);
    checkDeployment(provisioned, price);
    if (properties(provisioned).provisioningState !== 'Succeeded') throw new Error(`${price.role} deployment has not succeeded.`);
    if (!models.some(item => item.name === price.publishedName)) rest('put', candidate.model, { properties: {
      displayName: price.label, apiFormat: 'OpenAIChatCompletions', supportedEndpoints: ['/openai/v1/chat/completions'],
      deployment: { resourceId: candidate.deploymentId, modelName: price.publishedName, modelVersion: price.modelVersion }
    } });
    if (!aliases.some(item => item.name === price.publishedName)) rest('put', candidate.alias, { properties: {
      aliasName: price.publishedName, description: `${price.label} pay-per-token cost candidate, pinned ${price.modelVersion}.`,
      backendModels: [{ resourceId: candidate.model }]
    } });
    checkModel(rest('get', candidate.model), candidate);
    checkAlias(rest('get', candidate.alias), candidate);
    console.log(JSON.stringify({ provisioningState: 'Succeeded', publishedName: price.publishedName,
      physicalModel: price.modelName, version: price.modelVersion, sku: 'GlobalStandard', capacity: 1 }));
  }
  // A new process applies NODE_EXTRA_CA_CERTS loaded from .env before opening TLS connections.
  try {
    console.log(execFileSync(process.execPath, ['--use-system-ca', fileURLToPath(import.meta.url), '--verify'], {
      env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000
    }).trim());
  } catch (error) {
    const stdout = String((error as { stdout?: unknown }).stdout ?? '');
    for (const line of stdout.split('\n')) {
      try {
        const result = record(JSON.parse(line));
        if (typeof result.status === 'number' && typeof result.latencyMs === 'number') {
          console.log(JSON.stringify({ status: result.status, model: result.model, latencyMs: result.latencyMs, tokens: result.tokens }));
        }
      } catch { /* Ignore non-result output; never log credential-bearing errors. */ }
    }
    throw new Error('Real gateway verification failed; no secrets logged and local model configuration was not switched.');
  }
  let env = readFileSync('.env', 'utf8');
  checkEnv(env);
  for (const [key, value] of Object.entries(envValues)) {
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    const line = `${key}=${value}`;
    env = pattern.test(env) ? env.replace(pattern, () => line) : `${env}${env.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('Switched only MODEL_1/MODEL_3 settings after both real gateway verifications; MODEL_2 and credentials unchanged.');
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Current model configuration failed.');
  process.exitCode = 1;
});
