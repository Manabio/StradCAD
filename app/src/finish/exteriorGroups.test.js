// finish/exteriorGroups.js（外部タブ GroupedExteriorTable の群構成の唯一の供給源）の単体テスト。
// react／store.js／.jsx を静的にimportしない純モジュールのため node:test から直接importできる
// （modes/FinishModeState.test.jsと同じ方針）。呼び出し側（GroupedExteriorTable）が実際に渡す形
// （graph.rooms・graph.exteriorRows・graph.roomOrder）をそのまま入力にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, RoomKind, RoomFeature } from '@core';
import { buildExteriorGroups, isExteriorRoomGroupRoom } from './exteriorGroups.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// 部屋を1つ作り、kind/feature/nameを設定するヘルパー（cellsはダミー。グリッド判定は本モジュールの対象外）。
function makeRoom(graph, name, { kind = RoomKind.INTERIOR, feature = null } = {}) {
  const room = graph.addRoom(new Set([`dummy-${name}-${Math.random()}`]), name);
  room.setKind(kind);
  room.setFeature(feature);
  return room;
}

function input(graph) {
  return { rows: graph.exteriorRows, rooms: graph.rooms, roomOrder: graph.roomOrder };
}

test('isExteriorRoomGroupRoom: kind===EXTERIORかつfeature!==STAIRの部屋だけtrue（HEADのshowLevelRowと同じ条件。QA指摘2026-09-29で訂正）', () => {
  const graph = makeGraph();
  const plain    = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR, feature: null });
  const stair    = makeRoom(graph, '', { kind: RoomKind.EXTERIOR, feature: RoomFeature.STAIR });
  const void_    = makeRoom(graph, '吹抜け', { kind: RoomKind.EXTERIOR, feature: RoomFeature.VOID });
  const ev       = makeRoom(graph, 'EV', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ELEVATOR_EQUIPMENT });
  const interior = makeRoom(graph, '部屋', { kind: RoomKind.INTERIOR, feature: null });

  assert.equal(isExteriorRoomGroupRoom(plain), true);
  assert.equal(isExteriorRoomGroupRoom(void_), true, '吹抜けは屋外部屋の群の対象（階段ではない）');
  assert.equal(isExteriorRoomGroupRoom(ev), true,
    '屋外の昇降路はHEADのshowLevelRowと同じ扱い（除外しない。屋外部屋の群の対象）');
  assert.equal(isExteriorRoomGroupRoom(stair), false);
  assert.equal(isExteriorRoomGroupRoom(interior), false);
  assert.equal(isExteriorRoomGroupRoom(null), false);
  assert.equal(isExteriorRoomGroupRoom(undefined), false);
});

test('buildExteriorGroups: 行あり屋外部屋は連動行から群ができる（part・roomId・rowsを保持）', () => {
  const graph = makeGraph();
  const room = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR, feature: null });
  graph.addExteriorRow('exteriorRows', 'テラス', room.id);

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, `room:${room.id}`);
  assert.equal(groups[0].roomId, room.id);
  assert.equal(groups[0].part, 'テラス');
  assert.equal(groups[0].rows.length, 1);
});

test('buildExteriorGroups: 行0件の屋外部屋も群を出す（part=room.name・rows=[]）', () => {
  const graph = makeGraph();
  const room = makeRoom(graph, 'バルコニー', { kind: RoomKind.EXTERIOR, feature: null });
  // exteriorRowsは1件も無い

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, `room:${room.id}`);
  assert.equal(groups[0].roomId, room.id);
  assert.equal(groups[0].part, 'バルコニー');
  assert.deepEqual(groups[0].rows, []);
});

test('buildExteriorGroups: 屋外階段は行0件なら群を作らない（屋外部屋の群として扱わない）', () => {
  const graph = makeGraph();
  makeRoom(graph, '', { kind: RoomKind.EXTERIOR, feature: RoomFeature.STAIR });
  // exteriorRowsは1件も無い（_syncExteriorRowsを経由していないケースを模す）

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 0);
});

test('buildExteriorGroups: 屋外階段でも行があれば（row-derived）群として現れる——ただし新規合成はしない', () => {
  const graph = makeGraph();
  const stair = makeRoom(graph, '', { kind: RoomKind.EXTERIOR, feature: RoomFeature.STAIR });
  graph.addExteriorRow('exteriorRows', '階段', stair.id);

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].roomId, stair.id);
  assert.equal(groups[0].rows.length, 1);
});

test('buildExteriorGroups: 手入力群（roomIdなし）はpart単位でそのまま群になる', () => {
  const graph = makeGraph();
  graph.addExteriorRow('exteriorRows', '外壁');

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'part:外壁');
  assert.equal(groups[0].roomId, null);
  assert.equal(groups[0].rows.length, 1);
});

test('buildExteriorGroups: 同名partの手入力群と連動群を混同しない（別々の群になる）', () => {
  const graph = makeGraph();
  const room = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR, feature: null });
  graph.addExteriorRow('exteriorRows', 'テラス', room.id); // 連動行
  graph.addExteriorRow('exteriorRows', 'テラス');          // 手入力行（同名part・roomIdなし）

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 2);
  const keys = groups.map(g => g.key);
  assert.ok(keys.includes(`room:${room.id}`));
  assert.ok(keys.includes('part:テラス'));
  const roomGroup = groups.find(g => g.key === `room:${room.id}`);
  const partGroup = groups.find(g => g.key === 'part:テラス');
  assert.equal(roomGroup.rows.length, 1);
  assert.equal(partGroup.rows.length, 1);
});

test('buildExteriorGroups: 屋内の部屋は行0件だと群を作らない', () => {
  const graph = makeGraph();
  makeRoom(graph, '部屋', { kind: RoomKind.INTERIOR, feature: null });

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 0);
});

test('buildExteriorGroups: 屋外の昇降路は行0件でも群が出る（HEADのshowLevelRowと同じ扱い。除外しない）', () => {
  const graph = makeGraph();
  const ev = makeRoom(graph, 'EV', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ELEVATOR_EQUIPMENT });

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].roomId, ev.id);
  assert.equal(groups[0].part, 'EV');
  assert.deepEqual(groups[0].rows, []);
});

test('buildExteriorGroups: Roomが無い連動行（孤立行）も群になる（isExteriorRoomGroupRoom(undefined)は常にfalse）', () => {
  const graph = makeGraph();
  graph.addExteriorRow('exteriorRows', '謎の部位', 'ghost'); // roomMapに存在しないroomId

  const groups = buildExteriorGroups({ rows: graph.exteriorRows, rooms: [], roomOrder: [] });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'room:ghost');
  assert.equal(groups[0].roomId, 'ghost');
  assert.equal(groups[0].rows.length, 1);
  assert.equal(isExteriorRoomGroupRoom(undefined), false);
});

test('buildExteriorGroups: 並び順は「行を持つ群は行の出現順」→「行0件の屋外部屋はroomOrder順でその後ろ」', () => {
  const graph = makeGraph();
  // roomOrder出現順: roomWithRows → roomNoRows1 → roomNoRows2（addRoom呼び出し順=roomOrder追加順）
  const roomWithRows = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR, feature: null });
  const roomNoRows1  = makeRoom(graph, 'バルコニー', { kind: RoomKind.EXTERIOR, feature: null });
  const roomNoRows2  = makeRoom(graph, 'ベランダ', { kind: RoomKind.EXTERIOR, feature: null });
  // rows出現順: 手入力行（外壁）→ roomWithRowsの連動行（roomNoRows1/2には行を作らない）
  graph.addExteriorRow('exteriorRows', '外壁');
  graph.addExteriorRow('exteriorRows', 'テラス', roomWithRows.id);

  const groups = buildExteriorGroups(input(graph));

  assert.deepEqual(groups.map(g => g.key), [
    'part:外壁',
    `room:${roomWithRows.id}`,
    `room:${roomNoRows1.id}`,
    `room:${roomNoRows2.id}`,
  ]);
  // 行0件の合成群は rows:[] のまま
  assert.deepEqual(groups[2].rows, []);
  assert.deepEqual(groups[3].rows, []);
});

// ---- 屋根（RoomFeature.ROOF。ステップB1a）: 専用の群（type:'roof'）を先頭に出す ----
test('buildExteriorGroups: 各群は type を持つ（手入力=part・roomId連動=room・屋外部屋の合成群=room）', () => {
  const graph = makeGraph();
  const withRows = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  const noRows   = makeRoom(graph, 'バルコニー', { kind: RoomKind.EXTERIOR });
  graph.addExteriorRow('exteriorRows', '外壁');
  graph.addExteriorRow('exteriorRows', 'テラス', withRows.id);

  const groups = buildExteriorGroups(input(graph));

  assert.deepEqual(groups.map(g => [g.key, g.type]), [
    ['part:外壁', 'part'],
    [`room:${withRows.id}`, 'room'],
    [`room:${noRows.id}`, 'room'],
  ]);
});

test('isExteriorRoomGroupRoom: 屋根（kind=EXTERIOR・feature=ROOF）は屋外部屋の群の対象外', () => {
  const graph = makeGraph();
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  assert.equal(isExteriorRoomGroupRoom(roof), false, '仕上げレベル行・改名入力・区分セレクタを出さない');
});

test('buildExteriorGroups: 屋根は type:\'roof\'・見出し「屋根」・行なしの群になり、屋外部屋の群に混ざらない', () => {
  const graph = makeGraph();
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });

  const groups = buildExteriorGroups(input(graph));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'roof');
  assert.equal(groups[0].key, `roof:${roof.id}`);
  assert.equal(groups[0].roomId, roof.id);
  assert.equal(groups[0].part, '屋根');
  assert.deepEqual(groups[0].rows, []);
  assert.equal(groups.filter(g => g.type === 'room').length, 0, '屋外部屋の群として二重に出ない');
});

test('buildExteriorGroups: 並びは 下屋（roomOrder順）→ 既存の群（行を持つ群→行0件の屋外部屋）', () => {
  const graph = makeGraph();
  // roomOrder: terrace → roof1 → balcony → roof2
  const terrace = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  const roof1   = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const balcony = makeRoom(graph, 'バルコニー', { kind: RoomKind.EXTERIOR });
  const roof2   = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  graph.addExteriorRow('exteriorRows', '外壁');
  graph.addExteriorRow('exteriorRows', 'テラス', terrace.id);

  const groups = buildExteriorGroups(input(graph));

  assert.deepEqual(groups.map(g => g.key), [
    `roof:${roof1.id}`, `roof:${roof2.id}`,
    'part:外壁', `room:${terrace.id}`, `room:${balcony.id}`,
  ]);
  assert.deepEqual(groups.map(g => g.type), ['roof', 'roof', 'part', 'room', 'room']);
});

test('【失敗系】buildExteriorGroups: 屋内の部屋・Roomが無い屋根id（roomOrder にだけある）は屋根の群を作らない', () => {
  const graph = makeGraph();
  makeRoom(graph, '部屋', { kind: RoomKind.INTERIOR, feature: null });

  const groups = buildExteriorGroups({ rows: [], rooms: graph.rooms, roomOrder: [...graph.roomOrder, 'ghost-roof'] });

  assert.equal(groups.length, 0);
});
