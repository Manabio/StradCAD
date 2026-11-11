// 手動柱のアンカー解決（S2）: manualMemberAdd.js resolveManualColumnAnchors・manualMemberCommit.js commitManualColumnAdd・
// columnEditTarget.js resolveColumnSlot のテスト。在来木造は自動補完（3a）と同じ resolveWoodColumnAnchorCL で
// 柱のアンカー（通り芯／梁芯→中心線）を決める。中心線のまま手動柱を立てると識別キーが食い違い、再計算のたびに
// auto の柱が作られては消える（実測）——その再発を、本番と同じ recomputeStructuralForGraph で固定する。
// fixture は原点から離した座標。柱・graph・CL は循環参照を持つため assert.equal に渡さず id で比べる。
// .jsx/store.js/snap.js は import しない。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType, centerLineKind, columnSlotKey, columnAnchorKey } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { undoManager } from '../undoManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { runInAction } from 'mobx';
import { serializeGraph } from '../graphSnapshot.js';
import { autoFillWallBeamAxes, selfWallSegments, wallBeamSourcesFor, removeOrphanedWallBeamAxesFor } from './wallBeamAxes.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { resolveManualColumnAnchors } from './manualMemberAdd.js';
import { commitManualColumnAdd } from './manualMemberCommit.js';
import { resolveColumnSlot, isColumnSlotOccupied } from './columnEditTarget.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const WX = 3300, WY = 4700; // 交点（縦壁 x=3300・横壁 y=4700）

let originalPeek;
beforeEach(() => {
  originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => null; // 単層。下階・上階の peek は無し
  undoManager._undoStack.splice(0);
  undoManager._redoStack.splice(0);
});
afterEach(() => { floorSwapManager.peek = originalPeek; });

// 縦壁 x=3300・横壁 y=4700（どちらも下地オーナー壁。軸は意匠中心線）が十字に交わる 1 層。通り芯は structGraph。
function build(structure) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = structure;
  const sg = project.structGraph;
  const gx = [1300, 5300].map(v => sg.addCenterLine(V, v, { labeled: true, discipline: Discipline.STRUCT }));
  const gy = [2700, 6700].map(v => sg.addCenterLine(H, v, { labeled: true, discipline: Discipline.STRUCT }));
  const wall = (isVertical, value, a, b) => {
    const axisCL = graph.addCenterLine(isVertical ? V : H, value, { labeled: false, discipline: Discipline.ARCH });
    return graph.addWall(axisCL, 0, isVertical, a, 0, b, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  };
  const vWall = wall(true, WX, gy[0], gy[1]);
  const hWall = wall(false, WY, gx[0], gx[1]);
  return { project, graph, gx, gy, cV: vWall.axisCL, cH: hWall.axisCL };
}
const beamAxes = graph => graph.centerLines.filter(cl => centerLineKind(cl) === 'beam');
const beamAt = (graph, type, value) => beamAxes(graph).find(cl => cl.centerLineType === type && cl.value === value);
// 壁由来の梁芯だけを先に生やす（構造再計算が最初にやること。woodAutoFill.test.js の fillWoodColumns と同じ前提）。
function withBeamAxes(structure) {
  const env = build(structure);
  autoFillWallBeamAxes(env.graph, selfWallSegments(env.graph));
  env.bV = beamAt(env.graph, V, WX);
  env.bH = beamAt(env.graph, H, WY);
  return env;
}
const atCross = graph => graph.columns.filter(c => Math.abs(c.x - WX) < 1 && Math.abs(c.y - WY) < 1);

// ---- resolveManualColumnAnchors ----
test('【アンカー解決】在来木造: 中心線と同座標に梁芯があれば梁芯の組へ解決する', () => {
  const { graph, project, cV, cH, bV, bH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  assert.ok(bV && bH, '前提: 壁由来の梁芯が生える');
  const r = resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: cH });
  assert.equal(r.vCL.id, bV.id);
  assert.equal(r.hCL.id, bH.id);
});

test('【アンカー解決】在来木造: 梁芯が無ければ壁のある中心線のまま（縦横それぞれ）', () => {
  const { graph, project, cV, cH } = build(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(beamAxes(graph).length, 0, '前提: 梁芯なし');
  const r = resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: cH });
  assert.equal(r.vCL.id, cV.id);
  assert.equal(r.hCL.id, cH.id);
});

test('【アンカー解決】在来木造: 通り芯は通り芯のまま・解決できない線（補助線）は渡した線のまま', () => {
  const { graph, project, gx, gy } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  const aux = graph.addCenterLine(V, 4100, { labeled: false, lineType: 'dashed' });
  const g = resolveManualColumnAnchors(graph, project, { vCL: gx[1], hCL: gy[0] });
  assert.equal(g.vCL.id, gx[1].id);
  assert.equal(g.hCL.id, gy[0].id);
  const a = resolveManualColumnAnchors(graph, project, { vCL: aux, hCL: gy[1] });
  assert.equal(a.vCL.id, aux.id, '補助線はアンカー候補に無い＝渡した線のまま');
  assert.equal(a.hCL.id, gy[1].id);
});

test('【アンカー解決】縦は縦・横は横の線で解決する（座標が同じでも向きを取り違えない）', () => {
  const { graph, project, cV, cH, bV, bH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  const r = resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: cH });
  assert.equal(r.vCL.centerLineType, V);
  assert.equal(r.hCL.centerLineType, H);
  // 縦の線だけ梁芯のある座標・横の線は梁芯の無い座標（y=3900 の中心線）: 横は渡した線のまま
  const other = graph.addCenterLine(H, 3900, { labeled: false, discipline: Discipline.ARCH });
  const r2 = resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: other });
  assert.equal(r2.vCL.id, bV.id);
  assert.equal(r2.hCL.id, other.id);
  assert.notEqual(r2.hCL.id, bH.id);
});

test('【アンカー解決】非在来（S造）は同座標に梁芯があっても渡した線のまま', () => {
  const { graph, project, cV, cH } = withBeamAxes('S造');
  assert.ok(beamAt(graph, V, WX), '前提: 同座標に梁芯がある');
  const r = resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: cH });
  assert.equal(r.vCL.id, cV.id);
  assert.equal(r.hCL.id, cH.id);
});

test('【アンカー解決・失敗側】vCL/hCL 欠落は throw', () => {
  const { graph, project, cV } = build(TRADITIONAL_WOOD_STRUCTURE);
  assert.throws(() => resolveManualColumnAnchors(graph, project, { vCL: null, hCL: cV }), /必須/);
  assert.throws(() => resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: undefined }), /必須/);
  assert.throws(() => resolveManualColumnAnchors(graph, project, undefined), /必須/);
});

// ---- commitManualColumnAdd ----
test('【commit】在来木造で中心線の交点へ追加すると梁芯の組で立ち（キー一致）、undo で戻る', () => {
  const { graph, project, cV, cH, bV, bH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  const before = new Set(graph.columns.map(c => c.id));
  const col = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  assert.equal(col.verticalCL.id, bV.id);
  assert.equal(col.horizontalCL.id, bH.id);
  assert.equal(columnAnchorKey(col), columnSlotKey(bV, bH));
  assert.equal(col.dimensionStatus, 'locked');
  undoManager.undo();
  assert.deepEqual([...graph.columns.map(c => c.id)].sort(), [...before].sort(), 'undo で追加前の柱の集合へ戻る');
});

test('【commit】非在来では渡した線のまま立つ', () => {
  const { graph, project, cV, cH } = withBeamAxes('S造');
  const col = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  assert.equal(col.verticalCL.id, cV.id);
  assert.equal(col.horizontalCL.id, cH.id);
});

// ---- 冪等（S2 の核心）: 本番と同じ recomputeStructuralForGraph を 3 回 ----
// 柱の作成（graph.addColumn）・撤去（columnMap.delete）を記録して、各回の「何が作られ何が消えたか」を id で見る。
function instrument(graph) {
  const log = { created: [], removed: [] };
  const add = graph.addColumn.bind(graph);
  graph.addColumn = (...a) => { const c = add(...a); log.created.push(c.id); return c; };
  const del = graph.columnMap.delete.bind(graph.columnMap);
  graph.columnMap.delete = id => { if (graph.columnMap.has(id)) log.removed.push(id); return del(id); };
  return log;
}

test('【冪等】中心線の交点へ手動追加→再計算 3 回で、auto 柱の作成・撤去が起きず手動柱 1 本が id 不変で残る', async () => {
  const { graph, project, cV, cH } = build(TRADITIONAL_WOOD_STRUCTURE);
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE); // 梁芯と壁交点の auto 柱ができる
  assert.ok(beamAt(graph, V, WX) && beamAt(graph, H, WY), '前提: 梁芯ができた');
  assert.equal(atCross(graph).length, 1, '前提: 交点に auto 柱が 1 本ある');
  const log = instrument(graph);
  const manual = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  const total = graph.columns.length;
  const results = [];
  for (let i = 0; i < 3; i++) {
    log.created.length = 0; log.removed.length = 0;
    const r = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
    results.push({ changed: r.changed, created: [...log.created], removed: [...log.removed] });
  }
  // 1 回目だけ、手動柱が来る前からあった auto 柱（同じ位置）が重複として片付く。2・3 回目は何も起きない。
  assert.equal(results[0].created.length, 0, '1 回目: 作成なし');
  assert.equal(results[0].removed.length, 1, '1 回目: 手動柱と重なる auto 柱 1 本だけが片付く');
  for (const i of [1, 2]) {
    assert.deepEqual(results[i].created, [], `${i + 1} 回目: 柱の作成 0`);
    assert.deepEqual(results[i].removed, [], `${i + 1} 回目: 柱の撤去 0`);
    assert.equal(results[i].changed, false, `${i + 1} 回目: 変化なし`);
  }
  const here = atCross(graph);
  assert.deepEqual(here.map(c => c.id), [manual.id], '交点の柱は手動柱 1 本（id 不変）');
  assert.equal(here[0].dimensionStatus, 'locked');
  assert.equal(graph.columns.length, total - 1, '柱の総数は片付いた auto 柱の 1 本分だけ減って安定');

  // 再計算が在来木造の柱の補完経路を実際に通っていた証拠: 別の交点の auto 柱を消すと次の再計算で再生成される。
  const other = graph.columns.find(c => c.dimensionStatus === 'auto' && Math.abs(c.x - WX) < 1 && Math.abs(c.y - 2700) < 1);
  assert.ok(other, '前提: (3300,2700) に auto 柱がある');
  graph.columnMap.delete(other.id);
  log.created.length = 0; log.removed.length = 0;
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(log.created.length, 1, '消した別交点の柱だけが再生成される（補完経路は動いている）');
  assert.deepEqual(atCross(graph).map(c => c.id), [manual.id], 'その間も交点の手動柱は不変');
});

test('【冪等・除外済みの交点へ追加】解決したアンカー（梁芯の組）のキーで除外が解除され、再計算は何も起こさない', async () => {
  const { graph, project, cV, cH } = build(TRADITIONAL_WOOD_STRUCTURE);
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  const bV = beamAt(graph, V, WX), bH = beamAt(graph, H, WY);
  const beamKey = columnSlotKey(bV, bH);
  graph.removeColumn(atCross(graph)[0].id); // 利用者が柱を消した（除外集合へ）
  assert.equal(graph.excludedColumnSlots.has(beamKey), true, '前提: 追加前は梁芯の組のキーが除外されている');
  const manual = commitManualColumnAdd(graph, project, { vCL: cV, hCL: cH });
  assert.equal(graph.excludedColumnSlots.has(beamKey), false, '解決したアンカーのキーで除外が解除された（中心線のままなら残る）');
  const log = instrument(graph);
  for (let i = 0; i < 3; i++) {
    const r = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(r.changed, false);
  }
  assert.deepEqual(log.created, []);
  assert.deepEqual(log.removed, []);
  assert.deepEqual(atCross(graph).map(c => c.id), [manual.id]);
});

// ---- 追加テスト ----
test('【アンカー解決】effectiveValue で解決する（ドラッグ中などで value≠effectiveValue の線）', () => {
  const { graph, project, cV, cH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  runInAction(() => { cV.pendingDelta = 40; }); // 縦中心線の value は 3300・effectiveValue は 3340
  assert.equal(cV.value, WX);
  assert.equal(cV.effectiveValue, WX + 40);
  const bNear = graph.addCenterLine(V, WX + 40, { labeled: false, discipline: Discipline.FUSE }); // effectiveValue の座標にだけある梁芯
  const r = resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: cH });
  assert.equal(r.vCL.id, bNear.id, 'value(3300) 側の梁芯ではなく effectiveValue(3340) の梁芯');
});

test('【アンカー解決】解決は graph を変えない（resolveManualColumnAnchors・resolveColumnSlot の前後でスナップショット同一）', () => {
  const { graph, project, cV, cH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  const before = serializeGraph(graph);
  resolveManualColumnAnchors(graph, project, { vCL: cV, hCL: cH });
  resolveColumnSlot(graph, project, { vCL: cV, hCL: cH, x: WX, y: WY });
  const after = serializeGraph(graph);
  assert.ok(before.length === after.length && before.every((v, i) => v === after[i]), 'graph が変わった');
});

// 壁の軸の中心線を消しても、梁芯の組へ付け替えて立てた手動柱は残る。locked 柱の乗った梁芯を孤児掃除から守る既存の仕組み
// （wallBeamAxes.js isProtectedWallBeamAxis）に依存する——中心線のまま立てていれば、中心線の削除の道連れで柱ごと消える。
test('【中心線削除】在来木造で梁芯の組へ付け替えた手動柱は、壁の軸の中心線を消しても残り、梁芯も撤去されない', () => {
  const run = withColumn => {
    const env = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
    const col = withColumn ? commitManualColumnAdd(env.graph, env.project, { vCL: env.cV, hCL: env.cH }) : null;
    const sourcesBefore = wallBeamSourcesFor(env.graph, env.project, null);
    env.graph.removeCenterLine(env.cV.id); // 本番の中心線削除（centerLineOps.js）と同じ: 削除→孤児の壁由来梁芯の掃除
    const orphaned = removeOrphanedWallBeamAxesFor(env.graph, env.project, null, sourcesBefore);
    const stillSource = wallBeamSourcesFor(env.graph, env.project, null).some(s => s.isVertical && Math.abs(s.coord - WX) < 1);
    return { ...env, col, orphaned, stillSource };
  };
  const control = run(false);
  assert.equal(control.stillSource, false, '前提: 縦壁の壁源は消えた');
  assert.ok(control.orphaned.some(c => c.id === control.bV.id), '前提（対照）: 柱が無ければ梁芯は孤児として撤去される');
  const r = run(true);
  assert.equal(r.graph.columnMap.has(r.col.id), true, '手動柱が残る');
  assert.equal(r.col.verticalCL.id, r.bV.id);
  assert.equal(r.orphaned.some(c => c.id === r.bV.id), false, '柱が参照する梁芯は撤去されない');
  assert.equal(r.graph.shapeMap.has(r.bV.id), true);
});

// ---- resolveColumnSlot ----
test('【占有・解決後】中心線で引いた交点に梁芯キーの既存柱があれば、矩形から外れていても occupied（キー一致）', () => {
  const { graph, project, cV, cH, bV, bH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  const ex = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', bV, bH, { eccentricity: { x: 500, y: 0 } });
  assert.equal(ex.x, WX + 500, '前提: 偏芯で矩形が交点 x=3300 を含まない（矩形判定では空き）');
  assert.equal(isColumnSlotOccupied(graph, { vCL: cV, hCL: cH, x: WX, y: WY }), false, '解決前の線（中心線ペア）ではキーが合わず空き');
  const r = resolveColumnSlot(graph, project, { vCL: cV, hCL: cH, x: WX, y: WY });
  assert.equal(r.occupied, true);
  assert.equal(r.vCL.id, bV.id);
  assert.equal(r.hCL.id, bH.id);
  assert.equal(r.x, WX);
  assert.equal(r.y, WY);
});

test('【占有・解決後】空きの交点は occupied 偽・戻り値は解決後の線と入力の x,y', () => {
  const { graph, project, cV, cH, bV, bH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(graph.columns.length, 0, '前提: 柱なし');
  const r = resolveColumnSlot(graph, project, { vCL: cV, hCL: cH, x: WX + 0.2, y: WY - 0.2 });
  assert.equal(r.occupied, false);
  assert.equal(r.vCL.id, bV.id);
  assert.equal(r.hCL.id, bH.id);
  assert.equal(r.x, WX + 0.2, 'x は入力のまま（解決した線の値に置き換えない）');
  assert.equal(r.y, WY - 0.2);
});

test('【占有・解決後】非在来は渡した線のまま判定する', () => {
  const { graph, project, cV, cH } = withBeamAxes('S造');
  const ex = graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-H200x200', cV, cH, { eccentricity: { x: 500, y: 0 } });
  assert.equal(ex.x, WX + 500);
  const r = resolveColumnSlot(graph, project, { vCL: cV, hCL: cH, x: WX, y: WY });
  assert.equal(r.occupied, true, '同じ線ペアのキー一致');
  assert.equal(r.vCL.id, cV.id);
});

test('【占有・解決後・失敗側】vCL/hCL 欠落・x/y 非有限は throw', () => {
  const { graph, project, cV, cH } = withBeamAxes(TRADITIONAL_WOOD_STRUCTURE);
  assert.throws(() => resolveColumnSlot(graph, project, { vCL: null, hCL: cH, x: WX, y: WY }), /必須/);
  assert.throws(() => resolveColumnSlot(graph, project, { vCL: cV, hCL: undefined, x: WX, y: WY }), /必須/);
  assert.throws(() => resolveColumnSlot(graph, project, { vCL: cV, hCL: cH, x: NaN, y: WY }), /有限/);
  assert.throws(() => resolveColumnSlot(graph, project, { vCL: cV, hCL: cH, x: WX, y: Infinity }), /有限/);
  assert.throws(() => resolveColumnSlot(graph, project, undefined), /必須/);
});
