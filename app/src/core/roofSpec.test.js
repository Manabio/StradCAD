import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoofSpec, ROOF_SPEC_KEYS, RoofShape, RoofHighSide, RoofRidgeDirection, DEFAULT_ROOF_SLOPE, DEFAULT_ROOF_EAVE_OVERHANG_MM,
  DEFAULT_ROOF_GABLE_OVERHANG_MM, DEFAULT_ROOF_SHEATHING, DEFAULT_ROOF_UNDERLAYMENT,
  ROOF_SHEATHING_CODES, ROOF_UNDERLAYMENT_CODES, isDefaultRoofSpec,
} from '../core.js';
import { NON_DEFAULT_ROOF_SPEC } from '../finish/roofTestFixtures.js';

test('RoofSpec: 既定値は 形状=自動(null)・勾配3・野地板=構造用合板t12・防水=改質アスファルトルーフィング・出幅455/455・自由入力は空', () => {
  const d = new RoofSpec().toData();
  assert.deepEqual(d, {
    shape: null, slope: DEFAULT_ROOF_SLOPE,
    sheathingMaterial: DEFAULT_ROOF_SHEATHING, underlaymentMaterial: DEFAULT_ROOF_UNDERLAYMENT,
    roofFinish: '', eaveOverhangMm: DEFAULT_ROOF_EAVE_OVERHANG_MM, gableOverhangMm: DEFAULT_ROOF_GABLE_OVERHANG_MM,
    soffit: '', note: '', highSide: null, ridgeDirection: null,
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
  assert.equal(ROOF_SPEC_KEYS.length, 11);
  assert.equal(ROOF_SPEC_KEYS[ROOF_SPEC_KEYS.length - 1], 'ridgeDirection', 'ridgeDirection は末尾');
  assert.equal(ROOF_SPEC_KEYS[ROOF_SPEC_KEYS.length - 2], 'highSide');
});

test('不変条件: 全11項目を既定値以外にした RoofSpec は toData→fromData→toData で一致し、各項目が保たれる（出幅0・勾配2.5）', () => {
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

test('highSide: 既定は null（自動）。4値は toData→fromData で保たれ、setField で書き換えられる', () => {
  assert.equal(new RoofSpec().highSide, null);
  for (const highSide of Object.values(RoofHighSide)) {
    assert.equal(RoofSpec.fromData({ highSide }).highSide, highSide);
    assert.equal(new RoofSpec({ highSide }).toData().highSide, highSide);
  }
  const spec = new RoofSpec();
  spec.setField('highSide', RoofHighSide.LEFT);
  assert.equal(spec.highSide, 'left');
});

test('【失敗系】fromData: 未知の highSide は null（自動）へ（欠落・空・非文字列・大文字違いも）', () => {
  for (const v of ['up', 'TOP', '', 3, null, undefined, {}]) {
    assert.equal(RoofSpec.fromData({ highSide: v }).highSide, null, `highSide=${JSON.stringify(v)}`);
  }
});

test('ridgeDirection: 既定は null（自動＝長手）。2値は toData→fromData で保たれ、setField で書き換えられる', () => {
  assert.equal(new RoofSpec().ridgeDirection, null);
  for (const ridgeDirection of Object.values(RoofRidgeDirection)) {
    assert.equal(RoofSpec.fromData({ ridgeDirection }).ridgeDirection, ridgeDirection);
    assert.equal(new RoofSpec({ ridgeDirection }).toData().ridgeDirection, ridgeDirection);
  }
  const spec = new RoofSpec();
  spec.setField('ridgeDirection', RoofRidgeDirection.HORIZONTAL);
  assert.equal(spec.ridgeDirection, 'horizontal');
});

test('【失敗系】fromData: 未知の ridgeDirection は null（自動）へ（欠落・空・非文字列・大文字違い・highSide の値も）', () => {
  for (const v of ['diagonal', 'VERTICAL', '', 3, null, undefined, {}, 'top']) {
    assert.equal(RoofSpec.fromData({ ridgeDirection: v }).ridgeDirection, null, `ridgeDirection=${JSON.stringify(v)}`);
  }
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

// ---- B3: 主屋根の「既定値のときは保存しない」判定（isDefaultRoofSpec） ----
test('isDefaultRoofSpec: 既定値の RoofSpec・その toData()・null/undefined は既定値扱い', () => {
  assert.equal(isDefaultRoofSpec(new RoofSpec()), true);
  assert.equal(isDefaultRoofSpec(new RoofSpec().toData()), true);
  assert.equal(isDefaultRoofSpec(null), true);
  assert.equal(isDefaultRoofSpec(undefined), true);
});

test('isDefaultRoofSpec: 11項目のどれか1つでも既定値と違えば false（ROOF_SPEC_KEYS の全項目で確かめる）', () => {
  for (const key of ROOF_SPEC_KEYS) {
    const spec = new RoofSpec();
    spec.setField(key, NON_DEFAULT_ROOF_SPEC[key]);
    assert.equal(isDefaultRoofSpec(spec), false, `${key} だけ既定外でも false`);
    assert.equal(isDefaultRoofSpec(spec.toData()), false, `${key}（plain）`);
  }
  assert.equal(ROOF_SPEC_KEYS.length, 11);
  assert.equal(isDefaultRoofSpec(new RoofSpec({ highSide: RoofHighSide.TOP })), false, 'highSide だけ明示しても既定外');
  assert.equal(isDefaultRoofSpec(new RoofSpec({ ridgeDirection: RoofRidgeDirection.HORIZONTAL })), false, 'ridgeDirection だけ明示しても既定外');
});

test('isDefaultRoofSpec: 形状を明示すると（自動と同じ見た目の陸屋根でも）既定値ではない。出幅0は既定外', () => {
  assert.equal(isDefaultRoofSpec(new RoofSpec({ shape: RoofShape.FLAT })), false);
  assert.equal(isDefaultRoofSpec(new RoofSpec({ eaveOverhangMm: 0 })), false);
});
