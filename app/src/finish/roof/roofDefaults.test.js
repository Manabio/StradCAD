import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Room, RoomKind, RoomFeature, RoofSpec, RoofShape, ROOF_SPEC_KEYS, ROOF_MONO_MAX_SHORT_SPAN_MM,
  DEFAULT_ROOF_NOTE,
} from '@core';
import { createRoofSpec, createLeanToRoofSpec, resolveRoofShape, restoreRoofSpecInto, roofRoomBounds } from './roofDefaults.js';
import { buildRoofLayout, NON_DEFAULT_ROOF_SPEC } from '../roofTestFixtures.js';

const rect = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

test('createRoofSpec: 既定値一式（形状=自動・勾配3・野地板=構造用合板t12・防水=改質アスファルトルーフィング・出幅455/455・自由入力は空）', () => {
  const spec = createRoofSpec();
  assert.deepEqual(spec.toData(), {
    shape: null, slope: 3, sheathingMaterial: '101200000008', underlaymentMaterial: '302000000003',
    roofFinish: '', eaveOverhangMm: 455, gableOverhangMm: 455, soffit: '', note: '',
  });
  assert.ok(spec instanceof RoofSpec);
});

test('createRoofSpec({ note }): 備考だけが入る。下屋の既定（createLeanToRoofSpec）は備考「下野」', () => {
  assert.equal(createRoofSpec({ note: 'メモ' }).note, 'メモ');
  assert.equal(createLeanToRoofSpec().note, '下野');
  assert.equal(DEFAULT_ROOF_NOTE, '下野');
  assert.deepEqual({ ...createLeanToRoofSpec().toData(), note: '' }, createRoofSpec().toData());
});

test('resolveRoofShape: 短手が 3640 以下なら片流れ、超えれば切妻（ちょうど 3640 は片流れ）', () => {
  assert.equal(ROOF_MONO_MAX_SHORT_SPAN_MM, 3640);
  const spec = createRoofSpec();
  assert.equal(resolveRoofShape(spec, { boundsList: [rect(0, 0, 9000, 3640)] }), RoofShape.MONO);
  assert.equal(resolveRoofShape(spec, { boundsList: [rect(0, 0, 9000, 3641)] }), RoofShape.GABLE);
  assert.equal(resolveRoofShape(spec, { boundsList: [rect(0, 0, 9000, 1820)] }), RoofShape.MONO);
});

test('resolveRoofShape: 明示された形状（陸屋根を含む）は範囲に関係なくそのまま', () => {
  const big = [rect(0, 0, 9000, 9000)];
  for (const shape of Object.values(RoofShape)) {
    assert.equal(resolveRoofShape(new RoofSpec({ shape }), { boundsList: big }), shape);
  }
  assert.equal(resolveRoofShape(new RoofSpec({ shape: RoofShape.MONO }), { boundsList: big }), RoofShape.MONO);
});

test('resolveRoofShape: rules.mainRoofDefaultShape があれば自動のときそれを使う（主屋根用の引数口）。明示値が優先', () => {
  const big = [rect(0, 0, 9000, 9000)];
  assert.equal(resolveRoofShape(createRoofSpec(), { boundsList: big, rules: { mainRoofDefaultShape: RoofShape.FLAT } }), RoofShape.FLAT);
  assert.equal(resolveRoofShape(createRoofSpec(), { boundsList: big, rules: { mainRoofDefaultShape: null } }), RoofShape.GABLE);
  assert.equal(resolveRoofShape(new RoofSpec({ shape: RoofShape.HIP }), { boundsList: big, rules: { mainRoofDefaultShape: RoofShape.FLAT } }), RoofShape.HIP);
});

test('【失敗系】resolveRoofShape: 範囲が空（セルが消失した等）でも例外にならず片流れ（短手0）', () => {
  assert.equal(resolveRoofShape(createRoofSpec(), { boundsList: [] }), RoofShape.MONO);
  assert.equal(resolveRoofShape(createRoofSpec()), RoofShape.MONO);
  assert.equal(resolveRoofShape(null, { boundsList: [] }), RoofShape.MONO);
});

test('roofRoomBounds: 屋根の部屋のセルを現在の格子で矩形群に解決する（band 配置の屋根セル 4000x1500）', () => {
  const { graph, extra } = buildRoofLayout('band', 'roof');
  const bounds = roofRoomBounds(extra, graph);
  assert.equal(bounds.length, 1);
  assert.deepEqual(bounds[0], rect(4000, 0, 8000, 1500));
});

// ---- restoreRoofSpecInto（復元側の I1） ----

function makeRoom(feature) {
  return new Room('r1', '屋根', new Set(), new Set(), RoomKind.EXTERIOR, null, feature);
}

test('restoreRoofSpecInto: ROOF の部屋に plain があれば RoofSpec.fromData で復元する（全項目）', () => {
  const room = makeRoom(RoomFeature.ROOF);
  restoreRoofSpecInto(room, NON_DEFAULT_ROOF_SPEC);
  assert.deepEqual(room.roofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.deepEqual(Object.keys(room.roofSpec.toData()).sort(), [...ROOF_SPEC_KEYS].sort());
});

test('restoreRoofSpecInto: ROOF の部屋で plain が欠けていれば既定値（備考「下野」）で補う', () => {
  for (const plain of [null, undefined]) {
    const room = makeRoom(RoomFeature.ROOF);
    restoreRoofSpecInto(room, plain);
    assert.deepEqual(room.roofSpec.toData(), createLeanToRoofSpec().toData());
    assert.equal(room.roofSpec.note, '下野');
  }
});

test('【失敗系】restoreRoofSpecInto: ROOF でない部屋に plain が付いていても捨てる（I1）', () => {
  for (const feature of [null, RoomFeature.STAIR, RoomFeature.UNDEFINED]) {
    const room = makeRoom(feature);
    restoreRoofSpecInto(room, NON_DEFAULT_ROOF_SPEC);
    assert.equal(room.roofSpec, null, `feature=${String(feature)}`);
  }
});

test('【失敗系】restoreRoofSpecInto: 壊れた plain は正規化される（未知の shape・負の出幅）', () => {
  const room = makeRoom(RoomFeature.ROOF);
  restoreRoofSpecInto(room, { ...NON_DEFAULT_ROOF_SPEC, shape: 'dome', eaveOverhangMm: -5, slope: 0 });
  assert.equal(room.roofSpec.shape, null);
  assert.equal(room.roofSpec.eaveOverhangMm, 455);
  assert.equal(room.roofSpec.slope, 3);
});

test('Room.setFeature: ROOF 以外へ変えると roofSpec を捨てる（I1）。ROOF のままなら保つ', () => {
  const room = makeRoom(RoomFeature.ROOF);
  room.setRoofSpec(createLeanToRoofSpec());
  room.setFeature(RoomFeature.ROOF);
  assert.ok(room.roofSpec, 'ROOF のまま再設定しても roofSpec は保たれる');
  room.setFeature(null);
  assert.equal(room.roofSpec, null);
});
