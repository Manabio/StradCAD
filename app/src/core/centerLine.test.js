// core/centerLine.js の単体テスト（centerLineKind・isGridCenterLine は既存の各所テストで
// 間接的に検証済みのため、本ファイルはBeamAxisOrigin/fillBeamAxisOriginIfUnknownに絞る）。
// originColorKey.test.js と同じ方針: 実物のCenterLineを直接newして検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLine, BeamAxisOrigin, fillBeamAxisOriginIfUnknown } from './centerLine.js';
import { CenterLineType, Discipline } from './constants.js';

function makeCL(props) {
  return new CenterLine('cl-1', CenterLineType.HORIZONTAL, 0, props);
}

test('fillBeamAxisOriginIfUnknown: 梁芯(discipline:fuse)でbeamAxisOrigin未設定(null)ならoriginを書き込みtrueを返す', () => {
  const cl = makeCL({ discipline: Discipline.FUSE });
  const ok = fillBeamAxisOriginIfUnknown(cl, BeamAxisOrigin.WALL);
  assert.equal(ok, true);
  assert.equal(cl.beamAxisOrigin, BeamAxisOrigin.WALL);
});

test('fillBeamAxisOriginIfUnknown: 梁芯で既にbeamAxisOrigin:userがあれば上書きせずfalseを返す', () => {
  const cl = makeCL({ discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER });
  const ok = fillBeamAxisOriginIfUnknown(cl, BeamAxisOrigin.WALL);
  assert.equal(ok, false);
  assert.equal(cl.beamAxisOrigin, BeamAxisOrigin.USER);
});

// 【失敗系】梁芯以外（通り芯・中心線・補助線）には書き込まない
test('【失敗系】fillBeamAxisOriginIfUnknown: 通り芯(labeled:true, discipline:struct)には書き込まずfalseを返す', () => {
  const cl = makeCL({ labeled: true, discipline: Discipline.STRUCT });
  const ok = fillBeamAxisOriginIfUnknown(cl, BeamAxisOrigin.WALL);
  assert.equal(ok, false);
  assert.equal(cl.beamAxisOrigin, null);
});

test('【失敗系】fillBeamAxisOriginIfUnknown: 中心線(既定discipline:arch)には書き込まずfalseを返す', () => {
  const cl = makeCL({});
  const ok = fillBeamAxisOriginIfUnknown(cl, BeamAxisOrigin.WALL);
  assert.equal(ok, false);
  assert.equal(cl.beamAxisOrigin, null);
});

test('【失敗系】fillBeamAxisOriginIfUnknown: 補助線(lineType:dashed)には書き込まずfalseを返す', () => {
  const cl = makeCL({ lineType: 'dashed' });
  const ok = fillBeamAxisOriginIfUnknown(cl, BeamAxisOrigin.WALL);
  assert.equal(ok, false);
  assert.equal(cl.beamAxisOrigin, null);
});

// ---- value の3分岐（undo復帰時アーキ壁ドリフト修正・260929指示書ステップ1） ----
// _value は「絶対座標値」であり続ける前提での value() の分岐を固定する。

test('value: refId無しなら_valueをそのまま返す', () => {
  const cl = new CenterLine('cl-1', CenterLineType.HORIZONTAL, 700, {});
  assert.equal(cl.value, 700);
});

test('value: refIdが解決済み(_referencedCLあり)なら 親.value + refOffset を返す', () => {
  const parent = new CenterLine('parent', CenterLineType.HORIZONTAL, 1000, {});
  const child  = new CenterLine('child', CenterLineType.HORIZONTAL, 999,
    { refId: parent.id, refOffset: 500 });
  child._referencedCL = parent;
  assert.equal(child.value, 1500);
});

test('【失敗系】value: refIdはあるが未解決(_referencedCL無し)なら_valueをそのまま返す（refOffsetを足さない。HEADでは1500+500=2000に化ける＝赤）', () => {
  const child = new CenterLine('child', CenterLineType.HORIZONTAL, 1500,
    { refId: 'ghost-parent', refOffset: 500 });
  // _referencedCL は初期値null（未解決を模す。PlanGraphが解決に失敗したケース）
  assert.equal(child.value, 1500);
});
