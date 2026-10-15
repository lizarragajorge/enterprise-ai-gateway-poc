import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { parseMonitoringEvidence } from '../server/monitoring-evidence.ts';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = `/subscriptions/${subscription}/resourceGroups/${config.resourceGroup}`;
const gatewayId = `${group}/providers/Microsoft.ApiManagement/aigateways/${config.gatewayName}`;
const insightsId = `${group}/providers/Microsoft.Insights/components/${config.monitoringInsightsName}`;
const roleId = '3913510d-42f4-4e42-8a64-420c390055eb';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Azure resource.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected Azure resource value is missing.');
  return value;
}
function cli(args: string[]): unknown {
  return JSON.parse(execFileSync('az', [...args, ...(args.includes('--subscription') ? [] : ['--subscription', subscription]), '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
  }));
}
function rest(method: string, id: string, api: string, body?: unknown, etag?: string) {
  return record(cli(['rest', '--method', method, '--url', `https://management.azure.com${id}?api-version=${api}`,
    ...(body ? ['--body', JSON.stringify(body)] : []), ...(etag ? ['--headers', `If-Match=${etag}`] : [])]));
}
const gateway = rest('get', gatewayId, '2026-05-01');
const insights = rest('get', insightsId, '2020-02-02');
for (const resource of [gateway, insights]) {
  if (record(resource.tags).purpose !== 'enterprise-ai-gateway-demo') throw new Error('Resource ownership tag mismatch.');
}
if (record(gateway.properties).provisioningState !== 'Succeeded'
  || text(gateway.id).toLowerCase() !== gatewayId.toLowerCase()) {
  throw new Error('The new AI Gateway tier is not ready.');
}
const original = record(insights.properties);
if (text(original.WorkspaceResourceId).toLowerCase() !== `${group}/providers/Microsoft.OperationalInsights/workspaces/${config.monitoringWorkspaceName}`.toLowerCase()
  || original.DisableLocalAuth !== true) throw new Error('Unexpected Application Insights binding or authentication.');
if (original.AzureMonitorWorkspaceIngestionMode !== 'Enabled') {
  rest('patch', insightsId, '2020-02-02-preview', { properties: { AzureMonitorWorkspaceIngestionMode: 'Enabled' } });
}
const properties = record(rest('get', insightsId, '2020-02-02').properties);
const dcrId = text(properties.DataCollectionRuleResourceId);
const expectedManagedGroup = `/subscriptions/${subscription}/resourceGroups/ai_${config.monitoringInsightsName}_${text(properties.AppId)}_managed/`;
if (!dcrId.toLowerCase().startsWith(expectedManagedGroup.toLowerCase())
  || !dcrId.toLowerCase().endsWith(`/providers/microsoft.insights/datacollectionrules/managed-${config.monitoringInsightsName}-dcr`.toLowerCase())) {
  throw new Error('Unexpected OTLP collection rule. Wait for provisioning; do not substitute a destination.');
}
const dcr = rest('get', dcrId, '2024-03-11');
const immutableId = text(record(dcr.properties).immutableId);
const endpoints = Object.fromEntries([
  ['metricsEndpoint', 'OTLPMetricsEndpoint'], ['logsEndpoint', 'OTLPLogsEndpoint'], ['tracesEndpoint', 'OTLPTracesEndpoint']
].map(([key, property]) => {
  const endpoint = new URL(text(properties[property]));
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.monitor.azure.com')
    || !endpoint.pathname.includes(`/dataCollectionRules/${immutableId}/`)) throw new Error('Unexpected native OTLP endpoint.');
  return [key, endpoint.href];
}));
const principal = text(record(gateway.identity).principalId);
const assignments = cli(['role', 'assignment', 'list', '--assignee-object-id', principal, '--scope', dcrId, '--subscription', subscription]);
if (!Array.isArray(assignments)) throw new Error('Unexpected role assignment list.');
if (!assignments.some(item => text(record(item).roleDefinitionId).endsWith(`/${roleId}`)
  && text(record(item).scope).toLowerCase() === dcrId.toLowerCase())) {
  cli(['role', 'assignment', 'create', '--assignee-object-id', principal, '--assignee-principal-type', 'ServicePrincipal',
    '--scope', dcrId, '--role', roleId, '--subscription', subscription]);
}
const exporterId = `${gatewayId}/workspaces/default/telemetryExporters/default`;
const collection = rest('get', `${gatewayId}/workspaces/default/telemetryExporters`, '2026-05-01');
if (!Array.isArray(collection.value) || collection.nextLink) throw new Error('Unexpected exporter list.');
const existing = collection.value.map(record).find(item => item.name === 'default');
if (collection.value.length && !existing) throw new Error('Another exporter exists; refusing to add a conflicting destination.');
if (existing && text(record(record(existing.properties).applicationInsights).resourceId).toLowerCase() !== insightsId.toLowerCase()) {
  throw new Error('Existing exporter points to another resource; refusing overwrite.');
}
const body = { properties: {
  kind: 'OpenTelemetry', payloadCapture: false, applicationInsights: { resourceId: insightsId },
  openTelemetry: { ...endpoints, credentials: { managedIdentity: { resource: 'https://monitor.azure.com' } } }
} };
if (existing) {
  const current = record(existing.properties);
  const otlp = record(current.openTelemetry);
  const identity = record(record(otlp.credentials).managedIdentity);
  if (current.payloadCapture !== false || text(current.kind).toLowerCase() !== 'opentelemetry'
    || identity.resource !== 'https://monitor.azure.com' || identity.clientId
    || Object.entries(endpoints).some(([key, value]) => otlp[key] !== value)) {
    throw new Error('Existing exporter differs. Review it in the portal before replacing its configuration.');
  }
} else rest('put', exporterId, '2026-05-01', body);
const saved = record(rest('get', exporterId, '2026-05-01').properties);
if (saved.payloadCapture !== false || text(record(saved.applicationInsights).resourceId).toLowerCase() !== insightsId.toLowerCase()) {
  throw new Error('Native telemetry configuration verification failed.');
}
const evidence = parseMonitoringEvidence({
  source: 'azure-control-plane', capturedAt: new Date().toISOString(), insightsResourceId: insightsId,
  exporterName: 'default', payloadCapture: false, metric: 'azure.ai_gateway.client.token.usage'
});
mkdirSync('.local', { recursive: true });
writeFileSync('.local/gateway-monitoring.json.tmp', JSON.stringify(evidence, null, 2), { mode: 0o600 });
renameSync('.local/gateway-monitoring.json.tmp', '.local/gateway-monitoring.json');
console.log('Native OTLP exporter configured for the configured Application Insights resource. Gateway managed identity has DCR-scoped Metrics Publisher; payload capture is off. Configuration is not yet ingestion proof.');
