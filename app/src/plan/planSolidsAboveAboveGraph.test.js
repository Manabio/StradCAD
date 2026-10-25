// N+2 の graph（aboveGraph）を、N+1 の階段の裏面（stairSoffitAbove＝展開図の E5／planSolids の stairUndersideOf＝天伏の見上げ）へ
// 渡す受け口（S10-6 S1）の単体テスト。値は呼び元（ElevationModeState・PlanSolidsLayer）がまだ渡さない＝本番の出力は不変。
// フィクスチャは finish/stair/stairArrivalFaceWiring.test.js と同じ作り（等長レーン・上り・木造・隔て壁つき）を N と N+1 に置く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { stairSoffitSolids } from '../ceiling/stairSoffit.js';
import { stairSoffitAbove } from '../elevation/space/stairSoffitCeiling.js';
import { planSolidsLayerSolids, planSolidsLayerSolidsUp, planSolidsLayerCacheSpec } from './planSolidsLayerFilter.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const STRUCT = { labeled: false, discipline: Discipline.STRUCT };
const Q3 = 4000 - 57.5, FACE = 4000 - 72.5;
const EPS = 1e-6;
const FH = 2800, RISER = 200;

// 縦走行（up）の木造 SWITCHBACK。階 floor の graph と階段（隔て壁つき）
function stairGraph(id, elevation, floor) {
  const graph = new PlanGraph(new Plane(id, elevation, `${floor}階`, floor, 1));
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
// N+2: 到達辺（y=4000）に幅 120 の梁（横梁・x 0..2000）
function aboveWithBeam() {
  const above = new PlanGraph(new Plane('p3', 6000, '3階', 3, 1));
  const axis = above.addCenterLine(CenterLineType.HORIZONTAL, 4000, STRUCT);
  const mk = v => above.addCenterLine(CenterLineType.VERTICAL, v, STRUCT);
  above.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axis, false, mk(0), mk(2000), {});
  return above;
}
// 関係の無い N+2: 梁なし／走行に平行な梁だけ
const aboveEmpty = () => new PlanGraph(new Plane('p3', 6000, '3階', 3, 1));
function aboveParallel() {
  const par = new PlanGraph(new Plane('p3', 6000, '3階', 3, 1));
  const ax = par.addCenterLine(CenterLineType.VERTICAL, 4000, STRUCT);
  const mk = v => par.addCenterLine(CenterLineType.HORIZONTAL, v, STRUCT);
  par.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', ax, true, mk(0), mk(4000), {});
  return par;
}

const scene = () => ({ n: stairGraph('p1', 0, 1), u: stairGraph('p2', 3000, 2) });
const sofArgs = (n, u, aboveGraph) => ({
  stair: n.stair, graph: n.graph, upperGraph: u.graph, floorHeightMm: FH, riserOf: () => RISER, ...(aboveGraph === undefined ? {} : { aboveGraph }),
});
const upSolids = (n, u, aboveAboveGraph) => planSolidsLayerSolidsUp({
  graph: n.graph, abovePeek: { graph: u.graph, floorHeightMm: FH, ...(aboveAboveGraph === undefined ? {} : { aboveAboveGraph }) }, aboveRiserOf: () => RISER,
});
const soffitOfUp = solids => solids.find(s => s.source?.kind === 'stairSoffit');
// 関数（zAt）を落として構造だけ比べる
const plain = solids => JSON.parse(JSON.stringify(solids));
const sample = (s, pts) => pts.map(([x, y]) => s.zAt(x, y));
const PTS = [[500, 500], [500, 2000], [500, 3500], [1500, 3900], [1500, 1500]];

test('【S1】stairSoffitAbove: aboveGraph（N+2 の梁）で到達辺が梁の面。省略・null は Q3。stairSoffitSolids と同じ立体', () => {
  const { n, u } = scene();
  const above = aboveWithBeam();
  const withAbove = stairSoffitAbove(sofArgs(n, u, above));
  const without = stairSoffitAbove(sofArgs(n, u));
  assert.ok(withAbove && without);
  assert.ok(Math.abs(withAbove.solid.arrivalFlat.run - FACE) < EPS, `面 ${withAbove.solid.arrivalFlat.run}`);
  assert.ok(Math.abs(without.solid.arrivalFlat.run - Q3) < EPS, `Q3 ${without.solid.arrivalFlat.run}`);
  const direct = stairSoffitSolids({ stair: u.stair, graph: u.graph, belowStair: n.stair, belowGraph: n.graph, riser: RISER, floorZMm: FH, aboveGraph: above })[0];
  assert.deepEqual(plain(withAbove.solid.footprint), plain(direct.footprint));
  assert.deepEqual(sample(withAbove.solid, PTS), sample(direct, PTS));
  assert.deepEqual(plain(stairSoffitAbove(sofArgs(n, u, null)).solid), plain(without.solid), 'null は省略と同じ');
});

test('【S1】planSolidsLayerSolidsUp: abovePeek.aboveAboveGraph で N+1 の層の裏面が stairSoffitAbove と同じ立体（到達辺は梁の面）。N+1 の層の立体が変わる', () => {
  const { n, u } = scene();
  const above = aboveWithBeam();
  const viaPlan = soffitOfUp(upSolids(n, u, above));
  const viaElev = stairSoffitAbove(sofArgs(n, u, above)).solid;
  assert.ok(viaPlan, '前提: 見上げの裏面が引ける');
  assert.ok(Math.abs(viaPlan.arrivalFlat.run - FACE) < EPS, `面 ${viaPlan.arrivalFlat.run}`);
  assert.deepEqual(plain(viaPlan.footprint), plain(viaElev.footprint), '展開図と見上げで同じ立体');
  assert.deepEqual(sample(viaPlan, PTS), sample(viaElev, PTS));
  const base = upSolids(n, u);
  assert.ok(Math.abs(soffitOfUp(base).arrivalFlat.run - Q3) < EPS, '対照: N+2 なしは Q3');
  // 供給源は 1 つ: 足元の壁の天端・段の占有形も同じ N+2 を読むので、N+1 の層の立体全体が変わる
  assert.notDeepEqual(plain(upSolids(n, u, above)), plain(base));
});

test('【S1・失敗系】N+2 が null・梁なし・走行に平行な梁・peek に無い場合は今の出力と同じ', () => {
  const { n, u } = scene();
  const base = plain(upSolids(n, u));
  assert.deepEqual(plain(upSolids(n, u, null)), base, 'null');
  assert.deepEqual(plain(upSolids(n, u, aboveEmpty())), base, '梁なし');
  assert.deepEqual(plain(upSolids(n, u, aboveParallel())), base, '走行に平行な梁');
  const sof = stairSoffitAbove(sofArgs(n, u));
  assert.deepEqual(plain(stairSoffitAbove(sofArgs(n, u, aboveEmpty())).solid), plain(sof.solid), 'stairSoffitAbove も梁なしは不変');
  assert.deepEqual(plain(stairSoffitAbove(sofArgs(n, u, aboveParallel())).solid), plain(sof.solid), 'stairSoffitAbove も平行な梁は不変');
  // 上階（N+1）が無い peek では N+2 があっても何も起きない
  assert.deepEqual(plain(planSolidsLayerSolidsUp({ graph: n.graph, abovePeek: { graph: null, floorHeightMm: FH, aboveAboveGraph: aboveWithBeam() } })),
    plain(planSolidsLayerSolidsUp({ graph: n.graph, abovePeek: null })));
});

test('【S1】見下げ（planSolidsLayerSolids）は N+2 を受けず不変。見上げの鍵だけ N+2 の plane で変わる', () => {
  const { n, u } = scene();
  const above = aboveWithBeam();
  const peekDown = { graph: n.graph, floorHeightMm: FH };
  const downBase = plain(planSolidsLayerSolids({ graph: u.graph, belowPeek: peekDown, selfRiserOf: () => RISER }));
  const downWith = plain(planSolidsLayerSolids({ graph: u.graph, belowPeek: { ...peekDown, aboveAboveGraph: above }, selfRiserOf: () => RISER }));
  assert.deepEqual(downWith, downBase, '見下げは aboveAboveGraph を読まない');
  const peekUp = { graph: u.graph, floorHeightMm: FH, activePlaneId: n.graph.plane.id };
  const k0 = planSolidsLayerCacheSpec(n.graph, peekUp, 'up').key;
  const k1 = planSolidsLayerCacheSpec(n.graph, { ...peekUp, aboveAboveGraph: above }, 'up').key;
  assert.notEqual(k0, k1, '見上げの鍵は N+2 で変わる');
  assert.ok(k1.endsWith(`:${above.plane.id}`) && k0.endsWith(':-'));
  assert.equal(planSolidsLayerCacheSpec(n.graph, { ...peekUp, aboveAboveGraph: above }, 'down').key,
    planSolidsLayerCacheSpec(n.graph, peekUp, 'down').key, '見下げの鍵は N+2 に依らない');
});
