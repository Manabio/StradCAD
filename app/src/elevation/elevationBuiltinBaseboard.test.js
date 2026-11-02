// 組込み「巾木 出 10」（detail/detailBuiltins.js・floorWall・高さは param baseboardHeight）が暗黙の既定（S8c）:
// 割当て無し（既定）の出力 ≡ 従来の巾木線 appendBaseboard（フォールバック。明示の参照切れで再現）。
// source 属性（detail）以外は、線の数・座標・線種・途切れまで一致する（部分詳細図 S8a-2 の回帰を S8c で反転）。
// 組込みはカタログの組込み層から引く（overlay 無し）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory, CenterLineType } from '@core';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DETAIL_PRIM_SOURCE, DETAIL_BUILTIN_BASEBOARD_KEY } from '../core/constants.js';
import { detailBuiltinFigures } from '../detail/detailPlacement.js';
import { buildFaceFigure } from './elevationFigure.js';

const KEY = DETAIL_BUILTIN_BASEBOARD_KEY;

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
function build(detailRefs, baseboardHeight = 'h=60') {
  const room = { getFinishInfo: () => ({}), finish: { baseboardHeight }, detailRefs };
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
// 従来の巾木線（appendBaseboard。フォールバック）: 明示の参照切れの割当てで再現する（参照切れは既定へ戻らず従来経路になる）
const legacy = baseboardHeight => build({ [DetailSlot.FLOOR_WALL]: 'df-gone' }, baseboardHeight);
const hLinesAt = (prims, y) => prims.filter(p => p.type === 'line' && p.y1 === y && p.y2 === y);

test('暗黙の既定（割当て無し）≡ 従来の巾木 h=60（source 属性を除いて deepEqual）。巾木線は図の派生線（source=detail）', () => {
  assert.equal(detailBuiltinFigures.some(e => e.key === KEY), true, '組込みが供給されている');
  const base = legacy('h=60');
  const dflt = build(null);
  const baseboardLines = base.filter(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60);
  assert.ok(baseboardLines.length >= 2, `対照: 従来の巾木線が戸・開放スパンで途切れて引かれている（${baseboardLines.length} 本）`);
  assert.ok(baseboardLines.every(p => p.source === undefined), '従来経路は source を付けない');
  assert.equal(dflt.filter(p => p.source === DETAIL_PRIM_SOURCE).length, baseboardLines.length, '派生線の本数＝巾木線の本数');
  assert.deepEqual(withoutSource(dflt), withoutSource(base));
  // 明示の割当て（組込みのキー）も既定と同じ出力
  assert.deepEqual(build({ [DetailSlot.FLOOR_WALL]: KEY }), dflt);
});

test('param 束縛: 巾木の高さは部屋の h に追従する（h=70 で 70 の高さ・従来と同じ）。h 無し・解釈不能は巾木を描かない', () => {
  const dflt70 = build(null, 'h=70');
  assert.equal(hLinesAt(dflt70.filter(p => p.source === DETAIL_PRIM_SOURCE), -70).length >= 2, true);
  assert.equal(hLinesAt(dflt70, -60).length, 0, '固定 60 ではない');
  assert.deepEqual(withoutSource(dflt70), withoutSource(legacy('h=70')));
  for (const none of ['', '自由入力', 'H=0']) {
    const prims = build(null, none);
    assert.equal(prims.filter(p => p.source === DETAIL_PRIM_SOURCE).length, 0, `「${none}」: 派生線なし`);
    assert.deepEqual(prims, legacy(none), `「${none}」: 従来どおり巾木なし`);
  }
});

test('既知の差: 窓台（80）より巾木が高い h=90 では、図の派生線は窓の幅で途切れる（junction の述語）。従来の巾木線は窓の前も通っていた', () => {
  const winRange = p => p.x1 < 3700 && p.x2 > 3300;
  const dflt = hLinesAt(build(null, 'h=90').filter(p => p.source === DETAIL_PRIM_SOURCE), -90);
  const old = hLinesAt(legacy('h=90'), -90);
  assert.equal(dflt.some(winRange), false, '窓（3300〜3700）の高さ 80〜1080 に掛かる 90 の線は窓で切れる');
  assert.equal(old.some(winRange), true, '従来は窓台より高い巾木でも窓の前を通る');
});

test('【失敗系】フォールバック: 既定の組込みが fit 失敗しても従来の巾木線が出る（線が消えない）', () => {
  // 壁厚が引けない面（壁なし）では既定の組込みを fit できない
  const room = { getFinishInfo: () => ({}), finish: { baseboardHeight: 'h=60' }, detailRefs: null };
  const graph = { openings: [door, win], kneeDropWalls: new Map(), shapeMap: new Map([[AXIS_Y0.id, AXIS_Y0]]), walls: [] };
  const prims = buildFaceFigure(face, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
  });
  assert.ok(prims.some(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60), '従来の巾木線');
  assert.equal(prims.filter(p => p.source === DETAIL_PRIM_SOURCE).length, 0);
});

test('【失敗系】存在しない図のキーの明示の割当ては従来の巾木線（source なし）', () => {
  const prims = build({ [DetailSlot.FLOOR_WALL]: 'df-builtin-gone' });
  assert.ok(prims.some(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60 && p.source === undefined));
  assert.equal(prims.filter(p => p.source === DETAIL_PRIM_SOURCE).length, 0);
});
