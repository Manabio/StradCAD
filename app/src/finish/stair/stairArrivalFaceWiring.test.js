// 到達辺＝上階（N+1）の床梁の外面＋壁仕上げ（S2）: 展開図（stairContribution）・天伏の裏面（stairSoffitSolids）・
// 立体の段（stairTreadFootprints）が、aboveGraph を受けると平面（uTurnPlanLayout）と同じ到達辺（通り芯＋72.5）になり、
// 省略（上階グラフが無い経路）では従来の Q3（＋57.5）に戻ることを実物の PlanGraph で確かめる。
// フィクスチャは stairUTurnPlanLayout.test.js の equalFixture／aboveWithBeam と同じ作り（等長レーン・上り・木造・隔て壁つき）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { uTurnPlanLayout } from './stairGeometry.js';
import { stairTreadFootprints } from './stairTreads.js';
import { generateStairPartitionWalls } from './stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { stairContribution } from '../../elevation/section/sectionStair.js';
import { stairSoffitSolids } from '../../ceiling/stairSoffit.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const EPS = 1e-6;

// 縦走行（up）。踊り場は y 0..1000、往路・復路は y 1000..4000。基端の通り芯は y=4000。階段は y の小さい側へ上る
function fixture() {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = [0, 1000, 2000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const Hl = [0, 1000, 4000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const keys = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) keys.push(`${V[i].id}:${Hl[j].id}:${V[i + 1].id}:${Hl[j + 1].id}`);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(keys), sections: [6, 1, 6], flip: false, upDirection: 'up' });
  stair.structure = StructuralMaterialType.WOOD;
  graph.setStructureOverride('木造（在来）');
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
  return { graph, stair };
}
// 上階: 到達辺（y=4000）に幅 120 の梁（横梁・x 0..2000）
function aboveWithBeam() {
  const above = new PlanGraph(new Plane('p2', 3000, '2階', 2, 1));
  const axis = above.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.STRUCT });
  const mk = v => above.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.STRUCT });
  above.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axis, false, mk(0), mk(2000), {});
  return above;
}
const Q3 = 4000 - 57.5, FACE = 4000 - 72.5;

test('stairContribution: aboveGraph で復路の到達辺（frame 外の最終蹴上）が梁の面＋仕上げ。省略は Q3。平面の run.baseB と同じ', () => {
  const { graph, stair } = fixture();
  const above = aboveWithBeam();
  const withAbove = stairContribution(stair, graph, 2800, above);
  const without = stairContribution(stair, graph, 2800);
  assert.ok(withAbove && without);
  assert.equal(uTurnPlanLayout(stair, graph, { aboveGraph: above }).run.baseB, FACE);
  // 復路の到達側の端（forwardSign で歩く向きの終端）が平面の baseB と一致する
  const baseEnd = c => c.flights.at(-1).runHi; // 最後の flight＝復路。up は基端（y 大）側が到達辺
  assert.ok(Math.abs(baseEnd(withAbove) - FACE) < EPS, `面 ${baseEnd(withAbove)}`);
  assert.ok(Math.abs(baseEnd(without) - Q3) < EPS, `Q3 ${baseEnd(without)}`);
  assert.notEqual(withAbove.flights.at(-1).lengthMm, without.flights.at(-1).lengthMm, '復路の区間（ピッチ）が伸びる');
});

test('stairSoffitSolids: aboveGraph で columnBases の arrivalFlat.run（到達辺）が梁の面。省略は Q3', () => {
  const { graph, stair } = fixture();
  const args = { stair, graph, riser: 200, floorZMm: 2800 };
  const a = stairSoffitSolids({ ...args, aboveGraph: aboveWithBeam() })[0];
  const b = stairSoffitSolids(args)[0];
  assert.ok(a && b);
  assert.ok(Math.abs(a.arrivalFlat.run - FACE) < EPS, `面 ${a.arrivalFlat.run}`);
  assert.ok(Math.abs(b.arrivalFlat.run - Q3) < EPS, `Q3 ${b.arrivalFlat.run}`);
});

test('stairTreadFootprints: aboveGraph で復路の最終マスの到達辺が梁の面。省略は Q3。梁が走行に平行なら動かない（失敗系）', () => {
  const { graph, stair } = fixture();
  const lastEdge = (aboveGraph) => {
    const cells = stairTreadFootprints(stair, graph, { riser: 100, insetView: 'install', aboveGraph });
    const last = cells.reduce((m, c) => (c.number > m.number ? c : m));
    const ys = last.poly.filter((_, i) => i % 2 === 1);
    return Math.max(...ys);
  };
  assert.ok(Math.abs(lastEdge(aboveWithBeam()) - FACE) < EPS, `面 ${lastEdge(aboveWithBeam())}`);
  assert.ok(Math.abs(lastEdge(undefined) - Q3) < EPS, `Q3 ${lastEdge(undefined)}`);
  const par = new PlanGraph(new Plane('p3', 3000, '2階', 2, 1));
  const ax = par.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.STRUCT });
  const mk = v => par.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.STRUCT });
  par.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', ax, true, mk(0), mk(4000), {});
  assert.ok(Math.abs(lastEdge(par) - Q3) < EPS, '走行に平行な梁は無視');
});

// ---- 配線（.jsx 以外もソース走査で固定する。コメント行・ブロックコメントを除いた 1 行まるごと一致）
import fs from 'node:fs';
import path from 'node:path';
const codeLines = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.trim()).filter(l => !l.startsWith('//'));
const has = (rel, line) => assert.ok(codeLines(rel).includes(line), `${rel}: ${line}`);

test('【配線】aboveGraph は展開図・天伏・立体の各呼び出し元から uTurnPlanLayout／stairTreadFootprints まで渡る', () => {
  has('../../elevation/section/sectionStair.js', 'export function stairContribution(stair, graph, floorHeight, aboveGraph = null) {');
  has('../../elevation/section/sectionStair.js', 'const layout = uTurnPlanLayout(stair, graph, { aboveGraph });');
  has('../../elevation/elevationBand.js', 'const contribution = stairContribution(stair, graph, floorHeight, aboveGraph);');
  has('../../elevation/elevationBand.js', 'stairOver: stairContributionOverRoom(room, graph, ctx.solids?.floorHeightMm, ctx.solids?.upperGraph ?? null) });');
  has('../../elevation/section/cuts/switchbackCuts.js', 'const contribution = stairContribution(stair, graph, floorHeight, opts.upperGraph ?? null);');
  has('../../elevation/section/sectionContent.js', 'const contribution = stairContribution(stair, layer.graph, floorHeight, above?.graph ?? probeCtx?.upperGraph ?? null);');
  has('../../ceiling/stairSoffit.js', 'const L = uTurnPlanLayout(stair, graph, { aboveGraph });');
  has('../../ceiling/stairSoffit.js', 'export function stairSoffitSolids({ stair, graph, belowStair = null, belowGraph = null, riser, floorZMm, aboveGraph = null }) {');
  has('../../elevation/elevationStairSequence.js', 'return Number.isFinite(riser) ? (stairSoffitSolids({ stair, graph, riser, floorZMm: floorZ0, aboveGraph: opts.upperGraph ?? null })[0] ?? null) : null;');
  has('../../elevation/elevationStairSequence.js', 'const found = stairUnderReturnSoffit(stair, graph, { floorHeight, floorZMm, aboveGraph });');
  has('../../elevation/elevationStairSequence.js', 'const underReturn = underReturnSpaceOf(stair, graph, cut, floorHeight, selfFloorZ, ceilLowAbs, opts.upperGraph ?? null);');
  has('../../elevation/section/sectionProbe.js', 'const solid = stairSoffitSolids({ stair, graph, riser, floorZMm, aboveGraph })[0];');
  has('../../elevation/section/sectionProbe.js', 'const found = stairUnderReturnSoffit(stair, graph, { floorHeight, floorZMm: floorZFor(room, layer), aboveGraph });');
  has('../../elevation/section/sectionProbe.js', 'addUnderReturnTops(out, graph, above ? above.floorZMm - layer.floorZMm : fallbackFloorHeightMm, layer, floorZFor, above?.graph ?? fallbackUpperGraph);');
  has('../../elevation/section/sectionProbe.js', 'if (!m) { m = buildWallTopProfiles(layers, layer, spaceIndex.floorZFor, opts.floorHeightMm ?? null, opts.upperGraph ?? null); wallTopByLayer.set(layer, m); }');
  has('../../elevation/section/sectionProbe.js', 'upperGraph: opts.upperGraph ?? null,');
  has('../../elevation/elevationBand.js', 'const probeCtx = makeProbeContext(layers, { floorOffsetMm: bandFloorOffsetMm(room, graph), floorHeightMm: opts.floorHeightMm, upperGraph: opts.upperGraph ?? null });');
  has('../../elevation/section/sectionStair.js', "? stairTreadFootprints(stair, graph, { riser, insetView: 'install', aboveGraph }) : [];");
  has('stairTreads.js', "view: 'upper', insetView, detail: false, riser, spans: measureStairSpans(stair, graph), laneGap: true, graph, aboveGraph, collectCells: true,");
  has('../../plan/planSolids.js', 'for (const t of stairTreadFootprints(stair, layer.graph, { riser: riserFor(stair), insetView, aboveGraph })) {');
  has('../../plan/planSolids.js', 'opts.lookUp === true && layer.role === \'self\' ? stairsContinuedAbove(layer, layers, opts) : null, upperGraph),');
});

test('T1【到達口が側面】取りつき区画（zoneCells.arrival）の外縁も aboveGraph で梁の面になり、平面の run.baseB と一致する。省略は Q3 側', () => {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = Hh(0), ym = Hh(1500), yz = Hh(3500), y1 = Hh(4500);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const cells = new Set([k(x0, y0, x1, ym), k(x0, ym, xm, yz), k(x0, yz, xm, y1), k(xm, ym, x1, yz), k(xm, yz, x1, y1)]);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], upDirection: 'up', flip: false, entrySide: 'end', arrivalSide: 'left', entryTurnSteps: 0, arrivalTurnSteps: 2 });
  stair.structure = StructuralMaterialType.WOOD;
  graph.setStructureOverride('木造（在来）');
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
  const above = new PlanGraph(new Plane('p2', 3000, '2階', 2, 1));
  const axis = above.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.STRUCT });
  const mk = v => above.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.STRUCT });
  above.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axis, false, mk(0), mk(2000), {});
  const outerEdge = c => Math.max(...c.zoneCells.arrival.flatMap(z => z.poly.filter((_, i) => i % 2 === 1))); // up は基端（y 大）が外縁
  const withAbove = stairContribution(stair, graph, 2800, above);
  const without = stairContribution(stair, graph, 2800);
  const baseB = uTurnPlanLayout(stair, graph, { aboveGraph: above }).run.baseB;
  assert.ok(Math.abs(baseB - (4500 - 72.5)) < EPS, `前提: 平面の baseB は面 ${baseB}`);
  assert.ok(Math.abs(outerEdge(withAbove) - baseB) < EPS, `区画の外縁 ${outerEdge(withAbove)} vs ${baseB}`);
  assert.ok(Math.abs(outerEdge(without) - uTurnPlanLayout(stair, graph).run.baseB) < EPS, '省略は従来の baseB');
});

test('T2【立体の段】planSolids の below 層の stairTread の最終マスの到達辺が、self 層の梁の面（通り芯±72.5）になる', async () => {
  const { planSolids } = await import('../../plan/planSolids.js');
  const { graph: low, stair } = fixture();
  const above = aboveWithBeam();
  const layers = [
    { graph: above, role: 'self', floorZMm: 2800 },
    { graph: low, role: 'below', floorZMm: 0 },
  ];
  const lastEdge = (ls) => {
    const ts = planSolids(ls, { riserOf: () => 200 }).filter(s => s.kind === 'stairTread' && s.source?.id === stair.id);
    assert.ok(ts.length > 0, 'stairTread が出る');
    const last = ts.reduce((m, s) => (s.source.part > m.source.part ? s : m));
    return Math.max(...last.footprint.poly.filter((_, i) => i % 2 === 1));
  };
  assert.ok(Math.abs(lastEdge(layers) - FACE) < EPS, `面 ${lastEdge(layers)}`);
  // 対照: 上階（self）に梁が無ければ Q3
  const noBeam = [{ graph: new PlanGraph(new Plane('p3', 3000, '2階', 2, 1)), role: 'self', floorZMm: 2800 }, layers[1]];
  assert.ok(Math.abs(lastEdge(noBeam) - Q3) < EPS, `Q3 ${lastEdge(noBeam)}`);
});
