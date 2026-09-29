// finish/equipment/equipmentFigure.js（昇降機器具の図中記号。graphを読むだけの純関数）の単体テスト。
// グリッドの作り方はequipmentGeometry.test.jsと同じ方針。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { computeEquipmentSymbols } from './equipmentFigure.js';
import { selfFloorEquipmentCatalog } from './equipmentNumbering.js';

// 1x2マス（x:0-1000-2000, y:0-1500）のグリッド。left/right は辺で隣接する2セル。
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

function makeShaftRoom(graph, cells) {
  const room = graph.addRoom(new Set(cells), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  return room;
}

test('computeEquipmentSymbols: 1基なら"EV"・位置は包絡矩形の中心', () => {
  const { graph, left } = makeGrid();
  const room = makeShaftRoom(graph, [left]);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: room.id });

  const result = computeEquipmentSymbols(graph, selfFloorEquipmentCatalog(graph.equipmentRows));
  assert.deepEqual(result, [{ id: 'eq1', text: 'EV', x: 500, y: 750 }]);
});

test('computeEquipmentSymbols: 2基は"EV1""EV2"（no順）・位置は各器具ごとの中心', () => {
  const { graph, left, right } = makeGrid();
  const roomL = makeShaftRoom(graph, [left]);
  const roomR = makeShaftRoom(graph, [right]);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: roomL.id });
  graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set([right]), roomId: roomR.id });

  const result = computeEquipmentSymbols(graph, selfFloorEquipmentCatalog(graph.equipmentRows));
  const byId = new Map(result.map(s => [s.id, s]));
  assert.equal(byId.get('eq1').text, 'EV1');
  assert.equal(byId.get('eq2').text, 'EV2');
  assert.deepEqual([byId.get('eq1').x, byId.get('eq1').y], [500, 750]);
  assert.deepEqual([byId.get('eq2').x, byId.get('eq2').y], [1500, 750]);
});

test('【失敗系】computeEquipmentSymbols: 器具0件は空配列', () => {
  const { graph } = makeGrid();
  assert.deepEqual(computeEquipmentSymbols(graph, selfFloorEquipmentCatalog(graph.equipmentRows)), []);
});

test('【失敗系】computeEquipmentSymbols: セルが解決できない行（CL無し）は記号を出さず例外にもならない', () => {
  const { graph } = makeGrid();
  graph.addEquipmentRow({
    id: 'eqBroken', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set(['no-such-cl-1:no-such-cl-2:no-such-cl-3:no-such-cl-4']), roomId: null,
  });

  assert.doesNotThrow(() => computeEquipmentSymbols(graph, selfFloorEquipmentCatalog(graph.equipmentRows)));
  assert.deepEqual(computeEquipmentSymbols(graph, selfFloorEquipmentCatalog(graph.equipmentRows)), []);
});

test('【失敗系】computeEquipmentSymbols: graphが無ければ空配列（例外にならない）', () => {
  assert.deepEqual(computeEquipmentSymbols(null, []), []);
});
