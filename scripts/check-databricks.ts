import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { inventory } from '../server/databricks-inventory.ts';
import { databricksText } from '../server/databricks-response.ts';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const model = 'databricks-gpt-oss-20b';
const subscription = config.subscriptionId;
const workspaceId = `/subscriptions/${subscription}/resourceGroups/${config.databricksResourceGroup}/providers/Microsoft.Databricks/workspaces/${config.databricksWorkspaceName}`;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Databricks response.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected Databricks resource value is missing.');
  return value;
}
function azure(args: string[]): unknown {
  return JSON.parse(execFileSync('az', [...args, ...(args.includes('--subscription') ? [] : ['--subscription', subscription]), '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
  }));
}
const workspace = record(azure(['rest', '--method', 'get', '--url',
  `https://management.azure.com${workspaceId}?api-version=2026-01-01`]));
const properties = record(workspace.properties);
if (record(workspace.tags).purpose !== 'enterprise-ai-gateway-demo'
  || properties.provisioningState !== 'Succeeded' || properties.computeMode !== 'Serverless'
  || record(workspace.sku).name !== 'premium') throw new Error('The owned Premium serverless workspace is not ready.');
const hostname = text(properties.workspaceUrl);
if (!/^adb-\d+\.\d+\.azuredatabricks\.net$/.test(hostname)) throw new Error('Unexpected Databricks workspace hostname.');
const origin = `https://${hostname}`;
const token = text(record(azure(['account', 'get-access-token', '--resource', '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d',
  '--subscription', subscription])).accessToken);
async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin), {
    method: body ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000)
  });
  const raw = await response.text();
  if (raw.length > 1024 * 1024) throw new Error('Databricks response exceeded 1 MiB.');
  if (!response.ok) throw new Error(`Databricks ${path}: HTTP ${response.status}. ${raw.replaceAll(token, '[redacted]').slice(0,800)}`);
  return record(JSON.parse(raw));
}
if (process.argv.slice(2).some(arg => arg !== '--call')) throw new Error('Usage: npm run check:databricks -- [--call]');
const endpoints = await request('/api/2.0/serving-endpoints');
if (!Array.isArray(endpoints.endpoints)) throw new Error('Databricks did not return a serving endpoint inventory.');
const found = endpoints.endpoints.map(record).find(endpoint => endpoint.name === model);
if (!found || found.endpoint_type !== 'FOUNDATION_MODEL_API'
  || record(found.state).ready !== 'READY') {
  throw new Error(`${model} is not a ready pay-per-token Foundation Model API endpoint.`);
}
const warehouses = await request('/api/2.0/sql/warehouses');
const warehouseStates = inventory(warehouses, 'warehouses').map(item => {
  const warehouse = record(item);
  return { name: text(warehouse.name), state: text(warehouse.state) };
});
const clusters = inventory(await request('/api/2.0/clusters/list'), 'clusters').map(item => {
  const cluster = record(item);
  return { id: text(cluster.cluster_id), state: text(cluster.state) };
});
if (warehouseStates.length || clusters.length) {
  throw new Error('Unexpected compute exists. Inspect it before claiming a model-access-only workspace.');
}
const evidence: Record<string, unknown> = {
  capturedAt: new Date().toISOString(), workspaceId, workspaceUrl: origin, computeMode: properties.computeMode,
  model, endpointPresent: true, endpointType: found.endpoint_type,
  endpointReady: record(found.state).ready, sqlWarehouses: warehouseStates, clusters,
  apimIntegrationChecked: false, gatewayEvidenceFile: '.local/databricks-gateway.json', modelCallMade: false
};
if (process.argv.includes('--call')) {
  const start = performance.now();
  const result = await request(`/serving-endpoints/${model}/invocations`, {
    messages: [{ role: 'user', content: 'Reply with the single word READY.' }], max_tokens: 128
  });
  const choice = Array.isArray(result.choices) && result.choices.length ? record(result.choices[0]) : undefined;
  const output = databricksText(choice && record(choice.message).content);
  const usage = record(result.usage);
  const tokens = ['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => {
    const value = usage[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Invalid returned Databricks usage: ${key}`);
    return [key, value];
  });
  evidence.modelCallMade = true;
  evidence.response = output.replaceAll(token, '[redacted]');
  evidence.returnedModel = text(result.model);
  evidence.tokens = Object.fromEntries(tokens);
  evidence.latencyMs = Math.round(performance.now() - start);
  evidence.callPath = 'local verification script -> Databricks; not APIM';
}
mkdirSync('.local', { recursive: true });
writeFileSync('.local/databricks-demo.json.tmp', JSON.stringify(evidence, null, 2), { mode: 0o600 });
renameSync('.local/databricks-demo.json.tmp', '.local/databricks-demo.json');
console.log(JSON.stringify(evidence, null, 2));
