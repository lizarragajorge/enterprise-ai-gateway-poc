import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = config.resourceGroup;
const gatewayName = config.gatewayName;
const accountName = config.modelAccountName;
const modelName = 'demo-chat-mini';
function az(args: string[]): unknown {
  try {
    return JSON.parse(execFileSync('az', [...args, '--subscription', subscription, '--output', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024
    }));
  } catch (error) {
    // Never print CLI output: runtime key actions can return credentials.
    throw new Error(`Azure CLI operation failed (${args[0]}). Inspect resource state in Azure; no credentials were logged.`, { cause: error instanceof Error ? error.name : 'Unknown error' });
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Azure API object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Azure response missing ${field}.`);
  return value;
}
function rest(method: string, path: string, body?: unknown): unknown {
  return az(['rest', '--method', method, '--url', `https://management.azure.com${path}?api-version=2026-05-01`,
    ...(body === undefined ? [] : ['--body', JSON.stringify(body)])]);
}
function list(path: string): Record<string, unknown>[] {
  const value = record(rest('get', path)).value;
  if (!Array.isArray(value)) throw new Error('Unexpected Azure resource collection.');
  return value.map(record);
}
const prefix = `/subscriptions/${subscription}/resourceGroups/${group}`;
const resourceGroup = record(az(['group', 'show', '--name', group]));
if (record(resourceGroup.tags).purpose !== 'enterprise-ai-gateway-demo') throw new Error('Refusing to configure an untagged/non-PoC group.');
const gateway = `${prefix}/providers/Microsoft.ApiManagement/aigateways/${gatewayName}`;
const account = `${prefix}/providers/Microsoft.CognitiveServices/accounts/${accountName}`;
const runtime = record(rest('get', gateway));
const properties = record(runtime.properties);
if (properties.provisioningState !== 'Succeeded') throw new Error('Gateway is not provisioned.');
const hostname = text(record(properties.frontend).defaultHostname, 'runtime hostname');
const provider = `${gateway}/workspaces/default/modelProviders/azure-models`;
const providerProperties = {
  kind: 'Foundry', displayName: 'Enterprise AI demo backend',
  foundry: {
    endpoint: `https://${accountName}.openai.azure.com/`, resourceIds: [account],
    authentication: { kind: 'ManagedIdentity', managedIdentity: { resource: 'https://cognitiveservices.azure.com/' } }
  }
};
const providers = list(`${gateway}/workspaces/default/modelProviders`);
if (!providers.some(item => item.name === 'azure-models')) {
  rest('put', provider, { properties: providerProperties });
}
const model = `${provider}/models/${modelName}`;
if (!list(`${provider}/models`).some(item => item.name === modelName)) {
  rest('put', model, { properties: {
    displayName: modelName,
    apiFormat: 'OpenAIChatCompletions',
    supportedEndpoints: ['/openai/v1/chat/completions'],
    deployment: { resourceId: `${account}/deployments/${modelName}`, modelName, modelVersion: '2024-07-18' }
  } });
}
const alias = list(`${gateway}/workspaces/default/aliases`).find(item => item.name === modelName);
if (alias) {
  const backends = record(alias.properties).backendModels;
  if (!Array.isArray(backends) || backends.length !== 1 || record(backends[0]).resourceId !== model) {
    throw new Error('Existing alias targets a different backend; refusing to overwrite.');
  }
} else {
  rest('put', `${gateway}/workspaces/default/aliases/${modelName}`, { properties: {
    aliasName: modelName, description: 'Explicit single-model PoC selection; not intelligent routing.',
    backendModels: [{ resourceId: model }]
  } });
}
console.log('Published one Azure model using gateway managed identity; no live call claimed yet.');

function runtimeKey(name: string): string {
  // PUT uses the same stable key resource name; don't rotate keys on reruns.
  const keys = record(rest('get', `${gateway}/apiKeys`));
  if (!Array.isArray(keys.value)) throw new Error('Unexpected runtime key list.');
  if (!keys.value.some(item => record(item).name === name)) {
    rest('put', `${gateway}/apiKeys/${name}`, { properties: { displayName: name } });
  }
  const secrets = record(rest('post', `${gateway}/apiKeys/${name}/listSecrets`, {}));
  return text(secrets.primaryKey ?? record(secrets.properties ?? {}).primaryKey, 'primary runtime key');
}
const keyA = runtimeKey('demo-app-a');
const keyB = runtimeKey('demo-app-b');
const fields: Record<string, string> = {
  GATEWAY_ORIGIN: `https://${hostname}`,
  APP_A_KEY: keyA, APP_B_KEY: keyB,
  MODEL_1_NAME: modelName, MODEL_1_CLOUD: 'azure', MODEL_1_FORMAT: 'openai-chat'
};
let env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
for (const [key, value] of Object.entries(fields)) {
  if (/[\r\n]/.test(value)) throw new Error('Invalid multiline configuration value.');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  env = pattern.test(env) ? env.replace(pattern, () => line) : `${env}${env.endsWith('\n') || !env ? '' : '\n'}${line}\n`;
}
writeFileSync('.env', env, { mode: 0o600 });
console.log('Stored distinct A/B runtime keys in ignored local .env (not printed). Restart the local PoC.');
