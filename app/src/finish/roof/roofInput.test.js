import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoofShape, ROOF_SHEATHING_CODES, ROOF_UNDERLAYMENT_CODES, ROOF_SPEC_KEYS } from '@core';
import {
  parseRoofSlopeInput, parseRoofOverhangInput, isValidRoofFieldValue, roofShapeOptions, roofHighSideOptions, roofMaterialOptions,
} from './roofInput.js';

test('parseRoofSlopeInput: 0.5刻みの正の数は有効（3・2.5・0.5・10）', () => {
  assert.equal(parseRoofSlopeInput('3'), 3);
  assert.equal(parseRoofSlopeInput('2.5'), 2.5);
  assert.equal(parseRoofSlopeInput('0.5'), 0.5);
  assert.equal(parseRoofSlopeInput(' 10 '), 10);
  assert.equal(parseRoofSlopeInput('3.0'), 3);
});

test('【失敗系】parseRoofSlopeInput: 0・負・文字・空・0.5刻みでない値は null', () => {
  for (const t of ['0', '0.0', '-1', 'abc', '', ' ', '2.3', '2.75', '1e2', '3寸', '--3', null, undefined]) {
    assert.equal(parseRoofSlopeInput(t), null, `入力=${JSON.stringify(t)}`);
  }
});

test('parseRoofOverhangInput: 0 以上の数は有効（0 も正当）', () => {
  assert.equal(parseRoofOverhangInput('0'), 0);
  assert.equal(parseRoofOverhangInput('455'), 455);
  assert.equal(parseRoofOverhangInput('300.5'), 300.5);
});

test('【失敗系】parseRoofOverhangInput: 負・文字・空は null', () => {
  for (const t of ['-1', '-0.5', 'abc', '', ' ', '4 55', null, undefined]) {
    assert.equal(parseRoofOverhangInput(t), null, `入力=${JSON.stringify(t)}`);
  }
});

test('isValidRoofFieldValue: 全10項目それぞれの正常値と不正値', () => {
  for (const v of ['top', 'bottom', 'left', 'right']) assert.ok(isValidRoofFieldValue('highSide', v), v);
  assert.ok(!isValidRoofFieldValue('highSide', null), '「自動」へ戻す入口は無い（shape と同じ）');
  for (const v of ['up', 'TOP', '', 0, undefined]) assert.ok(!isValidRoofFieldValue('highSide', v), String(v));
  assert.ok(isValidRoofFieldValue('shape', RoofShape.FLAT));
  assert.ok(!isValidRoofFieldValue('shape', null), '「自動」へ戻す入口は無い');
  assert.ok(!isValidRoofFieldValue('shape', 'dome'));
  assert.ok(isValidRoofFieldValue('slope', 2.5));
  assert.ok(!isValidRoofFieldValue('slope', 0));
  assert.ok(!isValidRoofFieldValue('slope', 2.3));
  assert.ok(!isValidRoofFieldValue('slope', '3'));
  for (const f of ['eaveOverhangMm', 'gableOverhangMm']) {
    assert.ok(isValidRoofFieldValue(f, 0));
    assert.ok(!isValidRoofFieldValue(f, -1));
    assert.ok(!isValidRoofFieldValue(f, NaN));
    assert.ok(!isValidRoofFieldValue(f, '455'));
  }
  for (const f of ['sheathingMaterial', 'underlaymentMaterial']) {
    assert.ok(isValidRoofFieldValue(f, '101200000008'));
    assert.ok(!isValidRoofFieldValue(f, ''));
    assert.ok(!isValidRoofFieldValue(f, null));
  }
  for (const f of ['roofFinish', 'soffit', 'note']) {
    assert.ok(isValidRoofFieldValue(f, ''));
    assert.ok(isValidRoofFieldValue(f, '自由入力'));
    assert.ok(!isValidRoofFieldValue(f, 5));
  }
  assert.ok(!isValidRoofFieldValue('unknown', 'x'));
  // 全キーに判定がある（ROOF_SPEC_KEYS の取りこぼし検出）
  const sample = { shape: 'mono', slope: 3, sheathingMaterial: 'a', underlaymentMaterial: 'b', roofFinish: '', eaveOverhangMm: 0, gableOverhangMm: 0, soffit: '', note: '', highSide: 'top' };
  for (const key of ROOF_SPEC_KEYS) assert.ok(isValidRoofFieldValue(key, sample[key]), key);
});

test('roofShapeOptions: 5形状（片流れ・切妻・寄棟・棟違い・陸屋根）の並びで「自動」は出さない', () => {
  assert.deepEqual(roofShapeOptions().map(o => o.label), ['片流れ', '切妻', '寄棟', '棟違い', '陸屋根']);
  assert.deepEqual(roofShapeOptions().map(o => o.value), ['mono', 'gable', 'hip', 'staggered', 'flat']);
});

test('roofHighSideOptions: 上・下・左・右の並びで「自動」は出さない', () => {
  assert.deepEqual(roofHighSideOptions().map(o => o.label), ['上', '下', '左', '右']);
  assert.deepEqual(roofHighSideOptions().map(o => o.value), ['top', 'bottom', 'left', 'right']);
});

test('roofMaterialOptions: 候補コードの並びで名前を引く。解決できないコードは名前の代わりにコードを表示', () => {
  const names = { '302000000007': 'アスファルトルーフィング', '302000000003': '改質アスファルトルーフィング' };
  const opts = roofMaterialOptions(ROOF_UNDERLAYMENT_CODES, '302000000003', code => names[code]);
  assert.deepEqual(opts.map(o => o.value), [...ROOF_UNDERLAYMENT_CODES]);
  assert.equal(opts[0].label, 'アスファルトルーフィング');
  assert.equal(opts[2].label, '302000000008', '名前が引けなければコードを表示');
  assert.equal(roofMaterialOptions(ROOF_SHEATHING_CODES, '101200000008', () => null).length, 21);
});

test('【失敗系】roofMaterialOptions: 保存コードが候補に無い（付け替え・未解決）ときは先頭へ補って値を失わない', () => {
  const opts = roofMaterialOptions(ROOF_SHEATHING_CODES, '999999999999', () => undefined);
  assert.equal(opts.length, 22);
  assert.deepEqual(opts[0], { value: '999999999999', label: '999999999999' });
  // 候補内のコードなら補わない
  assert.equal(roofMaterialOptions(ROOF_SHEATHING_CODES, '301000000023', () => undefined).length, 21);
  // 現在値が空・null でも例外にならない
  assert.equal(roofMaterialOptions(ROOF_SHEATHING_CODES, null, () => undefined).length, 21);
});
