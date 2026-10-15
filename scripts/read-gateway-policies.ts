import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { parsePolicyEvidence } from '../server/policy-evidence.ts';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
const subscription = config.subscriptionId;
const resource = `/subscriptions/${subscription}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ApiManagement/aigateways/${config.gatewayName}`;
const query = 'value[].{name:name,policies:properties.policies[].{type:type,callsPerPeriod:callsPerPeriod,periodSeconds:periodSeconds,count:count,period:period,counterKey:counterKey,scope:scope}}';
const models: unknown = JSON.parse(execFileSync('az', [
  'rest', '--method', 'get', '--url', `https://management.azure.com${resource}/workspaces/default/aliases?api-version=2026-05-01`,
  '--subscription', subscription, '--query', query, '--output', 'json'
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }));
const evidence = parsePolicyEvidence({ source: 'azure-control-plane', capturedAt: new Date().toISOString(), models });
mkdirSync('.local', { recursive: true });
writeFileSync('.local/gateway-policies.json.tmp', JSON.stringify(evidence, null, 2), { mode: 0o600 });
renameSync('.local/gateway-policies.json.tmp', '.local/gateway-policies.json');
console.log(`Read-only Azure snapshot: ${evidence.models.length} published models, ${evidence.models.reduce((sum, model) => sum + model.policies.length, 0)} attached policies. Restart to load it. No Azure settings changed.`);
