// FinishModeState の部屋新規作成経路（QA G2）。mobx以外はDOM/IndexedDBに依存しないため
// node:testから直接importできる（ElevationModeState.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, applyDefaultBaseboard, RoomKind, RoomFeature } from '@core';
import { FinishModeState } from './FinishModeState.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// startDrag/commitDrag が使う regionCellsAt/worldToCell が拾えるよう、区切りCL（非labeled・
// discipline=ARCH・非dashed）で単一セルの矩形を作る（elevationFaces.test.js等と同じ方針）。
function makeSingleCellGraph() {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  return graph;
}

// ---- QA G2(b): ユーザーの新規部屋指定確定（commitDrag）経路でのみ巾木初期値が入る ----
test('FinishModeState.commitDrag: 未指定領域をドラッグして新規部屋を作ると巾木初期値(木製出幅木/h=60)が入る', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  state.startDrag(2000, 1500); // セル中央
  assert.ok(state.dragState, 'ドラッグが開始されるはず（regionCellsAtが単一セルを返す前提）');
  state.commitDrag();

  assert.ok(state.namingRoomId, '新規部屋のダイアログが開くはず');
  assert.equal(state.namingIsNew, true);
  const room = graph.roomMap.get(state.namingRoomId);
  assert.ok(room, '新規Roomが作られるはず');
  assert.equal(room.finish.baseboardMaterial, '木製出幅木');
  assert.equal(room.finish.baseboardHeight, 'h=60');
});

// ---- 単体: applyDefaultBaseboard は指定の2フィールドだけを初期値にする ----
test('applyDefaultBaseboard: baseboardMaterial/baseboardHeightへ既定値を設定する', () => {
  const graph = makeSingleCellGraph();
  const room = graph.addRoom(new Set(['dummy']), 'テスト');
  assert.equal(room.finish.baseboardMaterial, '', '適用前は空文字のまま（コンストラクタ既定値。QA G2）');

  applyDefaultBaseboard(room);
  assert.equal(room.finish.baseboardMaterial, '木製出幅木');
  assert.equal(room.finish.baseboardHeight, 'h=60');
});

// ---- 失敗系: 既存部屋の完全一致ドラッグ（判定1）はaddRoomを呼ばないため巾木初期値も付与しない ----
test('【失敗系・QA G2】FinishModeState.commitDrag: 既存部屋と完全一致するドラッグは新規Roomを作らない（巾木初期値の対象外）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  state.startDrag(2000, 1500);
  state.commitDrag();
  const firstRoomId = state.namingRoomId;
  const room = graph.roomMap.get(firstRoomId);
  room.finish.setField('baseboardMaterial', ''); // ユーザーが明示的にクリアした想定
  state.namingRoomId = null;

  // 同じ領域を再度ドラッグ（既存部屋と完全一致）→ 既存ダイアログが開くだけで新規作成されない
  state.startDrag(2000, 1500);
  state.commitDrag();

  assert.equal(state.namingRoomId, firstRoomId, '既存部屋がそのまま選択されるはず（新規IDにならない）');
  assert.equal(state.namingIsNew, false);
  assert.equal(graph.roomMap.get(firstRoomId).finish.baseboardMaterial, '',
    '既存部屋の完全一致ドラッグでユーザーのクリアが巾木初期値へ巻き戻ってはいけない');
});

// ---- 屋外部屋（非階段）の外部タブ連動（_syncExteriorRows）----
test('applyNaming: 非階段の部屋をkind=EXTERIORで確定するとexteriorRowsに部位=名前・roomId=部屋IDの行が1件追加される', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');

  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });

  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].part, 'テラス');
});

test('applyNaming: 同じ屋外部屋を別名で再確定すると行は1件のままpartが更新される', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');

  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  state.applyNaming(room.id, { name: 'バルコニー', kind: RoomKind.EXTERIOR, feature: null });

  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1, '行は増えず1件のまま');
  assert.equal(rows[0].part, 'バルコニー');
});

test('applyNaming: 屋外部屋を屋内(kind=INTERIOR)へ再確定するとexteriorRowsの連動行が消える', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');

  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 1);

  state.applyNaming(room.id, { name: '部屋', kind: RoomKind.INTERIOR, feature: null });

  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 0);
});

test('deleteRoom: 非階段の屋外部屋を削除するとexteriorRowsの連動行が消える', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');
  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 1);

  state.deleteRoom(room.id);

  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 0);
  assert.equal(graph.roomMap.has(room.id), false);
});

// ---- 失敗系: 存在しないroomIdはexteriorRowsを増やさない ----
test('【失敗系】applyNaming: 存在しないroomIdを渡すとnullを返しexteriorRowsは増えない', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const before = graph.exteriorRows.length;

  const result = state.applyNaming('no-such-room-id', { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });

  assert.equal(result, null);
  assert.equal(graph.exteriorRows.length, before);
});

// ---- _syncExteriorRows: 屋外階段は既存行のpartを上書きしない（旧挙動維持） ----
test('_syncExteriorRows: 屋外階段（feature=STAIR）は既存行のpartをユーザー編集のまま保つ（上書きしない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '階段');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.STAIR);

  const row = graph.addExteriorRow('exteriorRows', '手編集した部位名', room.id);

  state._syncExteriorRows(room);

  assert.equal(row.part, '手編集した部位名', '既存行のpartは上書きされないはず');
  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 1, '新規行も追加されないはず');
});

test('_syncExteriorRows: 屋外階段で連動行が無ければ部位「階段」で新規追加する', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '階段');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.STAIR);

  state._syncExteriorRows(room);

  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].part, '階段');
});

// ---- CL偏芯（clEccentricities）の下地材個別指定も材照合対象に含める（欠落修正） ----
test('FinishModeState.init: CL偏芯のbackingに未知コードがあるとmaterialErrorが立つ', async () => {
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '999999999999' });
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, false);
  assert.ok(state.materialError, 'materialErrorが設定されるはず');
});

test('FinishModeState.init: CL偏芯のbacking===\'\'（per-floor既定を参照する合図）はmaterialErrorを立てない', async () => {
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '' });
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, true);
  assert.equal(state.materialError, null);
});

test('FinishModeState.init: CL偏芯のbackingが既知コードならmaterialErrorを立てない', async () => {
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '111111111111' });
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, true);
  assert.equal(state.materialError, null);
});
