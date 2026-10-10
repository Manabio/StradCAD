// CeilingModeState（天伏モード。独立 State）。mobx と純モジュール（ceiling/ceilingSelection.js）にしか
// 依存しないため node:test から直接 import できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun, isObservable } from 'mobx';
import { StairType, CenterLineType, Discipline } from '@core';
import { isUiBusy } from '../uiBusy.js';
import { ERR_CL_MOVE_LOAD_FAILED } from '../error.js';
import { makeGrid } from '../plan/planTestFixtures.js';
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

test('CeilingModeState: ドラッグ中は previewCells に訪れたセルが出る。部屋を超えた分は入らない', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  assert.deepEqual(state.previewCells, []);
  state.startDrag(g.graph, ...ctr(1, 0));
  state.updateDrag(g.graph, ...ctr(3, 0), 100); // 階段・B を通っても A 以外は足さない
  assert.equal(state.previewCells.length, 1);
  state.updateDrag(g.graph, ...ctr(0, 0), 100);
  assert.equal(state.previewCells.length, 2);
  assert.equal(state.selection, null, '確定前は selection に出ない');
});

test('CeilingModeState: 購読は 開始・足したとき・確定 でだけ再実行され、何も足さない update では再実行されない', () => {
  const { g } = setup();
  const state = new CeilingModeState();
  const seen = [];
  const stop = autorun(() => seen.push([state.previewCells.length, state.selection ? 'sel' : 'none']));
  assert.equal(seen.length, 1);
  state.startDrag(g.graph, ...ctr(0, 0));
  assert.equal(seen.length, 2, '開始');
  assert.equal(isObservable(state.dragState), false, 'dragState は observable.ref（中身を深く観測しない。lastWorld の in place 更新が購読を起こさない前提）');
  state.updateDrag(g.graph, ...ctr(0, 0), 100);
  assert.equal(seen.length, 2, '何も足さない update では再実行されない');
  state.updateDrag(g.graph, ...ctr(1, 0), 100);
  assert.equal(seen.length, 3, '足した update（回数の assert は observable.ref の変異を検出しない。ref の固定は isObservable の assert が担う）');
  state.commitDrag();
  assert.equal(seen.length, 4, '確定');
  assert.deepEqual(seen[3], [0, 'sel']);
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
