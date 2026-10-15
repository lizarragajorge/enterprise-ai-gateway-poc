import assert from 'node:assert/strict';
import test from 'node:test';
import {
  organizationReferenceMarkup, referenceDetails, referenceSources, referenceInstances,
  getReferenceDetail, isReferenceInstance
} from './organization-reference.ts';

test('every reference diagram component has sourced responsibility, recommendation and PoC boundaries', () => {
  const ids = [...organizationReferenceMarkup.matchAll(/data-reference="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(new Set(ids), new Set(Object.keys(referenceInstances)));
  assert.equal(ids.length, new Set(ids).size, 'Every selectable instance must appear only once.');
  assert.deepEqual(new Set(Object.values(referenceInstances).map(instance => instance.detail)), new Set(Object.keys(referenceDetails)));
  for (const id of ids) {
    assert.ok(isReferenceInstance(id));
    const item = getReferenceDetail(id);
    for (const value of [item.role, item.documented, item.recommendation, item.demo, item.limitation]) {
      assert.ok(value.length > 20 && value.length < 500);
    }
    assert.ok(item.sources.length);
    for (const source of item.sources) assert.ok(Object.values(referenceSources).includes(source));
  }
});

test('reference separates APIM v2 association from this PoC new tier', () => {
  assert.match(organizationReferenceMarkup, /Foundry’s portal automatic resource\/project association guide uses <strong>APIM v2/);
  assert.match(organizationReferenceMarkup, /not as a prerequisite for Foundry models/);
  assert.match(organizationReferenceMarkup, /supports Foundry backend imports/);
  assert.match(referenceDetails.gateway.documented, /new AI Gateway tier supports Foundry backend imports/);
  assert.match(organizationReferenceMarkup, /new AI Gateway tier \(preview\)/);
  assert.match(organizationReferenceMarkup, /not deployed/);
  assert.match(referenceDetails.foundry.limitation, /not verified.*new AI Gateway tier/);
  assert.match(referenceDetails.gateway.limitation, /no SLA.*gateway-scoped/);
  assert.match(referenceDetails.gateway.limitation, /not demonstrated or assumed/);
});

test('reference shows two shared workload boundaries, not gateway-per-application or serial governance', () => {
  assert.equal((organizationReferenceMarkup.match(/class="reference-boundary"/g) || []).length, 2);
  assert.equal((organizationReferenceMarkup.match(/proposed runtime request path/g) || []).length, 2);
  assert.match(organizationReferenceMarkup, /Projects A \+ B/);
  assert.match(organizationReferenceMarkup, /not an inference hop/);
  assert.match(referenceDetails.boundary.recommendation, /Neither one gateway per app nor one gateway for the whole enterprise/);
  assert.doesNotMatch(organizationReferenceMarkup, /class="[^"]*(?:observed|pending|failed)/);
});

test('resource, project and gateway instances resolve separately with specific boundary context', () => {
  assert.notEqual(getReferenceDetail('foundry-shared').title, getReferenceDetail('foundry-isolated').title);
  assert.notEqual(getReferenceDetail('projects-shared').title, getReferenceDetail('projects-isolated').title);
  assert.equal(getReferenceDetail('gateway-shared').title, 'APIM AI Gateway · shared');
  assert.equal(getReferenceDetail('gateway-isolated').title, 'APIM AI Gateway · isolated');
  assert.equal(getReferenceDetail('boundary-shared').title, 'Shared internal workloads');
  assert.equal(getReferenceDetail('boundary-isolated').title, 'Regulated production workload');
  assert.match(getReferenceDetail('boundary-shared').recommendation, /Share ownership, common policies/);
  assert.match(getReferenceDetail('boundary-isolated').recommendation, /separate Foundry resource and gateway/);
  assert.notEqual(getReferenceDetail('boundary-shared').recommendation, getReferenceDetail('boundary-isolated').recommendation);
  assert.equal(isReferenceInstance('foundry'), false);
  assert.equal(isReferenceInstance('toString'), false);
});

test('projects are nested in Foundry resource containers and governance links are explicit', () => {
  assert.match(organizationReferenceMarkup, /aria-label="Foundry resource 1 contains Projects A \+ B"[\s\S]*?data-reference="foundry-shared"[\s\S]*?class="reference-projects"[\s\S]*?data-reference="projects-shared"[\s\S]*?<\/section>/);
  assert.match(organizationReferenceMarkup, /aria-label="Foundry resource 2 contains Project C"[\s\S]*?data-reference="foundry-isolated"[\s\S]*?class="reference-projects"[\s\S]*?data-reference="projects-isolated"[\s\S]*?<\/section>/);
  assert.equal((organizationReferenceMarkup.match(/class="reference-connection"/g) || []).length, 6);
  for (const id of ['registry-shared', 'registry-isolated', 'identity-shared', 'identity-isolated', 'association-shared', 'association-isolated'] as const) {
    assert.match(organizationReferenceMarkup, new RegExp(`data-reference="${id}"[^>]*not inference traffic`));
    const item = getReferenceDetail(id);
    assert.ok(item.sources.length);
  }
  assert.doesNotMatch(organizationReferenceMarkup, /reference-summary|reference-control-link|Boundary gateway [12]/);
});

test('reference retains licensing, telemetry, MCP and Databricks limits', () => {
  assert.match(referenceDetails.governance.limitation, /licensing.*Frontier.*administrator/);
  assert.match(referenceDetails.governance.limitation, /SDK.*Entra permissions/);
  assert.match(referenceDetails.backends.documented, /without managed OAuth/);
  assert.match(referenceDetails.backends.demo, /APIM → Databricks.*when its published alias is configured.*current-session supported gateway responses prove it/);
  assert.match(referenceDetails.backends.demo, /historical direct Databricks evidence/);
  assert.match(referenceDetails.backends.limitation, /Databricks.*workspace-level, not per-model authorization/);
  assert.match(referenceDetails.applications.demo, /our Node code/);
  assert.match(referenceDetails.applications.limitation, /not dollar budgets/);
});
