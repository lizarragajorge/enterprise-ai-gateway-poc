import assert from 'node:assert/strict';
import test from 'node:test';
import { databricksText } from './databricks-response.ts';

test('Databricks model text supports plain and structured responses', () => {
  assert.equal(databricksText('READY'), 'READY');
  assert.equal(databricksText([
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Not output' }] },
    { type: 'text', text: 'REA' }, { type: 'text', text: 'DY' }
  ]), 'READY');
});

test('Databricks reasoning alone and malformed output never establish success', () => {
  for (const value of [undefined, null, '', '  ', [], [{ type: 'reasoning' }],
    [{ type: 'text', text: '' }], [{ type: 'text', text: 123 }],
    [{ type: 'unknown', text: 'READY' }], [null]]) {
    assert.throws(() => databricksText(value), /Databricks/);
  }
});
