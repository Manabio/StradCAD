// FinishModeState._missingUsageForKind（SNAPSHOT_REF_WALKERS を通らない自前ループ）が
// 姿図の配置（graph.placedFigures[].figureKey）の未解決キーを数えることのテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, PlacedFigure } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { undoManager } from '../undoManager.js';
import { PLACED_FIGURE_POSITION_STEP_MM, DetailSlot } from '../core/constants.js';
import { ERR_DETAIL_FIT_FAILED, DETAIL_TARGET_PLACED_FIGURE } from '../error.js';
import { square, wallFaceDatums } from '../finish/placedFigure/placedFigureTestFixtures.js';

const pf = (id, figureKey) => new PlacedFigure({ id, figureKey, x: 300, y: 100, rotationDeg: 90 });

test.afterEach(() => clearOverlays());

function makeState() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  return { graph, state: new FinishModeState(graph, null) };
}

test('_missingUsageForKind(DETAIL_FIGURE): カタログに無い figureKey の配置を {location:placedFigure, placedFigureId, slot:null} で数える', () => {
  const { graph, state } = makeState();
  graph.setPlacedFigures([pf('p1', 'df-ok'), pf('p2', 'df-gone'), pf('p3', 'df-gone')]);
  const usage = state._missingUsageForKind(CatalogKind.DETAIL_FIGURE, new Map([['df-ok', {}]]));
  assert.deepEqual(usage, [
    { code: 'df-gone', location: 'placedFigure', placedFigureId: 'p2', slot: null },
    { code: 'df-gone', location: 'placedFigure', placedFigureId: 'p3', slot: null },
  ]);
});

test('【失敗系】_missingUsageForKind(DETAIL_FIGURE): 配置なし／全て解決済みなら空', () => {
  const { graph, state } = makeState();
  assert.deepEqual(state._missingUsageForKind(CatalogKind.DETAIL_FIGURE, new Map()), []);
  graph.setPlacedFigures([pf('p1', 'df-ok')]);
  assert.deepEqual(state._missingUsageForKind(CatalogKind.DETAIL_FIGURE, new Map([['df-ok', {}]])), []);
});

// ---- P4: 配置待ち・配置・編集・選択・削除 ----

const undoDepth = () => undoManager._undoStack.length;
function placedOne(state, key = 'k', wx = 300.4, wy = -100.6) {
  state.beginFigurePlacement(key);
  state.startDrag(wx, wy);
  return state.graph.placedFigures[0];
}

test('配置: 配置待ち→startDrag で丸めた点に 1 件置き、dragState は作らず、配置待ちを解いて置いた図を選択する', () => {
  const { graph, state } = makeState();
  assert.equal(PLACED_FIGURE_POSITION_STEP_MM, 1);
  state.beginFigurePlacement('k');
  assert.equal(state.placingFigureKey, 'k');
  state.startDrag(300.4, -100.6);
  assert.equal(graph.placedFigures.length, 1);
  const [p] = graph.placedFigures;
  assert.deepEqual([p.figureKey, p.x, p.y, p.rotationDeg, p.mirror, p.zMm, p.note], ['k', 300, -101, 0, false, 0, '']);
  assert.equal(state.dragState, null);
  assert.equal(state.placingFigureKey, null, '1 回置くと配置待ちを解く（連続配置なし）');
  assert.equal(state.selectedPlacedFigureId, p.id);
  state.startDrag(5000, 5000); // 配置待ちでなければ置かない（領域の無い点は何も起きない）
  assert.equal(graph.placedFigures.length, 1);
});

test('配置の undo / redo: 1 操作 1 エントリで 0 件↔1 件（別経路の undo で配置が戻る）', () => {
  const { graph, state } = makeState();
  const before = undoDepth();
  const p = placedOne(state);
  assert.equal(undoDepth(), before + 1);
  undoManager.undo();
  assert.equal(graph.placedFigures.length, 0);
  undoManager.redo();
  assert.deepEqual(graph.placedFigures.map(x => x.toData()), [p.toData()]);
  undoManager.undo(); // 後始末
});

test('排他: 配置待ち中に屋根区画の指定を始めると配置待ちが解ける。屋根区画の指定中に配置待ちを始めると指定が解ける', () => {
  const { state } = makeState();
  state.beginFigurePlacement('k');
  state.setRoofZonePick(true);
  assert.equal(state.placingFigureKey, null);
  state.roofZonePickActive = true; // 最上階判定は project を要るため、フラグを直接立てて「指定中」を作る
  state.beginFigurePlacement('k');
  assert.equal(state.roofZonePickActive, false);
  assert.equal(state.placingFigureKey, 'k');
  state.toggleRoofZonePick();
  assert.equal(state.placingFigureKey, null, 'toggle で始めた側も配置待ちを解く');
});

test('編集: 回転は 90° ずつ（270 の次は 0）・鏡像はトグル・x の更新・それぞれ undo 1 エントリ', () => {
  const { graph, state } = makeState();
  const p = placedOne(state, 'k', 300, -100); // 丸めに依らない整数の点
  const base = undoDepth();
  for (const want of [90, 180, 270, 0]) {
    state.rotatePlacedFigure(p.id);
    assert.equal(graph.placedFigures[0].rotationDeg, want);
  }
  assert.equal(undoDepth(), base + 4);
  state.togglePlacedFigureMirror(p.id);
  assert.equal(graph.placedFigures[0].mirror, true);
  state.togglePlacedFigureMirror(p.id);
  assert.equal(graph.placedFigures[0].mirror, false);
  state.updatePlacedFigure(p.id, { x: 777, zMm: 850 });
  assert.deepEqual([graph.placedFigures[0].x, graph.placedFigures[0].zMm], [777, 850]);
  assert.equal(undoDepth(), base + 7);
  undoManager.undo();
  assert.deepEqual([graph.placedFigures[0].x, graph.placedFigures[0].zMm], [300, 0]);
  for (let i = 0; i < 7; i++) undoManager.undo(); // 後始末（編集 6 + 配置 1。1 件目は上で戻し済み）
});

test('備考: setPlacedFigureNote は undo を積まない（field undo に任せる）。beginFieldUndo〜endFieldUndo で 1 エントリ', async () => {
  const { beginFieldUndo, endFieldUndo } = await import('../finish/finishUndo.js');
  const { graph, state } = makeState();
  const p = placedOne(state);
  const base = undoDepth();
  beginFieldUndo(graph);
  state.setPlacedFigureNote(p.id, 'a');
  state.setPlacedFigureNote(p.id, 'ab');
  assert.equal(undoDepth(), base, 'キーストロークごとには積まない');
  endFieldUndo(graph);
  assert.equal(undoDepth(), base + 1);
  assert.equal(graph.placedFigures[0].note, 'ab');
  undoManager.undo();
  assert.equal(graph.placedFigures[0].note, '');
  undoManager.undo();
});

test('削除: 選択中の配置を消すと選択も外れる。undo で同 id が戻る', () => {
  const { graph, state } = makeState();
  const p = placedOne(state);
  assert.equal(state.selectedPlacedFigureId, p.id);
  state.removePlacedFigure(p.id);
  assert.deepEqual(graph.placedFigures, []);
  assert.equal(state.selectedPlacedFigureId, null);
  undoManager.undo();
  assert.deepEqual(graph.placedFigures.map(x => x.id), [p.id]);
  undoManager.undo();
});

test('【失敗系】無い id の update／rotate／mirror／remove は何も変えず undo も積まない。beginFigurePlacement は空・null・非文字列を無視', () => {
  const { graph, state } = makeState();
  const p = placedOne(state);
  const base = undoDepth();
  const snapshot = graph.placedFigures;
  state.updatePlacedFigure('nope', { x: 1 });
  state.rotatePlacedFigure('nope');
  state.togglePlacedFigureMirror('nope');
  state.removePlacedFigure('nope');
  state.setPlacedFigureNote('nope', 'x');
  assert.equal(graph.placedFigures, snapshot);
  assert.equal(undoDepth(), base);
  assert.equal(state.selectedPlacedFigureId, p.id, '無い id の削除で選択を外さない');
  state.cancelFigurePlacement(); // 配置後の配置待ち解除は別のテストで固定する。ここは入力の検査だけを見る
  for (const bad of ['', null, undefined, 5]) {
    state.beginFigurePlacement(bad);
    assert.equal(state.placingFigureKey, null);
  }
  undoManager.undo();
});

test('選択の相互排他: 部屋・階段・器具・屋根区画を選ぶと配置の選択が外れ、配置を選ぶと他の選択が外れる', () => {
  const { state } = makeState();
  for (const select of [() => state.selectRoom('r1'), () => state.selectEquipment('e1'), () => state.selectRoofZone('z1'), () => state.selectStair('s1')]) {
    state.selectPlacedFigure('p1');
    select();
    assert.equal(state.selectedPlacedFigureId, null);
  }
  state.selectRoom('r1');
  state.selectedStairId = 's1';
  state.selectedEquipmentId = 'e1';
  state.selectedRoofZoneId = 'z1';
  state.selectPlacedFigure('p1');
  assert.deepEqual(
    [state.selectedPlacedFigureId, state.selectedRoomId, state.selectedStairId, state.selectedEquipmentId, state.selectedRoofZoneId],
    ['p1', null, null, null, null]);
  state.selectPlacedFigure(null);
  assert.equal(state.selectedPlacedFigureId, null);
});

test('dispose: 配置待ちと選択を解く', () => {
  const { state } = makeState();
  state.beginFigurePlacement('k');
  state.selectPlacedFigure('p1');
  state.dispose();
  assert.equal(state.placingFigureKey, null);
  assert.equal(state.selectedPlacedFigureId, null);
});

test('init: 配置図の fit 失敗は detail-fit-failed の行として catalogResolveRows に残る（壁厚・段差高さの絞りの外）。参照切れは unresolved-code の行', async () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [square('df-bad', { datums: wallFaceDatums(), label: '不良図' })] });
  const { graph, state } = makeState();
  graph.setPlacedFigures([pf('p1', 'df-bad'), pf('p2', 'df-gone')]);
  await state.init();
  const rows = state.catalogResolveRows;
  const failed = rows.filter(r => r.scenario === 'detail-fit-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].targetLabel, '不良図');
  assert.equal(failed[0].targetKey, DETAIL_TARGET_PLACED_FIGURE);
  assert.ok(failed[0].message.startsWith(ERR_DETAIL_FIT_FAILED('不良図', DETAIL_TARGET_PLACED_FIGURE, '', DetailSlot.FIGURE).replace(/: $/, '')), failed[0].message);
  const unresolved = rows.filter(r => r.scenario === 'unresolved-code' && r.kind === CatalogKind.DETAIL_FIGURE);
  assert.deepEqual(unresolved.map(r => [r.targetKey, r.usage[0].location]), [['df-gone', 'placedFigure']]);
});

test('【失敗系】init: 通知の集計が投げても init は通り、detail-fit-failed の行は 0（仕上げモードに入れなくしない）', async () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [square('df-bad', { datums: wallFaceDatums() })] });
  const { graph, state } = makeState();
  // 図は実在（_missingUsageForKind は id を読まない）で fit に失敗する→集計が行を作る時に id の getter が投げる
  const booby = { figureKey: 'df-bad', get id() { throw new Error('boom'); } };
  graph.setPlacedFigures([booby]);
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  let result;
  try {
    result = await state.init();
  } finally {
    console.error = origError;
  }
  assert.equal(result.ok, true);
  assert.equal(state.catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed').length, 0);
  assert.equal(errors.length, 1, 'console.error に 1 回記録');
});

test('配置待ちと屋根区画の指定が両方立っていても startDrag は配置を優先する（置く・dragState なし）', () => {
  const { graph, state } = makeState();
  state.placingFigureKey = 'k';
  state.roofZonePickActive = true;
  state.startDrag(10, 20);
  assert.equal(graph.placedFigures.length, 1);
  assert.equal(state.dragState, null);
  undoManager.undo();
});

test('【失敗系】init: 配置が無い・全て正常なら detail-fit-failed の行は無い', async () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [square('df-ok')] });
  const { graph, state } = makeState();
  await state.init();
  assert.equal(state.catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed').length, 0);
  graph.setPlacedFigures([pf('p1', 'df-ok')]);
  assert.deepEqual(state._placedFigureFitFailures(), []);
});
