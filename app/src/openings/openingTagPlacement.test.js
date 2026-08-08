// openingRoomLabel.test.js と同じ方針: worldToCell的な壁トポロジー判定はダックタイピングでは
// 再現できないため、実 core.js（Plane/PlanGraph）を使う。LodLevel は本体・テストとも viewport.js
// から import する（viewport.js は mobx と @core しか引かず純モジュール制約に抵触しない。
// 前例: finish/stair/stairEntries.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { LodLevel } from '../viewport.js';
import { wallFaceRange } from './openingGeometry.js';
import {
  shouldShowOpeningTags, roomSideDir, openingTagAnchor, wallObstacleRects, layoutOpeningTags,
} from './openingTagPlacement.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

function approxEqual(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `期待値 ${b} に対し実際は ${a}（差 ${Math.abs(a - b)}）`);
}

const RADIUS = 100, GAP = 20; // 個別テストのデフォルト（テストごとに上書きする場合あり）

// ================================================================
// shouldShowOpeningTags
// ================================================================

test('shouldShowOpeningTags: floorplanはDETAILのみ、openingはSTANDARD・DETAILのみ表示', () => {
  assert.equal(shouldShowOpeningTags('floorplan', LodLevel.SCHEMATIC), false);
  assert.equal(shouldShowOpeningTags('floorplan', LodLevel.STANDARD), false);
  assert.equal(shouldShowOpeningTags('floorplan', LodLevel.DETAIL), true);
  assert.equal(shouldShowOpeningTags('opening', LodLevel.SCHEMATIC), false);
  assert.equal(shouldShowOpeningTags('opening', LodLevel.STANDARD), true);
  assert.equal(shouldShowOpeningTags('opening', LodLevel.DETAIL), true);
  assert.equal(shouldShowOpeningTags('finish', LodLevel.DETAIL), false, '対象外モードは常にfalse');
  assert.equal(shouldShowOpeningTags('structure', LodLevel.DETAIL), false);
});

// F4回帰: SceneLayers側の外側ゲートを削除し shouldShowOpeningTags を唯一の判定にしたため、
// 未知のappModeでも安全にfalseを返すことを保証する（表示レイヤーが常時マウントされるようになるため）。
test('shouldShowOpeningTags: 未知のappMode（figure等）は常にfalse', () => {
  assert.equal(shouldShowOpeningTags('figure', LodLevel.DETAIL), false);
  assert.equal(shouldShowOpeningTags('site', LodLevel.DETAIL), false);
});

// ================================================================
// openingTagAnchor（offsetアンカー）: 符号回帰
// ================================================================

// 単一の垂直壁（axisCL=1000, axisOffset=100）に窓を1つ置く共通セットアップ。
// isExteriorWall だけを差し替えて比較する。
function makeSingleWallWindow(graph, isExteriorWall) {
  const xCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(xCL, 100, true, y0, 0, y1, 0, { isExteriorWall });
  const opening = graph.addOpening(xCL, 1, true, y0, 2000, 400, OpeningCategory.WINDOW, 'doubleSliding', {});
  return { wall, opening };
}

test('openingTagAnchor: 外壁の窓は記号丸が室内側・壁面から radius+gap 離れる（符号回帰）', () => {
  const graph = makeGraph();
  const { wall, opening } = makeSingleWallWindow(graph, true);
  const [faceLo] = wallFaceRange(wall, graph);

  const dir = roomSideDir(opening, wall);
  const anchor = openingTagAnchor(opening, wall, graph, { radiusMm: RADIUS, gapMm: GAP });

  assert.equal(dir, -1, '外壁は仕上げ面方向(faceDir=+1)の逆側が室内側になるはず');
  approxEqual(anchor.x, faceLo - (RADIUS + GAP)); // 室内側(faceLo方向)へ radius+gap 離れた位置になるはず
  assert.equal(anchor.y, opening.centerCoord);
  assert.equal(anchor.kind, 'offset');
});

test('openingTagAnchor: 内壁の窓は外壁と逆側（faceDirそのまま）に配置される', () => {
  const graph = makeGraph();
  const { wall, opening } = makeSingleWallWindow(graph, false);
  const [, faceHi] = wallFaceRange(wall, graph);

  const dir = roomSideDir(opening, wall);
  const anchor = openingTagAnchor(opening, wall, graph, { radiusMm: RADIUS, gapMm: GAP });

  assert.equal(dir, 1, '内壁は仕上げ面方向(faceDir)がそのまま部屋内側になるはず');
  approxEqual(anchor.x, faceHi + (RADIUS + GAP));
  // 外壁版（同じ axisOffset）とは軸CL(x=1000)を挟んで反対側になる
  assert.ok(anchor.x > 1000, '内壁版は軸CLより外側(+x)');
});

// ================================================================
// openingTagAnchor（sectorアンカー・開き戸）
// ================================================================

function makeSingleSwingDoor(graph, { hingeSide = -1, swingSide = 1 } = {}) {
  const xCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(xCL, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  const opening = graph.addOpening(xCL, 1, true, y0, 1000, 800, OpeningCategory.FITTING, 'singleSwing', { hingeSide, swingSide });
  return { wall, opening };
}

test('openingTagAnchor: 開き戸は hinge + 0.6*width の二等分角方向に配置される', () => {
  const graph = makeGraph();
  const { wall, opening } = makeSingleSwingDoor(graph, { hingeSide: -1, swingSide: 1 });
  const anchor = openingTagAnchor(opening, wall, graph, { radiusMm: RADIUS, gapMm: GAP });

  // hingeSide=-1 → hingeAlong=coord1、isVertical・towardFar>0 → closedAngle=90、bisector=90+45=135°
  const rad = (135 * Math.PI) / 180;
  const hinge = { x: wall.axisValue, y: opening.coord1 };
  approxEqual(anchor.x, hinge.x + 0.6 * opening.width * Math.cos(rad));
  approxEqual(anchor.y, hinge.y + 0.6 * opening.width * Math.sin(rad));
  assert.equal(anchor.kind, 'sector');
});

test('openingTagAnchor: swingSide反転で二等分角が軸対称の位置に移る', () => {
  const graph = makeGraph();
  const { wall: wallPos, opening: openingPos } = makeSingleSwingDoor(graph, { hingeSide: -1, swingSide: 1 });
  const anchorPos = openingTagAnchor(openingPos, wallPos, graph, { radiusMm: RADIUS, gapMm: GAP });

  const graph2 = makeGraph('p2');
  const { wall: wallNeg, opening: openingNeg } = makeSingleSwingDoor(graph2, { hingeSide: -1, swingSide: -1 });
  const anchorNeg = openingTagAnchor(openingNeg, wallNeg, graph2, { radiusMm: RADIUS, gapMm: GAP });

  // swingSide=1→bisector135°、swingSide=-1→bisector45°。closedAngle(90°)を挟んで対称。
  const hinge = { x: wallPos.axisValue, y: openingPos.coord1 };
  assert.ok(Math.abs((anchorPos.y - hinge.y) - (anchorNeg.y - hinge.y)) < 1, 'along方向(y)はほぼ同じ位置になるはず');
  assert.notEqual(anchorPos.x, anchorNeg.x, 'x方向は対称の別位置になるはず');
});

// ================================================================
// layoutOpeningTags: ドア円弧AABBの反転
// ================================================================

// 垂直壁の開き戸1（コーナー）と水平壁の開き戸2が同じ角で交差するよう配置し、AABB衝突を起こす。
function makeCornerDoors() {
  const graph = makeGraph();
  const xCL   = graph.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const xA    = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const xB    = graph.addCenterLine(CenterLineType.VERTICAL,   1400, { labeled: false, discipline: Discipline.ARCH });
  const y0    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1    = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });

  const wall1 = graph.addWall(xCL, 0, true,  y0, 0, y1, 0, { isExteriorWall: false }); // 垂直壁
  const wall2 = graph.addWall(y0,  0, false, xA, 0, xB, 0, { isExteriorWall: false }); // 水平壁

  // door1: 垂直壁, hingeAlong=coord1=0 → hinge=(1000,0), R=400, swingSide=1 → bisector135°
  const door1 = graph.addOpening(xCL, 1, true,  y0, 200, 400, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide: 1 });
  // door2: 水平壁, refCL=xCL, refOffset=-300 → centerCoord=700, coord1=500, hinge=(500,0), R=400, swingSide=1 → bisector45°
  const door2 = graph.addOpening(y0, 1, false, xCL, -300, 400, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide: 1 });

  return { graph, wall1, wall2, door1, door2 };
}

test('layoutOpeningTags: 円弧AABBが重なる開き戸2件は後の1件が壁軸で反転する', () => {
  const { graph, wall1, door1, door2 } = makeCornerDoors();
  const results = layoutOpeningTags(graph, { radiusMm: 100, gapMm: 20, stepMm: 220 });

  const r1 = results.find(r => r.openingId === door1.id);
  const r2 = results.find(r => r.openingId === door2.id);

  // ソート順は [isVertical, axisValue, centerCoord, id] 昇順。isVertical=false(door2)が先、
  // isVertical=true(door1)が後 → door1側が反転対象になる。
  assert.equal(r2.flipped, false, '先に処理される水平壁側は反転しない');
  assert.equal(r1.flipped, true, '後に処理される垂直壁側が反転するはず');

  // 反転前アンカー(手計算): hinge=(1000,0), bisector135°
  const rad = (135 * Math.PI) / 180;
  const beforeX = wall1.axisValue + 0.6 * door1.width * Math.cos(rad);
  const beforeY = 0 + 0.6 * door1.width * Math.sin(rad);
  approxEqual(r1.x, 2 * wall1.axisValue - beforeX, 1, 'x は壁軸で鏡映されるはず');
  approxEqual(r1.y, beforeY, 1, 'y（along方向）は反転で変化しないはず');
});

// F1回帰: 円弧反転は位置だけでなくu/v基底も鏡映しなければならない。鏡映しないと格子探索が
// 元の（壁・扉側へ戻る）方向へ退避してしまう——反転後アンカー位置に障害物壁を置き、退避後の
// 採用位置が反転前の開口(door1)からより離れる側になることを確認する。
// （u/v鏡映を外すと退避方向が反転し、door1からの距離が縮む側に採用されてしまい失敗する）
test('layoutOpeningTags: 反転した開口の格子探索はu/vも鏡映した向きへ退避する（壁・扉側へ戻らない）', () => {
  const graph = makeGraph();
  const xCL    = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const xBlock = graph.addCenterLine(CenterLineType.VERTICAL, 1119.7, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 200000, { labeled: false, discipline: Discipline.ARCH });

  graph.addWall(xCL, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  // 反転後アンカー(1169.7, 1269.7)をちょうど塞ぐ障害物壁: materialRange=[1119.7,1219.7]
  graph.addWall(xBlock, 100, true, y0, 0, y1, 0, { isExteriorWall: false });

  // door1・door2は同一壁上でAABBが重なる（door2はcenterCoordが大きい＝ソート順で後）→ door2が反転する。
  const door1 = graph.addOpening(xCL, 1, true, y0, 1000, 400, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide: 1 }, 'door1');
  const door2 = graph.addOpening(xCL, 1, true, y0, 1300, 400, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide: 1 }, 'door2');

  const radiusMm = 100, gapMm = 20, stepMm = 220;
  const results = layoutOpeningTags(graph, { radiusMm, gapMm, stepMm });
  const r1 = results.find(r => r.openingId === door1.id);
  const r2 = results.find(r => r.openingId === door2.id);

  assert.equal(r2.flipped, true, 'door2が反転するはず');
  assert.equal(r2.placed, true);

  const distAfter = Math.hypot(r1.x - r2.x, r1.y - r2.y);
  // u/vを鏡映しない場合（バグ）はdoor1により近い側（実測 ≈515.6mm）へ退避してしまう。
  // 鏡映する場合（修正後）はdoor1からより離れる側（実測 ≈672.7mm）へ退避する。
  assert.ok(distAfter > 600,
    `反転後の格子探索はdoor1からより離れる側へ退避するはず（実測距離 ${distAfter}）`);
});

// ================================================================
// layoutOpeningTags: 近接する窓2件の格子回避
// ================================================================

test('layoutOpeningTags: 近接する窓2件は2件目がstepずれ、中心間距離が2r+gap以上になる', () => {
  const graph = makeGraph();
  const xCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y0  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1  = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(xCL, 100, true, y0, 0, y1, 0, { isExteriorWall: false });

  const openingA = graph.addOpening(xCL, 1, true, y0, 1000, 400, OpeningCategory.WINDOW, 'doubleSliding', {});
  const openingB = graph.addOpening(xCL, 1, true, y0, 1100, 400, OpeningCategory.WINDOW, 'doubleSliding', {});

  const radiusMm = 50, gapMm = 10, stepMm = 2 * radiusMm + gapMm; // = 110
  const results = layoutOpeningTags(graph, { radiusMm, gapMm, stepMm });
  const rA = results.find(r => r.openingId === openingA.id);
  const rB = results.find(r => r.openingId === openingB.id);

  assert.equal(rA.placed, true);
  assert.equal(rB.placed, true);
  const dist = Math.hypot(rA.x - rB.x, rA.y - rB.y);
  assert.ok(dist >= 2 * radiusMm + gapMm - 1e-6, `中心間距離(${dist})は2r+gap(${2 * radiusMm + gapMm})以上のはず`);
  // Bはalong方向(u=y方向)へstepぶんずれているはず（perp方向xは変化しない）
  approxEqual(rB.x, rA.x, 1e-6);
  approxEqual(rB.y - (rA.y + 100), stepMm, 1, 'Bの素のalong位置(rA.y+100)からstepぶんだけy方向にずれるはず');
});

// ================================================================
// layoutOpeningTags: 壁バンドと重なる候補は不採用
// ================================================================

test('layoutOpeningTags: 狭い通路では反対側の壁バンドに乗る候補を避けて配置する', () => {
  const graph = makeGraph();
  const xA = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 手前の壁
  const xB = graph.addCenterLine(CenterLineType.VERTICAL, 1150, { labeled: false, discipline: Discipline.ARCH }); // 対面の壁（狭い通路）
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -100000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 100000,  { labeled: false, discipline: Discipline.ARCH });

  const wallA = graph.addWall(xA, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  graph.addWall(xB, 0, true, y0, 0, y1, 0, { isExteriorWall: false }); // 対面の壁（障害物のみ、開口なし）

  const opening = graph.addOpening(xA, 1, true, y0, 2000, 400, OpeningCategory.WINDOW, 'doubleSliding', {});

  const radiusMm = 100, gapMm = 20, stepMm = 220;
  const results = layoutOpeningTags(graph, { radiusMm, gapMm, stepMm });
  const r = results.find(x => x.openingId === opening.id);

  assert.equal(r.placed, true);
  const rects = wallObstacleRects(graph);
  const intersectsAny = rects.some(rect => {
    const clampedX = Math.min(Math.max(r.x, rect.x1), rect.x2);
    const clampedY = Math.min(Math.max(r.y, rect.y1), rect.y2);
    const dx = r.x - clampedX, dy = r.y - clampedY;
    return dx * dx + dy * dy < radiusMm * radiusMm;
  });
  assert.equal(intersectsAny, false, 'どちらの壁バンドにも乗らない位置に採用されるはず');
  // naiveアンカー(faceHi+radius+gap=1000+120=1120)は対面の壁(1150)に近すぎて不採用になり、
  // v方向(+1)へstepぶんずれた1340側に落ち着くはず
  approxEqual(r.x, wallA.axisValue + (radiusMm + gapMm) + stepMm, 1);
});

// ================================================================
// layoutOpeningTags: 全候補閉塞（失敗経路）
// ================================================================

test('layoutOpeningTags: 全候補が壁バンドと重なっても必ず1件返る（placed:false）', () => {
  const graph = makeGraph();
  const xCL    = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const xBlock = graph.addCenterLine(CenterLineType.VERTICAL, 840,  { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -100000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 100000,  { labeled: false, discipline: Discipline.ARCH });

  graph.addWall(xCL, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  // 巨大な障害物壁: materialRange=[840,1280]。候補が動きうる全x範囲(anchor.x±2*step)を覆い尽くす。
  graph.addWall(xBlock, 440, true, y0, 0, y1, 0, { isExteriorWall: false });

  const opening = graph.addOpening(xCL, 1, true, y0, 2000, 400, OpeningCategory.WINDOW, 'doubleSliding', { wallSide: 1 });

  const radiusMm = 50, gapMm = 10, stepMm = 2 * radiusMm + gapMm; // = 110
  const results = layoutOpeningTags(graph, { radiusMm, gapMm, stepMm });
  const r = results.find(x => x.openingId === opening.id);

  assert.equal(r.placed, false, '全滅時は placed:false になるはず');
  // フォールバックは必ず(0,0)候補＝naiveアンカーそのもの
  const [, faceHi] = wallFaceRange(graph.walls.find(w => w.axisCL.id === xCL.id), graph);
  approxEqual(r.x, faceHi + (radiusMm + gapMm));
  assert.equal(r.y, opening.centerCoord);
});

// ================================================================
// layoutOpeningTags: ホスト壁削除済み開口は除外（失敗経路。openingRoomLabel.test.js:82-89と同型）
// ================================================================

test('layoutOpeningTags: ホスト壁が見つからない開口は結果に含まれない', () => {
  const graph = makeGraph();
  const { wall, opening } = makeSingleWallWindow(graph, false);
  graph.removeShape(wall.id);

  const results = layoutOpeningTags(graph, { radiusMm: RADIUS, gapMm: GAP, stepMm: 220 });
  assert.equal(results.find(r => r.openingId === opening.id), undefined);
});

// ================================================================
// layoutOpeningTags: 開き戸の動作扇形も障害物になる（F5）
// ================================================================

test('layoutOpeningTags: 開き戸の扇形内に窓のアンカーが来る場合、窓は扇形AABB外へ退避する', () => {
  const graph = makeGraph();
  const xCL   = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const xRef  = graph.addCenterLine(CenterLineType.VERTICAL, 500,  { labeled: false, discipline: Discipline.ARCH });
  const xStart = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xEnd   = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1    = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const yAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 700,  { labeled: false, discipline: Discipline.ARCH });

  graph.addWall(xCL, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  graph.addWall(yAxis, 0, false, xStart, 0, xEnd, 0, { isExteriorWall: false });

  // door: hinge=(1000,600), R=800, bisector135° → 扇形AABB=[200,1000]x[600,1400]
  const door = graph.addOpening(xCL, 1, true, y0, 1000, 800, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide: 1 }, 'door');
  // win: naiveアンカー=(500,820)。上記扇形AABBの内側にちょうど来る配置。
  const win = graph.addOpening(yAxis, 1, false, xRef, 0, 200, OpeningCategory.WINDOW, 'doubleSliding', { wallSide: 1 }, 'win');

  const radiusMm = 100, gapMm = 20, stepMm = 220;
  const results = layoutOpeningTags(graph, { radiusMm, gapMm, stepMm });
  const rDoor = results.find(r => r.openingId === door.id);
  const rWin  = results.find(r => r.openingId === win.id);

  assert.equal(rWin.placed, true);
  // 扇形AABB[200,1000]x[600,1400]に対する円-矩形非交差を確認する（壁バンドテストと同型のチェック）。
  const arcRect = { x1: 200, y1: 600, x2: 1000, y2: 1400 };
  const clampedX = Math.min(Math.max(rWin.x, arcRect.x1), arcRect.x2);
  const clampedY = Math.min(Math.max(rWin.y, arcRect.y1), arcRect.y2);
  const dx = rWin.x - clampedX, dy = rWin.y - clampedY;
  assert.ok(dx * dx + dy * dy >= radiusMm * radiusMm, '窓の記号丸は開き戸の動作扇形AABB外へ退避するはず');

  // 開き戸自身は自分の扇形内（naiveアンカーどおり）に留まる——自己除外が効いている確認。
  // アンカーは hinge(1000,600) + 0.6*R の二等分角(135°)方向。
  assert.equal(rDoor.flipped, false);
  const doorRad = (135 * Math.PI) / 180;
  approxEqual(rDoor.x, 1000 + 0.6 * door.width * Math.cos(doorRad), 1);
  approxEqual(rDoor.y, 600 + 0.6 * door.width * Math.sin(doorRad), 1);
});

// ================================================================
// layoutOpeningTags: 決定性（順序入替不変）
// ================================================================

test('layoutOpeningTags: openingsの追加順序が変わっても結果は同一になる', () => {
  function buildGraph(order) {
    const graph = makeGraph();
    const xCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const y0  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
    const y1  = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
    graph.addWall(xCL, 100, true, y0, 0, y1, 0, { isExteriorWall: false });
    const specs = [
      ['a', 1000], ['b', 1500], ['c', 2000],
    ];
    const ordered = order === 'forward' ? specs : [...specs].reverse();
    const ids = {};
    for (const [id, refOffset] of ordered) {
      ids[id] = graph.addOpening(xCL, 1, true, y0, refOffset, 300, OpeningCategory.WINDOW, 'doubleSliding', {}, id).id;
    }
    return { graph, ids };
  }

  const fwd = buildGraph('forward');
  const rev = buildGraph('reverse');

  const radiusMm = 50, gapMm = 10, stepMm = 2 * radiusMm + gapMm;
  const resultsFwd = layoutOpeningTags(fwd.graph, { radiusMm, gapMm, stepMm });
  const resultsRev = layoutOpeningTags(rev.graph, { radiusMm, gapMm, stepMm });

  const normalize = (results) => results
    .map(r => ({ id: r.openingId, x: Math.round(r.x * 1000), y: Math.round(r.y * 1000), flipped: r.flipped, placed: r.placed }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  assert.deepEqual(normalize(resultsFwd), normalize(resultsRev));
});

// ================================================================
// layoutOpeningTags: 追加の失敗経路（QA指定）
// ================================================================

test('layoutOpeningTags: 開口0件のgraphは空配列', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const results = layoutOpeningTags(graph, { radiusMm: RADIUS, gapMm: GAP, stepMm: 220 });
  assert.deepEqual(results, []);
});

test('layoutOpeningTags: 幅0の開き戸でも例外なく1件返り x/y が有限数', () => {
  const graph = makeGraph();
  const xCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y0  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1  = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(xCL, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  const door = graph.addOpening(xCL, 1, true, y0, 1000, 0, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide: 1 });

  const results = layoutOpeningTags(graph, { radiusMm: RADIUS, gapMm: GAP, stepMm: 220 });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.openingId, door.id);
  assert.ok(Number.isFinite(r.x), `x が有限数のはず（実際: ${r.x}）`);
  assert.ok(Number.isFinite(r.y), `y が有限数のはず（実際: ${r.y}）`);
});
