// 組込み「巾木 10×60」（detail/detailBuiltins.js・floorWall）の割当て出力 ≡ 既存の巾木線（baseboardHeight "h=60"）。
// source 属性（detail）以外は、線の数・座標・線種・途切れまで一致する（部分詳細図 S8a-2 の回帰）。
// 組込みはカタログの組込み層から引く（overlay 無し）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory, CenterLineType } from '@core';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { detailBuiltinFigures } from '../detail/detailPlacement.js';
import { buildFaceFigure } from './elevationFigure.js';

const KEY = 'df-builtin-baseboard-10x60';

test.afterEach(() => clearOverlays());

const AXIS_Y0 = { id: 'axisY0', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 };
const wall = { axisCL: AXIS_Y0, isVertical: false, coord1: 0, coord2: 4000, materialRange: { lo: 0, hi: 100 }, backingRange: null };
const door = { id: 'd', isVertical: false, axisCL: { id: 'axisY0' }, centerCoord: 500, width: 800, height: 2000, sillHeight: 0, category: OpeningCategory.FITTING, subType: 'singleSwing' };
const win = { id: 'w', isVertical: false, axisCL: { id: 'axisY0' }, centerCoord: 3500, width: 400, height: 1000, sillHeight: 80, category: OpeningCategory.WINDOW, subType: 'fixed' };
const face = {
  axisCL: AXIS_Y0, isVertical: false, inward: 1, faceValue: 0, lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0,
  startCLId: 'x0', endCLId: 'x1',
  spans: [{ loX: 0, hiX: 2800, kind: 'wall' }, { loX: 2800, hiX: 3000, kind: 'open', farFloorDeltaMm: 0, farCeilAbsMm: 2400 }, { loX: 3000, hiX: 4000, kind: 'wall' }],
};
function build(detailRefs) {
  const room = { getFinishInfo: () => ({}), finish: { baseboardHeight: 'h=60' }, detailRefs };
  const graph = { openings: [door, win], kneeDropWalls: new Map(), shapeMap: new Map([[AXIS_Y0.id, AXIS_Y0]]), walls: [wall] };
  return buildFaceFigure(face, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
  });
}
const withoutSource = prims => prims.map(p => {
  const rest = { ...p };
  delete rest.source;
  return rest;
});

test('組込み 10×60 の割当て ≡ 既存の巾木 h=60（source 属性を除いて deepEqual）', () => {
  assert.equal(detailBuiltinFigures.some(e => e.key === KEY), true, '組込みが供給されている');
  const base = build(null);
  const assigned = build({ [DetailSlot.FLOOR_WALL]: KEY });
  const baseboardLines = base.filter(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60);
  assert.ok(baseboardLines.length >= 2, `対照: 既存の巾木線が戸・開放スパンで途切れて引かれている（${baseboardLines.length} 本）`);
  assert.equal(assigned.filter(p => p.source === DETAIL_PRIM_SOURCE).length, baseboardLines.length, '派生線の本数＝巾木線の本数');
  assert.deepEqual(withoutSource(assigned), withoutSource(base));
});

test('【失敗系】存在しない図のキーの割当ては従来の巾木線のまま（source を含めて byte 一致）', () => {
  assert.deepEqual(build({ [DetailSlot.FLOOR_WALL]: 'df-builtin-gone' }), build(null));
});
