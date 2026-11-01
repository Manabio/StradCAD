// 部屋の取り合いの部分詳細図の割当て（Room.detailRefs。FBS の RM.DETAIL_KEYS=32・DETAIL_VALS=33）の保存・復元のテスト。
// 割当ての無い部屋は 2 フィールドとも書かない（未使用の文書のバイト列は不変）ことを vtable 直読みで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from 'flatbuffers';
import { Plane, PlanGraph } from './core.js';
import { DetailSlot } from './core/constants.js';
import {
  serializeGraph, restoreGraph, decodeFloorSnapshot, encodeFloorSnapshot,
} from './graphSnapshot.js';
import { snapshotRoomsState, restoreRoomsState } from './finish/roomReinterpret.js';

const GS_ROOMS = 9; // schema/graphFbs.js GS.ROOMS
const RM_DETAIL_KEYS = 32; // schema/graphFbs.js RM.DETAIL_KEYS
const RM_DETAIL_VALS = 33; // schema/graphFbs.js RM.DETAIL_VALS
const { FLOOR_WALL, WALL_CEILING } = DetailSlot;

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
}

/** 部屋 2 つ（id 固定）の階。 */
function makeGraphWithRooms() {
  const graph = makeGraph();
  const a = graph.addRoom(new Set(['c1:r1']), '居間', 'rm0');
  const b = graph.addRoom(new Set(['c2:r1']), '寝室', 'rm1');
  return { graph, rooms: [a, b] };
}

/** i 番目の部屋の FBS テーブルに fieldNo の枠が書かれているか（vtable の有無）。 */
function roomHasField(bytes, roomIdx, fieldNo) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const vecOff = root + bb.__offset(root, 4 + GS_ROOMS * 2);
  const table = bb.__indirect(bb.__vector(vecOff) + roomIdx * 4);
  return bb.__offset(table, 4 + fieldNo * 2) !== 0;
}

function roundTrip(graph) {
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  return restored;
}
const roomOf = (graph, id) => graph.roomMap.get(id);

test('FBS 往復: floorWall だけ／両方の detailRefs が往復する。キーは slot 名の昇順で決定的', () => {
  const { graph, rooms: [a, b] } = makeGraphWithRooms();
  a.setDetailRefs({ [FLOOR_WALL]: 'df-fw' });
  b.setDetailRefs({ [WALL_CEILING]: 'df-wc', [FLOOR_WALL]: 'df-fw' });
  const restored = roundTrip(graph);
  assert.deepEqual(roomOf(restored, 'rm0').detailRefs, { [FLOOR_WALL]: 'df-fw' });
  assert.deepEqual(roomOf(restored, 'rm1').detailRefs, { [FLOOR_WALL]: 'df-fw', [WALL_CEILING]: 'df-wc' });
  assert.deepEqual(Object.keys(roomOf(restored, 'rm1').detailRefs), [FLOOR_WALL, WALL_CEILING]);
  assert.ok(Object.isFrozen(roomOf(restored, 'rm1').detailRefs), '復元後も凍結した正規形');
});

test('割当ての無い部屋は detailRefs が null。空の写像・空文字だけの値も null に正規化され書かれない', () => {
  const { graph, rooms: [a, b] } = makeGraphWithRooms();
  assert.equal(a.detailRefs, null, '既定は null');
  b.setDetailRefs({});
  assert.equal(b.detailRefs, null);
  a.setDetailRefs({ [FLOOR_WALL]: '', [WALL_CEILING]: '' });
  assert.equal(a.detailRefs, null);
  const bytes = serializeGraph(graph);
  assert.equal(roomHasField(bytes, 0, RM_DETAIL_KEYS), false);
  assert.equal(roomOf(roundTrip(graph), 'rm0').detailRefs, null);
});

test('割当ての無い文書のバイト列は不変: 2 フィールドが vtable に無く、キー無しの snapshot の encode と一致し、足して外せば元と一致する', () => {
  const { graph, rooms: [a] } = makeGraphWithRooms();
  const base = serializeGraph(graph);
  for (const i of [0, 1]) {
    assert.equal(roomHasField(base, i, RM_DETAIL_KEYS), false, `部屋${i}: keys を書かない`);
    assert.equal(roomHasField(base, i, RM_DETAIL_VALS), false, `部屋${i}: vals を書かない`);
  }
  const snap = decodeFloorSnapshot(base);
  assert.equal(snap.rooms[0].detailRefs, null);
  for (const r of snap.rooms) delete r.detailRefs;
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base], '旧形式（キー無し）と同じバイト列');

  a.setDetailRefs({ [FLOOR_WALL]: 'df-1' });
  const withRefs = serializeGraph(graph);
  assert.ok(withRefs.length > base.length);
  assert.equal(roomHasField(withRefs, 0, RM_DETAIL_KEYS), true, '前提: 値があれば書く（フィールド番号が合っている）');
  assert.equal(roomHasField(withRefs, 0, RM_DETAIL_VALS), true);
  assert.equal(roomHasField(withRefs, 1, RM_DETAIL_KEYS), false, '割当ての無い隣の部屋は書かない');
  a.setDetailRefs(null);
  assert.deepEqual([...serializeGraph(graph)], [...base], '外せばバイト列は元と一致');
});

test('plain 経路: decodeFloorSnapshot の detailRefs は JSON 往復でも復元できる。キー無しの旧データ（plain）は null', () => {
  const { graph, rooms: [a] } = makeGraphWithRooms();
  a.setDetailRefs({ [FLOOR_WALL]: 'df-fw', [WALL_CEILING]: 'df-wc' });
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const restored = makeGraph();
  restoreGraph(restored, JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(roomOf(restored, 'rm0').detailRefs, { [FLOOR_WALL]: 'df-fw', [WALL_CEILING]: 'df-wc' });
  assert.equal(roomOf(restored, 'rm1').detailRefs, null);

  const legacy = JSON.parse(JSON.stringify(snap));
  for (const r of legacy.rooms) delete r.detailRefs;
  const restoredLegacy = makeGraph();
  restoreGraph(restoredLegacy, legacy);
  assert.equal(roomOf(restoredLegacy, 'rm0').detailRefs, null, 'キー無しは null');
});

test('【失敗系】壊れた入力: 値が空の対・文字列でない値・形が違う値は捨て、残りだけが読める。例外にしない', () => {
  const { graph, rooms: [a] } = makeGraphWithRooms();
  a.setDetailRefs({ [FLOOR_WALL]: 'df-fw', [WALL_CEILING]: 'df-wc' });
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  snap.rooms[0].detailRefs = { [FLOOR_WALL]: '', [WALL_CEILING]: 'df-wc', sill: 7 };
  assert.deepEqual(decodeFloorSnapshot(encodeFloorSnapshot(snap)).rooms[0].detailRefs, { [WALL_CEILING]: 'df-wc' });
  snap.rooms[0].detailRefs = { [FLOOR_WALL]: null };
  assert.equal(decodeFloorSnapshot(encodeFloorSnapshot(snap)).rooms[0].detailRefs, null);
  snap.rooms[0].detailRefs = 'df-fw';
  assert.equal(decodeFloorSnapshot(encodeFloorSnapshot(snap)).rooms[0].detailRefs, null);
});

test('仕上げ undo の部屋スナップショット（snapshotRoomsState／restoreRoomsState）: detailRefs が往復し、キー無しの旧スナップショットは null', () => {
  const { graph, rooms: [a] } = makeGraphWithRooms();
  a.setDetailRefs({ [FLOOR_WALL]: 'df-fw' });
  const snap = snapshotRoomsState(graph);
  assert.deepEqual(snap.rooms[0].detailRefs, { [FLOOR_WALL]: 'df-fw' });
  assert.equal(snap.rooms[1].detailRefs, null);
  a.setDetailRefs({ [WALL_CEILING]: 'df-wc' });
  restoreRoomsState(graph, snap);
  assert.deepEqual(roomOf(graph, 'rm0').detailRefs, { [FLOOR_WALL]: 'df-fw' }, 'undo で戻る');
  const legacy = JSON.parse(JSON.stringify(snap));
  for (const r of legacy.rooms) delete r.detailRefs;
  restoreRoomsState(graph, legacy);
  assert.equal(roomOf(graph, 'rm0').detailRefs, null, 'キー無しは null');
});
