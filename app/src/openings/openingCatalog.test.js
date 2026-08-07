import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOpeningHeight, defaultMaterialGlassFor, FIXTURE_SYMBOLS } from './openingCatalog.js';

test('defaultOpeningHeight: カタログに存在する種別はdefaultHeightを返す', () => {
  assert.equal(defaultOpeningHeight('window', 'doubleSliding'), 1170);
  assert.equal(defaultOpeningHeight('fitting', 'singleSwing'), 2000);
});

test('defaultOpeningHeight: 未知のsubTypeはカテゴリ既定へフォールバック', () => {
  assert.equal(defaultOpeningHeight('window', 'unknownType'), 1100);
  assert.equal(defaultOpeningHeight('fitting', 'unknownType'), 2000);
});

// ---- 建具表「材料・ガラス」の記号別初期値 ----
test('defaultMaterialGlassFor: 記号ごとの初期値を返す', () => {
  assert.equal(defaultMaterialGlassFor('AW'), 'アルミ');
  assert.equal(defaultMaterialGlassFor('AD'), 'アルミ');
  assert.equal(defaultMaterialGlassFor('WD'), 'ポリ合板フラッシュ戸、木製枠');
  assert.equal(defaultMaterialGlassFor('WW'), '木製');
  assert.equal(defaultMaterialGlassFor('JW'), '樹脂');
  assert.equal(defaultMaterialGlassFor('SW'), 'スチール');
  assert.equal(defaultMaterialGlassFor('SD'), 'スチール');
});

test('defaultMaterialGlassFor: 未知の記号はnull', () => {
  assert.equal(defaultMaterialGlassFor('XX'), null);
});

test('FIXTURE_SYMBOLS: WW（木製窓）が窓カテゴリに存在する', () => {
  const ww = FIXTURE_SYMBOLS.find(f => f.key === 'WW');
  assert.ok(ww);
  assert.equal(ww.category, 'window');
});
