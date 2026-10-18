// CeilingModeState（天伏モード。独立 State）。mobx と純モジュール（ceiling/ceilingSelection.js）にしか
// 依存しないため node:test から直接 import できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun, isObservable } from 'mobx';
import { StairType, CenterLineType, Discipline, RoomFeature, Plane, PlanGraph } from '@core';
import { isUiBusy } from '../uiBusy.js';
import { ERR_CL_MOVE_LOAD_FAILED } from '../error.js';
import { undoManager } from '../undoManager.js';
import { isDirty, clearDirty } from '../dirtyState.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { roomGroupId, zoneGroupId, stairGroupId, stairUnderGroupId } from '../ceiling/ceilingGroups.js';
import { selectedNodeId, nodePathOf, ceilingPanelTree, ceilingPanelLines } from '../ceiling/ceilingPanelRows.js';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';
import { CeilingModeState } from './CeilingModeState.js';
import { FinishModeState } from './FinishModeState.js';

test('CeilingModeState: 既定値（選択なし・内部タブ）。graph を持たず、FinishModeState を継承しない', () => {
  const state = new CeilingModeState();
  assert.equal(state.graph, undefined);
  assert.equal(state.selectedRoomId, null);
  assert.deepEqual(state.expandedPath, []);
  assert.equal(state.activeTab, 'interior');
  assert.ok(!(state instanceof FinishModeState));
  state.dispose();
});

test('CeilingModeState: selectedRoomId（raiseSignal 用）は選択中の群 id。三角の開閉（expandedPath）では変わらず再実行されない', () => {
  const state = new CeilingModeState();
  const seen = [];
  const stop = autorun(() => seen.push(state.selectedRoomId));
  state.toggleNode(0, 'room:r1');
  state.toggleNode(1, 'zone:r1#z');
  state.toggleNode(0, 'room:r1');
  assert.deepEqual(seen, [null], '開閉だけでは変わらない＝BottomSheet が縮まない');
  state.selection = { owner: { kind: 'room', id: 'r1', rowId: 'r1' }, groupId: 'room:r1', cellKeys: new Set() };
  state.dispose();
  stop();
  assert.deepEqual(seen, [null, 'room:r1', null]);
});

test('CeilingModeState（S12c）: toggleNode(depth, id) は、開いている id なら その段以下を畳み、別の id ならその段を付け替えて深い段を畳む（各段1つだけ）', () => {
  const state = new CeilingModeState();
  state.toggleNode(0, 'room:p');
  state.toggleNode(1, 'room:c');
  state.toggleNode(2, 'zone:c#z');
  assert.deepEqual(state.expandedPath, ['room:p', 'room:c', 'zone:c#z']);
  state.toggleNode(2, 'zone:c#z');
  assert.deepEqual(state.expandedPath, ['room:p', 'room:c'], '開いている段のトグルでその段を畳む');
  state.toggleNode(2, 'zone:c#z');
  state.toggleNode(1, 'room:c');
  assert.deepEqual(state.expandedPath, ['room:p'], '途中の段を畳むと深い段も畳まれる');
  state.toggleNode(1, 'room:c');
  state.toggleNode(1, 'zone:p#y');
  assert.deepEqual(state.expandedPath, ['room:p', 'zone:p#y'], '別のノードに付け替えると深い段は畳まれる');
  state.toggleNode(0, 'room:q');
  assert.deepEqual(state.expandedPath, ['room:q'], '最上位の付け替えで子の段も畳まれる');
  state.toggleNode(0, 'room:q');
  assert.deepEqual(state.expandedPath, []);
});

test('CeilingModeState: setActiveTab は interior / stair / exterior を切り替える', () => {
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  assert.equal(state.activeTab, 'stair');
  state.setActiveTab('exterior');
  assert.equal(state.activeTab, 'exterior');
  state.setActiveTab('interior');
  assert.equal(state.activeTab, 'interior');
});

test('【失敗系】CeilingModeState: 未知のタブ名は例外で、activeTab は変わらない', () => {
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  assert.throws(() => state.setActiveTab('roof'), /未知のタブ/);
  assert.equal(state.activeTab, 'stair');
});

test('setMainRoofField: 確定で true・自階 mainRoofSpec が変わり markDirty・undo 1エントリ。graph は引数で受ける', () => {
  const state = new CeilingModeState();
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  clearDirty();
  const stack = undoManager._undoStack.length;
  assert.equal(state.setMainRoofField(graph, 'soffitNote', '目透かし貼り'), true);
  assert.equal(graph.mainRoofSpec.soffitNote, '目透かし貼り');
  assert.equal(isDirty(), true);
  assert.equal(undoManager._undoStack.length, stack + 1);
  undoManager.undo();
  assert.equal(graph.mainRoofSpec.soffitNote, '');
});

test('【失敗系】setMainRoofField: 不正な値・無変更は false で markDirty も undo も積まない', () => {
  const state = new CeilingModeState();
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  clearDirty();
  const stack = undoManager._undoStack.length;
  assert.equal(state.setMainRoofField(graph, 'soffitOrientation', 'diagonal'), false, '不正な値');
  assert.equal(state.setMainRoofField(graph, 'soffitNote', ''), false, '無変更');
  assert.equal(isDirty(), false);
  assert.equal(undoManager._undoStack.length, stack);
});

test('setAboveRoofContext は observable（購読者が置換で再実行される）。既定は null', () => {
  const state = new CeilingModeState();
  assert.equal(state.aboveRoofContext, null);
  let runs = 0;
  const dispose = autorun(() => { void state.aboveRoofContext; runs++; });
  state.setAboveRoofContext({ planeId: 'p1', aboveGraph: {} });
  assert.equal(runs, 2);
  dispose();
});

test('CeilingModeState: dispose で選択を解除する（タブは保つ）。dispose の二重呼びも例外にならない', () => {
  const state = new CeilingModeState();
  state.toggleNode(0, 'room:r1');
  state.setActiveTab('stair');
  state.dispose();
  assert.equal(state.selectedRoomId, null);
  assert.deepEqual(state.expandedPath, []);
  assert.equal(state.activeTab, 'stair');
  assert.doesNotThrow(() => state.dispose());
});

// ---- 天井セルのドラッグ選択（S2）----
const XS = [0, 1000, 2000, 3000, 4000];
const YS = [0, 1000, 2000];
const ctr = (i, j) => [i * 1000 + 500, j * 1000 + 500];

/** 部屋 A（セル 0,1）・部屋 B（セル 3）・部屋の無い階段（セル 2。stair.id）の階。 */
function setup() {
  const g = makeGrid(XS, YS);
  const a = g.interior([[0, 0], [1, 0]]);
  const b = g.interior([[3, 0]]);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(2, 0)]) });
  return { g, a, b, stair };
}

/** ドラッグ（start → update → commit）。points は [i,j] のセル中心。 */
function drag(state, g, points, { tap = false } = {}) {
  state.startDrag(g.graph, ...ctr(...points[0]));
  for (const p of points.slice(1)) state.updateDrag(g.graph, ...ctr(...p), 0);
  state.commitDrag({ tap, ctx: { graph: g.graph, project: {} } });
}

test('CeilingModeState: start→update→commit で selection・selectedRoomId・activeTab が決まる（部屋 → 内部タブ）', () => {
  const { g, a } = setup();
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  drag(state, g, [[0, 0], [1, 0]]);
  assert.equal(state.dragState, null);
  assert.equal(state.selectedRoomId, roomGroupId(a.id));
  assert.equal(state.activeTab, 'interior');
  assert.deepEqual([...state.selection.cellKeys].sort(), [g.cell(0, 0), g.cell(1, 0)].sort());
  assert.equal(state.selection.owner.id, a.id);
  assert.equal(state.selectedCellKeys, state.selection.cellKeys);
});

test('CeilingModeState: 階段のセルを選ぶと selectedRoomId は stair.id、階段タブへ切り替わる', () => {
  const { g, stair } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[2, 0]]);
  assert.equal(state.selectedRoomId, stairGroupId(stair.id));
  assert.equal(state.activeTab, 'stair');
});

test('CeilingModeState（S12c）: commitDrag で expandedPath が nodePathOf（部屋は [room:id]、階段は [stair:id]）になる。確定前は変わらない', () => {
  const { g, a, stair } = setup();
  const state = new CeilingModeState();
  assert.deepEqual(state.expandedPath, []);
  state.startDrag(g.graph, ...ctr(0, 0));
  assert.deepEqual(state.expandedPath, [], '確定前は展開しない');
  state.commitDrag({ ctx: { graph: g.graph, project: {} } });
  assert.deepEqual(state.expandedPath, [roomGroupId(a.id)]);
  drag(state, g, [[2, 0]]);
  assert.deepEqual(state.expandedPath, [stairGroupId(stair.id)]);
});

test('CeilingModeState（S12c）: 部分指定の子の区画を選ぶと expandedPath は 親→子→区画 の3段（キャンバス選択）', () => {
  const g = makeGrid(XS, YS);
  const parent = g.interior([[0, 0], [1, 0], [2, 0]]);
  const child = g.graph.addRoom(new Set([g.cell(2, 0)]), '子', undefined, new Set([parent.id]));
  child.setCeilingZones(assignZoneHeight(g.graph, child, [g.cell(2, 0)], 2300));
  const zid = child.ceilingZones[0].id;
  const state = new CeilingModeState();
  drag(state, g, [[2, 0]]);
  assert.equal(state.selection.groupId, zoneGroupId(child.id, zid));
  assert.deepEqual(state.expandedPath, [roomGroupId(parent.id), roomGroupId(child.id), zoneGroupId(child.id, zid)]);
  assert.equal(state.selectedRoomId, zoneGroupId(child.id, zid));
});

test('CeilingModeState（S12c）: 空白タップ（dragState なしの commitDrag({tap:true})）で選択・展開をすべて解除する', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  assert.notDeepEqual(state.expandedPath, []);
  state.commitDrag({ tap: true });
  assert.equal(state.selection, null);
  assert.equal(state.selectedRoomId, null);
  assert.deepEqual(state.expandedPath, []);
});

// S12b で書き換え（旧 S2: 「なぞったセルだけ」がプレビューだった。開始 1 セル→A を超えた分は入らない→戻って 2 セル、確定前は selection に出ない）。
// 今は 'select' のプレビューは開始セルの群全体で、なぞっても変わらない。
test('CeilingModeState: ドラッグ中の previewCells は開始セルの群全体（なぞっても変わらない。他の群は入らない）', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  assert.deepEqual(state.previewCells, []);
  state.startDrag(g.graph, ...ctr(1, 0));
  assert.equal(state.previewCells.length, 2, '開始した瞬間に A の群全体（0,0 と 1,0）');
  state.updateDrag(g.graph, ...ctr(3, 0), 100); // 階段・B を通っても変わらない
  assert.equal(state.previewCells.length, 2);
  state.updateDrag(g.graph, ...ctr(0, 0), 100);
  assert.equal(state.previewCells.length, 2);
  assert.deepEqual(state.previewCells.map(c => c.key).sort(), [g.cell(0, 0), g.cell(1, 0)].sort());
  assert.equal(state.selection, null, '確定前は selection に出ない');
});

// S12b で書き換え（旧 S2: 開始 1 → 足した update で 3 回目 → 確定 4 回目 [0,'sel']）。'select' は update が何も足さないので 3 回目が無い。
test('CeilingModeState: 購読は 開始・確定 でだけ再実行され、select のドラッグ中の update では再実行されない', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  const seen = [];
  const stop = autorun(() => seen.push([state.previewCells.length, state.selection ? 'sel' : 'none']));
  assert.equal(seen.length, 1);
  state.startDrag(g.graph, ...ctr(0, 0));
  assert.equal(seen.length, 2, '開始');
  assert.deepEqual(seen[1], [2, 'none']);
  assert.equal(isObservable(state.dragState), false, 'dragState は observable.ref（中身を深く観測しない。lastWorld の in place 更新が購読を起こさない前提）');
  state.updateDrag(g.graph, ...ctr(0, 0), 100);
  state.updateDrag(g.graph, ...ctr(1, 0), 100);
  assert.equal(seen.length, 2, 'select の update では再実行されない');
  state.commitDrag({ ctx: { graph: g.graph, project: {} } });
  assert.equal(seen.length, 3, '確定');
  assert.deepEqual(seen[2], [0, 'sel']);
  assert.equal(isObservable(state.selection), false, 'selection は observable.ref');
  stop();
});

test('【失敗系】CeilingModeState: 空白のタップで選択を解除する', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  assert.ok(state.selection);
  drag(state, g, [[0, 1]], { tap: true }); // 部屋も階段も無いセル。dragState は作られず、tap で解除
  assert.equal(state.selection, null);
  assert.equal(state.selectedRoomId, null);
});

test('【失敗系】CeilingModeState: 選べないセルから始めたドラッグ（tap でない）は前の選択を保つ', () => {
  const { g, a } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  const before = state.selection;
  drag(state, g, [[0, 1], [1, 1]], { tap: false });
  assert.equal(state.selection, before);
  assert.equal(state.selectedRoomId, roomGroupId(a.id));
  assert.equal(state.dragState, null);
});

test('CeilingModeState: タップは常に置き換え（別の部屋のタップで前の選択のセルは残らない）', () => {
  const { g, b } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0], [1, 0]]);
  drag(state, g, [[3, 0]], { tap: true });
  assert.deepEqual([...state.selection.cellKeys], [g.cell(3, 0)]);
  assert.equal(state.selectedRoomId, roomGroupId(b.id));
});

test('CeilingModeState: cancelDrag は dragState だけ消し、選択は保つ。関門の中断は cancelDrag?.() の名前に乗る', () => {
  const { g, a } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  state.startDrag(g.graph, ...ctr(3, 0));
  assert.ok(state.dragState);
  state.cancelDrag();
  assert.equal(state.dragState, null);
  assert.equal(state.selection.owner.id, a.id);
  assert.equal(typeof new CeilingModeState().cancelDrag, 'function');
});

test('CeilingModeState: dispose で選択・ドラッグ・強調行がすべて消える', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  state.startDrag(g.graph, ...ctr(3, 0));
  state.dispose();
  assert.equal(state.dragState, null);
  assert.equal(state.selection, null);
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.selectedCellKeys.size, 0);
});

test('CeilingModeState（S12c）: パネルの行クリック selectNode は別の群の選択に置き換え、タブは切り替えない（キャンバスの選択は所属でタブを切り替える）', () => {
  const { g, a, b } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  state.selectNode(g.graph, roomGroupId(b.id));
  assert.equal(state.selection.groupId, roomGroupId(b.id));
  assert.deepEqual([...state.selection.cellKeys], [g.cell(3, 0)]);
  assert.deepEqual(state.expandedPath, [roomGroupId(b.id)]);
  state.setActiveTab('stair');
  state.selectNode(g.graph, roomGroupId(a.id)); // 階段タブの木に部屋ノードは無い
  assert.equal(state.activeTab, 'stair', 'タブは切り替えない');
  assert.equal(state.selection.groupId, roomGroupId(a.id), '群はあるので選択は作る');
  assert.deepEqual(state.expandedPath, [], '今のタブの木に無ければ展開は畳む');
});

// ---- S3: 材データ（init）----
test('CeilingModeState.init: 未ロードでは materialMap=null・選択肢は空。init 後は materialMap と getMaterialsByCategory が使え、結果は { ok:true, error:null }', async () => {
  const state = new CeilingModeState();
  assert.equal(state.materialsLoaded, false);
  assert.equal(state.materialMap, null);
  assert.deepEqual(state.getMaterialsByCategory('panel'), []);
  assert.equal(state.materialDiff('301000000001'), null);

  const result = await state.init();

  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(state.materialsLoaded, true);
  assert.equal(state.materialError, null);
  assert.equal(state.materialMap.get('301000000001').name, 'せっこうボード t=9.5');
  assert.equal(state.materialMap.get('302000000001').name, 'ビニールクロス');
  const panels = state.getMaterialsByCategory('panel');
  assert.ok(panels.length > 0 && panels.every(m => m.category === 'panel'));
  assert.ok(panels.some(m => m.code === '301000000001'));
  assert.ok(state.getMaterialsByCategory('finish').some(m => m.code === '302000000001'));
});

test('【失敗系】CeilingModeState.getMaterialsByCategory: 未知のカテゴリは空配列（例外にしない）', async () => {
  const state = new CeilingModeState();
  await state.init();
  assert.deepEqual(state.getMaterialsByCategory('no-such-category'), []);
});

test('CeilingModeState.init: 材データは FinishModeState.init と同じ材マスタ（コード集合が一致）', async () => {
  const { g } = setup();
  const ceiling = new CeilingModeState();
  const finish = new FinishModeState(g.graph, null);
  await Promise.all([ceiling.init(), finish.init()]);
  assert.deepEqual([...ceiling.materialMap.keys()].sort(), [...finish.materialMap.keys()].sort());
});

// ---- 天井芯の移動（S8b）: preloadMove / startMove / updateMove / commitMove / cancelMove ----
// graph・project は呼び出しごとに ctx で受け、State は保持しない。

function moveSetup() {
  const g = makeGrid(XS, YS);
  const cl = g.graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.CEILING });
  return { g, cl, ctx: { graph: g.graph, project: {} } };
}

test('CeilingModeState.startMove: ctx で範囲を解決して moveState を立て（isMoving）、updateMove は範囲にクランプして pendingDelta だけ動かす', async () => {
  const { cl, ctx } = moveSetup();
  const state = new CeilingModeState();
  assert.equal(state.isMoving, false);
  const err = await state.startMove(cl, ctx);
  assert.equal(err, null);
  assert.equal(state.isMoving, true);
  assert.equal(state.moveState.cl, cl);
  assert.equal(state.moveState.originalValue, 500);
  assert.deepEqual(state.moveState.range, { min: 0, max: 1000 }, '隣の中心線（x=0・x=1000）で止まる');

  state.updateMove(700);
  assert.equal(cl.value, 500, 'cl.value は確定まで動かさない');
  assert.equal(cl.pendingDelta, 200);
  state.updateMove(5000);
  assert.equal(cl.effectiveValue, 1000, '範囲の上限にクランプ');
  state.updateMove(-5000);
  assert.equal(cl.effectiveValue, 0, '範囲の下限にクランプ');

  state.commitMove();
  assert.equal(state.moveState, null);
  assert.equal(state.isMoving, false);
});

test('CeilingModeState.cancelMove: pendingDelta を 0 に戻して moveState を閉じる。moveState が無いときは何もしない', async () => {
  const { cl, ctx } = moveSetup();
  const state = new CeilingModeState();
  assert.doesNotThrow(() => state.cancelMove());
  await state.startMove(cl, ctx);
  state.updateMove(800);
  assert.equal(cl.pendingDelta, 300);
  state.cancelMove();
  assert.equal(cl.pendingDelta, 0);
  assert.equal(state.moveState, null);
});

test('CeilingModeState.dispose: 移動中なら cancelMove して pendingDelta を戻す', async () => {
  const { cl, ctx } = moveSetup();
  const state = new CeilingModeState();
  await state.startMove(cl, ctx);
  state.updateMove(900);
  state.dispose();
  assert.equal(cl.pendingDelta, 0);
  assert.equal(state.moveState, null);
});

test('CeilingModeState.preloadMove: 先読みを startMove が一度だけ使う。graph・project は State に残らない', async () => {
  const { cl, ctx } = moveSetup();
  const state = new CeilingModeState();
  state.preloadMove(cl, ctx);
  assert.equal(state._pendingPreload.clId, cl.id);
  await state.startMove(cl, ctx);
  assert.equal(state._pendingPreload, null, '使い切り');
  assert.equal(state.graph, undefined);
  assert.equal(state.project, undefined);
  const holds = (v) => v === ctx.graph || v === ctx.project;
  assert.ok(!Object.values(state).some(holds), 'State が graph／project を保持している');
  assert.deepEqual(Object.keys(state.moveState).sort(), ['cl', 'originalValue', 'range']);
});

test('【失敗系】CeilingModeState: ctx 無しの preloadMove は何もせず、startMove は例外（moveState なし）', async () => {
  const { cl } = moveSetup();
  const state = new CeilingModeState();
  state.preloadMove(cl);
  assert.equal(state._pendingPreload, null);
  await assert.rejects(() => state.startMove(cl), /ctx/);
  assert.equal(state.moveState, null);
});

test('【失敗系】CeilingModeState.startMove: 先読みが reject なら ERR_CL_MOVE_LOAD_FAILED を返し、関門は戻って moveState は立たない', async () => {
  const { cl, ctx } = moveSetup();
  const state = new CeilingModeState();
  state._pendingPreload = { clId: cl.id, promise: Promise.reject(new Error('IDB読込失敗')) };
  const orig = console.error;
  console.error = () => {};
  let err;
  try { err = await state.startMove(cl, ctx); } finally { console.error = orig; }
  assert.equal(err, ERR_CL_MOVE_LOAD_FAILED);
  assert.equal(isUiBusy(), false);
  assert.equal(state.moveState, null);
});

// ---- S12b: 群選択と、選択中の残りを再タップ／ドラッグしての区画の作成 ----
const GXS = [0, 1000, 2000, 3000, 4000, 5000];
const GYS = [0, 1000, 2000];

/** A（4 セル 0..3）・B（1 セル 4）の階。 */
function groupSetup() {
  const g = makeGrid(GXS, GYS);
  const a = g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const b = g.interior([[4, 0]]);
  return { g, graph: g.graph, a, b, k: i => g.cell(i, 0) };
}
const gctx = graph => ({ graph, project: {} });
/** タップ（start → commit tap:true）。 */
function tapCell(state, g, i, j = 0, ctx) {
  state.startDrag(g.graph, ...ctr(i, j));
  state.commitDrag({ tap: true, ctx });
}
/** なぞる（cells の [i,j] を順に。stepMm 0 なので終点だけ見る）。 */
function stroke(state, g, cells, ctx) {
  state.startDrag(g.graph, ...ctr(...cells[0]));
  for (const c of cells.slice(1)) state.updateDrag(g.graph, ...ctr(...c), 0);
  state.commitDrag({ tap: false, ctx });
}
const stackLen = () => undoManager._undoStack.length;
const roomOf = (graph, room) => graph.roomMap.get(room.id); // undo は部屋を復元で差し替えうるので引き直す

test('S12b 群選択: タップでも途中までのドラッグでも、選択は開始セルの群全体（旧 S2 は なぞったセルだけ）。groupId を持つ', () => {
  const { g, a, k } = groupSetup();
  const all = [0, 1, 2, 3].map(k).sort();
  const s1 = new CeilingModeState();
  tapCell(s1, g, 1, 0, gctx(g.graph));
  assert.deepEqual([...s1.selection.cellKeys].sort(), all, 'タップ 1 セルでも A の 4 セル全部');
  assert.equal(s1.selection.groupId, roomGroupId(a.id));
  assert.equal(s1.selectedRoomId, roomGroupId(a.id));
  const s2 = new CeilingModeState();
  stroke(s2, g, [[0, 0], [1, 0]], gctx(g.graph));
  assert.deepEqual([...s2.selection.cellKeys].sort(), all, '途中までのドラッグでも群全体');
  assert.equal(s2.dragState, null);
});

test('S12b 作成: 選択中の残りを再タップすると 1 セルの区画（部屋の CH を数値で固定）。undo 1 回で消え、markDirty される。親 CH の変更に追従しない', () => {
  const { g, graph, a, k } = groupSetup();
  a.setOverride('ceilingHeight', '2500');
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  const n0 = stackLen();
  clearDirty();
  tapCell(state, g, 1, 0, gctx(graph));
  assert.equal(a.ceilingZones.length, 1);
  const z = a.ceilingZones[0];
  assert.deepEqual([...z.cells], [k(1)]);
  assert.deepEqual([z.heightMm, z.shape, [...z.dims]], [roomCeilingHeight(graph, a).mm, 'flat', []]);
  assert.equal(z.heightMm, 2500);
  assert.equal(stackLen(), n0 + 1, 'undo は 1 エントリ');
  assert.equal(isDirty(), true);
  assert.equal(state.selection.groupId, zoneGroupId(a.id, z.id), '作った区画の群を選択');
  assert.deepEqual([...state.selection.cellKeys], [k(1)]);
  assert.deepEqual(state.expandedPath, [roomGroupId(a.id), zoneGroupId(a.id, z.id)], '作った区画の行まで開く');
  a.setOverride('ceilingHeight', '2600');
  assert.equal(a.ceilingZones[0].heightMm, 2500, '数値固定: 親 CH に追従しない');
  undoManager.undo();
  assert.equal(roomOf(graph, a).ceilingZones.length, 0, 'undo 1 回で消える');
  assert.equal(stackLen(), n0);
  clearDirty();
});

test('S12b 作成: 再ドラッグ（残りの中をなぞる）は visited ∩ G の区画。部屋の形状（傾斜）を新しい区画へ引き継ぐ', () => {
  const { g, graph, a, k } = groupSetup();
  a.setOverride('ceilingShape', 'slope');
  a.setOverride('ceilingDims', '500,90');
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  stroke(state, g, [[1, 0], [4, 0], [2, 0]], gctx(graph)); // 途中で B のセル（別所属）を通る
  assert.equal(a.ceilingZones.length, 1);
  assert.deepEqual([...a.ceilingZones[0].cells].sort(), [k(1), k(2)].sort(), 'B のセルは入らない');
  assert.deepEqual([a.ceilingZones[0].shape, [...a.ceilingZones[0].dims]], ['slope', [500, 90]]);
  clearDirty();
  undoManager.undo();
});

test('S12b 作成: なぞりは群の中だけ（allowed）。同じ部屋の既存区画のセルは、ドラッグが通っても足さない', () => {
  const { g, graph, a, k } = groupSetup();
  a.setCeilingZones(assignZoneHeight(graph, a, [k(3)], 2700));
  const zoneId = a.ceilingZones[0].id;
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph)); // 残り（0,1,2）の群
  assert.deepEqual([...state.selection.cellKeys].sort(), [k(0), k(1), k(2)].sort());
  stroke(state, g, [[0, 0], [1, 0], [3, 0]], gctx(graph)); // 区画のセル(3) は同じ所属だが群の外
  assert.equal(a.ceilingZones.length, 2);
  const created = a.ceilingZones.find(z => z.id !== zoneId);
  assert.deepEqual([...created.cells].sort(), [k(0), k(1)].sort());
  assert.deepEqual([...a.ceilingZones.find(z => z.id === zoneId).cells], [k(3)], '既存の区画は不変');
  clearDirty();
  undoManager.undo();
});

test('S12b 作成しない: G 全体を覆うなぞり・1 セルしかない残りの再タップ・区画の中での再タップは何もしない（選択もそのまま）', () => {
  const { g, graph, a, b, k } = groupSetup();
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  const sel = state.selection;
  const n0 = stackLen();
  stroke(state, g, [[0, 0], [1, 0], [2, 0], [3, 0]], gctx(graph));
  assert.equal(a.ceilingZones.length, 0, 'G 全体では作らない（真部分集合のときだけ）');
  assert.equal(state.selection, sel, '選択はそのまま');
  assert.equal(state.dragState, null);
  // 1 セルの残り
  const one = new CeilingModeState();
  tapCell(one, g, 4, 0, gctx(graph));
  tapCell(one, g, 4, 0, gctx(graph));
  assert.equal(b.ceilingZones.length, 0, '1 セルの残りでは作らない');
  assert.equal(one.selection.groupId, roomGroupId(b.id));
  // 区画の中での再タップ
  a.setCeilingZones(assignZoneHeight(graph, a, [k(1), k(2)], 2700));
  const zid = a.ceilingZones[0].id;
  const n1 = stackLen();
  const zs = new CeilingModeState();
  tapCell(zs, g, 1, 0, gctx(graph));
  assert.equal(zs.selection.groupId, zoneGroupId(a.id, zid), '区画のセルのタップは区画の群を選ぶ');
  tapCell(zs, g, 2, 0, gctx(graph));
  stroke(zs, g, [[1, 0]], gctx(graph));
  assert.equal(a.ceilingZones.length, 1, '区画の中での再タップ／ドラッグは何もしない');
  assert.deepEqual([...a.ceilingZones[0].cells].sort(), [k(1), k(2)].sort());
  assert.equal(zs.selection.groupId, zoneGroupId(a.id, zid));
  assert.equal(stackLen(), n1);
  assert.equal(stackLen(), n0, '何も作らないので undo も積まない');
});

test('S12b 選択の置換: 別の群のタップで置き換え、空白のタップで解除。区画の群と残りの群は別の群', () => {
  const { g, graph, a, b, k } = groupSetup();
  a.setCeilingZones(assignZoneHeight(graph, a, [k(3)], 2700));
  const zid = a.ceilingZones[0].id;
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  assert.equal(state.selection.groupId, roomGroupId(a.id));
  tapCell(state, g, 3, 0, gctx(graph)); // 同じ部屋の区画のセル = 別の群
  assert.equal(state.selection.groupId, zoneGroupId(a.id, zid));
  assert.deepEqual([...state.selection.cellKeys], [k(3)]);
  tapCell(state, g, 4, 0, gctx(graph));
  assert.equal(state.selection.groupId, roomGroupId(b.id));
  assert.equal(state.selectedRoomId, roomGroupId(b.id));
  tapCell(state, g, 0, 1, gctx(graph)); // 空白
  assert.equal(state.selection, null);
  assert.deepEqual(state.expandedPath, []);
  assert.equal(a.ceilingZones.length, 1, '置換・解除では区画を作らない');
});

test('S12b 作成: cancelDrag（長押しメニューなど）の後は commitDrag しても作られない。選択は保つ', () => {
  const { g, graph, a } = groupSetup();
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  const sel = state.selection;
  state.startDrag(g.graph, ...ctr(1, 0));
  assert.equal(state.dragState.intent, 'create');
  state.cancelDrag();
  state.commitDrag({ tap: false, ctx: gctx(graph) });
  assert.equal(a.ceilingZones.length, 0);
  assert.equal(state.selection, sel);
});

/** 階段（4 セルの STAIR ペア部屋 P + 階段 S）の階。階高 3200 の上階つきの project。 */
function stairGroupSetup(type = StairType.STRAIGHT) {
  const g = makeGrid([0, 1000, 2000, 3000, 4000], [0, 1000]);
  const cells = [[0, 0], [1, 0], [2, 0], [3, 0]];
  const pair = g.feature(cells, RoomFeature.STAIR);
  pair.setOverride('ceilingHeight', '2400');
  const stair = g.graph.addStair({ type, upDirection: 'right', totalSteps: 16, roomId: pair.id, cells: new Set(cells.map(([i, j]) => g.cell(i, j))) });
  const plane = g.graph.plane;
  const project = { planes: [plane, new Plane('p2', 3200, '2階', 2, 1)], activePlane: plane };
  return { g, graph: g.graph, pair, stair, ctx: { graph: g.graph, project }, k: i => g.cell(i, 0) };
}

test('S12b 作成（階段）: 直進階段の残りを再ドラッグすると、階段に沿った傾斜（ライズ按分）の区画が対の部屋に付く。階段タブで区画を選択', () => {
  const { g, graph, pair, stair, ctx, k } = stairGroupSetup();
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, ctx);
  assert.equal(state.selection.groupId, stairGroupId(stair.id));
  assert.equal(state.activeTab, 'stair');
  stroke(state, g, [[2, 0], [3, 0]], ctx);
  assert.equal(pair.ceilingZones.length, 1);
  const z = pair.ceilingZones[0];
  assert.deepEqual([...z.cells].sort(), [k(2), k(3)].sort());
  assert.deepEqual([z.shape, z.heightMm, [...z.dims]], ['slope', roomCeilingHeight(graph, pair).mm, [1600, 0]], 'ライズ = 200×16 × 2/4');
  assert.equal(state.selection.groupId, zoneGroupId(pair.id, z.id));
  assert.equal(state.activeTab, 'stair');
  assert.deepEqual(state.expandedPath, [stairGroupId(stair.id), zoneGroupId(pair.id, z.id)], '階段タブでは 階段→区画');
  clearDirty();
  undoManager.undo();
  assert.equal(roomOf(graph, pair).ceilingZones.length, 0);
});

test('S12b 作成（階段）: 折返しなど傾斜を算出できない階段、最上階（階高なし）の直進は 平面＋対の部屋の CH', () => {
  const sw = stairGroupSetup(StairType.SWITCHBACK);
  const s1 = new CeilingModeState();
  tapCell(s1, sw.g, 0, 0, sw.ctx);
  tapCell(s1, sw.g, 1, 0, sw.ctx);
  assert.deepEqual([sw.pair.ceilingZones[0].shape, sw.pair.ceilingZones[0].heightMm, [...sw.pair.ceilingZones[0].dims]], ['flat', 2400, []]);
  const top = stairGroupSetup();
  const s2 = new CeilingModeState();
  tapCell(s2, top.g, 0, 0, { graph: top.graph, project: {} }); // 階高が引けない
  tapCell(s2, top.g, 1, 0, { graph: top.graph, project: {} });
  assert.deepEqual([top.pair.ceilingZones[0].shape, top.pair.ceilingZones[0].heightMm], ['flat', 2400]);
  clearDirty();
  undoManager.undo();
  undoManager.undo();
});

test('【失敗系】S12b: 対の部屋の無い階段の残りでは区画を作らない（例外にもしない）。選択はそのまま', () => {
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000]);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 0), g.cell(1, 0), g.cell(2, 0)]) });
  const state = new CeilingModeState();
  const ctx = { graph: g.graph, project: {} };
  const n0 = stackLen();
  tapCell(state, g, 0, 0, ctx);
  assert.equal(state.selection.groupId, stairGroupId(stair.id));
  const sel = state.selection;
  assert.doesNotThrow(() => tapCell(state, g, 1, 0, ctx));
  assert.equal(state.selection, sel);
  assert.equal(stackLen(), n0);
  assert.equal(g.graph.rooms.length, 0);
});

test('【失敗系】S12b/S12c: ctx なしの commitDrag は select でも create でも例外（プログラミングエラー）。dragState は残さず、選択も区画も作られない', () => {
  const { g, graph, a } = groupSetup();
  const state = new CeilingModeState();
  state.startDrag(g.graph, ...ctr(0, 0));
  assert.throws(() => state.commitDrag({ tap: true }), /ctx/);
  assert.equal(state.dragState, null);
  assert.equal(state.selection, null);
  tapCell(state, g, 0, 0, gctx(graph));
  state.startDrag(g.graph, ...ctr(1, 0));
  assert.throws(() => state.commitDrag({ tap: true }), /ctx/);
  assert.equal(state.dragState, null);
  assert.equal(a.ceilingZones.length, 0);
  assert.equal(graph.rooms.length, 2);
});

test('S12b selectNode: 群 id で選択を作る（行・タブも合う）。セル 0 件の群 id は展開だけ（選択は変えない）。解けない id は何もしない', () => {
  const { graph, a, b, k } = groupSetup();
  a.setCeilingZones(assignZoneHeight(graph, a, [k(0), k(1), k(2), k(3)], 2700)); // 残りが無い
  const zid = a.ceilingZones[0].id;
  const state = new CeilingModeState();
  state.selectNode(graph, zoneGroupId(a.id, zid));
  assert.equal(state.selection.groupId, zoneGroupId(a.id, zid));
  assert.equal(state.selectedRoomId, zoneGroupId(a.id, zid));
  assert.deepEqual(state.expandedPath, [roomGroupId(a.id), zoneGroupId(a.id, zid)]);
  state.selectNode(graph, roomGroupId(b.id));
  assert.equal(state.selection.groupId, roomGroupId(b.id));
  const sel = state.selection;
  state.selectNode(graph, roomGroupId(a.id)); // A の残りは 0 セル（群なし）
  assert.equal(state.selection, sel, '選択は変えない');
  assert.deepEqual(state.expandedPath, [roomGroupId(a.id)], '展開だけ');
  state.selectNode(graph, 'bogus');
  assert.deepEqual(state.expandedPath, [], '木に無いノードは展開を畳む');
  assert.equal(state.selection, sel);
});

test('S12c 持ち越し(1): 区画を作って undo すると、選択が指す区画の群は無くなる→パネルは選択なし扱い（selectedNodeId null）。その群 id の nodePathOf は null で、選び直しの展開は []', () => {
  const { g, graph, a } = groupSetup();
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  tapCell(state, g, 1, 0, gctx(graph)); // 区画を作成して選択
  const zoneId = state.selection.groupId;
  assert.equal(selectedNodeId(graph, state.selection), zoneId, '作成直後は選択中のノード');
  assert.equal(state.expandedPath.length, 2);
  clearDirty();
  undoManager.undo();
  assert.equal(state.selection.groupId, zoneId, '選択は undo で追従しない（既知の限界）');
  assert.equal(selectedNodeId(graph, state.selection), null, '群が無い選択は選択なし扱い');
  assert.equal(nodePathOf(graph, zoneId, 'interior'), null);
  state.selectNode(graph, zoneId);
  assert.deepEqual(state.expandedPath, [], '木に無いノードの選択は展開を畳む');
  assert.equal(roomOf(graph, a).ceilingZones.length, 0);
});

test('S12c Minor4: 同じ対の部屋の2本の階段にまたがる区画は両方の階段の下に出る。2本目の下の区画行のクリックは、その行の経路（line.path）を開く', () => {
  const g = makeGrid(XS, YS);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  const s1 = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0)]) });
  const s2 = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(1, 0)]) });
  pair.setCeilingZones(assignZoneHeight(g.graph, pair, [g.cell(0, 0), g.cell(1, 0)], 2500));
  const zid = zoneGroupId(pair.id, pair.ceilingZones[0].id);
  const [S1, S2] = [stairGroupId(s1.id), stairGroupId(s2.id)];
  const lines = ceilingPanelLines(ceilingPanelTree(g.graph, 'stair'), [S2]);
  const under2 = lines.find(l => l.type === 'zone' && l.path[0] === S2);
  assert.deepEqual(under2.path, [S2, zid]);
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  state.selectNode(g.graph, zid, under2.path);
  assert.deepEqual(state.expandedPath, [S2, zid], '押された行（2本目の階段の下）の経路');
  assert.equal(state.selection.groupId, zid);
  state.selectNode(g.graph, zid);
  assert.deepEqual(state.expandedPath, [S1, zid], '経路を渡さなければ nodePathOf＝最初に見つかる側（既知の限界）');
});

test('S12c 持ち越し(2): 部屋 CH がレンジ表記のとき、残りから作る新区画の高さは既定 CH（roomCeilingHeight().mm のフォールバック）で固定する', () => {
  const { g, graph, a } = groupSetup();
  a.setOverride('ceilingHeight', '2300～3500');
  const expected = roomCeilingHeight(graph, a);
  assert.equal(expected.isFallback, true, '前提: レンジ表記は数値化できず既定値に落ちる');
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  tapCell(state, g, 1, 0, gctx(graph));
  assert.equal(a.ceilingZones.length, 1);
  assert.equal(a.ceilingZones[0].heightMm, expected.mm);
  assert.equal(a.getFinishInfo().ceilingHeight, '2300～3500', '部屋の CH 欄は変えない');
  clearDirty();
  undoManager.undo();
});

test('S12b: 群を選び直すと選択の cellKeys は選んだ時点の写し（undo で解除しない従来規則）', () => {
  const { g, graph, a, k } = groupSetup();
  const state = new CeilingModeState();
  tapCell(state, g, 0, 0, gctx(graph));
  tapCell(state, g, 1, 0, gctx(graph)); // 区画 {k1} を作成
  const zoneSel = state.selection;
  clearDirty();
  undoManager.undo();
  assert.equal(roomOf(graph, a).ceilingZones.length, 0);
  assert.equal(state.selection, zoneSel, 'undo で選択は解除されない');
  assert.deepEqual([...state.selection.cellKeys], [k(1)]);
});

// ---- 階段下の群（選択専用。stairUnderContext を App の直下階 peek が渡す）----

/** stairGroupSetup の階（破れ先は右 2 セル = 2,3）に、最下階の判定材料（stairUnderContext）を置いた State。 */
function stairUnderSetup(planeId) {
  const s = stairGroupSetup();
  const state = new CeilingModeState();
  state.setStairUnderContext({ planeId: planeId ?? s.graph.plane.id, lowerStairCellBounds: [], floorHeightMm: 3200 });
  return { ...s, state };
}

test('階段下（選択）: 階段下のセルのタップは「階段下」の群（そのセルだけ）を選び、経路は [stair, stairUnder]・階段タブ。階段本体のセルは従来の階段の群', () => {
  const { g, stair, ctx, state, k } = stairUnderSetup();
  tapCell(state, g, 3, 0, ctx);
  assert.equal(state.selection.groupId, stairUnderGroupId(stair.id));
  assert.deepEqual([...state.selection.cellKeys].sort(), [k(2), k(3)].sort());
  assert.equal(state.activeTab, 'stair');
  assert.deepEqual(state.expandedPath, [stairGroupId(stair.id), stairUnderGroupId(stair.id)]);
  assert.deepEqual(state.selection.owner, { kind: 'stair', id: stair.id, rowId: state.selection.owner.rowId });
  tapCell(state, g, 0, 0, ctx);
  assert.equal(state.selection.groupId, stairGroupId(stair.id));
  assert.deepEqual([...state.selection.cellKeys].sort(), [k(0), k(1)].sort(), '階段本体は階段下を除く');
});

test('階段下（作成）: 選択中の階段下を再タップすると 1 セルでも区画になり、なぞって群と同じ集合にしても区画になる。undo 1 回で消える', () => {
  const { g, graph, pair, stair, ctx, state, k } = stairUnderSetup();
  tapCell(state, g, 2, 0, ctx); // 選択
  const n0 = stackLen();
  tapCell(state, g, 3, 0, ctx); // 再タップ＝1 セルの区画
  assert.equal(pair.ceilingZones.length, 1);
  assert.deepEqual([...pair.ceilingZones[0].cells], [k(3)]);
  assert.equal(stackLen(), n0 + 1);
  assert.equal(state.selection.groupId, zoneGroupId(pair.id, pair.ceilingZones[0].id));
  assert.equal(state.activeTab, 'stair');
  undoManager.undo();
  assert.equal(roomOf(graph, pair).ceilingZones.length, 0, 'undo 1 回で消える');
  // 同一集合（階段下の全体）をなぞる
  tapCell(state, g, 2, 0, ctx);
  stroke(state, g, [[2, 0], [3, 0]], ctx);
  const zone = roomOf(graph, pair).ceilingZones[0];
  assert.deepEqual([...zone.cells].sort(), [k(2), k(3)].sort(), '階段下の全セルで 1 区画');
  assert.deepEqual(zone.shape, 'slope', '初期値は従来の階段の既定（stairCeilingSlopeDefaults）');
  assert.deepEqual(state.expandedPath, [stairGroupId(stair.id), zoneGroupId(pair.id, zone.id)]);
  clearDirty();
  undoManager.undo();
  assert.equal(roomOf(graph, pair).ceilingZones.length, 0);
});

test('階段下（従来の規則は変えない）: 階段本体の残りは同一集合（全セル）のなぞりでは区画を作らない', () => {
  const { g, pair, ctx, state } = stairUnderSetup();
  tapCell(state, g, 0, 0, ctx);
  stroke(state, g, [[0, 0], [1, 0]], ctx); // 階段本体 {0,1} の全部
  assert.equal(pair.ceilingZones.length, 0);
});

test('【失敗系】階段下: 判定材料が無い（null）・別の階のもの（planeId 不一致）なら割れない（階段は 4 セルの 1 群）。stairUnderKeysOf は null', () => {
  for (const make of [() => { const s = stairGroupSetup(); return { ...s, state: new CeilingModeState() }; }, () => stairUnderSetup('other-plane')]) {
    const { g, graph, stair, ctx, state } = make();
    assert.equal(state.stairUnderKeysOf(graph), null);
    tapCell(state, g, 3, 0, ctx);
    assert.equal(state.selection.groupId, stairGroupId(stair.id));
    assert.equal(state.selection.cellKeys.size, 4);
  }
});

test('【失敗系】階段下: 区画が階段下の全部を覆うと階段下の群は無く、そのセルのタップは区画の選択', () => {
  const { g, graph, pair, ctx, state, k } = stairUnderSetup();
  pair.setCeilingZones(assignZoneHeight(graph, pair, [k(2), k(3)], 2500));
  tapCell(state, g, 3, 0, ctx);
  assert.equal(state.selection.groupId, zoneGroupId(pair.id, pair.ceilingZones[0].id));
  assert.equal(state.stairUnderKeysOf(graph).has(state.selection.owner.id), true, '索引上は階段下のまま（群は区画が先勝ち）');
});

test('setStairUnderContext は observable（購読者が置換で再実行される）', () => {
  const state = new CeilingModeState();
  let runs = 0;
  const dispose = autorun(() => { void state.stairUnderContext; runs++; });
  state.setStairUnderContext({ planeId: 'p1', lowerStairCellBounds: [], floorHeightMm: 3200 });
  assert.equal(runs, 2);
  dispose();
});

test('【失敗系】aboveRoofGraphOf: planeId が違う ctx・null の ctx・graph なしは null、一致なら aboveGraph', () => {
  const state = new CeilingModeState();
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const above = { rooms: [] };
  assert.equal(state.aboveRoofGraphOf(graph), null, 'ctx null');
  state.setAboveRoofContext({ planeId: 'p2', aboveGraph: above });
  assert.equal(state.aboveRoofGraphOf(graph), null, 'planeId 不一致（階切替直後の古い peek）');
  state.setAboveRoofContext({ planeId: 'p1', aboveGraph: above });
  assert.equal(state.aboveRoofGraphOf(graph), above);
  assert.equal(state.aboveRoofGraphOf(null), null, 'graph なし');
});

test('getMaterial: 未ロードは null、ロード後はコードで引ける', async () => {
  const state = new CeilingModeState();
  assert.equal(state.getMaterial('301000000015'), null);
  await state.init();
  assert.equal(state.getMaterial('301000000015').code, '301000000015');
  assert.equal(state.getMaterial('nope'), null);
});
