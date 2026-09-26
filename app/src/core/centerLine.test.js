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
