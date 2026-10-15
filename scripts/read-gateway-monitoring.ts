import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { parseMonitoringEvidence } from '../server/monitoring-evidence.ts';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const group = `/subscriptions/${subscription}/resourceGroups/${config.resourceGroup}`;
const insightsId = `${group}/providers/Microsoft.Insights/components/${config.monitoringInsightsName}`;
const exporterId = `${group}/providers/Microsoft.ApiManagement/aigateways/${config.gatewayName}/workspaces/default/telemetryExporters/default`;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Azure monitoring response.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected monitoring value is missing.');
  return value;
}
function get(url: string, resource?: string): Record<string, unknown> {
  return record(JSON.parse(execFileSync('az', ['rest', '--method', 'get', '--url', url,
    ...(resource ? ['--resource', resource] : []), '--subscription', subscription, '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
  })));
}
const exporter = record(get(`https://management.azure.com${exporterId}?api-version=2026-05-01`).properties);
if (exporter.payloadCapture !== false || text(record(exporter.applicationInsights).resourceId).toLowerCase() !== insightsId.toLowerCase()) {
  throw new Error('Unexpected gateway telemetry destination or payload capture setting.');
}
const properties = record(get(`https://management.azure.com${insightsId}?api-version=2020-02-02`).properties);
const workspaceId = text(properties.AzureMonitorWorkspaceResourceId);
if (!workspaceId.toLowerCase().startsWith(`/subscriptions/${subscription}/resourcegroups/ai_${config.monitoringInsightsName}_`.toLowerCase())
  || !workspaceId.toLowerCase().endsWith(`/providers/microsoft.monitor/accounts/managed-${config.monitoringInsightsName}-amw`.toLowerCase())) {
  throw new Error('Unexpected native metrics workspace.');
}
const workspace = get(`https://management.azure.com${workspaceId}?api-version=2023-04-03`);
const endpoint = new URL(text(record(record(workspace.properties).metrics).prometheusQueryEndpoint));
if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.prometheus.monitor.azure.com')) {
  throw new Error('Unexpected native metrics query endpoint.');
}
const metric = 'azure.ai_gateway.client.token.usage';
const query = new URL('/api/v1/query', endpoint);
query.searchParams.set('query', `{__name__="${metric}","microsoft.appresourceid"="${insightsId.toLowerCase()}","azure.ai_gateway.workspace"="default"}`);
const response = get(query.href, 'https://prometheus.monitor.azure.com');
const data = record(response.data);
if (response.status !== 'success' || data.resultType !== 'vector' || !Array.isArray(data.result)) {
  throw new Error('Native metric query did not succeed.');
}
const samples = data.result.map((item: unknown) => {
  const series = record(item), labels = record(series.metric);
  if (labels.__name__ !== metric || !Array.isArray(series.value) || series.value.length !== 2
    || typeof series.value[1] !== 'string' || !series.value[1].trim()) throw new Error('Unexpected native token series.');
  return { model: text(labels['gen_ai.request.model']), tokenType: text(labels['gen_ai.token.type']), value: Number(series.value[1]) };
});
const capturedAt = new Date().toISOString();
const gatewayResourceId = exporterId.split('/workspaces/')[0];
const windowStart = new Date(Date.now() - 7 * 86400000).toISOString();
const activities: unknown = JSON.parse(execFileSync('az', ['monitor', 'activity-log', 'list',
  '--subscription', subscription, '--resource-group', config.resourceGroup, '--start-time', windowStart, '--end-time', capturedAt,
  '--max-events', '100', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }));
if (!Array.isArray(activities)) throw new Error('Unexpected Azure Activity Log response.');
const management = activities.map(record).filter(event => typeof event.resourceId === 'string'
  && (event.resourceId.toLowerCase() === gatewayResourceId.toLowerCase()
    || event.resourceId.toLowerCase().startsWith(`${gatewayResourceId.toLowerCase()}/`)));
const evidence = parseMonitoringEvidence({
  source: 'azure-control-plane', capturedAt, insightsResourceId: insightsId,
  logsWorkspaceResourceId: text(properties.WorkspaceResourceId),
  exporterName: 'default', payloadCapture: false, metric,
  metrics: { source: 'azure-monitor-promql', queriedAt: capturedAt, samples },
  activity: { source: 'azure-activity-log', queriedAt: capturedAt, windowStart, gatewayResourceId,
    scanned: activities.length, scanLimit: 100, events: management.slice(0, 20).map(event => ({
      at: event.eventTimestamp, operation: record(event.operationName).value, status: record(event.status).value,
      correlationId: event.correlationId, resourceId: event.resourceId, actorRecorded: Boolean(event.caller)
    })) }
});
mkdirSync('.local', { recursive: true });
writeFileSync('.local/gateway-monitoring.json.tmp', JSON.stringify(evidence, null, 2), { mode: 0o600 });
renameSync('.local/gateway-monitoring.json.tmp', '.local/gateway-monitoring.json');
console.log(`Observed ${samples.length} native gateway token series and saved ${evidence.activity!.events.length} matching management audit events. Saved credential-free snapshot; reload evidence in the demo. No Azure settings changed or model calls made.`);
