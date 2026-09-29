// finish/equipment/equipmentOps.js（昇降機器具の確定・削除。graphを書き換える純関数群）の
// 単体テスト。modes/FinishModeStateEquipment.test.js は FinishModeState.applyNaming/deleteEquipment
// 経由の統合的な確認、こちらは equipmentOps.js を直接呼ぶ単体確認（失敗系・境界値中心）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature, isShaftFeature } from '@core';
import { worldToCell } from '../gridCells.js';
import { validateElevatorInstall, installEquipment, removeEquipment, applyEquipmentNumbers } from './equipmentOps.js';
import { ERR_ELEVATOR_NOT_UNASSIGNED, ERR_ELEVATOR_NOT_RECTANGLE, ERR_ELEVATOR_EXTERIOR } from '../../error.js';

function makeGrid2x1() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  return graph;
}

function makeGrid2x2() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opt);
  return graph;
}

test('validateElevatorInstall: 優先順位は 新規候補でない/部分指定 → 矩形でない → 屋外 の順', () => {
  const graph = makeGrid2x1();
  const left  = worldToCell(1000, 750, graph);
  const right = worldToCell(3000, 750, graph);

  // 1. 新規候補でない
  const notNewRoom = graph.addRoom(new Set([left.key]));
  assert.equal(
    validateElevatorInstall({ graph, room: notNewRoom, kind: RoomKind.EXTERIOR, isNewCandidate: false }),
    ERR_ELEVATOR_NOT_UNASSIGNED,
    '新規候補でなければ屋外でもNOT_UNASSIGNEDが最優先',
  );

  // 部分指定（referenceRoomIds非空）も新規候補扱いにならない
  const parent  = graph.addRoom(new Set([left.key, right.key]));
  const partial = graph.addRoom(new Set([left.key]), '', crypto.randomUUID(), new Set([parent.id]));
  assert.equal(
    validateElevatorInstall({ graph, room: partial, kind: RoomKind.INTERIOR, isNewCandidate: true }),
    ERR_ELEVATOR_NOT_UNASSIGNED,
    '部分指定は isNewCandidate:true でもNOT_UNASSIGNED',
  );

  // 2. 矩形でない（2x2グリッドのL字。3セルのうち1つ欠け）— 屋外区分でも矩形判定が先に赤くなる
  const grid2x2 = makeGrid2x2();
  const tl = worldToCell(1000, 750, grid2x2);
  const tr = worldToCell(3000, 750, grid2x2);
  const bl = worldToCell(1000, 2250, grid2x2);
  const nonRect = grid2x2.addRoom(new Set([tl.key, tr.key, bl.key]));
  assert.equal(
    validateElevatorInstall({ graph: grid2x2, room: nonRect, kind: RoomKind.EXTERIOR, isNewCandidate: true }),
    ERR_ELEVATOR_NOT_RECTANGLE,
    '矩形判定の方が屋外判定より先（新規候補・非部分指定の場合）',
  );

  // 3. 屋外（矩形は満たす）
  const rectRoom = graph.addRoom(new Set([left.key, right.key]));
  assert.equal(
    validateElevatorInstall({ graph, room: rectRoom, kind: RoomKind.EXTERIOR, isNewCandidate: true }),
    ERR_ELEVATOR_EXTERIOR,
  );

  // 通る場合は null
  assert.equal(
    validateElevatorInstall({ graph, room: rectRoom, kind: RoomKind.INTERIOR, isNewCandidate: true }),
    null,
  );
});

test('【失敗系】installEquipment: cellsが空なら throw する', () => {
  const graph = makeGrid2x1();
  assert.throws(() => installEquipment(graph, {
    id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cells: new Set(),
  }));
});

test('installEquipment: 隣接する登録済み昇降路Roomが無く候補も無ければ新規Roomを作る', () => {
  const graph = makeGrid2x1();
  const left = worldToCell(1000, 750, graph);

  const { equipmentId, roomId } = installEquipment(graph, {
    id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cells: new Set([left.key]),
  });

  assert.equal(graph.equipmentRows.length, 1);
  assert.equal(graph.equipmentRows[0].id, equipmentId);
  const room = graph.roomMap.get(roomId);
  assert.ok(room);
  assert.equal(isShaftFeature(room.feature), true);
});

test('installEquipment: 統合先の generatedWallIds は統合で消える（QA指摘T6）', () => {
  const graph = makeGrid2x1();
  const left  = worldToCell(1000, 750, graph);
  const right = worldToCell(3000, 750, graph);

  const { roomId: firstRoomId } = installEquipment(graph, {
    id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cells: new Set([left.key]),
  });
  const firstRoom = graph.roomMap.get(firstRoomId);
  firstRoom.generatedWallIds.add('stale-wall-1');
  assert.equal(firstRoom.generatedWallIds.size, 1, '前提: 統合前は壁idを持つ');

  const { roomId: mergedRoomId } = installEquipment(graph, {
    id: 'eq2', category: 'ev', usage: 'passenger', no: 2, cells: new Set([right.key]),
  });

  assert.equal(mergedRoomId, firstRoomId, '前提: 辺で隣接するので統合先は先に登録した器具のRoom');
  assert.equal(graph.roomMap.get(mergedRoomId).generatedWallIds.size, 0,
    '統合でセルが変わるため、古い壁idの記録は消えるはず');
});

test('removeEquipment: 存在しないidは removed:false・graphを変更しない', () => {
  const graph = makeGrid2x1();
  const before = JSON.stringify([...graph.equipmentRows]);
  const result = removeEquipment(graph, 'no-such-id');
  assert.deepEqual(result, { removed: false, keptRoomId: null, createdShaftRoomIds: [], undefinedRoomId: null });
  assert.equal(JSON.stringify([...graph.equipmentRows]), before);
});

test('removeEquipment: roomId が存在しないRoomを指す行（壊れたデータ）は行だけ削除され例外にならない', () => {
  const graph = makeGrid2x1();
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(['x']), roomId: 'no-such-room' });

  const result = removeEquipment(graph, 'eq1');

  assert.equal(result.removed, true);
  assert.equal(result.keptRoomId, null);
  assert.equal(result.undefinedRoomId, null);
  assert.equal(graph.equipmentRows.length, 0);
});

// QA指摘（ステップ3全体・T10）: makeGrid2x1は2セルしか無く分割（非連結化）を起こせないため、
// 3セル構成のグラフで「中央削除→左右が分割される」場面を作る。
test('removeEquipment【分割・3セル】: 中央削除で分割されるとき、新しく作られる昇降路Roomの区分は元のRoomと同じ', () => {
  const graph3 = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph3.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph3.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  graph3.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph3.addCenterLine(CenterLineType.VERTICAL,   6000, opt);
  graph3.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph3.addCenterLine(CenterLineType.HORIZONTAL, 3000, opt);
  const left  = worldToCell(1000, 1500, graph3);
  const mid   = worldToCell(3000, 1500, graph3);
  const right = worldToCell(5000, 1500, graph3);
  const room = graph3.addRoom(new Set([left.key, mid.key, right.key]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  room.setKind(RoomKind.INTERIOR);
  graph3.addEquipmentRow({ id: 'left-row',  category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left.key]),  roomId: room.id });
  graph3.addEquipmentRow({ id: 'mid-row',   category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set([mid.key]),   roomId: room.id });
  graph3.addEquipmentRow({ id: 'right-row', category: 'ev', usage: 'passenger', no: 3, cellKeys: new Set([right.key]), roomId: room.id });

  const result = removeEquipment(graph3, 'mid-row');

  assert.equal(result.createdShaftRoomIds.length, 1, '前提: 3基目（right）側が分割で新規Roomになる');
  const newRoom = graph3.roomMap.get(result.createdShaftRoomIds[0]);
  assert.equal(newRoom.kind, room.kind, '分割で新しく作られるRoomの区分は元のRoomと同じはず');
});

test('applyEquipmentNumbers: noByIdに無いidは変更しない。変更した件数を返す', () => {
  const graph = makeGrid2x1();
  const left = worldToCell(1000, 750, graph);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 5, cellKeys: new Set([left.key]) });
  graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: 'passenger', no: 9, cellKeys: new Set([left.key]) });

  const changed = applyEquipmentNumbers(graph, new Map([['eq1', 1]]));

  assert.equal(changed, 1);
  assert.equal(graph.equipmentRows.find(r => r.id === 'eq1').no, 1);
  assert.equal(graph.equipmentRows.find(r => r.id === 'eq2').no, 9, 'noByIdに無いidは変更しないはず');
});
