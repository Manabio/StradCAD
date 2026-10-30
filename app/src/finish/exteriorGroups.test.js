// finish/exteriorGroups.js（外部タブ GroupedExteriorTable の群構成の唯一の供給源）の単体テスト。
// react／store.js／.jsx を静的にimportしない純モジュールのため node:test から直接importできる
// （modes/FinishModeState.test.jsと同じ方針）。呼び出し側（GroupedExteriorTable）が実際に渡す形
// （graph.rooms・graph.exteriorRows・graph.roomOrder）をそのまま入力にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, RoomKind, RoomFeature } from '@core';
import { buildExteriorGroups, isExteriorRoomGroupRoom, isSelectedRoofGroup } from './exteriorGroups.js';

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

// ---- ステップB2b: 選んだ屋根の群だけが「選択中」になる ----
test('isSelectedRoofGroup: 屋根が複数あるとき、選択中の部屋の屋根の群だけ true', () => {
  const graph = makeGraph();
  const roof1 = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const roof2 = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const groups = buildExteriorGroups(input(graph));

  assert.deepEqual(groups.map(g => isSelectedRoofGroup(g, roof1.id)), [true, false]);
  assert.deepEqual(groups.map(g => isSelectedRoofGroup(g, roof2.id)), [false, true]);
});

test('【失敗系】isSelectedRoofGroup: 未選択（null/undefined）・屋根でない群・存在しない id は常に false', () => {
  const graph = makeGraph();
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const terrace = makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  const [roofGroup, terraceGroup] = buildExteriorGroups(input(graph));

  assert.equal(isSelectedRoofGroup(roofGroup, null), false);
  assert.equal(isSelectedRoofGroup(roofGroup, undefined), false);
  assert.equal(isSelectedRoofGroup(roofGroup, 'ghost'), false);
  assert.equal(isSelectedRoofGroup(terraceGroup, terrace.id), false, '屋外部屋の群は強調しない（屋根の群だけ）');
  assert.equal(isSelectedRoofGroup({ type: 'part', roomId: null }, null), false);
  assert.ok(roof.id);
});

// ---- 主屋根（ステップB3）: includeMainRoof で type:'mainRoof' の群を先頭に出す ----
test('【B3】buildExteriorGroups: includeMainRoof=true で先頭に type:\'mainRoof\'（見出し「屋根（主屋根）」・roomId なし・行なし）が1つ付く。下屋の見出しは「屋根」のまま。並びは 主屋根→下屋→屋外部屋→部位', () => {
  const graph = makeGraph();
  makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  graph.addExteriorRow('exteriorRows', '外壁');
  const groups = buildExteriorGroups({ ...input(graph), includeMainRoof: true });

  assert.deepEqual(groups.map(g => g.type), ['mainRoof', 'roof', 'part', 'room']);
  assert.equal(groups[0].key, 'mainRoof');
  assert.equal(groups[0].roomId, null);
  assert.equal(groups[0].part, '屋根（主屋根）');
  assert.deepEqual(groups[0].rows, []);
  assert.equal(groups[1].roomId, roof.id);
  assert.equal(groups[1].part, '屋根');
  assert.equal(groups.filter(g => g.type === 'mainRoof').length, 1);
});

test('【B3】buildExteriorGroups: includeMainRoof を省略・false にすると従来どおり（主屋根の群なし）。既存の群は同じ並び・同じ中身', () => {
  const graph = makeGraph();
  makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  graph.addExteriorRow('exteriorRows', '外壁');
  const base = buildExteriorGroups(input(graph));
  const off = buildExteriorGroups({ ...input(graph), includeMainRoof: false });
  const on = buildExteriorGroups({ ...input(graph), includeMainRoof: true });

  assert.equal(base.some(g => g.type === 'mainRoof'), false);
  assert.deepEqual(off.map(g => g.key), base.map(g => g.key));
  assert.deepEqual(on.slice(1).map(g => g.key), base.map(g => g.key), '主屋根を除けば従来の群と同じ');
});

test('【B3】buildExteriorGroups: 部屋も行も無い最上階でも主屋根の群だけが出る（includeMainRoof=true）。false なら空', () => {
  const graph = makeGraph();
  assert.deepEqual(buildExteriorGroups({ ...input(graph), includeMainRoof: true }).map(g => g.type), ['mainRoof']);
  assert.equal(buildExteriorGroups(input(graph)).length, 0);
});

test('【B3】isSelectedRoofGroup: 主屋根の群は選択中の部屋 id が何であっても常に false（青枠なし）', () => {
  const graph = makeGraph();
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const [main] = buildExteriorGroups({ ...input(graph), includeMainRoof: true });
  assert.equal(main.type, 'mainRoof');
  for (const selected of [null, undefined, roof.id, 'mainRoof', '']) {
    assert.equal(isSelectedRoofGroup(main, selected), false, String(selected));
  }
});

test('【B3】屋根の部屋（下屋）が無い・複数でも主屋根の群は常に1つで、下屋の群は従来どおり屋根の部屋ごと', () => {
  const graph = makeGraph();
  makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const groups = buildExteriorGroups({ ...input(graph), includeMainRoof: true });
  assert.deepEqual(groups.map(g => g.type), ['mainRoof', 'roof', 'roof']);
});

// ---- 屋根区画（S2）: 主屋根の次・下屋の前に type:'roofZone' の群 ----
test('【屋根区画 S2】buildExteriorGroups: 並びは 主屋根→区画（並び順）→下屋→部位→屋外部屋。区画の key／zoneId／見出し「屋根区画N」', () => {
  const graph = makeGraph();
  makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  graph.addExteriorRow('exteriorRows', '外壁');
  const groups = buildExteriorGroups({
    ...input(graph), includeMainRoof: true, roofZones: [{ id: 'za', empty: false }, { id: 'zb', empty: false }],
  });
  assert.deepEqual(groups.map(g => g.type), ['mainRoof', 'roofZone', 'roofZone', 'roof', 'part', 'room']);
  assert.deepEqual(groups.slice(1, 3).map(g => [g.key, g.zoneId, g.roomId, g.part, g.rows]),
    [['roofZone:za', 'za', null, '屋根区画1', []], ['roofZone:zb', 'zb', null, '屋根区画2', []]]);
  assert.equal(groups[3].roomId, roof.id);
});

test('【屋根区画 S2】buildExteriorGroups: 区画が1件以上あるとき主屋根の見出しは「屋根（主屋根・区画以外）」。0件なら従来の「屋根（主屋根）」', () => {
  const graph = makeGraph();
  assert.equal(buildExteriorGroups({ ...input(graph), includeMainRoof: true })[0].part, '屋根（主屋根）');
  assert.equal(buildExteriorGroups({ ...input(graph), includeMainRoof: true, roofZones: [] })[0].part, '屋根（主屋根）');
  assert.equal(buildExteriorGroups({ ...input(graph), includeMainRoof: true, roofZones: [{ id: 'z', empty: false }] })[0].part,
    '屋根（主屋根・区画以外）');
});

test('【屋根区画 S2】buildExteriorGroups: 実効セルが0の区画の見出しには「（範囲なし）」が付く（番号は並び順のまま）', () => {
  const graph = makeGraph();
  const groups = buildExteriorGroups({
    ...input(graph), includeMainRoof: true, roofZones: [{ id: 'a', empty: false }, { id: 'b', empty: true }],
  });
  assert.deepEqual(groups.slice(1).map(g => g.part), ['屋根区画1', '屋根区画2（範囲なし）']);
});

test('【屋根区画 S2・失敗系】buildExteriorGroups: roofZones を省略・空配列にすると、引数を渡さない呼び出しと出力が同一（deepEqual）。最上階でない（includeMainRoof=false）なら区画を渡しても群は出ない', () => {
  const graph = makeGraph();
  makeRoom(graph, 'テラス', { kind: RoomKind.EXTERIOR });
  makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  graph.addExteriorRow('exteriorRows', '外壁');
  for (const includeMainRoof of [true, false]) {
    const base = buildExteriorGroups({ ...input(graph), includeMainRoof });
    assert.deepEqual(buildExteriorGroups({ ...input(graph), includeMainRoof, roofZones: [] }), base);
  }
  const noTop = buildExteriorGroups({ ...input(graph), includeMainRoof: false, roofZones: [{ id: 'z', empty: false }] });
  assert.deepEqual(noTop, buildExteriorGroups(input(graph)));
});

test('【屋根区画 S2】isSelectedRoofGroup: 区画の群は選択中の区画 id と一致するときだけ true。部屋 id・未選択・省略は false（従来の呼び出しは不変）', () => {
  const graph = makeGraph();
  const roof = makeRoom(graph, '屋根', { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF });
  const groups = buildExteriorGroups({ ...input(graph), includeMainRoof: true, roofZones: [{ id: 'za', empty: false }, { id: 'zb', empty: false }] });
  const [za, zb] = groups.filter(g => g.type === 'roofZone');
  assert.equal(isSelectedRoofGroup(za, null, 'za'), true);
  assert.equal(isSelectedRoofGroup(zb, null, 'za'), false);
  assert.equal(isSelectedRoofGroup(za, 'za', null), false, '部屋 id の欄に区画 id を入れても true にならない');
  assert.equal(isSelectedRoofGroup(za, roof.id), false, '第3引数を省略すると区画は選択なし');
  assert.equal(isSelectedRoofGroup(za, null, undefined), false);
  assert.equal(isSelectedRoofGroup(za, null, 'ghost'), false);
  // 下屋の群は区画 id の影響を受けない
  const roofGroup = groups.find(g => g.type === 'roof');
  assert.equal(isSelectedRoofGroup(roofGroup, roof.id, 'za'), true);
  assert.equal(isSelectedRoofGroup(roofGroup, null, roof.id), false);
});
