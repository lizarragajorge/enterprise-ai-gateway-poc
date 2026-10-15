import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export interface MonitoringEvidence {
  source: 'azure-control-plane';
  capturedAt: string;
  insightsResourceId: string;
  logsWorkspaceResourceId?: string;
  logsQueryUrl?: string;
  exporterName: string;
  payloadCapture: false;
  metric: 'azure.ai_gateway.client.token.usage';
  activity?: {
    source: 'azure-activity-log';
    queriedAt: string;
    windowStart: string;
    gatewayResourceId: string;
    scanned: number;
    scanLimit: number;
    events: { at: string; operation: string; status: string; correlationId: string; resourceId: string; actorRecorded: boolean }[];
  };
  metrics?: {
    source: 'azure-monitor-promql';
    queriedAt: string;
    samples: { model: string; tokenType: string; value: number }[];
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
export function parseMonitoringEvidence(value: unknown): MonitoringEvidence {
  if (!record(value) || value.source !== 'azure-control-plane' || !date(value.capturedAt)
    || typeof value.insightsResourceId !== 'string'
    || !/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[\w.-]+\/providers\/Microsoft\.Insights\/components\/[\w.-]+$/i.test(value.insightsResourceId)
    || typeof value.exporterName !== 'string' || !/^[\w.-]+$/.test(value.exporterName)
    || value.payloadCapture !== false || value.metric !== 'azure.ai_gateway.client.token.usage') {
    throw new Error('Invalid native gateway monitoring evidence.');
  }
  const result: MonitoringEvidence = {
    source: value.source, capturedAt: value.capturedAt, insightsResourceId: value.insightsResourceId,
    exporterName: value.exporterName, payloadCapture: false, metric: value.metric
  };
  if (value.logsWorkspaceResourceId !== undefined) {
    if (typeof value.logsWorkspaceResourceId !== 'string'
      || !/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[\w.-]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[\w.-]+$/i.test(value.logsWorkspaceResourceId)) {
      throw new Error('Invalid native Log Analytics workspace.');
    }
    const query = `let gatewayTraces = OTelSpans
| where TimeGenerated > ago(7d)
| where Kind =~ "Server"
| extend Workspace = coalesce(tostring(Attributes["azure.ai_gateway.workspace"]),
    extract(@"/([^/]+)/models/", 1, tostring(Attributes["http.route"])))
| where Workspace == "default"
| distinct TraceId;
OTelSpans
| where TimeGenerated > ago(7d)
| join kind=inner gatewayTraces on TraceId
| project TimeGenerated, TraceId, SpanId, ParentSpanId, Name, Kind, DurationMs, StatusCode
| order by TimeGenerated desc
| take 100`;
    result.logsWorkspaceResourceId = value.logsWorkspaceResourceId;
    result.logsQueryUrl = `https://portal.azure.com/#blade/Microsoft_Azure_Monitoring_Logs/LogsBlade/resourceId/${encodeURIComponent(value.logsWorkspaceResourceId)}/source/LogsBlade.AnalyticsShareLinkToQuery/q/${encodeURIComponent(gzipSync(query).toString('base64'))}/timespan/P7D`;
  }
  if (value.metrics !== undefined) {
    const metrics = value.metrics;
    if (!record(metrics) || metrics.source !== 'azure-monitor-promql' || !date(metrics.queriedAt)
      || !Array.isArray(metrics.samples) || !metrics.samples.length) throw new Error('Invalid native metric snapshot.');
    const samples = metrics.samples.map((sample: unknown) => {
      if (!record(sample) || typeof sample.model !== 'string' || !sample.model
        || typeof sample.tokenType !== 'string' || !sample.tokenType
        || typeof sample.value !== 'number' || !Number.isFinite(sample.value) || sample.value < 0) {
        throw new Error('Invalid native token metric sample.');
      }
      return { model: sample.model, tokenType: sample.tokenType, value: sample.value };
    });
    if (!samples.some(sample => sample.value > 0)) throw new Error('No positive native token metric observed.');
    result.metrics = { source: metrics.source, queriedAt: metrics.queriedAt, samples };
  }
  if (value.activity !== undefined) {
    const activity = value.activity;
    if (!record(activity) || activity.source !== 'azure-activity-log' || !date(activity.queriedAt) || !date(activity.windowStart)
      || typeof activity.gatewayResourceId !== 'string'
      || !/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[\w.-]+\/providers\/Microsoft\.ApiManagement\/(?:aigateways|service)\/[\w.-]+$/i.test(activity.gatewayResourceId)
      || activity.scanLimit !== 100 || !Number.isInteger(activity.scanned) || Number(activity.scanned) < 0 || Number(activity.scanned) > 100
      || !Array.isArray(activity.events) || activity.events.length > 20) throw new Error('Invalid management audit snapshot.');
    const scope = activity.gatewayResourceId.toLowerCase();
    const events = activity.events.map((event: unknown) => {
      if (!record(event) || !date(event.at) || typeof event.operation !== 'string' || !/^Microsoft\.(?:ApiManagement|Authorization)\/[\w/.-]+$/i.test(event.operation)
        || typeof event.status !== 'string' || !/^[\w ]{1,64}$/.test(event.status)
        || typeof event.correlationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(event.correlationId)
        || typeof event.resourceId !== 'string' || !(event.resourceId.toLowerCase() === scope || event.resourceId.toLowerCase().startsWith(`${scope}/`))
        || typeof event.actorRecorded !== 'boolean') throw new Error('Invalid management audit event.');
      return { at: event.at, operation: event.operation, status: event.status, correlationId: event.correlationId,
        resourceId: event.resourceId, actorRecorded: event.actorRecorded };
    });
    result.activity = { source: activity.source, queriedAt: activity.queriedAt, windowStart: activity.windowStart,
      gatewayResourceId: activity.gatewayResourceId, scanned: Number(activity.scanned), scanLimit: 100, events };
  }
  return result;
}
export function readMonitoringEvidence(path = '.local/gateway-monitoring.json'): MonitoringEvidence | undefined {
  try {
    if (statSync(path).size > 1024 * 1024) throw new Error('Monitoring snapshot exceeds 1 MiB.');
    return parseMonitoringEvidence(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
