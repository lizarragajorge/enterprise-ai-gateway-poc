import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogEntries, modelLabel, requestContract, renderModelCatalog } from './model-catalog.ts';
import type { Model } from '../server/gateway.ts';

const azure: Model = { id: 'model-1', name: 'private-published-name', cloud: 'azure', format: 'openai-chat' };
test('known Azure aliases have readable labels without relabeling another cloud or an unknown model', () => {
  assert.equal(modelLabel({ ...azure, name: 'ai-cost-economy-current' }), 'Azure · GPT-6 Luna');
  assert.equal(modelLabel({ ...azure, name: 'ai-cost-premium-current' }), 'Azure · GPT-6.1 Sol');
  assert.equal(modelLabel({ ...azure, name: 'demo-chat-secondary' }), 'Azure · GPT-4.1 mini');
  assert.equal(modelLabel(azure), 'Azure · model-1');
  assert.equal(modelLabel({ ...azure, name: 'ai-cost-economy-current', cloud: 'aws' }), 'AWS · model-1');
});
test('only configured models have callable model metadata', () => {
  const entries = catalogEntries([azure], new Set());
  assert.deepEqual(entries.map(entry => entry.status), [
    'Configured, unverified', 'Architecture example',
    'Architecture example', 'Architecture example'
  ]);
  assert.deepEqual(entries.filter(entry => entry.model).map(entry => entry.id), ['model-1']);
});
test('responses verify individual models, not every model in a cloud', () => {
  const entries = catalogEntries([azure, { ...azure, id: 'model-2' }], new Set(['model-1']));
  assert.equal(entries[0].status, 'Response observed');
  assert.equal(entries[1].status, 'Configured, unverified');
});
test('missing gateway configuration does not make direct access callable', () => {
  const entries = catalogEntries([], new Set(['model-1']));
  assert.equal(entries.length, 4);
  assert.ok(entries.every(entry => !entry.model));
  assert.equal(entries.filter(entry => entry.status === 'Architecture example').length, 4);
});
test('an unconfigured Databricks example never ships another deployment’s direct-call evidence', () => {
  const entry = catalogEntries([azure], new Set(['databricks-gpt-oss-20b']))
    .find(item => item.id === 'databricks-gpt-oss-20b')!;
  assert.equal(entry.label, 'Databricks · GPT OSS 20B');
  assert.equal(entry.cloud, 'azure');
  assert.equal(entry.model, undefined);
  assert.equal(entry.status, 'Architecture example');
  assert.ok(!('directVerification' in entry));
  assert.match(requestContract(entry), /No callable model is configured/);
  assert.doesNotMatch(requestContract(entry), /POST|api-key/);
});
test('configured fourth Databricks alias has one callable card and only current-session proof', () => {
  const databricks: Model = {
    id: 'model-4', name: 'demo-databricks-gpt-oss-20b', cloud: 'azure',
    provider: 'databricks', format: 'openai-chat'
  };
  const entries = catalogEntries([azure, databricks], new Set(['databricks-gpt-oss-20b']));
  assert.equal(entries.filter(entry => entry.label.includes('Databricks')).length, 1);
  const entry = entries.find(item => item.id === 'model-4')!;
  assert.equal(entry.model, databricks);
  assert.equal(entry.label, 'Databricks · GPT OSS 20B');
  assert.equal(entry.status, 'Configured, unverified');
  assert.ok(!('directVerification' in entry));
  assert.match(requestContract(entry), /POST \/default\/models\/databricks-gpt-oss-20b\/invocations/);
  assert.doesNotMatch(requestContract(entry), /\/openai\/v1\/chat\/completions/);
  assert.match(requestContract(entry), /"max_tokens": 256/);
  assert.doesNotMatch(requestContract(entry), /max_completion_tokens|not connected/);
  assert.equal(catalogEntries([databricks], new Set(['model-4']))[0].status, 'Response observed');
});
test('OpenAI shape matches the backend path without exposing a key or actual alias', () => {
  const contract = requestContract(catalogEntries([azure], new Set())[0]);
  assert.match(contract, /POST \/default\/models\/openai\/v1\/chat\/completions/);
  assert.match(contract, /"stream": false/);
  assert.doesNotMatch(contract, /private-published-name|anthropic-version/);
});
test('Anthropic shape matches the backend version header and max tokens', () => {
  const contract = requestContract(catalogEntries([{ ...azure, cloud: 'aws', format: 'anthropic-messages' }], new Set())[0]);
  assert.match(contract, /POST \/default\/models\/anthropic\/v1\/messages/);
  assert.match(contract, /anthropic-version: 2023-06-01/);
  assert.match(contract, /"max_tokens": 256/);
  assert.doesNotMatch(contract, /"stream"/);
});
test('architectural providers do not invent callable paths', () => {
  for (const entry of catalogEntries([], new Set()).filter(item => item.status === 'Architecture example')) {
    assert.match(requestContract(entry), /No callable model is configured/);
    assert.doesNotMatch(requestContract(entry), /POST|api-key/);
  }
});

test('rendered Databricks selection is configuration-driven, not a saved success; expiry and history stay distinct', () => {
  class Element {
    tag: string;
    id = '';
    textContent = '';
    className = '';
    hidden = false;
    disabled = false;
    open = false;
    children: Element[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    click?: () => void;
    constructor(tag: string) { this.tag = tag; }
    get childElementCount() { return this.children.length; }
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    addEventListener(event: string, action: () => void) { if (event === 'click') this.click = action; }
    querySelector() { return null; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: (tag: string) => new Element(tag) }
  });
  try {
    const databricks: Model = {
      id: 'model-4', name: 'demo-databricks-gpt-oss-20b', cloud: 'azure',
      provider: 'databricks', format: 'openai-chat'
    };
    const target = new Element('div');
    const state = {
      models: [azure, databricks], successes: new Set<string>(), selectedId: 'model-4',
      gatewayConfigured: true, pending: false, configurationStatus: 'Configured.'
    };
    let chosen: Model | undefined;
    const render = () => renderModelCatalog(target as unknown as HTMLElement, state, () => {}, model => { chosen = model; });
    render();
    const flatten = (element: Element): Element[] => [element, ...element.children.flatMap(flatten)];
    let nodes = flatten(target);
    const card = nodes.find(node => node.tag === 'button' && node.children[0]?.textContent === 'Databricks · GPT OSS 20B')!;
    assert.equal(card.id, 'catalog-model-4');
    assert.equal(card.dataset.status, 'Configured, unverified');
    assert.equal(nodes.filter(node => node.tag === 'button' && node.children[0]?.textContent.includes('Databricks')).length, 1);
    assert.ok(!target.children.some(node => node.tag === 'section'), 'No embedded private direct-call history.');
    assert.ok(!nodes.some(node => node.textContent === 'Historical direct-call evidence · not gateway proof'));
    assert.ok(nodes.some(node => /seven-day model-serving-inference.*Rotate before expiry/.test(node.textContent)));
    assert.equal(card.children[1].textContent, 'Ready to test');
    const connection = nodes.find(node => node.tag === 'details' && node.className.includes('catalog-preview'))!;
    assert.equal(connection.open, false, 'Technical connection content starts collapsed.');
    assert.equal(card.disabled, false);
    card.click!();
    assert.equal(chosen, databricks);
    state.successes.add('model-4');
    render();
    nodes = flatten(target);
    assert.equal(nodes.find(node => node.tag === 'button' && node.children[0]?.textContent.includes('Databricks'))!.dataset.status, 'Response observed');
    state.gatewayConfigured = false;
    render();
    chosen = undefined;
    flatten(target).find(node => node.id === 'catalog-model-4')!.click!();
    assert.equal(chosen, undefined, 'Inspection without a gateway cannot select a callable model.');
    state.gatewayConfigured = true;
    state.pending = true;
    render();
    assert.equal(flatten(target).find(node => node.id === 'catalog-model-4')!.disabled, true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
