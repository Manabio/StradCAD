// effectiveCeilingHeight / validateKneeDropWall の回帰テスト（QA F5）。
// roomMetrics.roomCeilingHeight への差し替え（finish/roomMetrics.js）で挙動が変わった
// （旧: 非数値CHはNaN/文字列のままMath.minに渡り不定挙動 → 新: graph.defaultCeilingHeightへ
// フォールバック）ため、新セマンティクスをテストで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { effectiveCeilingHeight, validateKneeDropWall, ERR_CEILING_HEIGHT_UNRESOLVED } from './kneeDropWall.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addCL(graph, type, value) {
  return graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}

// 上室(0,0)-(4000,2000)・下室(0,2000)-(4000,5000)がy=2000のCLを共有する2部屋を作る。
function makeSharedEdgeRooms(graph) {
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);

  const upperKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const upperRoom = graph.addRoom(new Set([upperKey]), '上室');
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, upperRoom);
  generateRoomWallsFromOutline(graph, lowerRoom);

  const key = edgeKey(yMid.id, x0.id, x1.id);
  return { upperRoom, lowerRoom, key };
}

// ---- (a) 両側数値: 低い方を返す ----
test('effectiveCeilingHeight: 両側とも数値のceilingHeightなら低い方を返す', () => {
  const graph = makeGraph();
  const { upperRoom, lowerRoom, key } = makeSharedEdgeRooms(graph);
  upperRoom.setOverride('ceilingHeight', '2400');
  lowerRoom.setOverride('ceilingHeight', '2600');
  const cellToRoom = buildCellToRoom(graph);

  assert.equal(effectiveCeilingHeight(graph, key, cellToRoom), 2400);
});

// ---- (b) 片側レンジ表記: defaultCeilingHeightへフォールバックしてから低い方を取る ----
test('effectiveCeilingHeight: 片側がレンジ表記「2300〜3500」ならdefaultCeilingHeightへフォールバックする', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2400);
  const { upperRoom, lowerRoom, key } = makeSharedEdgeRooms(graph);
  upperRoom.setOverride('ceilingHeight', '2300〜3500'); // 数値化できない → fallback 2400
  lowerRoom.setOverride('ceilingHeight', '2600');
  const cellToRoom = buildCellToRoom(graph);

  assert.equal(effectiveCeilingHeight(graph, key, cellToRoom), 2400);
});

// ---- (c) 失敗系: edgeGeometry解決不能（部屋なし）→ null → ERR_CEILING_HEIGHT_UNRESOLVED ----
test('【失敗系】effectiveCeilingHeight: edgeGeometryが解決できない（存在しないCL参照）ならnull', () => {
  const graph = makeGraph();
  const badKey = edgeKey('no-such-cl', 'no-such-start', 'no-such-end');
  const cellToRoom = buildCellToRoom(graph);

  assert.equal(edgeGeometry(badKey, graph, cellToRoom), null, '前提: 解決不能なedgeはnullを返す');
  assert.equal(effectiveCeilingHeight(graph, badKey, cellToRoom), null);
});

test('【失敗系】validateKneeDropWall: ceilingHeight=nullはERR_CEILING_HEIGHT_UNRESOLVEDを返す', () => {
  const result = validateKneeDropWall(600, 400, null);
  assert.deepEqual(result, { valid: false, error: ERR_CEILING_HEIGHT_UNRESOLVED });
});

// ---- 失敗系: 部屋が片側にしか無い（もう片側は無名屋外）場合も、有る側だけで解決する ----
test('【失敗系】effectiveCeilingHeight: 片側が無名屋外（部屋なし）でも、部屋がある側だけで解決する', () => {
  const graph = makeGraph();
  // 下室だけを作る（上側は無指定＝無名屋外）
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, lowerRoom);
  lowerRoom.setOverride('ceilingHeight', '2600');

  const key = edgeKey(yMid.id, x0.id, x1.id);
  const cellToRoom = buildCellToRoom(graph);
  assert.equal(effectiveCeilingHeight(graph, key, cellToRoom), 2600);
});
