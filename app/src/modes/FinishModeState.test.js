// FinishModeState の部屋新規作成経路（QA G2）。mobx以外はDOM/IndexedDBに依存しないため
// node:testから直接importできる（ElevationModeState.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, applyDefaultBaseboard } from '@core';
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
