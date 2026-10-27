// slabSecondaryBeamAxes.js（S造スラブ小梁の梁芯の割付け。ユーザー指示2026-10-26）の単体テスト。
// フィクスチャは woodAutoFill.test.js の buildClosedCellGraph の主構造差し替え版（4辺を primary 梁で囲んだ1ベイ）。
// 座標系は実データに合わせ y 下向き正・ベイは y:[-height,0]。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomFeature, centerLineKind as centerLineKindOf } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SlabBayFillSkip, STEEL_SECONDARY_BEAM_MAX_PITCH_MM, CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { reconcileSlabSecondaryBeamAxes, slabBeamSlotKeyFor, planSlabSecondaryBeamAxes, slabBeamSlotKey, parseSlabBeamSlotKey, nearUserSlabAxisIds } from './slabSecondaryBeamAxes.js';
import { addCenterLineFromDialog } from '../transform/centerLineOps.js';
import { initialRef, foldRefForConfirm } from '../ui/addCLDialogRefs.js';
import { exclusionKeyReferencesCL } from '../core/structuralEntities.js';
import { autoFillSecondaryBeams } from './structuralAutoFill.js';
import { rulesFor } from './structureRules.js';
import { wallBeamAxisExcludeKey } from './wallBeamAxes.js';

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' }, memberGroupLedger: new Map() };
const MAX = STEEL_SECONDARY_BEAM_MAX_PITCH_MM;

// 幅 width × 高さ height のベイを4辺 primary 梁で囲む。topRole で上辺（y=-height）の役割を変えられる。
function buildBay(structure, { width = 5000, height = 7000, topRole = 'primary', bottomRole = 'primary' } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const rules = rulesFor(structure);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,      { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, width,  { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -height, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,       { labeled: true, discipline: Discipline.STRUCT });
  const add = (cl, isV, a, b, role) => graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, a, b, { role });
  const top = add(y0, false, x0, x1, topRole);
  const bottom = add(y1, false, x0, x1, bottomRole);
  const left = add(x0, true, y0, y1, 'primary');
  const right = add(x1, true, y0, y1, 'primary');
  return { graph, x0, x1, y0, y1, top, bottom, left, right };
}

const axesOf = (created) => created.slice().sort((a, b) => a.value - b.value);

// 開口セル矩形（openingCellRects の1件と同じ形）。
const rectOpening = (x1, x2, y1, y2) => ({ x1, x2, y1, y2, source: 'void' });

test('5000×7000のベイ: 短辺方向（横梁）の梁芯が y=-4666.67・-2333.33 の2本。端の通り芯を extent に参照し由来は slabBeam。座標は丸めない', () => {
  const { graph, x0, x1 } = buildBay('S造');
  const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.deepEqual(skipped, []);
  const axes = axesOf(created);
  assert.equal(axes.length, 2);
  assert.deepEqual(axes.map(a => a.value), [-7000 + 7000 / 3, -7000 + 2 * (7000 / 3)], '丸めない（等分の式どおり）');
  assert.ok(Math.abs(axes[0].value - -4666.67) < 0.01 && Math.abs(axes[1].value - -2333.33) < 0.01);
  for (const a of axes) {
    assert.equal(a.centerLineType, CenterLineType.HORIZONTAL);
    assert.equal(a.labeled, false);
    assert.equal(a.discipline, Discipline.FUSE);
    assert.equal(centerLineKindOf(a), 'beam');
    assert.equal(a.beamAxisOrigin, BeamAxisOrigin.SLAB_BEAM);
    assert.equal(a.refId ?? null, null, 'refId は持たせない');
    assert.deepEqual([a.extentLoRef.clId, a.extentHiRef.clId], [x0.id, x1.id], 'extent は端の通り芯への参照');
    assert.deepEqual([a.extentLo, a.extentHi], [0, 5000], '解決後の extent は端の通り芯の位置');
  }
  // 既存の小梁生成が梁芯から子梁を作る（大梁面までの端部クリアランスは小梁生成側の規則）。
  const children = autoFillSecondaryBeams(graph, PROJECT).created;
  assert.equal(children.length, 2);
  assert.ok(children.every(b => b.role === 'secondary' && b.isVertical === false));
});

test('正方形のベイは横梁（材軸＝X）: 5000×5000 → 横梁の梁芯1本 y=-2500', () => {
  const { graph } = buildBay('S造', { width: 5000, height: 5000 });
  const { created } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].centerLineType, CenterLineType.HORIZONTAL);
  assert.equal(created[0].value, -2500);
});

test('幅が長辺のベイは縦梁: 7000×5000 → x=2333.33/4666.67 の縦梁芯2本（端は横の通り芯）', () => {
  const { graph, y0, y1 } = buildBay('S造', { width: 7000, height: 5000 });
  const { created } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  const axes = axesOf(created);
  assert.equal(axes.length, 2);
  assert.ok(axes.every(a => a.centerLineType === CenterLineType.VERTICAL));
  assert.deepEqual([axes[0].extentLoRef.clId, axes[0].extentHiRef.clId], [y0.id, y1.id]);
});

test('3595角のベイは1本（ceil(3595/2500)=2等分）', () => {
  const { graph } = buildBay('S造', { width: 3595, height: 3595 });
  const { created } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].value, -3595 + 3595 / 2);
});

test('【失敗系】短辺がちょうど2500のベイは作らず SHORT_SPAN、2501は作る', () => {
  const at = buildBay('S造', { width: MAX, height: 7000 });
  const r1 = reconcileSlabSecondaryBeamAxes(at.graph, PROJECT);
  assert.equal(r1.created.length, 0);
  assert.deepEqual(r1.skipped.map(s => s.reason), [SlabBayFillSkip.SHORT_SPAN]);
  const over = buildBay('S造', { width: MAX + 1, height: 7000 });
  const r2 = reconcileSlabSecondaryBeamAxes(over.graph, PROJECT);
  assert.ok(r2.created.length > 0, '2501 は作る');
  assert.deepEqual(r2.skipped, []);
});

test('【失敗系】辺が1本欠けるとベイにならず何も作らない（大梁を1本抜く）', () => {
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const b = buildBay('S造');
    b.graph.beamMap.delete(b[side].id);
    const { created, skipped } = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
    assert.equal(created.length, 0, `${side} 欠け`);
    assert.deepEqual(skipped, [], `${side} 欠け: ベイが無いので報告もしない`);
  }
});

test('【失敗系】開口と面積で重なるベイは OPENING（開口の中心がベイの外でも）。辺で接するだけなら割り付ける', () => {
  // ベイ x:[0,5000] y:[-7000,0]。開口 x:[4000,6000] y:[-6500,-5500] は中心 (5000,-6000) がベイの辺上＝内部ではないが1000×1000で重なる。
  const overlap = buildBay('S造');
  const r1 = reconcileSlabSecondaryBeamAxes(overlap.graph, PROJECT, [rectOpening(4000, 6000, -6500, -5500)]);
  assert.equal(r1.created.length, 0);
  assert.equal(r1.created.length, 0);
  assert.deepEqual(r1.skipped.map(s => s.reason), [SlabBayFillSkip.OPENING]);
  // x:[5000,6000] はベイの右辺に接するだけ。
  const touch = buildBay('S造');
  const r2 = reconcileSlabSecondaryBeamAxes(touch.graph, PROJECT, [rectOpening(5000, 6000, -6500, -5500)]);
  assert.equal(r2.created.length, 2);
});

test('【失敗系】端が踊り場受け梁（LG）のベイは NO_HOST で作らない', () => {
  // 7000×5000 は縦梁（y方向に走る）で、上辺（y=-5000）が子梁の端になる。
  const { graph } = buildBay('S造', { width: 7000, height: 5000, topRole: 'landing' });
  const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.NO_HOST]);
});

test('【失敗系】hi 端（下辺 y=0）が踊り場受け梁（LG）のベイも NO_HOST で作らない', () => {
  const { graph } = buildBay('S造', { width: 7000, height: 5000, bottomRole: 'landing' });
  const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.NO_HOST]);
});

test('【失敗系】端の通り芯が無い（端が通り芯でない梁芯）ベイは NO_HOST', () => {
  const { graph, y0 } = buildBay('S造', { width: 7000, height: 5000 });
  // 子梁の端（上辺）の通り芯を通り芯でなくす（labeled:false の梁芯相当）。大梁は残るので境界にはなる。
  runInAction(() => { y0.labeled = false; });
  const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.NO_HOST]);
});

test('同方向の通り芯と同座標の位置は作らない', () => {
  const { graph } = buildBay('S造');
  const yy = -7000 + 7000 / 3;
  graph.addCenterLine(CenterLineType.HORIZONTAL, yy, { labeled: true, discipline: Discipline.STRUCT });
  const { created } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].value, -7000 + 2 * (7000 / 3));
});

test('除外集合（手動削除済み）の座標は作らない', () => {
  const { graph } = buildBay('S造');
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, -7000 + 7000 / 3));
  const { created } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].value, -7000 + 2 * (7000 / 3));
});

test('【失敗系】ベイ内にユーザーの梁芯があれば丸ごと作らない（OCCUPIED）。直交する梁芯でも同じ', () => {
  for (const [type, value] of [[CenterLineType.HORIZONTAL, -3000], [CenterLineType.VERTICAL, 1000]]) {
    const { graph } = buildBay('S造');
    graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.FUSE, extentLo: -7000, extentHi: 5000, beamAxisOrigin: BeamAxisOrigin.USER });
    const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
    assert.equal(created.length, 0, `${type} の USER 梁芯`);
    assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.OCCUPIED]);
  }
});

test('ベイと extent が重ならないユーザーの梁芯は邪魔しない（extent 付きは区間で判定）', () => {
  const { graph } = buildBay('S造');
  // x=1000 の縦梁芯だが extent が y:[-9000,-8000]（ベイの外）。
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: -9000, extentHi: -8000, beamAxisOrigin: BeamAxisOrigin.USER });
  const { created } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 2);
});

test('冪等: 2回目は何も変えない（自分の梁芯があるベイは管理中——作らず・張り直さず・撤去せず・正規化せず）', () => {
  const { graph } = buildBay('S造');
  assert.equal(reconcileSlabSecondaryBeamAxes(graph, PROJECT).created.length, 2);
  const again = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.deepEqual(
    [again.created, again.revalued, again.removed, again.normalized, again.skipped].map(a => a.length), [0, 0, 0, 0, 0]);
});

// 人が消したものが再計算で復活しない（team-lessons: 広い領域で梁芯を作る規則は削除→再計算を複数パス回して確かめる）。
function recomputePasses(graph, n = 3) {
  const made = [];
  for (let i = 0; i < n; i++) {
    made.push(...reconcileSlabSecondaryBeamAxes(graph, PROJECT).created, ...autoFillSecondaryBeams(graph, PROJECT).created);
  }
  return made;
}

test('梁芯を1本削除（除外集合へ記録）→再計算×3パスで復活しない。残りの梁芯・子梁は保たれる', () => {
  const { graph } = buildBay('S造');
  recomputePasses(graph, 1);
  const [first, second] = axesOf(graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM));
  // centerLineOps.js の梁芯削除と同じ手順（除外集合へ記録→removeCenterLine。子梁は道連れ）。
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, first.effectiveValue));
  graph.removeCenterLine(first.id);
  assert.equal(recomputePasses(graph, 3).length, 0, '3パスとも何も作らない');
  const left = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM);
  assert.deepEqual(left.map(cl => cl.id), [second.id]);
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, 1);
});

test('梁芯を両方削除しても除外集合があれば復活しない', () => {
  const { graph } = buildBay('S造');
  recomputePasses(graph, 1);
  for (const a of graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM)) {
    graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, a.effectiveValue));
    graph.removeCenterLine(a.id);
  }
  assert.equal(recomputePasses(graph, 3).length, 0);
});

test('子梁だけ削除（梁芯は残す）→再計算×3パスで梁も梁芯も復活しない', () => {
  const { graph } = buildBay('S造');
  recomputePasses(graph, 1);
  const axisIds = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM).map(cl => cl.id);
  const victim = graph.beams.find(b => b.role === 'secondary');
  graph.removeBeam(victim.id);
  assert.equal(recomputePasses(graph, 3).length, 0);
  // 子梁を消した梁芯は「手を加えた」ので由来が USER へ替わるだけで、梁芯自体は残る（撤去 0）。
  const beamAxes = graph.centerLines.filter(cl => cl.discipline === Discipline.FUSE);
  assert.deepEqual(beamAxes.map(cl => cl.id).sort(), [...axisIds].sort());
  assert.deepEqual(beamAxes.map(cl => cl.beamAxisOrigin).sort(), [BeamAxisOrigin.SLAB_BEAM, BeamAxisOrigin.USER]);
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, 1);
});

test('対象外の主構造は0本: SRC造・未定・在来木造・RC造(ラーメン/壁式)・2x4', () => {
  for (const structure of ['SRC造', '未定', '木造（在来）', 'RC造(ラーメン)', 'RC造(壁式)', '木造（2"×4"）']) {
    const { graph } = buildBay(structure);
    const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
    assert.equal(created.length, 0, structure);
    assert.deepEqual(skipped, [], structure);
  }
});

// 5000×20000 のベイの y=-8000 に、指定の由来の梁芯と小梁（x0〜x1）を通す。
function buildBayWithMidBeam(origin) {
  const b = buildBay('S造', { width: 5000, height: 20000 });
  const rules = rulesFor('S造');
  const axis = b.graph.addCenterLine(CenterLineType.HORIZONTAL, -8000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: origin,
    extentLoRef: { clId: b.x0.id, offset: 0 }, extentHiRef: { clId: b.x1.id, offset: 0 },
  });
  b.graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, axis, false, b.x0, b.x1, { role: 'secondary' });
  return b;
}

test('開口辺の小梁（由来 OPENING）はベイの境界になり、上下の2ベイを別々に割り付ける', () => {
  const { graph } = buildBayWithMidBeam(BeamAxisOrigin.OPENING);
  const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.deepEqual(skipped, []);
  // 下 y:[-8000,0] は ceil(8000/2500)=4 等分で3本、上 y:[-20000,-8000] は ceil(12000/2500)=5 等分で4本。
  assert.equal(created.length, 7);
  assert.ok(created.every(a => a.value !== -8000));
});

test('【失敗系】USER 由来の梁芯に乗る小梁は境界にしない（ベイは割れず、その梁芯がベイ内にあり OCCUPIED）', () => {
  const { graph } = buildBayWithMidBeam(BeamAxisOrigin.USER);
  const { created, skipped } = reconcileSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.OCCUPIED]);
});

// ---- planSlabSecondaryBeamAxes（純関数）の総当り ----
function rectLines(x1, x2, y1, y2) {
  return [
    { isVertical: true, coord: x1, lo: y1, hi: y2 }, { isVertical: true, coord: x2, lo: y1, hi: y2 },
    { isVertical: false, coord: y1, lo: x1, hi: x2 }, { isVertical: false, coord: y2, lo: x1, hi: x2 },
  ];
}

test('planSlabSecondaryBeamAxes: 寸法×開口位置の総当り（短辺≤2500・開口の面積重なり・向き・本数）', () => {
  const sizes = [2400, MAX, MAX + 1, 3595, 5000, 7000, 7500];
  // 開口: なし／遠い／右辺に接するだけ／右辺をまたぐ／ベイ内に収まる
  const openings = (w, h) => [
    [[], false],
    [[{ x1: w + 1000, x2: w + 2000, y1: 0, y2: h }], false],
    [[{ x1: w, x2: w + 1000, y1: 0, y2: h }], false],
    [[{ x1: w - 500, x2: w + 500, y1: 100, y2: 600 }], true],
    [[{ x1: 100, x2: 600, y1: 100, y2: 600 }], true],
  ];
  for (const w of sizes) for (const h of sizes) {
    for (const [rects, overlaps] of openings(w, h)) {
      const [r] = planSlabSecondaryBeamAxes(rectLines(0, w, 0, h), rects, MAX);
      const label = `${w}x${h} 開口${JSON.stringify(rects)}`;
      assert.deepEqual(r.cell, { x1: 0, y1: 0, x2: w, y2: h }, label);
      if (overlaps) { assert.equal(r.skip, SlabBayFillSkip.OPENING, label); continue; }
      if (Math.min(w, h) <= MAX) { assert.equal(r.skip, SlabBayFillSkip.SHORT_SPAN, label); continue; }
      assert.equal(r.skip, undefined, label);
      assert.equal(r.isVertical, h < w, label);
      const long = h < w ? w : h;
      assert.equal(r.coords.length, Math.ceil(long / MAX) - 1, label);
      assert.deepEqual([r.shortLo, r.shortHi], h < w ? [0, h] : [0, w], label);
      r.coords.forEach((c, i) => assert.equal(c, (i + 1) * (long / Math.ceil(long / MAX)), label));
    }
  }
});

test('【失敗系】planSlabSecondaryBeamAxes: 境界の欠け（4辺のどれか1本）・空入力ではベイが出ない', () => {
  const all = rectLines(0, 5000, 0, 7000);
  for (let i = 0; i < all.length; i++) {
    assert.deepEqual(planSlabSecondaryBeamAxes(all.filter((_, j) => j !== i), [], MAX), [], `辺${i}欠け`);
  }
  assert.deepEqual(planSlabSecondaryBeamAxes([], [], MAX), []);
});

// ---- 本番の再計算（recomputeStructuralForGraph）経由: 開口セル矩形が配線されること ----
// 1階・2階の S造。2階に通り芯 X:0,6000 / Y:0,6000,12000 と補助の分割線（x=3000,y=3000）を引き、voidCells のセルを吹抜けにする。
async function recomputeS2F(voidCellsOf) {
  const project = new Project('proj-slab', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = 'S造';
  g1.structureOverride = 'S造';
  g2.structureOverride = 'S造';
  const struct = { labeled: true, discipline: Discipline.STRUCT }, arch = { labeled: false, discipline: Discipline.ARCH };
  for (const g of [g1, g2]) {
    for (const x of [0, 6000]) g.addCenterLine(CenterLineType.VERTICAL, x, struct);
    for (const y of [0, 6000, 12000]) g.addCenterLine(CenterLineType.HORIZONTAL, y, struct);
  }
  g2.addCenterLine(CenterLineType.VERTICAL, 3000, arch);
  g2.addCenterLine(CenterLineType.HORIZONTAL, 3000, arch);
  const cells = getAllCells(g2);
  const keyOf = ([x1, y1, x2, y2]) => cells.find(c => c.x1 === x1 && c.y1 === y1 && c.x2 === x2 && c.y2 === y2).key;
  g2.addRoom(new Set(voidCellsOf.map(keyOf))).setFeature(RoomFeature.VOID);
  // 建物フットプリント（自階の部屋と直下階の部屋）で部材を取捨するゲートを通すため、吹抜け以外のセルを1部屋にし、
  // 1階は全体を1部屋にする。
  const voidKeys = new Set(voidCellsOf.map(keyOf));
  g2.addRoom(new Set(cells.map(c => c.key).filter(k => !voidKeys.has(k))));
  g1.addRoom(new Set(getAllCells(g1).map(c => c.key)));
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => ({ p1: g1, p2: g2 })[plane.id] ?? null;
  try {
    for (let i = 0; i < 3; i++) await recomputeStructuralForGraph(g2, project, 'S造');
  } finally { floorSwapManager.peek = original; }
  return g2;
}
const slabBeamAxisYs =(g) => g.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM)
  .map(cl => cl.value).sort((a, b) => a - b);

test('【失敗系・配線】recomputeStructuralForGraph: S造の矩形の吹抜けと重なるベイには梁芯を作らず、隣のベイには作る', async () => {
  // 吹抜け＝上半分 x:[0,6000] y:[0,6000]（2×2セル）。下のベイ y:[6000,12000]（6000角）は y=8000,10000 の2本。
  const g2 = await recomputeS2F([[0, 0, 3000, 3000], [3000, 0, 6000, 3000], [0, 3000, 3000, 6000], [3000, 3000, 6000, 6000]]);
  assert.deepEqual(slabBeamAxisYs(g2), [8000, 10000]);
});

test('【失敗系・配線】L字（非矩形）の吹抜けと重なるベイは OPENING: 梁芯・子梁を作らず、接しない隣のベイには作る', async () => {
  // 吹抜け＝L字（上半分の4セルのうち右下を除く3セル）。吹抜けは非矩形のため開口辺の矩形成分（openingEdgeComponents）には
  // 入らないが、開口セル矩形には入る。上半分のベイ（6000角）は L字と面積で重なるので割り付けない。
  const g2 = await recomputeS2F([[0, 0, 3000, 3000], [3000, 0, 6000, 3000], [0, 3000, 3000, 6000]]);
  assert.deepEqual(slabBeamAxisYs(g2), [8000, 10000], '上半分（L字と重なる）には無く、下のベイにだけある');
  assert.equal(g2.beams.filter(b => b.role === 'secondary').length, 2, '子梁も下のベイの2本だけ');
});

// ---- S2a: スラブ小梁の枠キー（PlanGraph.excludedSlabBeamSlots の要素） ----
const SLOT = { x1Id: 'xa', x2Id: 'xb', y1Id: 'ya', y2Id: 'yb', dir: CenterLineType.VERTICAL, n: 3, i: 2 };

test('【S2a】slabBeamSlotKey は slab:<4辺>:<向き>:<n>:<i> の形で、parse で元の枠に戻る（X・Y とも）', () => {
  assert.equal(slabBeamSlotKey(SLOT), 'slab:xa:xb:ya:yb:X:3:2');
  assert.deepEqual(parseSlabBeamSlotKey(slabBeamSlotKey(SLOT)), SLOT);
  const h = { ...SLOT, dir: CenterLineType.HORIZONTAL, n: 4, i: 3 };
  assert.deepEqual(parseSlabBeamSlotKey(slabBeamSlotKey(h)), h);
});

test('【S2a・失敗系】parseSlabBeamSlotKey は壊れたキー・別名前空間・数値でない n/i・範囲外・欠け・余分な項を null にする', () => {
  const bad = [
    '', 'slab', 'slab:xa:xb:ya:yb:X:3',                 // 項が欠ける
    'slab:xa:xb:ya:yb:X:3:2:9',                          // 余分な項
    'wall:xa:xb:ya:yb:X:3:2', 'X:1000',                  // 別名前空間・座標キー
    'slab::xb:ya:yb:X:3:2',                              // 空の id
    'slab:xa:xb:ya:yb:R:3:2', 'slab:xa:xb:ya:yb:x:3:2',  // 向きが X/Y 以外
    'slab:xa:xb:ya:yb:X:n:2', 'slab:xa:xb:ya:yb:X:3:i',  // 数値でない
    'slab:xa:xb:ya:yb:X:3.5:2', 'slab:xa:xb:ya:yb:X:3:1.5',
    'slab:xa:xb:ya:yb:X:03:2',                           // 非正規表記
    'slab:xa:xb:ya:yb:X:1:1',                            // n<2（内部の枠が無い）
    'slab:xa:xb:ya:yb:X:3:0', 'slab:xa:xb:ya:yb:X:3:3',  // i が 1..n-1 の外
  ];
  for (const k of bad) assert.equal(parseSlabBeamSlotKey(k), null, `null のはず: "${k}"`);
  for (const k of [undefined, null, 5, {}]) assert.equal(parseSlabBeamSlotKey(k), null);
});

test('【S2a】exclusionKeyReferencesCL は枠キーの4辺いずれのCL id も拾い、無関係な id は拾わない', () => {
  const key = slabBeamSlotKey(SLOT);
  for (const id of ['xa', 'xb', 'ya', 'yb']) assert.equal(exclusionKeyReferencesCL(key, id), true, id);
  assert.equal(exclusionKeyReferencesCL(key, 'xc'), false);
});

// ---- S2b: 割り直し（reconcileSlabSecondaryBeamAxes） ----
const fuseAxes = g => g.centerLines.filter(cl => cl.discipline === Discipline.FUSE).sort((a, b) => a.value - b.value);
const bayIds = b => ({ x1Id: b.x0.id, x2Id: b.x1.id, y1Id: b.y0.id, y2Id: b.y1.id });
// 1パス＝割り直し＋子梁の生成（structuralAutoFill.js と同じ順）。パスごとの変更の総数を返す。
function settle(graph, passes = 3, openingRects = undefined) {
  return Array.from({ length: passes }, () => {
    const r = reconcileSlabSecondaryBeamAxes(graph, PROJECT, openingRects);
    const kids = autoFillSecondaryBeams(graph, PROJECT).created;
    return r.created.length + r.revalued.length + r.removed.length + r.normalized.length + kids.length;
  });
}
const secondaries = g => g.beams.filter(b => b.role === 'secondary');
const pitchesOf = (values, lo, hi) => [lo, ...values, hi].map((v, i, a) => v - a[i - 1]).slice(1);

test('【S2b】通り芯を動かす（y −7000→−10000）: 同じ id の2本を張り直し1本を新規、ピッチ≤2500。戻すと元の座標・元の id に戻る', () => {
  const b = buildBay('S造');
  assert.deepEqual(settle(b.graph, 1), [4]);
  const [a, c] = fuseAxes(b.graph);
  const before = [a.value, c.value];
  b.y0.value = -10000;
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual([r.revalued.map(x => x.id), r.created.length, r.removed.length, r.normalized.length], [[a.id, c.id], 1, 0, 0]);
  autoFillSecondaryBeams(b.graph, PROJECT);
  const vs = fuseAxes(b.graph).map(x => x.value);
  assert.equal(vs.length, 3);
  assert.ok(pitchesOf(vs, -10000, 0).every(p => p <= MAX + 1e-9), `ピッチ ${pitchesOf(vs, -10000, 0)}`);
  assert.equal(secondaries(b.graph).length, 3, '子梁も3本');
  // 戻す（undo 後の再同期）: 決定的に元の座標・元の id へ。-7500 に出ていた a がベイ (−7000,0) の外でも、所属は
  // 端の通り芯で決まるので a のまま張り直され、移動時に増えた1本だけが撤去される。
  b.y0.value = -7000;
  const back = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.equal(back.removed.length, 1);
  assert.deepEqual(fuseAxes(b.graph).map(x => [x.id, x.value]), [[a.id, before[0]], [c.id, before[1]]], '元の id・座標に戻る');
  assert.deepEqual(settle(b.graph, 3), [0, 0, 0], '収束');
});

test('【S2b】子梁の id は張り直しで保たれる（番号グループ・除外キーが生き残る）', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const kidIds = secondaries(b.graph).map(k => k.id).sort();
  b.y0.value = -10000;
  settle(b.graph, 3);
  const after = secondaries(b.graph).map(k => k.id);
  for (const id of kidIds) assert.ok(after.includes(id), `子梁 ${id} が残る`);
});

test('【S2b・失敗系】通り芯を動かして短辺が2500以下になると、梁芯も子梁も撤去する（SHORT_SPAN）', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  b.y0.value = -2400; // 5000×2400
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.equal(r.removed.length, 2);
  assert.deepEqual(r.skipped.map(s => s.reason), [SlabBayFillSkip.SHORT_SPAN]);
  assert.equal(fuseAxes(b.graph).length, 0);
  assert.equal(secondaries(b.graph).length, 0, '子梁は梁芯の撤去で道連れ');
});

test('【S2b】ベイが分割される（大梁が増える）: 孤児の梁芯を撤去し、新しい2ベイを割り付ける', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const oldIds = fuseAxes(b.graph).map(x => x.id);
  const rules = rulesFor('S造');
  const ym = b.graph.addCenterLine(CenterLineType.HORIZONTAL, -3000, { labeled: true, discipline: Discipline.STRUCT });
  b.graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, ym, false, b.x0, b.x1, { role: 'primary' });
  // 左右の大梁も ym で受けられるよう、既存の縦梁は y0〜y1 の通しのまま（ホスト判定は区間内で成立）。
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.equal(r.removed.length, 2, '向きの違う旧梁芯は孤児');
  assert.deepEqual(r.removed.map(x => x.id).sort(), [...oldIds].sort());
  // 5000×4000 と 5000×3000 はともに縦梁（短辺が垂直方向）で x=2500 の1本ずつ。
  assert.equal(r.created.length, 2);
  assert.ok(r.created.every(x => x.centerLineType === CenterLineType.VERTICAL && x.value === 2500));
  assert.deepEqual(settle(b.graph, 2), [2, 0], '子梁2本を作って収束');
});

test('【S2b】隣り合う2ベイ: それぞれの梁芯は自分のベイに属し（extent）、再計算を重ねても id・本数が変わらない', () => {
  const b = buildBay('S造');
  const rules = rulesFor('S造');
  const x2 = b.graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const add = (cl, isV, p, q) => b.graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, p, q, { role: 'primary' });
  add(b.y0, false, b.x1, x2); add(b.y1, false, b.x1, x2); add(x2, true, b.y0, b.y1);
  assert.equal(settle(b.graph, 1)[0] > 0, true);
  const snap = () => fuseAxes(b.graph).map(x => `${x.id}@${x.value}[${x.extentLo},${x.extentHi}]`).join('|');
  const first = snap();
  assert.equal(fuseAxes(b.graph).length, 4);
  assert.deepEqual(settle(b.graph, 3), [0, 0, 0]);
  assert.equal(snap(), first);
});

test('【S2b】子梁を固定（locked）した梁芯: 由来を USER へ替え枠を記録し、その梁芯は動かさない。同じベイの他の梁芯は割り直され、重複しない', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a, c] = fuseAxes(b.graph); // a=−4666.67（i=1）, c=−2333.33（i=2）
  secondaries(b.graph).find(k => k.axisCL.id === a.id).setDimensionStatus('locked');
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual(r.normalized.map(x => x.id), [a.id]);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER);
  assert.equal(c.beamAxisOrigin, BeamAxisOrigin.SLAB_BEAM);
  assert.deepEqual([...b.graph.excludedSlabBeamSlots], [slabBeamSlotKey({ ...bayIds(b), dir: CenterLineType.HORIZONTAL, n: 3, i: 1 })]);
  assert.deepEqual([r.created.length, r.revalued.length, r.removed.length], [0, 0, 0]);
  assert.deepEqual(settle(b.graph, 3), [0, 0, 0]);
  assert.equal(fuseAxes(b.graph).length, 2, '重複して作らない');
  // 寸法が変わっても n は固定（ユーザー裁定U1）: 高さ10000でも n=3、i=1 は作らず i=2 だけ追従。固定した梁芯は動かない。
  b.y0.value = -10000;
  const moved = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual(moved.revalued.map(x => x.id), [c.id]);
  assert.equal(c.value, -10000 + 2 * (10000 / 3));
  assert.equal(a.value, -7000 + 7000 / 3, '固定した梁芯は動かない');
  assert.equal(moved.created.length, 0, 'i=1 は記録済みで作らない');
});

test('【S2b・失敗系】子梁だけ削除: 梁芯は USER で残り子梁は復活しない（×3パス・撤去0）。後から吹抜けが出ても削除の記録を持つ梁芯は撤去しない', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a, c] = fuseAxes(b.graph);
  b.graph.removeBeam(secondaries(b.graph).find(k => k.axisCL.id === a.id).id);
  let removedTotal = 0;
  for (let i = 0; i < 3; i++) {
    removedTotal += reconcileSlabSecondaryBeamAxes(b.graph, PROJECT).removed.length;
    assert.equal(autoFillSecondaryBeams(b.graph, PROJECT).created.length, 0, '子梁は復活しない');
  }
  assert.equal(removedTotal, 0);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER);
  // 吹抜けが後から出る: 未編集の c は撤去、削除の記録（excludedBeamSlots が a.id を参照）を持つ a は撤去しない。
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT, [rectOpening(0, 5000, -7000, 0)]);
  assert.deepEqual(r.removed.map(x => x.id), [c.id]);
  assert.ok(b.graph.centerLines.includes(a), '別 id で復活する事故の再発防止: 削除の記録がある梁芯は残る');
  assert.ok([...b.graph.excludedBeamSlots].some(k => exclusionKeyReferencesCL(k, a.id)));
});

test('【S2b・失敗系】孤児でも手が入った梁芯は撤去しない（USER へ替えるだけ）', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a, c] = fuseAxes(b.graph);
  secondaries(b.graph).find(k => k.axisCL.id === c.id).setDimensionStatus('locked');
  b.y0.value = -2400; // 短辺2400でベイは SHORT_SPAN
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual(r.removed.map(x => x.id), [a.id]);
  assert.equal(c.beamAxisOrigin, BeamAxisOrigin.USER);
  assert.ok(b.graph.centerLines.includes(c));
});

test('【S2b】管理中のベイでも、手で足した USER 梁芯が目標の座標にあればそこには作らず、他は割り直す', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a, c] = fuseAxes(b.graph);
  b.graph.removeCenterLine(c.id);
  const user = b.graph.addCenterLine(CenterLineType.HORIZONTAL, -7000 + 2 * (7000 / 3) + 0.2, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER,
    extentLoRef: { clId: b.x0.id, offset: 0 }, extentHiRef: { clId: b.x1.id, offset: 0 },
  });
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual([r.created.length, r.revalued.length, r.removed.length, r.normalized.length], [0, 0, 0, 0]);
  assert.deepEqual(fuseAxes(b.graph).map(x => x.id), [a.id, user.id]);
});

test('【S2b・U1/U2】記録のあるベイ: 寸法が変わっても n 固定で除外枠は作らず残りは追従。短辺・長辺が入れ替わると記録は効かず全部割り直す', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a, c] = fuseAxes(b.graph);
  b.graph.removeCenterLine(a.id); // 利用者が i=1 を削除した状態（記録を直接入れる）
  b.graph.excludedSlabBeamSlots.add(slabBeamSlotKey({ ...bayIds(b), dir: CenterLineType.HORIZONTAL, n: 3, i: 1 }));
  b.y0.value = -10000;
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual(r.revalued.map(x => x.id), [c.id]);
  assert.deepEqual(fuseAxes(b.graph).map(x => x.value), [-10000 + 2 * (10000 / 3)], 'n=3 のまま（既定なら n=4）・i=1 は作らない');
  // 入れ替え: 5000×3000（横が長辺→縦梁・n=2）。向きが変わるので記録は効かず、旧梁芯は孤児で撤去、既定の割付けになる。
  b.y0.value = -3000;
  const flipped = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual(flipped.removed.map(x => x.id), [c.id]);
  assert.deepEqual(flipped.created.map(x => [x.centerLineType, x.value]), [[CenterLineType.VERTICAL, 2500]]);
});

test('【S2b・失敗系】記録の無い手動削除（excludedWallBeamAxes）の座標は、管理中でも作らない', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a, c] = fuseAxes(b.graph);
  b.graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, a.effectiveValue));
  b.graph.removeCenterLine(a.id);
  assert.deepEqual(settle(b.graph, 3), [0, 0, 0]);
  assert.deepEqual(fuseAxes(b.graph).map(x => x.id), [c.id]);
});

test('【S2b】在来木造の FLOOR_BEAM 梁芯には触れない（木造は何もしない・S造でも FLOOR_BEAM は未編集の自動梁芯として扱わない）', () => {
  const wood = buildBay('木造（在来）');
  const axisOf = (g, bay, origin) => g.addCenterLine(CenterLineType.HORIZONTAL, -3500, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: origin,
    extentLoRef: { clId: bay.x0.id, offset: 0 }, extentHiRef: { clId: bay.x1.id, offset: 0 },
  });
  const wAxis = axisOf(wood.graph, wood, BeamAxisOrigin.FLOOR_BEAM);
  const wr = reconcileSlabSecondaryBeamAxes(wood.graph, PROJECT);
  assert.deepEqual([wr.created, wr.revalued, wr.removed, wr.normalized, wr.skipped].map(a => a.length), [0, 0, 0, 0, 0]);
  assert.equal(wAxis.value, -3500);
  const steel = buildBay('S造');
  const sAxis = axisOf(steel.graph, steel, BeamAxisOrigin.FLOOR_BEAM);
  const sr = reconcileSlabSecondaryBeamAxes(steel.graph, PROJECT);
  assert.deepEqual([sr.created.length, sr.revalued.length, sr.removed.length, sr.normalized.length], [0, 0, 0, 0]);
  assert.deepEqual(sr.skipped.map(s => s.reason), [SlabBayFillSkip.OCCUPIED]);
  assert.equal(sAxis.value, -3500);
});

// ---- S2b: 本番の再計算（recomputeStructuralForGraph）経由 ----
// 1階・2階の S造。両階に通り芯 xs×ys を引き、各階を全セル1部屋にする。leftVoid=true のとき x 最小のセルを後から吹抜けにできる。
async function buildS2FProject(xs, ys) {
  const project = new Project('proj-slab-s2b', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = 'S造';
  g1.structureOverride = 'S造';
  g2.structureOverride = 'S造';
  const struct = { labeled: true, discipline: Discipline.STRUCT };
  // 通り芯は本番どおり構造グラフ（全階共有）に置く。
  for (const x of xs) project.structGraph.addCenterLine(CenterLineType.VERTICAL, x, struct);
  for (const y of ys) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, y, struct);
  g1.addRoom(new Set(getAllCells(g1).map(c => c.key)));
  const cells = getAllCells(g2);
  const rooms = cells.map(c => g2.addRoom(new Set([c.key])));
  const run = async (passes = 3) => {
    const original = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => ({ p1: g1, p2: g2 })[plane.id] ?? null;
    const changed = [];
    try {
      for (let i = 0; i < passes; i++) changed.push((await recomputeStructuralForGraph(g2, project, 'S造')).changed);
    } finally { floorSwapManager.peek = original; }
    return changed;
  };
  const moveY = (from, to) => { g2.gridYs.find(c => c.value === from).value = to; };
  return { project, g1, g2, rooms, run, moveY };
}
const slabAxesOf = g => g.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM).sort((a, b) => a.value - b.value);

test('【S2b・配線】割付け後に吹抜けを足すと、そのベイの梁芯と子梁は0本になり、隣のベイの id・座標は変わらない', async () => {
  const p = await buildS2FProject([0, 5000, 10000], [0, 7000]);
  assert.equal((await p.run(3)).slice(1).some(Boolean), false, '2パス目以降は changed=false');
  const before = slabAxesOf(p.g2);
  assert.equal(before.length, 4);
  const left = before.filter(a => a.extentLo === 0 && a.extentHi === 5000); // 水平の梁芯の extent は x の範囲
  assert.equal(left.length, 2);
  // 後から足す吹抜け: 左のセル（x:0〜5000）。
  const leftCell = getAllCells(p.g2).find(c => c.x1 === 0 && c.x2 === 5000);
  p.rooms.find(r => r.cells.has(leftCell.key)).setFeature(RoomFeature.VOID);
  await p.run(3);
  const after = slabAxesOf(p.g2);
  const rightBefore = before.filter(a => !left.includes(a));
  assert.equal(after.length, 2);
  assert.deepEqual(after.map(a => [a.id, a.value]), rightBefore.map(a => [a.id, a.value]), '隣のベイは id・座標とも不変');
  assert.ok(p.g2.beams.filter(b => b.role === 'secondary').every(b => after.some(a => a.id === b.axisCL.id)), '吹抜けのベイの子梁は無い');
  assert.equal(p.g2.beams.filter(b => b.role === 'secondary').length, 2);
});

test('【S2b・配線】通り芯 y 7000→10000 を再計算に通す: 同じ id が張り直され、changed は収束する。戻すと元の座標・元の id', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const before = slabAxesOf(p.g2);
  assert.equal(before.length, 2);
  p.moveY(7000, 10000);
  const changed = await p.run(3);
  assert.deepEqual(changed, [true, false, false]);
  const moved = slabAxesOf(p.g2);
  assert.equal(moved.length, 3);
  assert.deepEqual(moved.map(a => a.value), [2500, 5000, 7500]);
  assert.deepEqual(before.map(a => a.id), moved.slice(0, 2).map(a => a.id), '値だけ張り直し（id 不変）');
  assert.equal(p.g2.beams.filter(b => b.role === 'secondary').length, 3);
  p.moveY(10000, 7000);
  assert.deepEqual((await p.run(3)), [true, false, false]);
  assert.deepEqual(slabAxesOf(p.g2).map(a => [a.id, a.value]), before.map(a => [a.id, a.value]));
});

test('【S2b・配線】子梁の固定は再計算で梁芯を USER へ替え（changed=true）、次のパスで収束する', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a] = slabAxesOf(p.g2);
  p.g2.beams.find(k => k.role === 'secondary' && k.axisCL.id === a.id).setDimensionStatus('locked');
  assert.deepEqual(await p.run(3), [true, false, false]);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER);
  assert.equal(slabAxesOf(p.g2).length, 1);
  assert.equal(p.g2.centerLines.filter(cl => cl.discipline === Discipline.FUSE).length, 2);
});

test('【S2b・配線】保存→読込みの往復の後も同じ（値・由来・枠の記録が戻り、再計算は何も変えない）', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a] = slabAxesOf(p.g2);
  p.g2.beams.find(k => k.role === 'secondary' && k.axisCL.id === a.id).setDimensionStatus('locked');
  p.moveY(7000, 10000);
  await p.run(3);
  const snap = g => g.centerLines.filter(cl => cl.discipline === Discipline.FUSE)
    .sort((x, y) => x.value - y.value).map(x => `${x.id}@${x.value}:${x.beamAxisOrigin}`).join('|');
  const slots = [...p.g2.excludedSlabBeamSlots];
  assert.equal(slots.length, 1);
  // 本番同型の読込み（graph を新しく作り、構造グラフを繋いでバイト列から復元する）。
  const loaded = new PlanGraph(p.g2.plane);
  loaded._structGraph = p.project.structGraph;
  restoreGraph(loaded, serializeGraph(p.g2));
  assert.equal(snap(loaded), snap(p.g2));
  assert.deepEqual([...loaded.excludedSlabBeamSlots], slots);
  const r = reconcileSlabSecondaryBeamAxes(loaded, p.project);
  assert.deepEqual([r.created, r.revalued, r.removed, r.normalized, r.skipped].map(x => x.length), [0, 0, 0, 0, 0]);
  assert.equal(snap(loaded), snap(p.g2));
});

// ---- S2b 是正（QA）: 梁芯の個別移動・undo/redo の id・子梁の編集判定・変異の穴 ----
test('【S2b・配線】梁芯を commitCLMoveOp で +500 動かす: 由来は USER になり、再計算×3 でも2本とも残り値が保たれる。元の位置に自動の梁芯は作り直されない', async () => {
  const { commitCLMoveOp } = await import('../transform/centerLineOps.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  const original = a.value;
  a.pendingDelta = 500;
  commitCLMoveOp(p.g2, p.project, a, original);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER);
  assert.equal(a.value, original + 500);
  assert.deepEqual(await p.run(3), [false, false, false]);
  const axes = p.g2.centerLines.filter(cl => cl.discipline === Discipline.FUSE).sort((x, y) => x.value - y.value);
  assert.deepEqual(axes.map(x => [x.id, x.value]), [[a.id, original + 500], [c.id, c.value]], '2本とも残り、c は動かない');
  assert.equal(c.value, 2 * (7000 / 3), 'c は元の座標のまま');
  assert.ok(!p.g2.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, original)), 'SLAB_BEAM の移動は座標キーを記録しない');
  assert.deepEqual([...p.g2.excludedSlabBeamSlots].map(k => parseSlabBeamSlotKey(k)).map(s => [s.dir, s.n, s.i]),
    [[CenterLineType.HORIZONTAL, 3, 1]], '元の枠（i=1）がベイ単位で記録される');
  assert.equal(p.g2.beams.filter(b => b.role === 'secondary').length, 2);
});

test('【S2b・配線】通り芯 y=0→−3000 の移動を undo/redo しても、元の2本の梁芯と子梁の id が両方向とも元どおり', async () => {
  const { commitCLMoveOp, setCenterLineStructuralListener } = await import('../transform/centerLineOps.js');
  const { undoManager } = await import('../undoManager.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  const kidIds = p.g2.beams.filter(b => b.role === 'secondary').map(b => b.id).sort();
  const idsOf = () => slabAxesOf(p.g2).map(x => x.id);
  let pending = Promise.resolve();
  setCenterLineStructuralListener(() => { pending = pending.then(() => p.run(3)); });
  try {
    const grid = p.g2.gridYs.find(g => g.value === 0);
    grid.pendingDelta = -3000;
    commitCLMoveOp(p.g2, p.project, grid, 0, { saveFloorFn: async () => {} });
    await pending;
    assert.ok(idsOf().includes(a.id) && idsOf().includes(c.id), '広げても元の2本は残る');
    const widened = slabAxesOf(p.g2);
    assert.equal(widened.length, 3);
    undoManager.undo(); await pending;
    assert.deepEqual(slabAxesOf(p.g2).map(x => [x.id, x.value]), [[a.id, 7000 / 3], [c.id, 2 * (7000 / 3)]], 'undo: 元の id・座標');
    assert.deepEqual(p.g2.beams.filter(b => b.role === 'secondary').map(b => b.id).sort(), kidIds, 'undo: 子梁の id');
    undoManager.redo(); await pending;
    assert.ok(idsOf().includes(a.id) && idsOf().includes(c.id), 'redo: 元の2本の id');
    assert.ok(p.g2.beams.filter(b => b.role === 'secondary').map(b => b.id).every(Boolean));
    for (const id of kidIds) assert.ok(p.g2.beams.some(b => b.id === id), `redo: 子梁 ${id} が残る`);
  } finally { setCenterLineStructuralListener(null); }
});

test('【S2b・失敗系】子梁の接合・番号グループ・断面・face gap だけ変えた梁芯は、吹抜けが出ても撤去されず USER になる', () => {
  const edits = {
    接合: k => { k.jointType = 'RIGID'; },
    番号グループ: k => { k.numberGroupId = 'B#1'; },
    断面: k => { k.sectionDefId = 'other-section'; },
    faceGap: k => { k.faceGap = 10; },
    天端レベル: k => { k.levelOffset = -50; },
  };
  for (const [label, edit] of Object.entries(edits)) {
    const b = buildBay('S造');
    settle(b.graph, 1);
    const [a, c] = fuseAxes(b.graph);
    edit(secondaries(b.graph).find(k => k.axisCL.id === a.id));
    const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT, [rectOpening(0, 5000, -7000, 0)]);
    assert.deepEqual(r.normalized.map(x => x.id), [a.id], label);
    assert.deepEqual(r.removed.map(x => x.id), [c.id], `${label}: 未編集の c だけ撤去`);
    assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER, label);
    assert.ok(b.graph.centerLines.includes(a), label);
  }
});

test('【S2b】自動生成のままの子梁（既定の接合・断面・番号なし）は編集あり扱いにならない', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  assert.deepEqual(settle(b.graph, 2), [0, 0]);
  assert.ok(fuseAxes(b.graph).every(x => x.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM));
});

test('【S2b】ベイが縮む（y −7000→−5000: n=3→2）: 1本を張り直し・1本を撤去、子梁は1本', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a] = fuseAxes(b.graph);
  b.y0.value = -5000;
  const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual([r.revalued.length, r.removed.length, r.created.length], [1, 1, 0]);
  assert.equal(r.revalued[0].id, a.id);
  autoFillSecondaryBeams(b.graph, PROJECT);
  assert.deepEqual(fuseAxes(b.graph).map(x => x.value), [-2500]);
  assert.equal(secondaries(b.graph).length, 1);
});

// 通り芯 grid を commitCLMoveOp で delta だけ動かし、構造同期（再計算×3）の changed 列を返す。
async function moveGridWithSync(p, grid, delta) {
  const { commitCLMoveOp, setCenterLineStructuralListener } = await import('../transform/centerLineOps.js');
  const original = grid.value;
  let pending = Promise.resolve([]);
  setCenterLineStructuralListener(() => { pending = pending.then(() => p.run(3)); });
  try {
    grid.pendingDelta = delta;
    commitCLMoveOp(p.g2, p.project, grid, original, { saveFloorFn: async () => {} });
    return await pending;
  } finally { setCenterLineStructuralListener(null); }
}

test('【S2b・配線】縦に並ぶ2ベイの中央の通り芯 7000→4000: 1回の再計算で収束し（changed [true,false,false]）、上のベイ（縦梁）の梁芯1本と子梁が1パス目でできる', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000, 14000]);
  await p.run(3);
  assert.equal(slabAxesOf(p.g2).length, 4);
  const changed = await moveGridWithSync(p, p.g2.gridYs.find(g => g.value === 7000), -3000);
  assert.deepEqual(changed, [true, false, false]);
  const axes = slabAxesOf(p.g2);
  const vertical = axes.filter(a => a.centerLineType === CenterLineType.VERTICAL);
  assert.deepEqual(vertical.map(a => [a.value, a.extentLo, a.extentHi]), [[2500, 0, 4000]]);
  assert.equal(axes.length - vertical.length, 3, '下のベイ（5000×10000）は n=4 の3本');
  assert.equal(p.g2.beams.filter(b => b.role === 'secondary').length, 4, '子梁も1パス目で揃う');
});

test('【S2b・配線】縦に並ぶ2ベイ（同じ端の通り芯を共有）: 各梁芯は自分の値を含むベイに属し、中央の通り芯を動かしても元の id が正しいベイで保たれる', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000, 14000]);
  await p.run(3);
  const [a, b, c, d] = slabAxesOf(p.g2); // a,b＝上のベイ（2333・4667）、c,d＝下のベイ（9333・11667）
  assert.deepEqual(await (async () => { p.moveY(7000, 9000); return p.run(3); })(), [true, false, false]);
  const now = slabAxesOf(p.g2).map(x => [x.id, x.value]);
  // 上のベイ 0..9000（n=4: 2250・4500・6750）、下のベイ 9000..14000（5000×5000: n=2 → 11500）。
  assert.deepEqual(now.map(x => x[1]), [2250, 4500, 6750, 11500]);
  assert.deepEqual(now.slice(0, 2).map(x => x[0]), [a.id, b.id], '上のベイ: a・b が保たれる');
  assert.equal(now[3][0], c.id, '下のベイ: 自分の値を含むベイへ属した c が張り直される（上のベイに取られない）');
  assert.ok(!now.some(x => x[0] === d.id), 'd は余りとして撤去');
});

test('【S2b・配線】小梁グループに手動タグ（join あり）を付けても梁芯は SLAB_BEAM のまま・枠0件。通り芯 7000→10000 で3本に割り直される。個別の断面変更は編集（対照）', async () => {
  const { splitGroup, setGroupManualTag } = await import('./memberGroups.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const kids = p.g2.beams.filter(b => b.role === 'secondary');
  const gid = splitGroup(p.project, 'beamMap', kids);
  setGroupManualTag(p.project.memberGroupLedger, gid, 'Bx');
  await p.run(3); // conformToLedger が加入署名の一致する自動の部材にも gid を付ける
  assert.ok(kids.every(k => k.numberGroupId === gid));
  assert.equal(slabAxesOf(p.g2).length, 2);
  assert.equal(p.g2.excludedSlabBeamSlots.size, 0);
  p.moveY(7000, 10000);
  await p.run(3);
  const vs = slabAxesOf(p.g2).map(x => x.value);
  assert.deepEqual(vs, [2500, 5000, 7500]);
  assert.equal(p.g2.excludedSlabBeamSlots.size, 0);
  // 対照: 個別の断面変更（join に乗らない値）は編集
  const q = await buildS2FProject([0, 5000], [0, 7000]);
  await q.run(3);
  q.g2.beams.find(b => b.role === 'secondary').sectionDefId = 'other-section';
  await q.run(2);
  assert.equal(slabAxesOf(q.g2).length, 1, '個別編集した梁芯は USER');
  assert.equal(q.g2.excludedSlabBeamSlots.size, 1);
});

test('【S2b・失敗系】孤立グループ（join なし＝個別採番）の子梁は編集あり。join のあるグループは編集なし', async () => {
  const { splitGroup, materializeGroup } = await import('./memberGroups.js');
  const withGroup = (join) => {
    const b = buildBay('S造');
    settle(b.graph, 1);
    const kids = secondaries(b.graph);
    if (join) splitGroup(PROJECT_G, 'beamMap', kids);
    else kids.forEach(k => k.setNumberGroupId(materializeGroup(PROJECT_G.memberGroupLedger, 'B', 'iso-signature', 'sectionDefId=x', { join: false })));
    return b;
  };
  const PROJECT_G = { ...PROJECT, memberGroupLedger: new Map() };
  for (const [join, edited] of [[true, false], [false, true]]) {
    const b = withGroup(join);
    const r = reconcileSlabSecondaryBeamAxes(b.graph, PROJECT_G);
    assert.equal(r.normalized.length > 0, edited, join ? 'join あり' : '孤立グループ');
  }
});

// ---- S2c: 削除・移動の記録をベイ単位に（slabBeamSlotKeyFor） ----
const slabSlotsOf = g => [...g.excludedSlabBeamSlots].map(k => parseSlabBeamSlotKey(k));
const userAxesOf = g => g.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.USER);

async function deleteAxis(p, cl) {
  const { deleteCenterLineWithUndo } = await import('../transform/centerLineOps.js');
  const r = await deleteCenterLineWithUndo(p.g2, p.project, cl, { saveFloorFn: async () => {} });
  assert.equal(r.toast, null);
}

test('【S2c・配線】梁芯を1本削除→通り芯 7000→10000: 削除は保たれ（n=3 固定・除外枠は作らない）、残りは追従し、再計算×3 で復活しない。座標キーは記録しない', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  await deleteAxis(p, a);
  assert.equal(p.g2.excludedWallBeamAxes.size, 0, 'SLAB_BEAM の削除は座標キーを記録しない');
  assert.deepEqual(slabSlotsOf(p.g2).map(s => [s.dir, s.n, s.i]), [[CenterLineType.HORIZONTAL, 3, 1]]);
  assert.deepEqual(await p.run(3), [false, false, false], '削除直後の再計算で何も起きない');
  await moveGridWithSync(p, p.g2.gridYs.find(g => g.value === 7000), 3000);
  const after = slabAxesOf(p.g2);
  assert.deepEqual(after.map(x => [x.id, x.value]), [[c.id, 2 * (10000 / 3)]], 'n=3 固定: i=2 の1本だけが追従。復活しない');
  assert.equal(p.g2.beams.filter(b => b.role === 'secondary').length, 1);
});

test('【S2c・配線】あるベイで梁芯を削除しても、別のベイの同じ座標には作られる（座標キーを使わない）', async () => {
  const p = await buildS2FProject([0, 5000, 10000], [0, 7000]);
  await p.run(3);
  const left = slabAxesOf(p.g2).filter(x => x.extentHi === 5000);
  const right = slabAxesOf(p.g2).filter(x => x.extentHi === 10000);
  assert.equal(left.length + right.length, 4);
  await deleteAxis(p, left[0]);
  // 右のベイは梁芯ごと消えた状態（未管理）にして、再計算が同じ座標へ作ることを見る。
  right.forEach(x => p.g2.removeCenterLine(x.id));
  await p.run(3);
  const rightNow = slabAxesOf(p.g2).filter(x => x.extentHi === 10000).map(x => x.value);
  assert.deepEqual(rightNow, right.map(x => x.value), '右のベイは同じ座標（削除した左の座標を含む）に2本とも作られる');
  assert.equal(slabAxesOf(p.g2).filter(x => x.extentHi === 5000).length, 1, '左は削除した1本が戻らない');
});

test('【S2c・配線】梁芯を1本動かす: 元の位置に作り直されず、通り芯 7000→10000 でも元の枠は空いたまま（動かした梁芯は USER で動かない）', async () => {
  const { commitCLMoveOp } = await import('../transform/centerLineOps.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  const original = a.value;
  a.pendingDelta = 500;
  commitCLMoveOp(p.g2, p.project, a, original);
  assert.deepEqual(slabSlotsOf(p.g2).map(s => [s.dir, s.n, s.i]), [[CenterLineType.HORIZONTAL, 3, 1]]);
  assert.equal(p.g2.excludedWallBeamAxes.size, 0);
  assert.deepEqual(await p.run(3), [false, false, false]);
  await moveGridWithSync(p, p.g2.gridYs.find(g => g.value === 7000), 3000);
  assert.deepEqual(slabAxesOf(p.g2).map(x => [x.id, x.value]), [[c.id, 2 * (10000 / 3)]], 'i=1 の位置（3333）に自動の梁芯は作られない');
  assert.deepEqual(userAxesOf(p.g2).map(x => [x.id, x.value]), [[a.id, original + 500]], '動かした梁芯は動かない');
});

test('【S2c・配線】梁芯を +1700 動かす（移動後の位置では最寄りの枠が i=2 になる距離）: 枠は移動前の位置で i=1 と記録され、もう1本は張り直されない', async () => {
  const { commitCLMoveOp } = await import('../transform/centerLineOps.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  const [aBefore, cBefore] = [a.value, c.value];
  a.pendingDelta = 1700; // 7000/3 → 4033.3。i=1(2333) より i=2(4667) の方が近い
  commitCLMoveOp(p.g2, p.project, a, aBefore);
  assert.deepEqual(slabSlotsOf(p.g2).map(s => [s.n, s.i]), [[3, 1]], '移動前の位置（i=1）で記録される');
  assert.deepEqual(await p.run(3), [false, false, false]);
  assert.equal(c.value, cBefore, 'もう1本の自動梁芯は i=2 の位置のまま張り直されない');
  assert.equal(c.beamAxisOrigin, BeamAxisOrigin.SLAB_BEAM);
  assert.equal(a.value, aBefore + 1700);
});

test('【S2c・配線】削除・移動の undo/redo で、枠の記録と梁芯が往復する', async () => {
  const { commitCLMoveOp } = await import('../transform/centerLineOps.js');
  const { undoManager } = await import('../undoManager.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  // 削除
  await deleteAxis(p, a);
  assert.equal(p.g2.excludedSlabBeamSlots.size, 1);
  undoManager.undo();
  assert.equal(p.g2.excludedSlabBeamSlots.size, 0, 'undo: 記録が戻る');
  assert.ok(p.g2.centerLines.some(x => x.id === a.id), 'undo: 梁芯が戻る');
  undoManager.redo();
  assert.equal(p.g2.excludedSlabBeamSlots.size, 1, 'redo: 記録が再び付く');
  assert.ok(!p.g2.centerLines.some(x => x.id === a.id));
  undoManager.undo();
  // 移動（undo 後に戻った a を動かす。graph 復元で CL 実体が作り直されるので引き直す）
  const a2 = p.g2.centerLines.find(x => x.id === a.id);
  const original = a2.value;
  a2.pendingDelta = 500;
  commitCLMoveOp(p.g2, p.project, a2, original);
  assert.equal(p.g2.excludedSlabBeamSlots.size, 1);
  undoManager.undo();
  assert.equal(p.g2.excludedSlabBeamSlots.size, 0, '移動の undo: 記録が戻る');
  const back = p.g2.centerLines.find(x => x.id === a.id);
  assert.equal(back.value, original);
  assert.equal(back.beamAxisOrigin, BeamAxisOrigin.SLAB_BEAM, '移動の undo: 由来も SLAB_BEAM に戻る');
  undoManager.redo();
  assert.equal(p.g2.excludedSlabBeamSlots.size, 1);
  assert.equal(p.g2.centerLines.find(x => x.id === a.id).beamAxisOrigin, BeamAxisOrigin.USER);
  assert.ok(p.g2.centerLines.some(x => x.id === c.id));
});

test('【S2c・配線】子梁だけ削除（excludedBeamSlots）した後に、その梁芯を削除しても復活しない・枠は重複しない', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  p.g2.removeBeam(p.g2.beams.find(k => k.role === 'secondary' && k.axisCL.id === a.id).id);
  await p.run(3);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER);
  assert.equal(p.g2.excludedSlabBeamSlots.size, 1);
  await deleteAxis(p, a); // USER 由来なので枠は増えず、座標キーで守る（従来の記録）
  assert.equal(p.g2.excludedSlabBeamSlots.size, 1);
  assert.deepEqual(await p.run(3), [false, false, false]);
  assert.deepEqual(p.g2.centerLines.filter(x => x.discipline === Discipline.FUSE).map(x => x.id), [c.id]);
});

test('【S2c・失敗系】slabBeamSlotKeyFor: 非スラブ由来・FLOOR_BEAM・孤児・木造・S造でない構造は null', () => {
  const probeOf = (cl, extra = {}) => ({ beamAxisOrigin: cl.beamAxisOrigin, centerLineType: cl.centerLineType, coord: cl.value,
    extentLoRef: cl.extentLoRef, extentHiRef: cl.extentHiRef, extentLo: cl.extentLo, extentHi: cl.extentHi, ...extra });
  const b = buildBay('S造');
  settle(b.graph, 1);
  const [a] = fuseAxes(b.graph);
  assert.ok(slabBeamSlotKeyFor(b.graph, PROJECT, probeOf(a)), '基準: SLAB_BEAM は枠キーを返す');
  for (const origin of [BeamAxisOrigin.USER, BeamAxisOrigin.FLOOR_BEAM, BeamAxisOrigin.OPENING, BeamAxisOrigin.WALL, null]) {
    assert.equal(slabBeamSlotKeyFor(b.graph, PROJECT, probeOf(a, { beamAxisOrigin: origin })), null, String(origin));
  }
  // 孤児: 端の通り芯が合わない（参照 id も座標も）
  assert.equal(slabBeamSlotKeyFor(b.graph, PROJECT, probeOf(a, { extentLoRef: { clId: 'nope', offset: 0 }, extentHiRef: { clId: 'nope2', offset: 0 } })), null);
  assert.equal(slabBeamSlotKeyFor(b.graph, PROJECT, probeOf(a, { extentLoRef: null, extentHiRef: null, extentLo: 123, extentHi: 456 })), null);
  // 向きがベイの割付け方向と違う
  assert.equal(slabBeamSlotKeyFor(b.graph, PROJECT, probeOf(a, { centerLineType: CenterLineType.VERTICAL })), null);
  // 木造・SRC 造・未定
  for (const structure of ['木造（在来）', 'SRC造', '未定']) {
    const w = buildBay(structure);
    assert.equal(slabBeamSlotKeyFor(w.graph, PROJECT, probeOf(a)), null, structure);
  }
  // 短辺が最大ピッチ以下のベイ（割付け対象外）
  const s = buildBay('S造', { width: 5000, height: 2400 });
  assert.equal(slabBeamSlotKeyFor(s.graph, PROJECT, probeOf(a)), null);
});

test('【S2c・失敗系】壊れたキー・別名前空間・範囲外の枠が除外集合にあっても、割り直しは無視して何も変えない', () => {
  const b = buildBay('S造');
  settle(b.graph, 1);
  const before = fuseAxes(b.graph).map(x => `${x.id}@${x.value}`).join('|');
  for (const k of ['', 'slab', 'X:1000', 'wall:a:b:c:d:X:3:1', 'slab:a:b:c:d:Z:3:1', 'slab:a:b:c:d:Y:3:9', 'slab:a:b:c:d:Y:x:1']) b.graph.excludedSlabBeamSlots.add(k);
  assert.deepEqual(settle(b.graph, 3), [0, 0, 0]);
  assert.equal(fuseAxes(b.graph).map(x => `${x.id}@${x.value}`).join('|'), before);
});

test('【S2b】同じ座標に通り芯と OPENING 由来梁芯が並ぶ辺は、枠キーの辺 id が通り芯の id（id の辞書順より通り芯を優先）', () => {
  const b = buildBay('S造');
  const rules = rulesFor('S造');
  // 辞書順で必ず通り芯より前になる id ('!' は uuid のどの文字より小さい)。
  const open = b.graph.addCenterLine(CenterLineType.HORIZONTAL, -7000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
    extentLoRef: { clId: b.x0.id, offset: 0 }, extentHiRef: { clId: b.x1.id, offset: 0 },
  }, '!open');
  b.graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, open, false, b.x0, b.x1, { role: 'secondary' });
  settle(b.graph, 1);
  const [a] = fuseAxes(b.graph).filter(x => x.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM);
  secondaries(b.graph).find(k => k.axisCL.id === a.id).setDimensionStatus('locked');
  reconcileSlabSecondaryBeamAxes(b.graph, PROJECT);
  assert.deepEqual([...b.graph.excludedSlabBeamSlots], [slabBeamSlotKey({ ...bayIds(b), dir: CenterLineType.HORIZONTAL, n: 3, i: 1 })]);
});

// ---- S2d: 平面で見えない子梁芯に通り芯の移動が阻まれない／個別の移動は別ベイの梁芯に止められない ----
// 本番の移動範囲（resolveMoveRange。通り芯は他階を peek して障害物を集める）を、peek を2階分だけ差し替えて呼ぶ。
async function moveRangeOf(p, cl) {
  const { resolveMoveRange } = await import('../transform/followerGraph.js');
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => ({ p1: p.g1, p2: p.g2 })[plane.id] ?? null;
  try {
    const r = await resolveMoveRange(p.project, p.g2, cl);
    assert.ok(r.range, '随伴探査の上限を超えない');
    return r.range;
  } finally { floorSwapManager.peek = original; }
}

test('【S2d・配線】通り芯 y=7000 の移動範囲は SLAB_BEAM の子梁芯（2333・4667）で止まらず、辺の通り芯 y=0 までになる。y=0 の上側も 7000 まで', async () => {
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  assert.equal(slabAxesOf(p.g2).length, 2, '前提: 子梁芯が2本ある');
  assert.deepEqual(await moveRangeOf(p, p.g2.gridYs.find(g => g.value === 7000)), { min: 0, max: Infinity });
  assert.deepEqual(await moveRangeOf(p, p.g2.gridYs.find(g => g.value === 0)), { min: -Infinity, max: 7000 });
});

test('【S2d・配線・U3】手を加えた（動かして USER になった）梁芯は通り芯の移動を止める。他の SLAB_BEAM は止めない', async () => {
  const { commitCLMoveOp } = await import('../transform/centerLineOps.js');
  const p = await buildS2FProject([0, 5000], [0, 7000]);
  await p.run(3);
  const [a, c] = slabAxesOf(p.g2);
  const original = a.value;
  a.pendingDelta = 500;
  commitCLMoveOp(p.g2, p.project, a, original);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.USER);
  assert.equal(c.beamAxisOrigin, BeamAxisOrigin.SLAB_BEAM);
  assert.deepEqual(await moveRangeOf(p, p.g2.gridYs.find(g => g.value === 7000)), { min: original + 500, max: Infinity },
    'USER の梁芯（a）で止まる。c（SLAB_BEAM・4667）は止めない');
});

test('【S2d・配線】通り芯 10000→7000（子梁芯 7500 を越える）: 再計算で割り直され、ピッチ≤2500・changed 収束。undo で元の3本が元の id・座標に戻る', async () => {
  const { commitCLMoveOp, setCenterLineStructuralListener } = await import('../transform/centerLineOps.js');
  const { undoManager } = await import('../undoManager.js');
  const p = await buildS2FProject([0, 5000], [0, 10000]);
  await p.run(3);
  const before = slabAxesOf(p.g2).map(x => [x.id, x.value]);
  assert.deepEqual(before.map(x => x[1]), [2500, 5000, 7500]);
  const grid = p.g2.gridYs.find(g => g.value === 10000);
  assert.deepEqual(await moveRangeOf(p, grid), { min: 0, max: Infinity }, '前提: 7500 の子梁芯を越えて動かせる');
  let pending = Promise.resolve([]);
  setCenterLineStructuralListener(() => { pending = pending.then(() => p.run(3)); });
  try {
    grid.pendingDelta = -3000;
    commitCLMoveOp(p.g2, p.project, grid, 10000, { saveFloorFn: async () => {} });
    const changed = await pending;
    assert.deepEqual(changed, [true, false, false]);
    const axes = slabAxesOf(p.g2);
    assert.deepEqual(axes.map(x => x.value), [7000 / 3, 2 * (7000 / 3)], '越えられた 7500 は孤児として撤去、残りは 7000 の 3 等分へ割り直し');
    const ys = [0, ...axes.map(x => x.value), 7000];
    assert.ok(ys.slice(1).every((y, i) => y - ys[i] <= MAX), 'ピッチ≤2500');
    assert.deepEqual(axes.map(x => x.id), before.slice(0, 2).map(x => x[0]), '1・2本目は同じ id で張り直される');
    assert.equal(p.g2.beams.filter(b => b.role === 'secondary').length, 2);
    undoManager.undo(); await pending;
    const undone = slabAxesOf(p.g2).map(x => [x.id, x.value]);
    assert.deepEqual(undone.map(x => x[1]), before.map(x => x[1]), 'undo: 元の座標');
    assert.deepEqual(undone.slice(0, 2), before.slice(0, 2), 'undo: 張り直された2本は元の id');
    // 既知の限界（cl-conversion-limits.md）: 本数が減る移動で撤去された3本目の id は、undo で作り直されるため戻らない。
    assert.notEqual(undone[2][0], before[2][0]);
  } finally { setCenterLineStructuralListener(null); }
});

test('【S2d・配線・U5】横に並ぶ2ベイ: 左のベイの子梁芯の移動範囲は、右のベイの梁芯（extent が接するだけ）に止められず、同じベイの隣と辺の通り芯で止まる', async () => {
  const { beamAxisMoveRange } = await import('./beamAxisMove.js');
  const p = await buildS2FProject([0, 5000, 10000], [0, 7000]);
  await p.run(3);
  const left = slabAxesOf(p.g2).filter(a => a.extentHi === 5000);
  assert.equal(left.length, 2);
  const [a, b] = left;
  // 右のベイにだけ y=1000 の手動の梁芯（USER）を足す: 左の子梁芯の下限になってはならない。
  p.g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER, extentLo: 5000, extentHi: 10000,
  });
  assert.deepEqual(beamAxisMoveRange(p.g2, a), { min: 0 + CL_OVERLAP_TOL_MM, max: b.value - CL_OVERLAP_TOL_MM },
    '下は辺の通り芯 y=0（右のベイの y=1000 は無視）、上は同じベイの隣（順番が入れ替わらない）');
});

// ---- S3-3: 手動の梁芯に近すぎる自動の梁芯（nearUserSlabAxisIds） ----
// 5000×6000 のベイ: 横梁の梁芯が y=-4000・-2000（n=3・ピッチ2000・ピッチの半分1000）。
const userAxis = (b, y, extra = {}) => b.graph.addCenterLine(CenterLineType.HORIZONTAL, y, {
  labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER,
  extentLoRef: { clId: b.x0.id, offset: 0 }, extentHiRef: { clId: b.x1.id, offset: 0 }, ...extra,
});
function nearBay() {
  const b = buildBay('S造', { width: 5000, height: 6000 });
  settle(b.graph, 1);
  const [a, c] = slabAxesOf(b.graph);
  assert.deepEqual([a.value, c.value], [-4000, -2000], '前提: 自動の梁芯の位置');
  return { b, a, c };
}

test('【S3-3】nearUserSlabAxisIds: 手動の梁芯とのスパン方向の距離がピッチの半分（1000）未満の自動の梁芯だけが入る。ちょうど半分と以上は入らない', () => {
  const { b, a, c } = nearBay();
  const ids = () => [...nearUserSlabAxisIds(b.graph, PROJECT)];
  const user = userAxis(b, -3001); // a(-4000) まで 999
  assert.deepEqual(ids(), [a.id]);
  user.value = -3000; // a・c ともちょうど 1000（境界: 入らない）
  assert.deepEqual(ids(), []);
  user.value = -2999; // c(-2000) まで 999
  assert.deepEqual(ids(), [c.id]);
  user.value = -4000 + 1001; // a まで 1001（以上: 入らない）、c まで 999
  assert.deepEqual(ids(), [c.id]);
  userAxis(b, -4400); // a に 400
  assert.deepEqual(new Set(ids()), new Set([a.id, c.id]), '2本の手動の梁芯がそれぞれの自動の梁芯に近い');
});

test('【S3-3・失敗系】nearUserSlabAxisIds: 手動の梁芯が無い・自動の梁芯が無い・S造でない・別ベイ・向き違い・範囲が重ならないときは入らない', () => {
  const { b } = nearBay();
  assert.equal(nearUserSlabAxisIds(b.graph, PROJECT).size, 0, '手動の梁芯が無い');

  // 自動の梁芯が無い（USER 同士・SLAB_BEAM の条件）: 未割付けのベイに USER を2本（近いが SLAB_BEAM ではない）。
  const noSlab = buildBay('S造', { width: 5000, height: 6000 });
  userAxis(noSlab, -4000); userAxis(noSlab, -3300);
  assert.equal(nearUserSlabAxisIds(noSlab.graph, PROJECT).size, 0, '自動の梁芯が無ければ手動どうしは対象外');

  // 向き違い: 縦の手動の梁芯（x=2400）は横梁の SLAB_BEAM と同じ向きでない。
  const v = nearBay();
  v.b.graph.addCenterLine(CenterLineType.VERTICAL, 2400, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER,
    extentLoRef: { clId: v.b.y0.id, offset: 0 }, extentHiRef: { clId: v.b.y1.id, offset: 0 },
  });
  assert.equal(nearUserSlabAxisIds(v.b.graph, PROJECT).size, 0, '向き違い');

  // 向き違いの距離: ベイ x∈[0,5000]・y∈[1000,7000]（横梁の梁芯 y=3000・5000、半ピッチ1000）に、縦の手動の梁芯
  // x=3300（|3300−3000|=300 < 半ピッチ。ベイ内・extent も重なる）を置く。値だけ近くても向きが違えば入らない。
  const g = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  g.structureOverride = 'S造';
  const rules = rulesFor('S造');
  const st = { labeled: true, discipline: Discipline.STRUCT };
  const gx0 = g.addCenterLine(CenterLineType.VERTICAL, 0, st), gx1 = g.addCenterLine(CenterLineType.VERTICAL, 5000, st);
  const gy0 = g.addCenterLine(CenterLineType.HORIZONTAL, 1000, st), gy1 = g.addCenterLine(CenterLineType.HORIZONTAL, 7000, st);
  const addB = (cl, isV, p, q) => g.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, p, q, { role: 'primary' });
  addB(gy0, false, gx0, gx1); addB(gy1, false, gx0, gx1); addB(gx0, true, gy0, gy1); addB(gx1, true, gy0, gy1);
  settle(g, 1);
  assert.deepEqual(slabAxesOf(g).map(a => a.value), [3000, 5000], '前提: 自動の梁芯の位置');
  g.addCenterLine(CenterLineType.VERTICAL, 3300, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER,
    extentLoRef: { clId: gy0.id, offset: 0 }, extentHiRef: { clId: gy1.id, offset: 0 },
  });
  assert.equal(nearUserSlabAxisIds(g, PROJECT).size, 0, '値が近い縦の梁芯でも向き違いは入らない');
  g.addCenterLine(CenterLineType.HORIZONTAL, 3300, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER,
    extentLoRef: { clId: gx0.id, offset: 0 }, extentHiRef: { clId: gx1.id, offset: 0 },
  });
  assert.equal(nearUserSlabAxisIds(g, PROJECT).size, 1, '対照: 同じ値の横の梁芯なら入る');

  // 範囲が重ならない: 手動の梁芯の extent がベイの右の外（x 5000〜9000）。
  const r = nearBay();
  userAxis(r.b, -3300, { extentLoRef: null, extentHiRef: null, extentLo: 5000, extentHi: 9000 });
  assert.equal(nearUserSlabAxisIds(r.b.graph, PROJECT).size, 0, 'extent が重ならない');

  // S造でない: 同じ梁芯のまま主構造だけ在来木造にすると空。
  const w = nearBay();
  userAxis(w.b, -3300);
  assert.equal(nearUserSlabAxisIds(w.b.graph, PROJECT).size, 1, '前提: S造なら入る');
  w.b.graph.structureOverride = '在来木造';
  assert.equal(nearUserSlabAxisIds(w.b.graph, PROJECT).size, 0, 'S造以外は空');
});

test('【S3-3】nearUserSlabAxisIds: 別のベイの手動の梁芯は数えない（隣のベイの自動の梁芯だけが入る）', () => {
  const b = buildBay('S造', { width: 5000, height: 6000 });
  const rules = rulesFor('S造');
  const x2 = b.graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const add = (cl, isV, p, q) => b.graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, p, q, { role: 'primary' });
  add(b.y0, false, b.x1, x2); add(b.y1, false, b.x1, x2); add(x2, true, b.y0, b.y1);
  settle(b.graph, 1);
  const rightAxes = slabAxesOf(b.graph).filter(a => a.extentLoRef.clId === b.x1.id);
  assert.equal(rightAxes.length, 2, '前提: 右のベイにも自動の梁芯が2本');
  userAxis(b, -3300, { extentLoRef: { clId: b.x1.id, offset: 0 }, extentHiRef: { clId: x2.id, offset: 0 } });
  const ids = [...nearUserSlabAxisIds(b.graph, PROJECT)];
  assert.deepEqual(ids, [rightAxes[0].id], '右のベイの y=-4000 の梁芯だけ（左のベイの同じ y の梁芯は入らない）');
});

const realProject = () => { const p = new Project('proj-s33', 'test'); p.structuralInfo.mainStructure = 'S造'; return p; };

test('【S3-3・配線】吸着後の値（中心線の位置・絶対座標）で addCenterLineFromDialog: 由来 USER・refId なし・子梁が生成され、ずれた自動の梁芯は残り、近い自動の梁芯が注意対象になる', async () => {
  const { b, a, c } = nearBay();
  const center = b.graph.addCenterLine(CenterLineType.HORIZONTAL, -3300, { labeled: false, discipline: Discipline.ARCH });
  // ダイアログの流れ: 参照の選択肢 = 近接する中心線 + 通り芯。ポインタ y=-3290 の最寄りは中心線 → 距離 '0'
  const worldCoord = -3290, sign = -1;
  const options = [center, ...b.graph.gridYs];
  const init = initialRef(options, worldCoord, 'structure', sign);
  assert.deepEqual(init, { refId: center.id, distStr: '0' });
  const refCL = options.find(o => o.id === init.refId);
  const dir = worldCoord >= refCL.value ? 1 : -1;
  const previewWorld = refCL.value + dir * 0;
  const folded = foldRefForConfirm(refCL, 'structure', { dist: 0, dir });
  assert.deepEqual(folded, { refId: null, refOffset: null });
  const r = await addCenterLineFromDialog(
    b.graph, realProject(),
    { clDialog: { type: 'horizontal', worldCoord, perpCoord: 2500 }, value: previewWorld, kind: 'beam', refId: folded.refId, refOffset: folded.refOffset },
    null,
  );
  assert.equal(r.done, true);
  const added = b.graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.USER);
  assert.equal(added.value, -3300);
  assert.equal(added.refId ?? null, null, '絶対座標（中心線に追従しない）');
  assert.ok(b.graph.beams.some(bm => bm.axisCL.id === added.id && bm.role === 'secondary'), '子梁が生成される');
  // 再計算を重ねても自動の梁芯は残る（-3300 は目標 -4000・-2000 のどちらとも一致しない＝両方残る）
  settle(b.graph, 3);
  assert.deepEqual(slabAxesOf(b.graph).map(x => x.id), [a.id, c.id]);
  assert.deepEqual([...nearUserSlabAxisIds(b.graph, PROJECT)], [a.id], 'a(-4000) まで 700 < 1000');
});

test('【S3-3・失敗系・配線】自動の梁芯と同位置への手動追加は同種別の重複として拒否され、自動の梁芯は二重にならない', async () => {
  const { b, a } = nearBay();
  const r = await addCenterLineFromDialog(
    b.graph, realProject(),
    { clDialog: { type: 'horizontal', worldCoord: -4000, perpCoord: 2500 }, value: -4000, kind: 'beam', refId: null, refOffset: null },
    null,
  );
  assert.equal(r.done, false);
  assert.ok(r.toast);
  assert.equal(b.graph.centerLines.filter(cl => Math.abs(cl.value - -4000) < CL_OVERLAP_TOL_MM && cl.discipline === Discipline.FUSE).length, 1);
  assert.equal(a.beamAxisOrigin, BeamAxisOrigin.SLAB_BEAM);
});
