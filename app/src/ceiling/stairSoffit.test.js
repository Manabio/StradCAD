// stairSoffit.js（天伏の見上げ。階段上の裏面。S13a）の単体テスト。実物の PlanGraph / Stair で組む（stairTreads.test.js の流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType, DEFAULT_ROOM_CEILING_HEIGHT } from '@core';
import { STAIR_SOFFIT_THICKNESS_MM } from '../core/constants.js';
import { stairSoffitSolids, stairBelowCeilingMm } from './stairSoffit.js';
import { uTurnPlanLayout, straightPlanLayout } from '../finish/stair/stairGeometry.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { makeGrid } from '../plan/planTestFixtures.js';

const RISER = 200;
const FL = 2800; // N+1 の FL
const TREAD = 250; // Stair の既定の踏面
const DZ = STAIR_SOFFIT_THICKNESS_MM * Math.sqrt(1 + (RISER / TREAD) ** 2); // 厚み / cosθ
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
const zTop = n => FL + n * RISER - DZ;

/** 踊り場（y 0..1000・全幅）＋往路・復路（y 1000..4000）。stairTreads.test.js の uTurn と同じ配置。 */
function uTurn(type, { sections = [6, 1, 6], structure = StructuralMaterialType.WOOD } = {}) {
  const { graph, cell } = makeGrid([0, 1000, 2000], [0, 1000, 4000]);
  const stair = graph.addStair({ type, cells: new Set([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)]), sections, flip: false, upDirection: 'up' });
  stair.structure = structure;
  return { graph, stair };
}

/** 縦長の直進系（幅 2000・x 0..2000、y は ys の境界）。 */
function straight(type, ys, sections, structure = StructuralMaterialType.WOOD) {
  const { graph, cell } = makeGrid([0, 1000, 2000], ys);
  const keys = [];
  for (let j = ys.length - 2; j >= 0; j--) for (let i = 0; i < 2; i++) keys.push(cell(i, j));
  const stair = graph.addStair({ type, cells: new Set(keys), sections, flip: false, upDirection: 'up' });
  stair.structure = structure;
  return { graph, stair };
}

const solidsOf = (stair, graph, extra = {}) => stairSoffitSolids({ stair, graph, riser: RISER, floorZMm: FL, ...extra });
/** 立体の run 軸上の z を、矩形の run 範囲の端で読む（zAt が無ければ平ら）。 */
const zAtPt = (s, x, y) => (s.zAt ? s.zAt(x, y) : s.zLo);

// ---------------------------------------------------------------- U字系

test('SWITCHBACK（踊り場）: 往路1＋踊り場1＋復路1 の3立体。往路は 当該階天井 → 回転部の最初の段の天端−dz、踊り場は平ら、復路は 最後の回転部の天端−dz → 総蹴上の天端−dz', () => {
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  const L = uTurnPlanLayout(stair, graph);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 3);
  assert.deepEqual(solids.map(s => s.kind), ['ceiling', 'ceiling', 'ceiling'], '面材として遮蔽に参加');
  assert.deepEqual(solids.map(s => s.source), [0, 1, 2].map(part => ({ kind: 'stairSoffit', id: String(stair.id), layerFloorZ: FL, part })));
  assert.ok(solids.every(s => s.drawEdges === undefined && !s.innerLines), '輪郭を描く（既定）。innerLines は使わない');
  const [out, land, back] = solids;
  // 縦走行（run は y・across は x）
  assert.equal(L.vertical, true);
  const runLo = Math.min(L.run.baseA, L.run.frontA), runHi = Math.max(L.run.baseA, L.run.frontA);
  assert.deepEqual(out.footprint.rects, [{ x1: Math.min(L.across.s0, L.across.sA), y1: runLo, x2: Math.max(L.across.s0, L.across.sA), y2: runHi }]);
  const xm = (L.across.s0 + L.across.sA) / 2;
  near(zAtPt(out, xm, L.run.baseA), DEFAULT_ROOM_CEILING_HEIGHT, '往路の上り口 = 当該階天井（対の部屋なし → 既定。floorZMm は足さない）');
  near(zAtPt(out, xm, L.run.frontA), zTop(L.firstTurnNumber), '往路の前縁');
  near(out.zLo, Math.min(DEFAULT_ROOM_CEILING_HEIGHT, zTop(L.firstTurnNumber)), 'zLo = 端点の低い方');
  near(out.zHi, Math.max(DEFAULT_ROOM_CEILING_HEIGHT, zTop(L.firstTurnNumber)), 'zHi = 端点の高い方（解決器は min(zHi, zAt) を使う）');
  // 踊り場: 1 マスの平らな面（折れ線なし）
  assert.equal(L.turnCells, 1);
  assert.equal(land.zAt, undefined);
  near(land.zLo, zTop(L.firstTurnNumber), '踊り場の高さ');
  assert.equal(land.zLo, land.zHi);
  assert.ok(land.footprint.poly.length >= 6);
  // 復路
  const xb = (L.across.sB + L.across.s1) / 2;
  near(zAtPt(back, xb, L.run.front), zTop(L.firstTurnNumber + L.turnCells - 1), '復路の前縁 = 最後の回転部マスの天端−dz（回転部と連続）');
  near(zAtPt(back, xb, L.run.baseB), zTop(L.totalSteps), '復路の到達辺 = 総蹴上の天端−dz（N+2 の FL 側）');
});

test('WINDING: 回転部のマス数ぶんの面（扇形ごとに平ら）。番号 n の面は 天端−dz で、番号順に1蹴上ずつ上がる。多角形は stairTreadFootprints と同じ', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [6, 3, 6] });
  const L = uTurnPlanLayout(stair, graph);
  assert.equal(L.turnCells, 3);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 2 + L.turnCells);
  const turns = solids.slice(1, 1 + L.turnCells);
  const treads = stairTreadFootprints(stair, graph, { riser: RISER, insetView: 'upper' });
  turns.forEach((s, i) => {
    const n = L.firstTurnNumber + i;
    near(s.zLo, zTop(n), `回転部 ${n}`);
    assert.equal(s.zLo, s.zHi);
    assert.deepEqual(s.footprint.poly, treads.find(t => t.number === n).poly);
  });
  near(turns[1].zLo - turns[0].zLo, RISER, '隣の面とは 1 蹴上の段差');
});

test('取りつき回転部の番号の段（entry/arrival の回転部）は回転部の面に混ぜない（firstTurnNumber 〜 +turnCells−1 だけ）', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [6, 3, 6] });
  const L = uTurnPlanLayout(stair, graph);
  const numbers = solidsOf(stair, graph).filter(s => s.footprint.poly).map(s => Math.round((s.zLo - (FL - DZ)) / RISER));
  assert.deepEqual(numbers, Array.from({ length: L.turnCells }, (_, i) => L.firstTurnNumber + i));
});

// ---------------------------------------------------------------- 直進系

test('STRAIGHT: 1 立体。base で 当該階天井 → end で 総蹴上の天端−dz', () => {
  const { graph, stair } = straight(StairType.STRAIGHT, [0, 1000, 2000, 3000], [15]);
  const L = straightPlanLayout(stair, graph);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 1);
  const xm = (L.across.s0 + L.across.s1) / 2;
  near(zAtPt(solids[0], xm, L.run.base), DEFAULT_ROOM_CEILING_HEIGHT, 'base');
  near(zAtPt(solids[0], xm, L.run.end), zTop(L.totalSteps), 'end');
});

test('STRAIGHT_LANDING: 直進部1（base → 踊り場の高さ）／踊り場（平ら）／直進部2（踊り場の高さ → end）', () => {
  const { graph, stair } = straight(StairType.STRAIGHT_LANDING, [0, 1000, 2000, 3000, 4000, 5000], [6, 1, 6]);
  const L = straightPlanLayout(stair, graph);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 3);
  const xm = (L.across.s0 + L.across.s1) / 2;
  const zLand = zTop(L.landingNumber);
  near(zAtPt(solids[0], xm, L.run.base), DEFAULT_ROOM_CEILING_HEIGHT, 'base');
  near(zAtPt(solids[0], xm, L.run.land1), zLand, '直進部1の終端');
  assert.equal(solids[1].zAt, undefined);
  near(solids[1].zLo, zLand, '踊り場は平ら');
  near(zAtPt(solids[2], xm, L.run.land2), zLand, '直進部2の始端');
  near(zAtPt(solids[2], xm, L.run.end), zTop(L.totalSteps), 'end');
});

// ---------------------------------------------------------------- 当該階天井

test('当該階天井: N の階段の対の部屋の CH＋床段差。対の部屋が無い・参照切れ・belowGraph なしは既定の天井高', () => {
  const below = makeGrid([0, 1000, 2000], [0, 1000, 4000]);
  const room = below.interior([[0, 0], [1, 0], [0, 1], [1, 1]]);
  room.setOverride('ceilingHeight', '2600');
  const belowStair = { roomId: room.id };
  assert.equal(stairBelowCeilingMm(belowStair, below.graph), 2600 + (below.graph.effectiveFloorLevel(room) - below.graph.effectiveFloorLevel(null)));
  assert.equal(stairBelowCeilingMm({ roomId: 'nope' }, below.graph), DEFAULT_ROOM_CEILING_HEIGHT, '参照切れ');
  assert.equal(stairBelowCeilingMm({ roomId: null }, below.graph), DEFAULT_ROOM_CEILING_HEIGHT, 'roomId なし');
  assert.equal(stairBelowCeilingMm(belowStair, null), DEFAULT_ROOM_CEILING_HEIGHT, 'belowGraph なし');
  // 立体の始点にも反映される
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  const L = uTurnPlanLayout(stair, graph);
  const [out] = solidsOf(stair, graph, { belowStair, belowGraph: below.graph });
  near(zAtPt(out, (L.across.s0 + L.across.sA) / 2, L.run.baseA), stairBelowCeilingMm(belowStair, below.graph), '往路の上り口');
});

// ---------------------------------------------------------------- 対象外・失敗経路

test('対象外は []: 鉄骨・L_TURN・FLARED・OPEN_WELL・蹴上／踏面が求まらない・階段／graph なし・セルなし（例外にしない）', () => {
  const wood = uTurn(StairType.SWITCHBACK);
  assert.equal(solidsOf(wood.stair, wood.graph).length, 3, '前提: 木造の折返しは出る');
  const steel = uTurn(StairType.SWITCHBACK, { structure: StructuralMaterialType.STEEL });
  assert.deepEqual(solidsOf(steel.stair, steel.graph), [], '鉄骨は裏面なし（踏面線は planSolids 側）');
  for (const type of [StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL]) {
    const g = uTurn(type);
    assert.deepEqual(solidsOf(g.stair, g.graph), [], type);
  }
  for (const riser of [null, undefined, 0, -5, NaN]) assert.deepEqual(solidsOf(wood.stair, wood.graph, { riser }), [], `riser=${riser}`);
  assert.deepEqual(solidsOf(wood.stair, wood.graph, { floorZMm: NaN }), [], 'floorZMm 非有限');
  assert.deepEqual(solidsOf(null, wood.graph), []);
  assert.deepEqual(solidsOf(wood.stair, null), []);
  const noTread = uTurn(StairType.SWITCHBACK);
  noTread.stair.tread = 0;
  assert.deepEqual(solidsOf(noTread.stair, noTread.graph), [], '踏面 0');
  const empty = uTurn(StairType.SWITCHBACK);
  empty.stair.cells = new Set();
  assert.deepEqual(solidsOf(empty.stair, empty.graph), [], 'セルなし');
  const emptyStraight = straight(StairType.STRAIGHT, [0, 1000, 2000, 3000], [15]);
  emptyStraight.stair.cells = new Set();
  assert.deepEqual(solidsOf(emptyStraight.stair, emptyStraight.graph), [], '直進系でセルなし');
});

test('厚みは傾斜に直交（dz = 厚み / cosθ）: 踏面を変えると dz が変わり、面は垂直厚み 300 より深く下がる', () => {
  const a = uTurn(StairType.SWITCHBACK), b = uTurn(StairType.SWITCHBACK);
  b.stair.tread = 400;
  const land = g => solidsOf(g.stair, g.graph)[1].zLo;
  const dzOf = tread => STAIR_SOFFIT_THICKNESS_MM * Math.sqrt(1 + (RISER / tread) ** 2);
  const n = uTurnPlanLayout(a.stair, a.graph).firstTurnNumber;
  near(land(a), FL + n * RISER - dzOf(250), 'tread 250');
  near(land(b), FL + n * RISER - dzOf(400), 'tread 400');
  assert.ok(dzOf(250) > STAIR_SOFFIT_THICKNESS_MM && dzOf(250) > dzOf(400), '急なほど垂直の下がりは大きい');
});

test('手計算の固定値: SWITCHBACK sections [6,1,6]・蹴上 200・踏面 250・FL 2800 → 回転部の最初の番号 6・総蹴上 12・dz≈384.1874542。往路 2400→3615.81、踊り場 3615.81、復路 3615.81→4815.81', () => {
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  const L = uTurnPlanLayout(stair, graph);
  assert.deepEqual([L.firstTurnNumber, L.turnCells, L.totalSteps], [6, 1, 12]);
  const dz = 300 * Math.sqrt(1 + 0.8 ** 2); // 300 / cosθ（tanθ = 200/250）
  near(dz, 384.1874542, 'dz');
  const [out, land, back] = solidsOf(stair, graph);
  near(out.zLo, 2400, '往路の下端（当該階天井。既定の天井高）');
  near(out.zHi, 2800 + 6 * 200 - 384.1874542, '往路の上端 = FL + 6 蹴上 − dz = 3615.8125458');
  near(land.zLo, 3615.8125458, '踊り場');
  near(back.zLo, 3615.8125458, '復路の下端');
  near(back.zHi, 2800 + 12 * 200 - 384.1874542, '復路の上端 = FL + 12 蹴上 − dz = 4815.8125458');
});

// ---------------------------------------------------------------- レーン（向き × flip）

const centroid = poly => {
  const n = poly.length / 2;
  let x = 0, y = 0;
  for (let i = 0; i < poly.length; i += 2) { x += poly[i]; y += poly[i + 1]; }
  return [x / n, y / n];
};
const inFootprint = (fp, x, y) => (fp.rects ?? []).some(r => x >= r.x1 - 1e-6 && x <= r.x2 + 1e-6 && y >= r.y1 - 1e-6 && y <= r.y2 + 1e-6);

for (const upDirection of ['up', 'down', 'left', 'right']) {
  for (const flip of [false, true]) {
    test(`レーン（実装と独立に stairTreadFootprints と照合）: upDirection=${upDirection} flip=${flip} — 踏面 1 の重心は往路の中、最後の踏面の重心は復路の中、z は段の天端−dz から 2 蹴上以内`, () => {
      const { graph, cell } = makeGrid([0, 2000, 4000], [0, 2000, 4000]);
      const stair = graph.addStair({ type: StairType.SWITCHBACK, cells: new Set([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)]), sections: [6, 1, 6], flip, upDirection });
      stair.structure = StructuralMaterialType.WOOD;
      const solids = solidsOf(stair, graph);
      assert.equal(solids.length, 3);
      const treads = stairTreadFootprints(stair, graph, { riser: RISER, insetView: 'upper' }).sort((a, b) => a.number - b.number);
      const first = treads[0], last = treads[treads.length - 1];
      const [fx, fy] = centroid(first.poly), [lx, ly] = centroid(last.poly);
      assert.ok(inFootprint(solids[0].footprint, fx, fy), `踏面 ${first.number} は往路の中`);
      assert.ok(inFootprint(solids[2].footprint, lx, ly), `踏面 ${last.number} は復路の中`);
      for (const [t, x, y, sf] of [[first, fx, fy, solids[0]], [last, lx, ly, solids[2]]]) {
        const z = sf.zAt ? sf.zAt(x, y) : sf.zLo;
        assert.ok(Math.abs(z - zTop(t.number)) <= 2 * RISER, `踏面 ${t.number}: 面の z ${z} が 天端−dz ${zTop(t.number)} から 2 蹴上以内`);
      }
    });
  }
}
