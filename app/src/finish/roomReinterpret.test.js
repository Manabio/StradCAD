// normalizePartialDominance（部分指定が親の残余面積を上回ったら親子を入れ替える）のテスト。
// 背景: 親・部分指定とも自動ラベル配置は「最大面積セルの中心」のため、部分指定が支配的に
// なると両者のラベルが同一セルに落ちて重なって表示される（問題: 「3」と「3'」の重なり）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { normalizePartialDominance } from './roomReinterpret.js';
import { roomNameAnchor } from './roomLabel.js';
import { worldToCell } from './gridCells.js';

// 2セルグリッド: 左セルA(0..4000 × 0..3000 = 12M mm²) / 右セルB(4000..7000 × 0..3000 = 9M mm²)
function makeTwoCellGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL, 0, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 7000, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  return {
    graph,
    cellA: worldToCell(2000, 1500, graph).key,
    cellB: worldToCell(5500, 1500, graph).key,
  };
}

test('normalizePartialDominance: 部分指定が親の残余より大きければ親子が入れ替わる', () => {
  const { graph, cellA, cellB } = makeTwoCellGraph();
  const parent = graph.addRoom(new Set([cellA, cellB]), '3');
  const partial = graph.addRoom(new Set([cellA]), "3'", undefined, new Set([parent.id]));
  partial.setFloorLevel(100);

  normalizePartialDominance(graph);

  // 勝った子が親（全セル・参照元）になる
  assert.equal(partial.referenceRoomIds.size, 0, "3'が参照元（親）になるはず");
  assert.deepEqual([...partial.cells].sort(), [cellA, cellB].sort(), "3'は親の全セルを引き継ぐはず");
  // 旧親は残余セルの部分指定へ降格する
  assert.deepEqual([...parent.referenceRoomIds], [partial.id], "3は3'の部分指定になるはず");
  assert.deepEqual([...parent.cells], [cellB], '3のセルは残余（旧表示域）だけになるはず');
  // 床レベルは各Roomに残る（セルの実効FL: A側=100 / B側=既定 が入れ替え後も変わらない）
  assert.equal(partial.floorLevel, 100);
  assert.equal(parent.floorLevel, null);
  // 表示順も入れ替わる（部分指定は親の後）
  assert.ok(
    graph.roomOrder.indexOf(partial.id) < graph.roomOrder.indexOf(parent.id),
    '新しい親が roomOrder で先に並ぶはず'
  );
});

test('normalizePartialDominance: 残余の方が大きければ何も変えない', () => {
  const { graph, cellA, cellB } = makeTwoCellGraph();
  const parent = graph.addRoom(new Set([cellA, cellB]), 'LDK');
  const partial = graph.addRoom(new Set([cellB]), '小上がり', undefined, new Set([parent.id]));

  normalizePartialDominance(graph);

  assert.equal(parent.referenceRoomIds.size, 0, '親は参照元のまま');
  assert.deepEqual([...parent.cells].sort(), [cellA, cellB].sort(), '親のセルは不変');
  assert.deepEqual([...partial.referenceRoomIds], [parent.id], '部分指定の参照先も不変');
});

test('normalizePartialDominance: 入れ替え時、他の部分指定の参照先も新しい親へ付け替わる', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL, 0, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 5500, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 7000, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  const cellA  = worldToCell(2000, 1500, graph).key; // 12M mm²
  const cellB1 = worldToCell(4700, 1500, graph).key; // 4.5M mm²
  const cellB2 = worldToCell(6200, 1500, graph).key; // 4.5M mm²

  const parent = graph.addRoom(new Set([cellA, cellB1, cellB2]), '3');
  const big    = graph.addRoom(new Set([cellA]),  "3'", undefined, new Set([parent.id]));
  const small  = graph.addRoom(new Set([cellB1]), "3''", undefined, new Set([parent.id]));

  normalizePartialDominance(graph);

  assert.equal(big.referenceRoomIds.size, 0, '最大の部分指定が親になるはず');
  assert.deepEqual([...parent.referenceRoomIds], [big.id]);
  assert.deepEqual([...parent.cells], [cellB2], '旧親のセルは全部分指定を除いた残余のみ');
  assert.deepEqual([...small.referenceRoomIds], [big.id], '兄弟の部分指定は新しい親を参照するはず');
});

// ---- 問題.md のシナリオ実寸: 「3」=e+f+g、「3'」=e+f（部分指定・床高100）----
// このテストグリッドは全CLが全延長のため、g（中心2..中心5 × 中心3..中心4）は中心7でも
// 分割され上下2セルになる。f は縦線（中心5・中心6）で3セルに分割される。
// 部分指定 e+f（計11.4M mm²）＞残余 g上下（計1.2M mm²）で入れ替えが起きる。
test('normalizePartialDominance: 問題.mdシナリオ（e+f>g）で親子が入れ替わり、「3」のラベルが g に移る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  for (const x of [0, 3400, 4600, 6000, 7000]) graph.addCenterLine(CenterLineType.VERTICAL, x, opts);
  for (const y of [0, 2000, 3000, 3400, 4000, 7000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts);
  const gTop = worldToCell(4000, 3200, graph).key; // 中心2..中心5 × 中心3..中心7 = 1200×400
  const gBot = worldToCell(4000, 3700, graph).key; // 中心2..中心5 × 中心7..中心4 = 1200×600
  const e    = worldToCell(6500, 3700, graph).key; // 中心6..X2 × 中心7..中心4 = 1000×600
  const f1   = worldToCell(4000, 5500, graph).key; // 中心2..中心5 × 中心4..Y1 = 1200×3000
  const f2   = worldToCell(5300, 5500, graph).key; // 中心5..中心6 × 中心4..Y1 = 1400×3000
  const f3   = worldToCell(6500, 5500, graph).key; // 中心6..X2 × 中心4..Y1 = 1000×3000

  const room3 = graph.addRoom(new Set([e, f1, f2, f3, gTop, gBot]), '3');
  const room3d = graph.addRoom(new Set([e, f1, f2, f3]), "3'", undefined, new Set([room3.id]));
  room3d.setFloorLevel(100);

  normalizePartialDominance(graph);

  assert.equal(room3d.referenceRoomIds.size, 0, "3'が親（参照元）になるはず");
  assert.deepEqual([...room3.referenceRoomIds], [room3d.id], "3は3'の部分指定になるはず");
  assert.deepEqual([...room3.cells].sort(), [gTop, gBot].sort(), '3のセルは残余 g だけになるはず');
  // 受け入れ基準: 「3」のラベルが g（残余の最大セル）の中心に移り、「3'」のラベルと重ならない
  const a3  = roomNameAnchor(room3, graph);
  const a3d = roomNameAnchor(room3d, graph);
  assert.deepEqual({ x: a3.x, y: a3.y }, { x: 4000, y: 3700 }, '「3」のラベルは g の中心に出るはず');
  assert.notDeepEqual({ x: a3.x, y: a3.y }, { x: a3d.x, y: a3d.y }, 'ラベルアンカーが重ならないはず');
});

// ---- 受け入れ基準: 総面積で入れ替わっても（最大セルが残余側でも）ラベルは重ならない ----
test('normalizePartialDominance+roomNameAnchor: 部分指定の総面積が勝ち・最大セルは残余側でもラベルが重ならない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  for (const x of [0, 1500, 3000, 4500, 8500]) graph.addCenterLine(CenterLineType.VERTICAL, x, opts);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts);
  const s1  = worldToCell(750, 1500, graph).key;  // 1500×3000 = 4.5M
  const s2  = worldToCell(2250, 1500, graph).key; // 4.5M
  const s3  = worldToCell(3750, 1500, graph).key; // 4.5M
  const big = worldToCell(6500, 1500, graph).key; // 4000×3000 = 12M（全セル中最大）

  const parent = graph.addRoom(new Set([s1, s2, s3, big]), 'A');
  const partial = graph.addRoom(new Set([s1, s2, s3]), "A'", undefined, new Set([parent.id]));

  normalizePartialDominance(graph);

  assert.equal(partial.referenceRoomIds.size, 0, '総面積13.5M>12Mの部分指定が親になるはず');
  const ap = roomNameAnchor(parent, graph);
  const ac = roomNameAnchor(partial, graph);
  assert.notDeepEqual({ x: ap.x, y: ap.y }, { x: ac.x, y: ac.y },
    '新しい親のラベルは部分指定（旧親）に奪われていないセルから選ばれ、重ならないはず');
});

// ---- 受け入れ基準: 入れ替えが起きない（残余の総面積が勝つ）場合もラベルは重ならない ----
test('roomNameAnchor: 最大セルが部分指定側・総面積は残余側が勝つ場合、入れ替えなしでも親ラベルは残余側に出る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  for (const x of [0, 5000, 9000, 13000]) graph.addCenterLine(CenterLineType.VERTICAL, x, opts);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts);
  const big = worldToCell(2500, 1500, graph).key;  // 5000×3000 = 15M（全セル中最大）
  const r1  = worldToCell(7000, 1500, graph).key;  // 4000×3000 = 12M
  const r2  = worldToCell(11000, 1500, graph).key; // 12M

  const parent = graph.addRoom(new Set([big, r1, r2]), 'B');
  const partial = graph.addRoom(new Set([big]), "B'", undefined, new Set([parent.id]));

  normalizePartialDominance(graph);

  assert.equal(parent.referenceRoomIds.size, 0, '残余24M>15Mなので入れ替えは起きないはず');
  const ap = roomNameAnchor(parent, graph);
  const ac = roomNameAnchor(partial, graph);
  assert.notDeepEqual({ x: ap.x, y: ap.y }, { x: ac.x, y: ac.y },
    '親の自動ラベルは部分指定に奪われた最大セルを避け、残余の最大セルに出るはず');
});

// ---- 失敗系: 親に含まれないセルを持つ部分指定（reinterpretの1辺喪失経路では 親⊉子 がありうる）----
test('【失敗系】normalizePartialDominance: 親の外にセルを持つ部分指定が勝っても、そのセルの所属は失われない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  for (const x of [0, 4000, 7000, 10000]) graph.addCenterLine(CenterLineType.VERTICAL, x, opts);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts);
  const cellA = worldToCell(2000, 1500, graph).key; // 12M
  const cellB = worldToCell(5500, 1500, graph).key; // 9M
  const cellX = worldToCell(8500, 1500, graph).key; // 9M（親の外）

  const parent = graph.addRoom(new Set([cellA, cellB]), '親');
  const partial = graph.addRoom(new Set([cellA, cellX]), '子', undefined, new Set([parent.id]));

  normalizePartialDominance(graph);

  assert.equal(partial.referenceRoomIds.size, 0, '子（21M>残余9M）が親になるはず');
  const union = new Set([...parent.cells, ...partial.cells]);
  assert.ok(union.has(cellX), '親の外のセルXがどの部屋にも属さなくなってはいけない');
  assert.ok(partial.cells.has(cellA) && partial.cells.has(cellB), '新しい親は旧親の全セルを引き継ぐはず');
});

// ---- 失敗系: セルキーが現在のCLで解決できない（CL削除後のダングリングキー）----
test('【失敗系】normalizePartialDominance: 解決不能セルキーのみの部分指定は refreshCells が候補から外し、入れ替えず例外も出ない', () => {
  const { graph, cellA, cellB } = makeTwoCellGraph();
  const parent = graph.addRoom(new Set([cellA, cellB]), '部屋');
  const partial = graph.addRoom(
    new Set(['gone1:gone2:gone3:gone4']), '欠損', undefined, new Set([parent.id]));

  assert.doesNotThrow(() => normalizePartialDominance(graph));

  assert.equal(parent.referenceRoomIds.size, 0, '親は参照元のまま');
  assert.deepEqual([...partial.referenceRoomIds], [parent.id], '部分指定の参照先も不変');
});

// ---- 失敗系: 親側に解決不能キーが混ざっていても、入れ替えで黙って消えない ----
test('【失敗系】normalizePartialDominance: 親の解決不能キーは入れ替え後も旧親（降格側）に残る', () => {
  const { graph, cellA, cellB } = makeTwoCellGraph();
  const gone = 'gone1:gone2:gone3:gone4';
  const parent = graph.addRoom(new Set([cellA, cellB, gone]), '親');
  const partial = graph.addRoom(new Set([cellA]), '子', undefined, new Set([parent.id]));

  normalizePartialDominance(graph);

  assert.equal(partial.referenceRoomIds.size, 0, '子（12M>残余9M）が親になるはず');
  assert.ok(parent.cells.has(gone),
    '解決不能キーは reinterpretRoomsOnEntry の現状維持方針どおり捨てずに残すはず');
});
