import { readFileSync } from 'node:fs';

export interface DeploymentConfig {
  subscriptionId: string;
  resourceGroup: string;
  gatewayName: string;
  modelAccountName: string;
  gatewayOrigin: string;
  comparisonResourceGroup: string;
  comparisonGatewayName: string;
  comparisonFoundryName: string;
  comparisonProjectName: string;
  comparisonGatewayOrigin: string;
  databricksResourceGroup: string;
  databricksWorkspaceName: string;
  databricksOrigin: string;
  monitoringInsightsName: string;
  monitoringWorkspaceName: string;
  contentSafetyAccountName: string;
  contentSafetyLocation: string;
}

const nameFields = [
  'resourceGroup', 'gatewayName', 'modelAccountName', 'comparisonResourceGroup',
  'comparisonGatewayName', 'comparisonFoundryName', 'comparisonProjectName',
  'databricksResourceGroup', 'databricksWorkspaceName', 'monitoringInsightsName',
  'monitoringWorkspaceName', 'contentSafetyAccountName', 'contentSafetyLocation'
] as const;
const originFields = ['gatewayOrigin', 'comparisonGatewayOrigin', 'databricksOrigin'] as const;
const fields = ['subscriptionId', ...nameFields, ...originFields];

export function parseDeploymentConfig(value: unknown): Readonly<DeploymentConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deployment configuration must be a JSON object.');
  }
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !fields.includes(key))) {
    throw new Error('Unknown deployment configuration field. Store credentials only in the existing local credential setup.');
  }
  for (const field of fields) {
    if (typeof config[field] !== 'string' || !config[field] || config[field] !== config[field].trim()
      || /[<>\r\n]|change[-_ ]?me|replace[-_ ]?me/i.test(config[field])) {
      throw new Error(`Set a non-placeholder deployment configuration field: ${field}.`);
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(config.subscriptionId))
    || config.subscriptionId === '00000000-0000-0000-0000-000000000000') {
    throw new Error('Set a valid deployment configuration field: subscriptionId.');
  }
  for (const field of nameFields) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,89}$/i.test(String(config[field]))) {
      throw new Error(`Invalid deployment configuration resource name: ${field}.`);
    }
  }
  if (!/^[a-z0-9]+$/.test(String(config.contentSafetyLocation))) {
    throw new Error('Invalid deployment configuration location: contentSafetyLocation.');
  }
  for (const field of originFields) {
    let origin: URL;
    try { origin = new URL(String(config[field])); }
    catch { throw new Error(`Invalid deployment configuration HTTPS origin: ${field}.`); }
    const host = origin.hostname;
    const expectedHost = field === 'gatewayOrigin'
      ? host.startsWith(`${String(config.gatewayName).toLowerCase()}.`) && host.endsWith('.ai.gateway.azure.com')
      : field === 'comparisonGatewayOrigin'
        ? host === `${String(config.comparisonGatewayName).toLowerCase()}.azure-api.net`
        : /^adb-[0-9]+\.[0-9]+\.azuredatabricks\.net$/.test(host);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
      || origin.pathname !== '/' || origin.search || origin.hash || !expectedHost) {
      throw new Error(`Invalid deployment configuration HTTPS origin or resource binding: ${field}.`);
    }
  }
  const result = Object.fromEntries(fields.map(field => [field, config[field]])) as unknown as DeploymentConfig;
  for (const field of originFields) result[field] = new URL(result[field]).origin;
  return Object.freeze(result);
}

export function loadDeploymentConfig(
  path: string | URL = new URL('../.local/deployment-config.json', import.meta.url)
): Readonly<DeploymentConfig> {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch {
    throw new Error('Cannot read deployment configuration. Copy scripts/deployment-config.example.json to .local/deployment-config.json and fill in owned resource bindings. Do not add credentials.');
  }
  return parseDeploymentConfig(value);
}
