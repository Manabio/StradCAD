// normalizePartialDominance（部分指定が親の残余面積を上回ったら親子を入れ替える）のテスト。
// 背景: 親・部分指定とも自動ラベル配置は「最大面積セルの中心」のため、部分指定が支配的に
// なると両者のラベルが同一セルに落ちて重なって表示される（問題: 「3」と「3'」の重なり）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature, ExteriorLevelRef, StructuralMaterialType, isShaftFeature, RoofSpec, ROOF_SPEC_KEYS } from '@core';
import { NON_DEFAULT_ROOF_SPEC } from './roofTestFixtures.js';
import {
  normalizePartialDominance, reinterpretRoomsOnEntry, snapshotRoomsState, restoreRoomsState,
  findUnresolvableCells, reinterpretSlabsAfterCLRemoval,
} from './roomReinterpret.js';
import { roomNameAnchor } from './roomLabel.js';
import { worldToCell, lostSides, cellInteriorPoint, regionCellsAt, refreshCells } from './gridCells.js';
import { isInteriorWallTarget } from './wallGeneration.js';
import { stairUnderRoomsOf } from './stair/stairUnderRooms.js';

// ---- 作業0（前提確認）: 最外郭CL（外壁線）を失ったセルは再解釈できるか ----
// フットプリント境界CL削除ガード（centerLineConvert.js isFootprintBoundaryCL）着手前の実測。
// 対辺(right)が生きているため cellInteriorPoint は代表点を返す（対辺2本同時喪失の退化ケースではない）
// が、その代表点は「削除された左端CLより外側（格子の外）」に来るため worldToCell 自体が
// 格子外としてnullを返し、regionCellsAt は空配列になる——reinterpretRoomsOnEntry（regionCellsAtが
// 空なら該当セルをスキップ＝現状維持）では救済されない。
test('作業0: 最外郭の縦CL（外壁線）を削除すると、そのセルの regionCellsAt は空になり再解釈不能', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const vs = [0, 4000, 8000].map(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  [0, 4000, 8000].forEach(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  const cellKey = worldToCell(2000, 2000, graph).key; // 左上セル（左端CLが外壁線）
  graph.addRoom(new Set([cellKey]), '部屋');

  graph.removeCenterLine(vs[0].id); // 最外郭（外壁線）の縦CLを削除

  const lost = lostSides(cellKey, graph);
  assert.deepEqual(lost, ['left'], '前提: 削除した左端だけが喪失（右端・上下は健在）');

  const pt = cellInteriorPoint(cellKey, graph);
  assert.ok(pt, '前提: 対辺(right)が健在のため内部代表点は復元できる（退化ケースではない）');

  const region = regionCellsAt(pt.x, pt.y, graph);
  assert.equal(region.length, 0,
    '復元した代表点は削除済み外壁線の外側に来るため worldToCell が格子外としてnullを返し、' +
    'regionCellsAtは空配列になる（reinterpretRoomsOnEntryのregionCellsAt空スキップでは救済不能）');
});

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

// ---- シナリオ実寸: 「3」=e+f+g、「3'」=e+f（部分指定・床高100）----
// このテストグリッドは全CLが全延長のため、g（中心2..中心5 × 中心3..中心4）は中心7でも
// 分割され上下2セルになる。f は縦線（中心5・中心6）で3セルに分割される。
// 部分指定 e+f（計11.4M mm²）＞残余 g上下（計1.2M mm²）で入れ替えが起きる。
test('normalizePartialDominance: シナリオ（e+f>g）で親子が入れ替わり、「3」のラベルが g に移る', () => {
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

// ---- reinterpretRoomsOnEntry: 屋外部屋が2辺喪失で完全吸収されると連動行も孤児化しない ----
// 3列(左/中/右)の行で、中央セル1つを屋外部屋、左右2セルを屋内部屋が持つ。中央の左右の
// 仕切りCL（x1/x2）が「（floorplanモードでの短縮により）この行の範囲では非アクティブ」に
// なった状態を再現する（addCenterLineのextentLo/extentHiを行のyレンジ外に設定）。
// これにより中央セルはlostSides=['left','right']（2辺喪失）となり、左右セルとまとめて
// 1つの領域に統合される。セル数の少ない屋外部屋（1セル）が完全吸収され消える経路を通す。
function makeRowWithShortenedMiddleDividers() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    ARCH);
  // x1/x2: 本来は行の仕切りだが、extentLo/Hiが行のyレンジ[0,3000]の外にあるため
  // 「この行の範囲では非分割（＝短縮済み）」を表す。
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { ...ARCH, extentLo: 4000, extentHi: 5000 });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { ...ARCH, extentLo: 4000, extentHi: 5000 });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 9000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);

  const left  = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const mid   = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;
  const right = `${x2.id}:${y0.id}:${x3.id}:${y1.id}`;
  return { graph, left, mid, right };
}

test('reinterpretRoomsOnEntry: 屋外部屋の2辺喪失（完全吸収）でexteriorRowsの連動行も孤児化せず削除される', () => {
  const { graph, left, mid, right } = makeRowWithShortenedMiddleDividers();

  const big = graph.addRoom(new Set([left, right]), 'LDK');
  const small = graph.addRoom(new Set([mid]), 'テラス');
  small.setKind(RoomKind.EXTERIOR);
  graph.addExteriorRow('exteriorRows', 'テラス', small.id);

  assert.equal(graph.exteriorRows.filter(r => r.roomId === small.id).length, 1, '前提: 連動行が1件ある');

  reinterpretRoomsOnEntry(graph);

  assert.equal(graph.roomMap.has(small.id), false, '屋外部屋（少ないセル数）は完全吸収されて消えるはず');
  assert.equal(graph.roomMap.has(big.id), true, '屋内部屋（多いセル数）は残るはず');
  assert.equal(graph.exteriorRows.filter(r => r.roomId === small.id).length, 0,
    '吸収削除された屋外部屋の連動行が孤児化せず削除されるはず');
});

// ---- snapshotRoomsState/restoreRoomsState: 屋外部屋の仕上げレベル3フィールドのundo往復 ----
test('snapshotRoomsState→restoreRoomsState: exteriorSlope/exteriorLevelRef/exteriorLevelが採取時の値へ戻る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const room = graph.addRoom(new Set(['dummy']), 'テラス');
  room.setKind(RoomKind.EXTERIOR);
  room.setExteriorSlope(50);
  room.setExteriorLevelRef(ExteriorLevelRef.GL);
  room.setExteriorLevel(150);

  const snap = snapshotRoomsState(graph);

  // 採取後に別値へ変更する
  room.setExteriorSlope(100);
  room.setExteriorLevelRef(ExteriorLevelRef.ROOM);
  room.setExteriorLevel(-300);

  restoreRoomsState(graph, snap);

  const restored = graph.roomMap.get(room.id);
  assert.equal(restored.exteriorSlope, 50, '採取時の勾配へ戻るはず');
  assert.equal(restored.exteriorLevelRef, ExteriorLevelRef.GL, '採取時の基準へ戻るはず');
  assert.equal(restored.exteriorLevel, 150, '採取時のおさえへ戻るはず');
});

test('snapshotRoomsState→restoreRoomsState: 未設定の部屋はnull/"room"/nullのまま往復する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const room = graph.addRoom(new Set(['dummy']), 'LDK');
  // exteriorSlope/exteriorLevelRef/exteriorLevel は未設定のまま

  const snap = snapshotRoomsState(graph);
  restoreRoomsState(graph, snap);

  const restored = graph.roomMap.get(room.id);
  assert.equal(restored.exteriorSlope, null);
  assert.equal(restored.exteriorLevelRef, ExteriorLevelRef.ROOM);
  assert.equal(restored.exteriorLevel, null);
});

// ---- 屋根の仕様（ステップB2。Room.roofSpec）の仕上げモード undo 経路（snapshotRoomsState/restoreRoomsState）----
function makeGraphWithRoof() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const interior = graph.addRoom(new Set(['dummy1']), '居間');
  const roof = graph.addRoom(new Set(['dummy2']), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  roof.setRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  return { graph, interior, roof };
}

test('【B2】snapshotRoomsState→restoreRoomsState→snapshotRoomsState: 全10項目を既定値以外にした RoofSpec が往復する（出幅0・勾配2.5・形状明示）', () => {
  const { graph, roof } = makeGraphWithRoof();
  const snap = snapshotRoomsState(graph);
  roof.roofSpec.setField('slope', 7);
  roof.roofSpec.setField('note', '書換え');
  restoreRoomsState(graph, snap);
  const restored = graph.roomMap.get(roof.id);
  assert.deepEqual(restored.roofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.equal(JSON.stringify(snapshotRoomsState(graph)), JSON.stringify(snap), '往復前後でスナップショットが一致する');
});

test('【C1b】snapshotRoomsState→restoreRoomsState: highSide の null（自動）と明示値がそれぞれ保たれる。壊れた値は null へ', () => {
  const { graph, roof } = makeGraphWithRoof();
  const specOf = () => graph.roomMap.get(roof.id).roofSpec; // restore は Room を作り直すので毎回引き直す
  specOf().setField('highSide', null);
  const snapNull = snapshotRoomsState(graph);
  assert.equal(snapNull.rooms.find(r => r.id === roof.id).roofSpec.highSide, null);
  specOf().setField('highSide', 'bottom');
  restoreRoomsState(graph, snapNull);
  assert.equal(graph.roomMap.get(roof.id).roofSpec.highSide, null, 'null（自動）へ戻る');
  specOf().setField('highSide', 'bottom');
  const snapSet = snapshotRoomsState(graph);
  specOf().setField('highSide', null);
  restoreRoomsState(graph, snapSet);
  assert.equal(graph.roomMap.get(roof.id).roofSpec.highSide, 'bottom');
  snapSet.rooms.find(r => r.id === roof.id).roofSpec.highSide = 'up';
  restoreRoomsState(graph, snapSet);
  assert.equal(graph.roomMap.get(roof.id).roofSpec.highSide, null, '【失敗系】未知の値は null');
});

test('【B2】snapshotRoomsState: roofSpec のキー集合は ROOF_SPEC_KEYS と一致し、屋根でない部屋は null', () => {
  const { graph, roof, interior } = makeGraphWithRoof();
  const snap = snapshotRoomsState(graph);
  const roofSnap = snap.rooms.find(r => r.id === roof.id);
  assert.deepEqual(Object.keys(roofSnap.roofSpec).sort(), [...ROOF_SPEC_KEYS].sort());
  assert.equal(snap.rooms.find(r => r.id === interior.id).roofSpec, null);
});

test('【B2・失敗系】restoreRoomsState: roofSpec が欠けた屋根の snapshot（B1a 以前の形）は既定値で補う（備考「下野」）', () => {
  const { graph, roof } = makeGraphWithRoof();
  const snap = snapshotRoomsState(graph);
  delete snap.rooms.find(r => r.id === roof.id).roofSpec; // キー自体が無い旧形式
  restoreRoomsState(graph, snap);
  const spec = graph.roomMap.get(roof.id).roofSpec;
  assert.ok(spec, 'I1: 屋根の部屋には roofSpec が補われる');
  assert.equal(spec.note, '下野');
  assert.equal(spec.slope, 3);
  assert.equal(spec.shape, null);
});

test('【B2・失敗系】restoreRoomsState: 屋根でない部屋に付いた roofSpec は捨てる（I1）', () => {
  const { graph, interior } = makeGraphWithRoof();
  const snap = snapshotRoomsState(graph);
  snap.rooms.find(r => r.id === interior.id).roofSpec = { ...NON_DEFAULT_ROOF_SPEC };
  restoreRoomsState(graph, snap);
  assert.equal(graph.roomMap.get(interior.id).roofSpec, null);
});

// ================================================================
// findUnresolvableCells（CL削除ステップ2: 削除前の先読み判定）
// ================================================================
// 現在すでに失われている辺（lostSides）に、これから削除するclId自身の辺を加えた集合で
// 「対辺2本同時喪失」（cellInteriorPointがnullを返す条件と同じ）を判定する。
// 実際のCL削除を経ずに、fabricatedなセルキー（本番でも部分指定・旧データ由来で起こりうる
// 「一部の辺が既に解決不能」なキー）で直接テストする。

test('findUnresolvableCells: 既に片辺（left）が失われたセルで、対辺（right）のCLを削除すると復元不能として返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const top    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  const bottom = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  const right  = graph.addCenterLine(CenterLineType.VERTICAL,   4000, opts);
  // left側は既に削除済みのCL id（ダングリング参照。lostSidesがgetCL()=null→'left'を喪失と判定する）。
  const key = `gone-left:${top.id}:${right.id}:${bottom.id}`;
  graph.addRoom(new Set([key]), '部屋');

  const result = findUnresolvableCells(graph, right.id);

  assert.deepEqual(result, [key], 'right削除でleft・right両方喪失=対辺2本同時喪失として返すはず');
});

test('findUnresolvableCells: 片辺しか失われないなら復元不能ではない（空配列）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const left   = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opts);
  const top    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  const bottom = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  const right  = graph.addCenterLine(CenterLineType.VERTICAL,   4000, opts);
  // rightのさらに外側（S1・2026-09-27: これが無いとrightを失った代表点がbracketできず
  // 復元不能になる——hasDividerBeyondのテストは別途下に用意する）。
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, opts);
  const key = `${left.id}:${top.id}:${right.id}:${bottom.id}`;
  graph.addRoom(new Set([key]), '部屋');

  const result = findUnresolvableCells(graph, right.id);

  assert.deepEqual(result, [], 'left健在・rightのさらに外側にも分割CLがあるためrightを失うだけでは復元不能にならない');
});

test('findUnresolvableCells: clIdを辺に持たないセルは無視する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const left   = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opts);
  const top    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  const bottom = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  const right  = graph.addCenterLine(CenterLineType.VERTICAL,   4000, opts);
  const other  = graph.addCenterLine(CenterLineType.VERTICAL,   9000, opts); // このセルの辺には無い
  const key = `${left.id}:${top.id}:${right.id}:${bottom.id}`;
  graph.addRoom(new Set([key]), '部屋');

  assert.deepEqual(findUnresolvableCells(graph, other.id), []);
});

// ================================================================
// S1（2026-09-27 QA指摘）: 対辺2本喪失に至らなくても、失った辺の外側（セルの外方向）に
// 有効な同軸の分割CLが1本も無ければ復元不能——部屋の無い外周スラブ・屋外部屋（isBuildingRoom
// が偽）の外周セルで、対辺2本喪失の判定だけでは検出できなかった退化を一般判定で拾う。
// ================================================================

test('findUnresolvableCells: 部屋の無い外周スラブのセル辺を担うCLの削除は復元不能として返す（S1実測再現）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const v0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, opts);
  const leftCell = worldToCell(2000, 2000, graph).key;
  graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([leftCell]));

  const result = findUnresolvableCells(graph, v0.id);

  assert.deepEqual(result, [leftCell],
    'V0はグリッド最外郭の左辺のため、削除すると左セルの代表点がbracketできず復元不能になるはず');
});

test('findUnresolvableCells: 屋外部屋（RoomKind.EXTERIOR。isBuildingRoomが偽）の外周セル辺を担うCLの削除も同様に復元不能として返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const v0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, opts);
  const leftCell = worldToCell(2000, 2000, graph).key;
  // feature未設定（isReinterpretExemptの対象外）——STAIR等の除外部屋ではなく、通常Roomと
  // 同じ「対辺2本喪失／外側にbracket先が無い」判定を通ることを確認する。
  const room = graph.addRoom(new Set([leftCell]), '屋外');
  room.setKind(RoomKind.EXTERIOR);

  const result = findUnresolvableCells(graph, v0.id);

  assert.deepEqual(result, [leftCell],
    '屋外部屋（isBuildingRoomが偽）はisFootprintBoundaryCLのフットプリント判定からは外れるが、' +
    'findUnresolvableCellsの一般判定はfeature（再解釈除外）の有無に関わらず同じ関数で当たるはず');
});

test('findUnresolvableCells: グリッド最外郭（上辺）を失う場合もx軸と対称にy軸方向で復元不能を検出する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 4000, opts);
  const h0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, opts);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 8000, opts);
  const topCell = worldToCell(2000, 2000, graph).key;
  graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([topCell]));

  const result = findUnresolvableCells(graph, h0.id);

  assert.deepEqual(result, [topCell], 'H0（y軸最外郭）の削除もx軸と対称に検出されるはず');
});

// ---- 裁定変更（ユーザー裁定）: 再解釈除外部屋（STAIR/STAIR_VOID/UNDEFINED）は救済経路自体が
// 無いため、対辺2本同時喪失を待たず、辺を1つでも参照していれば復元不能として返す（通常Roomは
// 対辺2本同時喪失のときだけ——上の「片辺しか失われないなら復元不能ではない」テストと対照）。----

// QA指摘（案a・空振りテストの是正）: cellAの左辺（V0）はグリッド最外郭で外側に分割CLが
// 無いため、通常の部屋でも常に復元不能——isReinterpretExemptの有無を判別できず空振りになる
// （isReinterpretExemptを常にfalseにする変異でも緑のままだった）。cellAの右辺（V4000。
// makeTwoCellGraphのcellB側との内部境界）に替える——外側にV7000があるため通常の部屋なら
// 復元可能（[]）、再解釈対象外の部屋だけ[cellA]になり、判別力を持つ。
test('findUnresolvableCells: 階段Room（feature===STAIR）は再解釈対象外のため、通常なら復元可能な片辺の参照だけでも復元不能として返す', () => {
  const { graph, cellA } = makeTwoCellGraph();
  const room = graph.addRoom(new Set([cellA]), '階段');
  room.setFeature(RoomFeature.STAIR);
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), [cellA],
    '階段Roomは再解釈で永久に救済されないため、片辺の参照だけで復元不能扱いになるはず（裁定変更点）');
});

test('findUnresolvableCells: STAIR_VOID部屋（階段吹抜け）も同様に片辺の参照だけで復元不能として返す', () => {
  const { graph, cellA } = makeTwoCellGraph();
  const room = graph.addRoom(new Set([cellA]), '吹抜け');
  room.setFeature(RoomFeature.STAIR_VOID);
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), [cellA]);
});

test('findUnresolvableCells: UNDEFINED部屋（未定義）も同様に片辺の参照だけで復元不能として返す', () => {
  const { graph, cellA } = makeTwoCellGraph();
  const room = graph.addRoom(new Set([cellA]), '');
  room.setFeature(RoomFeature.UNDEFINED);
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), [cellA]);
});

// ---- 昇降路（feature===ELEVATOR_EQUIPMENT）も階段と同じ扱いへ（ユーザー裁定2026-09-29）:
// 案a＝再解釈対象外（isReinterpretExemptにisShaftFeatureを追加）。隣の部屋と統合しない・
// 部分指定にしないため、昇降路のセル辺になっているCLは（階段と同じく）片辺の参照だけで
// 復元不能扱いになる。----

test('findUnresolvableCells: 昇降路Room（feature===ELEVATOR_EQUIPMENT）も同様に片辺の参照だけで復元不能として返す', () => {
  const { graph, cellA } = makeTwoCellGraph();
  const room = graph.addRoom(new Set([cellA]), 'EV');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), [cellA],
    '昇降路は再解釈で永久に救済されないため、片辺の参照だけで復元不能扱いになるはず（案a）');
});

// 対照: 同じ配置・同じ削除対象（cellAの右辺）で通常の部屋なら、外側にV7000があるため復元可能（[]）。
test('findUnresolvableCells: 【対照】同じ配置・同じ削除対象で通常の部屋なら片辺喪失は復元可能（空配列）', () => {
  const { graph, cellA } = makeTwoCellGraph();
  graph.addRoom(new Set([cellA]), '部屋'); // featureなし（通常の部屋）
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), [],
    '通常の部屋は対辺2本同時喪失のときだけ復元不能——片辺（外側にV7000がある）だけなら復元可能なはず');
});

// ---- 失敗系: 昇降路の部屋はあるが、判定対象のCLはその昇降路の辺ではなく別の部屋の辺でしかない
// → 昇降路を理由にした拒否は起きない（対辺2本同時喪失でなければ復元可能） ----
test('【失敗系】findUnresolvableCells: 昇降路の部屋があっても、削除対象CLがその昇降路の辺でなければ昇降路を理由に拒否しない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const left   = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opts);
  const top    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  const bottom = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  const right  = graph.addCenterLine(CenterLineType.VERTICAL,   4000, opts);
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, opts); // rightのさらに外側（片辺喪失を復元可能にする）
  const key = `${left.id}:${top.id}:${right.id}:${bottom.id}`;
  graph.addRoom(new Set([key]), '部屋'); // 通常部屋（rightを辺に持つ）

  // 昇降路は別セル（このCLとは無関係）に置く
  const evV = graph.addCenterLine(CenterLineType.VERTICAL,   20000, opts);
  const evV2 = graph.addCenterLine(CenterLineType.VERTICAL,  24000, opts);
  const evH = graph.addCenterLine(CenterLineType.HORIZONTAL, 20000, opts);
  const evH2 = graph.addCenterLine(CenterLineType.HORIZONTAL,24000, opts);
  const ev = graph.addRoom(new Set([`${evV.id}:${evH.id}:${evV2.id}:${evH2.id}`]), 'EV');
  ev.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  assert.deepEqual(findUnresolvableCells(graph, right.id), [],
    '昇降路が存在しても、削除対象CLがその昇降路の辺でなければ拒否理由にはならないはず');
});

// ================================================================
// reinterpretRoomsOnEntry: 戻り値 { unresolved } の検証
// ================================================================

test('reinterpretRoomsOnEntry: 部屋が無ければ{unresolved:[]}を返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  assert.deepEqual(reinterpretRoomsOnEntry(graph), { unresolved: [] });
});

test('reinterpretRoomsOnEntry: 復元不能（regionCellsAtが空）のセルはunresolvedに入り現状維持される', () => {
  // 作業0と同じ構成（最外郭CL削除→regionCellsAtが空）。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const vs = [0, 4000, 8000].map(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  [0, 4000, 8000].forEach(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  const cellKey = worldToCell(2000, 2000, graph).key;
  const room = graph.addRoom(new Set([cellKey]), '部屋');

  graph.removeCenterLine(vs[0].id);

  const result = reinterpretRoomsOnEntry(graph);

  assert.deepEqual(result.unresolved, [cellKey]);
  assert.ok(room.cells.has(cellKey), '復元不能なので現状維持（セルキーは変わらない）');
});

test('reinterpretRoomsOnEntry: 通常に解決できるケースはunresolvedが空のまま', () => {
  const { graph, left, mid, right } = makeRowWithShortenedMiddleDividers();
  graph.addRoom(new Set([left, right]), 'LDK');
  const small = graph.addRoom(new Set([mid]), 'テラス');
  small.setKind(RoomKind.EXTERIOR);

  const result = reinterpretRoomsOnEntry(graph);

  assert.deepEqual(result.unresolved, [], '完全吸収（2辺喪失だが復元可能）はunresolvedに入らないはず');
});

test('reinterpretRoomsOnEntry: 昇降路（feature===ELEVATOR_EQUIPMENT）は辺喪失でも吸収されず現状維持され、隣の部屋も昇降路を吸収しない（ユーザー裁定2026-09-29: 階段と同じ扱い）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  [0, 4000, 6000].forEach(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  const hs = [0, 2000, 4000].map(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  // 左列(0..4000)×2行=ホール、右上セル(4000..6000,0..2000)=独立した昇降路、右下=ホール
  const hallCells = [
    worldToCell(2000, 1000, graph).key,
    worldToCell(2000, 3000, graph).key,
    worldToCell(5000, 3000, graph).key,
  ];
  const hall = graph.addRoom(new Set(hallCells), 'ホール');
  const shaft = graph.addRoom(new Set([worldToCell(5000, 1000, graph).key]), 'EV');
  shaft.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const [shaftCellKey] = shaft.cells;

  // 昇降路とホール右下の境界の横CL(y=2000)を削除する（左列も分けているためホール側も再解釈対象になる）
  graph.removeCenterLine(hs[1].id);
  const result = reinterpretRoomsOnEntry(graph);

  assert.ok(graph.roomMap.has(shaft.id), '昇降路は吸収されず残る');
  assert.equal(shaft.cells.size, 1, '昇降路のセル数は変わらない');
  assert.ok(shaft.cells.has(shaftCellKey), '昇降路のセルは変更されない（ダングリングidも含め現状維持）');
  assert.equal(shaft.referenceRoomIds.size, 0, '昇降路は部分指定にならない');
  assert.equal(result.unresolved.includes(shaftCellKey), false,
    '再解釈除外部屋は候補にすら上がらないため、unresolvedにも（昇降路の分は）入らない');
  assert.ok(graph.roomMap.has(hall.id), 'ホールも残る');
  assert.ok(![...hall.cells].includes(shaftCellKey), '隣の部屋（ホール）が昇降路のセルを吸収してはいけない');
});

// ---- 屋根（RoomFeature.ROOF。ステップB1a）: 再解釈除外（固定セル）。昇降路と同じ構成で検証する ----
test('【B1a・I2】reinterpretRoomsOnEntry: 屋根（kind=EXTERIOR・feature=ROOF）は辺喪失でも動かず、隣の屋内部屋も屋根を吸収しない／屋根も屋内を吸わない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  [0, 4000, 6000].forEach(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  const hs = [0, 2000, 4000].map(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  const hallCells = [
    worldToCell(2000, 1000, graph).key,
    worldToCell(2000, 3000, graph).key,
    worldToCell(5000, 3000, graph).key,
  ];
  const hall = graph.addRoom(new Set(hallCells), 'ホール');
  const roof = graph.addRoom(new Set([worldToCell(5000, 1000, graph).key]), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  const [roofCellKey] = roof.cells;

  graph.removeCenterLine(hs[1].id); // 屋根とホール右下の境界の横CL(y=2000)
  reinterpretRoomsOnEntry(graph);

  assert.ok(graph.roomMap.has(roof.id), '屋根は吸収されず残る');
  assert.deepEqual([...roof.cells], [roofCellKey], '屋根のセルは変更されない（現状維持）');
  assert.equal(roof.referenceRoomIds.size, 0, '屋根は部分指定にならない');
  assert.equal(roof.kind, RoomKind.EXTERIOR);
  assert.equal(roof.feature, RoomFeature.ROOF);
  assert.ok(graph.roomMap.has(hall.id), 'ホールも残る');
  assert.ok(![...hall.cells].includes(roofCellKey), '屋内部屋（ホール）が屋根のセルを吸収してはいけない');
  const ownedByBoth = [...hall.cells].filter(k => roof.cells.has(k));
  assert.deepEqual(ownedByBoth, [], 'I2: 屋根セルは他の部屋と二重に所有されない');
});

test('【B1a】findUnresolvableCells: 屋根も再解釈除外のため、片辺の参照だけで復元不能として返す（【対照】通常の部屋は復元可能＝上のテスト）', () => {
  const { graph, cellA } = makeTwoCellGraph();
  const room = graph.addRoom(new Set([cellA]), '屋根');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.ROOF);
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), [cellA],
    '屋根は再解釈で救済されないため、片辺の参照だけで復元不能扱い（昇降路と同じ既知の限界）');
});

// ================================================================
// findUnresolvableCells（スラブ拡張。H2・2026-09-27）
// ================================================================

test('findUnresolvableCells: スラブ（StructuralSlab.cells）でも対辺2本同時喪失を検出する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const top    = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opts);
  const bottom = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opts);
  const right  = graph.addCenterLine(CenterLineType.VERTICAL,   4000, opts);
  // left側は既に削除済みのCL id（ダングリング参照）。
  const key = `gone-left:${top.id}:${right.id}:${bottom.id}`;
  graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([key]));

  const result = findUnresolvableCells(graph, right.id);

  assert.deepEqual(result, [key], 'スラブのセルでもright削除でleft・right両方喪失=対辺2本同時喪失として返すはず');
});

test('findUnresolvableCells: スラブが片辺しか失わないなら復元不能ではない（空配列）', () => {
  const { graph, cellA } = makeTwoCellGraph();
  graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([cellA]));
  // cellAのright（cellBとの内部境界）を削除対象にする。leftは健在で、rightのさらに外側にも
  // cellBの右端（x=7000）の分割CLがあるため復元不能ではない（S1・2026-09-27: cellAのleftは
  // グリッド最外郭のため、もしleftを削除対象にすると外側に何も無く復元不能になる——
  // 別テストで固定する）。
  const [, , rightId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, rightId), []);
});

// ---- 階段（Stair.cells）: ペアRoom（feature===STAIR）を一時的に
// 失った旧データ（core/stair.js「旧データ」・ensureStairRooms参照）でも、Room判定に
// 頼らずStair.cells自体を直接判定する ----

test('findUnresolvableCells: ペアRoomを持たない階段（Stair.roomId===null）でも、Stair.cellsの片辺の参照だけで復元不能として返す', () => {
  const { graph, cellA } = makeTwoCellGraph();
  graph.addStair({ cells: new Set([cellA]), roomId: null }); // 旧データの再現
  const [leftId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, leftId), [cellA],
    'ペアRoomが無くてもStair.cells自体が判定対象になるはず（裁定変更点）');
});

test('findUnresolvableCells: ペアRoomがある通常経路の階段は、Room側・Stair側の二重判定でも重複なく1件だけ返す', () => {
  const { graph, cellA } = makeTwoCellGraph();
  const room = graph.addRoom(new Set([cellA]), '階段');
  room.setFeature(RoomFeature.STAIR);
  graph.addStair({ cells: new Set([cellA]), roomId: room.id });
  const [leftId] = cellA.split(':');

  assert.deepEqual(findUnresolvableCells(graph, leftId), [cellA],
    'Room側・Stair側どちらも同じキーを検出するが、Setで重複排除され1件のはず');
});

// ================================================================
// reinterpretSlabsAfterCLRemoval（H2・2026-09-27。reinterpretRoomsOnEntryのスラブ版）
// ================================================================

test('reinterpretSlabsAfterCLRemoval: スラブが無ければ{unresolved:[]}を返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  assert.deepEqual(reinterpretSlabsAfterCLRemoval(graph), { unresolved: [] });
});

test('reinterpretSlabsAfterCLRemoval: 内部の仕切りCLが非アクティブ化されると、同一スラブの3セルが1つの併合セルへ置き換わり削除済みidが残らない（同一スラブ内union）', () => {
  const { graph, left, mid, right } = makeRowWithShortenedMiddleDividers();
  const slab = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([left, mid, right]));

  const result = reinterpretSlabsAfterCLRemoval(graph);

  assert.deepEqual(result.unresolved, []);
  assert.equal(slab.cells.size, 1, '3セルは1つの併合セルへ統合されるはず（同一スラブ内union）');
  const [mergedKey] = [...slab.cells];
  for (const oldKey of [left, mid, right]) {
    assert.notEqual(mergedKey, oldKey, '併合セルは行全体を覆う新キーで、旧キーのいずれとも異なるはず');
  }
});

test('reinterpretSlabsAfterCLRemoval: 2つのスラブが同じ領域へ吸収される場合、先に登録されたスラブ（graph.slabs順）が併合セルを領有し、後発スラブは完全吸収されてgraphから削除される（S2・2026-09-27裁定）', () => {
  const { graph, left, mid, right } = makeRowWithShortenedMiddleDividers();
  const slabA = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB-A', new Set([left]));
  const slabB = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB-B', new Set([mid, right]));
  const slabBId = slabB.id;

  const result = reinterpretSlabsAfterCLRemoval(graph);

  assert.deepEqual(result.unresolved, []);
  assert.equal(slabA.cells.size, 1, '先に登録されたスラブAが併合セルを領有するはず');
  assert.equal(graph.slabMap.has(slabBId), false,
    '後発のスラブBは併合により完全吸収され、Roomの完全吸収と同じくgraphから削除されるはず（0セルのまま残さない）');
});

// ---- 貫通孔（PenetrationSleeve。hostType==='slab'）の付け替え（H2追補・2026-09-27） ----

test('reinterpretSlabsAfterCLRemoval: スラブのセルが併合セルへ置き換わると、そのセルをホストするスリーブのhostCellKeyも併合セルのキーへ付け替わる（削除されない）', () => {
  const { graph, left, mid, right } = makeRowWithShortenedMiddleDividers();
  const slab = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([left, mid, right]));
  const sleeve = graph.addSleeve('slab', { hostSlabId: slab.id, hostCellKey: mid, localX: 10, localY: 20 });

  const result = reinterpretSlabsAfterCLRemoval(graph);

  assert.deepEqual(result.unresolved, []);
  assert.equal(graph.sleeveMap.has(sleeve.id), true, 'ホストスラブの領域内に留まるスリーブは削除されないはず');
  assert.equal(slab.cells.size, 1, '前提: 3セルは1つの併合セルへ統合される');
  const [mergedKey] = [...slab.cells];
  assert.equal(sleeve.hostCellKey, mergedKey, 'スリーブのhostCellKeyは併合セルのキーへ付け替わるはず');
  assert.equal(sleeve.localX, 10, 'localX/localYはこのアプリのどこからも読まれないため現状維持（付け替え対象はhostCellKeyのみ）');
  assert.equal(sleeve.localY, 20);
});

test('reinterpretSlabsAfterCLRemoval: セルが別スラブに吸収されたスリーブは削除されず、領有先スラブへ移籍する（S2・2026-09-27裁定）', () => {
  const { graph, left, mid, right } = makeRowWithShortenedMiddleDividers();
  const slabA = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB-A', new Set([left]));
  const slabB = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB-B', new Set([mid, right]));
  const slabAId = slabA.id, slabBId = slabB.id;
  const sleeve = graph.addSleeve('slab', { hostSlabId: slabB.id, hostCellKey: mid });
  const sleeveId = sleeve.id;

  const result = reinterpretSlabsAfterCLRemoval(graph);

  assert.deepEqual(result.unresolved, []);
  assert.equal(slabA.cells.size, 1, '前提: 先に登録されたスラブAが併合セルを領有する');
  assert.equal(graph.slabMap.has(slabBId), false, '前提: 後発のスラブBは完全吸収されgraphから削除される');
  assert.equal(graph.sleeveMap.has(sleeveId), true,
    'スリーブ自体は削除されず、Bの完全吸収先であるAへ移籍するはず（Room併合と同じ考え方）');
  const migrated = graph.sleeveMap.get(sleeveId);
  assert.equal(migrated.hostSlabId, slabAId, 'hostSlabIdは併合セルの領有先（A）へ張り替わるはず');
  const [mergedKey] = [...slabA.cells];
  assert.equal(migrated.hostCellKey, mergedKey, 'hostCellKeyも併合セルのキーへ付け替わるはず');
});

test('reinterpretSlabsAfterCLRemoval: 対辺2本同時喪失（regionCellsAtが空）のセルはunresolvedに入り現状維持される', () => {
  // roomReinterpret.test.jsの作業0・reinterpretRoomsOnEntry版と同じ構成（最外郭CL削除→regionCellsAtが空）。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  const vs = [0, 4000, 8000].map(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  [0, 4000, 8000].forEach(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  const cellKey = worldToCell(2000, 2000, graph).key;
  const slab = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set([cellKey]));

  graph.removeCenterLine(vs[0].id);

  const result = reinterpretSlabsAfterCLRemoval(graph);

  assert.deepEqual(result.unresolved, [cellKey]);
  assert.ok(slab.cells.has(cellKey), '復元不能なので現状維持（セルキーは変わらない）');
});

// ================================================================
// QA実測（2026-09-29）回帰ガード→ユーザー裁定「案a」により書き換え: 昇降路は階段と同じ
// 再解釈対象外（isReinterpretExemptにisShaftFeatureを追加）。旧テストは「独立した昇降路が
// CL削除後の再解釈で部分指定になっても isInteriorWallTarget は true のまま」を確認していたが、
// 対象外化により「部分指定になる」という前提の経路自体が塞がったため、
// 「削除の先読み（findUnresolvableCells）が拒否する」「（先読みを無視して強行しても）
// reinterpretRoomsOnEntryは部分指定化しない」へ内容を差し替える。
// ================================================================
test('【QA回帰・2026-09-29→書換え】独立した昇降路に接する横CLの削除は先読み（findUnresolvableCells）が拒否する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  [0, 4000, 6000].forEach(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  const hs = [0, 2000, 4000].map(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  // 左列(0..4000)×2行=ホール、右上セル(4000..6000,0..2000)=独立した昇降路、右下=ホール
  const hallCells = [
    worldToCell(2000, 1000, graph).key,
    worldToCell(2000, 3000, graph).key,
    worldToCell(5000, 3000, graph).key,
  ];
  graph.addRoom(new Set(hallCells), 'ホール');
  const ev = graph.addRoom(new Set([worldToCell(5000, 1000, graph).key]), 'EV');
  ev.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const [evCellKey] = ev.cells;

  assert.equal(ev.referenceRoomIds.size, 0, '前提: 削除前は独立部屋（部分指定ではない）');
  assert.equal(isInteriorWallTarget(ev, new Set()), true, '前提: 独立部屋は対象（feature に関わらず）');

  // 昇降路とホール右下の境界の横CL(y=2000)は左列（ホール）も分けている
  const result = findUnresolvableCells(graph, hs[1].id);

  assert.ok(result.includes(evCellKey),
    '昇降路のセル辺になっているCLは、再解釈除外部屋の辺を1つでも失う=復元不能として先読みが拒否するはず（案a）');
});

// ================================================================
// 不変条件（moku2-1 2階実測・2026-10-01）: 再解釈は、再解釈除外部屋
// （isReinterpretExempt＝階段・階段吹抜け・未定義・昇降路）とStair.cellsが持つセルを
// 奪わない（セルの二重所有を作らない）。
//
// フィクスチャ: 横2列のグリッド。左列(x0..x1)はさらに上下2セルに分かれ、除外部屋
// （階段ペアRoom等）が占める。右列(x1..x2)は分割なしの1セルで、通常の部屋（廊下相当）
// が占める。列境界のCL(x1)は（floorplanモードでの短縮により）全区間で非アクティブ
// （＝開口）——CL自体は削除しない（moku2-1の実際の原因と同じ。CL削除によるダングリング
// ではなく「存在するが短縮で非アクティブ」なケースを再現する）。
// この開口により、通常の部屋の代表点から見た連結領域（regionCellsAt）は
// [通常の部屋のセル, 除外部屋のセル×2] の3セルになる——不変条件が無いと、通常の部屋が
// 除外部屋のセルを own してしまう（セルの二重所有＝moku2-1の不良の直接原因）。
// ================================================================
function makeExemptOpeningFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  // x1: 列境界だが、extentLo/Hiをグリッド外に置くことで「常に非アクティブ（＝開口）」を表す
  // （CL自体は削除しない。moku2-1の実際の原因＝短縮による非アクティブと同じ再現方法）。
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { ...ARCH, extentLo: 10000, extentHi: 11000 });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  // yMid: 左列(x0..x1)だけを上下に分ける内部仕切り（extentを左列のx範囲に限定）。
  // 右列（通常の部屋）はこの仕切りの影響を受けず1セルのまま——worldToCellの点判定で
  // 両列の「縦区間」の形が食い違うため、x1が非アクティブでも1個の巨大セルへ自動合体せず、
  // regionCellsAtのflood-fillで3つの別個セルとして連結される（実機のL字連結領域と同型）。
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { ...ARCH, extentLo: 0, extentHi: 3000 });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);

  const exemptTopKey    = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const exemptBottomKey = `${x0.id}:${yMid.id}:${x1.id}:${y1.id}`;
  const normalKey       = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;

  const normalRoom = graph.addRoom(new Set([normalKey]), '廊下');

  return { graph, exemptTopKey, exemptBottomKey, normalKey, normalRoom };
}

test('reinterpretRoomsOnEntry【不変条件】: 開口（短縮で非アクティブな列境界CL）を挟んで隣接する通常の部屋は、階段ペアRoom（feature===STAIR）とStair.cellsが持つセルを奪わない', () => {
  const { graph, exemptTopKey, exemptBottomKey, normalKey, normalRoom } = makeExemptOpeningFixture();
  const stairRoom = graph.addRoom(new Set([exemptTopKey, exemptBottomKey]), '階段');
  stairRoom.setFeature(RoomFeature.STAIR);
  const stair = graph.addStair({ cells: new Set([exemptTopKey, exemptBottomKey]), roomId: stairRoom.id });

  // 前提: 通常の部屋（廊下）が開口越しに辺を1つ失っている（再解釈の起動条件）
  assert.deepEqual(lostSides(normalKey, graph), ['left'], '前提: 廊下の左辺（開口）が喪失扱いになる');

  const result = reinterpretRoomsOnEntry(graph);

  // (a) 廊下のcellsが階段セルを含まない（二重所有が起きていない）
  assert.ok(!normalRoom.cells.has(exemptTopKey) && !normalRoom.cells.has(exemptBottomKey),
    '廊下が階段のセルを奪ってはいけない');
  // (b) 階段ペアRoomのcellsは不変
  assert.deepEqual([...stairRoom.cells].sort(), [exemptTopKey, exemptBottomKey].sort(),
    '階段ペアRoomのセルは再解釈の前後で不変のはず');
  // (c) stairUnderRoomsOf（2a判定の部屋抽出）が廊下を誤って拾わない。
  // cellsBeyondBreak（階段ジオメトリ・riser等が必要）はこの純粋な格子テストの対象外のため、
  // 実機で破れ先セルになりうる「階段自身のセル」をbeyondの代役として使う——廊下がこの
  // セル群と物理的に重ならなければ、実際のcellsBeyondBreak（階段セルの部分集合）とも重ならない。
  const beyondProxy = refreshCells(stair.cells, graph);
  assert.deepEqual(stairUnderRoomsOf(stair, graph, beyondProxy), [],
    '廊下が階段のセルを持たないため、2a判定の部屋抽出に廊下が入ってはいけない');
  // (d) 復元不能（unresolved）には入らない——除外対象を除いた残りセル（廊下自身）で
  // 正しく解決できるはず
  assert.deepEqual(result.unresolved, [], '廊下自身のセルで解決できるため復元不能にはならないはず');
});

test('reinterpretRoomsOnEntry【不変条件】: 昇降路（isShaftFeature）が占めるセルも同様に奪われない', () => {
  const { graph, exemptTopKey, exemptBottomKey, normalKey, normalRoom } = makeExemptOpeningFixture();
  const shaftRoom = graph.addRoom(new Set([exemptTopKey, exemptBottomKey]), 'EV');
  shaftRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  assert.ok(isShaftFeature(shaftRoom.feature), '前提: isShaftFeatureがtrueになる種別');

  const result = reinterpretRoomsOnEntry(graph);

  assert.ok(!normalRoom.cells.has(exemptTopKey) && !normalRoom.cells.has(exemptBottomKey),
    '通常の部屋が昇降路のセルを奪ってはいけない');
  assert.deepEqual([...shaftRoom.cells].sort(), [exemptTopKey, exemptBottomKey].sort(),
    '昇降路のセルは再解釈の前後で不変のはず');
  assert.deepEqual(result.unresolved, [], '通常の部屋自身のセルで解決できるため復元不能にはならないはず');
  assert.ok(normalRoom.cells.has(normalKey), '通常の部屋のセル自体は維持される');
});

test('reinterpretRoomsOnEntry【不変条件】: 未定義部屋（RoomFeature.UNDEFINED）が占めるセルも同様に奪われない', () => {
  const { graph, exemptTopKey, exemptBottomKey, normalRoom } = makeExemptOpeningFixture();
  const undefinedRoom = graph.addRoom(new Set([exemptTopKey, exemptBottomKey]), '');
  undefinedRoom.setFeature(RoomFeature.UNDEFINED);

  const result = reinterpretRoomsOnEntry(graph);

  assert.ok(!normalRoom.cells.has(exemptTopKey) && !normalRoom.cells.has(exemptBottomKey),
    '通常の部屋が未定義部屋のセルを奪ってはいけない');
  assert.deepEqual([...undefinedRoom.cells].sort(), [exemptTopKey, exemptBottomKey].sort(),
    '未定義部屋のセルは再解釈の前後で不変のはず');
  assert.deepEqual(result.unresolved, [], '通常の部屋自身のセルで解決できるため復元不能にはならないはず');
});

// ================================================================
// QA指摘1（2026-10-01）: 固定セル自身をoldKeyとして持つ「正規の階段下部屋（2a）」が
// セルを奪われる不良。破れ先セルを通常の部屋が持つのは設計上正しい（stairUnderRoomsOfの
// 前提）——その部屋が開口越しに辺を1つ失っても、固定セル（階段ペアRoom・Stair.cellsの
// セル）自身をoldKeyとして持つなら、洪水させず現状のまま残すべき。QA再現: scratchの
// under.mjs（物入=botを正規に持つ→再解釈でbotを失い廊下の部分指定化→廊下が空になる）。
// ================================================================
test('reinterpretRoomsOnEntry【QA指摘1】: 階段の破れ先セルを正規に持つ通常の部屋（2a）は、そのセル自身を失わない（物入・廊下とも維持される）', () => {
  const { graph, exemptTopKey, exemptBottomKey, normalKey, normalRoom } = makeExemptOpeningFixture();
  const stairRoom = graph.addRoom(new Set([exemptTopKey, exemptBottomKey]), '階段');
  stairRoom.setFeature(RoomFeature.STAIR);
  graph.addStair({ cells: new Set([exemptTopKey, exemptBottomKey]), roomId: stairRoom.id });
  // 物入: 階段の破れ先セル(exemptBottomKey)を正規に持つ通常の部屋（2a。設計上
  // Stair.cells／階段ペアRoomと同じセルを持つのが正しい）。
  const closet = graph.addRoom(new Set([exemptBottomKey]), '物入');

  const result = reinterpretRoomsOnEntry(graph);

  assert.deepEqual([...closet.cells], [exemptBottomKey], '物入はbotを失わず、部分指定にもならないはず');
  assert.equal(closet.referenceRoomIds.size, 0, '物入は廊下の部分指定になってはいけない');
  assert.ok(graph.roomMap.has(closet.id), '物入は吸収削除されてはいけない');
  assert.deepEqual([...normalRoom.cells], [normalKey], '廊下は空にならず、自分のセルを維持するはず');
  assert.deepEqual([...stairRoom.cells].sort(), [exemptTopKey, exemptBottomKey].sort(),
    '階段ペアRoomのセルは不変のはず');
  assert.deepEqual(result.unresolved, [], '廊下自身のセルで解決できるため復元不能にはならないはず');
});

// ================================================================
// QA指摘2（2026-10-01・既存不良）: 多部屋グループの解決で「親にcellsを足す→各エントリの
// oldKeyを消す」の順だと、親自身のoldKeyがcellsに含まれる場合、足したばかりのセルを
// 直後に消してしまい、親が本来維持すべきセルを失う。「先に全oldKeyを消す→その後で足す」
// （1部屋グループと同じ順序）に直すことで防ぐ。
// 指摘1の固定セル判定とは無関係であることを示すため、除外部屋・Stairを一切使わない
// （fixedCellsが空の状態で、通常の部屋どうし2件がflood領域を共有する最小構成）。
// ================================================================
test('reinterpretRoomsOnEntry【QA指摘2】: 多部屋グループで親自身のoldKeyが洪水先の領域に含まれても、親はセルを失わない（除外部屋を使わない最小構成）', () => {
  const { graph, exemptTopKey, exemptBottomKey, normalKey, normalRoom } = makeExemptOpeningFixture();
  // 「大」は通常の部屋（featureなし。除外部屋ではない）。exemptTopKey/exemptBottomKeyという
  // 名前はフィクスチャ共用の都合で、ここでは階段とは無関係な2セルとして使う。
  const big = graph.addRoom(new Set([exemptTopKey, exemptBottomKey]), '大');

  const result = reinterpretRoomsOnEntry(graph);

  // 「大」（親候補。セル数2で廊下より多い）は、開口で連結された領域の全セル
  // （exemptTopKey・exemptBottomKey・normalKey）を維持するはず——自分のoldKeyの削除で
  // 足したばかりのセルを消してしまうと、exemptTopKey・exemptBottomKeyが失われる。
  assert.deepEqual([...big.cells].sort(), [exemptTopKey, exemptBottomKey, normalKey].sort(),
    '親（大）は自分の元のセルを含む領域全体を維持するはず（0件・一部欠落のいずれにもならない）');
  // 廊下（セル数1。子側）は部分指定として同じ領域全体を持つ
  assert.deepEqual([...normalRoom.cells].sort(), [exemptTopKey, exemptBottomKey, normalKey].sort());
  assert.deepEqual([...normalRoom.referenceRoomIds], [big.id], '廊下は大の部分指定になるはず');
  assert.deepEqual(result.unresolved, []);
});

test('【QA回帰・2026-09-29→書換え】先読みを無視して削除を強行しても、reinterpretRoomsOnEntryは独立した昇降路を部分指定化しない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opts = { labeled: false, discipline: Discipline.ARCH };
  [0, 4000, 6000].forEach(x => graph.addCenterLine(CenterLineType.VERTICAL, x, opts));
  const hs = [0, 2000, 4000].map(y => graph.addCenterLine(CenterLineType.HORIZONTAL, y, opts));
  const hallCells = [
    worldToCell(2000, 1000, graph).key,
    worldToCell(2000, 3000, graph).key,
    worldToCell(5000, 3000, graph).key,
  ];
  graph.addRoom(new Set(hallCells), 'ホール');
  const ev = graph.addRoom(new Set([worldToCell(5000, 1000, graph).key]), 'EV');
  ev.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const [evCellKey] = ev.cells;

  // 先読みなら拒否される操作を、テストのため（強行時の安全側動作の確認）にガードを迂回して行う。
  graph.removeCenterLine(hs[1].id);
  reinterpretRoomsOnEntry(graph);

  assert.ok(graph.roomMap.has(ev.id), '昇降路自体は削除されず残る（旧テストと同じ前提）');
  assert.equal(ev.referenceRoomIds.size, 0,
    '再解釈対象外のため部分指定にはならない（旧テストが確認していた「部分指定化」は起きなくなった）');
  assert.equal(ev.cells.size, 1, 'セル数は変わらない');
  assert.ok(ev.cells.has(evCellKey), '昇降路のセルはダングリングidを含んだまま現状維持される（階段と同じ、救済経路が無い設計）');
  assert.equal(ev.feature, RoomFeature.ELEVATOR_EQUIPMENT, 'featureはelevatorEquipmentのまま');
  assert.ok(isShaftFeature(ev.feature), 'isShaftFeatureのまま');
  assert.equal(isInteriorWallTarget(ev, new Set()), true,
    '独立部屋のまま（部分指定化していない）なのでisInteriorWallTargetは変わらずtrue');
});

// QA指摘2の修正で入ったリグレッション: 同じ子部屋が同一グループに「2辺以上喪失」と「1辺喪失」の
// エントリを両方持つとき、全oldKeyを先に消す順序だと2辺喪失側の処理時点で子のcellsが空になり、
// 吸収削除されてしまう（HEADは1辺喪失エントリのoldKeyが残っていたため部分指定になっていた）。
// 吸収か部分指定かはエントリ単位でなく部屋単位で決める（混在は常に部分指定）。
test('reinterpretRoomsOnEntry【QA指摘2・回帰】: 同じグループに2辺喪失→1辺喪失の順でエントリを持つ子部屋は、吸収削除されず部分指定として残る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const A = { labeled: false, discipline: Discipline.ARCH };
  // x1・x2 は1段目（y3000〜6000）だけ非アクティブ → 1段目の3セルが開口で連結する
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, A);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { ...A, extentLo: 3000, extentHi: 6000 });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { ...A, extentLo: 3000, extentHi: 6000 });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 9000, A);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, A);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, A);
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, A);
  const k = (a, b, c, d) => `${a.id}:${b.id}:${c.id}:${d.id}`;
  const r1L = k(x0, y0, x1, y1), r1M = k(x1, y0, x2, y1), r1R = k(x2, y0, x3, y1);
  const r2L = k(x0, y1, x1, y2), r2M = k(x1, y1, x2, y2);
  const big = graph.addRoom(new Set([r1R, r2L, r2M]), '大');
  // 子: r1M（左右とも喪失=2辺）→ r1L（右だけ喪失=1辺）の順
  const child = graph.addRoom(new Set([r1M, r1L]), '子');

  const result = reinterpretRoomsOnEntry(graph);

  assert.ok(graph.roomMap.has(child.id), '子は吸収削除されず残るはず');
  assert.deepEqual([...child.referenceRoomIds], [big.id], '子は大の部分指定になるはず');
  // 1段目の3セルは開口で1つの統合セルになる（旧キーは別のキーへ置き換わる）
  const pt = cellInteriorPoint(r1M, graph);
  const merged = regionCellsAt(pt.x, pt.y, graph).map(c => c.key);
  assert.equal(merged.length, 1, '1段目は統合後1セルのはず');
  assert.ok(child.cells.has(merged[0]), '子のcellsに統合後の1段目セルを含むはず');
  assert.ok(big.cells.has(merged[0]), '大も統合後の1段目セルを持つはず');
  assert.deepEqual(result.unresolved, []);
});
