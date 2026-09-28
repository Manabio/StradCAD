import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHAFT_WALL_MATERIAL_CODES } from '@core';
import { shaftWallMaterialOptions } from './shaftWallMaterialOptions.js';

const PANEL_MATERIALS = [
  { code: SHAFT_WALL_MATERIAL_CODES[0], name: 'せっこうボード t=12.5' },
  { code: SHAFT_WALL_MATERIAL_CODES[1], name: '強化せっこうボード t=12.5' },
  { code: SHAFT_WALL_MATERIAL_CODES[2], name: '強化せっこうボード t=12.5+12.5' },
];

test('3択のうちの1つが現在値なら3件で、名称が材マスタから引ける', () => {
  const opts = shaftWallMaterialOptions(SHAFT_WALL_MATERIAL_CODES[0], PANEL_MATERIALS);
  assert.equal(opts.length, 3);
  assert.deepEqual(opts.map(o => o.value), SHAFT_WALL_MATERIAL_CODES);
  assert.equal(opts[0].label, 'せっこうボード t=12.5');
});

test('材マスタ未ロード（空配列）では名称が引けず code をそのまま表示する', () => {
  const opts = shaftWallMaterialOptions(SHAFT_WALL_MATERIAL_CODES[0], []);
  assert.equal(opts.length, 3);
  assert.ok(opts.every(o => o.label === o.value), 'code そのままのラベルになっていない');
});

test('現在値が3択外（カタログ照合で付け替わった値）なら先頭に補われ4件になる', () => {
  const foreignCode = 'ZZZ999999999';
  const opts = shaftWallMaterialOptions(foreignCode, PANEL_MATERIALS);
  assert.equal(opts.length, 4);
  assert.equal(opts[0].value, foreignCode);
  assert.equal(opts[0].label, foreignCode, '材マスタに無いcodeの名称はcodeそのまま');
  assert.deepEqual(opts.slice(1).map(o => o.value), SHAFT_WALL_MATERIAL_CODES);
});

test('現在値が null・\'\' なら3件のまま（先頭に補わない）', () => {
  assert.equal(shaftWallMaterialOptions(null, PANEL_MATERIALS).length, 3);
  assert.equal(shaftWallMaterialOptions('', PANEL_MATERIALS).length, 3);
});
