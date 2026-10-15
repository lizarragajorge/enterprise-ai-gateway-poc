import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseMonitoringEvidence, readMonitoringEvidence } from './monitoring-evidence.ts';

const configuration = {
  source: 'azure-control-plane', capturedAt: '2026-10-13T00:00:00Z',
  insightsResourceId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Insights/components/demo',
  exporterName: 'default', payloadCapture: false, metric: 'azure.ai_gateway.client.token.usage'
};
test('trace query links use the configured Log Analytics workspace and metadata-only KQL', () => {
  const logsWorkspaceResourceId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.OperationalInsights/workspaces/logs';
  const result = parseMonitoringEvidence({ ...configuration, logsWorkspaceResourceId, logsQueryUrl: 'https://untrusted.invalid' });
  const url = new URL(result.logsQueryUrl!);
  assert.equal(url.origin, 'https://portal.azure.com');
  assert.ok(url.hash.includes(`/resourceId/${encodeURIComponent(logsWorkspaceResourceId)}/`));
  const encodedQuery = url.hash.split('/q/')[1].split('/timespan/')[0];
  const query = gunzipSync(Buffer.from(decodeURIComponent(encodedQuery), 'base64')).toString('utf8');
  assert.match(query, /OTelSpans/);
  assert.match(query, /Workspace == "default"/);
  assert.match(query, /join kind=inner gatewayTraces on TraceId/);
  assert.match(query, /take 100/);
  assert.doesNotMatch(query, /Body|project \*|prompt|completion/i);
  assert.ok(!result.logsQueryUrl!.includes('untrusted.invalid'));
  assert.equal(parseMonitoringEvidence(configuration).logsQueryUrl, undefined);
  for (const invalid of ['https://untrusted.invalid', configuration.insightsResourceId, '', null]) {
    assert.throws(() => parseMonitoringEvidence({ ...configuration, logsWorkspaceResourceId: invalid }), /Log Analytics/);
  }
});
test('native configuration is not ingestion proof and credentials are never exposed', () => {
  const result = parseMonitoringEvidence({ ...configuration, credentials: 'must-not-escape', endpoint: 'https://secret.invalid' });
  assert.equal(result.metrics, undefined);
  assert.ok(!JSON.stringify(result).includes('must-not-escape'));
  assert.ok(!JSON.stringify(result).includes('secret.invalid'));
});
test('native metric snapshot preserves observed zero subcategories and allows only public fields', () => {
  const result = parseMonitoringEvidence({ ...configuration, metrics: {
    source: 'azure-monitor-promql', queriedAt: configuration.capturedAt,
    samples: [
      { model: 'demo', tokenType: 'prompt_tokens', value: 12, credential: 'hidden' },
      { model: 'demo', tokenType: 'completion_tokens_details.reasoning_tokens', value: 0 }
    ]
  } });
  assert.equal(result.metrics?.samples[1].value, 0);
  assert.ok(!JSON.stringify(result).includes('hidden'));
});
test('unsafe destinations, payload capture and malformed metric claims fail explicitly', () => {
  for (const invalid of [
    { ...configuration, insightsResourceId: 'https://untrusted.invalid' },
    { ...configuration, payloadCapture: true },
    { ...configuration, metric: 'invented' },
    { ...configuration, capturedAt: 'invalid' },
    { ...configuration, metrics: { source: 'local-timing', queriedAt: configuration.capturedAt, samples: [] } },
    ...[[], [{ model: 'demo', tokenType: 'prompt_tokens', value: 0 }],
      [{ model: 'demo', tokenType: 'prompt_tokens', value: -1 }],
      [{ model: 'demo', tokenType: 'prompt_tokens', value: Number.NaN }],
      [{ model: 'demo', tokenType: 'prompt_tokens', value: '12' }]].map(samples => ({
      ...configuration, metrics: { source: 'azure-monitor-promql', queriedAt: configuration.capturedAt, samples }
    }))
  ]) assert.throws(() => parseMonitoringEvidence(invalid));
});
test('missing monitoring evidence stays absent; corruption and oversized files fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-monitoring-'));
  const path = join(directory, 'snapshot.json');
  try {
    assert.equal(readMonitoringEvidence(path), undefined);
    writeFileSync(path, JSON.stringify(configuration));
    assert.equal(readMonitoringEvidence(path)?.metrics, undefined);
    writeFileSync(path, '{');
    assert.throws(() => readMonitoringEvidence(path));
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    assert.throws(() => readMonitoringEvidence(path), /exceeds/);
  } finally { rmSync(directory, { recursive: true }); }
});
test('management audit is a bounded separate source, strips actor claims and rejects out-of-scope resources', () => {
  const gatewayResourceId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.ApiManagement/aigateways/fixture';
  const activity = { source: 'azure-activity-log', queriedAt: configuration.capturedAt, windowStart: configuration.capturedAt,
    gatewayResourceId, scanned: 100, scanLimit: 100, events: [{ at: configuration.capturedAt,
      operation: 'Microsoft.ApiManagement/aigateways/workspaces/aliases/write', status: 'Succeeded',
      correlationId: '00000000-0000-0000-0000-000000000000', resourceId: `${gatewayResourceId}/workspaces/default/aliases/fixture`,
      actorRecorded: true, caller: 'actor-canary', claims: 'private-claims-canary' }] };
  const parsed = parseMonitoringEvidence({ ...configuration, activity });
  assert.equal(parsed.activity?.events.length, 1);
  assert.equal(parsed.activity?.events[0].actorRecorded, true);
  assert.ok(!JSON.stringify(parsed).includes('canary'));
  for (const invalid of [
    { ...activity, events: Array(21).fill(activity.events[0]) },
    { ...activity, scanned: 101 },
    { ...activity, events: [{ ...activity.events[0], resourceId: `${gatewayResourceId}-other` }] }
  ]) assert.throws(() => parseMonitoringEvidence({ ...configuration, activity: invalid }));
});
