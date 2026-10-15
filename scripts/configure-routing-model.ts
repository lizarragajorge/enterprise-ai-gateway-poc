// Run: node scripts/configure-routing-model.ts
// Provisions only the second deployment, publishes it without modifying existing policies,
// verifies a real gateway response, then updates only MODEL_2_* in local .env.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = config.resourceGroup;
const accountName = config.modelAccountName;
const gatewayName = config.gatewayName;
const name = 'demo-chat-secondary';
const physicalModel = 'gpt-4.1-mini';
const version = '2025-04-14';
const prefix = `/subscriptions/${subscription}/resourceGroups/${group}`;
const account = `${prefix}/providers/Microsoft.CognitiveServices/accounts/${accountName}`;
const gateway = `${prefix}/providers/Microsoft.ApiManagement/aigateways/${gatewayName}`;
const provider = `${gateway}/workspaces/default/modelProviders/azure-models`;
const model = `${provider}/models/${name}`;
const deploymentId = `${account}/deployments/${name}`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Azure API object.');
  return value as Record<string, unknown>;
}
function az(args: string[]): unknown {
  try {
    return JSON.parse(execFileSync('az', [...args, '--subscription', subscription, '--output', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024
    }));
  } catch (error) {
    // Extract only error-code identifiers, never raw CLI output or credential-bearing values.
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    const code = stderr.match(/(?:ERROR:\s*\(|"code"\s*:\s*")([A-Za-z][A-Za-z0-9_.-]{0,100})/)?.[1];
    throw new Error(`Azure ${args.slice(0, 2).join(' ')} failed${code ? ` (${code})` : ''}; no CLI payload logged.`);
  }
}
function rest(method: string, path: string, body?: unknown): unknown {
  return az(['rest', '--method', method, '--url', `https://management.azure.com${path}?api-version=2026-05-01`,
    ...(body === undefined ? [] : ['--body', JSON.stringify(body)])]);
}
function list(path: string): Record<string, unknown>[] {
  const values = record(rest('get', path)).value;
  if (!Array.isArray(values)) throw new Error('Unexpected Azure resource collection.');
  return values.map(record);
}
function properties(value: unknown): Record<string, unknown> {
  return record(record(value).properties);
}
function checkDeployment(value: unknown): void {
  const item = record(value);
  const props = properties(item);
  const physical = record(props.model);
  const sku = record(item.sku);
  if (physical.name !== physicalModel || physical.version !== version || physical.format !== 'OpenAI'
    || sku.name !== 'GlobalStandard' || sku.capacity !== 1) {
    throw new Error('Second deployment name collision: physical model/version/SKU differs; refusing overwrite.');
  }
}
function checkModel(value: unknown): void {
  const props = properties(value);
  const target = record(props.deployment);
  if (target.resourceId !== deploymentId || target.modelName !== name || target.modelVersion !== version
    || !Array.isArray(props.supportedEndpoints) || !props.supportedEndpoints.includes('/openai/v1/chat/completions')) {
    throw new Error('Second gateway model collision: target or endpoint differs; refusing overwrite.');
  }
}
function checkAlias(value: unknown): void {
  const props = properties(value);
  const targets = props.backendModels;
  if (props.aliasName !== name || !Array.isArray(targets) || targets.length !== 1 || record(targets[0]).resourceId !== model) {
    throw new Error('Second alias collision: target differs; refusing overwrite.');
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--verify')) {
    process.loadEnvFile('.env');
    const { callGateway, loadConfig } = await import('../server/gateway.ts');
    const config = loadConfig({ ...process.env, MODEL_2_NAME: name, MODEL_2_CLOUD: 'azure', MODEL_2_FORMAT: 'openai-chat' });
    const result = await callGateway(config, { app: 'A', modelId: 'model-2', prompt: 'Reply with the word ready.' });
    console.log(JSON.stringify({
      status: result.status, model: result.returnedModel ?? result.model,
      latencyMs: result.latencyMs, tokens: result.tokens
    }));
    if (result.status !== 200 || !result.modelResponse || result.returnedModel !== `${physicalModel}-${version}`) {
      throw new Error('Second-model real gateway verification failed; MODEL_2 configuration was not written.');
    }
    return;
  }

  process.loadEnvFile('.env');
  if (process.env.MODEL_2_NAME && process.env.MODEL_2_NAME !== name) {
    throw new Error('MODEL_2_NAME already selects a different target; refusing overwrite.');
  }
  const tags = record(record(az(['group', 'show', '--name', group])).tags);
  if (tags.purpose !== 'enterprise-ai-gateway-demo') throw new Error('Refusing to modify a non-PoC resource group.');
  const gatewayProps = properties(rest('get', gateway));
  if (gatewayProps.provisioningState !== 'Succeeded') throw new Error('Gateway is not provisioned.');
  const foundry = record(properties(rest('get', provider)).foundry);
  if (!Array.isArray(foundry.resourceIds) || !foundry.resourceIds.includes(account)
    || record(foundry.authentication).kind !== 'ManagedIdentity') {
    throw new Error('Existing provider does not authorize this account through managed identity.');
  }

  const existingDeployment = listCognitiveDeployments().find(item => item.name === name);
  const existingModel = list(`${provider}/models`).find(item => item.name === name);
  const existingAlias = list(`${gateway}/workspaces/default/aliases`).find(item => item.name === name);
  if (existingDeployment) checkDeployment(existingDeployment);
  if (existingModel) checkModel(existingModel);
  if (existingAlias) checkAlias(existingAlias);

  if (!existingDeployment) {
    az(['deployment', 'group', 'create', '--resource-group', group, '--name', 'demo-routing-model-secondary',
      '--mode', 'Incremental', '--template-file', fileURLToPath(new URL('../infra/routing-model.bicep', import.meta.url)),
      '--parameters', `accountName=${accountName}`]);
  }
  const provisioned = az(['cognitiveservices', 'account', 'deployment', 'show', '--resource-group', group,
    '--name', accountName, '--deployment-name', name]);
  checkDeployment(provisioned);
  if (properties(provisioned).provisioningState !== 'Succeeded') throw new Error('Second deployment has not succeeded.');
  if (!existingModel) rest('put', model, { properties: {
    displayName: name, apiFormat: 'OpenAIChatCompletions',
    supportedEndpoints: ['/openai/v1/chat/completions'],
    deployment: { resourceId: deploymentId, modelName: name, modelVersion: version }
  } });
  if (!existingAlias) rest('put', `${gateway}/workspaces/default/aliases/${name}`, { properties: {
    aliasName: name, description: 'Distinct second physical chat model for latency-aware routing comparison.',
    backendModels: [{ resourceId: model }]
  } });
  checkModel(rest('get', model));
  checkAlias(rest('get', `${gateway}/workspaces/default/aliases/${name}`));
  console.log(JSON.stringify({ provisioningState: 'Succeeded', publishedName: name, physicalModel, version, sku: 'GlobalStandard', capacity: 1 }));

  // Start a fresh Node process after loading .env so NODE_EXTRA_CA_CERTS is honored.
  try {
    const output = execFileSync(process.execPath, ['--use-system-ca', fileURLToPath(import.meta.url), '--verify'], {
      env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log(output.trim());
  } catch {
    throw new Error('Real gateway verification failed; no secrets logged and MODEL_2 configuration was not written.');
  }

  // Read again after provisioning to preserve unrelated concurrent configuration updates.
  let env = readFileSync('.env', 'utf8');
  for (const [key, value] of Object.entries({ MODEL_2_NAME: name, MODEL_2_CLOUD: 'azure', MODEL_2_FORMAT: 'openai-chat' })) {
    const pattern = new RegExp(`^${key}=.*$`, 'gm');
    const line = `${key}=${value}`;
    env = pattern.test(env) ? env.replace(pattern, () => line) : `${env}${env.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('Updated only MODEL_2_NAME/CLOUD/FORMAT in local .env.');
}
function listCognitiveDeployments(): Record<string, unknown>[] {
  const values = az(['cognitiveservices', 'account', 'deployment', 'list', '--resource-group', group, '--name', accountName]);
  if (!Array.isArray(values)) throw new Error('Unexpected cognitive deployment collection.');
  return values.map(record);
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Second model configuration failed.');
  process.exitCode = 1;
});
