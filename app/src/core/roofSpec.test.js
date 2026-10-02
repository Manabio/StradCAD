import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoofSpec, ROOF_SPEC_KEYS, RoofShape, DEFAULT_ROOF_SLOPE, DEFAULT_ROOF_EAVE_OVERHANG_MM,
  DEFAULT_ROOF_GABLE_OVERHANG_MM, DEFAULT_ROOF_SHEATHING, DEFAULT_ROOF_UNDERLAYMENT,
  ROOF_SHEATHING_CODES, ROOF_UNDERLAYMENT_CODES,
} from '../core.js';
import { NON_DEFAULT_ROOF_SPEC } from '../finish/roofTestFixtures.js';

test('RoofSpec: 既定値は 形状=自動(null)・勾配3・野地板=構造用合板t12・防水=改質アスファルトルーフィング・出幅455/455・自由入力は空', () => {
  const d = new RoofSpec().toData();
  assert.deepEqual(d, {
    shape: null, slope: DEFAULT_ROOF_SLOPE,
    sheathingMaterial: DEFAULT_ROOF_SHEATHING, underlaymentMaterial: DEFAULT_ROOF_UNDERLAYMENT,
    roofFinish: '', eaveOverhangMm: DEFAULT_ROOF_EAVE_OVERHANG_MM, gableOverhangMm: DEFAULT_ROOF_GABLE_OVERHANG_MM,
    soffit: '', note: '',
  });
  assert.equal(DEFAULT_ROOF_SLOPE, 3);
  assert.equal(DEFAULT_ROOF_EAVE_OVERHANG_MM, 455);
  assert.equal(DEFAULT_ROOF_GABLE_OVERHANG_MM, 455);
  assert.equal(DEFAULT_ROOF_SHEATHING, '101200000008');
  assert.equal(DEFAULT_ROOF_UNDERLAYMENT, '302000000003');
});

test('不変条件: toData() のキー集合は ROOF_SPEC_KEYS と一致し、全項目を既定値以外にした fixture もキー集合が一致する', () => {
  assert.deepEqual(Object.keys(new RoofSpec().toData()).sort(), [...ROOF_SPEC_KEYS].sort());
  assert.deepEqual(Object.keys(NON_DEFAULT_ROOF_SPEC).sort(), [...ROOF_SPEC_KEYS].sort(),
    'RoofSpec に項目を足したら fixture にも足す');
  assert.equal(ROOF_SPEC_KEYS.length, 9);
});

test('不変条件: 全9項目を既定値以外にした RoofSpec は toData→fromData→toData で一致し、各項目が保たれる（出幅0・勾配2.5）', () => {
  const defaults = new RoofSpec().toData();
  for (const key of ROOF_SPEC_KEYS) {
    assert.notDeepEqual(NON_DEFAULT_ROOF_SPEC[key], defaults[key], `前提: ${key} は既定値と異なる`);
  }
  const restored = RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC);
  assert.deepEqual(restored.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.equal(restored.eaveOverhangMm, 0, '出幅0は正当な値で既定へ読み替えない');
  assert.equal(restored.slope, 2.5);
});

test('RoofSpec.setField: 項目を書き換えられる。未知の項目は throw', () => {
  const spec = new RoofSpec();
  spec.setField('note', '下野');
  spec.setField('shape', RoofShape.FLAT);
  assert.equal(spec.note, '下野');
  assert.equal(spec.shape, RoofShape.FLAT);
  assert.throws(() => spec.setField('unknown', 1), /未知の項目/);
});

test('【失敗系】fromData: 未知の shape は null（自動）へ', () => {
  assert.equal(RoofSpec.fromData({ shape: 'dome' }).shape, null);
  assert.equal(RoofSpec.fromData({ shape: 3 }).shape, null);
  assert.equal(RoofSpec.fromData({ shape: '' }).shape, null);
  for (const shape of Object.values(RoofShape)) assert.equal(RoofSpec.fromData({ shape }).shape, shape);
});

test('【失敗系】fromData: slope が非有限・0以下・数値でないときは既定値3（0.5刻みの2.5は保つ）', () => {
  for (const slope of [0, -1, NaN, Infinity, '3', null, undefined]) {
    assert.equal(RoofSpec.fromData({ slope }).slope, DEFAULT_ROOF_SLOPE, `slope=${String(slope)}`);
  }
  assert.equal(RoofSpec.fromData({ slope: 2.5 }).slope, 2.5);
});

test('【失敗系】fromData: 出幅が負・非有限・数値でないときは既定455。0 は保つ', () => {
  for (const v of [-1, NaN, -Infinity, '455', null, undefined]) {
    const spec = RoofSpec.fromData({ eaveOverhangMm: v, gableOverhangMm: v });
    assert.equal(spec.eaveOverhangMm, DEFAULT_ROOF_EAVE_OVERHANG_MM, `eave=${String(v)}`);
    assert.equal(spec.gableOverhangMm, DEFAULT_ROOF_GABLE_OVERHANG_MM, `gable=${String(v)}`);
  }
  const zero = RoofSpec.fromData({ eaveOverhangMm: 0, gableOverhangMm: 0 });
  assert.equal(zero.eaveOverhangMm, 0);
  assert.equal(zero.gableOverhangMm, 0);
});

test('【失敗系】fromData: 文字列の欠落（undefined・非文字列）は空文字、材料コードの欠落（空・非文字列）は既定コード', () => {
  const spec = RoofSpec.fromData({ roofFinish: undefined, soffit: 5, note: null, sheathingMaterial: '', underlaymentMaterial: undefined });
  assert.equal(spec.roofFinish, '');
  assert.equal(spec.soffit, '');
  assert.equal(spec.note, '');
  assert.equal(spec.sheathingMaterial, DEFAULT_ROOF_SHEATHING);
  assert.equal(spec.underlaymentMaterial, DEFAULT_ROOF_UNDERLAYMENT);
  assert.deepEqual(RoofSpec.fromData(null).toData(), new RoofSpec().toData(), 'null・undefined は既定値');
  assert.deepEqual(RoofSpec.fromData(undefined).toData(), new RoofSpec().toData());
});

test('候補コード表: 野地板は構造用合板5件＋セメント板16件の計21件（重複なし・並びは仕様どおり）、防水シートは4件の指定順。既定値は候補に含まれる', () => {
  assert.equal(ROOF_SHEATHING_CODES.length, 21);
  assert.equal(new Set(ROOF_SHEATHING_CODES).size, 21);
  assert.deepEqual(ROOF_SHEATHING_CODES.slice(0, 5),
    ['101200000007', '101200000008', '101200000009', '101200000010', '101200000011']);
  assert.equal(ROOF_SHEATHING_CODES[5], '301000000021');
  assert.equal(ROOF_SHEATHING_CODES[20], '301000000036');
  assert.deepEqual([...ROOF_UNDERLAYMENT_CODES], ['302000000007', '302000000003', '302000000008', '302000000009']);
  assert.ok(ROOF_SHEATHING_CODES.includes(DEFAULT_ROOF_SHEATHING));
  assert.ok(ROOF_UNDERLAYMENT_CODES.includes(DEFAULT_ROOF_UNDERLAYMENT));
});
