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
  TOAST_PLACEMENT_ALONG_INCOMPLETE, TOAST_PLACEMENT_ALONG_AXIS, TOAST_PLACEMENT_ALONG_UNSHARED,
} from '../transform/sitePlacementEdit.js';
import { applySiteTransform } from '../site/siteTransform.js';
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

const EMPTY_ALONG = { v1: null, v2: null, centerLineId: null, distanceValue: '', sideFlipped: false };
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

// 4 つの枠（1 対目の頂点1・頂点2、2 対目の頂点1・頂点2）の入力を [f1, f2, a1, a2] で見る
const slots = sm => [sm.placementInput.v1, sm.placementInput.v2, sm.placementInput.along.v1, sm.placementInput.along.v2];

test('pickPlacementVertex: 1 対目 v1 → v2 → 2 対目 v1 → v2 の順に埋まり、全部埋まると 2 対目 v2 を置換する（1 対目・2 対目 v1 は据え置き）', async () => {
  const sm = await openPlacement();
  const [a, b, c, d] = corners(sm);
  sm.pickPlacementVertex(a);
  assert.deepEqual(slots(sm), [a, null, null, null]);
  sm.pickPlacementVertex(b);
  assert.deepEqual(slots(sm), [a, b, null, null]);
  sm.pickPlacementVertex(c);
  assert.deepEqual(slots(sm), [a, b, c, null], '3 つ目は 2 対目の頂点1');
  sm.pickPlacementVertex(d);
  assert.deepEqual(slots(sm), [a, b, c, d], '4 つ目は 2 対目の頂点2');
  sm.dispose();
});

test('pickPlacementVertex: 4 枠が全部埋まっているとき、新しい角は 2 対目の頂点2 を置換する。座標は EPS 以内なら同じ角', async () => {
  const sm = await openPlacement();
  const [a, b, c, d] = corners(sm);
  const extra = { x: 99999, y: 99999 };
  [a, b, c, d].forEach(p => sm.pickPlacementVertex(p));
  // 4 角（長方形）しか角が無いので、5 つ目は角として存在しない座標で置換の分岐だけを見る（失効扱いは別テスト）
  sm.pickPlacementVertex(extra);
  assert.deepEqual(slots(sm).slice(0, 3), [a, b, c], '1 対目と 2 対目の頂点1 は据え置き');
  assert.deepEqual(slots(sm)[3], extra, '2 対目の頂点2 を置換');
  sm.pickPlacementVertex({ x: extra.x + SITE_PLACEMENT_VERTEX_EPS_MM / 2, y: extra.y }); // EPS 以内＝同じ角 → 解除
  assert.equal(slots(sm)[3], null);
  sm.dispose();
});

test('pickPlacementVertex: 2 対目だけの角のタップはその枠を解除し、1 対目の枠は触らない。空いた枠は次のタップで埋まる', async () => {
  const sm = await openPlacement();
  const [a, b, c, d] = corners(sm);
  [a, b, c, d].forEach(p => sm.pickPlacementVertex(p));
  sm.pickPlacementVertex(d); // 2 対目の頂点2 を解除
  assert.deepEqual(slots(sm), [a, b, c, null]);
  sm.pickPlacementVertex(c); // 2 対目の頂点1 を解除
  assert.deepEqual(slots(sm), [a, b, null, null], '1 対目は無傷');
  sm.pickPlacementVertex(d); // 空いた 2 対目の頂点1 へ
  assert.deepEqual(slots(sm), [a, b, d, null]);
  sm.dispose();
});

test('pickPlacementVertex: 1 対目だけの角のタップ。1 対目が不完全なら解除・揃っていて 2 対目に空きがあれば 2 対目へ入れる（共有点）・空きが無ければ解除', async () => {
  const sm = await openPlacement();
  const [a, b, c, d] = corners(sm);
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(a); // 1 対目が不完全 → 解除
  assert.deepEqual(slots(sm), [null, null, null, null]);
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(b);
  sm.pickPlacementVertex(b); // 1 対目が揃っている・2 対目に空き → 共有点として 2 対目の頂点1 へ
  assert.deepEqual(slots(sm), [a, b, b, null]);
  assert.equal(sm.placementAlongSharedVertex, 2);
  sm.pickPlacementVertex(a); // 1 対目の頂点1 の角。2 対目に空きがある（頂点2）→ 2 対目の頂点2 へ
  assert.deepEqual(slots(sm), [a, b, b, a]);
  sm.pickPlacementVertex(c);
  assert.deepEqual(slots(sm), [a, b, b, c], '全部埋まっていれば 2 対目の頂点2 を置換');
  sm.pickPlacementVertex(a); // 1 対目だけの角・2 対目に空きなし → 1 対目の頂点1 を解除
  assert.deepEqual(slots(sm), [null, b, b, c], '2 対目は触らない');
  assert.equal(sm.placementAlongVertexStates.v1, 'set', '頂点2 が一致しているので共有のまま');
  sm.pickPlacementVertex(d); // 空いた 1 対目の頂点1 へ
  assert.deepEqual(slots(sm), [d, b, b, c]);
  sm.dispose();
});

test('pickPlacementVertex: 2 対目の失効枠（角が無い座標）は空きとして埋まる。どの枠にも無い角のタップは 2 対目の頂点2 でなく頂点1 に入る', async () => {
  const sm = await openPlacement();
  const [a, b, c] = corners(sm);
  [a, b].forEach(p => sm.pickPlacementVertex(p));
  const gone = { x: 1, y: 2 };
  runInAction(() => { sm.placementInput = { ...sm.placementInput, along: { ...sm.placementInput.along, v1: gone } }; });
  assert.equal(sm.placementAlongVertexStates.v1, 'stale');
  sm.pickPlacementVertex(c);
  assert.deepEqual(slots(sm), [a, b, c, null]);
  sm.dispose();
});

test('pickPlacementVertex: 2 対目の頂点1 が unshared のとき、1 対目だけの角のタップは頂点1 を置き換え、1 対目は不変', async () => {
  const sm = await openPlacement();
  const [a, b, c] = corners(sm);
  [a, b, c].forEach(p => sm.pickPlacementVertex(p)); // 2 対目の頂点1＝c（1 対目 [a,b] のどちらとも違う）
  assert.equal(sm.placementAlongVertexStates.v1, 'unshared');
  sm.pickPlacementVertex(a);
  assert.deepEqual(slots(sm), [a, b, a, null], '頂点1 が置き換わり 1 対目は不変');
  assert.equal(sm.placementAlongSharedVertex, 1);
  sm.dispose();
});

test('pickPlacementVertex: 共有の角（1 対目と 2 対目の頂点1 が同じ）のタップは、入っている枠すべてから外す。次のタップは空いた 1 対目の枠から埋まる', async () => {
  const sm = await openPlacement();
  const [a, b] = corners(sm);
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(b);
  sm.pickPlacementVertex(b); // 共有
  sm.pickPlacementVertex(b);
  assert.deepEqual(slots(sm), [a, null, null, null]);
  sm.pickPlacementVertex(b);
  assert.deepEqual(slots(sm), [a, b, null, null]);
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
  sm.pickPlacementVertex(b); // 1 対目が揃っているので 2 対目の頂点1（共有点）になる
  assert.equal(sm.placementCanCommit, false, '2 対目が不完全（頂点1 だけ）');
  sm.pickPlacementVertex(b); // 共有の角 → 1 対目の頂点2・2 対目の頂点1 から外れる
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
// 2 段目＝横 Y4000（y=4000）離れ 500・R(90)·(v2−v1)=(0,3000)。側は敷地の延びる向きの手前（図芯・前回の像は使わない）:
// 共有点 v1 は +y へ延びるので手前 y=3500、共有点 v2 は −y へ延びるので手前の反対＝y=4500。

const imageOf = (sm, p) => applySiteTransform(p, sm.placementView.siteTransform);
const nearPt = (p, x, y, msg) => { assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6, `${msg ?? ''} (${p.x}, ${p.y}) ≠ (${x}, ${y})`); };

/** 2 対目の入力（頂点1＝1 対目の頂点 vertex（1|2）と同じ角・横 Y4000・離れ）を揃える。1 対目が揃っていること（その角のタップが 2 対目の頂点1 になる）。 */
function fillAlong(sm, { vertex = 1, distance = '500' } = {}) {
  sm.pickPlacementVertex(vertex === 1 ? sm.placementInput.v1 : sm.placementInput.v2);
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

test('placementAlongState: 頂点・通り芯・離れがすべて空なら none（側だけの変更は none）・不足は partial・頂点1・通り芯・離れで ready（頂点2 は任意）', async () => {
  const sm = await openPlacement();
  const [a, b, , d] = corners(sm);
  sm.setPlacementCenterLine(gridX0(sm).id);
  assert.equal(sm.placementAlongState, 'none');
  sm.togglePlacementAlongSide();
  assert.equal(sm.placementAlongState, 'none', '側は数えない');
  sm.setPlacementAlongDistanceValue('500');
  assert.equal(sm.placementAlongState, 'partial', '離れだけ');
  sm.setPlacementAlongCenterLine(gridY4000(sm).id);
  assert.equal(sm.placementAlongState, 'partial', '頂点1 なし');
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(b);
  sm.pickPlacementVertex(b); // 2 対目の頂点1
  assert.equal(sm.placementAlongState, 'ready', '頂点2 は空でも ready');
  sm.pickPlacementVertex(d); // 2 対目の頂点2
  assert.equal(sm.placementAlongState, 'ready');
  sm.setPlacementAlongDistanceValue('');
  assert.equal(sm.placementAlongState, 'partial', '離れなし');
  sm.setPlacementAlongCenterLine(gridY4000(sm).id); // 通り芯を解除
  sm.pickPlacementVertex(d); // 2 対目の頂点2 を解除
  sm.pickPlacementVertex(b); // 共有の角→ 1 対目の頂点2 と 2 対目の頂点1 から外れる
  assert.equal(sm.placementAlongState, 'none', '頂点2 だけ残っていても partial だが、全部空なら none');
  sm.pickPlacementVertex(d); // 空いた 1 対目の頂点2 へ（2 対目は空のまま）
  sm.pickPlacementVertex(a); // 1 対目の頂点1 の角: 2 対目の頂点1 へ
  sm.pickPlacementVertex(d); // 1 対目の頂点2 の角: 2 対目の空き（頂点2）へ
  assert.deepEqual(slots(sm), [a, d, a, d]);
  sm.setPlacementAlongCenterLine(gridY4000(sm).id);
  sm.setPlacementAlongCenterLine(gridY4000(sm).id); // 付けて外す（通り芯・離れは空のまま）
  assert.equal(sm.placementAlongState, 'partial', '頂点だけ残っていれば partial');
  sm.dispose();
});

test('placementAlongVertexStates・placementAlongSharedVertex: 頂点1 が 1 対目の頂点1 と一致→shared=1・頂点2 と一致→2・どちらとも一致しなければ unshared（角は存在する）。角が消えたら stale', async () => {
  const project = makeProject();
  const sm = await openPlacement(project);
  const [a, b, c, d] = corners(sm);
  assert.deepEqual(sm.placementAlongVertexStates, { v1: 'none', v2: 'none' });
  assert.equal(sm.placementAlongSharedVertex, null);
  sm.pickPlacementVertex(a);
  sm.pickPlacementVertex(b);
  sm.pickPlacementVertex(a); // 1 対目の頂点1 の角 → 2 対目の頂点1
  assert.equal(sm.placementAlongSharedVertex, 1);
  assert.deepEqual(sm.placementAlongVertexStates, { v1: 'set', v2: 'none' });
  sm.pickPlacementVertex(a); // 共有の角 → 入っている枠すべてから外れる（1 対目の頂点1・2 対目の頂点1）
  sm.pickPlacementVertex(a); // 空いた 1 対目の頂点1 へ
  sm.pickPlacementVertex(b); // 1 対目の頂点2 の角 → 2 対目の頂点1
  assert.equal(sm.placementAlongSharedVertex, 2);
  // 2 対目の頂点1 を 1 対目のどちらとも違う角にする
  sm.pickPlacementVertex(b); // 共有を外す（1 対目の頂点2 も外れる）
  sm.pickPlacementVertex(c); // 空いた 1 対目の頂点2 へ
  sm.pickPlacementVertex(d); // 2 対目の頂点1（1 対目 [a,c] のどちらとも違う）
  assert.deepEqual(slots(sm), [a, c, d, null]);
  assert.equal(sm.placementAlongSharedVertex, null);
  assert.deepEqual(sm.placementAlongVertexStates, { v1: 'unshared', v2: 'none' });
  runInAction(() => { project.site.removeRect(project.site.rects[0].id); });
  assert.deepEqual(sm.placementAlongVertexStates, { v1: 'stale', v2: 'none' }, '角が消えたら unshared でなく stale');
  sm.dispose();
});

test('1 対目の枠が変わっても 2 対目は残り、共有の判定だけが再評価される（頂点1 の一致が 1→2 に移る・どちらとも外れれば unshared）', async () => {
  const sm = await openPlacement();
  const [a, b, c] = corners(sm);
  [a, b].forEach(p => sm.pickPlacementVertex(p));
  sm.pickPlacementVertex(a); // 2 対目の頂点1＝a（共有 1）
  assert.equal(sm.placementAlongSharedVertex, 1);
  runInAction(() => { sm.placementInput = { ...sm.placementInput, v1: b, v2: a }; }); // 1 対目の枠が入れ替わった
  assert.deepEqual(sm.placementInput.along.v1, a, '2 対目は触られない');
  assert.equal(sm.placementAlongSharedVertex, 2, '一致が頂点2 へ移る');
  assert.equal(sm.placementAlongVertexStates.v1, 'set');
  sm.pickPlacementVertex(b); // 1 対目の頂点1 の角で 2 対目に空き → 2 対目の頂点2
  runInAction(() => { sm.placementInput = { ...sm.placementInput, v1: c, v2: b }; });
  assert.equal(sm.placementAlongSharedVertex, null);
  assert.equal(sm.placementAlongVertexStates.v1, 'unshared');
  assert.deepEqual(sm.placementInput.along.v2, b, '2 対目の頂点2 も残る');
  sm.dispose();
});

test('位置のアクション: 通り芯は同じ id で解除・離れは文字列をそのまま持つ。配置図を開いていなければ何もしない', async () => {
  const sm = await openPlacement();
  const id = gridY4000(sm).id;
  sm.setPlacementAlongCenterLine(id);
  assert.equal(sm.placementInput.along.centerLineId, id);
  sm.setPlacementAlongCenterLine(id);
  assert.equal(sm.placementInput.along.centerLineId, null);
  sm.setPlacementAlongDistanceValue('12+3');
  assert.equal(sm.placementInput.along.distanceValue, '12+3');
  sm.dispose();

  const closed = new SiteModeState(makeProject().site);
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

test('commitPlacement: 2 対目あり（頂点1=1 対目の頂点1）→ 保存される along は {v1, v2（無ければ null）, centerLineId, distance（式を評価した数値）, sideFlipped}。共有点の像の y=4000−500、v2 の像の x は 1 段目の拘束どおり', async () => {
  const sm = await openPlacement();
  const [v1, v2] = fillInput(sm, { distance: '1000' });
  nearPt(v1, 10000, 0); nearPt(v2, 13000, 0);
  fillAlong(sm, { vertex: 1, distance: '400+100' });
  assert.equal(sm.placementCanCommit, true);
  assert.deepEqual(sm.commitPlacement(), { ok: true, toast: null });
  assert.deepEqual(sm.site.placement.input.along, { v1, v2: null, centerLineId: gridY4000(sm).id, distance: 500, sideFlipped: false });
  assert.equal(sm.site.placement.rotationDeg, 90);
  nearPt(imageOf(sm, v1), -1000, 3500, '共有点 v1（v2 へ延びる向きの手前 y=Y4000−500）');
  nearPt(imageOf(sm, v2), -1000, 6500, 'v2（x=−1000 の拘束が保たれる）');
  assert.equal(sm.placementInput.along.distanceValue, '500', '保存値から作り直した入力は評価後の文字列');
  sm.dispose();
});

test('commitPlacement: 2 対目あり（頂点1=1 対目の頂点2）→ v2 の像の y=4500・v1 の像の y=1500（R·(v2−v1)=(0,3000) を引く）。保存の頂点1 は 1 対目の頂点2 の座標', async () => {
  const sm = await openPlacement();
  const [v1, v2] = fillInput(sm, { distance: '1000' });
  fillAlong(sm, { vertex: 2, distance: '500' });
  assert.equal(sm.commitPlacement().ok, true);
  assert.deepEqual(sm.site.placement.input.along.v1, v2);
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
  const [a] = fillInput(sm); // 1 段目＝縦 X0
  sm.pickPlacementVertex(a); // 2 対目の頂点1
  const x6000 =sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.VERTICAL && g.value === 6000);
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

test('【失敗系】2 対目の頂点1 が 1 対目の頂点のどちらとも一致しない（unshared）と canCommit=false・commit は TOAST_PLACEMENT_ALONG_UNSHARED で保存しない。頂点2 の有無は問わない', async () => {
  const sm = await openPlacement();
  const [a, b, c] = fillInput(sm).concat(corners(sm)[2]);
  fillAlong(sm, { vertex: 2 });
  assert.equal(sm.placementCanCommit, true, '共有している間は確定できる');
  // 2 対目の頂点1 を 1 対目のどちらとも違う角 c へ付け替える（1 対目を c に変えずに 2 対目だけを動かす）
  sm.pickPlacementVertex(b); // 共有の角 → 1 対目の頂点2・2 対目の頂点1 から外れる
  sm.pickPlacementVertex(c); // 空いた 1 対目の頂点2 へ
  sm.pickPlacementVertex(b); // 1 対目に無い角 → 空き枠（2 対目の頂点1）へ
  assert.deepEqual(slots(sm), [a, c, b, null]);
  assert.equal(sm.placementAlongVertexStates.v1, 'unshared');
  assert.equal(sm.placementCanCommit, false);
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_ALONG_UNSHARED });
  assert.equal(sm.site.placement, null);
  assert.equal(undoManager.peekUndo(), before);
  sm.dispose();
});

test('【失敗系】2 対目の頂点1 が失効（角が消えた）なら canCommit=false・commit は TOAST_PLACEMENT_INCOMPLETE。2 対目が none なら失効扱いにしない', async () => {
  const project = makeProject();
  const sm = await openPlacement(project);
  fillInput(sm);
  assert.equal(sm.placementAlongVertexStates.v1, 'none', '2 対目が none');
  fillAlong(sm, { vertex: 2 });
  assert.equal(sm.placementCanCommit, true);
  runInAction(() => { project.site.removeRect(project.site.rects[0].id); });
  assert.equal(sm.placementAlongVertexStates.v1, 'stale');
  assert.equal(sm.placementCanCommit, false);
  assert.deepEqual(sm.commitPlacement(), { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE });
  sm.dispose();
});

test('頂点2（2 対目）は解に使わない・任意: 空でも確定でき、入れても像は変わらず、保存には入る（座標のコピー）。失効した頂点2 は保存しない', async () => {
  const project = makeProject();
  const sm = await openPlacement(project);
  const [v1] = fillInput(sm, { distance: '1000' });
  fillAlong(sm, { vertex: 1, distance: '500' });
  assert.equal(sm.commitPlacement().ok, true);
  const withoutV2 = sm.site.placement;
  assert.equal(withoutV2.input.along.v2, null);
  const image = imageOf(sm, v1);
  const d = corners(sm)[3];
  sm.pickPlacementVertex(d); // 2 対目の頂点2
  assert.equal(sm.commitPlacement().ok, true);
  assert.deepEqual(sm.site.placement.input.along.v2, d);
  assert.notEqual(sm.site.placement.input.along.v2, sm.placementInput.along.v2, '座標オブジェクトを共有しない');
  nearPt(imageOf(sm, v1), image.x, image.y, '頂点2 の有無で像は変わらない');
  runInAction(() => { sm.placementInput = { ...sm.placementInput, along: { ...sm.placementInput.along, v2: { x: 1, y: 2 } } }; });
  assert.equal(sm.placementAlongVertexStates.v2, 'stale');
  assert.equal(sm.commitPlacement().ok, true, '頂点2 の失効は確定を止めない');
  assert.equal(sm.site.placement.input.along.v2, null, '失効した頂点2 は保存しない');
  sm.dispose();
});

test('実機再現の回帰: 2 対目の角 2 点のタップで 1 対目が変わらない（敷地 13000×15000・1 対目＝左上・左下・X1・2000、2 対目＝左下・右下・Y1・1500 → 回転 0・左下 (−2000,1500)・左上 (−2000,−13500)・右下 (11000,1500)）', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.activePlaneId = 'p1';
  const st = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, st);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 9100, st);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, st);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -12614, st);
  project.site.addRect(0, 0, 13000, 15000); // 左上(0,0)・右上(13000,0)・右下(13000,15000)・左下(0,15000)
  const sm = new SiteModeState(project.site, project);
  await sm.setShowPlacement(true);
  // 建物図芯 (4550,−6307)＝通り芯の外接矩形の中心（屋根は無い）
  assert.deepEqual(sm.placementView.buildingCenter, { x: 4550, y: -6307 });
  const at = (x, y) => corners(sm).find(c => c.x === x && c.y === y);
  const topLeft = at(0, 0), bottomLeft = at(0, 15000), bottomRight = at(13000, 15000);
  const x1 = sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.VERTICAL && g.value === 0);
  const y1 = sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.HORIZONTAL && g.value === 0);
  sm.pickPlacementVertex(topLeft);
  sm.pickPlacementVertex(bottomLeft);
  sm.setPlacementCenterLine(x1.id);
  sm.setPlacementDistanceValue('2000');
  sm.pickPlacementVertex(bottomLeft); // 2 対目の頂点1＝左下（1 対目の頂点2 と共有）
  sm.pickPlacementVertex(bottomRight); // 2 対目の頂点2＝右下。ここで 1 対目が変わってはならない
  assert.deepEqual(slots(sm), [topLeft, bottomLeft, bottomLeft, bottomRight], '1 対目は不変');
  sm.setPlacementAlongCenterLine(y1.id);
  sm.setPlacementAlongDistanceValue('1500');
  assert.equal(sm.placementAlongSharedVertex, 2);
  assert.equal(sm.placementCanCommit, true);
  assert.deepEqual(sm.commitPlacement(), { ok: true, toast: null });
  assert.equal(sm.site.placement.rotationDeg, 0, '90° 回らない');
  nearPt(imageOf(sm, bottomLeft), -2000, 1500, '左下');
  nearPt(imageOf(sm, topLeft), -2000, -13500, '左上');
  nearPt(imageOf(sm, bottomRight), 11000, 1500, '右下');
  assert.deepEqual(sm.site.placement.input.along.v1, bottomLeft);
  assert.deepEqual(sm.site.placement.input.along.v2, bottomRight);
  sm.dispose();
});

test('togglePlacementAlongSide: 配置済みなら即時に再配置（共有点の像 y=3500→4500。undo 1 件）。未配置ならフラグだけ（配置も undo も増えない）', async () => {
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
  nearPt(imageOf(sm, v1), -1000, 3500);
  const first = sm.site.placement;
  assert.deepEqual(sm.togglePlacementAlongSide(), { ok: true, toast: null });
  assert.equal(sm.site.placement.input.along.sideFlipped, true);
  nearPt(imageOf(sm, v1), -1000, 4500, '側反転で B の向こうへ');
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

test('undo/redo との同期: 2 対目あり→解除→undo で 2 対目の入力（頂点・通り芯・離れ・側）も保存値から復元され、離れの NumPad は閉じる', async () => {
  const sm = await openPlacement();
  const [, b] = fillInput(sm);
  fillAlong(sm, { vertex: 2, distance: '500' });
  sm.togglePlacementAlongSide();
  sm.commitPlacement();
  sm.clearPlacement();
  assert.deepEqual(sm.placementInput.along, EMPTY_ALONG);
  sm.setPlacementAlongDistanceFocused(true);
  undoManager.undo();
  assert.deepEqual(sm.placementInput.along, { v1: b, v2: null, centerLineId: gridY4000(sm).id, distanceValue: '500', sideFlipped: true });
  assert.equal(sm.placementAlongDistanceFocused, false);
  sm.dispose();
});

test('init: site.placement.input.along があれば 2 対目の入力を復元する（離れは文字列・座標はコピー）。頂点2 が無い旧データは null のまま。無ければ既定', async () => {
  const project = makeProject();
  const input = {
    v1: { x: 10000, y: 0 }, v2: { x: 13000, y: 0 }, centerLineId: 'cl-1', distance: 1000, rotationFlipped: false, sideFlipped: false,
    along: { v1: { x: 13000, y: 0 }, v2: { x: 13000, y: 2000 }, centerLineId: 'cl-2', distance: 250.5, sideFlipped: true },
  };
  project.site.setPlacement({ rotationDeg: 90, tx: 0, ty: 0, input });
  const sm = new SiteModeState(project.site, project);
  await sm.init();
  assert.deepEqual(sm.placementInput.along, {
    v1: { x: 13000, y: 0 }, v2: { x: 13000, y: 2000 }, centerLineId: 'cl-2', distanceValue: '250.5', sideFlipped: true,
  });
  assert.notEqual(sm.placementInput.along.v1, input.along.v1, '保存値の座標オブジェクトを共有しない');
  sm.dispose();
  project.site.setPlacement({ rotationDeg: 90, tx: 0, ty: 0, input: { ...input, along: { ...input.along, v2: null } } });
  const smLegacy = new SiteModeState(project.site, project);
  await smLegacy.init();
  assert.equal(smLegacy.placementInput.along.v2, null, '旧データの頂点2 は null のまま');
  assert.deepEqual(smLegacy.placementInput.along.v1, { x: 13000, y: 0 });
  smLegacy.dispose();
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

// ---- 通り芯の丸ラベルをタップ（pickPlacementCenterLine）----
// 部屋なし＝外周が判定できないので全部 exterior。外周でない通り芯は placementRoof の写しを差し替えて作る。

const gridX6000 = sm => sm.placementRoof.gridLines.find(g => g.centerLineType === CenterLineType.VERTICAL && g.value === 6000);
const IGNORED = { ok: false, toast: null };
const PICKED = { ok: true, toast: null };
const setExterior = (sm, id, exterior) => runInAction(() => {
  sm.placementRoof = { ...sm.placementRoof, gridLines: sm.placementRoof.gridLines.map(g => (g.id === id ? { ...g, exterior } : g)) };
});

test('pickPlacementCenterLine: 未選択→1 段目 A。同じ軸の別の線は A を置換、A 自身は解除（2 段目には触れない）', async () => {
  const sm = await openPlacement();
  assert.deepEqual(sm.pickPlacementCenterLine(gridX0(sm).id), PICKED);
  assert.equal(sm.placementInput.centerLineId, gridX0(sm).id);
  assert.equal(sm.placementInput.along.centerLineId, null);
  assert.deepEqual(sm.pickPlacementCenterLine(gridX6000(sm).id), PICKED);
  assert.equal(sm.placementInput.centerLineId, gridX6000(sm).id, '同軸は A の置換');
  assert.equal(sm.placementInput.along.centerLineId, null);
  assert.deepEqual(sm.pickPlacementCenterLine(gridX6000(sm).id), PICKED);
  assert.equal(sm.placementInput.centerLineId, null, 'A 自身は解除');
  sm.pickPlacementCenterLine(gridY0(sm).id); // A が空なら横線でも A
  assert.equal(sm.placementInput.centerLineId, gridY0(sm).id);
  sm.dispose();
});

test('pickPlacementCenterLine: A と直交する軸の線は 2 段目 B。B 自身は解除、別の直交線は B の置換（A は不変）', async () => {
  const sm = await openPlacement();
  sm.pickPlacementCenterLine(gridX0(sm).id);
  sm.pickPlacementCenterLine(gridY4000(sm).id);
  assert.equal(sm.placementInput.centerLineId, gridX0(sm).id, 'A は不変');
  assert.equal(sm.placementInput.along.centerLineId, gridY4000(sm).id);
  assert.equal(sm.placementAlongCenterLine, gridY4000(sm));
  sm.pickPlacementCenterLine(gridY0(sm).id);
  assert.equal(sm.placementInput.along.centerLineId, gridY0(sm).id, 'B の置換');
  sm.pickPlacementCenterLine(gridY0(sm).id);
  assert.equal(sm.placementInput.along.centerLineId, null, 'B 自身は解除');
  assert.equal(sm.placementAlongState, 'none', 'B 自身の解除は［位置の解除］と同じで離れも消える');
  assert.equal(sm.placementInput.centerLineId, gridX0(sm).id);
  // A を横線へ付け替えれば、縦線が B の側になる
  sm.pickPlacementCenterLine(gridY0(sm).id); // A と直交＝B…ではなく A が縦なので横は B
  sm.pickPlacementCenterLine(gridX0(sm).id); // A 自身を解除
  sm.pickPlacementCenterLine(gridY4000(sm).id); // A 未選択なので横線が A
  assert.equal(sm.placementInput.centerLineId, gridY4000(sm).id);
  sm.pickPlacementCenterLine(gridX6000(sm).id); // 縦線は B
  assert.equal(sm.placementInput.along.centerLineId, gridX6000(sm).id);
  sm.dispose();
});

test('【失敗系】pickPlacementCenterLine: 外周でない通り芯・写しに無い id・配置図を開いていない（入力 null）・直交する軸が無い A は無視（{ok:false}・入力不変）', async () => {
  const sm = await openPlacement();
  setExterior(sm, gridX6000(sm).id, false);
  const before = sm.placementInput;
  assert.deepEqual(sm.pickPlacementCenterLine(gridX6000(sm).id), IGNORED, '外周でない');
  assert.deepEqual(sm.pickPlacementCenterLine('gone'), IGNORED, '写しに無い');
  assert.equal(sm.placementInput, before, '入力は同じ参照のまま');
  sm.pickPlacementCenterLine(gridX0(sm).id);
  assert.deepEqual(sm.pickPlacementCenterLine(gridX6000(sm).id), IGNORED, 'A がある状態でも外周でなければ置換しない');
  assert.equal(sm.placementInput.centerLineId, gridX0(sm).id);
  runInAction(() => {
    sm.placementRoof = { ...sm.placementRoof, gridLines: [...sm.placementRoof.gridLines, { id: 'radial', centerLineType: CenterLineType.RADIAL, value: 45, label: 'R1', exterior: true }] };
  });
  sm.pickPlacementCenterLine(gridX0(sm).id); // A 解除
  sm.pickPlacementCenterLine('radial'); // 放射が A
  assert.equal(sm.placementInput.centerLineId, 'radial');
  assert.deepEqual(sm.pickPlacementCenterLine(gridX0(sm).id), IGNORED, '放射の A には直交する軸が無い＝B にしない');
  assert.equal(sm.placementInput.along.centerLineId, null);
  sm.dispose();
  const closed = new SiteModeState(makeProject().site);
  assert.deepEqual(closed.pickPlacementCenterLine('x'), IGNORED);
});

test('pickPlacementCenterLine: 配置済みで B の変更は即時再配置（undo 1 件・保存の along が更新）。B 自身のタップは［位置の解除］と同じ（離れも消え、沿い座標を据え置いて再配置）', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  fillAlong(sm); // B=Y4000・離れ 500
  assert.equal(sm.commitPlacement().ok, true);
  const first = sm.site.placement;
  assert.equal(first.input.along.centerLineId, gridY4000(sm).id);
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.pickPlacementCenterLine(gridY0(sm).id), PICKED);
  assert.notEqual(sm.site.placement, first, '再配置された');
  assert.equal(sm.site.placement.input.along.centerLineId, gridY0(sm).id);
  assert.notEqual(undoManager.peekUndo(), before, 'undo が 1 件増える');
  undoManager.undo();
  assert.equal(sm.site.placement, first, '1 件の undo で B の変更前へ戻る');
  // B 自身のタップ＝［位置の解除］: 離れも消えて none、配置済みなので along なし（R6 据え置き）で再配置し undo が 1 件増える
  const placed = sm.site.placement;
  const stackTop = undoManager.peekUndo();
  assert.deepEqual(sm.pickPlacementCenterLine(gridY4000(sm).id), PICKED);
  assert.equal(sm.placementInput.along.centerLineId, null);
  assert.equal(sm.placementAlongState, 'none');
  assert.notEqual(sm.site.placement, placed, '再配置される');
  assert.equal(sm.site.placement.input.along, null, '保存の along は無しになる');
  assert.notEqual(undoManager.peekUndo(), stackTop, 'undo が 1 件増える');
  sm.dispose();
});

test('pickPlacementCenterLine: 配置済みでも 1 段目 A の変更は再配置しない（［配置］で確定。placement は同じ参照・undo 不変）。未配置の B 変更も再配置しない', async () => {
  const sm = await openPlacement();
  fillInput(sm);
  assert.equal(sm.commitPlacement().ok, true);
  const placed = sm.site.placement;
  const before = undoManager.peekUndo();
  assert.deepEqual(sm.pickPlacementCenterLine(gridX6000(sm).id), PICKED);
  assert.equal(sm.placementInput.centerLineId, gridX6000(sm).id);
  assert.equal(sm.site.placement, placed);
  assert.equal(undoManager.peekUndo(), before);
  assert.deepEqual(sm.pickPlacementCenterLine(gridX6000(sm).id), PICKED); // 解除
  assert.equal(sm.placementInput.centerLineId, null);
  assert.equal(sm.site.placement, placed);
  sm.dispose();

  const fresh = await openPlacement();
  fresh.pickPlacementCenterLine(gridX0(fresh).id);
  fresh.pickPlacementCenterLine(gridY4000(fresh).id);
  assert.equal(fresh.site.placement, null, '未配置では配置しない');
  fresh.dispose();
});
