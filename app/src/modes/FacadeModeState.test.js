// FacadeModeState（立面モード。表示専用）。mobx と純モジュール（facade/・elevation/elevationLayout.js）にしか
// 依存しないため node:test から直接 import できる。他階の解決は IDB（floorSwapManager.peek）経由のため、
// テストではその1点だけ差し替える（ElevationModeState.test.js と同じ作法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getObserverTree } from 'mobx';
import { Project, CenterLineType, Discipline, OpeningCategory } from '@core';
import { faceGapLimitMm } from '../elevation/elevationStyle.js';
import { resolveLineWeightsPx } from '../viewport.js';
import { FACADE_OPENING_KIND } from '../facade/facadeStyle.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { FACADE_EMPTY_MESSAGE, FACADE_INIT_ERROR_MESSAGE, FACADE_DIRECTION_ORDER } from '../core/constants.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { eaveTopZMm, resolveTopStoryHeightMm } from '../floorHeights.js';
import { FacadeModeState } from './FacadeModeState.js';

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

/** n 階建て（p1..pn・3000 ピッチ）。withRooms=false なら部屋も壁も無い。 */
function makeProject(n, { activeId = 'p1', withRooms = true } = {}) {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= n; i++) {
    const { graph } = project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`);
    if (withRooms) makeRectRoom(graph, 0, 0, 6000 + i * 1000, 4000, `${i}F`);
  }
  project.activePlaneId = activeId;
  return project;
}

/** peek を差し替えて fn を実行する（finally で戻す）。 */
async function withPeek(peek, fn) {
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = peek;
  try { return await fn(); } finally { floorSwapManager.peek = orig; }
}

test('FacadeModeState.init: 自階は activeGraph・他階は全部 peek して4面（東南西北）を作る。materialError なし', async () => {
  const project = makeProject(3, { activeId: 'p2' });
  const peeked = [];
  await withPeek(async plane => { peeked.push(plane.id); return project.graphMap.get(plane.id); }, async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1200, height: 900 });
    const result = await state.init();
    assert.equal(result.ok, true);
    assert.equal(state.loading, false);
    assert.equal(state.materialError, null);
    assert.deepEqual(peeked.sort(), ['p1', 'p3'], '自階（p2）は peek せず、他の採用階は全部 peek する');
    assert.deepEqual(state.faces.map(f => f.direction), [...FACADE_DIRECTION_ORDER]);
    assert.deepEqual(state.layout.placements.map(p => p.direction), [...FACADE_DIRECTION_ORDER]);
    assert.ok(state.layout.contentHeightMm > 0);
    state.dispose();
  });
});

test('FacadeModeState.init: 自階（1F）より広い 3F の幅が南面の幅に出る（peek した他階の外壁を描いている）', async () => {
  const project = makeProject(3, { activeId: 'p1' });
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1200, height: 900 });
    await state.init();
    const south = state.faces.find(f => f.direction === 'south');
    // 3F の部屋は x 方向に 9000（＋壁厚）。1F だけなら 7000 前後
    assert.ok(south.widthMm > 8500, `南面の幅に 3F（9000）が出る（width=${south.widthMm}）`);
    state.dispose();
  });
});

test('FacadeModeState.init: 屋根の region を解決して渡す（在来木造の最上階の切妻＝南面の高さが軒桁上端より高い・屋根の線がある）', async () => {
  const project = makeProject(2, { activeId: 'p2' });
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE; // 既定（未定）は陸屋根＝屋根なし
  const eaveHeight = eaveTopZMm(project.planes, resolveTopStoryHeightMm(project)) + project.glBelow1FlMm; // GL〜軒桁上端
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1200, height: 900 });
    const result = await state.init();
    assert.equal(result.ok, true);
    const south = state.faces.find(f => f.direction === 'south');
    assert.ok(south.heightMm > eaveHeight + 1, `棟が軒桁上端より上（${south.heightMm} > ${eaveHeight}）`);
    state.dispose();
  });
});

test('【失敗系】FacadeModeState.init: 他階の peek が例外でも reject せず、残りの階で描いて materialError＝初期化失敗', async () => {
  const project = makeProject(2, { activeId: 'p1' });
  await withPeek(async () => { throw new Error('idb boom'); }, async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1200, height: 900 });
    const result = await state.init();
    assert.equal(result.ok, false);
    assert.equal(state.loading, false);
    assert.equal(state.materialError, FACADE_INIT_ERROR_MESSAGE);
    assert.equal(state.faces.length, 4, '自階（p1）の外壁で4面は描く');
    state.dispose();
  });
});

test('【失敗系】FacadeModeState.init: 外壁が1本も無ければ faces は空・materialError＝FACADE_EMPTY_MESSAGE', async () => {
  const project = makeProject(2, { activeId: 'p1', withRooms: false });
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1200, height: 900 });
    const result = await state.init();
    assert.equal(result.ok, false);
    assert.deepEqual(state.faces, []);
    assert.equal(state.materialError, FACADE_EMPTY_MESSAGE);
    assert.equal(state.layout.contentHeightMm, 0);
    state.dispose();
  });
});

test('【失敗系】FacadeModeState.init: project=null でも reject しない（loading=false・materialError 非null）', async () => {
  const state = new FacadeModeState(null, null, { width: 1200, height: 900 });
  const result = await state.init();
  assert.equal(result.ok, false);
  assert.equal(state.loading, false);
  assert.ok(state.materialError);
  state.dispose();
});

test('FacadeModeState: init 中に dispose されたら何も書かない（loading のまま・faces 空）', async () => {
  const project = makeProject(2, { activeId: 'p1' });
  let release;
  const gate = new Promise(r => { release = r; });
  await withPeek(async plane => { await gate; return project.graphMap.get(plane.id); }, async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1200, height: 900 });
    const pending = state.init();
    state.dispose();
    release();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(state.faces, []);
    assert.equal(state.loading, true);
  });
});

test('FacadeModeState: viewSize を変えると倍率が変わり、注記（GL の延長）も新しい倍率で作り直す。dispose 後は作り直さない', async () => {
  const project = makeProject(2, { activeId: 'p1' });
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const state = new FacadeModeState(project.activeGraph, project, { width: 1600, height: 1200 });
    await state.init();
    const scale1 = state.scale;
    const ext1 = -state.faces[0].bounds.minX; // GL の延長（モデル mm）
    state.setViewSize({ width: 400, height: 300 });
    const scale2 = state.scale;
    assert.ok(scale2 < scale1, `小さい画面ほど倍率が小さい（${scale1}→${scale2}）`);
    const ext2 = -state.faces[0].bounds.minX;
    assert.ok(ext2 > ext1, `倍率が下がると実画面一定の延長はモデル mm で長くなる（${ext1}→${ext2}）`);
    const scaleObservers = () => getObserverTree(state, 'scale').observers ?? [];
    assert.ok(scaleObservers().length > 0, '前提: dispose 前は reaction が scale を観測している');
    state.dispose();
    // 解除そのもの（_disposed の早期 return だけでは緑にならない側）
    assert.equal(scaleObservers().length, 0, 'dispose 後は scale の観測者（reaction）が居ない');
    const facesAfterDispose = state.faces;
    state.setViewSize({ width: 1600, height: 1200 });
    assert.equal(state.faces, facesAfterDispose, 'dispose 後は作り直さない');
  });
});

test('FacadeModeState: 建具の姿図の minFaceMm が倍率に追従する（三方枠の内法の竪＝見付 20 と faceGapLimitMm の大きい方）', async () => {
  const project = makeProject(1, { activeId: 'p1' });
  const graph = project.activeGraph;
  const lineAt = (type, value) => graph.centerLines.find(c => c.centerLineType === type && c.value === value);
  const south = lineAt(CenterLineType.HORIZONTAL, 4000), west = lineAt(CenterLineType.VERTICAL, 0);
  assert.ok(south && west, '前提: 部屋の通り芯を引ける');
  // 南の壁（y=4000・外向き +1）の x=1000 を中心に幅 800 の三方枠（見付 20）
  graph.addOpening(south, 1, false, west, 1000, 800, OpeningCategory.FITTING, 'threeSidedFrame', { height: 2000 });
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const state = new FacadeModeState(graph, project, { width: 1600, height: 1200 });
    await state.init();
    // 南面の三方枠の線の X（外の竪 2 本・内法の竪 2 本）から内法の竪の寄り（外の竪からの距離）を読む
    const jambInset = () => {
      const face = state.faces.find(f => f.direction === 'south');
      const prims = face.primitives.filter(p => p.kind === FACADE_OPENING_KIND);
      const xs = [...new Set(prims.flatMap(p => [p.x1, p.x2]))].sort((a, b) => a - b);
      assert.equal(xs.length, 4, `竪の X は 4 つ: ${JSON.stringify(xs)}`);
      assert.ok(Math.abs((xs[1] - xs[0]) - (xs[3] - xs[2])) < 1e-6, '左右の内法の寄りは同じ');
      return xs[1] - xs[0];
    };
    const expectedInset = () => Math.max(20, faceGapLimitMm(state.scale, resolveLineWeightsPx(state.screenPxPerMm), 'thin', 'medium'));
    const inset1 = jambInset();
    assert.ok(Math.abs(inset1 - expectedInset()) < 1e-6, `大きい画面: ${inset1} = ${expectedInset()}`);
    const scale1 = state.scale;
    state.setViewSize({ width: 400, height: 300 });
    assert.ok(state.scale < scale1, '前提: 倍率が下がる');
    const inset2 = jambInset();
    assert.ok(Math.abs(inset2 - expectedInset()) < 1e-6, `小さい画面: ${inset2} = ${expectedInset()}`);
    assert.ok(inset2 > inset1 + 1, `倍率が下がると 1px 保証の内法の寄りは広がる（${inset1}→${inset2}）`);
    state.dispose();
  });
});

test('FacadeModeState.scrollBy: 書き込み時にクランプする（上端 0・下端 contentHeight−画面高さ）', async () => {
  const project = makeProject(2, { activeId: 'p1' });
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    // 横長の画面（倍率が幅で決まらず、縦には4面が収まらない）
    const state = new FacadeModeState(project.activeGraph, project, { width: 1600, height: 500 });
    await state.init();
    const viewHeightMm = 500 / state.scale;
    const maxScroll = Math.max(0, state.layout.contentHeightMm - viewHeightMm);
    assert.ok(maxScroll > 0, '前提: 4面が画面に収まらない');
    state.scrollBy(1000); // 下へドラッグ＝上端より上へは行かない
    assert.equal(state.scrollY, 0);
    state.scrollBy(-1e9);
    assert.equal(state.scrollY, maxScroll);
    state.scrollBy(0);
    assert.equal(state.scrollY, maxScroll);
    state.dispose();
  });
});
