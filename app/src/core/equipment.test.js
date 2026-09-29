// core/equipment.js（EquipmentRow）と core/planGraph.js の器具行 CRUD ・リセットの単体テスト
// （昇降機の仕様追加 ステップ3 S1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EquipmentRow } from './equipment.js';
import { ElevatorEquipmentCategory, EvUsage, DEFAULT_EV_USAGE } from './constants.js';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

// ---- EquipmentRow ----

test('EquipmentRow: 必須フィールドが揃っていれば作れ、setter で usage/no/cellKeys/roomId を変更できる', () => {
  const row = new EquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: EvUsage.PASSENGER, no: 1,
    cellKeys: new Set(['a:b:c:d']),
  });
  assert.equal(row.id, 'eq1');
  assert.equal(row.category, ElevatorEquipmentCategory.EV);
  assert.equal(row.roomId, null);

  row.setUsage(EvUsage.FREIGHT);
  row.setNo(2);
  row.setCellKeys(new Set(['x:y:z:w']));
  row.setRoomId('room1');
  assert.equal(row.usage, EvUsage.FREIGHT);
  assert.equal(row.no, 2);
  assert.deepEqual([...row.cellKeys], ['x:y:z:w']);
  assert.equal(row.roomId, 'room1');
});

test('【失敗系】new EquipmentRow({}) は id/category/no/cellKeys 欠落で throw する（黙って既定値に落ちない）', () => {
  assert.throws(() => new EquipmentRow({}));
  assert.throws(() => new EquipmentRow({ id: 'eq1' }));
  assert.throws(() => new EquipmentRow({ id: 'eq1', category: 'ev' }));
  assert.throws(() => new EquipmentRow({ id: 'eq1', category: 'ev', no: 1 }));
});

test('EquipmentRow.toData()/fromData(): 全フィールドが往復する', () => {
  const row = new EquipmentRow({
    id: 'eq1', category: 'ev', usage: EvUsage.PASSENGER_FREIGHT, no: 3,
    cellKeys: new Set(['a:b:c:d', 'e:f:g:h']), roomId: 'room9',
  });
  const restored = EquipmentRow.fromData(row.toData());
  assert.deepEqual(restored.toData(), row.toData());
});

test('EquipmentRow.fromData(): 旧データ・壊れたデータの既定（usage空→既定・category空→ev・no未満1または非有限→1・roomId空→null）', () => {
  const row = EquipmentRow.fromData({ id: 'eq1', cellKeys: ['a:b:c:d'] });
  assert.equal(row.usage, DEFAULT_EV_USAGE);
  assert.equal(row.category, ElevatorEquipmentCategory.EV);
  assert.equal(row.no, 1);
  assert.equal(row.roomId, null);

  assert.equal(EquipmentRow.fromData({ id: 'eq2', cellKeys: [], no: 0 }).no, 1);
  assert.equal(EquipmentRow.fromData({ id: 'eq3', cellKeys: [], no: NaN }).no, 1);
  assert.equal(EquipmentRow.fromData({ id: 'eq4', cellKeys: [], no: -3 }).no, 1);
  // 未知の非空文字列の分類は保持する。
  assert.equal(EquipmentRow.fromData({ id: 'eq5', cellKeys: [], category: 'escalator' }).category, 'escalator');
});

// ---- PlanGraph 側の CRUD・リセット ----

test('PlanGraph.addEquipmentRow/removeEquipmentRow: 追加・削除できる', () => {
  const graph = makeGraph();
  const row = graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: DEFAULT_EV_USAGE, no: 1, cellKeys: new Set(['a:b:c:d']) });
  assert.equal(graph.equipmentRows.length, 1);
  assert.equal(graph.equipmentRows[0], row);

  graph.removeEquipmentRow('eq1');
  assert.equal(graph.equipmentRows.length, 0);
});

test('PlanGraph.removeEquipmentRowsByRoomId: roomId を指す器具行をすべて削除する（他roomIdの行は残す）', () => {
  const graph = makeGraph();
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: DEFAULT_EV_USAGE, no: 1, cellKeys: new Set(['a']), roomId: 'r1' });
  graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: DEFAULT_EV_USAGE, no: 2, cellKeys: new Set(['b']), roomId: 'r1' });
  graph.addEquipmentRow({ id: 'eq3', category: 'ev', usage: DEFAULT_EV_USAGE, no: 3, cellKeys: new Set(['c']), roomId: 'r2' });

  graph.removeEquipmentRowsByRoomId('r1');

  assert.deepEqual(graph.equipmentRows.map(r => r.id), ['eq3']);
});

test('PlanGraph.clearFloorData(): equipmentRows が空になる（階切替での漏れ防止）', () => {
  const graph = makeGraph();
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: DEFAULT_EV_USAGE, no: 1, cellKeys: new Set(['a:b:c:d']) });
  assert.equal(graph.equipmentRows.length, 1);

  graph.clearFloorData();

  assert.equal(graph.equipmentRows.length, 0);
});

