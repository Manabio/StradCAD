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
  TOAST_PLACEMENT_ALONG_INCOMPLETE, TOAST_PLACEMENT_ALONG_AXIS,
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

const EMPTY_ALONG = { vertex: 1, centerLineId: null, distanceValue: '', sideFlipped: false };
const gridY0 = sm => sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.HORIZONTAL && g.value === 0);
const gridY4000 = sm => sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.HORIZONTAL && g.value === 4000);

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
    v1: null, v2: null, centerLineId: null, distanceValue: '', rotationFlipped: false, sideFlipped: false, along: EMPTY_ALONG,
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
    rotationFlipped: true, sideFlipped: false, along: EMPTY_ALONG,
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
    v1: a, v2: b, centerLineId: gridX0(sm).id, distance: 1000, rotationFlipped: false, sideFlipped: false, along: null,
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
    v1: null, v2: null, centerLineId: null, distanceValue: '', rotationFlipped: false, sideFlipped: false, along: EMPTY_ALONG,
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
    v1: a, v2: b, centerLineId: gridX0(sm).id, distanceValue: '1000', rotationFlipped: false, sideFlipped: false, along: EMPTY_ALONG,
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

// ---- 2 段目「位置」（S5） ----
// 配置: 敷地 (10000,0)-(13000,0)-… を v1=(10000,0)・v2=(13000,0)。1 段目＝縦 X0（x=0）距離 1000 → 回転 90 度・図芯 (3000,2000) が x=0 の東 → 像の x=−1000。
// 2 段目＝横 Y4000（y=4000）離れ 500・図芯 y=2000 が y=4000 の北 → 共有点の像の y=4500。R(90)·(v2−v1)=(0,3000)。

const imageOf = (sm, p) => applySiteTransform(p, sm.placementView.siteTransform);
const nearPt = (p, x, y, msg) => { assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6, `${msg ?? ''} (${p.x}, ${p.y}) ≠ (${x}, ${y})`); };

/** 位置の入力（共有点・横 Y4000・離れ）を揃える。 */
function fillAlong(sm, { vertex = 1, distance = '500' } = {}) {
  sm.setPlacementAlongVertex(vertex);
  sm.setPlacementAlongCenterLine(gridY4000(sm).id);
  sm.setPlacementAlongDistanceValue(distance);
}

test('placementAlongCenterLines: 1 段目が未選択なら空・縦を選ぶと横だけ・横を選ぶと縦だけ（同じ軸は候補に出ない）', async () => {
  const sm = await openPlacement();
  assert.deepEqual(sm.placementAlongCenterLines, []);
  sm.setPlacementCenterLine(gridX0(sm).id);
  assert.deepEqual(sm.placementAlongCenterLines.map(g => [g.centerLineType, g.value]),
    [[CenterLineType.HORIZONTAL, 0], [CenterLineType.HORIZONTAL, 4000]]);
  sm.setPlacementCenterLine(gridY0(sm).id);
  assert.deepEqual(sm.placementAlongCenterLines.map(g => [g.centerLineType, g.value]),
    [[CenterLineType.VERTICAL, 0], [CenterLineType.VERTICAL, 6000]]);
  sm.dispose();
});

test('placementAlongState: 通り芯も離れも空なら none（共有点・側だけの変更は none）・片方だけなら partial・両方で ready', async () => {
  const sm = await openPlacement();
  sm.setPlacementCenterLine(gridX0(sm).id);
  assert.equal(sm.placementAlongState, 'none');
  sm.setPlacementAlongVertex(2);
  sm.togglePlacementAlongSide();
  assert.equal(sm.placementAlongState, 'none', '共有点・側は数えない');
  sm.setPlacementAlongDistanceValue('500');
  assert.equal(sm.placementAlongState, 'partial', '離れだけ');
  sm.setPlacementAlongCenterLine(gridY4000(sm).id);
  assert.equal(sm.placementAlongState, 'ready');
  sm.setPlacementAlongDistanceValue('');
  assert.equal(sm.placementAlongState, 'partial', '通り芯だけ');
  sm.setPlacementAlongCenterLine(gridY4000(sm).id); // 解除
  assert.equal(sm.placementAlongState, 'none');
  sm.dispose();
});

test('位置のアクション: 共有点は 1/2 だけ受ける・通り芯は同じ id で解除・離れは文字列をそのまま持つ。配置図を開いていなければ何もしない', async () => {
  const sm = await openPlacement();
  sm.setPlacementAlongVertex(2);
  assert.equal(sm.placementInput.along.vertex, 2);
  sm.setPlacementAlongVertex(3);
  sm.setPlacementAlongVertex(0);
  assert.equal(sm.placementInput.along.vertex, 2, '1/2 以外は無視');
  const id = gridY4000(sm).id;
  sm.setPlacementAlongCenterLine(id);
  assert.equal(sm.placementInput.along.centerLineId, id);
  sm.setPlacementAlongCenterLine(id);
  assert.equal(sm.placementInput.along.centerLineId, null);
  sm.setPlacementAlongDistanceValue('12+3');
  assert.equal(sm.placementInput.along.distanceValue, '12+3');
  sm.dispose();

  const closed = new SiteModeState(makeProject().site);
  closed.setPlacementAlongVertex(2);
  closed.setPlacementAlongCenterLine('x');
  closed.setPlacementAlongDistanceValue('5');
  assert.equal(closed.placementInput, null);
  assert.deepEqual(closed.togglePlacementAlongSide(), { ok: true, toast: null });
  assert.deepEqual(closed.clearPlacementAlong(), { ok: true, toast: null });
  closed.dispose();
});

test('【失敗系】位置が partial: placementCanCommit は false・commitPlacement は TOAST_PLACEMENT_ALONG_INCOMPLETE で配置も undo も変えない（1 段目が揃っていても）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  assert.equal(sm.placementCanCommit, true, '位置なしなら確定できる');
  const before = undoManager.peekUndo();
  sm.setPlacementAlongDistanceValue('500'); // 通り芯なし
  assert.equal(sm.placementAlongState, 'partial');
  assert.equal(sm.placementCanCommit, false);
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_ALONG_INCOMPLETE });
  sm.setPlacementAlongDistanceValue('');
  sm.setPlacementAlongCenterLine(gridY4000(sm).id); // 離れなし
  assert.equal(sm.placementCanCommit, false);
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_ALONG_INCOMPLETE });
  assert.equal(sm.site.placement, null);
  assert.equal(undoManager.peekUndo(), before);
  sm.dispose();
});

test('commitPlacement: 位置あり（共有点=頂点1）→ 保存される along は {vertex, centerLineId, distance（式を評価した数値）, sideFlipped}。共有点の像の y=4000+500、v2 の像の x は 1 段目の拘束どおり', async () => {
  const sm = await openPlacement();
  const [v1, v2] = fillInput(sm, { distance: '1000' });
  nearPt(v1, 10000, 0); nearPt(v2, 13000, 0);
  fillAlong(sm, { vertex: 1, distance: '400+100' });
  assert.equal(sm.placementCanCommit, true);
  assert.deepEqual(sm.commitPlacement(), { ok: true, toast: null });
  assert.deepEqual(sm.site.placement.input.along, { vertex: 1, centerLineId: gridY4000(sm).id, distance: 500, sideFlipped: false });
  assert.equal(sm.site.placement.rotationDeg, 90);
  nearPt(imageOf(sm, v1), -1000, 4500, '共有点 v1（y=Y4000+500）');
  nearPt(imageOf(sm, v2), -1000, 7500, 'v2（x=−1000 の拘束が保たれる）');
  assert.equal(sm.placementInput.along.distanceValue, '500', '保存値から作り直した入力は評価後の文字列');
  sm.dispose();
});

test('commitPlacement: 位置あり（共有点=頂点2）→ v2 の像の y=4500・v1 の像の y=1500（R·(v2−v1)=(0,3000) を引く）', async () => {
  const sm = await openPlacement();
  const [v1, v2] = fillInput(sm, { distance: '1000' });
  fillAlong(sm, { vertex: 2, distance: '500' });
  assert.equal(sm.commitPlacement().ok, true);
  assert.equal(sm.site.placement.input.along.vertex, 2);
  nearPt(imageOf(sm, v2), -1000, 4500, '共有点 v2');
  nearPt(imageOf(sm, v1), -1000, 1500, 'v1');
  sm.dispose();
});

test('【失敗系】commitPlacement: 位置の離れが 0 以下・式でないなら TOAST_PLACEMENT_DISTANCE_BAD（canCommit も false）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  fillAlong(sm);
  for (const bad of ['0', '-10', '1+', 'abc']) {
    sm.setPlacementAlongDistanceValue(bad);
    assert.equal(sm.placementAlongState, 'ready');
    assert.equal(sm.placementCanCommit, false, `離れ「${bad}」`);
    assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_DISTANCE_BAD }, `離れ「${bad}」`);
  }
  assert.equal(sm.site.placement, null);
  sm.dispose();
});

test('【失敗系】commitPlacement: 位置の通り芯が 1 段目と同じ軸なら TOAST_PLACEMENT_ALONG_AXIS・写しに無い id（失効）なら TOAST_PLACEMENT_INCOMPLETE。どちらも保存しない', async () => {
  const sm = await openPlacement();
  fillInput(sm); // 1 段目＝縦 X0
  const x6000 = sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.VERTICAL && g.value === 6000);
  sm.setPlacementAlongCenterLine(x6000.id); // 一覧では選べないが、アクションは受ける（防御）
  sm.setPlacementAlongDistanceValue('500');
  assert.equal(sm.placementAlongCenterLine, null, '候補は直交する軸だけ');
  assert.equal(sm.placementCanCommit, false);
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_ALONG_AXIS });
  sm.setPlacementAlongCenterLine(x6000.id); // 解除
  sm.setPlacementAlongCenterLine('gone');
  assert.equal(sm.placementAlongStale, true);
  assert.equal(sm.placementCanCommit, false);
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE });
  assert.equal(sm.site.placement, null);
  sm.dispose();
});

test('1 段目の通り芯を縦→横へ変えると、選んでいた横の位置の通り芯は同じ軸になり失効扱い（placementAlongCenterLine=null・stale=true・canCommit=false）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  fillAlong(sm);
  assert.equal(sm.placementAlongCenterLine?.value, 4000);
  assert.equal(sm.placementAlongStale, false);
  sm.setPlacementCenterLine(gridY0(sm).id); // 1 段目を横 Y0 へ
  assert.equal(sm.placementAlongCenterLine, null);
  assert.equal(sm.placementAlongStale, true);
  assert.equal(sm.placementCanCommit, false);
  sm.dispose();
});

test('1 段目の頂点を解除すると、その頂点を共有点にした位置は失効（placementAlongVertexStale・canCommit=false・commit は INCOMPLETE）。位置が none なら失効扱いにしない', async () => {
  const sm = await openPlacement();
  const [, v2] = fillInput(sm);
  assert.equal(sm.placementAlongVertexStale, false);
  sm.pickPlacementVertex(v2); // 頂点2を解除
  assert.equal(sm.placementAlongVertexStale, false, '位置が none');
  assert.equal(sm.placementCanCommit, false, '1 段目の頂点2が無い');
  sm.pickPlacementVertex(v2); // 戻す
  fillAlong(sm, { vertex: 2 });
  assert.equal(sm.placementCanCommit, true);
  sm.pickPlacementVertex(v2); // 共有点の頂点2を解除
  assert.equal(sm.placementAlongVertexStale, true);
  assert.equal(sm.placementCanCommit, false);
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE });
  sm.setPlacementAlongVertex(1); // 共有点を頂点1（set）へ変えれば失効でなくなる（1 段目は頂点2なしで canCommit 不可のまま）
  assert.equal(sm.placementAlongVertexStale, false);
  sm.dispose();
});

test('togglePlacementAlongSide: 配置済みなら即時に再配置（共有点の像 y=4500→3500。undo 1 件）。未配置ならフラグだけ（配置も undo も増えない）', async () => {
  const sm = await openPlacement();
  const [v1] = fillInput(sm);
  fillAlong(sm);
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.togglePlacementAlongSide(), { ok: true, toast: null });
  assert.equal(sm.placementInput.along.sideFlipped, true);
  assert.equal(sm.site.placement, null);
  assert.equal(undoManager.peekUndo(), before);
  sm.togglePlacementAlongSide(); // 戻す
  assert.equal(sm.commitPlacement().ok, true);
  nearPt(imageOf(sm, v1), -1000, 4500);
  const first = sm.site.placement;
  assert.deepEqual(sm.togglePlacementAlongSide(), { ok: true, toast: null });
  assert.equal(sm.site.placement.input.along.sideFlipped, true);
  nearPt(imageOf(sm, v1), -1000, 3500, '側反転で B の手前へ');
  undoManager.undo();
  assert.equal(sm.site.placement, first, '側反転の 1 件だけ戻る');
  sm.dispose();
});

test('togglePlacementAlongSide: 配置済みでも位置が none なら再配置せずフラグだけ切り替える（{ok:true}・undo 件数不変・site.placement は同じ参照）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  assert.equal(sm.commitPlacement().ok, true);
  const placed = sm.site.placement;
  const before = undoManager.peekUndo();
  assert.equal(sm.placementAlongState, 'none');
  assert.deepEqual(sm.togglePlacementAlongSide(), { ok: true, toast: null });
  assert.equal(sm.placementInput.along.sideFlipped, true);
  assert.equal(sm.site.placement, placed);
  assert.equal(undoManager.peekUndo(), before);
  sm.dispose();
});

test('clearPlacementAlong: 位置を既定へ戻し、配置済みなら即時に再配置して沿い座標を前回の像へ据え置く（R6）。undo で位置ありの配置へ戻る', async () => {
  const sm = await openPlacement();
  const [v1] = fillInput(sm);
  fillAlong(sm, { vertex: 2 });
  sm.setPlacementAlongDistanceFocused(true);
  assert.equal(sm.commitPlacement().ok, true);
  const withAlong = sm.site.placement;
  nearPt(imageOf(sm, v1), -1000, 1500, '位置あり（共有点 v2 → v1 の y=1500）');
  assert.deepEqual(sm.clearPlacementAlong(), { ok: true, toast: null });
  assert.deepEqual(sm.placementInput.along, EMPTY_ALONG);
  assert.equal(sm.placementAlongDistanceFocused, false);
  assert.equal(sm.site.placement.input.along, null, '保存される along も null');
  assert.notEqual(sm.site.placement, withAlong);
  nearPt(imageOf(sm, v1), -1000, 1500, 'R6: 沿い座標は直前の像のまま');
  undoManager.undo();
  assert.equal(sm.site.placement, withAlong);
  sm.dispose();
});

test('clearPlacementAlong: 未配置なら入力を既定に戻すだけ（配置も undo も増えない）。1 段目が不完全な配置済みでも再配置しない', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  fillAlong(sm);
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.clearPlacementAlong(), { ok: true, toast: null });
  assert.deepEqual(sm.placementInput.along, EMPTY_ALONG);
  assert.equal(sm.site.placement, null);
  assert.equal(undoManager.peekUndo(), before);
  fillAlong(sm);
  sm.commitPlacement();
  const placed = sm.site.placement;
  sm.setPlacementDistanceValue('0'); // 1 段目の距離が不正 → canCommit=false
  assert.deepEqual(sm.clearPlacementAlong(), { ok: true, toast: null });
  assert.equal(sm.site.placement, placed, '再配置しない');
  sm.dispose();
});

test('undo/redo との同期: 位置あり→解除→undo で位置の入力（共有点・通り芯・離れ・側）も保存値から復元され、位置の NumPad は閉じる', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  fillAlong(sm, { vertex: 2, distance: '500' });
  sm.togglePlacementAlongSide();
  sm.commitPlacement();
  sm.clearPlacement();
  assert.deepEqual(sm.placementInput.along, EMPTY_ALONG);
  sm.setPlacementAlongDistanceFocused(true);
  undoManager.undo();
  assert.deepEqual(sm.placementInput.along, { vertex: 2, centerLineId: gridY4000(sm).id, distanceValue: '500', sideFlipped: true });
  assert.equal(sm.placementAlongDistanceFocused, false);
  sm.dispose();
});

test('init: site.placement.input.along があれば位置の入力を復元する（離れは文字列）。無ければ既定', async () => {
  const project = makeProject();
  const input = {
    v1: { x: 10000, y: 0 }, v2: { x: 13000, y: 0 }, centerLineId: 'cl-1', distance: 1000, rotationFlipped: false, sideFlipped: false,
    along: { vertex: 2, centerLineId: 'cl-2', distance: 250.5, sideFlipped: true },
  };
  project.site.setPlacement({ rotationDeg: 90, tx: 0, ty: 0, input });
  const sm = new SiteModeState(project.site, project);
  await sm.init();
  assert.deepEqual(sm.placementInput.along, { vertex: 2, centerLineId: 'cl-2', distanceValue: '250.5', sideFlipped: true });
  sm.dispose();
  project.site.setPlacement({ rotationDeg: 90, tx: 0, ty: 0, input: { ...input, along: null } });
  const sm2 = new SiteModeState(project.site, project);
  await sm2.init();
  assert.deepEqual(sm2.placementInput.along, EMPTY_ALONG);
  sm2.dispose();
});

test('NumPad のフォーカスの排他: 距離欄と位置の離れ欄は同時に true にならない（true にした側だけが残り、false は相手に触れない）。非表示・dispose で両方解く', async () => {
  const sm = await openPlacement();
  sm.setPlacementDistanceFocused(true);
  sm.setPlacementAlongDistanceFocused(true);
  assert.deepEqual([sm.placementDistanceFocused, sm.placementAlongDistanceFocused], [false, true]);
  sm.setPlacementDistanceFocused(true);
  assert.deepEqual([sm.placementDistanceFocused, sm.placementAlongDistanceFocused], [true, false]);
  sm.setPlacementAlongDistanceFocused(true);
  sm.setPlacementDistanceFocused(false);
  assert.equal(sm.placementAlongDistanceFocused, true, 'false は相手を触らない');
  sm.setPlacementAlongDistanceFocused(false);
  sm.setPlacementDistanceFocused(true);
  sm.setPlacementAlongDistanceFocused(false);
  assert.equal(sm.placementDistanceFocused, true, 'false は相手を触らない');
  sm.setPlacementAlongDistanceFocused(true);
  await sm.setShowPlacement(false);
  assert.deepEqual([sm.placementDistanceFocused, sm.placementAlongDistanceFocused], [false, false]);
  sm.dispose();

  const sm2 = await openPlacement();
  sm2.setPlacementAlongDistanceFocused(true);
  sm2.dispose();
  assert.equal(sm2.placementAlongDistanceFocused, false);
});
