import test from 'node:test';
import assert from 'node:assert/strict';
import { details, requirements } from './explanations.ts';

test('all customer requirement tabs have a concise gateway role and a distinct demo boundary', () => {
  assert.deepEqual(requirements.map(item => item.id), [
    'multi-cloud', 'routing', 'reliability', 'observability', 'finops', 'safety', 'performance', 'developer-experience'
  ]);
  for (const capability of requirements) {
    assert.ok(capability.gatewayRole.trim());
    assert.ok(capability.demoScope.trim());
    assert.ok(capability.gatewayRole.split(/\s+/).length <= 24, capability.id);
    assert.ok(capability.demoScope.split(/\s+/).length <= 24, capability.id);
    for (const value of [capability.demonstrated, capability.documented, capability.external, capability.gap]) {
      assert.ok(value.trim(), `Missing evidence category: ${capability.id}`);
    }
  }
});
test('selection remains explicitly custom while gateway dispatch remains native', () => {
  const routing = requirements.find(item => item.id === 'routing')!;
  assert.equal(routing.label, 'Selection & dispatch');
  assert.match(routing.title, /Custom selection/);
  assert.match(routing.gatewayRole, /Dispatch.*selected by.*separate router/);
  assert.match(routing.demoScope, /Our code.*AI Gateway dispatches.*does not assess/);
  assert.match(routing.external, /local application code/);
});
test('capability boundaries cannot read as unconditional working gateway proofs', () => {
  const byId = (id: string) => requirements.find(item => item.id === id)!;
  assert.match(byId('multi-cloud').demoScope, /Databricks on Azure.*this session.*not multicloud/);
  assert.match(byId('reliability').demoScope, /Enforcement.*not demonstrated/);
  assert.match(byId('safety').demoScope, /profile-specific native Content Safety evidence.*Only assets with attributable blocked and allowed observations/);
  assert.match(byId('safety').gap, /No configured policy is inferred from a 400\/403\/429 alone/);
  assert.match(byId('finops').demoScope, /No dollar budgets.*showback/);
  assert.match(byId('performance').demoScope, /not demonstrated/);
  assert.match(byId('developer-experience').demoScope, /not tested/);
});
test('Databricks model evidence does not imply data/tool access or another cloud', () => {
  assert.ok(requirements.find(item => item.id === 'multi-cloud')!.nodes.includes('databricks'));
  assert.match(details.databricks.proof, /current session.*historical direct evidence/);
  assert.match(details.databricks.responsibility, /native Databricks invocations.*not universal endpoint normalization/);
  assert.match(details.databricks.limitation, /No Unity Catalog tool\/data access, multicloud, intelligent routing, failover or telemetry/);
  assert.match(details.databricks.limitation, /workspace-level; no per-model authorization is claimed/);
  assert.match(details.databricks.limitation, /not a credential-health check.*PAT expires.*rotation/);
});
test('Content Safety remains a gateway requirement without a separate architecture component', () => {
  assert.ok(requirements.find(item => item.id === 'safety')!.nodes.includes('gateway'));
  assert.equal('safety' in details, false);
});
