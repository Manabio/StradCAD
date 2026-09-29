// voidGeometry.js（吹抜け(VOID)・昇降機の×描画データ計算）の単体テスト。
// グリッドの作り方は finish/stair/slabOpening.test.js の makeGrid と同じ方針
// （壁は生成しない——faceRect は壁が無ければCLのeffectiveValueへ落ちるため、
// 描画位置の確認だけならCLだけの最小グラフで足りる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';

import { computeVoidCrosses, showsUpperVoidLabel } from './voidGeometry.js';

// 2×1マス（x:0-1000-2000, y:0-1500）のグリッドを持つグラフとセルキーを作る。
function makeGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  return {
    graph,
    left:  `${x0.id}:${y0.id}:${xm.id}:${y1.id}`,
    right: `${xm.id}:${y0.id}:${x1.id}:${y1.id}`,
  };
}

// 2×2マス（x:0-1000-2000, y:0-1000-2000）のグリッドを持つグラフとセルキーを作る
// （非矩形の判定に4象限が要るため makeGrid とは別に用意する）。
function makeGrid2x2() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  return {
    graph,
    topLeft:     `${x0.id}:${y0.id}:${xm.id}:${ym.id}`,
    topRight:    `${xm.id}:${y0.id}:${x1.id}:${ym.id}`,
    bottomLeft:  `${x0.id}:${ym.id}:${xm.id}:${y1.id}`,
    bottomRight: `${xm.id}:${ym.id}:${x1.id}:${y1.id}`,
  };
}

test('computeVoidCrosses: VOID・昇降機が列挙され、featureが正しい', () => {
  const { graph, left, right } = makeGrid();
  const voidRoom = graph.addRoom(new Set([left]));
  voidRoom.setFeature(RoomFeature.VOID);
  const evRoom = graph.addRoom(new Set([right]));
  evRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 2);
  const byId = new Map(result.map(c => [c.id, c]));
  assert.equal(byId.get(voidRoom.id).feature, RoomFeature.VOID);
  assert.equal(byId.get(evRoom.id).feature, RoomFeature.ELEVATOR_EQUIPMENT);
  // 世界座標がセル矩形（left: x:0-1000 / right: x:1000-2000, y:0-1500）で返る（壁未生成のためCL値そのまま）
  assert.deepEqual(
    [byId.get(voidRoom.id).x1, byId.get(voidRoom.id).x2],
    [0, 1000],
  );
  assert.deepEqual(
    [byId.get(evRoom.id).x1, byId.get(evRoom.id).x2],
    [1000, 2000],
  );
});

test('【失敗系】computeVoidCrosses: STAIR_VOID・通常部屋（feature未設定）は対象外', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.STAIR_VOID);
  graph.addRoom(new Set([right])); // feature未設定＝通常の部屋

  assert.deepEqual(computeVoidCrosses(graph), []);
});

test('【失敗系】computeVoidCrosses: 非矩形（L字）のVOID・昇降機は対象外', () => {
  // VOID（bottomRightを欠いたL字・3セル）
  const voidGrid = makeGrid2x2();
  const voidRoom = voidGrid.graph.addRoom(new Set([voidGrid.topLeft, voidGrid.topRight, voidGrid.bottomLeft]));
  voidRoom.setFeature(RoomFeature.VOID);
  assert.deepEqual(computeVoidCrosses(voidGrid.graph), [], 'VOIDの非矩形はスキップされるはず');

  // QA指摘（低3件・2件目）: 昇降機も同じ非矩形判定を通ることを固定する（別グラフ・同じL字形状）。
  const evGrid = makeGrid2x2();
  const evRoom = evGrid.graph.addRoom(new Set([evGrid.topLeft, evGrid.topRight, evGrid.bottomLeft]));
  evRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  assert.deepEqual(computeVoidCrosses(evGrid.graph), [], '昇降機の非矩形はスキップされるはず（VOIDと同じ矩形判定を通る）');
});

test('computeVoidCrosses: 器具行を持つ昇降路Roomは器具単位で×が出る（1列2基・重ならず合わせるとRoom全体）', () => {
  const { graph, left, right } = makeGrid();
  const room = graph.addRoom(new Set([left, right]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: room.id });
  graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set([right]), roomId: room.id });

  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 2, 'Room単位ではなく器具単位で2件');
  const byId = new Map(result.map(c => [c.id, c]));
  assert.ok(byId.has('eq1') && byId.has('eq2'), 'idは行のid');
  assert.ok(!byId.has(room.id), 'Room単位の×は出ない');

  const a = byId.get('eq1'), b = byId.get('eq2');
  // 重ならない（aの右端とbの左端が一致 or 逆）
  assert.ok(a.x2 <= b.x1 || b.x2 <= a.x1, `矩形が重なっている: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
  // 合わせるとRoom全体（x:0〜2000）になる
  assert.deepEqual([Math.min(a.x1, b.x1), Math.max(a.x2, b.x2)], [0, 2000]);
});

test('computeVoidCrosses: L字に統合されたRoom（2行）でも×が2つ（idは行のid）', () => {
  const grid = makeGrid2x2();
  const room = grid.graph.addRoom(new Set([grid.topLeft, grid.topRight, grid.bottomLeft]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  grid.graph.addEquipmentRow({
    id: 'eqTop', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set([grid.topLeft, grid.topRight]), roomId: room.id,
  });
  grid.graph.addEquipmentRow({
    id: 'eqBottom', category: 'ev', usage: 'passenger', no: 2,
    cellKeys: new Set([grid.bottomLeft]), roomId: room.id,
  });

  const result = computeVoidCrosses(grid.graph);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(c => c.id).sort(), ['eqBottom', 'eqTop']);
});

test('computeVoidCrosses: 器具行の無い矩形の昇降路Roomは従来どおり×が1つ（idはRoomのid）', () => {
  const { graph, left, right } = makeGrid();
  const room = graph.addRoom(new Set([left, right]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  // 器具行を一切追加しない（旧データ相当）

  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, room.id);
});

test('【失敗系】computeVoidCrosses: 行のcellKeysが解決できない（CL無し）行は×を出さず例外にもならない', () => {
  const { graph, left } = makeGrid();
  const room = graph.addRoom(new Set([left]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.addEquipmentRow({
    id: 'eqBroken', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set(['no-such-cl-1:no-such-cl-2:no-such-cl-3:no-such-cl-4']), roomId: room.id,
  });

  assert.doesNotThrow(() => computeVoidCrosses(graph));
  const result = computeVoidCrosses(graph);
  assert.deepEqual(result.map(c => c.id), [], '解決できない行の×は出ない（他に器具行が無いためRoom側も無し）');
});

test('【失敗系】computeVoidCrosses: 行のroomIdが存在しないRoomを指しても例外にならない', () => {
  const { graph, left } = makeGrid();
  graph.addEquipmentRow({
    id: 'eqOrphan', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set([left]), roomId: 'no-such-room-id',
  });

  assert.doesNotThrow(() => computeVoidCrosses(graph));
  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 1, '行自体のセルは解決できるので×は出る（roomIdの有効性はcross算出に無関係）');
  assert.equal(result[0].id, 'eqOrphan');
});

test('showsUpperVoidLabel: VOIDのみtrue（昇降機・feature無しはfalse）', () => {
  assert.equal(showsUpperVoidLabel({ feature: RoomFeature.VOID }), true);
  assert.equal(showsUpperVoidLabel({ feature: RoomFeature.ELEVATOR_EQUIPMENT }), false, '昇降機は同じシャフトが続くだけなので破線のみ（裁定Q8）');
  assert.equal(showsUpperVoidLabel({ feature: null }), false);
  assert.equal(showsUpperVoidLabel(null), false, 'crossが無くても例外を投げない');
});

