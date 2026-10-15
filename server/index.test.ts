import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';

let child: ChildProcess;
let base: string;
let port: number;
before(async () => {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, PORT: String(port), GATEWAY_ORIGIN: '', APP_A_KEY: '', APP_B_KEY: '', MODEL_1_NAME: 'synthetic-model', MODEL_2_NAME: '', MODEL_3_NAME: '', MODEL_1_CLOUD: 'azure', MODEL_1_FORMAT: 'openai-chat',
      APIM_V2_GATEWAY_ORIGIN: '', APIM_V2_APP_A_KEY: '', APIM_V2_APP_B_KEY: '',
      APIM_V2_MODEL_1_NAME: '', APIM_V2_MODEL_2_NAME: '', APIM_V2_MODEL_3_NAME: '', APIM_V2_MODEL_4_NAME: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server exited ${code}`)); });
    child.stdout?.on('data', chunk => {
      if (String(chunk).includes('PoC listening')) { clearTimeout(timeout); resolve(); }
    });
  });
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
});

test('configuration endpoint works locally without exposing secrets', async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.gatewayConfigured, false);
  assert.equal(body.applications[0].ready, false);
  assert.ok(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
});
test('native safety API is profile-bound and unavailable without verified evidence or configuration', async () => {
  assert.equal((await fetch(`${base}/api/content-safety`)).status, 400);
  for (const gatewayId of ['ai-gateway', 'apim-v2']) {
    const response = await fetch(`${base}/api/content-safety?gateway=${gatewayId}`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.gatewayId, gatewayId);
    assert.ok(!('gatewayOrigin' in body));
    if (gatewayId === 'apim-v2') assert.match(body.error, /not configured.*not inherited/);
    const write = await fetch(`${base}/api/content-safety/request`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayId, app: 'A', modelId: 'model-1', action: 'reject' })
    });
    assert.equal(write.status, 503);
    const outcome = await write.json();
    assert.equal(outcome.outcome.gatewayCallMade, false);
    assert.equal(outcome.evidence.workload, 'governance-proof');
    assert.equal(outcome.evidence.policy, null);
    assert.equal(outcome.correlationId, write.headers.get('x-correlation-id'));
  }
});

test('policy snapshot endpoint is read-only and explicitly unavailable without evidence', async () => {
  const response = await fetch(`${base}/api/gateway-policies?gateway=ai-gateway`);
  const body = await response.json();
  if (response.status === 503) assert.match(body.error, /snapshot missing/);
  else {
    assert.equal(response.status, 200);
    assert.equal(body.source, 'azure-control-plane');
    assert.ok(Array.isArray(body.models));
    assert.ok(body.models.every((model: { policies: object[] }) =>
      model.policies.every(policy => !('credential' in policy) && !('token' in policy))));
  }
  const write = await fetch(`${base}/api/gateway-policies`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(write.status, 404);
});

test('native monitoring endpoint is credential-free, read-only and honest about missing evidence', async () => {
  const response = await fetch(`${base}/api/gateway-monitoring?gateway=ai-gateway`);
  const body = await response.json();
  if (response.status === 503) assert.match(body.error, /snapshot missing/);
  else {
    assert.equal(response.status, 200);
    assert.equal(body.source, 'azure-control-plane');
    assert.equal(body.payloadCapture, false);
    assert.ok(!('credentials' in body) && !('connectionString' in body));
    if (body.metrics) {
      assert.equal(body.metrics.source, 'azure-monitor-promql');
      assert.ok(body.metrics.samples.some((sample: { value: number }) => sample.value > 0));
    }
  }
  const write = await fetch(`${base}/api/gateway-monitoring`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(write.status, 404);
});

test('rejects DNS-rebinding Host and cross-origin calls', async () => {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/api/config`, { headers: { Host: `evil.example:${port}` } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  for (const path of ['/api/request', '/api/routing/request', '/api/content-safety/request']) {
    for (const origin of ['https://evil.example', 'null', undefined]) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (origin) headers.Origin = origin;
      const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 403);
    }
  }
});

test('valid request with absent runtime key fails explicitly', async () => {
  const response = await fetch(`${base}/api/request`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', prompt: 'Synthetic prompt' })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /runtime key/);
});

test('malformed JSON, unknown model, and oversized body are rejected', async () => {
  const post = (body: string) => fetch(`${base}/api/request`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body
  });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ gatewayId: 'ai-gateway', app: 'A', modelId: 'other', prompt: 'hello' }))).status, 400);
  assert.equal((await post(JSON.stringify({ prompt: 'x'.repeat(41000) }))).status, 413);
});

test('unknown API and wrong media type have clear errors', async () => {
  assert.equal((await fetch(`${base}/api/not-found`)).status, 404);
  assert.equal((await fetch(`${base}/api/request`, { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 415);
});

test('routing snapshot is app-scoped, requires a valid app and exposes no credentials', async () => {
  const response = await fetch(`${base}/api/routing?gateway=ai-gateway&app=B`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.application, 'B');
  assert.equal(body.ready, false);
  assert.equal(body.priceReviewedAt, '2026-10-12');
  assert.ok(body.candidates.every((candidate: { eligible: boolean }) => !candidate.eligible));
  assert.ok(!JSON.stringify(body).includes('test-a'));
  assert.equal((await fetch(`${base}/api/routing?gateway=ai-gateway&app=other`)).status, 400);
  assert.equal((await fetch(`${base}/api/routing?gateway=ai-gateway&app=A&workload=unknown`)).status, 400);
});
test('routing endpoints validate inputs and never simulate absent configuration', async () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'ai-gateway', ...body as object })
  });
  test('all profile-specific endpoints require explicit profile IDs and APIM never inherits proof', async () => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config.profiles.map((profile: { gatewayId: string }) => profile.gatewayId), ['ai-gateway', 'apim-v2']);
    assert.ok(!JSON.stringify(config).includes('APP_A_KEY'));
    for (const path of ['/api/routing?app=A', '/api/gateway-policies', '/api/gateway-monitoring']) {
      assert.equal((await fetch(`${base}${path}`)).status, 400);
    }
    for (const endpoint of ['gateway-policies', 'gateway-monitoring']) {
      const response = await fetch(`${base}/api/${endpoint}?gateway=apim-v2`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).gatewayId, 'apim-v2');
    }
    const response = await fetch(`${base}/api/routing?gateway=apim-v2&app=A`);
    const body = await response.json();
    assert.equal(body.gatewayId, 'apim-v2');
    assert.equal(body.gatewayType, 'apim-premium-v2');
    assert.equal(body.ready, false);
    assert.equal(body.evaluation, undefined);
    for (const gatewayId of [undefined, 'invalid', 'https://evil.example']) {
      const result = await fetch(`${base}/api/request`, {
        method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayId, app: 'A', modelId: 'model-1', prompt: 'hello' })
      });
      assert.equal(result.status, 400);
    }
    const override = await fetch(`${base}/api/request`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', prompt: 'hello', path: '/evil' })
    });
    assert.equal(override.status, 400);
  });
  assert.equal((await post('/api/routing/measure', { app: 'A' })).status, 404);
  assert.equal((await post('/api/routing/request', { app: 'A', prompt: 'task' })).status, 400);
  assert.equal((await post('/api/routing/request', { app: 'A', prompt: '', measurementId: 'known' })).status, 400);
  assert.equal((await post('/api/routing/request', {
    app: 'A', prompt: 'task', workload: 'extract-record', plannedInputTokens: 1000,
    evaluationId: 'test-run', priceVersion: 'azure-gpt6-eastus2-global-short-usd-2026-10-12', policyVersion: 'economy-first:v1:r0'
  })).status, 503);
});
test('routing policy changes live with version checking and is independent of the gateway profile', async () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const initial = await (await fetch(`${base}/api/routing-policy`)).json();
  const response = await post('/api/routing-policy', { presetId: 'premium-required-reconciliation', expectedVersion: initial.active.version });
  assert.equal(response.status, 200);
  const changed = await response.json();
  assert.equal(changed.active.id, 'premium-required-reconciliation');
  const stale = await post('/api/routing-policy', { presetId: 'economy-first', expectedVersion: initial.active.version });
  assert.equal(stale.status, 409);
  for (const gateway of ['ai-gateway', 'apim-v2']) {
    const snapshot = await (await fetch(`${base}/api/routing?gateway=${gateway}&app=A&workload=reconcile-records`)).json();
    assert.equal(snapshot.policy.version, changed.active.version);
  }
  assert.equal((await post('/api/routing-policy', { presetId: 'economy-first', expectedVersion: changed.active.version })).status, 200);
});
test('local request refusal has fresh boundary IDs, a single safe joined event and recovery', async () => {
  const response = await fetch(`${base}/api/request`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'x-correlation-id': 'client-spoof' },
    body: JSON.stringify({ gatewayId: 'ai-gateway', app: 'A', modelId: 'model-1', prompt: 'sensitive-prompt-canary' }) });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.correlationId, /^[a-f0-9-]{36}$/);
  assert.notEqual(body.correlationId, 'client-spoof');
  assert.equal(response.headers.get('x-correlation-id'), body.correlationId);
  assert.equal(body.decisionId, body.evidence.decisionId);
  assert.equal(body.outcome.gatewayCallMade, false);
  assert.equal(body.outcome.enforcementBoundary, 'local-poc');
  assert.ok(!JSON.stringify(body.evidence).includes('sensitive-prompt-canary'));
});
test('reloading genuine evidence validates profile and local origin without changing policy', async () => {
  const before = await (await fetch(`${base}/api/routing-policy`)).json();
  const response = await fetch(`${base}/api/reload-evidence`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'ai-gateway' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).policy.version, before.active.version);
  const invalid = await fetch(`${base}/api/reload-evidence`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'invalid' }) });
  assert.equal(invalid.status, 400);
});
test('unavailable native proof is explicit, profile-bound, and makes no gateway call', async () => {
  assert.equal((await fetch(`${base}/api/governance-proof`)).status, 400);
  const snapshot = await fetch(`${base}/api/governance-proof?gateway=ai-gateway`);
  assert.equal(snapshot.status, 503);
  const response = await fetch(`${base}/api/governance/request`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gatewayId: 'ai-gateway', app: 'A', action: 'reject' }) });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.outcome.gatewayCallMade, false);
  assert.equal(body.evidence.gatewayId, 'ai-gateway');
  assert.equal(body.evidence.application, 'A');
  assert.equal(body.evidence.selectedModel, null);
});
