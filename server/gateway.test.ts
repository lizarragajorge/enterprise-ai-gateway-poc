import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGateway, loadConfig, publicConfig, validateInput } from './gateway.ts';
import type { Config, Format } from './gateway.ts';
import { costCandidates } from './routing.ts';
import { getWorkload } from './workloads.ts';

const fixture = (format: Format = 'openai-chat'): Config => ({
  origin: 'https://synthetic-test.azure-api.net',
  keys: { A: 'synthetic-key-A', B: 'synthetic-key-B' },
  models: [{ id: 'model-1', name: 'published-test-model', cloud: 'azure', format }]
});
const input = { app: 'A' as const, modelId: 'model-1', prompt: 'Synthetic test prompt.' };
function reply(body: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers });
}
test('reasoning and cached-token usage preserve zero and do not inflate totals or infer missing counts', async () => {
  const result = await callGateway(fixture(), input, reply({
    choices: [{ message: { content: 'Synthetic response.' } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 4 }, prompt_tokens_details: { cached_tokens: 0 } }
  }));
  assert.deepEqual(result.tokens, { input: 20, output: 10, total: 30, reasoning: 4, cachedInput: 0 });
  const absent = await callGateway(fixture(), input, reply({
    choices: [{ message: { content: 'Synthetic response.' } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: -1 },
      prompt_tokens_details: { cached_tokens: '4' } }
  }));
  assert.deepEqual(absent.tokens, { input: 20, output: 10, total: 30 });
});

test('configuration constrains runtime destinations and formats', () => {
  for (const origin of [
    'http://test.azure-api.net', 'https://evil.example', 'https://test.azure-api.net.evil.example',
    'https://user:password@test.azure-api.net', 'https://test.azure-api.net/default',
    'https://test.azure-api.net:8443', 'https://test.azure-api.net/?key=value'
  ]) assert.throws(() => loadConfig({ GATEWAY_ORIGIN: origin }));
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'test', MODEL_1_FORMAT: 'native-bedrock' }));
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'test', MODEL_1_CLOUD: 'other' }));
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'test', MODEL_2_NAME: 'test' }));
  assert.equal(loadConfig({ GATEWAY_ORIGIN: fixture().origin }).origin, fixture().origin);
  assert.equal(loadConfig({ GATEWAY_ORIGIN: 'https://test.eastus2.aigateway.azure-api.net' }).origin, 'https://test.eastus2.aigateway.azure-api.net');
  assert.equal(loadConfig({ GATEWAY_ORIGIN: 'https://test.eastus2-01.ai.gateway.azure.com' }).origin, 'https://test.eastus2-01.ai.gateway.azure.com');
  assert.throws(() => loadConfig({ GATEWAY_ORIGIN: 'https://test.eastus2.aigateway.azure-api.net.evil.example' }));
  assert.throws(() => loadConfig({ GATEWAY_ORIGIN: 'https://test.eastus2-01.ai.gateway.azure.com.evil.example' }));
});

test('public configuration never exposes keys and reports shared identity', () => {
  const config = fixture();
  assert.ok(!JSON.stringify(publicConfig(config)).includes('synthetic-key'));
  assert.equal(publicConfig(config).sameKey, false);
  config.keys.B = config.keys.A;
  assert.equal(publicConfig(config).sameKey, true);
  assert.equal(publicConfig(loadConfig({})).gatewayConfigured, false);
});

test('request validation only permits configured application/model and bounded prompt', () => {
  for (const value of [
    null, {}, { ...input, app: 'C' }, { ...input, modelId: 'https://evil.example' },
    { ...input, prompt: '' }, { ...input, prompt: ' ' }, { ...input, prompt: 'a'.repeat(8001) }
  ]) assert.throws(() => validateInput(value, fixture()));
  assert.deepEqual(validateInput({ ...input, destination: 'https://evil.example' }, fixture()), input);
  assert.equal(validateInput({ ...input, prompt: 'a'.repeat(8000) }, fixture()).prompt.length, 8000);
});

test('real-client request shape: correct endpoint, caller key, no redirects or client routing', async () => {
  let called = 0;
  const result = await callGateway(fixture(), input, async (url, init) => {
    called++;
    assert.equal(String(url), 'https://synthetic-test.azure-api.net/default/models/openai/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('api-key'), 'synthetic-key-A');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'published-test-model', messages: [{ role: 'user', content: input.prompt }], stream: false
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic test response.' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
  });
  assert.equal(called, 1);
  assert.equal(result.source, 'gateway-response');
  assert.equal(result.modelResponse, true);
  assert.equal(result.response, 'Synthetic test response.');
  assert.deepEqual(result.tokens, { input: 2, output: 3, total: 5 });
  assert.ok(result.latencyMs >= 0);
});

test('application B uses its distinct server-side key', async () => {
  await callGateway(fixture(), { ...input, app: 'B' }, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('api-key'), 'synthetic-key-B');
    return new Response('{}');
  });
});
test('server correlation is propagated, returned and validated independently of client fields', async () => {
    const correlationId = crypto.randomUUID();
    const spoofedInput = { ...input, correlationId: 'client-spoof' };
    const result = await callGateway(fixture(), spoofedInput, async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('x-correlation-id'), correlationId);
      return new Response('{}');
    }, { correlationId });
    assert.equal(result.correlationId, correlationId);
    await assert.rejects(callGateway(fixture(), input, reply({}), { correlationId: 'invalid\r\nheader' }), /correlation ID/);
});
test('actual transport timeout type is explicit and runtime secrets are redacted from failures', async () => {
    const timedOut = await callGateway(fixture(), input, async () => { throw new DOMException('Synthetic timeout', 'TimeoutError'); });
    assert.equal(timedOut.transportFailure, 'timeout');
    const failed = await callGateway(fixture(), input, async () => { throw new Error('synthetic-key-A must not escape'); });
    assert.ok(!failed.response.includes('synthetic-key-A'));
});

test('cost routing passes an actual output cap and forwards cancellation', async () => {
  const controller = new AbortController();
  const result = await callGateway(fixture(), input, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).max_completion_tokens, 256);
    assert.equal(init?.signal?.aborted, false);
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'READY' } }] }));
  }, { maxCompletionTokens: 256, signal: controller.signal });
  assert.equal(result.request.max_completion_tokens, 256);
});

test('invalid output caps fail before any provider call', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response('{}'); };
  for (const maxCompletionTokens of [0, -1, 2049, 1.5, Number.NaN]) {
    await assert.rejects(callGateway(fixture(), input, fetcher, { maxCompletionTokens }), /output limit/);
  }
  await assert.rejects(callGateway(fixture('anthropic-messages'), input, fetcher, { maxCompletionTokens: 256 }), /OpenAI chat/);
  assert.equal(calls, 0);
});

test('third model slot is independent and enforces duplicate and format validation', () => {
  const config = loadConfig({
    MODEL_1_NAME: 'cheap', MODEL_2_NAME: 'existing-secondary', MODEL_3_NAME: 'premium',
    MODEL_3_CLOUD: 'azure', MODEL_3_FORMAT: 'openai-chat'
  });

  assert.equal(config.models.length, 3);
  assert.deepEqual(config.models[2], { id: 'model-3', name: 'premium', cloud: 'azure', provider: 'foundry', format: 'openai-chat' });
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'duplicate', MODEL_3_NAME: 'duplicate' }));
  assert.throws(() => loadConfig({ MODEL_3_NAME: 'premium', MODEL_3_FORMAT: 'unsupported' }));
});

test('four slots preserve existing aliases and expose provider metadata separately from cloud', () => {
  const config = loadConfig({
    MODEL_1_NAME: 'economy', MODEL_2_NAME: 'secondary', MODEL_3_NAME: 'premium',
    MODEL_4_NAME: 'demo-databricks-gpt-oss-20b', MODEL_4_CLOUD: 'azure',
    MODEL_4_FORMAT: 'openai-chat', MODEL_4_PROVIDER: 'databricks'
  });

  assert.deepEqual(config.models.map(model => [model.id, model.name, model.cloud, model.provider]), [
    ['model-1', 'economy', 'azure', 'foundry'], ['model-2', 'secondary', 'azure', 'foundry'],
    ['model-3', 'premium', 'azure', 'foundry'], ['model-4', 'demo-databricks-gpt-oss-20b', 'azure', 'databricks']
  ]);
  assert.equal(publicConfig(config).models[3].provider, 'databricks');
  assert.equal(loadConfig({ MODEL_1_NAME: 'aws', MODEL_1_CLOUD: 'aws' }).models[0].provider, 'bedrock');
  assert.equal(loadConfig({ MODEL_1_NAME: 'gcp', MODEL_1_CLOUD: 'gcp' }).models[0].provider, 'vertex');
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'same', MODEL_4_NAME: 'same' }), /unique/);
  assert.throws(() => loadConfig({ MODEL_4_NAME: 'test', MODEL_4_PROVIDER: 'unknown' }), /PROVIDER/);
  assert.throws(() => loadConfig({ MODEL_4_NAME: 'test', MODEL_4_PROVIDER: 'databricks', MODEL_4_CLOUD: 'aws' }), /Azure/);
  assert.throws(() => loadConfig({ MODEL_4_NAME: 'test', MODEL_4_PROVIDER: 'databricks', MODEL_4_FORMAT: 'anthropic-messages' }), /OpenAI chat/);
  assert.throws(() => loadConfig({ MODEL_4_NAME: 'test', MODEL_4_FORMAT: 'unsupported' }), /FORMAT/);
});

test('fourth provider does not change existing priced cost-selector candidates', () => {
  const config = loadConfig({
    MODEL_1_NAME: 'ai-cost-economy-current', MODEL_1_REASONING_EFFORT: 'none',
    MODEL_2_NAME: 'demo-chat-secondary',
    MODEL_3_NAME: 'ai-cost-premium-current', MODEL_3_REASONING_EFFORT: 'low',
    MODEL_4_NAME: 'demo-databricks-gpt-oss-20b', MODEL_4_PROVIDER: 'databricks'
  });
  const workload = getWorkload('extract-record');
  const candidates = costCandidates(config, workload, 1000, undefined, 0);
  assert.deepEqual(candidates.map(candidate => candidate.modelId), ['model-1', 'model-3']);
  assert.deepEqual(candidates, costCandidates({ ...config, models: config.models.slice(0, 3) }, workload, 1000, undefined, 0));
});

const databricksConfig = (): Config => loadConfig({
  GATEWAY_ORIGIN: fixture().origin, APP_A_KEY: 'synthetic-key-A',
  MODEL_4_NAME: 'demo-databricks-gpt-oss-20b', MODEL_4_CLOUD: 'azure',
  MODEL_4_FORMAT: 'openai-chat', MODEL_4_PROVIDER: 'databricks'
});
const databricksInput = { ...input, modelId: 'model-4' };

test('Databricks uses the published gateway alias, bounded max_tokens and strict answer extraction', async () => {
  for (const limit of [undefined, 1, 512, 2048]) {
    const raw = {
      model: 'gpt-oss-20b-080525',
      choices: [{ message: { content: [
        { type: 'reasoning', summary: 'Not the answer' },
        { type: 'text', text: 'REA' }, { type: 'text', text: 'DY' }
      ] } }],
      usage: { prompt_tokens: 108, completion_tokens: 35, total_tokens: 143 }
    };
    const result = await callGateway(databricksConfig(), databricksInput, async (url, init) => {
      assert.equal(String(url), `${fixture().origin}/default/models/databricks-gpt-oss-20b/invocations`);
      assert.equal(new Headers(init?.headers).get('api-key'), 'synthetic-key-A');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: 'demo-databricks-gpt-oss-20b', messages: [{ role: 'user', content: input.prompt }],
        max_tokens: limit ?? 256, stream: false
      });
      return new Response(JSON.stringify(raw));
    }, limit === undefined ? {} : { maxCompletionTokens: limit });
    assert.equal(result.request.max_tokens, limit ?? 256);
    assert.equal(result.request.max_completion_tokens, undefined);
    assert.equal(result.response, 'READY');
    assert.equal(result.returnedModel, 'gpt-oss-20b-080525');
    assert.equal(result.provider, 'databricks');
    assert.equal(result.cloud, 'azure');
    assert.equal(result.modelResponse, true);
    assert.deepEqual(result.tokens, { input: 108, output: 35, total: 143 });
    assert.deepEqual(result.raw, raw);
  }
});

test('Databricks invalid blocks preserve gateway diagnostics and never become local transport errors or success', async () => {
  for (const content of [
    [{ type: 'reasoning', summary: 'Only thinking' }],
    [{ type: 'text', text: 'READY' }, { type: 'unknown', text: 'Must reject all' }],
    [{ type: 'text', text: 42 }], [null], [], ''
  ]) {
    const raw = { choices: [{ message: { content } }] };
    const result = await callGateway(databricksConfig(), databricksInput, reply(raw, 200, { 'x-request-id': 'diagnostic' }));
    assert.equal(result.source, 'gateway-response');
    assert.equal(result.status, 200);
    assert.equal(result.modelResponse, false);
    assert.match(result.response, /Databricks/);
    assert.deepEqual(result.raw, raw);
    assert.equal(result.headers['x-request-id'], 'diagnostic');
  }
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const rejection = { error: { message: 'Synthetic expired/rejected backend credential or quota' } };
    const failed = await callGateway(databricksConfig(), databricksInput, async (url) => {
      calls++;
      assert.equal(String(url), `${fixture().origin}/default/models/databricks-gpt-oss-20b/invocations`);
      return new Response(JSON.stringify(rejection), { status });
    });
    assert.equal(calls, 1);
    assert.equal(failed.source, 'gateway-response');
    assert.equal(failed.status, status);
    assert.equal(failed.response, rejection.error.message);
    assert.equal(failed.modelResponse, false);
    assert.deepEqual(failed.raw, rejection);
  }
  const text = await callGateway(databricksConfig(), databricksInput, reply({ choices: [{ message: { content: 'READY' } }] }));
  assert.equal(text.modelResponse, true);
});

test('current reasoning models use explicitly configured none/low without unsupported parameters', async () => {
  for (const reasoningEffort of ['none', 'low']) {
    const config = loadConfig({
      GATEWAY_ORIGIN: fixture().origin, APP_A_KEY: 'synthetic-key-A',
      MODEL_1_NAME: 'current-model', MODEL_1_FORMAT: 'openai-chat', MODEL_1_REASONING_EFFORT: reasoningEffort
    });
    const response = await callGateway(config, input, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.reasoning_effort, reasoningEffort);
      assert.equal(body.max_completion_tokens, 256);
      assert.equal(body.temperature, undefined);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic response' } }] }));
    }, { maxCompletionTokens: 256 });
    assert.equal(response.request.reasoning_effort, reasoningEffort);
  }
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'test', MODEL_1_REASONING_EFFORT: 'unknown' }));
  assert.throws(() => loadConfig({ MODEL_1_NAME: 'test', MODEL_1_FORMAT: 'anthropic-messages', MODEL_1_REASONING_EFFORT: 'none' }));
});

test('native Anthropic format is passed without universal translation claims', async () => {
  const result = await callGateway(fixture('anthropic-messages'), input, async (url, init) => {
    assert.equal(String(url), 'https://synthetic-test.azure-api.net/default/models/anthropic/v1/messages');
    assert.equal(new Headers(init?.headers).get('anthropic-version'), '2023-06-01');
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 256);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Synthetic Anthropic response.' }], usage: { input_tokens: 4, output_tokens: 6 } }));
  });
  assert.equal(result.response, 'Synthetic Anthropic response.');
  assert.deepEqual(result.tokens, { input: 4, output: 6, total: 10 });
});

test('missing usage is unavailable, zero is valid, partial usage is not fabricated', async () => {
  const missing = await callGateway(fixture(), input, reply({ choices: [] }));
  assert.equal(missing.tokens, null);
  const zero = await callGateway(fixture(), input, reply({ usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  assert.equal(zero.tokens?.total, 0);
  const partial = await callGateway(fixture(), input, reply({ usage: { prompt_tokens: 2 } }));
  assert.equal(partial.tokens?.total, undefined);
  const invalid = await callGateway(fixture(), input, reply({ usage: { prompt_tokens: -1, completion_tokens: '3' } }));
  assert.equal(invalid.tokens, null);
});

test('returned model is provider-reported, never inferred from the selected alias', async () => {
  const result = await callGateway(fixture(), input, reply({
    model: 'actual-provider-model-version', choices: [{ message: { content: 'Synthetic response' } }]
  }));
  assert.equal(result.model, 'published-test-model');
  assert.equal(result.returnedModel, 'actual-provider-model-version');
  for (const model of [undefined, null, '', ' ', 42]) {
    const missing = await callGateway(fixture(), input, reply({ model }));
    assert.equal(missing.returnedModel, undefined);
  }
});

test('gateway rejections preserve status and headers without retries or false success', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const result = await callGateway(fixture(), input, async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Synthetic upstream rejection' } }), {
        status, headers: { 'retry-after': '30', 'remaining-tokens': '0', 'set-cookie': 'do-not-expose' }
      });
    });
    assert.equal(result.status, status);
    assert.equal(result.source, 'gateway-response');
    assert.equal(result.modelResponse, false);
    assert.equal(result.headers['retry-after'], '30');
    assert.equal(result.headers['remaining-tokens'], '0');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(calls, 1);
  }
});

test('non-JSON errors and empty/unexpected 2xx bodies remain honest', async () => {
  const nonJson = await callGateway(fixture(), input, async () => new Response('Upstream unavailable', { status: 502 }));
  assert.equal(nonJson.raw, 'Upstream unavailable');
  assert.equal(nonJson.modelResponse, false);
  const empty = await callGateway(fixture(), input, async () => new Response(null, { status: 204 }));
  assert.equal(empty.status, 204);
  assert.equal(empty.modelResponse, false);
  const error = await callGateway(fixture(), input, reply({ error: { message: 'Not a model response' } }));
  assert.equal(error.modelResponse, false);
});

test('configured keys are redacted from upstream body and exposed headers', async () => {
  const result = await callGateway(fixture(), input, reply(
    { error: { message: 'Echo synthetic-key-A and synthetic-key-B' } }, 400,
    { 'x-request-id': 'synthetic-key-A' }
  ));
  assert.ok(!JSON.stringify(result).includes('synthetic-key'));
  assert.equal(result.headers['x-request-id'], '[redacted]');
});

test('network errors and oversized upstream bodies are explicit local failures', async () => {
  let calls = 0;
  const result = await callGateway(fixture(), input, async () => {
    calls++;
    throw new Error('Synthetic network failure');
  });
  assert.equal(result.status, 502);
  assert.equal(result.source, 'local-error');
  assert.equal(result.modelResponse, false);
  assert.match(result.response, /Synthetic network failure/);
  assert.equal(calls, 1);
  const oversized = await callGateway(fixture(), input, async () => new Response('x'.repeat(1024 * 1024 + 1)));
  assert.equal(oversized.source, 'local-error');
  assert.match(oversized.response, /1 MiB/);
});

test('missing configuration never calls a provider or simulates success', async () => {
  const config = fixture();
  config.keys.A = undefined;
  await assert.rejects(callGateway(config, input, async () => {
    assert.fail('Must not fetch without credentials');
  }), /required/);
});
