// stairSoffit.js（天伏の見上げ。階段上の裏面。S13a）の単体テスト。実物の PlanGraph / Stair で組む（stairTreads.test.js の流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType, DEFAULT_ROOM_CEILING_HEIGHT, Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { classifyStairArea } from '../finish/stair/stairClassify.js';
import { STAIR_SOFFIT_THICKNESS_MM } from '../core/constants.js';
import { stairSoffitSolids, stairBelowCeilingMm, uTurnSoffitFromLayout, straightSoffitFromLayout } from './stairSoffit.js';
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

// ---------------------------------------------------------------- U字系（階段 1 本 = 1 立体）

const lineKey = l => l.points.map(v => Math.round(v * 1000) / 1000).join(',');

test('WINDING（手計算の固定値。sections [5,6,5]・蹴上200・FL2800・dz≈384.1874542）: 1 立体・矩形 4 枚。回転部は 4 三角の平面で、頂点の高さは角度で等分', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [5, 6, 5] });
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 1, '階段 1 本につき 1 立体（別立体の接する辺で線が 2 重にならない）');
  const [sf] = solids;
  assert.equal(sf.kind, 'ceiling');
  assert.deepEqual(sf.source, { kind: 'stairSoffit', id: String(stair.id), layerFloorZ: FL, part: 0 });
  assert.equal(sf.drawEdges, undefined, '輪郭を描く（既定）');
  // 縦走行: x＝幅方向（57.5〜1942.5・ピボット x=1000）、y＝走行（往路の上り口 4000・前縁 1000・奥 57.5）。到達辺も 4000
  assert.deepEqual(sf.footprint.rects, [
    { x1: 57.5, y1: 1000, x2: 1000, y2: 4000 },    // 往路 R_A
    { x1: 57.5, y1: 57.5, x2: 1000, y2: 1000 },    // 回転部 A
    { x1: 1000, y1: 57.5, x2: 1942.5, y2: 1000 },  // 回転部 B
    { x1: 1000, y1: 1000, x2: 1942.5, y2: 4000 },  // 復路 R_B
  ]);
  const dz = 384.1874542;
  const zA = 2800 + 5 * 200 - dz, zB = 2800 + 10 * 200 - dz, zEnd = 2800 + 15 * 200 - dz; // 回転部 5..10・総蹴上 15
  near(zB - zA, 1000, 'Δ = 回転部固有の蹴上 5 × 200');
  const z = (x, y) => sf.zAt(x, y);
  near(z(500, 4000), 2400, '往路の上り口 = 当該階天井（既定）');
  near(z(500, 1000), zA, 'F_A（往路の前縁）');
  near(z(999, 1000), zA, 'P_A（往路側のピボット）');
  near(z(1001, 1000), zB, 'P_B（復路側のピボット）');
  near(z(1900, 1000), zB, 'F_B');
  near(z(1000, 57.5), zA + 500, 'I（内側の奥）= 中点');
  near(z(57.5, 57.5), zA + 250, 'O_A（往路側の外側の奥の角）= 1/4');
  near(z(1942.5, 57.5), zA + 750, 'O_B = 3/4');
  near(z(1500, 4000), zEnd, '復路の到達辺');
  // 三角の内側は平面補間（A1=(P_A,F_A,O_A) の重心）
  near(z((1000 + 57.5 + 57.5) / 3, (1000 + 1000 + 57.5) / 3), zA + 250 / 3, 'A1 の重心');
  near(sf.zLo, 2400, 'zLo'); near(sf.zHi, zEnd, 'zHi');
  // 面の折れ目: 往路との境・復路との境・対角線 2 本（隔て板の角点 → 外側の奥の角）・あき 0 の往路/復路の境と A/B の境。6 本ちょうど
  assert.deepEqual(sf.innerLines.map(l => l.role), Array(6).fill('stairSoffitFold'));
  assert.deepEqual(sf.innerLines.map(lineKey), [
    '57.5,1000,1000,1000',
    '1000,1000,1942.5,1000',
    '1000,1000,57.5,57.5',
    '1000,1000,1942.5,57.5',
    '1000,1000,1000,4000', // あき 0（sA==sB）の往路 R_A と復路 R_B の境
    '1000,1000,1000,57.5', // あき 0 の回転部 A と B の境（高さが食い違う共有辺）
  ]);
});

test('回転部の段数によらず 4 三角（sections [6,3,6] でも矩形 4 枚・対角線 2 本）。頂点の高さは段数ぶんの Δ を等分', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [6, 3, 6] });
  const [sf] = solidsOf(stair, graph);
  assert.equal(sf.footprint.rects.length, 4);
  assert.equal(sf.innerLines.length, 6);
  const zA = zTop(6), delta = 2 * RISER; // 回転部 6..8
  near(sf.zAt(1000, 57.5), zA + delta / 2, 'I');
  near(sf.zAt(57.5, 57.5), zA + delta / 4, 'O_A');
  near(sf.zAt(1942.5, 57.5), zA + 3 * delta / 4, 'O_B');
});

test('SWITCHBACK（踊り場・回転部 1 マス）: 回転部は平ら（Δ=0）。対角線も A/B の境も描かず、折れ目は往路・復路との境の 2 本＋あき 0 の往路/復路の境 1 本', () => {
  const { graph, stair } = uTurn(StairType.SWITCHBACK);
  const [sf] = solidsOf(stair, graph);
  assert.equal(solidsOf(stair, graph).length, 1);
  assert.equal(sf.footprint.rects.length, 4);
  assert.deepEqual(sf.innerLines.map(lineKey), ['57.5,1000,1000,1000', '1000,1000,1942.5,1000', '1000,1000,1000,4000']);
  for (const [x, y] of [[57.5, 57.5], [500, 500], [1000, 57.5], [1500, 600], [1942.5, 1000]]) near(sf.zAt(x, y), zTop(6), `踊り場 (${x},${y}) は平ら`);
  near(sf.zAt(500, 4000), DEFAULT_ROOM_CEILING_HEIGHT, '往路の上り口 = 当該階天井（既定。floorZMm は足さない）');
  near(sf.zAt(1500, 4000), zTop(12), '復路の到達辺 = 総蹴上の天端−dz（N+2 の FL 側）');
  near(sf.zAt(500, 1000), zTop(6), '往路の前縁 = 回転部の最初の段の天端−dz');
});

test('取りつき回転部の番号の段（entry/arrival）は回転部の高さに混ぜない（回転部の頂点は firstTurnNumber 〜 +turnCells−1 だけ）', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [6, 3, 6] });
  const L = uTurnPlanLayout(stair, graph);
  const [sf] = solidsOf(stair, graph);
  near(sf.zAt(500, L.run.frontA), zTop(L.firstTurnNumber), '回転部の最初');
  near(sf.zAt(1900, L.run.front), zTop(L.firstTurnNumber + L.turnCells - 1), '回転部の最後');
});

// ---------------------------------------------------------------- 直進系

test('STRAIGHT: 1 立体・矩形 1 枚・折れ目なし。base で 当該階天井 → end で 総蹴上の天端−dz', () => {
  const { graph, stair } = straight(StairType.STRAIGHT, [0, 1000, 2000, 3000], [15]);
  const L = straightPlanLayout(stair, graph);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 1);
  assert.equal(solids[0].footprint.rects.length, 1);
  assert.equal(solids[0].innerLines, undefined);
  const xm = (L.across.s0 + L.across.s1) / 2;
  near(zAtPt(solids[0], xm, L.run.base), DEFAULT_ROOM_CEILING_HEIGHT, 'base');
  near(zAtPt(solids[0], xm, L.run.end), zTop(L.totalSteps), 'end');
});

test('STRAIGHT_LANDING: 1 立体・矩形 3 枚。直進部1（base → 踊り場の高さ）／踊り場（平ら）／直進部2（踊り場の高さ → end）。折れ目は land1・land2 の 2 本', () => {
  const { graph, stair } = straight(StairType.STRAIGHT_LANDING, [0, 1000, 2000, 3000, 4000, 5000], [6, 1, 6]);
  const L = straightPlanLayout(stair, graph);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 1);
  const [sf] = solids;
  assert.equal(sf.footprint.rects.length, 3);
  const xm = (L.across.s0 + L.across.s1) / 2;
  const zLand = zTop(L.landingNumber);
  near(zAtPt(sf, xm, L.run.base), DEFAULT_ROOM_CEILING_HEIGHT, 'base');
  near(zAtPt(sf, xm, L.run.land1), zLand, '直進部1の終端');
  near(zAtPt(sf, xm, (L.run.land1 + L.run.land2) / 2), zLand, '踊り場は平ら');
  near(zAtPt(sf, xm, L.run.land2), zLand, '直進部2の始端');
  near(zAtPt(sf, xm, L.run.end), zTop(L.totalSteps), 'end');
  assert.deepEqual(sf.innerLines.map(l => l.role), ['stairSoffitFold', 'stairSoffitFold']);
  assert.deepEqual(sf.innerLines.map(l => l.points[1]), [L.run.land1, L.run.land2], '折れ目は踊り場の両端（縦走行なら y）');
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
  assert.equal(solidsOf(wood.stair, wood.graph).length, 1, '前提: 木造の折返しは出る');
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
  const land = g => solidsOf(g.stair, g.graph)[0].zAt(500, 500); // 踊り場（平ら）
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
  const [sf] = solidsOf(stair, graph);
  near(sf.zLo, 2400, '往路の下端（当該階天井。既定の天井高）');
  near(sf.zHi, 2800 + 12 * 200 - 384.1874542, '最上端 = FL + 12 蹴上 − dz = 4815.8125458');
  near(sf.zAt(500, 4000), 2400, '往路の上り口');
  near(sf.zAt(500, 1000), 3615.8125458, '往路の前縁');
  near(sf.zAt(500, 500), 3615.8125458, '踊り場');
  near(sf.zAt(1500, 1000), 3615.8125458, '復路の前縁');
  near(sf.zAt(1500, 4000), 4815.8125458, '復路の到達辺');
});

// ---------------------------------------------------------------- レーン（向き × flip）

const centroid = poly => {
  const n = poly.length / 2;
  let x = 0, y = 0;
  for (let i = 0; i < poly.length; i += 2) { x += poly[i]; y += poly[i + 1]; }
  return [x / n, y / n];
};
const inFootprint = (fp, x, y) => (fp.rects ?? []).some(r => x >= r.x1 - 1e-6 && x <= r.x2 + 1e-6 && y >= r.y1 - 1e-6 && y <= r.y2 + 1e-6);

for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
  for (const upDirection of ['up', 'down', 'left', 'right']) {
    for (const flip of [false, true]) {
      test(`レーン（実装と独立に stairTreadFootprints と照合）: ${type} upDirection=${upDirection} flip=${flip} — 1 立体で、踏面 1 の重心と最後の踏面の重心は立体の中、z は段の天端−dz から 2 蹴上以内`, () => {
        const { graph, cell } = makeGrid([0, 2000, 4000], [0, 2000, 4000]);
        const stair = graph.addStair({ type, cells: new Set([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)]), sections: [6, type === StairType.WINDING ? 3 : 1, 6], flip, upDirection });
        stair.structure = StructuralMaterialType.WOOD;
        const solids = solidsOf(stair, graph);
        assert.equal(solids.length, 1);
        const [sf] = solids;
        const treads = stairTreadFootprints(stair, graph, { riser: RISER, insetView: 'upper' }).sort((a, b) => a.number - b.number);
        const first = treads[0], last = treads[treads.length - 1];
        for (const t of [first, last]) {
          const [x, y] = centroid(t.poly);
          assert.ok(inFootprint(sf.footprint, x, y), `踏面 ${t.number} は立体の中`);
          assert.ok(Math.abs(sf.zAt(x, y) - zTop(t.number)) <= 2 * RISER, `踏面 ${t.number}: 面の z が 天端−dz ${zTop(t.number)} から 2 蹴上以内`);
        }
        const L = uTurnPlanLayout(stair, graph);
        assert.ok(sf.innerLines.every(l => l.points.length === 4 && l.points.every(Number.isFinite)));
        assert.equal(sf.innerLines.length, type === StairType.WINDING ? 6 : 3); // あき 0 の往路/復路の境を含む
        near(sf.zHi, zTop(L.totalSteps), '最上端は総蹴上の天端−dz');
      });
    }
  }
}

// ---------------------------------------------------------------- layout を模した入力で幾何を直接検証（柱あり・frontA≠front・pivotAcross≠sA・向きの反転）

/** moku4-3 の 2F の階段（WINDING・柱あり）の uTurnPlanLayout の値。 */
const MOKU43 = {
  vertical: true,
  run: { baseA: -9100, frontA: -8235, front: -8145, baseB: -9100, back: -7352.5 },
  across: { s0: 72.5, sA: 852.5, sB: 967.5, s1: 1747.5, mid: 910 },
  pivotAcross: 865, hasColumn: true, firstTurnNumber: 5, turnCells: 6, totalSteps: 15,
};
const ctxOf = (zStart = 2400) => ({ zStart, zTop });
const ZA43 = FL + 5 * RISER - DZ, ZB43 = FL + 10 * RISER - DZ, ZEND43 = FL + 15 * RISER - DZ;

/** layout を向きごと変換する: sa＝幅方向の符号、sr＝走行方向の符号、swap＝vertical の反転（world への写しだけが変わる）。 */
function transformLayout(L, { sa, sr, swap }) {
  const mapA = v => sa * v, mapR = v => sr * v;
  return {
    ...L,
    vertical: swap ? !L.vertical : L.vertical,
    run: Object.fromEntries(Object.entries(L.run).map(([k, v]) => [k, mapR(v)])),
    across: Object.fromEntries(Object.entries(L.across).map(([k, v]) => [k, mapA(v)])),
    pivotAcross: mapA(L.pivotAcross),
  };
}
/** (a, r)（元の向きでの幅方向・走行方向）→ 変換後の世界座標。 */
const worldOf = (Lt, sa, sr) => (a, r) => (Lt.vertical ? [sa * a, sr * r] : [sr * r, sa * a]);
const lineKeyOf = pts => pts.map(v => Math.round(v * 1000) / 1000).join(',');
const norm = pts => (pts[0] < pts[2] || (pts[0] === pts[2] && pts[1] <= pts[3]) ? pts : [pts[2], pts[3], pts[0], pts[1]]);

/** 立体の外周（矩形群の和の境界）に折れ目の線が載っていない（輪郭との重なり）か、折れ目どうしが重なっていないかを調べる。問題の説明の配列を返す。 */
function overlapProblems(sf) {
  const rects = sf.footprint.rects, eps = 0.01, problems = [];
  const inside = (x, y) => rects.some(r => x >= r.x1 - 1e-6 && x <= r.x2 + 1e-6 && y >= r.y1 - 1e-6 && y <= r.y2 + 1e-6);
  const onOutline = (x, y) => inside(x, y) && [[eps, 0], [-eps, 0], [0, eps], [0, -eps]].some(([dx, dy]) => !inside(x + dx, y + dy));
  const samples = pts => Array.from({ length: 19 }, (_, i) => {
    const t = (i + 1) / 20;
    return [pts[0] + (pts[2] - pts[0]) * t, pts[1] + (pts[3] - pts[1]) * t];
  });
  const onLine = (x, y, p) => {
    const dx = p[2] - p[0], dy = p[3] - p[1], len2 = dx * dx + dy * dy;
    const t = Math.min(Math.max(((x - p[0]) * dx + (y - p[1]) * dy) / len2, 0), 1);
    return Math.hypot(x - (p[0] + dx * t), y - (p[1] + dy * t)) < 0.05;
  };
  sf.innerLines.forEach((l, i) => {
    for (const [x, y] of samples(l.points)) if (onOutline(x, y)) { problems.push(`折れ目 ${i} が輪郭と重なる (${x.toFixed(1)},${y.toFixed(1)})`); break; }
    sf.innerLines.forEach((m, j) => {
      if (j <= i) return;
      if (samples(l.points).some(([x, y]) => onLine(x, y, m.points))) problems.push(`折れ目 ${i} と ${j} が重なる`);
    });
  });
  return problems;
}

test('柱あり WINDING（moku4-3 の値）: 前縁は両レーン共通の -8145 の 1 本。対角線は隔て板の角点 (852.5,-8145)／(967.5,-8145) から。y=-8235（frontA）・x=865（ピボット）の線は無い', () => {
  const sf = uTurnSoffitFromLayout(MOKU43, ctxOf());
  assert.deepEqual(sf.footprint.rects, [
    { x1: 72.5, y1: -9100, x2: 852.5, y2: -8145 },       // 往路 R_A
    { x1: 72.5, y1: -8145, x2: 852.5, y2: -7352.5 },     // 回転部 A（780 × 792.5 ≒ 正方形）
    { x1: 852.5, y1: -8145, x2: 967.5, y2: -7352.5 },    // 隔て板の延長の帯 S
    { x1: 967.5, y1: -8145, x2: 1747.5, y2: -7352.5 },   // 回転部 B
    { x1: 967.5, y1: -9100, x2: 1747.5, y2: -8145 },     // 復路 R_B
  ]);
  const qa = sf.footprint.rects[1];
  assert.ok(Math.abs((qa.x2 - qa.x1) - (qa.y2 - qa.y1)) < 15, '回転部の矩形はほぼ正方形（対角線 45 度相当）');
  assert.deepEqual(sf.innerLines.map(l => l.role), Array(4).fill('stairSoffitFold'));
  assert.deepEqual(sf.innerLines.map(l => lineKeyOf(l.points)), [
    '72.5,-8145,852.5,-8145',
    '967.5,-8145,1747.5,-8145',
    '852.5,-8145,72.5,-7352.5',
    '967.5,-8145,1747.5,-7352.5',
  ]);
  assert.ok(sf.innerLines.every(l => l.points[1] !== -8235 && l.points[3] !== -8235), 'frontA（柱の往路側の面）の線は無い');
  assert.ok(sf.innerLines.every(l => l.points[0] !== 865 || l.points[2] !== 865), 'ピボット線は無い');
  // 手計算: dz≈384.1874542・FL2800 → zA=zTop(5)=3415.8125458、zB=zTop(10)=4415.8125458、Δ=1000
  near(ZA43, 3415.8125458, 'zA'); near(ZB43, 4415.8125458, 'zB');
  near(sf.zAt(852.5, -8145), ZA43, 'P_A（隔て板の角点）');
  near(sf.zAt(72.5, -8145), ZA43, 'F_A');
  near(sf.zAt(967.5, -8145), ZB43, 'P_B');
  near(sf.zAt(1747.5, -8145), ZB43, 'F_B');
  near(sf.zAt(852.5, -7352.5), ZA43 + 500, 'I_A');
  near(sf.zAt(967.5, -7352.5), ZA43 + 500, 'I_B');
  near(sf.zAt(72.5, -7352.5), ZA43 + 250, 'O_A');
  near(sf.zAt(1747.5, -7352.5), ZA43 + 750, 'O_B');
  near(sf.zAt(910, -8145), (ZA43 + ZB43) / 2, '帯 S の前縁の中点');
  near(sf.zAt(881.25, -8145), ZA43 + 250, '帯 S の前縁の 1/4');
  near(sf.zAt(910, -7352.5), ZA43 + 500, '帯 S の奥');
  near(sf.zAt(500, -9100), 2400, '往路の上り口');
  near(sf.zAt(500, -8145), ZA43, '往路の終端（前縁）');
  near(sf.zAt(1500, -9100), ZEND43, '復路の到達辺');
  assert.deepEqual(overlapProblems(sf), []);
});

for (const sa of [1, -1]) for (const sr of [1, -1]) for (const swap of [false, true]) {
  test(`向きの反転（幅方向 ${sa > 0 ? '+' : '-'}・走行 ${sr > 0 ? '+' : '-'}・vertical ${swap ? '反転' : '同じ'}）: 柱あり WINDING の折れ目・高さが向きによらず成り立ち、線の重なりが無い`, () => {
    const Lt = transformLayout(MOKU43, { sa, sr, swap });
    const sf = uTurnSoffitFromLayout(Lt, ctxOf());
    const W = worldOf(Lt, sa, sr);
    assert.equal(sf.footprint.rects.length, 5);
    // 折れ目の端点は元の (a, r) を同じ写像で移したものと一致する
    const expected = [[72.5, -8145, 852.5, -8145], [967.5, -8145, 1747.5, -8145], [852.5, -8145, 72.5, -7352.5], [967.5, -8145, 1747.5, -7352.5]]
      .map(([a0, r0, a1, r1]) => lineKeyOf(norm([...W(a0, r0), ...W(a1, r1)])));
    assert.deepEqual(sf.innerLines.map(l => lineKeyOf(norm(l.points))), expected);
    for (const [a, r, z] of [[852.5, -8145, ZA43], [72.5, -8145, ZA43], [967.5, -8145, ZB43], [1747.5, -8145, ZB43], [852.5, -7352.5, ZA43 + 500], [72.5, -7352.5, ZA43 + 250], [1747.5, -7352.5, ZA43 + 750], [910, -8145, (ZA43 + ZB43) / 2], [500, -9100, 2400], [1500, -9100, ZEND43]]) {
      near(sf.zAt(...W(a, r)), z, `(${a},${r})`);
    }
    assert.deepEqual(overlapProblems(sf), []);
  });
}

test('あき 0（sA==sB）の折返し・回り階段: 往路 R_A と復路 R_B の境（x=sA、run front〜base）の折れ目が出る。高さが食い違う境なので輪郭では出ない', () => {
  const base = { vertical: true, run: { baseA: 4000, frontA: 1000, front: 1000, baseB: 4000, back: 57.5 }, across: { s0: 57.5, sA: 1000, sB: 1000, s1: 1942.5, mid: 1000 }, pivotAcross: 1000, hasColumn: false };
  const sw = uTurnSoffitFromLayout({ ...base, firstTurnNumber: 6, turnCells: 1, totalSteps: 12 }, { zStart: 2400, zTop });
  assert.deepEqual(sw.innerLines.map(l => lineKeyOf(l.points)), ['57.5,1000,1000,1000', '1000,1000,1942.5,1000', '1000,1000,1000,4000']);
  const wd = uTurnSoffitFromLayout({ ...base, firstTurnNumber: 5, turnCells: 6, totalSteps: 15 }, ctxOf());
  assert.equal(wd.innerLines.length, 6);
  assert.ok(wd.innerLines.map(l => lineKeyOf(l.points)).includes('1000,1000,1000,4000'));
  assert.deepEqual(overlapProblems(wd), []);
  assert.deepEqual(overlapProblems(sw), []);
  // あきがある（sA≠sB）ときは境の折れ目を足さない（間は空き）
  const gap = uTurnSoffitFromLayout({ ...base, across: { ...base.across, sA: 940, sB: 1060 }, pivotAcross: 940, firstTurnNumber: 6, turnCells: 1, totalSteps: 12 }, { zStart: 2400, zTop });
  assert.equal(gap.innerLines.length, 2);
});

test('あき 0・不等長レーン（baseA≠baseB）: R_A と R_B の境の折れ目は走行範囲の共通部分だけ（合併にすると短い側の輪郭の外へはみ出す）', () => {
  const base = { vertical: true, across: { s0: 57.5, sA: 1000, sB: 1000, s1: 1942.5, mid: 1000 }, pivotAcross: 1000, hasColumn: false, firstTurnNumber: 6, turnCells: 1, totalSteps: 12 };
  const ctx = { zStart: 2400, zTop };
  // 復路が短い（baseB=3000）: 境は front(1000)〜3000。4000 までは伸びない
  const a = uTurnSoffitFromLayout({ ...base, run: { baseA: 4000, frontA: 1000, front: 1000, baseB: 3000, back: 57.5 } }, ctx);
  const keysA = a.innerLines.map(l => lineKeyOf(l.points));
  assert.ok(keysA.includes('1000,1000,1000,3000'), keysA.join(' | '));
  assert.ok(!keysA.includes('1000,1000,1000,4000'));
  assert.deepEqual(overlapProblems(a), []);
  // 往路が短い（baseA=3000）: 同じく 1000〜3000
  const b = uTurnSoffitFromLayout({ ...base, run: { baseA: 3000, frontA: 1000, front: 1000, baseB: 4000, back: 57.5 } }, ctx);
  const keysB = b.innerLines.map(l => lineKeyOf(l.points));
  assert.ok(keysB.includes('1000,1000,1000,3000'), keysB.join(' | '));
  assert.ok(!keysB.includes('1000,1000,1000,4000'));
  assert.deepEqual(overlapProblems(b), []);
});

test('STRAIGHT_LANDING で区間が潰れていれば、その境の折れ目は出さない（失敗経路）', () => {
  const L = { vertical: true, hasLanding: true, landingNumber: 6, totalSteps: 12, across: { s0: 0, s1: 2000 }, run: { base: 4000, land1: 2000, land2: 1000, end: 0 } };
  const ctx = { zStart: 2400, zTop };
  const normal = straightSoffitFromLayout(L, ctx);
  assert.deepEqual(normal.innerLines.map(l => l.points[1]), [2000, 1000], '前提: 通常は land1・land2 の 2 本');
  // 踊り場の長さ 0（land1 == land2）: 踊り場の部品が無い → どちらの境も出さない
  const noLanding = straightSoffitFromLayout({ ...L, run: { ...L.run, land2: 2000 } }, ctx);
  assert.equal(noLanding.innerLines, undefined);
  assert.equal(noLanding.footprint.rects.length, 2);
  // 直進部 2 が潰れる（land2 == end）: land2 の境だけ出さない
  const noRun2 = straightSoffitFromLayout({ ...L, run: { ...L.run, end: 1000 } }, ctx);
  assert.deepEqual(noRun2.innerLines.map(l => l.points[1]), [2000]);
});

// ---------------------------------------------------------------- 実物の layout（隔て壁の柱あり）× 向き × flip

const ARCH = { labeled: false, discipline: Discipline.ARCH };
/** 隔て壁の柱が立つ木造（在来）の等長レーン＋全幅の踊り場。dir＝上り方向。stairUTurnPlanLayout.test.js の equalFixture と同じ構成。 */
function columnFixture(type, dir, flip) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const vertical = dir === 'up' || dir === 'down';
  const along = { up: [0, 1000, 4000], down: [0, 3000, 4000], left: [0, 1000, 4000], right: [0, 3000, 4000] }[dir];
  const across = [0, 1000, 2000];
  const xs = vertical ? across : along, ys = vertical ? along : across;
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const Hl = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const keys = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) keys.push(`${V[i].id}:${Hl[j].id}:${V[i + 1].id}:${Hl[j + 1].id}`);
  const stair = graph.addStair({ type, cells: new Set(keys), sections: [6, type === StairType.WINDING ? 3 : 1, 6], flip, upDirection: dir });
  stair.structure = StructuralMaterialType.WOOD;
  graph.setStructureOverride('木造（在来）');
  return { graph, stair };
}
/** 張り出し（往路が長い・幅方向が反転・frontA≠front）。 */
function overhangColumnFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  const Hh = v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = Hh(0), y1 = Hh(1000), y2 = Hh(2000), y3 = Hh(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const c = { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), f: k(x1, y2, x2, y3) };
  const keys = ['f', 'b', 'c', 'd', 'a'].map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  const stair = graph.addStair({ type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections, entryTurnSteps: 0, arrivalTurnSteps: cls.arrivalTurnSteps ?? 0 });
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  return { graph, stair };
}

for (const type of [StairType.SWITCHBACK, StairType.WINDING]) for (const upDirection of ['up', 'down', 'left', 'right']) for (const flip of [false, true]) {
  test(`柱あり（実物の layout）: ${type} upDirection=${upDirection} flip=${flip} — 矩形 5 枚（隔て板の帯 S あり）・折れ目が輪郭や互いに重ならない`, () => {
    const { graph, stair } = columnFixture(type, upDirection, flip);
    const L = uTurnPlanLayout(stair, graph);
    assert.equal(L.hasColumn, true, '前提: 柱あり');
    assert.ok(Math.abs(L.across.sA - L.across.sB) >= 1, '前提: 隔て板の厚みぶんのあき');
    const [sf] = solidsOf(stair, graph);
    assert.equal(sf.footprint.rects.length, 5);
    assert.deepEqual(overlapProblems(sf), []);
  });
}

test('柱あり・張り出し（幅方向が反転・frontA≠front の実物の layout）: 前縁は back に近い方の 1 本だけ（frontA 側の線は無い）。折れ目が重ならず、往路の線は sA で止まる', () => {
  const { graph, stair } = overhangColumnFixture();
  const L = uTurnPlanLayout(stair, graph);
  assert.ok(L.across.s0 > L.across.s1 && L.run.frontA !== L.run.front, '前提');
  const [sf] = solidsOf(stair, graph);
  assert.equal(sf.footprint.rects.length, 5);
  const tf = Math.abs(L.run.back - L.run.frontA) <= Math.abs(L.run.back - L.run.front) ? L.run.frontA : L.run.front;
  const other = tf === L.run.frontA ? L.run.front : L.run.frontA;
  const runOf = l => (L.vertical ? [l.points[1], l.points[3]] : [l.points[0], l.points[2]]);
  assert.ok(sf.innerLines.every(l => !runOf(l).every(v => Math.abs(v - other) < 1e-6)), 'back から遠い方の前縁（柱の面）には線が無い');
  assert.equal(sf.innerLines.filter(l => runOf(l).every(v => Math.abs(v - tf) < 1e-6)).length, 2, '前縁の線は R_A 側と R_B 側の 2 区間（間の帯 S の前は輪郭）');
  assert.deepEqual(overlapProblems(sf), []);
  const a = sf.innerLines[0].points; // 往路との境: s0 → sA
  const pts = L.vertical ? [a[0], a[2]] : [a[1], a[3]];
  assert.deepEqual(pts, [L.across.s0, L.across.sA]);
});
