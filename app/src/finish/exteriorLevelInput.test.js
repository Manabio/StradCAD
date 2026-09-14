import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlopeInput } from './exteriorLevelInput.js';

test('parseSlopeInput: 正の数字文字列はNumberへ変換される', () => {
  assert.equal(parseSlopeInput('50'), 50);
  assert.equal(parseSlopeInput('1'), 1);
});

test('parseSlopeInput: 空文字は null（勾配指定なし）', () => {
  assert.equal(parseSlopeInput(''), null);
});

test('parseSlopeInput: "0" は null（勾配指定なし。0/1という勾配は無意味なため）', () => {
  assert.equal(parseSlopeInput('0'), null);
});

// ---- 失敗系: 数値化できない・0以下は null ----
test('【失敗系】parseSlopeInput: 数値化できない文字列は null', () => {
  assert.equal(parseSlopeInput('abc'), null);
});

test('【失敗系】parseSlopeInput: 負数文字列は null', () => {
  assert.equal(parseSlopeInput('-5'), null);
});
