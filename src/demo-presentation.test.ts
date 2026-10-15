import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogScope, demoPresentation, demoTabs, demoTabFor, monitoringRows } from './demo-presentation.ts';
import { requirements } from './explanations.ts';
import type { Model } from '../server/gateway.ts';

test('every capability has one short status and exposes calls only for relevant demonstrations', () => {
  assert.deepEqual(Object.keys(demoPresentation), requirements.map(item => item.id));
  for (const presentation of Object.values(demoPresentation)) assert.ok(presentation.badge.split(/\s+/).length <= 4);
  for (const id of ['reliability', 'safety', 'observability', 'finops'] as const) {
    assert.equal(demoPresentation[id].request, 'none', `${id} must not present a basic call as feature proof`);
  }
  assert.equal(demoPresentation.routing.request, 'selector');
  for (const id of ['multi-cloud', 'performance', 'developer-experience'] as const) {
    assert.equal(demoPresentation[id].request, 'manual');
  }
});
test('four capability tabs plus Architecture cover every requirement exactly once', () => {
  assert.equal(demoTabs.length + 1, 5);
  assert.deepEqual([...demoTabs.flatMap(tab => tab.capabilities)].sort(), requirements.map(item => item.id).sort());
  for (const tab of demoTabs) {
    assert.ok(tab.capabilities.includes(tab.id));
    for (const capability of tab.capabilities) assert.equal(demoTabFor(capability).id, tab.id);
  }
  assert.equal(demoTabFor('developer-experience').id, 'multi-cloud');
  assert.equal(demoTabFor('performance').id, 'multi-cloud');
  assert.equal(demoTabFor('finops').id, 'routing');
  assert.equal(demoTabFor('safety').id, 'reliability');
  assert.equal(demoPresentation[demoTabFor('finops').id].request, 'selector');
  assert.equal(demoPresentation[demoTabFor('safety').id].request, 'none');
});
test('catalog counts distinct configured providers without inventing another cloud', () => {
  const models: Model[] = [
    { id: 'model-1', name: 'azure', cloud: 'azure', provider: 'foundry', format: 'openai-chat' },
    { id: 'model-4', name: 'databricks', cloud: 'azure', provider: 'databricks', format: 'openai-chat' }
  ];
  assert.match(catalogScope(models), /2 models.*2 providers.*Azure/);
  assert.match(catalogScope([{ ...models[0], cloud: 'aws', provider: 'bedrock' }]), /AWS/);
  assert.match(catalogScope([...models, { ...models[0], cloud: 'gcp', provider: 'vertex' }]), /2 clouds/);
  assert.match(catalogScope([]), /0 models/);
});
test('compact monitoring rows preserve actual counters and never add series or fabricate missing totals', () => {
  assert.deepEqual(monitoringRows([
    { model: 'demo', tokenType: 'prompt_tokens', value: 0 },
    { model: 'demo', tokenType: 'completion_tokens', value: 4 }
  ]), [{ model: 'demo', input: 0, output: 4, total: 'Not reported', reasoning: 'Not reported', cachedInput: 'Not reported' }]);
  assert.equal(monitoringRows([{ model: 'demo', tokenType: 'completion_tokens_details.reasoning_tokens', value: 0 }])[0].reasoning, 0);
  assert.equal(monitoringRows([
    { model: 'demo', tokenType: 'total_tokens', value: 10 },
    { model: 'demo', tokenType: 'total_tokens', value: 20 }
  ])[0].total, 'Multiple series');
});
