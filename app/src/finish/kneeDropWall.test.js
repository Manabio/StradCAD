// effectiveCeilingHeight / validateKneeDropWall の回帰テスト（QA F5）。
// roomMetrics.roomCeilingHeight への差し替え（finish/roomMetrics.js）で挙動が変わった
// （旧: 非数値CHはNaN/文字列のままMath.minに渡り不定挙動 → 新: graph.defaultCeilingHeightへ
// フォールバック）ため、新セマンティクスをテストで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { effectiveCeilingHeight, validateKneeDropWall, ERR_CEILING_HEIGHT_UNRESOLVED, kneeDropRecordsOnAxis, resolveKneeDropOverlays, kneeDropRecordForWallSpan } from './kneeDropWall.js';

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

// ==== kneeDropRecordsOnAxis（key解読の共通化・軸は通りで照合） ====

test('kneeDropRecordsOnAxis: 同じ通り（向き＋座標）でスパンが重なるレコードを{key,rec,lo,hi}で返す', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  const rec = { knee: { topHeight: 900 } };
  graph.setKneeDropWall(key, rec);

  const axisCL = graph.shapeMap.get(key.split(':')[0]);
  const found = kneeDropRecordsOnAxis(graph, axisCL, 0, 4000);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, key);
  assert.deepEqual(found[0].rec, rec);
  assert.equal(found[0].lo, 0);
  assert.equal(found[0].hi, 4000);
});

// ---- 失敗系: axisCLIdが一致してもスパンが重ならなければ含めない ----
test('【失敗系】kneeDropRecordsOnAxis: スパンが重ならなければ含めない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });

  const axisCL = graph.shapeMap.get(key.split(':')[0]);
  // レコードのスパンは[0,4000]。問い合わせスパン[5000,6000]は重ならない。
  assert.equal(kneeDropRecordsOnAxis(graph, axisCL, 5000, 6000).length, 0);
});

// ---- 失敗系: 別の通り（座標違い・向き違い）は含めない ----
test('【失敗系】kneeDropRecordsOnAxis: 座標の違う通りのCLでは含めない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  const other = addCL(graph, CenterLineType.HORIZONTAL, 3000); // 記録は y=2000
  assert.equal(kneeDropRecordsOnAxis(graph, other, 0, 4000).length, 0);
});

test('【失敗系】kneeDropRecordsOnAxis: 座標が同じでも向きが違うCLでは含めない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  const vertical = addCL(graph, CenterLineType.VERTICAL, 2000); // 記録は HORIZONTAL の y=2000
  assert.equal(kneeDropRecordsOnAxis(graph, vertical, 0, 4000).length, 0);
});

// ---- 実機2026-08「21」: 同じ通りにCLが2本ある図面でも取りこぼさない ----
test('【実機指摘】kneeDropRecordsOnAxis: 同じ通りの別CL（同座標・同向き）でも該当する', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  // 記録は y=2000 のCL。面や壁が持つのが「同じ y=2000 の別CL」でも同じ通りなので該当する。
  const twin = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  assert.notEqual(twin.id, key.split(':')[0], '別のCLであること（前提の確認）');
  assert.equal(kneeDropRecordsOnAxis(graph, twin, 0, 4000).length, 1,
    'id違いでも同じ通りなら該当するはず（id一致だと指定が無いことになる）');
});

// ==== 隅の取り合いぶんのはみ出しを「区間の壁」と誤認しない（実機2026-08「21」2階 X2×Y2+3500）====
//
// 角では壁端が相手壁の仕上げ面まで伸びる（コーナーマップ／closeConvexCorners）ため、隣の区間の
// 壁が 57.5mm（=wallBase/2+wallFinish）だけ区間へ食い込む。これを構成壁として拾うと、その壁が
// 全長にわたって腰壁天板の輪郭で描き替えられてしまう（隣室側に天板線が増え、通常の壁帯が消える）。

// 区間[0,4000]の左隣から 57.5mm だけ食い込む下地オーナー壁を1本足す。
function addCornerOverhangWall(graph, yMid, x0) {
  const xLeft = addCL(graph, CenterLineType.VERTICAL, -4000);
  return graph.addWall(yMid, 57.5, false, xLeft, 0, x0, 57.5, {
    isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1,
  });
}

test('【失敗系】resolveKneeDropOverlays: 隅の取り合いぶん(57.5mm)だけ食い込む隣区間の壁は対象にしない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } }); // 平面切断高さ以下＝天板輪郭を出す
  const [axisCLId, startCLId] = key.split(':');
  const yMid = graph.shapeMap.get(axisCLId), x0 = graph.shapeMap.get(startCLId);
  const overhang = addCornerOverhangWall(graph, yMid, x0);

  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(overlays.has(overhang.id), false, '隣区間の壁は腰壁天板で描き替えない');
  const spanWalls = [...graph.walls].filter(w => !w.isVertical && w.axisCL === yMid && w !== overhang);
  assert.ok(spanWalls.length > 0 && spanWalls.every(w => overlays.has(w.id)), '区間本来の壁は対象のまま');
});

test('【失敗系】kneeDropRecordForWallSpan: 隅の取り合いぶんの重なりしかない壁スパンは拾わない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });

  const axisCL = graph.shapeMap.get(key.split(':')[0]);
  // レコードのスパンは[0,4000]。左隣の壁スパン[-4000,57.5]は 57.5mm しか重ならない。
  assert.equal(kneeDropRecordForWallSpan(graph, axisCL, -4000, 57.5), null);
  // 区間を実際に走る壁スパン（[0,4000]）はこれまでどおり拾う。
  assert.equal(kneeDropRecordForWallSpan(graph, axisCL, 0, 4000)?.key, key);
  // 素の重なり判定（点クエリ用。sectionProbe が使う）は従来どおり拾う——両者を混同しない。
  assert.equal(kneeDropRecordsOnAxis(graph, axisCL, 1999.5, 2000.5).length, 1);
});
