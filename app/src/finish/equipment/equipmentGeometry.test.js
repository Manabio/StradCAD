// finish/equipment/equipmentGeometry.js（昇降機器具の幾何。graphを読むだけの純関数）の単体テスト。
// 呼び出し側が実際に渡す形（PlanGraphのRoom・graph.equipmentRows）を入力にする
// （plan/planHoleMarks.test.js・finish/stair/slabOpening.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, RoomKind } from '@core';
import {
  isRegisteredShaftRoom, findAdjacentShaftRooms, equipmentAtCell, equipmentFootprints,
} from './equipmentGeometry.js';

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

function makeShaftRoom(graph, cellKey, { name = '' } = {}) {
  const room = graph.addRoom(new Set([cellKey]), name);
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  return room;
}

test('isRegisteredShaftRoom: 昇降機属性・屋内・referenceRoomIds空・器具行がroomIdを指す のすべてを満たすときだけ true', () => {
  const { graph, left } = makeGrid();
  const room = makeShaftRoom(graph, left);
  assert.equal(isRegisteredShaftRoom(graph, room), false, '器具行が無ければfalse');

  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: room.id });
  assert.equal(isRegisteredShaftRoom(graph, room), true);
});

test('isRegisteredShaftRoom: 屋外の昇降機属性Room・feature無しのRoomはfalse', () => {
  const { graph, left } = makeGrid();
  const room = makeShaftRoom(graph, left);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: room.id });
  room.setKind(RoomKind.EXTERIOR);
  assert.equal(isRegisteredShaftRoom(graph, room), false, '屋外はfalse');

  const plain = graph.addRoom(new Set(['dummy']), '');
  assert.equal(isRegisteredShaftRoom(graph, plain), false, 'feature無しはfalse');
});

test('findAdjacentShaftRooms: 辺で隣接する登録済み昇降路Roomだけを返す（角だけ接する・未登録・自身除外は対象外）', () => {
  const { graph, left, right } = makeGrid();
  const shaftRoom = makeShaftRoom(graph, right);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([right]), roomId: shaftRoom.id });

  const adjacent = findAdjacentShaftRooms(graph, new Set([left]));
  assert.deepEqual(adjacent.map(r => r.id), [shaftRoom.id]);

  // 未登録（器具行が無い）の昇降路Roomは対象外。
  const { graph: g2, left: l2, right: r2 } = makeGrid();
  makeShaftRoom(g2, r2); // 器具行を追加しない＝未登録
  assert.deepEqual(findAdjacentShaftRooms(g2, new Set([l2])), []);

  // excludeRoomId で自身を除外できる。
  assert.deepEqual(findAdjacentShaftRooms(graph, new Set([left]), { excludeRoomId: shaftRoom.id }), []);
});

test('equipmentAtCell: 行のセルは kind=row、行の無い旧データの昇降路Roomのセルは kind=unregistered、それ以外は null', () => {
  const { graph, left, right } = makeGrid();
  const registeredRoom = makeShaftRoom(graph, left);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: registeredRoom.id });
  const unregisteredRoom = makeShaftRoom(graph, right);

  assert.deepEqual(equipmentAtCell(graph, left), { id: 'eq1', kind: 'row' });
  assert.deepEqual(equipmentAtCell(graph, right), { id: unregisteredRoom.id, kind: 'unregistered' });
  assert.equal(equipmentAtCell(graph, 'no-such-cell'), null);
});

test('equipmentFootprints: 行ごとのrefresh済みセルを返す（空のものは除く）', () => {
  const { graph, left, right } = makeGrid();
  const room = makeShaftRoom(graph, left);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: room.id });
  graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set(), roomId: null }); // 空セル

  const footprints = equipmentFootprints(graph);
  assert.equal(footprints.length, 1);
  assert.equal(footprints[0].id, 'eq1');
  assert.equal(footprints[0].roomId, room.id);
  assert.deepEqual([...footprints[0].cells], [left]);
  void right;
});
