import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { loadDeploymentConfig } from '../server/deployment-config.ts';

const config = loadDeploymentConfig();
if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.NODE_EXTRA_CA_CERTS) {
  const certificates = readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length) throw new Error('Configured public CA bundle contains no certificates.');
  setDefaultCACertificates([...getCACertificates('default'), ...certificates]);
}
const subscription = config.subscriptionId;
const group = config.resourceGroup;
const model = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.ApiManagement/aigateways/${config.gatewayName}/workspaces/default/aliases/demo-chat-mini`;
const url = `https://management.azure.com${model}?api-version=2026-05-01`;
const credentials: unknown = JSON.parse(execFileSync('az', ['account', 'get-access-token', '--subscription', subscription, '--resource', 'https://management.azure.com/', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
if (!credentials || typeof credentials !== 'object' || !('accessToken' in credentials) || typeof credentials.accessToken !== 'string') {
  throw new Error('Unable to acquire an ARM token from the existing Azure CLI login.');
}
const headers = { Authorization: `Bearer ${credentials.accessToken}` };
const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Read callable alias failed: HTTP ${response.status}.`);
const etag = response.headers.get('etag');
if (!etag) throw new Error('Alias did not return an ETag; refusing an unconditional policy update.');
const current: unknown = await response.json();
if (!current || typeof current !== 'object' || !('properties' in current) || !current.properties || typeof current.properties !== 'object') {
  throw new Error('Unexpected model management response.');
}
const properties = current.properties;
const existing = 'policies' in properties ? properties.policies : [];
if (!Array.isArray(existing)) throw new Error('Unexpected existing policies; refusing to overwrite.');
const retained = existing.filter(policy => {
  if (!policy || typeof policy !== 'object' || !('type' in policy)) throw new Error('Unrecognized policy; refusing to overwrite.');
  return policy.type !== 'requestRateLimit' && policy.type !== 'tokenLimit';
});
const policies = [...retained,
  { type: 'requestRateLimit', callsPerPeriod: 2, periodSeconds: 30, counterKey: ['Identity'], scope: 'resource' },
  { type: 'tokenLimit', count: 1000, period: 'minute', counterKey: ['Identity'], scope: 'resource' }
];
const update = await fetch(url, {
  method: 'PATCH', headers: { ...headers, 'If-Match': etag, 'Content-Type': 'application/json' },
  body: JSON.stringify({ properties: { policies } }), redirect: 'error', signal: AbortSignal.timeout(30000)
});
if (!update.ok) throw new Error(`Alias policy update failed: HTTP ${update.status}. ${await update.text()}`);
console.log('Configured callable alias caller-identity limits: 2 requests / 30 seconds and 1000 tokens / minute. Live acceptance is still required.');
