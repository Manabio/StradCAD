// CeilingModeState（天伏モード。独立 State）。mobx と純モジュール（ceiling/ceilingSelection.js）にしか
// 依存しないため node:test から直接 import できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun, isObservable } from 'mobx';
import { StairType, CenterLineType, Discipline, RoomFeature, Plane } from '@core';
import { isUiBusy } from '../uiBusy.js';
import { ERR_CL_MOVE_LOAD_FAILED } from '../error.js';
import { undoManager } from '../undoManager.js';
import { isDirty, clearDirty } from '../dirtyState.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { roomGroupId, zoneGroupId, stairGroupId } from '../ceiling/ceilingGroups.js';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';
import { CeilingModeState } from './CeilingModeState.js';
import { FinishModeState } from './FinishModeState.js';

test('CeilingModeState: 既定値（選択なし・内部タブ）。graph を持たず、FinishModeState を継承しない', () => {
  const state = new CeilingModeState();
  assert.equal(state.graph, undefined);
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.activeTab, 'interior');
  assert.ok(!(state instanceof FinishModeState));
  state.dispose();
});

test('CeilingModeState: selectRoom は observable に反映し、null・undefined で解除する', () => {
  const state = new CeilingModeState();
  const seen = [];
  const stop = autorun(() => seen.push(state.selectedRoomId));
  state.selectRoom('r1');
  state.selectRoom(undefined);
  stop();
  assert.deepEqual(seen, [null, 'r1', null]);
});

test('CeilingModeState: setActiveTab は interior / stair を切り替える', () => {
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  assert.equal(state.activeTab, 'stair');
  state.setActiveTab('interior');
  assert.equal(state.activeTab, 'interior');
});

test('【失敗系】CeilingModeState: 未知のタブ名は例外で、activeTab は変わらない', () => {
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  assert.throws(() => state.setActiveTab('exterior'), /未知のタブ/);
  assert.equal(state.activeTab, 'stair');
});

test('CeilingModeState: dispose で選択を解除する（タブは保つ）。dispose の二重呼びも例外にならない', () => {
  const state = new CeilingModeState();
  state.selectRoom('r1');
  state.setActiveTab('stair');
  state.dispose();
  assert.equal(state.selectedRoomId, null);
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
  state.commitDrag({ tap });
}

test('CeilingModeState: start→update→commit で selection・selectedRoomId・activeTab が決まる（部屋 → 内部タブ）', () => {
  const { g, a } = setup();
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  drag(state, g, [[0, 0], [1, 0]]);
  assert.equal(state.dragState, null);
  assert.equal(state.selectedRoomId, a.id);
  assert.equal(state.activeTab, 'interior');
  assert.deepEqual([...state.selection.cellKeys].sort(), [g.cell(0, 0), g.cell(1, 0)].sort());
  assert.equal(state.selection.owner.id, a.id);
  assert.equal(state.selectedCellKeys, state.selection.cellKeys);
});

test('CeilingModeState: 階段のセルを選ぶと selectedRoomId は stair.id、階段タブへ切り替わる', () => {
  const { g, stair } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[2, 0]]);
  assert.equal(state.selectedRoomId, stair.id);
  assert.equal(state.activeTab, 'stair');
});

test('CeilingModeState（S10）: commitDrag で expandedRowId が owner.rowId になる（部屋・階段とも）。別の行を選べば移る。確定前は変わらない', () => {
  const { g, a, stair } = setup();
  const state = new CeilingModeState();
  assert.equal(state.expandedRowId, null);
  state.startDrag(g.graph, ...ctr(0, 0));
  assert.equal(state.expandedRowId, null, '確定前は展開しない');
  state.commitDrag();
  assert.equal(state.expandedRowId, a.id);
  drag(state, g, [[2, 0]]);
  assert.equal(state.expandedRowId, stair.id);
});

test('CeilingModeState（S10）: 空白タップ（dragState なしの commitDrag({tap:true})）で選択・強調・展開をすべて解除する', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  assert.notEqual(state.expandedRowId, null);
  state.commitDrag({ tap: true });
  assert.equal(state.selection, null);
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.expandedRowId, null);
});

test('CeilingModeState（S10）: selectRoom で展開（アコーディオン＝1行だけ）、toggleExpandedRow で開閉、selectRoom(null)・dispose で null', () => {
  const state = new CeilingModeState();
  state.selectRoom('r1');
  assert.equal(state.expandedRowId, 'r1');
  state.toggleExpandedRow('r1');
  assert.equal(state.expandedRowId, null, '開いている行のトグルで畳む');
  state.toggleExpandedRow('r1');
  assert.equal(state.expandedRowId, 'r1');
  state.toggleExpandedRow('r2');
  assert.equal(state.expandedRowId, 'r2', '別の行を開くと前の行は閉じる');
  assert.equal(state.selectedRoomId, 'r1', '三角は選択を変えない');
  state.selectRoom(null);
  assert.equal(state.expandedRowId, null);
  state.toggleExpandedRow('r1');
  state.dispose();
  assert.equal(state.expandedRowId, null);
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
  state.commitDrag();
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
  assert.equal(state.selectedRoomId, a.id);
  assert.equal(state.dragState, null);
});

test('CeilingModeState: タップは常に置き換え（別の部屋のタップで前の選択のセルは残らない）', () => {
  const { g, b } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0], [1, 0]]);
  drag(state, g, [[3, 0]], { tap: true });
  assert.deepEqual([...state.selection.cellKeys], [g.cell(3, 0)]);
  assert.equal(state.selectedRoomId, b.id);
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

test('CeilingModeState: 別の行の selectRoom で選択を解除し、同じ行なら保つ', () => {
  const { g, a, b } = setup();
  const state = new CeilingModeState();
  drag(state, g, [[0, 0]]);
  state.selectRoom(a.id);
  assert.ok(state.selection, '同じ行のタップでは保つ');
  state.selectRoom(b.id);
  assert.equal(state.selection, null);
  assert.equal(state.selectedRoomId, b.id);
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
  tapCell(s1, g, 1);
  assert.deepEqual([...s1.selection.cellKeys].sort(), all, 'タップ 1 セルでも A の 4 セル全部');
  assert.equal(s1.selection.groupId, roomGroupId(a.id));
  assert.equal(s1.selectedRoomId, a.id);
  const s2 = new CeilingModeState();
  stroke(s2, g, [[0, 0], [1, 0]]);
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
  assert.equal(state.expandedRowId, a.id);
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
  assert.equal(state.selectedRoomId, b.id);
  tapCell(state, g, 0, 1, gctx(graph)); // 空白
  assert.equal(state.selection, null);
  assert.equal(state.expandedRowId, null);
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
  assert.equal(state.expandedRowId, pair.id);
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

test('【失敗系】S12b: intent create で ctx なしの commitDrag は例外（プログラミングエラー）。dragState は残さず、区画は作られない。select は ctx なしでよい', () => {
  const { g, graph, a } = groupSetup();
  const state = new CeilingModeState();
  assert.doesNotThrow(() => tapCell(state, g, 0, 0), 'select は ctx 不要');
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
  assert.equal(state.selectedRoomId, a.id);
  assert.equal(state.expandedRowId, a.id);
  state.selectNode(graph, roomGroupId(b.id));
  assert.equal(state.selection.groupId, roomGroupId(b.id));
  const sel = state.selection;
  state.selectNode(graph, roomGroupId(a.id)); // A の残りは 0 セル（群なし）
  assert.equal(state.selection, sel, '選択は変えない');
  assert.equal(state.expandedRowId, a.id, '展開だけ');
  state.selectNode(graph, 'bogus');
  assert.equal(state.expandedRowId, a.id);
  assert.equal(state.selection, sel);
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
