import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = config.comparisonResourceGroup;
const base = `/subscriptions/${subscription}/resourceGroups/${group}/providers`;
const foundry = `${base}/Microsoft.CognitiveServices/accounts/${config.comparisonFoundryName}`.toLowerCase();
const gateway = `${base}/Microsoft.ApiManagement/service/${config.comparisonGatewayName}`.toLowerCase();
const project = `${foundry}/projects/${config.comparisonProjectName}`.toLowerCase();
const workspace = config.databricksOrigin;
const principalName = 'enterprise-ai-comparison-apim-managed-identity';
const connectionName = `ga-${createHash('sha256').update(gateway).digest('hex').slice(0, 30)}`;
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--plan', '--apply', '--verify'].includes(arg))) {
  throw new Error('Usage: node scripts/configure-comparison.ts [--plan | --apply | --verify]');
}
const apply = args.includes('--apply');
const verify = args.includes('--verify');

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected API object.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing required API field.');
  return value;
}
function az(parameters: string[]): unknown {
  try {
    return JSON.parse(execFileSync('az', [...parameters, ...(parameters.includes('--subscription') ? [] : ['--subscription', subscription]), '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
    }));
  } catch (error) {
    throw new Error(`Azure CLI ${parameters.slice(0, 2).join(' ')} failed; no credential payload was logged.`, { cause: error instanceof Error ? new Error(error.name) : undefined });
  }
}
function token(resource: string): string {
  return text(record(az(['account', 'get-access-token', '--subscription', subscription, '--resource', resource])).accessToken);
}
const armToken = token('https://management.azure.com/');
async function request(origin: string, path: string, credential: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin), {
    method, redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const raw = (await response.text()).replaceAll(credential, '[redacted]');
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}: ${raw.slice(0, 1500)}`);
  return raw.trim() ? record(JSON.parse(raw)) : {};
}
const arm = (path: string, method = 'GET', body?: unknown) => request('https://management.azure.com', path, armToken, method, body);
const service = await arm(`${gateway}?api-version=2024-05-01`);
const account = await arm(`${foundry}?api-version=2026-07-01`);
const projectResource = await arm(`${project}?api-version=2026-07-01`);
if (record(service.sku).name !== 'PremiumV2' || record(service.properties).provisioningState !== 'Succeeded'
  || record(account.properties).provisioningState !== 'Succeeded'
  || record(projectResource.properties).provisioningState !== 'Succeeded'
  || record(service.tags).purpose !== 'enterprise-ai-gateway-comparison'
  || record(account.tags).purpose !== 'enterprise-ai-gateway-comparison') {
  throw new Error('Comparison resource ownership, tier or readiness check failed.');
}
const principalId = text(record(service.identity).principalId);
const applicationId = text(record(az(['ad', 'sp', 'show', '--id', principalId])).appId);

const list = await arm(`${foundry}/connections?api-version=2025-06-01&category=GatewayAssociation`);
if (!Array.isArray(list.value) || list.nextLink) throw new Error('Unexpected or paginated association inventory.');
const associations = list.value.map(record).filter(item => record(item.properties).category === 'GatewayAssociation');
if (associations.length > 1 || associations.some(item => text(record(item.properties).target).toLowerCase() !== gateway)) {
  throw new Error('Foundry has another gateway association; refusing to overwrite it.');
}
if (!associations.length && apply) {
  await arm(`${foundry}/connections/${connectionName}?api-version=2025-06-01`, 'PUT', {
    properties: { category: 'GatewayAssociation', authType: 'None', target: gateway, metadata: { excludedProjectIds: '[]' } }
  });
}

const workspaceToken = token('2ff814a6-3304-4ab8-85cb-cd0e6f879c1d');
const scim = '/api/2.0/preview/scim/v2/ServicePrincipals';
const principals = await request(workspace, `${scim}?filter=${encodeURIComponent(`applicationId eq "${applicationId}"`)}`, workspaceToken);
const resources = principals.Resources === undefined ? [] : principals.Resources;
if (!Array.isArray(resources) || resources.length !== principals.totalResults || resources.length > 1) throw new Error('Unexpected SCIM principal inventory.');
let principal = resources.length ? record(resources[0]) : undefined;
if (!principal && apply) {
  principal = await request(workspace, scim, workspaceToken, 'POST', {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal'],
    applicationId, displayName: principalName, active: true, entitlements: [{ value: 'workspace-access' }]
  });
}
if (principal && (principal.applicationId !== applicationId || principal.displayName !== principalName || principal.active !== true
  || !Array.isArray(principal.entitlements) || principal.entitlements.length !== 1
  || record(principal.entitlements[0]).value !== 'workspace-access'
  || (Array.isArray(principal.roles) && principal.roles.length)
  || (Array.isArray(principal.groups) && principal.groups.some(item => record(item).display === 'admins')))) {
  throw new Error('Databricks principal privileges differ; refusing to alter it.');
}

const readback = await arm(`${foundry}/connections?api-version=2025-06-01&category=GatewayAssociation`);
if (!Array.isArray(readback.value) || readback.nextLink) throw new Error('Unexpected association readback.');
const match = readback.value.map(record).find(item => record(item.properties).category === 'GatewayAssociation' && text(record(item.properties).target).toLowerCase() === gateway);
const properties = match ? record(match.properties) : undefined;
const metadata = properties?.metadata ? record(properties.metadata) : {};
if (metadata.excludedProjectIds !== undefined && typeof metadata.excludedProjectIds !== 'string') throw new Error('Invalid project exclusion metadata.');
const exclusions: unknown = JSON.parse(metadata.excludedProjectIds === undefined ? '[]' : text(metadata.excludedProjectIds));
if (!Array.isArray(exclusions) || exclusions.some(item => typeof item !== 'string' || !item.toLowerCase().startsWith(`${foundry}/projects/`))) throw new Error('Invalid project exclusion metadata.');
const associated = properties?.authType === 'None' && !exclusions.some(item => item.toLowerCase() === project);
if ((apply || verify) && (!associated || !principal)) throw new Error('Native association or Databricks principal has not been configured.');
const report = {
  verifiedAt: new Date().toISOString(), gateway, foundry, project, foundryAssociated: associated,
  gatewayRegion: service.location, foundryRegion: account.location,
  databricksManagedIdentity: { applicationId, principalId, registered: Boolean(principal) },
  limitation: 'Association and workspace identity are configuration evidence, not agent/tool traffic or successful inference evidence.'
};
if (apply || verify) {
  mkdirSync('.local', { recursive: true });
  writeFileSync('.local/apim-v2-provisioning.json', JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
