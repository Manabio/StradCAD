// slabSecondaryBeamAxes.js（S造スラブ小梁の梁芯の割付け。ユーザー指示2026-10-26）の単体テスト。
// フィクスチャは woodAutoFill.test.js の buildClosedCellGraph の主構造差し替え版（4辺を primary 梁で囲んだ1ベイ）。
// 座標系は実データに合わせ y 下向き正・ベイは y:[-height,0]。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomFeature, centerLineKind as centerLineKindOf } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SlabBayFillSkip, STEEL_SECONDARY_BEAM_MAX_PITCH_MM } from '../core/constants.js';
import { autoFillSlabSecondaryBeamAxes, planSlabSecondaryBeamAxes } from './slabSecondaryBeamAxes.js';
import { autoFillSecondaryBeams } from './structuralAutoFill.js';
import { rulesFor } from './structureRules.js';
import { wallBeamAxisExcludeKey } from './wallBeamAxes.js';

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
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

test('5000×7000のベイ: 短辺方向（横梁）の梁芯が y=-4666.67・-2333.33 の2本。端の通り芯を extent に参照し由来は floorBeam。座標は丸めない', () => {
  const { graph, x0, x1 } = buildBay('S造');
  const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
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
    assert.equal(a.beamAxisOrigin, BeamAxisOrigin.FLOOR_BEAM);
    assert.equal(a.refId ?? null, null, 'refId は持たせない');
    assert.deepEqual([a.extentLoRef.clId, a.extentHiRef.clId], [x0.id, x1.id], 'extent は端の通り芯への参照');
    assert.deepEqual([a.extentLo, a.extentHi], [0, 5000], '解決後の extent は端の通り芯の位置');
  }
  // 既存の小梁生成が梁芯から子梁を作る（大梁面までの端部クリアランスは小梁生成側の規則）。
  const children = autoFillSecondaryBeams(graph, PROJECT);
  assert.equal(children.length, 2);
  assert.ok(children.every(b => b.role === 'secondary' && b.isVertical === false));
});

test('正方形のベイは横梁（材軸＝X）: 5000×5000 → 横梁の梁芯1本 y=-2500', () => {
  const { graph } = buildBay('S造', { width: 5000, height: 5000 });
  const { created } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].centerLineType, CenterLineType.HORIZONTAL);
  assert.equal(created[0].value, -2500);
});

test('幅が長辺のベイは縦梁: 7000×5000 → x=2333.33/4666.67 の縦梁芯2本（端は横の通り芯）', () => {
  const { graph, y0, y1 } = buildBay('S造', { width: 7000, height: 5000 });
  const { created } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  const axes = axesOf(created);
  assert.equal(axes.length, 2);
  assert.ok(axes.every(a => a.centerLineType === CenterLineType.VERTICAL));
  assert.deepEqual([axes[0].extentLoRef.clId, axes[0].extentHiRef.clId], [y0.id, y1.id]);
});

test('3595角のベイは1本（ceil(3595/2500)=2等分）', () => {
  const { graph } = buildBay('S造', { width: 3595, height: 3595 });
  const { created } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].value, -3595 + 3595 / 2);
});

test('【失敗系】短辺がちょうど2500のベイは作らず SHORT_SPAN、2501は作る', () => {
  const at = buildBay('S造', { width: MAX, height: 7000 });
  const r1 = autoFillSlabSecondaryBeamAxes(at.graph, PROJECT);
  assert.equal(r1.created.length, 0);
  assert.deepEqual(r1.skipped.map(s => s.reason), [SlabBayFillSkip.SHORT_SPAN]);
  const over = buildBay('S造', { width: MAX + 1, height: 7000 });
  const r2 = autoFillSlabSecondaryBeamAxes(over.graph, PROJECT);
  assert.ok(r2.created.length > 0, '2501 は作る');
  assert.deepEqual(r2.skipped, []);
});

test('【失敗系】辺が1本欠けるとベイにならず何も作らない（大梁を1本抜く）', () => {
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const b = buildBay('S造');
    b.graph.beamMap.delete(b[side].id);
    const { created, skipped } = autoFillSlabSecondaryBeamAxes(b.graph, PROJECT);
    assert.equal(created.length, 0, `${side} 欠け`);
    assert.deepEqual(skipped, [], `${side} 欠け: ベイが無いので報告もしない`);
  }
});

test('【失敗系】開口と面積で重なるベイは OPENING（開口の中心がベイの外でも）。辺で接するだけなら割り付ける', () => {
  // ベイ x:[0,5000] y:[-7000,0]。開口 x:[4000,6000] y:[-6500,-5500] は中心 (5000,-6000) がベイの辺上＝内部ではないが1000×1000で重なる。
  const overlap = buildBay('S造');
  const r1 = autoFillSlabSecondaryBeamAxes(overlap.graph, PROJECT, [rectOpening(4000, 6000, -6500, -5500)]);
  assert.equal(r1.created.length, 0);
  assert.equal(r1.created.length, 0);
  assert.deepEqual(r1.skipped.map(s => s.reason), [SlabBayFillSkip.OPENING]);
  // x:[5000,6000] はベイの右辺に接するだけ。
  const touch = buildBay('S造');
  const r2 = autoFillSlabSecondaryBeamAxes(touch.graph, PROJECT, [rectOpening(5000, 6000, -6500, -5500)]);
  assert.equal(r2.created.length, 2);
});

test('【失敗系】端が踊り場受け梁（LG）のベイは NO_HOST で作らない', () => {
  // 7000×5000 は縦梁（y方向に走る）で、上辺（y=-5000）が子梁の端になる。
  const { graph } = buildBay('S造', { width: 7000, height: 5000, topRole: 'landing' });
  const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.NO_HOST]);
});

test('【失敗系】hi 端（下辺 y=0）が踊り場受け梁（LG）のベイも NO_HOST で作らない', () => {
  const { graph } = buildBay('S造', { width: 7000, height: 5000, bottomRole: 'landing' });
  const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.NO_HOST]);
});

test('【失敗系】端の通り芯が無い（端が通り芯でない梁芯）ベイは NO_HOST', () => {
  const { graph, y0 } = buildBay('S造', { width: 7000, height: 5000 });
  // 子梁の端（上辺）の通り芯を通り芯でなくす（labeled:false の梁芯相当）。大梁は残るので境界にはなる。
  runInAction(() => { y0.labeled = false; });
  const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 0);
  assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.NO_HOST]);
});

test('同方向の通り芯と同座標の位置は作らない', () => {
  const { graph } = buildBay('S造');
  const yy = -7000 + 7000 / 3;
  graph.addCenterLine(CenterLineType.HORIZONTAL, yy, { labeled: true, discipline: Discipline.STRUCT });
  const { created } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].value, -7000 + 2 * (7000 / 3));
});

test('除外集合（手動削除済み）の座標は作らない', () => {
  const { graph } = buildBay('S造');
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, -7000 + 7000 / 3));
  const { created } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].value, -7000 + 2 * (7000 / 3));
});

test('【失敗系】ベイ内にユーザーの梁芯があれば丸ごと作らない（OCCUPIED）。直交する梁芯でも同じ', () => {
  for (const [type, value] of [[CenterLineType.HORIZONTAL, -3000], [CenterLineType.VERTICAL, 1000]]) {
    const { graph } = buildBay('S造');
    graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.FUSE, extentLo: -7000, extentHi: 5000, beamAxisOrigin: BeamAxisOrigin.USER });
    const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
    assert.equal(created.length, 0, `${type} の USER 梁芯`);
    assert.deepEqual(skipped.map(s => s.reason), [SlabBayFillSkip.OCCUPIED]);
  }
});

test('ベイと extent が重ならないユーザーの梁芯は邪魔しない（extent 付きは区間で判定）', () => {
  const { graph } = buildBay('S造');
  // x=1000 の縦梁芯だが extent が y:[-9000,-8000]（ベイの外）。
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: -9000, extentHi: -8000, beamAxisOrigin: BeamAxisOrigin.USER });
  const { created } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(created.length, 2);
});

test('冪等: 2回目は0本（自分の梁芯がベイ内にあり OCCUPIED）', () => {
  const { graph } = buildBay('S造');
  assert.equal(autoFillSlabSecondaryBeamAxes(graph, PROJECT).created.length, 2);
  const again = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.equal(again.created.length, 0);
  assert.deepEqual(again.skipped.map(s => s.reason), [SlabBayFillSkip.OCCUPIED]);
});

// 人が消したものが再計算で復活しない（team-lessons: 広い領域で梁芯を作る規則は削除→再計算を複数パス回して確かめる）。
function recomputePasses(graph, n = 3) {
  const made = [];
  for (let i = 0; i < n; i++) {
    made.push(...autoFillSlabSecondaryBeamAxes(graph, PROJECT).created, ...autoFillSecondaryBeams(graph, PROJECT));
  }
  return made;
}

test('梁芯を1本削除（除外集合へ記録）→再計算×3パスで復活しない。残りの梁芯・子梁は保たれる', () => {
  const { graph } = buildBay('S造');
  recomputePasses(graph, 1);
  const [first, second] = axesOf(graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.FLOOR_BEAM));
  // centerLineOps.js の梁芯削除と同じ手順（除外集合へ記録→removeCenterLine。子梁は道連れ）。
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, first.effectiveValue));
  graph.removeCenterLine(first.id);
  assert.equal(recomputePasses(graph, 3).length, 0, '3パスとも何も作らない');
  const left = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.FLOOR_BEAM);
  assert.deepEqual(left.map(cl => cl.id), [second.id]);
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, 1);
});

test('梁芯を両方削除しても除外集合があれば復活しない', () => {
  const { graph } = buildBay('S造');
  recomputePasses(graph, 1);
  for (const a of graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.FLOOR_BEAM)) {
    graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, a.effectiveValue));
    graph.removeCenterLine(a.id);
  }
  assert.equal(recomputePasses(graph, 3).length, 0);
});

test('子梁だけ削除（梁芯は残す）→再計算×3パスで梁も梁芯も復活しない', () => {
  const { graph } = buildBay('S造');
  recomputePasses(graph, 1);
  const axisIds = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.FLOOR_BEAM).map(cl => cl.id);
  const victim = graph.beams.find(b => b.role === 'secondary');
  graph.removeBeam(victim.id);
  assert.equal(recomputePasses(graph, 3).length, 0);
  assert.deepEqual(graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.FLOOR_BEAM).map(cl => cl.id), axisIds);
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, 1);
});

test('対象外の主構造は0本: SRC造・未定・在来木造・RC造(ラーメン/壁式)・2x4', () => {
  for (const structure of ['SRC造', '未定', '木造（在来）', 'RC造(ラーメン)', 'RC造(壁式)', '木造（2"×4"）']) {
    const { graph } = buildBay(structure);
    const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
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
  const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
  assert.deepEqual(skipped, []);
  // 下 y:[-8000,0] は ceil(8000/2500)=4 等分で3本、上 y:[-20000,-8000] は ceil(12000/2500)=5 等分で4本。
  assert.equal(created.length, 7);
  assert.ok(created.every(a => a.value !== -8000));
});

test('【失敗系】USER 由来の梁芯に乗る小梁は境界にしない（ベイは割れず、その梁芯がベイ内にあり OCCUPIED）', () => {
  const { graph } = buildBayWithMidBeam(BeamAxisOrigin.USER);
  const { created, skipped } = autoFillSlabSecondaryBeamAxes(graph, PROJECT);
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
const floorBeamAxisYs = (g) => g.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.FLOOR_BEAM)
  .map(cl => cl.value).sort((a, b) => a - b);

test('【失敗系・配線】recomputeStructuralForGraph: S造の矩形の吹抜けと重なるベイには梁芯を作らず、隣のベイには作る', async () => {
  // 吹抜け＝上半分 x:[0,6000] y:[0,6000]（2×2セル）。下のベイ y:[6000,12000]（6000角）は y=8000,10000 の2本。
  const g2 = await recomputeS2F([[0, 0, 3000, 3000], [3000, 0, 6000, 3000], [0, 3000, 3000, 6000], [3000, 3000, 6000, 6000]]);
  assert.deepEqual(floorBeamAxisYs(g2), [8000, 10000]);
});

test('【失敗系・配線】L字（非矩形）の吹抜けと重なるベイは OPENING: 梁芯・子梁を作らず、接しない隣のベイには作る', async () => {
  // 吹抜け＝L字（上半分の4セルのうち右下を除く3セル）。吹抜けは非矩形のため開口辺の矩形成分（openingEdgeComponents）には
  // 入らないが、開口セル矩形には入る。上半分のベイ（6000角）は L字と面積で重なるので割り付けない。
  const g2 = await recomputeS2F([[0, 0, 3000, 3000], [3000, 0, 6000, 3000], [0, 3000, 3000, 6000]]);
  assert.deepEqual(floorBeamAxisYs(g2), [8000, 10000], '上半分（L字と重なる）には無く、下のベイにだけある');
  assert.equal(g2.beams.filter(b => b.role === 'secondary').length, 2, '子梁も下のベイの2本だけ');
});
