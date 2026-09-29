// finish/equipment/equipmentTab.js（機械器具タブの行データの組み立て。純関数）の単体テスト。
// 呼び出し側（EquipmentTab.jsx）が実際に渡す形（graph.equipmentRows・graph.rooms・
// equipmentSymbols(catalog)のMap・spanLabel文字列）を模したプレーンオブジェクトを入力にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { buildEquipmentTabEntries, equipmentHighlightKeys } from './equipmentTab.js';
import { worldToCell } from '../gridCells.js';

function makeGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  return graph;
}

function row({ id, no, roomId = null, category = 'ev', usage = 'passenger' }) {
  return { id, no, roomId, category, usage };
}
function room({ id, feature = RoomFeature.ELEVATOR_EQUIPMENT }) {
  return { id, feature };
}

// spanLabelOf/currentFloorLabel（ステップ4・S4で単一の spanLabel 文字列から差し替え。
// 旧: buildEquipmentTabEntries({ …, spanLabel: '1階' })（全行に同じ文字列を適用）
// 新: spanLabelOf(id)（登録済み行ごとに mode.equipmentSpanLabel(id) 相当）・
//     currentFloorLabel（未登録は常に現在の階名）。テストは呼ばれた id を記録するスタブで固定する）。
function makeSpanLabelOf(byId = {}) {
  const calls = [];
  const fn = (id) => { calls.push(id); return byId[id] ?? `span(${id})`; };
  fn.calls = calls;
  return fn;
}

test('buildEquipmentTabEntries: 登録済みをno昇順で並べ、記号・用途・spanLabel（id別にspanLabelOfを呼ぶ）が入る', () => {
  const rows = [row({ id: 'b', no: 2, roomId: 'rb' }), row({ id: 'a', no: 1, roomId: 'ra', usage: 'freight' })];
  const rooms = [room({ id: 'ra' }), room({ id: 'rb' })];
  const symbols = new Map([['a', 'EV1'], ['b', 'EV2']]);
  const spanLabelOf = makeSpanLabelOf({ a: '1階〜3階', b: '1階' });

  const entries = buildEquipmentTabEntries({ rows, rooms, symbols, spanLabelOf, currentFloorLabel: '1階' });

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b'], 'no昇順のはず');
  assert.equal(entries[0].kind, 'row');
  assert.equal(entries[0].symbol, 'EV1');
  assert.equal(entries[0].usage, 'freight');
  assert.equal(entries[0].category, 'ev');
  assert.equal(entries[0].spanLabel, '1階〜3階', 'spanLabelOf(id)の戻り値がそのまま入る');
  assert.equal(entries[1].spanLabel, '1階');
  assert.equal(entries[0].roomId, 'ra');
  assert.deepEqual(spanLabelOf.calls.sort(), ['a', 'b'], 'spanLabelOfは登録済み行ごとにidで呼ばれる');
});

test('buildEquipmentTabEntries: 未登録（行を持たない昇降路Room）は登録済みの後ろにroomOrder順（rooms配列の並び順）で並び、spanLabelは常にcurrentFloorLabel', () => {
  const rows = [row({ id: 'a', no: 1, roomId: 'ra' })];
  // rooms は roomOrder 順（呼び出し側の規約）。未登録は z→y の順で並べておく。
  const rooms = [room({ id: 'ra' }), room({ id: 'rz' }), room({ id: 'ry' })];

  const entries = buildEquipmentTabEntries({
    rows, rooms, symbols: new Map(), spanLabelOf: makeSpanLabelOf(), currentFloorLabel: '2階',
  });

  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, 'row');
  assert.deepEqual(entries.slice(1).map(e => e.roomId), ['rz', 'ry'], 'roomOrder順（roomsの並び順）のはず');
  assert.ok(entries.slice(1).every(e => e.kind === 'unregistered'));
  assert.ok(entries.slice(1).every(e => e.symbol === '昇降路（未登録）'));
  assert.ok(entries.slice(1).every(e => e.category === null && e.usage === null));
  assert.ok(entries.slice(1).every(e => e.spanLabel === '2階'), '未登録は設置階の概念が無いため常にcurrentFloorLabel');
});

test('buildEquipmentTabEntries: 行0件かつ未登録0件は空配列', () => {
  assert.deepEqual(
    buildEquipmentTabEntries({ rows: [], rooms: [], symbols: new Map(), spanLabelOf: makeSpanLabelOf(), currentFloorLabel: '1階' }),
    [],
  );
  // 非shaft属性のRoomは未登録候補にならない
  const rooms = [room({ id: 'r1', feature: null }), room({ id: 'r2', feature: RoomFeature.STAIR })];
  assert.deepEqual(
    buildEquipmentTabEntries({ rows: [], rooms, symbols: new Map(), spanLabelOf: makeSpanLabelOf(), currentFloorLabel: '1階' }),
    [],
  );
});

test('buildEquipmentTabEntries: 行のroomIdが存在しないRoomを指していても例外にならない', () => {
  const rows = [row({ id: 'a', no: 1, roomId: 'no-such-room' })];
  const rooms = []; // roomMapに存在しない

  assert.doesNotThrow(() => {
    const entries = buildEquipmentTabEntries({ rows, rooms, symbols: new Map(), spanLabelOf: makeSpanLabelOf(), currentFloorLabel: '1階' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].roomId, 'no-such-room');
  });
});

test('buildEquipmentTabEntries: 登録済みRoomは未登録として二重に出ない', () => {
  const rows = [row({ id: 'a', no: 1, roomId: 'ra' })];
  const rooms = [room({ id: 'ra' })];

  const entries = buildEquipmentTabEntries({ rows, rooms, symbols: new Map(), spanLabelOf: makeSpanLabelOf(), currentFloorLabel: '1階' });

  assert.equal(entries.length, 1, '登録済みのRoomは未登録候補から除かれるはず');
});

// ---- equipmentHighlightKeys ----

test('equipmentHighlightKeys: 器具行のidなら行のセル（refresh済み）を返す', () => {
  const graph = makeGrid();
  const left  = worldToCell(1000, 750, graph);
  const right = worldToCell(3000, 750, graph);
  const r = graph.addRoom(new Set([left.key, right.key]), '');
  r.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left.key]), roomId: r.id });

  const keys = equipmentHighlightKeys(graph, 'eq1');

  assert.deepEqual([...keys], [left.key], '行のセルだけを返す（Room全体ではない）はず');
});

test('equipmentHighlightKeys: 未登録Roomのidなら Room のセル（refresh済み）を返す', () => {
  const graph = makeGrid();
  const left = worldToCell(1000, 750, graph);
  const r = graph.addRoom(new Set([left.key]), '');
  r.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const keys = equipmentHighlightKeys(graph, r.id);

  assert.deepEqual([...keys], [left.key]);
});

test('equipmentHighlightKeys: 該当なし（idがnull・行もRoomも無い・昇降機でないRoom）は空集合', () => {
  const graph = makeGrid();
  assert.deepEqual([...equipmentHighlightKeys(graph, null)], []);
  assert.deepEqual([...equipmentHighlightKeys(graph, 'no-such-id')], []);
  const plain = graph.addRoom(new Set(['dummy']), '');
  assert.deepEqual([...equipmentHighlightKeys(graph, plain.id)], [], '昇降機でないRoomは対象外のはず');
});
