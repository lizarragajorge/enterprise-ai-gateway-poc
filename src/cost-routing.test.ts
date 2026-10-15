import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatedCostLabel, usd } from './cost-routing.ts';

test('small real request costs keep useful precision rather than appearing free', () => {
  assert.equal(usd(0.0000105), '$0.00001050');
  assert.equal(usd(0.000164), '$0.00016400');
  assert.equal(usd(0.00000015), '$0.00000015');
  assert.equal(usd(0), '$0.00000000');
});
test('native/manual returned cost estimates preserve genuine precision and never turn missing usage into free calls', () => {
  assert.equal(estimatedCostLabel(0.0000105), '$0.00001050 USD');
  assert.equal(estimatedCostLabel(0), '$0.00000000 USD');
  for (const value of [null, undefined, NaN, Infinity, -1]) assert.equal(estimatedCostLabel(value), 'Unavailable, not zero');
});
