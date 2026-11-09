// SiteModeState の配置指定の入力（頂点2点・通り芯・距離・反転）と確定・解除（S4）。
// 配置図の読込み（屋根・通り芯の写し）は SiteModeState.placement.test.js が見る。ここは入力の状態遷移・派生・確定の結果を見る。
// 1階だけ・部屋なしの project＝他階の peek なし。通り芯は structGraph に置き、配置図を開いたときの写し（placementRoof.gridLines）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline } from '@core';
import { undoManager } from '../undoManager.js';
import { SITE_PLACEMENT_VERTEX_EPS_MM } from '../core/constants.js';
import {
  TOAST_PLACEMENT_INCOMPLETE, TOAST_PLACEMENT_DISTANCE_BAD, TOAST_PLACEMENT_UNSOLVABLE,
} from '../transform/sitePlacementEdit.js';
import { applySiteTransform } from '../site/sitePlacementView.js';
import { SiteModeState } from './SiteModeState.js';

/** 長方形1枚の敷地と、通り芯 X=0・X=6000・Y=0・Y=4000 を持つ project。 */
function makeProject() {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.activePlaneId = 'p1';
  const st = { labeled: true, discipline: Discipline.STRUCT };
  for (const v of [0, 6000]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, st);
  for (const v of [0, 4000]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, st);
  project.site.addRect(10000, 0, 3000, 2000);
  return project;
}

/** 配置図を開いた SiteModeState（読込み済み）。 */
async function openPlacement(project = makeProject()) {
  const sm = new SiteModeState(project.site, project);
  await sm.setShowPlacement(true);
  return sm;
}

const corners = sm => sm.placementView.siteCorners.map(c => ({ x: c.x, y: c.y }));
const gridX0 = sm => sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.VERTICAL && g.value === 0);

/** 頂点1・2・通り芯・距離を揃える。 */
function fillInput(sm, { distance = '1000' } = {}) {
  const [c0, c1] = corners(sm);
  sm.pickPlacementVertex(c0);
  sm.pickPlacementVertex(c1);
  sm.setPlacementCenterLine(gridX0(sm).id);
  sm.setPlacementDistanceValue(distance);
  return [c0, c1];
}

// ---- 初期化 ----

test('setShowPlacement(true): 痕跡が無ければ入力は空。非表示にすると null・距離欄のフォーカスも解く', async () => {
  const sm = await openPlacement();
  assert.deepEqual(sm.placementInput, {
    v1: null, v2: null, centerLineId: null, distanceValue: '', rotationFlipped: false, sideFlipped: false,
  });
  sm.setPlacementDistanceFocused(true);
  await sm.setShowPlacement(false);
  assert.equal(sm.placementInput, null);
  assert.equal(sm.placementDistanceFocused, false);
  sm.dispose();
});

test('init: site.placement.input があれば入力を復元する（距離は文字列・座標はコピー・centerLineId の空文字は null）', async () => {
  const project = makeProject();
  const saved = {
    v1: { x: 10000, y: 0 }, v2: { x: 13000, y: 0 }, centerLineId: 'cl-1', distance: 1250.5,
    rotationFlipped: true, sideFlipped: false,
  };
  project.site.setPlacement({ rotationDeg: 0, tx: 1, ty: 2, input: saved });
  const sm = new SiteModeState(project.site, project);
  await sm.init();
  assert.equal(sm.showPlacement, true);
  assert.deepEqual(sm.placementInput, {
    v1: { x: 10000, y: 0 }, v2: { x: 13000, y: 0 }, centerLineId: 'cl-1', distanceValue: '1250.5',
    rotationFlipped: true, sideFlipped: false,
  });
  assert.notEqual(sm.placementInput.v1, saved.v1, '保存値の座標オブジェクトを共有しない');
  sm.dispose();

  project.site.setPlacement({ rotationDeg: 0, tx: 1, ty: 2, input: { ...saved, centerLineId: '' } });
  const sm2 = new SiteModeState(project.site, project);
  await sm2.init();
  assert.equal(sm2.placementInput.centerLineId, null);
  sm2.dispose();
});

test('dispose: 入力とフォーカスを捨てる', async () => {
  const sm = await openPlacement();
  sm.setPlacementDistanceFocused(true);
  sm.dispose();
  assert.equal(sm.placementInput, null);
  assert.equal(sm.placementDistanceFocused, false);
});

// ---- 頂点・通り芯・距離 ----

test('pickPlacementVertex: v1→v2 の順に埋まり、同じ角のタップで解除、両方埋まると v2 を置換（v1 は据え置き）、v1 解除で v2 は残る', async () => {
  const sm = await openPlacement();
  const [a, b, c] = corners(sm);
  sm.pickPlacementVertex(a);
  assert.deepEqual([sm.placementInput.v1, sm.placementInput.v2], [a, null]);
  sm.pickPlacementVertex(b);
  assert.deepEqual([sm.placementInput.v1, sm.placementInput.v2], [a, b]);
  sm.pickPlacementVertex(c); // 両方埋まっている → v2 を置換
  assert.deepEqual([sm.placementInput.v1, sm.placementInput.v2], [a, c], 'v1 は距離の基準なので据え置き');
  sm.pickPlacementVertex(a); // v1 を解除
  assert.deepEqual([sm.placementInput.v1, sm.placementInput.v2], [null, c], 'v2 は残る');
  sm.pickPlacementVertex(b); // 空いた v1 へ
  assert.deepEqual([sm.placementInput.v1, sm.placementInput.v2], [b, c]);
  sm.pickPlacementVertex({ x: c.x + SITE_PLACEMENT_VERTEX_EPS_MM / 2, y: c.y }); // EPS 以内＝同じ角 → 解除
  assert.equal(sm.placementInput.v2, null);
  sm.dispose();
});

test('【失敗系】pickPlacementVertex: 配置図を開いていない（入力が null）ときは何もしない', () => {
  const sm = new SiteModeState(makeProject().site);
  sm.pickPlacementVertex({ x: 1, y: 2 });
  assert.equal(sm.placementInput, null);
  sm.setPlacementCenterLine('x');
  sm.setPlacementDistanceValue('5');
  assert.equal(sm.placementInput, null);
  sm.dispose();
});

test('setPlacementCenterLine: 同じ id で解除・違う id で付け替え。写しに無い id は失効（placementCenterLineStale）', async () => {
  const sm = await openPlacement();
  const [g0, g1] = sm.placementRoof.gridLines;
  sm.setPlacementCenterLine(g0.id);
  assert.equal(sm.placementCenterLine, g0);
  assert.equal(sm.placementCenterLineStale, false);
  sm.setPlacementCenterLine(g1.id);
  assert.equal(sm.placementCenterLine, g1);
  sm.setPlacementCenterLine(g1.id);
  assert.equal(sm.placementInput.centerLineId, null);
  assert.equal(sm.placementCenterLine, null);
  assert.equal(sm.placementCenterLineStale, false, '未指定は失効でない');
  sm.setPlacementCenterLine('gone');
  assert.equal(sm.placementCenterLine, null);
  assert.equal(sm.placementCenterLineStale, true, '指定はあるが写しに無い');
  sm.dispose();
});

test('placementVertexStates: 未指定は none・角が今の敷地にあれば set・角が消えたら stale。view が無い（読込み中）ときは set', async () => {
  const project = makeProject();
  const sm = new SiteModeState(project.site, project);
  const p = sm.setShowPlacement(true); // 読込みの完了前: placementView は null
  sm.pickPlacementVertex({ x: 10000, y: 0 });
  assert.equal(sm.placementView, null);
  assert.deepEqual(sm.placementVertexStates, { v1: 'set', v2: 'none' }, 'view が無ければ失効を判定せず set');
  await p;
  const b = corners(sm)[1];
  sm.pickPlacementVertex(b);
  assert.deepEqual(sm.placementVertexStates, { v1: 'set', v2: 'set' });
  runInAction(() => { project.site.removeRect(project.site.rects[0].id); }); // 角が消える
  assert.deepEqual(sm.placementVertexStates, { v1: 'stale', v2: 'stale' });
  sm.dispose();
});

test('placementCanCommit: 頂点2点が set・通り芯が引ける・距離が 0 より大きい有限値、のすべてが揃うときだけ true（stale は不可）', async () => {
  const project = makeProject();
  const sm = await openPlacement(project);
  assert.equal(sm.placementCanCommit, false, '空');
  const [a, b] = corners(sm);
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(b);
  sm.setPlacementCenterLine(gridX0(sm).id);
  assert.equal(sm.placementCanCommit, false, '距離なし');
  for (const bad of ['0', '-5', 'abc', '']) {
    sm.setPlacementDistanceValue(bad);
    assert.equal(sm.placementCanCommit, false, `距離「${bad}」`);
  }
  sm.setPlacementDistanceValue('800');
  assert.equal(sm.placementCanCommit, true);
  sm.setPlacementCenterLine(gridX0(sm).id); // 通り芯を外す
  assert.equal(sm.placementCanCommit, false, '通り芯なし');
  sm.setPlacementCenterLine(gridX0(sm).id);
  assert.equal(sm.placementCanCommit, true);
  sm.pickPlacementVertex(b); // 頂点2を外す
  assert.equal(sm.placementCanCommit, false, '頂点2なし');
  sm.pickPlacementVertex(b);
  assert.equal(sm.placementCanCommit, true);
  runInAction(() => { project.site.removeRect(project.site.rects[0].id); });
  assert.equal(sm.placementCanCommit, false, '頂点が失効');
  sm.dispose();
});

// ---- 確定 ----

test('commitPlacement: 成功すると site.placement に変換と入力（頂点のコピー・距離は数値）が入り、undo で未配置へ・redo で戻る', async () => {
  const sm = await openPlacement();
  const [a, b] = fillInput(sm, { distance: '1000' });
  const r = sm.commitPlacement();
  assert.deepEqual(r, { ok: true, toast: null });
  const p = sm.site.placement;
  assert.ok(p);
  assert.ok(Number.isFinite(p.rotationDeg) && Number.isFinite(p.tx) && Number.isFinite(p.ty));
  assert.deepEqual(p.input, {
    v1: a, v2: b, centerLineId: gridX0(sm).id, distance: 1000, rotationFlipped: false, sideFlipped: false,
  });
  assert.notEqual(p.input.v1, sm.placementInput.v1, '入力と保存値の座標オブジェクトを共有しない');
  assert.equal(sm.placementView.placed, true, '表示も配置の変換に切り替わる');
  undoManager.undo();
  assert.equal(sm.site.placement, null);
  undoManager.redo();
  assert.equal(sm.site.placement, p);
  sm.dispose();
});

test('【失敗系】commitPlacement: 入力不足（頂点・通り芯・距離の未入力）は TOAST_PLACEMENT_INCOMPLETE で配置も undo も変えない', async () => {
  const sm = await openPlacement();
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE }, '空');
  const [a, b] = corners(sm);
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(b);
  sm.setPlacementDistanceValue('500');
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE }, '通り芯なし');
  sm.setPlacementCenterLine('gone');
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE }, '通り芯が写しに無い（失効）');
  sm.setPlacementCenterLine('gone'); // 解除
  sm.setPlacementCenterLine(gridX0(sm).id);
  sm.setPlacementDistanceValue('');
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE }, '距離が空');
  assert.equal(sm.site.placement, null);
  assert.equal(undoManager.peekUndo(), before);
  sm.dispose();
});

test('【失敗系】commitPlacement: 頂点が失効（角が消えた）していれば TOAST_PLACEMENT_INCOMPLETE', async () => {
  const project = makeProject();
  const sm = await openPlacement(project);
  fillInput(sm);
  runInAction(() => { project.site.removeRect(project.site.rects[0].id); });
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE });
  assert.equal(sm.site.placement, null);
  sm.dispose();
});

test('commitPlacement: 距離は NumPad の式を評価した数値で確定する（\'1000+500\' → 1500。保存する distance は評価後の数値）', async () => {
  const sm = await openPlacement();
  fillInput(sm, { distance: '1000+500' });
  assert.equal(sm.placementCanCommit, true);
  assert.deepEqual(sm.commitPlacement(), { ok: true, toast: null });
  assert.equal(sm.site.placement.input.distance, 1500);
  assert.equal(sm.placementInput.distanceValue, '1500', '保存値から作り直した入力は評価後の文字列');
  sm.dispose();
});

test('【失敗系】commitPlacement: 距離が 0 以下・式でない・末尾演算子は TOAST_PLACEMENT_DISTANCE_BAD', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  for (const bad of ['0', '-10', '1+', 'abc', 'Infinity']) {
    sm.setPlacementDistanceValue(bad);
    assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_DISTANCE_BAD }, `距離「${bad}」`);
  }
  assert.equal(sm.site.placement, null);
  sm.dispose();
});

test('【失敗系】commitPlacement: 解けない入力（通り芯の種別が縦横以外）は TOAST_PLACEMENT_UNSOLVABLE で保存しない', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  runInAction(() => {
    sm.placementRoof = {
      ...sm.placementRoof,
      gridLines: [{ id: 'radial', centerLineType: CenterLineType.RADIAL, value: 45, label: 'R1' }],
    };
  });
  sm.setPlacementCenterLine('radial');
  assert.equal(sm.placementCanCommit, true, '入力としては揃っている');
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_UNSOLVABLE });
  assert.equal(sm.site.placement, null);
  sm.dispose();
});

// ---- 反転 ----

test('togglePlacementRotation / Side: 配置済みで確定できる入力なら即時に再配置する（undo は 1 件ずつ）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  assert.equal(sm.commitPlacement().ok, true);
  const first = sm.site.placement;
  const r = sm.togglePlacementRotation();
  assert.deepEqual(r, { ok: true, toast: null });
  assert.equal(sm.placementInput.rotationFlipped, true);
  const second = sm.site.placement;
  assert.notEqual(second, first, '再配置された');
  assert.equal(second.input.rotationFlipped, true);
  assert.notEqual(second.rotationDeg, first.rotationDeg, '回転反転で向きが変わる');
  sm.togglePlacementSide();
  const third = sm.site.placement;
  assert.equal(third.input.sideFlipped, true);
  undoManager.undo();
  assert.equal(sm.site.placement, second, '側反転の1件だけ戻る');
  undoManager.undo();
  assert.equal(sm.site.placement, first, '回転反転の1件だけ戻る');
  sm.dispose();
});

test('togglePlacement*: 未配置ではフラグを切り替えるだけで配置しない（toast なし）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.togglePlacementRotation(), { ok: true, toast: null });
  assert.deepEqual(sm.togglePlacementSide(), { ok: true, toast: null });
  assert.equal(sm.placementInput.rotationFlipped, true);
  assert.equal(sm.placementInput.sideFlipped, true);
  assert.equal(sm.site.placement, null);
  assert.equal(undoManager.peekUndo(), before);
  sm.dispose();
});

test('【失敗系】togglePlacement*: 配置済みでも距離が不正なら再配置せず toast も出さない（フラグだけ切り替える）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  sm.commitPlacement();
  const placed = sm.site.placement;
  sm.setPlacementDistanceValue('0'); // canCommit が false → 再配置しない
  assert.deepEqual(sm.togglePlacementSide(), { ok: true, toast: null });
  assert.equal(sm.placementInput.sideFlipped, true, 'フラグは切り替わる');
  assert.equal(sm.site.placement, placed, '配置は据え置き');
  sm.dispose();
});

// ---- 解除 ----

test('clearPlacement: 配置を null へ（undo で戻る）、入力を空に戻す', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  sm.commitPlacement();
  const placed = sm.site.placement;
  sm.setPlacementDistanceFocused(true);
  sm.clearPlacement();
  assert.equal(sm.site.placement, null);
  assert.equal(sm.placementView.placed, false, '図芯合わせへ戻る');
  assert.deepEqual(sm.placementInput, {
    v1: null, v2: null, centerLineId: null, distanceValue: '', rotationFlipped: false, sideFlipped: false,
  });
  assert.equal(sm.placementDistanceFocused, false);
  undoManager.undo();
  assert.equal(sm.site.placement, placed);
  sm.dispose();
});

// ---- 失効からの復帰・再配置の沿い座標・undo/redo との同期 ----

test('pickPlacementVertex: 失効した頂点1は空きとして埋め直せる（確定→敷地を作り直して v1・v2 が stale→新しい角のタップで v1 が埋まる）', async () => {
  const project = makeProject();
  const sm = await openPlacement(project);
  fillInput(sm);
  assert.equal(sm.commitPlacement().ok, true);
  runInAction(() => {
    project.site.removeRect(project.site.rects[0].id);
    project.site.addRect(20000, 0, 3000, 2000);
  });
  assert.deepEqual(sm.placementVertexStates, { v1: 'stale', v2: 'stale' });
  sm.pickPlacementVertex(corners(sm)[0]);
  assert.deepEqual(sm.placementVertexStates, { v1: 'set', v2: 'stale' });
  sm.pickPlacementVertex(corners(sm)[1]); // v1 が set なので v2（失効）を置換
  assert.deepEqual(sm.placementVertexStates, { v1: 'set', v2: 'set' });
  sm.dispose();
});

test('反転の即時再配置で頂点1の像の沿い座標が保たれる（R6）: 確定 (−1000,1000)・回転反転後も (−1000,1000)・側反転後は (1000,1000)', async () => {
  const sm = await openPlacement();
  const [v1] = fillInput(sm, { distance: '1000' });
  assert.equal(sm.commitPlacement().ok, true);
  const image = () => applySiteTransform(v1, sm.placementView.siteTransform);
  const near = (p, x, y) => { assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6, `(${p.x}, ${p.y}) ≠ (${x}, ${y})`); };
  near(image(), -1000, 1000);
  sm.togglePlacementRotation();
  near(image(), -1000, 1000);
  sm.togglePlacementSide();
  near(image(), 1000, 1000);
  sm.dispose();
});

test('【失敗系】togglePlacement*: 配置済みで canCommit でも解けなければ {ok:false, toast:UNSOLVABLE} を返し site.placement は同じ参照のまま', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  sm.commitPlacement();
  const placed = sm.site.placement;
  runInAction(() => {
    sm.placementRoof = { ...sm.placementRoof, gridLines: [{ id: 'radial', centerLineType: CenterLineType.RADIAL, value: 45, label: 'R1' }] };
  });
  sm.setPlacementCenterLine('radial');
  assert.equal(sm.placementCanCommit, true);
  assert.deepEqual(sm.togglePlacementSide(), { ok: false, toast: TOAST_PLACEMENT_UNSOLVABLE });
  assert.equal(sm.site.placement, placed);
  sm.dispose();
});

test('undo/redo との同期: 解除→undo で入力が保存値から復元される', async () => {
  const sm = await openPlacement();
  const [a, b] = fillInput(sm, { distance: '1000' });
  sm.commitPlacement();
  sm.clearPlacement();
  assert.equal(sm.placementInput.v1, null);
  sm.setPlacementDistanceFocused(true); // 距離を打ちかけのまま undo
  undoManager.undo();
  assert.ok(sm.site.placement);
  assert.deepEqual(sm.placementInput, {
    v1: a, v2: b, centerLineId: gridX0(sm).id, distanceValue: '1000', rotationFlipped: false, sideFlipped: false,
  });
  assert.equal(sm.placementDistanceFocused, false, '入力が保存値に置き換わるので NumPad の編集状態は閉じる');
  sm.dispose();
});

test('undo/redo との同期: 確定→undo で placement は null、入力は触らず残る（未配置＋入力あり）', async () => {
  const sm = await openPlacement();
  const [a] = fillInput(sm);
  sm.commitPlacement();
  undoManager.undo();
  assert.equal(sm.site.placement, null);
  assert.deepEqual(sm.placementInput.v1, a, '入力は残る');
  assert.equal(sm.placementInput.distanceValue, '1000');
  sm.dispose();
});
