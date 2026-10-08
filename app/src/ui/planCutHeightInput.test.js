import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanCutHeightInput } from './planCutHeightInput.js';

test('parsePlanCutHeightInput: 正の数は数値で返す（小数・前後空白も可）', () => {
  assert.equal(parsePlanCutHeightInput('1500'), 1500);
  assert.equal(parsePlanCutHeightInput(' 1200.5 '), 1200.5);
});

test('【失敗系】parsePlanCutHeightInput: 空・0・負・非数・無限大は null（確定不可）', () => {
  for (const bad of ['', '  ', '0', '-10', 'abc', '12abc', 'NaN', 'Infinity']) {
    assert.equal(parsePlanCutHeightInput(bad), null, `入力 "${bad}"`);
  }
});
