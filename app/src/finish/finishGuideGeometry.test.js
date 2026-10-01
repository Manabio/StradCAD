// finish/finishGuideGeometry.js の単体テスト。
// 壁は（階段フィクスチャ等を除き）本番の生成関数（generateRoomWallsFromOutline・
// generateExteriorWalls・resolveBackingOwnership）で作る——wallGeneration.test.js と同じ方針。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind } from '@core';
import {
  generateRoomWallsFromOutline, generateExteriorWalls, resolveBackingOwnership,
  computeExteriorWallSegments, closeConvexCorners,
} from './wallGeneration.js';
import { gridDividerSegments } from './gridCells.js';
import { outerWallFaceAt } from './wallFaces.js';
import {
  wallBodyRects, dividerSegmentsOutsideWalls, exteriorGuideSegments,
} from './finishGuideGeometry.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

function addWall(graph, axisCL, axisOffset, isVertical, clStart, startOffset, clEnd, endOffset, props) {
  return graph.addWall(axisCL, axisOffset, isVertical, clStart, startOffset, clEnd, endOffset, props);
}

// ---- 1. 壁0本: 区割り線・外壁判定線とも現行関数と同値 ----
test('壁が無ければ現行のgridDividerSegments/computeExteriorWallSegmentsと同値', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);

  assert.deepEqual(dividerSegmentsOutsideWalls(graph), gridDividerSegments(graph));
  assert.deepEqual(computeExteriorWallSegments(graph), []);
  assert.deepEqual(exteriorGuideSegments(graph), []);
});

// ---- 2. 2室+間仕切り: 間仕切り軸上の線は壁区間だけ消え、壁の無い独立CLは残る ----
test('2室+間仕切り: 間仕切り軸の区割り線は壁区間（下地オーナー壁＋薄壁の帯）だけ消え、壁の無い独立CL・壁端の隙間（T字取り合い）は残る', () => {
  const graph = makeGraph();
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const x2   = graph.addCenterLine(CenterLineType.VERTICAL,   8000, ARCH);
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  // どのセルの境界でもない独立CL（壁が生成されない）
  const xFree = graph.addCenterLine(CenterLineType.VERTICAL, 6000, ARCH);

  const roomA = graph.addRoom(new Set([`${x0.id}:${y0.id}:${xMid.id}:${y1.id}`]), 'A');
  const roomB = graph.addRoom(new Set([`${xMid.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');
  const wallsA = generateRoomWallsFromOutline(graph, roomA);
  const wallsB = generateRoomWallsFromOutline(graph, roomB);
  resolveBackingOwnership(graph, [...wallsA, ...wallsB]);
  closeConvexCorners([...graph.walls]);

  const beforeMid  = gridDividerSegments(graph).filter(s => s.key === xMid.id);
  const beforeFree = gridDividerSegments(graph).find(s => s.key === xFree.id);
  assert.ok(beforeMid.length > 0, '前提: 間仕切り軸に区割り線がある');
  assert.ok(beforeFree, '前提: 壁の無い独立CLにも区割り線がある');

  const after = dividerSegmentsOutsideWalls(graph);
  const midAfter = after.filter(s => s.key.startsWith(`${xMid.id}:`));
  // 間仕切り壁本体の無い両端（上辺・下辺のT字取り合い。壁生成の角チャンファーは厚みぶんだけ
  // 相手側へ入り込むが、通し壁（T字）側は伸びないため57.5mm四方だけ残る——wallJunctionResolve.js
  // が描画時に解決する範囲で、本関数（材の矩形合併）が埋める対象ではない）を除き、
  // 壁に覆われた中央部分は消えるはず。
  assert.deepEqual(midAfter.map(s => [s.lo, s.hi]).sort((a, b) => a[0] - b[0]), [[0, 57.5], [2942.5, 3000]],
    `間仕切り壁本体のある中央部分は消え、角のT字取り合い分だけ残るはず（実際:${JSON.stringify(midAfter)}）`);

  // xFree自身には壁が無い（間仕切りではない）ため「壁区間だけ消える」側の確認——
  // roomBの上辺・下辺壁（横断する壁）を横切る両端だけ削られ、壁の無い中央部分[57.5,2942.5]は残る。
  const afterFree = after.filter(s => s.key.startsWith(`${xFree.id}:`));
  assert.deepEqual(afterFree.map(s => [s.lo, s.hi]), [[57.5, 2942.5]],
    `壁の無い独立CLは、横断する上辺・下辺壁の厚みぶんだけ両端が削られて残るはず（実際:${JSON.stringify(afterFree)}, 元:${JSON.stringify(beforeFree)}）`);
});

// ---- 3. 外壁に突き当たる区割り線の端＝壁の部屋側の面 ----
test('区割り線（内部の独立CL）が外壁に突き当たる両端は、壁の部屋側の面（axisValue）で止まる', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  // 部屋の内部を横切るだけの独立CL（どのセルの境界でもない＝壁は生成されない）
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);

  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room); // DEFAULT_WALL_BASE=90, DEFAULT_WALL_FINISH=12.5 → offset=57.5

  const topWall    = graph.walls.find(w => w.axisCL.id === y0.id);
  const bottomWall = graph.walls.find(w => w.axisCL.id === y1.id);
  assert.ok(topWall && bottomWall, '前提: 上辺・下辺に外周壁が生成される');

  const after = dividerSegmentsOutsideWalls(graph).find(s => s.key === `${xMid.id}:0`);
  assert.ok(after, '独立CLの区割り線が1本残るはず');
  assert.equal(after.lo, topWall.axisValue, '上側の端は上辺壁の室側面（axisValue）で止まるはず');
  assert.equal(after.hi, bottomWall.axisValue, '下側の端は下辺壁の室側面（axisValue）で止まるはず');
});

// ---- 4. 矩形1室の外壁4辺: value=外面+strokeHalf、角の端点が隣辺のvalueと一致 ----
test('矩形1室の外壁4辺: valueは外面からstrokeHalfWidthMmぶん外側、角の端点は隣辺のvalueに揃う', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateExteriorWalls(graph); // DEFAULT_WALL_BASE=90, wallFinish=12.5 → offset=57.5（対称フォールバックで全厚90mm）

  const strokeHalf = 2;
  const segs = exteriorGuideSegments(graph, { strokeHalfWidthMm: strokeHalf });
  assert.equal(segs.length, 4, '矩形1室の外壁は4辺のはず');

  const expected = -(57.5 + strokeHalf); // 対称な正方形なので4辺とも同じ大きさ（符号は各辺の外向き）
  const top    = segs.find(s => s.key.startsWith(`ew${y0.id}:`));
  const left   = segs.find(s => s.key.startsWith(`ew${x0.id}:`));
  assert.ok(top && left, '前提: 上辺・左辺が見つかる');
  assert.equal(Math.abs(top.value),  Math.abs(expected));
  assert.equal(Math.abs(left.value), Math.abs(expected));

  // 角（x=0,y=0）: top の x=0 側の端点は left.value に揃うはず（CL座標(0)のままではない）
  const topStartIsLeftCorner = Math.min(top.start, top.end) === left.value;
  assert.ok(topStartIsLeftCorner, `top辺の左端はleft辺のvalueに揃うはず（top:${JSON.stringify(top)}, left.value:${left.value}）`);
});

// ---- 5. 中庭（屋外部屋）: 外が屋外部屋側になる ----
test('中庭（屋外部屋）: courtyard境界の外向きは屋外部屋側（exteriorGuideSegmentsのvalueも屋外部屋側）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   8000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '室内');
  const exterior = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'テラス');
  exterior.setKind(RoomKind.EXTERIOR);
  generateExteriorWalls(graph);

  const segs = exteriorGuideSegments(graph);
  const courtyard = segs.find(s => s.key.startsWith(`ew${x1.id}:`));
  assert.ok(courtyard, '共有境界(x=4000)にcourtyard境界線があるはず');
  assert.equal(courtyard.loopType, 'courtyard');
  assert.ok(courtyard.value > 4000, `外向きは屋外部屋側（x>4000）のはず（実際:${courtyard.value}）`);
});

// ---- 6. 帯シフト（柱寸105、bandShift 7.5）: 外面がシフト後のaxisValueに追従する ----
test('帯シフト（柱寸105階）: exteriorGuideSegmentsのvalueはCL座標のままではなく、シフトを織り込んだ壁の実面に追従する', () => {
  const BAND_WALL_BASE = 105, BAND_WALL_FINISH = 12.5, BAND_SHIFT = 7.5;
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateExteriorWalls(graph, { wallBase: BAND_WALL_BASE, wallFinish: BAND_WALL_FINISH, bandShift: BAND_SHIFT });

  const segs = exteriorGuideSegments(graph);
  const top = segs.find(s => s.key.startsWith(`ew${y0.id}:`));
  assert.ok(top, '前提: 上辺に外壁判定線がある');
  // 柱寸に関わらず外面(通り芯からの絶対距離)は60+wallFinishで不変（.claude/glossary.md 帯シフト節）
  assert.equal(top.value, -(60 + BAND_WALL_FINISH), 'bandShiftを考慮した壁の実面に一致するはず');
  assert.notEqual(top.value, 0, 'CL座標(0)のままではないはず');
});

// ---- 7. 失敗系: 長さ0の壁・軸CL未解決の壁は無視 ----
test('【失敗系】wallBodyRects: 長さ0の壁・axisCLがnull（未解決）の壁は無視する', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const clSame  = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH); // 長さ0壁用
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, ARCH);

  const zeroLenWall = addWall(graph, axisCL, 57.5, false, clStart, 0, clSame, 0, { wallFinish: 12.5 });
  const unresolved  = addWall(graph, axisCL, -57.5, false, clStart, 0, clEnd, 0, { wallFinish: 12.5 });
  unresolved.axisCL = null; // 軸CL未解決を模す

  assert.equal(Math.min(zeroLenWall.coord1, zeroLenWall.coord2), Math.max(zeroLenWall.coord1, zeroLenWall.coord2),
    '前提: 長さ0の壁');

  const rects = wallBodyRects(graph);
  assert.equal(rects.length, 0, '長さ0・軸CL未解決の壁はどちらも矩形に入らないはず');
});

// ---- 8. outerWallFaceAt 単体: outward±・wallFilter・重なりEPS以下除外 ----
test('outerWallFaceAt: outward>0で最も外側(最大)、outward<0で最も外側(最小)の面を返す', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, ARCH);
  // 2本の壁が同軸・同スパンに重なる（通常はありえないが面の大小比較を単体で見るための構成）。
  // backingDepth:0（下地なし＝仕上げのみの薄壁）でbackingRangeをnullにし、材の範囲をmaterialRangeだけに単純化する。
  const near = addWall(graph, axisCL,  60, false, clStart, 0, clEnd, 0, { wallFinish: 12.5, backingDepth: 0 });
  const far  = addWall(graph, axisCL, 100, false, clStart, 0, clEnd, 0, { wallFinish: 12.5, backingDepth: 0 });
  assert.equal(near.backingRange, null, '前提: backingDepth:0はbackingRangeがnull');

  const faceOutward = outerWallFaceAt(graph, axisCL, { isVertical: false, outward: 1, spanLo: 0, spanHi: 3000 });
  // far の materialRange: thickLo=min(0,100)=0, thickHi=100。near: thickLo=min(0,60)=0, thickHi=60。
  // outward=1（最大）は far の hi=100 のはず。
  assert.equal(faceOutward, Math.max(near.materialRange.hi, far.materialRange.hi));
  assert.equal(faceOutward, 100);

  const faceInward = outerWallFaceAt(graph, axisCL, { isVertical: false, outward: -1, spanLo: 0, spanHi: 3000 });
  assert.equal(faceInward, Math.min(near.materialRange.lo, far.materialRange.lo));
});

test('outerWallFaceAt: wallFilterで除外した壁は face に反映されない', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, ARCH);
  const other = addWall(graph, axisCL, 60, false, clStart, 0, clEnd, 0, { wallFinish: 12.5, isExteriorWall: false });
  addWall(graph, axisCL, 100, false, clStart, 0, clEnd, 0, { wallFinish: 12.5, isExteriorWall: true });

  const face = outerWallFaceAt(graph, axisCL, {
    isVertical: false, outward: 1, spanLo: 0, spanHi: 3000, wallFilter: w => !w.isExteriorWall,
  });
  assert.equal(face, other.materialRange.hi, 'isExteriorWall=trueの壁はwallFilterで除外され、otherの面だけが残るはず');
});

test('【失敗系】outerWallFaceAt: スパンとの重なりがSPAN_OVERLAP_EPS(5mm)以下の壁は除外され、該当なしならnull', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0, ARCH);
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3, ARCH); // 壁長3mm（問い合わせスパンとの重なりが3mm<5mm）
  addWall(graph, axisCL, 60, false, clStart, 0, clEnd, 0, { wallFinish: 12.5 });

  const face = outerWallFaceAt(graph, axisCL, { isVertical: false, outward: 1, spanLo: 0, spanHi: 3000 });
  assert.equal(face, null, '重なりがSPAN_OVERLAP_EPS以下の壁は構成壁とみなされず、該当なしでnullのはず');
});
