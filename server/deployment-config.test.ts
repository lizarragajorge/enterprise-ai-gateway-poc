import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadDeploymentConfig, parseDeploymentConfig } from './deployment-config.ts';

const config = {
  subscriptionId: '11111111-2222-4333-8444-555555555555',
  resourceGroup: 'rg-test', gatewayName: 'test-gateway', modelAccountName: 'test-models',
  gatewayOrigin: 'https://test-gateway.test-region.ai.gateway.azure.com/',
  comparisonResourceGroup: 'rg-comparison', comparisonGatewayName: 'test-apim',
  comparisonFoundryName: 'test-foundry', comparisonProjectName: 'test-project',
  comparisonGatewayOrigin: 'https://test-apim.azure-api.net',
  databricksResourceGroup: 'rg-databricks', databricksWorkspaceName: 'test-workspace',
  databricksOrigin: 'https://adb-0000000000000000.0.azuredatabricks.net',
  monitoringInsightsName: 'test-insights', monitoringWorkspaceName: 'test-logs',
  contentSafetyAccountName: 'test-safety', contentSafetyLocation: 'eastus2'
};

test('validates explicit non-secret bindings and normalizes immutable origins', () => {
  const parsed = parseDeploymentConfig(config);
  assert.equal(parsed.gatewayOrigin, config.gatewayOrigin.slice(0, -1));
  assert.equal(parsed.subscriptionId, config.subscriptionId);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(config.gatewayOrigin.endsWith('/'), true);
});

test('rejects missing, unknown, malformed and placeholder configuration without echoing values', () => {
  for (const invalid of [null, [], {}, { ...config, subscriptionId: '00000000-0000-0000-0000-000000000000' },
    { ...config, subscriptionId: 'wrong' }, { ...config, resourceGroup: '../another-group' },
    { ...config, gatewayName: '<your-gateway>' }, { ...config, contentSafetyLocation: 'East US 2' },
    { ...config, contentSafetyAccountName: 'replace-me' }, { ...config, apiKey: 'sensitive-fixture' }]) {
    assert.throws(() => parseDeploymentConfig(invalid), error =>
      error instanceof Error && !error.message.includes('sensitive-fixture'));
  }
  for (const field of Object.keys(config)) {
    assert.throws(() => parseDeploymentConfig({ ...config, [field]: '' }));
    assert.throws(() => parseDeploymentConfig({ ...config, [field]: ` ${config[field as keyof typeof config]}` }));
  }
});

test('rejects endpoint substitution, credentials, paths, queries, fragments and ports', () => {
  for (const gatewayOrigin of [
    'http://test-gateway.test-region.ai.gateway.azure.com',
    'https://other.test-region.ai.gateway.azure.com',
    'https://test-gateway.test-region.ai.gateway.azure.com.evil.example',
    'https://user:password@test-gateway.test-region.ai.gateway.azure.com',
    'https://test-gateway.test-region.ai.gateway.azure.com:8443',
    `${config.gatewayOrigin}path`, `${config.gatewayOrigin}?key=value`, `${config.gatewayOrigin}#fragment`
  ]) assert.throws(() => parseDeploymentConfig({ ...config, gatewayOrigin }));
  assert.throws(() => parseDeploymentConfig({ ...config, comparisonGatewayOrigin: 'https://other.azure-api.net' }));
  assert.throws(() => parseDeploymentConfig({ ...config, databricksOrigin: 'https://other.example' }));
});

test('public example fails closed until an operator replaces its placeholders', () => {
  const example: unknown = JSON.parse(readFileSync(new URL('../scripts/deployment-config.example.json', import.meta.url), 'utf8'));
  assert.throws(() => parseDeploymentConfig(example));
});

test('missing or invalid config fails before any Azure operation and never includes file content', () => {
  assert.throws(() => loadDeploymentConfig(new URL('./nonexistent-deployment-config.json', import.meta.url)), /Copy scripts\/deployment-config.example.json/);
  assert.throws(() => loadDeploymentConfig(new URL('../package.json', import.meta.url)), /Unknown deployment configuration field/);
  assert.throws(() => loadDeploymentConfig(new URL('./deployment-config.ts', import.meta.url)), /Cannot read deployment configuration/);
});
