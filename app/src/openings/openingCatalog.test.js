import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSillHeight, defaultOpeningHeight } from './openingCatalog.js';

test('parseSillHeight: 窓カテゴリで空欄は null（0ではない。未設定と0mmを区別する）', () => {
  assert.equal(parseSillHeight('', true), null);
  assert.equal(parseSillHeight('   ', true), null);
});

test('parseSillHeight: 窓カテゴリでない場合は入力値に関わらず null', () => {
  assert.equal(parseSillHeight('800', false), null);
  assert.equal(parseSillHeight('', false), null);
});

test('parseSillHeight: 窓カテゴリで数値文字列は絶対値の数値を返す', () => {
  assert.equal(parseSillHeight('800', true), 800);
  assert.equal(parseSillHeight('-100', true), 100);
  assert.equal(parseSillHeight('0', true), 0);
});

test('parseSillHeight: 窓カテゴリで不正入力（非数値）は0（幅・位置と同じ変換規約）', () => {
  assert.equal(parseSillHeight('abc', true), 0);
});

test('defaultOpeningHeight: カタログに存在する種別はdefaultHeightを返す', () => {
  assert.equal(defaultOpeningHeight('window', 'doubleSliding'), 1170);
  assert.equal(defaultOpeningHeight('fitting', 'singleSwing'), 2000);
});

test('defaultOpeningHeight: 未知のsubTypeはカテゴリ既定へフォールバック', () => {
  assert.equal(defaultOpeningHeight('window', 'unknownType'), 1100);
  assert.equal(defaultOpeningHeight('fitting', 'unknownType'), 2000);
});
