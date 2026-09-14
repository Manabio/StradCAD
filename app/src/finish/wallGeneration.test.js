// applyBackingOwnership（core.jsリファクタ: 仕上げ面が向く側導出のWall.faceDir集約）の回帰テスト。
// setOwnerFields=true 経路の finishSide 書き換えは Wall.faceDir（finishSide優先／axisOffsetの
// naiveな符号はfallback）を経由するが、dirの向きを取り違えても270件全緑で通過してしまう穴が
// あった（QA指摘）。この穴を塞ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph, Plane, CenterLineType, Discipline, RoomKind, RoomFeature } from '@core';
import {
  applyBackingOwnership, computeExternalEdgeParams, generateExteriorWalls, isInteriorWallTarget,
} from './wallGeneration.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addWall(graph, axisOffset, props) {
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, axisOffset, false, clStart, 0, clEnd, 0, props);
}

test('applyBackingOwnership: setOwnerFields=trueでも確定済みのfinishSideを書き換えない（axisOffsetのnaiveな符号と食い違うCL偏芯壁）', () => {
  const graph = makeGraph();
  // axisOffset=-75(負) だが finishSide=1 明示 → naiveなsign(axisOffset)=-1 とは食い違う。
  const owner = addWall(graph, -75, { wallFinish: 12.5, finishSide: 1 });

  applyBackingOwnership(graph, [owner], [], { setOwnerFields: true });

  assert.equal(owner.finishSide, 1, '既に確定済みのfinishSideはnaiveなsign(axisOffset)=-1へ書き換わらないはず');
});

// ---- 【失敗系】wallFinish===null（生成時確定値の無い手動壁）はsetOwnerFieldsの対象外 ----
test('【失敗系】applyBackingOwnership: wallFinish===null（手動壁）は早期continueされfinishSide/backingDepthが不変のまま', () => {
  const graph = makeGraph();
  const manualWall = addWall(graph, -75, { wallFinish: null, finishSide: null, backingDepth: 999 });

  applyBackingOwnership(graph, [manualWall], [], { setOwnerFields: true });

  assert.equal(manualWall.finishSide, null, '手動壁はcontinueされfinishSideが書き換わらないはず');
  assert.equal(manualWall.backingDepth, 999, '手動壁はcontinueされbackingDepthも書き換わらないはず');
});


// ---- 同値・別延長のCLがある場合の外周エッジ端点id（問題修正2026-08その9） ----
// externalSubIntervals は「自部屋のセルには現れない区切りCL」も分割候補に足すが、その追加が
// セルキー由来のid（実際にセルを画しているCL＝権威）を value をキーに上書きしていた。値が同じで
// 延長だけ違うCLが2本あると、隅が「その位置には届いていない方」のidを指し、buildRoomFacesの
// チェーン探索（隅をCLのidで辿る）が繋がらなくなる（実機2階の室22で展開図が「Aのみ」になった）。
// 再現には「同値CLの位置を跨ぐセル」（＝そのCLが届かず割れないセル）が要る。
test('computeExternalEdgeParams: 同値で延長の違うCLが2本あっても、端点idは辺の位置に届いている方になる', () => {
  const graph = makeGraph();
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   3000, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, ARCH);
  // y=2000 に延長の違う2本。左列(x:0..3000)に届くのは yNear、yFar は無関係な右方だけに届く。
  const yNear = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { ...ARCH, extentLo: 0,    extentHi: 3000 });
  const yFar  = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { ...ARCH, extentLo: 5000, extentHi: 7000 });

  // 左列は下半分だけ・右列はy=2000で割れない1枚（＝yNearが届かないため跨ぐ）。
  const room = graph.addRoom(new Set([
    `${x0.id}:${yNear.id}:${x1.id}:${y1.id}`,
    `${x1.id}:${y0.id}:${x2.id}:${y1.id}`,
  ]), 'R');

  const params = computeExternalEdgeParams(room, 1, graph);
  assert.ok(params.some(p => p.isVertical && p.axisCLId === x1.id),
    '前提: 右列の左辺（x=3000）に外周エッジが出る');
  assert.equal(params.filter(p => p.startCLId === yFar.id || p.endCLId === yFar.id).length, 0,
    `端点idに「この辺に届いていない同値CL」が混ざらないはず（実際:${JSON.stringify(params)}）`);
  assert.ok(params.some(p => p.isVertical && p.axisCLId === x1.id &&
    (p.startCLId === yNear.id || p.endCLId === yNear.id)),
    '右列の左辺の分割点はセルを画している側のCL(yNear)を指すはず');
});

// ---- 屋外部屋は壁を持たない（境界は屋内側から'courtyard'として生成し、壁本体は屋外室側に置かれる）----
test('generateExteriorWalls: 屋内室[0,4000]・屋外室[4000,8000]が隣接する場合、courtyard壁のaxisOffsetは屋外室側（正）で、屋外室の外周(x=8000)には壁が出ない', () => {
  const graph = makeGraph();
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   8000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);

  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '室内');
  const exterior = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'テラス');
  exterior.setKind(RoomKind.EXTERIOR);

  const walls = generateExteriorWalls(graph);

  // 共有境界(x=4000)上の壁はcourtyard壁。isExteriorWall=trueかつaxisOffsetは正（屋外室=x大側）。
  const courtyardWalls = walls.filter(w => w.axisCL.id === x1.id);
  assert.ok(courtyardWalls.length >= 1, '共有境界(x=4000)にcourtyard壁が生成されるはず');
  for (const w of courtyardWalls) {
    assert.equal(w.isExteriorWall, true);
    assert.ok(w.axisOffset > 0, `axisOffsetは屋外室側（正）のはず（実際:${w.axisOffset}）`);
  }

  // 屋外室自身の外周（x=8000等）には壁が出ない
  assert.equal(walls.some(w => w.axisCL.id === x2.id), false,
    '屋外室の外側辺(x=8000)には壁が出ないはず');
});

test('generateExteriorWalls: 屋外部屋のみ（屋内部屋が無い）場合は壁を生成しない', () => {
  const graph = makeGraph();
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);

  const exterior = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'テラス');
  exterior.setKind(RoomKind.EXTERIOR);

  const walls = generateExteriorWalls(graph);

  assert.deepEqual(walls, []);
});

// ---- isInteriorWallTarget: finishBoundary.js ステップ2（内周壁の全再生成）の対象判定 ----
test('isInteriorWallTarget: 屋外部屋（kind=EXTERIOR）は対象外', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(['dummy']), 'テラス');
  room.setKind(RoomKind.EXTERIOR);

  assert.equal(isInteriorWallTarget(room, new Set()), false);
});

test('isInteriorWallTarget: 屋外階段（kind=EXTERIOR かつ feature=STAIR）も対象外', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(['dummy']), '階段');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.STAIR);

  assert.equal(isInteriorWallTarget(room, new Set()), false);
});

test('isInteriorWallTarget: 屋内の通常部屋は対象', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(['dummy']), 'LDK');

  assert.equal(isInteriorWallTarget(room, new Set()), true);
});

test('isInteriorWallTarget: UNDEFINED（未定義）は対象外', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(['dummy']), '');
  room.setFeature(RoomFeature.UNDEFINED);

  assert.equal(isInteriorWallTarget(room, new Set()), false);
});

test('isInteriorWallTarget: 部分指定（referenceRoomIdsあり・非STAIR）は対象外（親が外周壁を担う）', () => {
  const graph = makeGraph();
  const parent = graph.addRoom(new Set(['dummy1']), '親');
  const partial = graph.addRoom(new Set(['dummy2']), '子', undefined, new Set([parent.id]));

  assert.equal(isInteriorWallTarget(partial, new Set()), false);
});

test('isInteriorWallTarget: 部分指定×feature=STAIR（部分指定から階段変換）は例外で対象', () => {
  const graph = makeGraph();
  const parent = graph.addRoom(new Set(['dummy1']), '親');
  const stairPartial = graph.addRoom(new Set(['dummy2']), '階段', undefined, new Set([parent.id]));
  stairPartial.setFeature(RoomFeature.STAIR);

  assert.equal(isInteriorWallTarget(stairPartial, new Set()), true);
});

test('isInteriorWallTarget: under2aRoomIdsに含まれる部屋（階段下2a）は対象外', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(['dummy']), '階段下');

  assert.equal(isInteriorWallTarget(room, new Set([room.id])), false);
});
