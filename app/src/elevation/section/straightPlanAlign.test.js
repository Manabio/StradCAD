// 直進系（STRAIGHT/STRAIGHT_LANDING）の展開図の階段（straightContribution・straightCuts）の走行方向の位置が平面（install の
// 踏面線・放射線）と一致することの単体テスト（ユーザー指示 2026-10-09 問題.md「展開図の階段を平面に揃える（続き）」T2-2）。
// 主ゲート（stairPlanAlign.test.js の assertFlightsMatchPlan / zoneBoundaryCheck の直進系版）: 展開図の蹴上（段鼻）の走行座標の集合 ＝
// 平面の踏面線のうち切断線（レーン中央 s=0.5）を横切るものの走行座標の集合（±0.5mm、両方向）。側面の口の区画は
// 切断線で切った Landing の境界＝平面の放射線∩切断線。期待値は straightPlanLayout ではなく buildStairGeometry の描画線から取る。
// 平面は detail:false（段のセルの境界。stairTreadFootprints と同じ。詳細 LOD の ±nosing のずらしは直進系の平面側の描画規約）。
// フィクスチャは stairStraightPlanLayout.test.js と同じ流儀（歩く順の行の長さで走行軸の境界を作る）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide } from '@core';
import { measureStairSpans } from '../../finish/stair/stairClassify.js';
import { buildStairGeometry, straightPlanLayout } from '../../finish/stair/stairGeometry.js';
import { roomBounds } from '../../finish/gridCells.js';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { composeRoomFaces } from '../elevationFaceList.js';
import { buildBandLayers } from './sectionBandLayers.js';
import { stairRunProfile } from '../elevationStairSection.js';
import { straightContribution, withCutLandings, landingStepRisers, stairPrimitivesForCut, crossesFlight } from './sectionStair.js';
import { straightCuts } from './cuts/straightCuts.js';
import { localXOf } from './sectionTypes.js';
import { faceFromCut } from './sectionFace.js';

const { LEFT, RIGHT } = StairPortSide;
const TOL = 0.5;
const FLOOR_HEIGHT = 2800;
const DIRS = ['up', 'down', 'left', 'right'];
const ARCH = { labeled: false, discipline: Discipline.ARCH };

// walk＝歩く順（上り口から到達端へ）の行の長さ。room:true なら階段室の Room と壁（straightCuts 用）も作る
function fixture({ dir = 'up', flip = false, walk = [1000, 1400, 600], cols = 2, type = StairType.STRAIGHT, extra = {}, room = false } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const vertical = dir === 'up' || dir === 'down';
  const total = walk.reduce((s, v) => s + v, 0);
  const cum = [0];
  for (const w of walk) cum.push(cum.at(-1) + w);
  const along = (dir === 'up' || dir === 'left') ? cum.map(v => total - v).reverse() : cum;
  const across = Array.from({ length: cols + 1 }, (_, i) => i * 1000);
  const xs = vertical ? across : along, ys = vertical ? along : across;
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const H = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const keys = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) keys.push(`${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`);
  const cells = new Set(keys);
  let roomObj = null;
  if (room) {
    roomObj = graph.addRoom(cells, '階段');
    generateRoomWallsFromOutline(graph, roomObj);
  }
  const stair = graph.addStair({ type, cells, upDirection: dir, flip, roomId: roomObj?.id ?? null, ...extra });
  return { graph, stair, room: roomObj, vertical };
}

// 設置階の枠（insetView 'install'）で全段を描いた平面（view 'upper'＝破れで打ち切らない。detail:false＝段のセルの境界）
const planGeom = (stair, graph) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view: 'upper', insetView: 'install', detail: false, riser: 200, spans: measureStairSpans(stair, graph), laneGap: true, graph,
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
// 斜めの線（放射線）と切断線 v の交点の走行座標
function radialCrossings(treads, vertical, v) {
  return treads.flatMap((t) => {
    const [pa, qa, pr, qr] = vertical ? [t.x1, t.x2, t.y1, t.y2] : [t.y1, t.y2, t.x1, t.x2];
    if ((pa - v) * (qa - v) > 0 || Math.abs(pa - qa) < 1e-9) return [];
    return [pr + (qr - pr) * (v - pa) / (qa - pa)];
  });
}
// 展開図の flight の蹴上（段鼻）の走行座標（世界）。flight は直進部だけ
function elevationNoses(flight) {
  const prof = stairRunProfile(flight.steps, flight.riserMm, flight.lengthMm, 0, 0, 1, 0);
  const worldStart = flight.travelSign > 0 ? flight.runLo : flight.runHi;
  return prof.noses.map(([x]) => worldStart + flight.travelSign * x);
}
function assertSameSet(actual, expected, tag) {
  const miss = expected.filter(e => !actual.some(a => Math.abs(a - e) <= TOL));
  const extra = actual.filter(a => !expected.some(e => Math.abs(a - e) <= TOL));
  assert.deepEqual({ miss, extra }, { miss: [], extra: [] }, `${tag}: 展開図の蹴上=${JSON.stringify(actual)} 平面の踏面線=${JSON.stringify(expected)}`);
}
const laneCut = (c, v) => ({ seqNo: '2', line: { isVertical: c.isVertical, axisValue: v, lo: -1e5, hi: 1e5 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 0 });

// 各 flight の蹴上の集合を平面の踏面線と突き合わせる（直進部だけ。区画は zoneCheck）
function assertFlightsMatchPlan(graph, stair, tag) {
  const c = straightContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c, tag);
  const p = straightPlanLayout(stair, graph);
  const g = planGeom(stair, graph);
  const mid = c.across.mid;
  c.flights.forEach((f, i) => {
    const lo = f.runLo - TOL, hi = f.runHi + TOL;
    const planRuns = planRunsAcross(g.treads, c.isVertical, mid).filter(r => r >= lo && r <= hi);
    // 走行端の上り口なら最初の蹴上の辺は外周の基端、走行端の到達口なら最後の蹴上の辺は外周の到達端（踏面線ではない）
    if (i === 0 && p.entryPort === 'end') planRuns.push(p.run.base);
    if (i === c.flights.length - 1 && p.arrivalPort === 'end') planRuns.push(p.run.end);
    assert.equal(elevationNoses(f).length, f.steps, `${tag} flight${i}: 蹴上の数＝段数`);
    assertSameSet(elevationNoses(f), planRuns, `${tag} flight${i}`);
  });
  return { c, p, g };
}

// 区画の主ゲート: レーン線で切った区画の Landing の境界（蹴上の走行座標）＝平面の放射線∩レーン線。外縁（上り口辺 base・到達端 end）の
// 段差は edgeRiser（外側の高さとの縦線 1 本）。期待値は buildStairGeometry の描画線と straightPlanLayout の端から取る
function zoneCheck(graph, stair, port, tag) {
  const c = straightContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c, tag);
  const p = straightPlanLayout(stair, graph);
  const g = planGeom(stair, graph);
  const v = c.across.mid;
  const cut = laneCut(c, v);
  const zoneNums = new Set(c.zoneCells[port].map(z => z.number));
  const sliced = withCutLandings(c, cut).landings.filter(l => l.turnStep != null && zoneNums.has(l.turnStep)).sort((a, b) => a.runLo - b.runLo);
  assert.ok(sliced.length >= 1, `${tag} ${port}: 区画を通る`);
  const riser = c.flights[0].riserMm;
  const hitsOn = radialCrossings(g.treads, c.isVertical, v);
  const edges = [];
  for (let i = 0; i + 1 < sliced.length; i++) {
    if (Math.abs(sliced[i].runHi - sliced[i + 1].runLo) <= TOL && Math.abs(sliced[i].z - sliced[i + 1].z) > 1e-6) {
      edges.push((sliced[i].runHi + sliced[i + 1].runLo) / 2);
      assert.ok(Math.abs(Math.abs(sliced[i].z - sliced[i + 1].z) - riser) < 1e-6, `${tag} ${port}: 隣り合う段は蹴上 1 段ぶん`);
    }
  }
  const lo = sliced[0].runLo, hi = sliced.at(-1).runHi;
  assertSameSet(edges, hitsOn.filter(r => r > lo + TOL && r < hi - TOL), `${tag} ${port}`);
  for (const l of sliced) {
    if (l.turnStep > 0 && l.turnStep < p.totalSteps) assert.ok(Math.abs(l.z - l.turnStep * riser) < 1e-6, `${tag} ${port}: 段 ${l.turnStep} の天端＝番号×蹴上`);
  }
  const edgeRun = port === 'entry' ? p.run.base : p.run.end;
  const outerZ = port === 'entry' ? 0 : p.totalSteps * riser;
  const withEdge = sliced.filter(l => l.edgeRiser);
  assert.equal(withEdge.length, 1, `${tag} ${port}: 外縁の段差は 1 本`);
  assert.ok(Math.abs(withEdge[0].edgeRiser.run - edgeRun) < 1e-9 && withEdge[0].edgeRiser.outerZ === outerZ, `${tag} ${port}: 外縁の位置と外側の高さ`);
  assert.ok(Math.abs(withEdge[0].runLo - edgeRun) <= TOL || Math.abs(withEdge[0].runHi - edgeRun) <= TOL, `${tag} ${port}: スライスの端が外縁に接する`);
  assert.ok(planRunsAcross(g.outline, c.isVertical, v).some(r => Math.abs(r - edgeRun) <= TOL), `${tag} ${port}: 平面の外周に外縁の辺がある`);
  assert.equal(landingStepRisers(sliced, c.isVertical, cut).length, edges.length + withEdge.length, `${tag} ${port}: landingStepRisers の本数`);
  return { c, p, sliced, edges, withEdge };
}

// ---------------------------------------------------------------- 主ゲート

test('主ゲート（走行端の口）: 直進 4方向×flip で、展開図の蹴上＝平面の踏面線（両方向）。足元 0・段数 15・踊り場なし', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      const tag = `STRAIGHT/${dir}/flip=${flip}`;
      const { graph, stair } = fixture({ dir, flip, extra: { sections: [15] } });
      const { c, p } = assertFlightsMatchPlan(graph, stair, tag);
      assert.equal(c.flights.length, 1, tag);
      assert.equal(c.landings.length, 0, tag);
      assert.equal(c.flights[0].steps, 15, tag);
      assert.equal(c.flights[0].baseZ, 0, tag);
      assert.equal(c.flights[0].underSteps, undefined, tag);
      assert.deepEqual([c.zoneCells.entry.length, c.zoneCells.arrival.length], [0, 0], `${tag}: 走行端は区画なし`);
      // 走行範囲＝平面の始端〜終端
      assert.ok(Math.abs(c.flights[0].runLo - Math.min(p.run.base, p.run.end)) < 1e-9 && Math.abs(c.flights[0].runHi - Math.max(p.run.base, p.run.end)) < 1e-9, tag);
      // 上り口〜到達端の向き（up/left は軸の負方向）と travelSign
      assert.equal(c.flights[0].travelSign, (dir === 'up' || dir === 'left') ? -1 : 1, tag);
    }
  }
});

test('主ゲート（走行端の口）: 踊場付直進 4方向×flip で、2 つの flight の蹴上＝平面の踏面線、踊り場の走行範囲＝land1〜land2、z＝n1×蹴上', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      const tag = `STRAIGHT_LANDING/${dir}/flip=${flip}`;
      const { graph, stair } = fixture({ dir, flip, walk: [2000, 1000, 2000], type: StairType.STRAIGHT_LANDING, extra: { sections: [7, 1, 8] } });
      const { c, p } = assertFlightsMatchPlan(graph, stair, tag);
      assert.equal(c.flights.length, 2, tag);
      assert.equal(c.landings.length, 1, tag);
      const riser = c.flights[0].riserMm;
      assert.deepEqual([c.flights[0].steps, c.flights[1].steps], [7, 8], tag);
      assert.ok(Math.abs(c.landings[0].z - 7 * riser) < 1e-9, `${tag}: 踊り場の高さ`);
      assert.ok(Math.abs(c.flights[1].baseZ - 7 * riser) < 1e-9, `${tag}: 2 つ目の flight の足元＝踊り場`);
      assert.ok(Math.abs(c.landings[0].runLo - Math.min(p.run.land1, p.run.land2)) < 1e-9 && Math.abs(c.landings[0].runHi - Math.max(p.run.land1, p.run.land2)) < 1e-9, `${tag}: 踊り場の走行範囲`);
      // 最後の蹴上の天端＝上階の床（総蹴上数×蹴上）
      assert.ok(Math.abs(c.flights[1].baseZ + c.flights[1].steps * riser - p.totalSteps * riser) < 1e-9, tag);
    }
  }
});

test('主ゲート（側面の上り口）: e=0・1・2 × 左右 × 4方向×flip で、直進部の蹴上＝平面の踏面線、区画の蹴上＝放射線∩レーン線、外縁 base の段差 1 本（e=0 は平場）', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      for (const side of [LEFT, RIGHT]) {
        for (const e of [0, 1, 2]) {
          const tag = `side-entry/${dir}/flip=${flip}/${side}/e=${e}`;
          const { graph, stair } = fixture({ dir, flip, extra: { sections: [15 - e], entrySide: side, entryTurnSteps: e } });
          const { c, p } = assertFlightsMatchPlan(graph, stair, tag);
          assert.equal(c.flights[0].steps, 15 - e, `${tag}: 直進部は n1 段（区画の段は含まない）`);
          assert.ok(Math.abs(c.flights[0].baseZ - e * c.flights[0].riserMm) < 1e-9, `${tag}: 足元＝e×蹴上`);
          assert.equal(c.flights[0].underSteps, e > 0 ? e : undefined, tag);
          assert.equal(c.zoneCells.entry.length, e > 0 ? e : 1, `${tag}: 区画のセルは e 枚（e=0 は平場の矩形 1 枚）`);
          if (e === 0) {
            assert.deepEqual(c.zoneCells.entry.map(z => [z.z, z.number]), [[0, 0]], `${tag}: 平場は z=0`);
            const lane = laneCut(c, c.across.mid);
            const sl = withCutLandings(c, lane).landings.filter(l => l.turnStep === 0);
            assert.equal(sl.length, 1, tag);
            assert.ok(Math.abs(sl[0].runLo - Math.min(p.run.base, p.run.exitE)) < 1e-9 && Math.abs(sl[0].runHi - Math.max(p.run.base, p.run.exitE)) < 1e-9, `${tag}: 平場は base〜exitE`);
            assert.equal(sl[0].edgeRiser, undefined, `${tag}: 平場は外側と同じ高さ`);
          } else {
            zoneCheck(graph, stair, 'entry', tag);
          }
        }
      }
    }
  }
});

test('主ゲート（側面の到達口）: a=0（平場）・1・2 × 4方向×flip で、区画の蹴上＝放射線∩レーン線、直進部の終端の天端＝区画の最初のセル、外縁 end の段差 1 本', () => {
  for (const dir of DIRS) {
    for (const flip of [false, true]) {
      for (const a of [0, 1, 2]) {
        const tag = `side-arrival/${dir}/flip=${flip}/a=${a}`;
        const { graph, stair } = fixture({ dir, flip, extra: { sections: [15 - a], arrivalSide: LEFT, arrivalTurnSteps: a } });
        const { c, p } = assertFlightsMatchPlan(graph, stair, tag);
        assert.equal(c.flights[0].steps, 15 - a, tag);
        assert.equal(c.zoneCells.arrival.length, a > 0 ? a : 1, tag);
        const f = c.flights[0];
        const top = f.baseZ + f.steps * f.riserMm;
        assert.ok(Math.abs(top - c.zoneCells.arrival[0].z) < 1e-9, `${tag}: 直進部の終端＝区画の最初のセルの天端`);
        if (a === 0) {
          assert.deepEqual(c.zoneCells.arrival.map(z => [z.z, z.number]), [[p.totalSteps * f.riserMm, p.totalSteps]], `${tag}: 平場は上階の床の高さ`);
          assert.equal(withCutLandings(c, laneCut(c, c.across.mid)).landings.find(l => l.turnStep === p.totalSteps)?.edgeRiser, undefined, `${tag}: 平場は段差なし`);
        } else {
          zoneCheck(graph, stair, 'arrival', tag);
        }
      }
    }
  }
});

test('主ゲート（両口が側面）: 上り口 e=2・到達口 a=2。直進部は exitE〜exitA の n1 段で平面の踏面線と一致、区画は両方とも放射線∩レーン線', () => {
  for (const flip of [false, true]) {
    const tag = `both/flip=${flip}`;
    const { graph, stair } = fixture({ flip, extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 2, arrivalSide: RIGHT, arrivalTurnSteps: 2 } });
    assertFlightsMatchPlan(graph, stair, tag);
    zoneCheck(graph, stair, 'entry', tag);
    zoneCheck(graph, stair, 'arrival', tag);
  }
});

test('合成した踊場付直進の側面の口は実測できないので走行端と同じ（実セルでは先頭の行が直進部全体になり区画を選べない）: 踊り場・直進部の位置は変わらず区画のセルは無い', () => {
  const { graph, stair } = fixture({ walk: [2000, 1000, 2000], type: StairType.STRAIGHT_LANDING, extra: { sections: [6, 1, 8], entrySide: LEFT, entryTurnSteps: 2 } });
  const c = straightContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c);
  assert.deepEqual([c.zoneCells.entry.length, c.zoneCells.arrival.length], [0, 0]);
  assert.equal(c.flights[0].underSteps, undefined);
  assert.equal(c.flights[0].baseZ, 0);
});

// ---------------------------------------------------------------- 切断定義表（straightCuts）

const OPTS = { floorHeight: FLOOR_HEIGHT, chUpperAbsMm: 5600 };
function cutsOf(fx) {
  const faces = composeRoomFaces(fx.room, fx.graph);
  return straightCuts(fx.stair, faces, fx.graph, { ...OPTS, layers: buildBandLayers(fx.graph) });
}

test('seq1 は上り口辺 base（install 枠の基端）に立つ。側面の上り口でも base のまま。到達端の面は end（枠が通り芯→install になる分の差）', () => {
  for (const dir of DIRS) {
    for (const side of [null, LEFT]) {
      const tag = `${dir}/${side ?? 'end'}`;
      const fx = fixture({ dir, room: true, extra: { sections: side ? [11] : [15], ...(side ? { entrySide: side, entryTurnSteps: 4 } : {}) } });
      const table = cutsOf(fx);
      assert.ok(table, tag);
      const p = straightPlanLayout(fx.stair, fx.graph);
      const seq1 = table.cuts.find(c => c.seqNo === '1');
      assert.ok(Math.abs(seq1.line.axisValue - p.run.base) < 1e-9, `${tag}: seq1=${seq1.line.axisValue} base=${p.run.base}`);
      const arrival = table.cuts.find(c => c.seqNo === '3');
      assert.ok(Math.abs(arrival.line.axisValue - p.run.end) < 1e-9, `${tag}: 到達端=${arrival.line.axisValue} end=${p.run.end}`);
      // 到達端は壁の仕上げ面で止まる＝通り芯の枠の終端（階段室の中心線）より内側にある
      const b = roomBounds(fx.stair.cells, fx.graph);
      const clEnd = { up: b.y1, down: b.y2, left: b.x1, right: b.x2 }[dir];
      assert.ok(Math.abs(arrival.line.axisValue - clEnd) > 1, `${tag}: install の到達端は通り芯の端と違う`);
      // 切断線の向きと seq2/4 のレーン線（幅方向の中央）
      const lane = table.cuts.find(c => c.seqNo === '2').line;
      assert.ok(Math.abs(lane.axisValue - p.across.mid) < 1e-9, tag);
      assert.equal(table.contribution.frame.base, p.run.base, tag);
    }
  }
});

test('切断線の両端（lo/hi）は faceFromCut と同じく直交壁の面へ寄せた値。隅の直交壁が途切れて面が通り芯のままでも枠がずれない（側面の口の直進）', () => {
  for (const dir of DIRS) {
    const fx = fixture({ dir, room: true, extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4 } });
    const faces = composeRoomFaces(fx.room, fx.graph);
    const opts = { ...OPTS, layers: buildBandLayers(fx.graph) };
    const good = straightCuts(fx.stair, faces, fx.graph, opts);
    // 入口・到達の壁の面（走行軸に直交）の両端を 40mm 外へずらす＝隅に直交壁が無く通り芯側へはみ出した面（classifyFaces の出力）を模す
    const p = straightPlanLayout(fx.stair, fx.graph);
    const loose = faces.map(f => (f.isVertical !== p.vertical ? { ...f, lo: f.lo - 40, hi: f.hi + 40 } : f));
    const bad = straightCuts(fx.stair, loose, fx.graph, opts);
    assert.ok(good && bad, dir);
    for (const seq of ['1', '3']) {
      const a = good.cuts.find(c => c.seqNo === seq).line, b = bad.cuts.find(c => c.seqNo === seq).line;
      assert.ok(Math.abs(a.lo - b.lo) < 1e-9 && Math.abs(a.hi - b.hi) < 1e-9, `${dir} seq${seq}: lo/hi は直交壁の面へ寄る ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      // 絶対値: 図の側が導く面（faceFromCut）の lo/hi と一致する（面をずらしても不変、だけでは install の幅へ寄せる誤りを通す）
      for (const [label, table, fs] of [['good', good, faces], ['bad', bad, loose]]) {
        const cut = table.cuts.find(c => c.seqNo === seq);
        const ff = faceFromCut(cut, fs, null);
        assert.ok(Math.abs(cut.line.lo - ff.lo) < 1e-9 && Math.abs(cut.line.hi - ff.hi) < 1e-9, `${dir} seq${seq} ${label}: line=${cut.line.lo}..${cut.line.hi} faceFromCut=${ff.lo}..${ff.hi}`);
      }
    }
  }
});

test('側面の上り口でも seq1（base に立つ）は flight を正面視の対象にする（crossesFlight）。梯子は区画の段 e も含めて足元 0 から n1+e 段', () => {
  for (const dir of DIRS) {
    const fx = fixture({ dir, room: true, extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4 } });
    const table = cutsOf(fx);
    const seq1 = table.cuts.find(c => c.seqNo === '1');
    const [flight] = table.contribution.flights;
    assert.ok(crossesFlight(flight, seq1), `${dir}: seq1 が flight を横切る`);
    // 手前（走行の逆向き）側へ区画の長さを超えて外れると横切らない
    const p = straightPlanLayout(fx.stair, fx.graph);
    const behind = { ...seq1, line: { ...seq1.line, axisValue: p.run.base + (p.run.base - p.run.exitE) * 0.5 } };
    assert.equal(crossesFlight(flight, behind), false, `${dir}: 基端より手前は対象外`);
    const columns = [{ x0: -1e4, x1: 1e4, worldLo: -1e4, worldHi: 1e4, bands: [] }];
    const prims = stairPrimitivesForCut(table.contribution, seq1, columns);
    const ladder = prims.filter(q => q.type === 'line' && q.y1 === q.y2);
    const riser = flight.riserMm;
    const zs = new Set(ladder.map(q => Math.round(-q.y1 * 1000) / 1000));
    for (let k = 1; k <= 15; k++) assert.ok(zs.has(Math.round(k * riser * 1000) / 1000), `${dir}: 梯子の ${k} 段目 z=${k * riser}`);
  }
});

test('到達口が側面（a≥1）でも seq1 の梯子は 1..総蹴上数 の全段を持つ（上階の床の段鼻 z＝総蹴上数×蹴上まで）。4 方向 × a=1/2 × e=0/2', () => {
  for (const dir of DIRS) {
    for (const a of [1, 2]) {
      for (const e of [0, 2]) {
        const tag = `${dir}/a=${a}/e=${e}`;
        const fx = fixture({ dir, room: true, extra: { sections: [15 - e - a], arrivalSide: LEFT, arrivalTurnSteps: a, ...(e > 0 ? { entrySide: LEFT, entryTurnSteps: e } : {}) } });
        const table = cutsOf(fx);
        assert.ok(table, tag);
        const seq1 = table.cuts.find(c => c.seqNo === '1');
        const columns = [{ x0: -1e4, x1: 1e4, worldLo: -1e4, worldHi: 1e4, bands: [] }];
        const prims = stairPrimitivesForCut(table.contribution, seq1, columns);
        const riser = table.contribution.flights[0].riserMm;
        const zs = new Set(prims.filter(q => q.type === 'line' && q.y1 === q.y2).map(q => Math.round(-q.y1 * 1000) / 1000));
        for (let k = 1; k <= 15; k++) assert.ok(zs.has(Math.round(k * riser * 1000) / 1000), `${tag}: 梯子の ${k} 段目 z=${k * riser}`);
      }
    }
  }
});

test('側面の上り口の seq2/4（レーン線）は区画のスライスを持ち、蹴上は放射線∩レーン線。seq2/4 の stairCut は同じ寄与', () => {
  const fx = fixture({ room: true, extra: { sections: [12], entrySide: LEFT, entryTurnSteps: 3 } });
  const table = cutsOf(fx);
  const seq2 = table.cuts.find(c => c.seqNo === '2'), seq4 = table.cuts.find(c => c.seqNo === '4');
  assert.equal(seq2.stairCut, table.contribution);
  assert.equal(seq4.stairCut, table.contribution);
  const g = planGeom(fx.stair, fx.graph);
  const sl = withCutLandings(table.contribution, seq2).landings.filter(l => l.turnStep > 0);
  assert.equal(sl.length >= 3, true, '区画 3 段のスライス');
  const hits = radialCrossings(g.treads, true, seq2.line.axisValue);
  const edges = [];
  const sorted = [...sl].sort((a, b) => a.runLo - b.runLo);
  for (let i = 0; i + 1 < sorted.length; i++) if (Math.abs(sorted[i].runHi - sorted[i + 1].runLo) <= TOL && Math.abs(sorted[i].z - sorted[i + 1].z) > 1e-6) edges.push(sorted[i].runHi);
  const lo = sorted[0].runLo, hi = sorted.at(-1).runHi;
  assertSameSet(edges, hits.filter(r => r > lo + TOL && r < hi - TOL), 'seq2');
  // 縦線は stairPrimitivesForCut の content に出る（landingStepRisers）
  const columns = [{ x0: -1e4, x1: 1e4, worldLo: -1e4, worldHi: 1e4, bands: [] }];
  const prims = stairPrimitivesForCut(table.contribution, seq2, columns);
  for (const r of edges) {
    const x = localXOf(seq2, r);
    assert.ok(prims.some(q => q.type === 'line' && Math.abs(q.x1 - x) < 1e-6 && Math.abs(q.x2 - x) < 1e-6), `蹴上の縦線 run=${r}`);
  }
});

test('踊り場壁の探索は平面の踊り場の手前の縁 land1（install の枠）が中心。壁を land1 に置くと seq3 が入り、遠い壁は拾わない', () => {
  const fx = fixture({ walk: [2000, 1000, 2000], type: StairType.STRAIGHT_LANDING, room: true, extra: { sections: [7, 1, 8] } });
  const base = cutsOf(fx);
  assert.deepEqual(base.cuts.map(c => c.seqNo), ['1', '2', '4', '5'], '壁なし');
  const p = straightPlanLayout(fx.stair, fx.graph);
  const addWallAt = (y) => {
    const ym = fx.graph.addCenterLine(CenterLineType.HORIZONTAL, y, ARCH);
    const x0 = fx.graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
    const x2 = fx.graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
    fx.graph.addWall(ym, 50, false, x0, 0, x2, 0, { isRoomWall: false, isExteriorWall: false });
  };
  addWallAt(p.run.land1 + 400); // 許容差 300 の外
  assert.deepEqual(cutsOf(fx).cuts.map(c => c.seqNo), ['1', '2', '4', '5'], '遠い壁は拾わない');
  addWallAt(p.run.land1 + 100);
  const withWall = cutsOf(fx);
  assert.deepEqual(withWall.cuts.map(c => c.seqNo), ['1', '2', '3', '4', '5']);
  const seq3 = withWall.cuts.find(c => c.seqNo === '3');
  assert.ok(Math.abs(seq3.line.axisValue - p.run.land1) < 1e-9, 'seq3 の切断線は land1');
  assert.ok(Math.abs(seq3.baseFloorZ - withWall.contribution.landings[0].z) < 1e-9, 'seq3 の基準床＝踊り場の高さ');
});

// ---------------------------------------------------------------- 失敗系

test('失敗系: 直進系でない・階高未確定・セルが空・解決できないセルは straightContribution が null（例外にしない）', () => {
  const { graph, stair } = fixture({ extra: { sections: [15] } });
  assert.ok(straightContribution(stair, graph, FLOOR_HEIGHT));
  assert.equal(straightContribution(null, graph, FLOOR_HEIGHT), null);
  assert.equal(straightContribution(stair, graph, null), null, '階高未確定');
  for (const type of [StairType.SWITCHBACK, StairType.WINDING, StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL]) {
    const fx = fixture({ extra: { sections: [15] } });
    fx.stair.type = type;
    assert.equal(straightContribution(fx.stair, fx.graph, FLOOR_HEIGHT), null, type);
  }
  stair.setCells(new Set());
  assert.equal(straightContribution(stair, graph, FLOOR_HEIGHT), null, 'セルが空');
  stair.setCells(new Set(['no-such:cell:key:here']));
  assert.equal(straightContribution(stair, graph, FLOOR_HEIGHT), null, '解決できないセル');
});

test('失敗系: 区画のセルが番号の範囲から拾えない（蹴上が不正で平面の段が求まらない）なら null。straightCuts も null（フォールバック）', () => {
  const fx = fixture({ room: true, extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4, riser: -5 } });
  assert.equal(straightContribution(fx.stair, fx.graph, FLOOR_HEIGHT), null);
  assert.equal(cutsOf(fx), null);
  // 走行端の口は区画を拾わないので蹴上が不正でも寄与は組める（区画なし）
  const plain = fixture({ room: true, extra: { sections: [15], riser: -5 } });
  assert.ok(straightContribution(plain.stair, plain.graph, FLOOR_HEIGHT));
});

test('失敗系: 選べない保存値（1 行の直進の側面の上り口）は走行端と同じ寄与（区画なし・足元 0・seq1 は base）', () => {
  const fx = fixture({ walk: [3000], room: true, extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4 } });
  const c = straightContribution(fx.stair, fx.graph, FLOOR_HEIGHT);
  assert.ok(c);
  assert.deepEqual([c.zoneCells.entry.length, c.zoneCells.arrival.length], [0, 0]);
  assert.equal(c.flights[0].baseZ, 0);
  assert.equal(c.flights[0].underSteps, undefined);
  assert.equal(c.flights[0].entryRunMm, undefined);
});

test('straightContribution の呼び出しは繰り返しても同じ値で、平面の描画を変えない', () => {
  const { graph, stair } = fixture({ extra: { sections: [9], entrySide: LEFT, entryTurnSteps: 3, arrivalSide: RIGHT, arrivalTurnSteps: 3 } });
  const g1 = planGeom(stair, graph);
  const c1 = straightContribution(stair, graph, FLOOR_HEIGHT);
  assert.deepEqual(straightContribution(stair, graph, FLOOR_HEIGHT), c1);
  assert.deepEqual(planGeom(stair, graph), g1);
});
