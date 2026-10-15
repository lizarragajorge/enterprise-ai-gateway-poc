import test from 'node:test';
import assert from 'node:assert/strict';
import { hasModelResponse, observedRequestPath, modelPathNode, modelCoverage } from './request-path.ts';
import type { CallResult } from '../server/gateway.ts';

const request = {
  application: 'B',
  model: { id: 'model-1', name: 'private-published-alias', cloud: 'azure' as const, format: 'openai-chat' as const }
};
const response: CallResult = {
  source: 'gateway-response', status: 200, model: request.model.name,
  returnedModel: 'reported-model', cloud: 'azure', latencyMs: 10,
  response: 'Synthetic test response.', modelResponse: true, tokens: null,
  headers: {}, raw: {}, request: { model: request.model.name, messages: [] }
};

test('idle has no observed path; pending never claims gateway receipt or model execution', () => {
  assert.deepEqual(observedRequestPath({ phase: 'idle' }), []);
  const steps = observedRequestPath({ phase: 'pending', request });
  assert.deepEqual(steps.map(step => [step.kind, step.state]), [['application', 'local'], ['gateway', 'unknown']]);
  assert.equal(steps[0].label, 'Application B');
  assert.equal(steps[1].detail, 'Receipt unconfirmed');
});
test('Databricks has its own highlighted node and provider coverage, but remains Azure', () => {
  const databricks = {
    ...request.model, id: 'model-4', name: 'demo-databricks-gpt-oss-20b', provider: 'databricks' as const
  };
  assert.equal(modelPathNode(request.model), 'azure');
  assert.equal(modelPathNode(databricks), 'databricks');
  assert.deepEqual(modelCoverage([request.model, databricks]), { models: 2, providers: 2, clouds: 1 });
  assert.deepEqual(modelCoverage([request.model, databricks], new Set(['model-4'])), { models: 1, providers: 1, clouds: 1 });
  const steps = observedRequestPath({
    phase: 'result', request: { ...request, model: databricks }, result: response
  });
  assert.match(steps[2].detail, /Databricks on Azure.*inferred.*not a gateway trace/);
  const failed = observedRequestPath({
    phase: 'result', request: { ...request, model: databricks },
    result: { ...response, modelResponse: false }
  });
  assert.equal(failed.length, 2);
});
test('automatic routing has no selected model in the path until a response arrives', () => {
  const automatic = { application: 'A' };
  const pending = observedRequestPath({ phase: 'pending', request: automatic });
  assert.equal(pending.length, 2);
  assert.ok(!pending.some(step => step.kind === 'model'));
  const steps = observedRequestPath({
    phase: 'result', request: automatic, result: { ...response, returnedModel: undefined }
  });
  assert.equal(steps[2].label, 'Model name unavailable');
  assert.match(steps[2].detail, /No reported or resolved/);
});

test('successful model response includes only client-observed/inferred path, not policy steps', () => {
  const steps = observedRequestPath({ phase: 'result', request, result: response });
  assert.deepEqual(steps.map(step => step.kind), ['application', 'gateway', 'model']);
  assert.equal(steps[2].label, 'reported-model');
  assert.match(steps[2].detail, /inferred/);
  assert.equal(hasModelResponse(response), true);
});

test('missing reported model uses a neutral configured label, not a claimed returned name', () => {
  const steps = observedRequestPath({ phase: 'result', request, result: { ...response, returnedModel: undefined } });
  assert.equal(steps[2].label, 'AZURE / model-1');
  assert.match(steps[2].detail, /name unavailable/);
  assert.ok(!JSON.stringify(steps).includes(request.model.name));
});

test('gateway errors stop at endpoint without claiming policy provenance or provider execution', () => {
  for (const status of [400, 403, 429, 500]) {
    const result = { ...response, status, modelResponse: false };
    const steps = observedRequestPath({ phase: 'result', request, result });
    assert.deepEqual(steps.map(step => step.kind), ['application', 'gateway']);
    assert.equal(steps[1].state, 'error');
    assert.match(steps[1].detail, /origin unconfirmed/);
    assert.equal(hasModelResponse(result), false);
  }
});

test('unsupported 2xx is not a successful model path', () => {
  for (const status of [200, 204]) {
    const result = { ...response, status, modelResponse: false };
    assert.equal(hasModelResponse(result), false);
    const steps = observedRequestPath({ phase: 'result', request, result });
    assert.equal(steps.length, 2);
    assert.match(steps[1].detail, /no supported model text/);
  }
});

test('local errors and transport failures never claim gateway or model execution', () => {
  for (const observation of [
    { phase: 'local-error' as const, request },
    { phase: 'result' as const, request, result: { ...response, source: 'local-error' as const, status: 502 } }
  ]) {
    const steps = observedRequestPath(observation);
    assert.deepEqual(steps.map(step => step.kind), ['application', 'proxy']);
    assert.match(steps[1].detail, /execution unknown/);
  }
  assert.equal(hasModelResponse({ ...response, source: 'local-error' }), false);
});

test('confirmed local routing refusal shows no gateway call, not unknown transport execution', () => {
  const steps = observedRequestPath({ phase: 'local-refusal', request });
  assert.deepEqual(steps.map(step => step.kind), ['application', 'proxy']);
  assert.equal(steps[1].label, 'Local router refused');
  assert.equal(steps[1].detail, 'No gateway or model call made');
  assert.equal(steps[1].state, 'error');
});
test('only an explicit server-native outcome labels gateway rejection; status does not establish enforcement', () => {
  const rejected = {
    ...response, status: 400, modelResponse: false,
    outcome: { kind: 'gateway-error' as const, enforcementBoundary: 'native-gateway-policy' as const, gatewayCallMade: true, recovery: 'Use allowed alias.' }
  };
  const steps = observedRequestPath({ phase: 'result', request, result: rejected });
  assert.deepEqual(steps.map(step => step.kind), ['application', 'gateway']);
  assert.match(steps[1].detail, /verified native gateway policy rejection.*model not called/);
  const unknown = observedRequestPath({
    phase: 'result', request, result: { ...rejected, outcome: { ...rejected.outcome, enforcementBoundary: 'unknown-upstream' } }
  });
  assert.match(unknown[1].detail, /origin unconfirmed/);
  const local = observedRequestPath({
    phase: 'result', request, result: { ...rejected, outcome: { kind: 'local-refusal', enforcementBoundary: 'local-poc', gatewayCallMade: false, recovery: null } }
  });
  assert.deepEqual(local.map(step => step.kind), ['application', 'proxy']);
});
