// 展開図の階段（stairContribution）の走行方向の位置が平面（install の踏面線）と一致することの単体テスト
// （ユーザー裁定 2026-10-09「展開図の階段位置を平面に揃える」S2a）。
// 主ゲート: 展開図の蹴上（段鼻）の走行座標の集合 ＝ 平面の踏面線（走行軸に直交する線分で、その切断線＝レーン中央を横切るもの）の
// 走行座標の集合（±0.5mm、両方向）。期待値は uTurnPlanLayout ではなく buildStairGeometry の描画線から取る
// （stairContribution が使う値の写しにしない）。回り段（扇形）は S2b まで等間隔の近似のため、直進部だけを比べる。
// フィクスチャは stairUTurnPlanLayout.test.js（張り出し f,b,c,d,a・等長レーン）と同じ流儀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { classifyStairArea, measureStairSpans } from '../../finish/stair/stairClassify.js';
import { buildStairGeometry, uTurnPlanLayout } from '../../finish/stair/stairGeometry.js';
import { roomBounds } from '../../finish/gridCells.js';
import { PARTITION_THICKNESS_MM } from '../../finish/stair/stairPartition.js';
import { generateStairPartitionWalls } from '../../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { stairRunProfile } from '../elevationStairSection.js';
import { stairContribution, stairAxisIsVertical, ladderAcrossRange, landingStepRisers, stairPrimitivesForCut, withCutLandings, stairOccluderRects, stairFaceHits } from './sectionStair.js';
import { localXOf } from './sectionTypes.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const TOL = 0.5;
const FLOOR_HEIGHT = 2800;

// 張り出し（往路が長い）: 2列×3行  d c / a b / e f（y下向き正）。f,b,c,d,a の順で歩く（上り口＝f の左辺・到達口＝a の下辺）
function overhangFixture(entryTurnSteps) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = Hh(0), y1 = Hh(1000), y2 = Hh(2000), y3 = Hh(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const c = { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), f: k(x1, y2, x2, y3) };
  const keys = ['f', 'b', 'c', 'd', 'a'].map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, FLOOR_HEIGHT, keys);
  const stair = graph.addStair({
    type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections,
    entryTurnSteps, arrivalTurnSteps: cls.arrivalTurnSteps ?? 0,
  });
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  return { graph, stair };
}

// 折返し（SWITCHBACK）の側面の上り口: 往路の基端の行（y3500..4500）を切り、取りつき回転部 entryTurnSteps 段を載せる
// （switchbackCuts.test.js の sideEntry と同じ構成。往路 x0..1000・復路 x1000..2000・踊り場 y0..1500）
// arrival=true なら復路の基端の行（y3500..4500）も切り、到達口を側面（外側）にする（arrivalTurnSteps 段の区画）。
// flip=true は往路が東・復路が西（左右の側面指定は進行方向基準なので、flip では側面になる側を探して選ぶ）
function sideEntrySwitchback(entryTurnSteps, { arrival = false, arrivalTurnSteps = 1, flip = false, structure = StructuralMaterialType.WOOD } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = Hh(0), ym = Hh(1500), yz = Hh(3500), y1 = Hh(4500);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  // 往路の列（flip=false は西 x0..xm・true は東 xm..x1）。復路は反対の列
  const [aL, aR, bL, bR] = flip ? [xm, x1, x0, xm] : [x0, xm, xm, x1];
  const cells = new Set([k(x0, y0, x1, ym), k(aL, ym, aR, yz), k(aL, yz, aR, y1),
    ...(arrival ? [k(bL, ym, bR, yz), k(bL, yz, bR, y1)] : [k(bL, ym, bR, y1)])]);
  const make = (entrySide, arrivalSide) => {
    const g = graph;
    const st = g.addStair({
      type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], upDirection: 'up', flip, entryTurnSteps, entrySide,
      ...(arrival ? { arrivalSide, arrivalTurnSteps } : {}),
    });
    st.structure = structure;
    return st;
  };
  // 側面の口になる辺（'left'/'right'）を探す: 上り口は往路の外側、到達口は復路の外側（内側は区画にならず走行端のまま）
  let stair = null;
  for (const [es, as] of [['left', 'left'], ['left', 'right'], ['right', 'left'], ['right', 'right']]) {
    const cand = make(es, as);
    const p = uTurnPlanLayout(cand, graph);
    if (p && p.entryPort !== 'end' && (!arrival || p.arrivalPort !== 'end')) { stair = cand; break; }
    graph.removeStair?.(cand.id);
  }
  graph.setStructureOverride('木造（在来）'); // 隔て壁の生成規則（addPartitionWalls で明示的に足したときだけ壁が立つ）。階段の構造は stair.structure
  return { graph, stair };
}

// 等長レーン＋全幅の踊り場（4方向）。dir＝上り方向。踊り場は上り方向の奥側の1行（幅1000）、往路・復路は残り3000
function equalFixture(type, dir, flip, { wood = true } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const vertical = dir === 'up' || dir === 'down';
  const along = { up: [0, 1000, 4000], down: [0, 3000, 4000], left: [0, 1000, 4000], right: [0, 3000, 4000] }[dir];
  const across = [0, 1000, 2000];
  const xs = vertical ? across : along, ys = vertical ? along : across;
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const Hl = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const cell = (i, j) => `${V[i].id}:${Hl[j].id}:${V[i + 1].id}:${Hl[j + 1].id}`;
  const keys = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) keys.push(cell(i, j));
  const stair = graph.addStair({ type, cells: new Set(keys), sections: [6, type === StairType.WINDING ? 2 : 1, 6], flip, upDirection: dir });
  stair.structure = wood ? StructuralMaterialType.WOOD : StructuralMaterialType.STEEL;
  graph.setStructureOverride('木造（在来）');
  return { graph, stair };
}

// 隔て壁（オーナー壁＋薄壁）を足し、両端の自由端を柱包み（物理端のはね出し ±57.5）にする
const addPartitionWalls = (graph) => {
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
};
const VARIANTS = [['柱材の面（壁なし）', () => {}], ['PB の外面（包み壁あり）', addPartitionWalls]];

// 設置階の枠（insetView 'install'）で全段を描いた平面（view 'upper'＝破れで打ち切らない。stairTreadFootprints と同じ）
const installGeom = (stair, graph) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view: 'upper', insetView: 'install', detail: true, riser: 200, spans: measureStairSpans(stair, graph), laneGap: true, graph,
});

// 走行軸に直交する線分のうち、幅方向の位置 across を横切るものの走行座標（縦走行なら y・横走行なら x）
function planRunsAcross(segs, vertical, across) {
  const out = [];
  for (const t of segs) {
    const perp = vertical ? Math.abs(t.y1 - t.y2) < 1e-9 : Math.abs(t.x1 - t.x2) < 1e-9;
    if (!perp) continue;
    const [a1, a2] = vertical ? [t.x1, t.x2] : [t.y1, t.y2];
    if (across < Math.min(a1, a2) - 1e-9 || across > Math.max(a1, a2) + 1e-9) continue;
    out.push(vertical ? t.y1 : t.x1);
  }
  return out;
}

// 展開図の flight の蹴上（段鼻）の走行座標（世界）。flight は直進部だけ（側面の口の区画は zoneCells のスライスで別に照合する）
function elevationNoses(flight) {
  const prof = stairRunProfile(flight.steps, flight.riserMm, flight.lengthMm, 0, 0, 1, 0);
  const worldStart = flight.travelSign > 0 ? flight.runLo : flight.runHi;
  return prof.noses.map(([x]) => worldStart + flight.travelSign * x);
}

// 集合として ±TOL で一致するか（両方向）。差分は文言に出す
function assertSameSet(actual, expected, tag) {
  const miss = expected.filter(e => !actual.some(a => Math.abs(a - e) <= TOL));
  const extra = actual.filter(a => !expected.some(e => Math.abs(a - e) <= TOL));
  assert.deepEqual({ miss, extra }, { miss: [], extra: [] }, `${tag}: 展開図の蹴上=${JSON.stringify(actual)} 平面の踏面線=${JSON.stringify(expected)}`);
}

// 往路・復路の蹴上の集合を平面の踏面線と突き合わせる（直進部だけ。取りつき区画の扇形は zoneBoundaryCheck）
function assertFlightsMatchPlan(graph, stair, tag) {
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c, tag);
  const p = uTurnPlanLayout(stair, graph);
  const g = installGeom(stair, graph);
  const vertical = c.isVertical;
  const [ob, ib] = c.flights;
  const mid = (f) => (f.acrossLo + f.acrossHi) / 2;
  // 往路: レーン中央を横切る踏面線（側面の上り口なら区画の出口境界も踏面線）∪（走行端の上り口なら基端＝最初の蹴上の辺）
  const lo = ob.runLo - TOL, hi = ob.runHi + TOL;
  const planOut = planRunsAcross(g.treads, vertical, mid(ob)).filter(r => r >= lo && r <= hi);
  if (p.entryPort === 'end') planOut.push(p.run.baseA);
  assertSameSet(elevationNoses(ob), planOut, `${tag} 往路`);
  // flight の走行範囲（runLo/runHi。切断線が flight を横切るかの判定に使う）は蹴上の範囲と矛盾しない
  const obNoses = elevationNoses(ob);
  const obEnd = ob.travelSign > 0 ? ob.runHi : ob.runLo;
  assert.ok(Math.abs(Math.max(...obNoses.map(x => x * ob.travelSign)) * ob.travelSign - obEnd) <= TOL, `${tag} 往路: 終端の蹴上＝走行範囲の終端`);
  const ibNoses = elevationNoses(ib);
  assert.ok(Math.abs(Math.min(...ibNoses) - ib.runLo) <= TOL && Math.abs(Math.max(...ibNoses) - ib.runHi) <= TOL, `${tag} 復路: 蹴上の範囲＝走行範囲`);
  // 復路: レーン中央を横切る踏面線 ∪ 到達辺（最後の蹴上）
  const lo2 = Math.min(ib.runLo, ib.runHi) - TOL, hi2 = Math.max(ib.runLo, ib.runHi) + TOL;
  const planIn = planRunsAcross(g.treads, vertical, mid(ib)).filter(r => r >= lo2 && r <= hi2);
  planIn.push(p.run.startB);
  assertSameSet(elevationNoses(ib), planIn, `${tag} 復路`);
  return { c, p, g };
}

// ---------------------------------------------------------------- 主ゲート

test('主ゲート: 張り出し（f,b,c,d,a。classifyStairArea が WINDING と判定する側面の上り口）× 隔て壁なし/PB 包み × 取りつき回転部 0/1 段で、展開図の蹴上＝平面の踏面線（両方向）', () => {
  for (const [name, setup] of VARIANTS) {
    for (const e of [0, 1]) {
      const tag = `${name}/e=${e}`;
      const { graph, stair } = overhangFixture(e);
      assert.equal(stair.type, StairType.WINDING, '前提: 回り階段');
      setup(graph);
      const { c, p } = assertFlightsMatchPlan(graph, stair, tag);
      assert.equal(p.entryTurnSteps, e, tag);
      assert.equal(c.flights[0].steps, p.n1, `${tag}: 往路の蹴上数＝直進部だけ（取りつき段は区画のセル）`);
      assert.equal(c.zoneCells.entry.length, 1, `${tag}: 上り口の区画のセルは 1 枚（e=1 の 1 段、e=0 の平場の矩形）`);
    }
  }
});

test('主ゲート: 折返し（SWITCHBACK）の側面の上り口 × 隔て壁なし/PB 包み × 取りつき回転部 0/1 段で、展開図の蹴上＝平面の踏面線（両方向）', () => {
  for (const [name, setup] of VARIANTS) {
    for (const e of [0, 1]) {
      const tag = `折返し/${name}/e=${e}`;
      const { graph, stair } = sideEntrySwitchback(e);
      setup(graph);
      const p = uTurnPlanLayout(stair, graph);
      assert.notEqual(p.entryPort, 'end', `${tag}: 前提: 側面の上り口（entrySide 'left'＝外側）`);
      const { c } = assertFlightsMatchPlan(graph, stair, tag);
      assert.equal(c.flights[0].steps, p.n1, tag);
    }
  }
});

test('主ゲート: 到達口が側面（区画あり）でも、復路は front から直進部の終端 startB（区画の出口）までで、蹴上＝平面の踏面線', () => {
  for (const [name, setup] of VARIANTS) {
    const tag = `到達口が側面/${name}`;
    const { graph, stair } = sideEntrySwitchback(0, { arrival: true });
    setup(graph);
    const p = uTurnPlanLayout(stair, graph);
    assert.notEqual(p.arrivalPort, 'end', `${tag}: 前提`);
    assert.notEqual(p.run.startB, p.run.baseB, `${tag}: 前提: 直進部の終端は到達辺ではなく区画の出口`);
    const { c } = assertFlightsMatchPlan(graph, stair, tag);
    assert.equal(c.flights[1].steps, p.n2, `${tag}: 復路は直進部の n2 段だけ`);
    assert.equal(Math.abs(c.flights[1].lengthMm - Math.abs(p.run.startB - p.run.front)) < TOL, true, tag);
  }
});

test('主ゲート: 取りつき回転部 2・3 段（扇形の区画）でも直進部の蹴上が平面の踏面線と一致する（区画は zoneBoundaryCheck）', () => {
  for (const [name, setup] of VARIANTS) {
    for (const e of [2, 3]) {
      const tag = `e=${e}/${name}`;
      const { graph, stair } = overhangFixture(e);
      setup(graph);
      const { c } = assertFlightsMatchPlan(graph, stair, tag);
      assert.equal(c.flights[0].steps, uTurnPlanLayout(stair, graph).n1, tag);
    }
  }
});

test('主ゲート: 等長レーン（4方向×flip×SWITCHBACK/WINDING×柱の変種）でも展開図の蹴上＝平面の踏面線（縦走行は y・横走行は x）', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    for (const dir of ['up', 'down', 'left', 'right']) {
      for (const flip of [false, true]) {
        for (const [name, setup] of VARIANTS) {
          const tag = `${type}/${dir}/flip=${flip}/${name}`;
          const { graph, stair } = equalFixture(type, dir, flip);
          setup(graph);
          assertFlightsMatchPlan(graph, stair, tag);
        }
      }
    }
  }
});

test('主ゲート: 鉄骨（隔て壁なし・あき 100）の SWITCHBACK/WINDING でも一致し、内縁はレーン中央のまま（あきは ladderAcrossRange が一度だけ引く）', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    const { graph, stair } = equalFixture(type, 'up', false, { wood: false });
    const { c, p } = assertFlightsMatchPlan(graph, stair, `鉄骨/${type}`);
    const [ob, ib] = c.flights;
    // 内縁（レーン境界側）は across.mid そのもの。外縁は平面の壁の面（across.s0 / across.s1）
    assert.equal(Math.max(ob.acrossLo, ob.acrossHi) === p.across.mid || Math.min(ob.acrossLo, ob.acrossHi) === p.across.mid, true, `${type}: 往路の内縁=mid`);
    assert.equal(Math.max(ib.acrossLo, ib.acrossHi) === p.across.mid || Math.min(ib.acrossLo, ib.acrossHi) === p.across.mid, true, `${type}: 復路の内縁=mid`);
    const outer = [Math.min(ob.acrossLo, ob.acrossHi, ib.acrossLo, ib.acrossHi), Math.max(ob.acrossLo, ob.acrossHi, ib.acrossLo, ib.acrossHi)];
    assert.deepEqual(outer, [Math.min(p.across.s0, p.across.s1), Math.max(p.across.s0, p.across.s1)], `${type}: 外縁=平面の壁の面`);
    // 梯子の幅: 内縁だけ LANE_GAP/2=50 詰まる（二重に引かない）
    const trueLo = outer[0], trueHi = outer[1];
    const lad = ladderAcrossRange(ob, trueLo, trueHi, 100);
    const inner = ob.acrossLo > trueLo + 1e-6 ? lad.acrossLo - ob.acrossLo : ob.acrossHi - lad.acrossHi;
    assert.equal(Math.abs(inner), 50, `${type}: 往路の梯子の内縁はちょうど 50 詰まる`);
  }
});

// ---------------------------------------------------------------- stairContribution の形

test('stairContribution: 往路（直進部）・復路の端・段数が uTurnPlanLayout と一致し、往路の足元は区画の最後の段・復路の足元は回転部の最後の段の高さ', () => {
  for (const e of [0, 1]) {
    const { graph, stair } = overhangFixture(e);
    addPartitionWalls(graph);
    const c = stairContribution(stair, graph, FLOOR_HEIGHT);
    const p = uTurnPlanLayout(stair, graph);
    const [ob, ib] = c.flights;
    const tag = `e=${e}`;
    assert.equal(ob.runLo, Math.min(p.run.startA, p.run.frontA), tag);
    assert.equal(ob.runHi, Math.max(p.run.startA, p.run.frontA), tag);
    assert.equal(ob.travelSign, p.run.frontA > p.run.startA ? 1 : -1, tag);
    assert.equal(ob.lengthMm, Math.abs(p.run.frontA - p.run.startA), tag);
    assert.equal(ob.steps, p.n1, `${tag}: 直進部の蹴上数だけ`);
    assert.equal(ob.baseZ, e * ob.riserMm, `${tag}: 足元＝区画の最後の段の天端`);
    assert.notEqual(p.run.startA, p.run.baseA, `${tag}: 側面の上り口は始端が区画の出口（上り口辺ではない）`);
    assert.equal('leadMm' in ob || 'leadSteps' in ob, false, tag);
    assert.equal(ib.runLo, Math.min(p.run.front, p.run.startB), tag);
    assert.equal(ib.runHi, Math.max(p.run.front, p.run.startB), tag);
    assert.equal(ib.travelSign, p.run.startB > p.run.front ? 1 : -1, `${tag}: 復路は front から startB へ歩く`);
    assert.equal(ib.lengthMm, Math.abs(p.run.startB - p.run.front), tag);
    assert.equal(ib.steps, p.n2, tag);
    assert.equal(ib.baseZ, (p.n1 + e + p.turnCells - 1) * ob.riserMm, `${tag}: 復路の足元＝(n1+e+w−1)×蹴上`);
    assert.deepEqual(c.frame, { frontA: p.run.frontA, front: p.run.front, back: p.run.back }, tag);
    assert.equal(c.isVertical, p.vertical, tag);
    assert.equal(c.turnCellCount, p.turnCells, tag);
  }
});

test('stairContribution: 隔て板の柱あり（frontA≠front）の SWITCHBACK は同じ高さの踊り場が 2 枚（本体＝桁枠 4 辺・延長＝往路側だけ frontA〜front・桁枠なし）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  addPartitionWalls(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  assert.ok(Math.abs(p.run.frontA - p.run.front) > 1, '前提: 前縁が往路側と復路側で分かれる');
  assert.equal(c.landings.length, 2);
  const [body, ext] = c.landings;
  assert.equal(body.z, ext.z, '同じ高さ');
  assert.equal(body.runLo, Math.min(p.run.front, p.run.back));
  assert.equal(body.runHi, Math.max(p.run.front, p.run.back));
  assert.equal(body.acrossLo, Math.min(p.across.s0, p.across.s1));
  assert.equal(body.acrossHi, Math.max(p.across.s0, p.across.s1));
  assert.equal(body.frame.edges.length, 4);
  assert.equal(ext.runLo, Math.min(p.run.frontA, p.run.front));
  assert.equal(ext.runHi, Math.max(p.run.frontA, p.run.front));
  assert.equal(ext.acrossLo, Math.min(p.across.s0, p.across.sA));
  assert.equal(ext.acrossHi, Math.max(p.across.s0, p.across.sA));
  assert.deepEqual(ext.frame.edges, []);
  assert.equal(ext.isVertical, true);
  // 延長は本体と重ならずに前縁側で接する（走行方向の区間が隣り合う）
  assert.ok(Math.abs(ext.runLo - body.runHi) < 1e-9 || Math.abs(ext.runHi - body.runLo) < 1e-9, '延長は本体の前縁に接する');
});

test('stairContribution: 隔て壁が立たない（鉄骨）なら踊り場は 1 枚のまま（延長を足さない）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false, { wood: false });
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.equal(c.landings.length, 1);
  assert.equal(c.frame.frontA, c.frame.front);
});

test('stairContribution(WINDING): 往路側のセルは frontA、復路側のセルは front に前縁がある（隔て板の柱あり）', () => {
  const { graph, stair } = equalFixture(StairType.WINDING, 'up', false);
  addPartitionWalls(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  assert.ok(Math.abs(p.run.frontA - p.run.front) > 1);
  // 回転部の多角形（w=2: 往路側 6・復路側 7）。走行軸の座標 r（縦走行は y）の範囲で前縁と奥を確かめる
  const runsOfPoly = (cell) => cell.poly.filter((_, i) => i % 2 === 1);
  const near = (arr, v) => arr.some(x => Math.abs(x - v) < 1e-6);
  const [cellA, cellB] = c.turnCells;
  assert.ok(near(runsOfPoly(cellA), p.run.frontA), '往路側のセルは frontA（P1 の面）に前縁がある');
  assert.ok(near(runsOfPoly(cellB), p.run.front), '復路側のセルは front（P2・P3 の面）に前縁がある');
  assert.ok(near(runsOfPoly(cellB), p.run.back) && near(runsOfPoly(cellA), p.run.back), '奥は back（壁の面）');
  const sign = Math.sign(p.run.back - p.run.baseA);
  for (const cell of c.turnCells) {
    assert.ok(runsOfPoly(cell).every(r => (r - p.run.back) * sign <= 1e-6), '回転部のセルは奥の壁の面を越えない');
  }
});

test('stairContribution(WINDING・奇数の回り段 3・5 ＋柱): 各レーンを縦断するとセルの縁ごとに蹴上が出る（本数＝通るセル数−1）', () => {
  for (const w of [3, 5]) {
    const { graph, stair } = equalFixture(StairType.WINDING, 'up', false);
    stair.setField('sections', [6, w, 6]);
    addPartitionWalls(graph);
    const c = stairContribution(stair, graph, FLOOR_HEIGHT);
    const p = uTurnPlanLayout(stair, graph);
    assert.ok(c && Math.abs(p.run.frontA - p.run.front) > 1, `w=${w}: 前提`);
    assert.equal(c.turnCells.length, w, `w=${w}: 回転部の多角形が w 枚`);
    for (const [lane, fl] of [['復路', c.flights[1]], ['往路', c.flights[0]]]) {
      const cut = { seqNo: '5', line: { isVertical: true, axisValue: (fl.acrossLo + fl.acrossHi) / 2, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 };
      const sliced = withCutLandings(c, cut).landings;
      // 各レーンは回転部のセルを（w+1）/2 枚か w/2 枚通り、隣り合う2枚の縁（放射線）ごとに蹴上が1本出る
      const risers = landingStepRisers(sliced, true, cut);
      assert.equal(risers.length, sliced.length - 1, `w=${w} ${lane}: 蹴上の本数＝通るセル数−1`);
      assert.ok(sliced.length >= Math.floor(w / 2), `w=${w} ${lane}: セルを通る`);
    }
  }
});

// 回転部の主ゲート: レーン線で切った回転部の Landing の境界（蹴上の走行座標）＝平面の踏面線（放射線）とレーン線の交点
function turnBoundaryCheck(graph, stair, tag) {
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c, tag);
  const g = installGeom(stair, graph);
  const vertical = c.isVertical;
  const hitsOn = (v) => g.treads.flatMap((t) => {
    const [pa, qa, pr, qr] = vertical ? [t.x1, t.x2, t.y1, t.y2] : [t.y1, t.y2, t.x1, t.x2];
    if ((pa - v) * (qa - v) > 0 || Math.abs(pa - qa) < 1e-9) return [];
    return [pr + (qr - pr) * (v - pa) / (qa - pa)];
  });
  for (const [lane, fl] of [['往路', c.flights[0]], ['復路', c.flights[1]]]) {
    const v = (fl.acrossLo + fl.acrossHi) / 2;
    const cut = { seqNo: '2', line: { isVertical: vertical, axisValue: v, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 };
    // 回転部のスライスだけ（取りつき区画のスライスは zoneBoundaryCheck）
    const first = uTurnPlanLayout(stair, graph).firstTurnNumber, w = c.turnCellCount;
    const sliced = withCutLandings(c, cut).landings.filter(l => l.turnStep >= first && l.turnStep < first + w).sort((a, b) => a.runLo - b.runLo);
    assert.ok(sliced.length >= 1, `${tag} ${lane}: 回転部を通る`);
    // 蹴上＝隣り合うセル同士が共有する縁（高さが違うもの）
    const edges = [];
    for (let i = 0; i + 1 < sliced.length; i++) {
      if (Math.abs(sliced[i].runHi - sliced[i + 1].runLo) <= TOL && Math.abs(sliced[i].z - sliced[i + 1].z) > 1e-6) edges.push((sliced[i].runHi + sliced[i + 1].runLo) / 2);
    }
    const lo = sliced[0].runLo, hi = sliced.at(-1).runHi;
    const planInside = hitsOn(v).filter(r => r > lo + TOL && r < hi - TOL);
    assertSameSet(edges, planInside, `${tag} ${lane}`);
    // landingStepRisers が同じ本数を出す（縁の共有を拾えている）
    assert.equal(landingStepRisers(sliced, vertical, cut).length, edges.length, `${tag} ${lane}: landingStepRisers の本数`);
  }
  return c;
}

test('回転部の主ゲート: 木造＋隔て板（柱材/PB 包み）× 回り段 w=2・3・4・5・6 × flip で、レーン線で切った回転部の蹴上＝平面の放射線∩レーン線（両方向）', () => {
  for (const w of [2, 3, 4, 5, 6]) {
    for (const flip of [false, true]) {
      for (const [name, setup] of VARIANTS) {
        const { graph, stair } = equalFixture(StairType.WINDING, 'up', flip);
        stair.setField('sections', [6, w, 6]);
        setup(graph);
        turnBoundaryCheck(graph, stair, `w=${w}/flip=${flip}/${name}`);
      }
    }
  }
});

test('回転部の主ゲート: 張り出し（f,b,c,d,a）の回り階段 × 取りつき回転部 0/1 段 × 柱材/PB 包み、鉄骨 WINDING（柱なし）でも一致する', () => {
  for (const [name, setup] of VARIANTS) {
    for (const e of [0, 1]) {
      const { graph, stair } = overhangFixture(e);
      setup(graph);
      turnBoundaryCheck(graph, stair, `張り出し/${name}/e=${e}`);
    }
  }
  for (const w of [2, 3, 4]) {
    const { graph, stair } = equalFixture(StairType.WINDING, 'up', false, { wood: false });
    stair.setField('sections', [6, w, 6]);
    turnBoundaryCheck(graph, stair, `鉄骨 w=${w}`);
  }
});

test('横切る線が「一部のセルにしかない頂点」の 0.5mm 以内に来ても、全セルが同じ座標で切られ縁が連続し、蹴上が落ちない', () => {
  for (const [label, { graph, stair }] of [
    ['鉄骨 up w=5', (() => { const f = equalFixture(StairType.WINDING, 'up', false, { wood: false }); f.stair.setField('sections', [6, 5, 6]); return f; })()],
    ['木造+柱 down w=5', (() => { const f = equalFixture(StairType.WINDING, 'down', false); f.stair.setField('sections', [6, 5, 6]); addPartitionWalls(f.graph); return f; })()],
  ]) {
    const c = stairContribution(stair, graph, FLOOR_HEIGHT);
    assert.ok(c, label);
    const vertical = c.isVertical;
    const runsOf = (cell) => cell.poly.filter((_, i) => i % 2 === (vertical ? 1 : 0));
    const allRuns = [...new Set(c.turnCells.flatMap(runsOf).map(r => Math.round(r * 1e6) / 1e6))];
    // 一部のセルにしかない頂点の走行座標（全セルが持つ座標・1 セルだけが持つ座標は除く）
    const partial = allRuns.filter(r => {
      const n = c.turnCells.filter(cell => runsOf(cell).some(x => Math.abs(x - r) < 1e-6)).length;
      return n >= 2 && n < c.turnCells.length;
    });
    assert.ok(partial.length > 0, `${label}: 前提: 一部のセルにしかない頂点がある`);
    for (const r of partial) {
      const at = (dv) => {
        const cut = { seqNo: '1', line: { isVertical: !vertical, axisValue: r + dv, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 };
        const sl = withCutLandings(c, cut).landings;
        return { sl, risers: landingStepRisers(sl, vertical, cut).length };
      };
      const base = at(0);
      for (const dv of [-0.45, -0.3, 0.3, 0.45]) {
        const { sl, risers } = at(dv);
        // 近接する端同士は完全に一致する（隙間・重なりが残らない）
        for (let i = 0; i < sl.length; i++) for (let j = i + 1; j < sl.length; j++) {
          for (const d of [Math.abs(sl[i].acrossHi - sl[j].acrossLo), Math.abs(sl[j].acrossHi - sl[i].acrossLo)]) {
            assert.ok(d < 1e-6 || d > 1, `${label} r=${r} dv=${dv}: 縁が 1mm 未満の隙間/重なりで食い違う (${d})`);
          }
        }
        assert.equal(risers, base.risers, `${label} r=${r} dv=${dv}: 蹴上の本数が頂点ちょうどの線と同じ`);
      }
    }
  }
});

test('回転部の切断線 seq1（frontA）は辺に乗るので奥（+t）側のセルを採る。±1e-3 の揺れでも同じセル', () => {
  const { graph, stair } = equalFixture(StairType.WINDING, 'up', false);
  stair.setField('sections', [6, 4, 6]);
  addPartitionWalls(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  const stepsAt = (dv) => withCutLandings(c, { line: { isVertical: !c.isVertical, axisValue: p.run.frontA + dv, lo: -1e5, hi: 1e5 } })
    .landings.map(l => l.turnStep).sort((a, b) => a - b);
  const first = p.firstTurnNumber;
  assert.deepEqual(stepsAt(0), [first], 'frontA は往路側の最初のセルの前縁（奥側のセル）だけ');
  assert.deepEqual(stepsAt(1e-3), [first]);
  assert.deepEqual(stepsAt(-1e-3), [first]);
  // 前縁の手前(上り口側へ 5mm)は回転部の外＝セルなし
  assert.deepEqual(stepsAt(-5 * Math.sign(p.run.back - p.run.baseA)), []);
});

// seq1 相当の横断切断（走行軸に直交・全幅）。columns は幅方向の全範囲を 1 列で渡す
function seq1LikeCut(c, p, axisValue) {
  return {
    cut: { seqNo: '1', line: { isVertical: !c.isVertical, axisValue, lo: Math.min(p.across.s0, p.across.s1), hi: Math.max(p.across.s0, p.across.s1) },
      viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 },
    columns: [{ x0: 0, x1: Math.abs(p.across.s1 - p.across.s0), worldLo: Math.min(p.across.s0, p.across.s1), worldHi: Math.max(p.across.s0, p.across.s1), bands: [] }],
  };
}

test('seq1（frontA）で物理的に切られる復路の初段の段板に CUT が出る（木造は厚30の矩形）。往路の端ちょうど・柱なし（境界）は従来どおり梯子だけ', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  addPartitionWalls(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  const { cut, columns } = seq1LikeCut(c, p, p.run.frontA);
  const [ob, ib] = c.flights;
  // 復路は front から startB へ pitch=長さ/(n2-1) ごとに段鼻。frontA は front から |frontA-front| 進んだ位置
  const pitch = ib.lengthMm / (ib.steps - 1);
  const idx = Math.floor(Math.abs(p.run.frontA - p.run.front) / pitch + 1e-9);
  assert.ok(idx >= 0 && idx < ib.steps);
  const treadZ = ib.baseZ + ib.riserMm * (1 + idx);
  const prims = stairPrimitivesForCut(c, cut, columns);
  const thickAt = (z) => prims.filter(q => q.type === 'line' && q.weight === 'thick' && q.y1 === -z && q.y2 === -z);
  assert.equal(thickAt(treadZ).length, 1, '切られる段板の天端に CUT');
  assert.equal(thickAt(treadZ - 30).length, 1, '段板の下面（厚30）に CUT');
  assert.equal(ob.runLo, p.run.frontA, '前提: 往路の端が frontA（境界。段板の断面は出さず梯子のみ。天端の高さは踊り場の床 CUT と同じ）');
  // 柱なし（鉄骨・frontA=front）: 復路の端ちょうど＝境界なので段板の CUT は増えない
  const g2 = equalFixture(StairType.SWITCHBACK, 'up', false, { wood: false });
  const c2 = stairContribution(g2.stair, g2.graph, FLOOR_HEIGHT);
  const p2 = uTurnPlanLayout(g2.stair, g2.graph);
  const k2 = seq1LikeCut(c2, p2, p2.run.frontA);
  const ib2 = c2.flights[1];
  const treadTop2 = ib2.baseZ + ib2.riserMm;
  const cutsAtTread = stairPrimitivesForCut({ ...c2, flights: [ib2], landings: [] }, k2.cut, k2.columns)
    .filter(q => q.weight === 'thick' && q.y1 === -treadTop2 && q.y2 === -treadTop2);
  assert.equal(cutsAtTread.length, 0, '境界ちょうどの flight 端は従来どおり（段板の断面を足さない）');
  // 同じ鉄骨で切断線を復路の内部へ 1 段ぶん入れると、その段板の天端に CUT が出る（検出力の裏取り）
  const k3 = seq1LikeCut(c2, p2, p2.run.front + (ib2.lengthMm / (ib2.steps - 1)) * 1.5 * Math.sign(p2.run.startB - p2.run.front));
  const inner = stairPrimitivesForCut({ ...c2, flights: [ib2], landings: [] }, k3.cut, k3.columns)
    .filter(q => q.weight === 'thick' && q.y1 === -(ib2.baseZ + ib2.riserMm * 2) && q.y2 === q.y1);
  assert.equal(inner.length, 1, '内部の切断では段板の天端に CUT');
});

test('段板の断面(CUT)の幅方向: 隔て板があるとき復路は隔て板の面 sB で止まり隔て板の断面(sA..sB)の中へ入らない。柱なし（鉄骨）はレーン中央 mid まで', () => {
  const treadLine = (c, p, axis) => {
    const [, ib] = c.flights;
    const { cut, columns } = seq1LikeCut(c, p, axis);
    const pitch = ib.lengthMm / (ib.steps - 1);
    const i = Math.floor(Math.abs(axis - (ib.travelSign > 0 ? ib.runLo : ib.runHi)) / pitch + 1e-9);
    const z = ib.baseZ + ib.riserMm * (1 + i);
    const ln = stairPrimitivesForCut({ ...c, landings: [], flights: [ib] }, cut, columns)
      .find(q => q.type === 'line' && q.weight === 'thick' && q.y1 === -z && q.y2 === -z);
    return { ln, cut };
  };
  // 木造＋PB 包み
  const w = equalFixture(StairType.SWITCHBACK, 'up', false);
  addPartitionWalls(w.graph);
  const c = stairContribution(w.stair, w.graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(w.stair, w.graph);
  const { ln, cut } = treadLine(c, p, p.run.frontA);
  assert.ok(ln, '段板の天端の CUT 線がある');
  const xs = [Math.min(ln.x1, ln.x2), Math.max(ln.x1, ln.x2)];
  const want = [p.across.sB, p.across.s1].map(a => localXOf(cut, a)).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[0] - want[0]) < 1e-6 && Math.abs(xs[1] - want[1]) < 1e-6, `復路の段板は sB..s1 (${want}) 実際 ${xs}`);
  const wallLo = localXOf(cut, Math.min(p.across.sA, p.across.sB)), wallHi = localXOf(cut, Math.max(p.across.sA, p.across.sB));
  assert.ok(xs[0] >= Math.max(wallLo, wallHi) - 1e-6 || xs[1] <= Math.min(wallLo, wallHi) + 1e-6, '隔て板の断面の外側');
  // 柱なし（鉄骨）: 内縁は mid のまま
  const s = equalFixture(StairType.SWITCHBACK, 'up', false, { wood: false });
  const c2 = stairContribution(s.stair, s.graph, FLOOR_HEIGHT);
  const p2 = uTurnPlanLayout(s.stair, s.graph);
  const ib2 = c2.flights[1];
  assert.equal(ib2.treadAcrossLo, undefined, '柱なしは treadAcross を持たない');
  const k = seq1LikeCut(c2, p2, p2.run.front + (ib2.lengthMm / (ib2.steps - 1)) * 1.5 * Math.sign(p2.run.startB - p2.run.front));
  const z2 = ib2.baseZ + ib2.riserMm * 2;
  const ln2 = stairPrimitivesForCut({ ...c2, landings: [], flights: [ib2] }, k.cut, k.columns).find(q => q.weight === 'thick' && q.y1 === -z2 && q.y2 === -z2);
  assert.ok(ln2);
  const lad = [localXOf(k.cut, p2.across.mid), localXOf(k.cut, p2.across.s1)].sort((a, b) => a - b);
  assert.ok(Math.abs(Math.min(ln2.x1, ln2.x2) - lad[0]) < 1e-6 && Math.abs(Math.max(ln2.x1, ln2.x2) - lad[1]) < 1e-6, `柱なしは mid..s1 (${lad})`);
});

test('seq1 の切断位置を frontA±1e-3 ずらしても stairPrimitivesForCut の出力は変わらない（境界上は両側を含む許容幅）', () => {
  for (const [name, setup] of VARIANTS) {
    const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
    setup(graph);
    const c = stairContribution(stair, graph, FLOOR_HEIGHT);
    const p = uTurnPlanLayout(stair, graph);
    const render = (dv) => { const { cut, columns } = seq1LikeCut(c, p, p.run.frontA + dv); return stairPrimitivesForCut(c, cut, columns); };
    const base = render(0);
    assert.ok(base.length > 0, name);
    assert.deepEqual(render(1e-3), base, `${name}: +1e-3`);
    assert.deepEqual(render(-1e-3), base, `${name}: -1e-3`);
  }
  // WINDING（回転部の最初のセルの前縁が frontA）でも同じ
  const w = equalFixture(StairType.WINDING, 'up', false);
  addPartitionWalls(w.graph);
  const cw = stairContribution(w.stair, w.graph, FLOOR_HEIGHT);
  const pw = uTurnPlanLayout(w.stair, w.graph);
  const renderW = (dv) => { const { cut, columns } = seq1LikeCut(cw, pw, pw.run.frontA + dv); return stairPrimitivesForCut(cw, cut, columns); };
  assert.deepEqual(renderW(1e-3), renderW(0));
  assert.deepEqual(renderW(-1e-3), renderW(0));
});

test('stairAxisIsVertical: contribution.isVertical を最優先に使う（flights/landings/切断線より先）', () => {
  const cut = { line: { isVertical: true } };
  assert.equal(stairAxisIsVertical({ isVertical: false, flights: [{ isVertical: true }], landings: [] }, cut), false);
  assert.equal(stairAxisIsVertical({ flights: [{ isVertical: true }], landings: [] }, cut), true, 'isVertical が無ければ従来どおり flights から');
  assert.equal(stairAxisIsVertical({ flights: [], landings: [] }, { line: { isVertical: false } }), false, '最後の退避は切断線');
});

test('失敗系: 平面の枠が求まらない（セルが空・解決できないセル）・U字系でない階段は stairContribution が null（例外なし）', () => {
  const { graph, stair } = equalFixture(StairType.SWITCHBACK, 'up', false);
  assert.ok(stairContribution(stair, graph, FLOOR_HEIGHT));
  assert.equal(stairContribution(stair, graph, null), null, '階高未確定');
  stair.setCells(new Set());
  assert.equal(stairContribution(stair, graph, FLOOR_HEIGHT), null, 'セルが空');
  stair.setCells(new Set(['no-such:cell:key:here']));
  assert.equal(stairContribution(stair, graph, FLOOR_HEIGHT), null, '解決できないセル');
  const st = equalFixture(StairType.SWITCHBACK, 'up', false);
  st.stair.type = StairType.STRAIGHT;
  assert.equal(stairContribution(st.stair, st.graph, FLOOR_HEIGHT), null, '直進階段');
});

test('PARTITION_THICKNESS_MM の前提: 隔て壁の総厚が 0 でないフィクスチャで隔て板の柱が立つ（frontA≠front の前提の確認）', () => {
  const { graph, stair } = overhangFixture(0);
  addPartitionWalls(graph);
  const p = uTurnPlanLayout(stair, graph);
  assert.equal(p.hasColumn, true);
  assert.ok(Math.abs(Math.abs(p.across.sB - p.across.sA) - PARTITION_THICKNESS_MM) < 1e-6);
});

// ---------------------------------------------------------------- 側面の口に取りつく区画（上り口 e 段・到達口 a 段）

// 区画の主ゲート: レーン線で切った区画の Landing の境界（蹴上の走行座標）＝平面の踏面線（放射線）とレーン線の交点。
// 区画の外縁（上り口辺 baseA・到達辺 baseB）の段差は edgeRiser（外側の高さとの縦線 1 本）で、位置は平面の基端・到達辺。
// 期待値は buildStairGeometry の描画線（installGeom）と uTurnPlanLayout の端から取る（stairContribution の値の写しにしない）。
function zoneBoundaryCheck(graph, stair, port, tag) {
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c, tag);
  const p = uTurnPlanLayout(stair, graph);
  const g = installGeom(stair, graph);
  const vertical = c.isVertical;
  const lane = port === 'entry' ? c.flights[0] : c.flights[1];
  const v = (lane.acrossLo + lane.acrossHi) / 2;
  const cut = { seqNo: '2', line: { isVertical: vertical, axisValue: v, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 };
  const zoneNums = new Set(c.zoneCells[port].map(z => z.number));
  const sliced = withCutLandings(c, cut).landings.filter(l => l.turnStep != null && zoneNums.has(l.turnStep)).sort((a, b) => a.runLo - b.runLo);
  assert.ok(sliced.length >= 1, `${tag} ${port}: 区画を通る`);
  const hitsOn = g.treads.flatMap((t) => {
    const [pa, qa, pr, qr] = vertical ? [t.x1, t.x2, t.y1, t.y2] : [t.y1, t.y2, t.x1, t.x2];
    if ((pa - v) * (qa - v) > 0 || Math.abs(pa - qa) < 1e-9) return [];
    return [pr + (qr - pr) * (v - pa) / (qa - pa)];
  });
  // 区画の内部の蹴上＝隣り合うスライスが共有する縁（高さが違うもの）。高さは 1 段（蹴上）ずつ違う
  const edges = [];
  for (let i = 0; i + 1 < sliced.length; i++) {
    if (Math.abs(sliced[i].runHi - sliced[i + 1].runLo) <= TOL && Math.abs(sliced[i].z - sliced[i + 1].z) > 1e-6) {
      edges.push((sliced[i].runHi + sliced[i + 1].runLo) / 2);
      assert.ok(Math.abs(Math.abs(sliced[i].z - sliced[i + 1].z) - lane.riserMm) < 1e-6, `${tag} ${port}: 隣り合う段は蹴上 1 段ぶん`);
    }
  }
  const lo = sliced[0].runLo, hi = sliced.at(-1).runHi;
  assertSameSet(edges, hitsOn.filter(r => r > lo + TOL && r < hi - TOL), `${tag} ${port}`);
  // 段の高さ＝番号×蹴上（stairTreadFootprints の規約。到達番号〔上階の床〕は含まない）
  for (const l of sliced) {
    assert.ok(Math.abs(l.z - l.turnStep * lane.riserMm) < 1e-6, `${tag} ${port}: 段 ${l.turnStep} の天端＝番号×蹴上`);
  }
  // 外縁の段差: 上り口辺（上り口）・到達辺（到達口）に端が接するスライスだけが edgeRiser を持ち、位置は平面の基端・到達辺
  const edgeRun = port === 'entry' ? p.run.baseA : p.run.baseB;
  const outerZ = port === 'entry' ? 0 : p.totalSteps * lane.riserMm;
  const withEdge = sliced.filter(l => l.edgeRiser);
  assert.equal(withEdge.length, 1, `${tag} ${port}: 外縁の段差は 1 本`);
  for (const l of withEdge) {
    assert.ok(Math.abs(l.edgeRiser.run - edgeRun) < 1e-9 && l.edgeRiser.outerZ === outerZ, `${tag} ${port}: 外縁の位置と外側の高さ`);
    assert.ok(Math.abs(l.runLo - edgeRun) <= TOL || Math.abs(l.runHi - edgeRun) <= TOL, `${tag} ${port}: スライスの端が外縁に接する`);
  }
  // 平面の外縁（baseA / baseB）の外周線もレーン線と交わる位置にある（蹴上の縦線を引く位置の裏取り）
  const outline = planRunsAcross(g.outline, vertical, v);
  assert.ok(outline.some(r => Math.abs(r - edgeRun) <= TOL), `${tag} ${port}: 平面の外周に外縁の辺がある`);
  // landingStepRisers が内部の縁＋外縁の段差を縦線として出す
  assert.equal(landingStepRisers(sliced, vertical, cut).length, edges.length + withEdge.length, `${tag} ${port}: landingStepRisers の本数`);
  return { c, p, sliced, edges, withEdge };
}

test('区画の主ゲート: 張り出し（f,b,c,d,a）の回り階段の上り口 e=1・2・3 × 柱材/PB 包みで、区画の蹴上＝平面の放射線∩レーン線、外縁 baseA の段差 1 本', () => {
  for (const [name, setup] of VARIANTS) {
    for (const e of [1, 2, 3]) {
      const { graph, stair } = overhangFixture(e);
      setup(graph);
      const { c, p } = zoneBoundaryCheck(graph, stair, 'entry', `張り出し/${name}/e=${e}`);
      assert.equal(c.zoneCells.entry.length, e, '区画のセルは e 枚');
      assert.deepEqual(p.entryNumbers, { from: 1, to: e });
    }
  }
});

test('区画の主ゲート: 折返しの側面の上り口 e=1・2・3 × 柱材/PB 包み × flip で、区画の蹴上＝平面の放射線∩レーン線（直進部も一致）', () => {
  for (const flip of [false, true]) {
    for (const [name, setup] of VARIANTS) {
      for (const e of [1, 2, 3]) {
        const tag = `折返し/flip=${flip}/${name}/e=${e}`;
        const { graph, stair } = sideEntrySwitchback(e, { flip });
        assert.ok(stair, `${tag}: 前提: 側面の上り口になる辺がある`);
        setup(graph);
        zoneBoundaryCheck(graph, stair, 'entry', tag);
        assertFlightsMatchPlan(graph, stair, tag);
      }
    }
  }
});

test('区画の主ゲート: 到達口の区画 a=1・2・3（上り口の区画 e=0・1 と併用）× 柱材/PB 包み × flip で、区画の蹴上＝平面の放射線∩レーン線、復路は front〜startB', () => {
  for (const flip of [false, true]) {
    for (const [name, setup] of VARIANTS) {
      for (const [e, a] of [[0, 1], [0, 2], [1, 3]]) {
        const tag = `到達口/flip=${flip}/${name}/e=${e}/a=${a}`;
        const { graph, stair } = sideEntrySwitchback(e, { arrival: true, arrivalTurnSteps: a, flip });
        assert.ok(stair, `${tag}: 前提`);
        setup(graph);
        const { c, p } = zoneBoundaryCheck(graph, stair, 'arrival', tag);
        assert.equal(c.zoneCells.arrival.length, a, `${tag}: 区画のセルは a 枚`);
        assert.deepEqual(p.arrivalNumbers, { from: p.totalSteps - a, to: p.totalSteps - 1 }, `${tag}: 到達口の番号は総蹴上数−a〜総蹴上数−1`);
        assert.equal(c.flights[1].steps, p.n2, `${tag}: 復路は直進部の n2 段だけ`);
        // 復路の足元＋n2 段の終端＝区画の最初のセルの天端（最後の蹴上が区画の最初のセルへ上がる）
        const ib = c.flights[1];
        assert.ok(Math.abs(ib.baseZ + ib.steps * ib.riserMm - c.zoneCells.arrival[0].z) < 1e-6, `${tag}: 復路の終端＝区画の最初のセルの天端`);
        assertFlightsMatchPlan(graph, stair, tag);
        if (e > 0) zoneBoundaryCheck(graph, stair, 'entry', tag);
      }
    }
  }
});

test('区画の主ゲート: 取りつき段 0（平場）は矩形のセル。上り口は z=0 で外縁の段差なし、到達口は上階の床の高さで外縁の段差なし', () => {
  const { graph, stair } = sideEntrySwitchback(0, { arrival: true, arrivalTurnSteps: 0 });
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  assert.equal(p.entryNumbers, null, '蹴上 0 の区画には番号がない');
  assert.equal(p.arrivalNumbers, null);
  const r = c.flights[0].riserMm;
  assert.deepEqual(c.zoneCells.entry.map(z => [z.z, z.number]), [[0, 0]]);
  assert.deepEqual(c.zoneCells.arrival.map(z => [z.z, z.number]), [[p.totalSteps * r, p.totalSteps]], '到達口の平場は上階の床の高さ（総蹴上数×蹴上）');
  for (const [port, lane, from, to] of [['entry', c.flights[0], p.run.baseA, p.run.exitA], ['arrival', c.flights[1], p.run.startB, p.run.baseB]]) {
    const v = (lane.acrossLo + lane.acrossHi) / 2;
    const cut = { seqNo: '2', line: { isVertical: c.isVertical, axisValue: v, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 };
    const sl = withCutLandings(c, cut).landings.filter(l => l.turnStep === c.zoneCells[port][0].number);
    assert.equal(sl.length, 1, `${port}: 平場は 1 枚`);
    assert.ok(Math.abs(sl[0].runLo - Math.min(from, to)) < 1e-9 && Math.abs(sl[0].runHi - Math.max(from, to)) < 1e-9, `${port}: 走行方向は ${from}〜${to}`);
    assert.equal(sl[0].edgeRiser, undefined, `${port}: 平場は外側と同じ高さなので段差なし`);
    assert.equal(landingStepRisers(sl, c.isVertical, cut).length, 0, `${port}: 蹴上の縦線は出ない`);
  }
  assertFlightsMatchPlan(graph, stair, '平場');
});

test('区画の主ゲート: 鉄骨（あき 100）の側面の上り口 e=2・到達口 a=2 でも区画の蹴上＝平面の放射線∩レーン線（あきは区画のセルに影響しない）', () => {
  for (const flip of [false, true]) {
    const { graph, stair } = sideEntrySwitchback(2, { arrival: true, arrivalTurnSteps: 2, flip, structure: StructuralMaterialType.STEEL });
    assert.ok(stair);
    const tag = `鉄骨/flip=${flip}`;
    zoneBoundaryCheck(graph, stair, 'entry', tag);
    zoneBoundaryCheck(graph, stair, 'arrival', tag);
    assertFlightsMatchPlan(graph, stair, tag);
  }
});

test('区画の外縁の段差は、レーンを縦断する切断の stairPrimitivesForCut に CUT の縦線として出る（外側の高さ→区画の天端）。横断の切断では出ない', () => {
  const { graph, stair } = sideEntrySwitchback(2, { arrival: true, arrivalTurnSteps: 2 });
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  const ob = c.flights[0];
  const v = (ob.acrossLo + ob.acrossHi) / 2;
  const cut = { seqNo: '2', line: { isVertical: c.isVertical, axisValue: v, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 };
  const columns = [{ x0: -1e4, x1: 1e4, worldLo: -1e4, worldHi: 1e4, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const x = localXOf(cut, p.run.baseA);
  const sl = withCutLandings(c, cut).landings.find(l => l.edgeRiser?.run === p.run.baseA);
  assert.ok(sl, '上り口の区画の外縁に接するスライス');
  const vline = prims.filter(q => q.type === 'line' && q.weight === 'thick' && Math.abs(q.x1 - x) < 1e-6 && Math.abs(q.x2 - x) < 1e-6
    && Math.abs(Math.min(q.y1, q.y2) - -sl.z) < 1e-6 && Math.abs(Math.max(q.y1, q.y2) - 0) < 1e-6);
  assert.equal(vline.length, 1, '上り口辺の位置に、床(0)から区画の天端までの CUT の縦線が 1 本');
  // 横断の切断（レーンに直交）では外縁の段差は出ない。上り口辺ちょうどを横切る線は区画のセルを切る（スライスは出る）が縦線は持たない
  for (const axisValue of [p.run.frontA, p.run.baseA]) {
    const crossCut = { ...cut, seqNo: '1', line: { isVertical: !c.isVertical, axisValue, lo: -1e5, hi: 1e5 } };
    const sliced = withCutLandings(c, crossCut).landings;
    assert.equal(sliced.filter(l => l.edgeRiser).length, 0, `横断 ${axisValue}: 外縁の段差は持たない`);
    if (axisValue === p.run.baseA) assert.ok(sliced.some(l => l.turnStep === 1), '前提: 上り口辺ちょうどの横断は区画のセルを切る');
  }
});

test('失敗系: 切断線が非有限・切断線なし・切るセルが無い寄与は、区画のスライスを足さず例外も投げない（landings は変わらない）', () => {
  const { graph, stair } = sideEntrySwitchback(2, { arrival: true, arrivalTurnSteps: 1 });
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const n0 = c.landings.length;
  assert.equal(withCutLandings(c, { line: { isVertical: true, axisValue: NaN } }).landings.length, n0, '非有限の位置');
  assert.equal(withCutLandings(c, { line: { isVertical: 'x', axisValue: 1 } }).landings.length, n0, '向きが不正');
  assert.equal(withCutLandings(c, {}), c, '切断線なしは寄与そのまま');
  const bare = { ...c, zoneCells: { entry: [], arrival: [] }, turnCells: [] };
  assert.equal(withCutLandings(bare, { line: { isVertical: true, axisValue: 1 } }), bare, '切るセルが無ければ寄与そのまま');
  assert.equal(withCutLandings(null, { line: {} }), null);
});

test('seq1（frontA）の梯子は、足元の下に続く上り口の区画の段（e=2）の踏面も含む（床〜踊り場の全段が見付けに入る）。遮蔽矩形・ヒットも足元は床から', () => {
  const { graph, stair } = sideEntrySwitchback(2);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const p = uTurnPlanLayout(stair, graph);
  const ob = c.flights[0];
  const r = ob.riserMm;
  const { cut, columns } = seq1LikeCut(c, p, p.run.frontA);
  const prims = stairPrimitivesForCut({ ...c, flights: [ob], landings: [] }, cut, columns);
  const rungs = prims.filter(q => q.type === 'line' && q.weight === 'thin' && q.y1 === q.y2).map(q => Math.round(-q.y1 * 1000) / 1000);
  for (let k = 1; k <= p.n1 + 2; k++) {
    assert.ok(rungs.some(z => Math.abs(z - k * r) < 1e-3), `${k} 段目の踏面（z=${k * r}）の梯子: ${JSON.stringify(rungs)}`);
  }
  // 見付けの矩形・ヒット: 足元は床（区画の段も含む）から踊り場の高さまで
  const rect = stairOccluderRects({ ...c, flights: [ob], landings: [] }, cut).find(q => q.zHi > q.zLo);
  assert.ok(Math.abs(rect.zLo - 0) < 1e-9 && Math.abs(rect.zHi - (p.n1 + 2) * r) < 1e-6, `遮蔽矩形 z: ${rect.zLo}〜${rect.zHi}`);
  const hit = stairFaceHits({ ...c, flights: [ob], landings: [] }, cut).find(h => h.part === 'tread');
  assert.ok(Math.abs(hit.z0 - 0) < 1e-9 && Math.abs(hit.z1 - (p.n1 + 2) * r) < 1e-6, `ヒット z: ${hit.z0}〜${hit.z1}`);
});
