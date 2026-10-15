import assert from 'node:assert/strict';
import test from 'node:test';
import { inventory } from './databricks-inventory.ts';

test('Databricks omits repeated fields in an empty inventory', () => {
  assert.deepEqual(inventory({}, 'warehouses'), []);
  assert.deepEqual(inventory({}, 'clusters'), []);
});

test('Databricks inventory retains explicit arrays', () => {
  assert.deepEqual(inventory({ clusters: [] }, 'clusters'), []);
  const clusters = [{ cluster_id: 'example', state: 'TERMINATED' }];
  assert.equal(inventory({ clusters }, 'clusters'), clusters);
});

test('Databricks inventory rejects malformed and unexpected empty shapes', () => {
  for (const value of [null, undefined, [], '', { warehouses: null },
    { warehouses: {} }, { warehouses: false }, { unexpected: [] }]) {
    assert.throws(() => inventory(value, 'warehouses'), /Invalid Databricks/);
  }
});
