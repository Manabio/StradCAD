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

test('WINDING（手計算の固定値。sections [5,6,5]・蹴上200・FL2800・dz≈384.1874542）: 1 立体・矩形 5 枚（復路は上階の天井 FL+2400=5200 で頭打ち）。回転部は 4 三角の平面で、頂点の高さは角度で等分', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [5, 6, 5] });
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 1, '階段 1 本につき 1 立体（別立体の接する辺で線が 2 重にならない）');
  const [sf] = solids;
  assert.equal(sf.kind, 'ceiling');
  assert.deepEqual(sf.source, { kind: 'stairSoffit', id: String(stair.id), layerFloorZ: FL, part: 0 });
  assert.equal(sf.drawEdges, undefined, '輪郭を描く（既定）');
  // 縦走行: x＝幅方向（57.5〜1942.5・ピボット x=1000）、y＝走行（往路の上り口 4000・前縁 1000・奥 57.5）。到達辺も 4000
  const dz = 384.1874542;
  const zA = 2800 + 5 * 200 - dz, zB = 2800 + 10 * 200 - dz, zEnd = 2800 + 15 * 200 - dz; // 回転部 5..10・総蹴上 15
  // 復路の裏面は上階の天井（FL 2800＋既定 CH 2400＝5200）より上に出ない: 斜面が 5200 に達する run で終え、到達辺まで平ら
  const ZCAP = 2800 + DEFAULT_ROOM_CEILING_HEIGHT;
  const capRun = 1000 + 3000 * ((ZCAP - zB) / (zEnd - zB)); // ≈3352.562
  assert.ok(zEnd > ZCAP, '前提: 到達辺の裏面は上階の天井より高い');
  const r4 = sf.footprint.rects[3], r5 = sf.footprint.rects[4];
  assert.deepEqual(sf.footprint.rects.slice(0, 3), [
    { x1: 57.5, y1: 1000, x2: 1000, y2: 4000 },    // 往路 R_A
    { x1: 57.5, y1: 57.5, x2: 1000, y2: 1000 },    // 回転部 A
    { x1: 1000, y1: 57.5, x2: 1942.5, y2: 1000 },  // 回転部 B
  ]);
  assert.equal(sf.footprint.rects.length, 5);
  assert.deepEqual([r4.x1, r4.y1, r4.x2], [1000, 1000, 1942.5]); near(r4.y2, capRun, '復路 R_B は頭打ちの交点まで');
  assert.deepEqual([r5.x1, r5.x2, r5.y2], [1000, 1942.5, 4000]); near(r5.y1, capRun, '交点から到達辺まで平ら');
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
  near(z(1500, 4000), ZCAP, '復路の到達辺＝上階の天井で頭打ち');
  near(z(1500, capRun - 1), ZCAP - (ZCAP - zB) / (capRun - 1000), '交点の手前は斜面');
  near(z(1500, capRun + 1), ZCAP, '交点の先は平ら');
  // 三角の内側は平面補間（A1=(P_A,F_A,O_A) の重心）
  near(z((1000 + 57.5 + 57.5) / 3, (1000 + 1000 + 57.5) / 3), zA + 250 / 3, 'A1 の重心');
  near(sf.zLo, 2400, 'zLo'); near(sf.zHi, ZCAP, 'zHi＝頭打ちの高さ');
  // 面の折れ目: 往路/復路との境（前縁）・頭打ちの交点・対角線 2 本（ピボット → 外側の奥の角）・回転部 A/B の境・あき 0 の往路/復路の境。7 本ちょうど
  assert.deepEqual(sf.innerLines.map(l => l.role), Array(7).fill('stairSoffitFold'));
  const k = v => Math.round(v * 1000) / 1000;
  assert.deepEqual(sf.innerLines.map(lineKey), [
    '57.5,1000,1000,1000',
    '1000,1000,1942.5,1000',
    `1000,${k(capRun)},1942.5,${k(capRun)}`, // 斜面→平らの折れ目（復路レーンの幅）
    '1000,1000,57.5,57.5',
    '1000,1000,1942.5,57.5',
    '1000,1000,1000,57.5',  // 回転部 A と B の境（高さが食い違う共有辺）
    '1000,1000,1000,4000',  // あき 0（sA==sB）の往路 R_A と復路 R_B の境
  ]);
});

test('回転部の段数によらず 4 三角（sections [6,3,6] でも矩形 4 枚＋頭打ちの平ら 1 枚・対角線 2 本）。頂点の高さは段数ぶんの Δ を等分', () => {
  const { graph, stair } = uTurn(StairType.WINDING, { sections: [6, 3, 6] });
  const [sf] = solidsOf(stair, graph);
  assert.equal(sf.footprint.rects.length, 5); // 総蹴上 15 の到達辺 5416 は上階の天井 5200 より高いので復路が頭打ちの 2 枚に割れる
  assert.equal(sf.innerLines.length, 7);
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
  const { graph, stair } = straight(StairType.STRAIGHT, [0, 1000, 2000, 3000], [12]); // zTop(12)=4815.8 は上階天井 5200 より低い（頭打ちなし）
  const L = straightPlanLayout(stair, graph);
  const solids = solidsOf(stair, graph);
  assert.equal(solids.length, 1);
  assert.equal(solids[0].footprint.rects.length, 1);
  assert.equal(solids[0].innerLines, undefined);
  const xm = (L.across.s0 + L.across.s1) / 2;
  near(zAtPt(solids[0], xm, L.run.base), DEFAULT_ROOM_CEILING_HEIGHT, 'base');
  near(zAtPt(solids[0], xm, L.run.end), zTop(L.totalSteps), 'end');
});

test('STRAIGHT（実物）: 総蹴上 15 の裏面は上階の天井（FL+既定 CH=5200）で頭打ち。斜面＋平らの 2 枚・折れ目 1 本・end は 5200', () => {
  const { graph, stair } = straight(StairType.STRAIGHT, [0, 1000, 2000, 3000], [15]);
  const L = straightPlanLayout(stair, graph);
  const [sf] = solidsOf(stair, graph);
  const zCap = FL + DEFAULT_ROOM_CEILING_HEIGHT;
  assert.ok(zTop(L.totalSteps) > zCap, '前提: 頭打ちしない裏面は上階天井より高い');
  assert.equal(sf.footprint.rects.length, 2);
  assert.equal(sf.innerLines.length, 1);
  const xm = (L.across.s0 + L.across.s1) / 2;
  near(zAtPt(sf, xm, L.run.end), zCap, 'end は zCap');
  near(zAtPt(sf, xm, sf.innerLines[0].points[1]), zCap, '折れ目で zCap に達する');
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
          const expected = Math.min(zTop(t.number), FL + DEFAULT_ROOM_CEILING_HEIGHT); // 上階の天井で頭打ち
          assert.ok(Math.abs(sf.zAt(x, y) - expected) <= 2 * RISER, `踏面 ${t.number}: 面の z が min(天端−dz, 上階天井) ${expected} から 2 蹴上以内`);
        }
        const L = uTurnPlanLayout(stair, graph);
        assert.ok(sf.innerLines.every(l => l.points.length === 4 && l.points.every(Number.isFinite)));
        const capped = zTop(L.totalSteps) > FL + DEFAULT_ROOM_CEILING_HEIGHT;
        assert.equal(sf.innerLines.length, (type === StairType.WINDING ? 6 : 3) + (capped ? 1 : 0)); // あき 0 の往路/復路の境を含む。頭打ちなら交点の折れ目
        near(sf.zHi, Math.min(zTop(L.totalSteps), FL + DEFAULT_ROOM_CEILING_HEIGHT), '最上端は総蹴上の天端−dz（上階の天井で頭打ち）');
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

test('柱あり WINDING（moku4-3 の値）: 前縁はレーンごと（往路 -8235・復路 -8145）。対角線はピボット (865,-8235)／(865,-8145) から外側の奥の角まで全長', () => {
  const sf = uTurnSoffitFromLayout(MOKU43, ctxOf());
  assert.deepEqual(sf.footprint.rects, [
    { x1: 72.5, y1: -9100, x2: 852.5, y2: -8235 },       // 往路 R_A（自分のレーンの前縁 frontA で終わる）
    { x1: 72.5, y1: -8235, x2: 865, y2: -7352.5 },       // 回転部 A（P_A=(865,-8235) が前縁側の内側の角）
    { x1: 865, y1: -8145, x2: 1747.5, y2: -7352.5 },     // 回転部 B（P_B=(865,-8145)）
    { x1: 967.5, y1: -9100, x2: 1747.5, y2: -8145 },     // 復路 R_B（front から始まる）
  ]);
  assert.deepEqual(sf.innerLines.map(l => l.role), Array(5).fill('stairSoffitFold'));
  assert.deepEqual(sf.innerLines.map(l => lineKeyOf(l.points)), [
    '72.5,-8235,852.5,-8235',            // 往路の前縁 frontA（往路レーンだけ）
    '967.5,-8145,1747.5,-8145',          // 復路の前縁 front（復路レーンだけ）
    '865,-8235,72.5,-7352.5',            // 対角線 P_A → O_A（全長・端点がピボット）
    '865,-8145,1747.5,-7352.5',          // 対角線 P_B → O_B
    '865,-8145,865,-7352.5',             // 回転部 A/B の境（-8235〜-8145 は Q_A の輪郭）
  ]);
  const horiz = y => sf.innerLines.filter(l => l.points[1] === y && l.points[3] === y);
  assert.equal(horiz(-8145).length, 1, '往路レーンに y=-8145 の線は無い（復路の前縁だけ）');
  assert.ok(horiz(-8145).every(l => Math.min(l.points[0], l.points[2]) >= 865), 'y=-8145 の線は復路側');
  assert.ok(horiz(-8235).every(l => Math.max(l.points[0], l.points[2]) <= 865), '復路レーンに y=-8235 の線は無い');
  // 手計算: dz≈384.1874542・FL2800 → zA=zTop(5)=3415.8125458、zB=zTop(10)=4415.8125458、Δ=1000
  near(ZA43, 3415.8125458, 'zA'); near(ZB43, 4415.8125458, 'zB');
  near(sf.zAt(865, -8235), ZA43, 'P_A（頂点＝矩形の角）');
  near(sf.zAt(72.5, -8235), ZA43, 'F_A');
  const within1 = (a, b, msg) => assert.ok(Math.abs(a - b) < 1, `${msg}: ${a} vs ${b}`);
  within1(sf.zAt(866, -8145), ZB43, 'P_B（復路側のピボット。front=-8145）');
  near(sf.zAt(1747.5, -8145), ZB43, 'F_B');
  near(sf.zAt(865, -7352.5), ZA43 + 500, 'I');
  near(sf.zAt(72.5, -7352.5), ZA43 + 250, 'O_A');
  near(sf.zAt(1747.5, -7352.5), ZA43 + 750, 'O_B');
  // 三角の重心（頂点の高さの平均）: A1=(P_A,F_A,O_A)・A2=(P_A,O_A,I)・B2=(P_B,I,O_B)・B1=(P_B,O_B,F_B)
  near(sf.zAt((865 + 72.5 + 72.5) / 3, (-8235 - 8235 - 7352.5) / 3), ZA43 + 250 / 3, 'A1 の重心');
  near(sf.zAt((865 + 72.5 + 865) / 3, (-8235 - 7352.5 - 7352.5) / 3), ZA43 + 250, 'A2 の重心');
  near(sf.zAt((865 + 865 + 1747.5) / 3, (-8145 - 7352.5 - 7352.5) / 3), ZA43 + 750, 'B2 の重心');
  near(sf.zAt((865 + 1747.5 + 1747.5) / 3, (-8145 - 7352.5 - 8145) / 3), ZA43 + 1000 - 250 / 3, 'B1 の重心');
  near(sf.zAt(500, -9100), 2400, '往路の上り口');
  near(sf.zAt(500, -8235), ZA43, '往路の終端（frontA）');
  near(sf.zAt(1500, -9100), ZEND43, '復路の到達辺');
  assert.deepEqual(overlapProblems(sf), []);
});

test('【2026-10-16】両基端が入口柱の面（columnBases。baseA＝Q1 -9157.5・baseB＝Q3 -9042.5）: 復路の裏面は到達辺 Q3 から Q1 まで最終段の高さで平らに続く（梁型なし）。折れ目は到達辺に 1 本', () => {
  const L = { ...MOKU43, run: { ...MOKU43.run, baseA: -9157.5, baseB: -9042.5 }, columnBases: true };
  const sf = uTurnSoffitFromLayout(L, ctxOf());
  assert.equal(sf.footprint.rects.length, 5);
  assert.deepEqual(sf.footprint.rects[4], { x1: 967.5, y1: -9157.5, x2: 1747.5, y2: -9042.5 }, '平らな矩形 R_E（復路の幅 × Q3〜Q1）');
  assert.deepEqual(sf.footprint.rects[3], { x1: 967.5, y1: -9042.5, x2: 1747.5, y2: -8145 }, 'R_B は Q3 で終わる');
  assert.deepEqual(sf.footprint.rects[0], { x1: 72.5, y1: -9157.5, x2: 852.5, y2: -8235 }, 'R_A は Q1 から');
  near(sf.zAt(1500, -9042.5), ZEND43, '到達辺');
  near(sf.zAt(1500, -9100), ZEND43, 'Y4（通り芯）でも同じ高さ');
  near(sf.zAt(1500, -9157.5), ZEND43, '壁の外 Q1 でも同じ高さ');
  assert.ok(sf.zAt(1500, -8500) < ZEND43 - 1, 'R_B の中は斜面');
  assert.deepEqual(sf.innerLines.map(l => lineKeyOf(l.points))[2], '967.5,-9042.5,1747.5,-9042.5', '到達辺の折れ目（復路の前縁の次）');
  assert.equal(sf.innerLines.length, 6);
  assert.deepEqual(overlapProblems(sf), []);
  // 平らな区間の記述（展開図の復路下の天井線が到達辺で終える・2FL の横架材を床構造の中として隠す判定に使う）
  assert.deepEqual(sf.arrivalFlat, { run: -9042.5, endRun: -9157.5, across: [967.5, 1747.5], vertical: true });
  // 対照: columnBases でなければ従来の 4 枚（到達辺 baseB で終わる）・平らな区間なし
  const sf4 = uTurnSoffitFromLayout({ ...L, columnBases: false }, ctxOf());
  assert.equal(sf4.footprint.rects.length, 4);
  assert.equal(sf4.arrivalFlat, undefined);
  assert.deepEqual(sf4.footprint.rects[3], { x1: 967.5, y1: -9042.5, x2: 1747.5, y2: -8145 });
});

test('【2026-10-16】zCap（上階の天井）: 復路の裏面が到達辺の手前で zCap に達したら、斜面はその交点で終わり到達辺まで zCap の平ら（梁型なし）。交点に折れ目。zCap 非有限・到達辺の裏面が zCap 以下なら従来', () => {
  const zCap = 5400; // moku4-3: 2FL 3000＋CH 2400 相当（この fixture の FL は 2800 なので値だけ借りる）
  const sf = uTurnSoffitFromLayout(MOKU43, { ...ctxOf(), zCap });
  assert.ok(ZEND43 > zCap && ZB43 < zCap, '前提');
  const capRun = -8145 + (-9100 - -8145) * ((zCap - ZB43) / (ZEND43 - ZB43));
  assert.equal(sf.footprint.rects.length, 5);
  near(sf.footprint.rects[3].y1, capRun, 'R_B は交点まで'); assert.equal(sf.footprint.rects[3].y2, -8145);
  assert.deepEqual([sf.footprint.rects[4].x1, sf.footprint.rects[4].y1, sf.footprint.rects[4].x2], [967.5, -9100, 1747.5]); near(sf.footprint.rects[4].y2, capRun, '交点から到達辺まで平ら');
  near(sf.zAt(1500, -9100), zCap, '到達辺は zCap'); near(sf.zAt(1500, capRun), zCap, '交点'); assert.ok(sf.zAt(1500, capRun + 50) < zCap - 1, '交点の手前は斜面');
  near(sf.zHi, zCap, 'zHi');
  const fold = sf.innerLines.map(l => lineKeyOf(l.points))[2];
  assert.equal(fold, lineKeyOf([967.5, capRun, 1747.5, capRun]), '交点の折れ目');
  assert.equal(sf.innerLines.length, 6);
  assert.equal(sf.arrivalFlat, undefined, 'columnBases でなければ到達辺の外の区間は無い');
  assert.deepEqual(overlapProblems(sf), []);
  // columnBases と併用: 平らは Q1 まで・arrivalFlat は Q3〜Q1 のまま
  const Lc = { ...MOKU43, run: { ...MOKU43.run, baseA: -9157.5, baseB: -9042.5 }, columnBases: true };
  const sc = uTurnSoffitFromLayout(Lc, { ...ctxOf(), zCap });
  assert.equal(sc.footprint.rects.length, 5);
  assert.deepEqual([sc.footprint.rects[4].y1, sc.footprint.rects[4].x1, sc.footprint.rects[4].x2], [-9157.5, 967.5, 1747.5]);
  assert.deepEqual(sc.arrivalFlat, { run: -9042.5, endRun: -9157.5, across: [967.5, 1747.5], vertical: true });
  near(sc.zAt(1500, -9157.5), zCap, '壁の外まで zCap');
  // 失敗系
  assert.equal(uTurnSoffitFromLayout(MOKU43, { ...ctxOf(), zCap: NaN }).footprint.rects.length, 4, 'zCap 非有限は従来');
  assert.equal(uTurnSoffitFromLayout(MOKU43, { ...ctxOf(), zCap: ZEND43 + 100 }).footprint.rects.length, 4, '到達辺の裏面が zCap 以下は従来');
  near(uTurnSoffitFromLayout(MOKU43, { ...ctxOf(), zCap: ZEND43 + 100 }).zAt(1500, -9100), ZEND43, '従来の到達辺');
});

test('回転部の 2 分線はピボットを通る直線: 直線の両側の点を手計算の平面で照合。R_A と Q_A は前縁 frontA の全幅で連続（頂点が矩形の角）', () => {
  const sf = uTurnSoffitFromLayout(MOKU43, ctxOf());
  const fa = -8235, back = -7352.5;
  // 平面 z = z0 + ga(a−a0) + gr(r−r0) を 3 点 [a, r, z] から手計算（Cramer）で求める
  const planeZ = (p, q, s) => {
    const det = (q[0] - p[0]) * (s[1] - p[1]) - (s[0] - p[0]) * (q[1] - p[1]);
    const ga = ((q[2] - p[2]) * (s[1] - p[1]) - (s[2] - p[2]) * (q[1] - p[1])) / det;
    const gr = ((q[0] - p[0]) * (s[2] - p[2]) - (s[0] - p[0]) * (q[2] - p[2])) / det;
    return (a, r) => p[2] + ga * (a - p[0]) + gr * (r - p[1]);
  };
  const P = [865, fa, ZA43], F = [72.5, fa, ZA43], O = [72.5, back, ZA43 + 250], I = [865, back, ZA43 + 500];
  const a1 = planeZ(P, F, O), a2 = planeZ(P, O, I);
  // 直線 P_A→O_A は r=-7900 で a≈564.2。F 側（左）は A1、I 側（右）は A2
  near(sf.zAt(300, -7900), a1(300, -7900), 'F 側 (300,-7900) は A1');
  near(sf.zAt(700, -7900), a2(700, -7900), 'I 側 (700,-7900) は A2');
  near(sf.zAt(460, fa + 0.001), a1(460, fa + 0.001), 'F 側 (460, 前縁直後) は A1');
  assert.ok(Math.abs(a1(700, -7900) - a2(700, -7900)) > 1, '前提: 2 平面は I 側で異なる（検出力）');
  // 前縁 frontA の全幅（s0〜852.5）で R_A と Q_A が連続（差 1e-4 以内）
  for (const a of [72.5, 200, 460, 700, 852.5]) {
    const lo = sf.zAt(a, fa - 1e-6), hi = sf.zAt(a, fa + 1e-6);
    assert.ok(Math.abs(lo - hi) < 1e-4, `a=${a}: R_A ${lo} vs Q_A ${hi}`);
  }
});

for (const sa of [1, -1]) for (const sr of [1, -1]) for (const swap of [false, true]) {
  test(`向きの反転（幅方向 ${sa > 0 ? '+' : '-'}・走行 ${sr > 0 ? '+' : '-'}・vertical ${swap ? '反転' : '同じ'}）: 柱あり WINDING の折れ目・高さが向きによらず成り立ち、線の重なりが無い`, () => {
    const Lt = transformLayout(MOKU43, { sa, sr, swap });
    const sf = uTurnSoffitFromLayout(Lt, ctxOf());
    const W = worldOf(Lt, sa, sr);
    assert.equal(sf.footprint.rects.length, 4);
    // 折れ目の端点は元の (a, r) を同じ写像で移したものと一致する
    const expected = [[72.5, -8235, 852.5, -8235], [967.5, -8145, 1747.5, -8145], [865, -8235, 72.5, -7352.5], [865, -8145, 1747.5, -7352.5], [865, -8145, 865, -7352.5]]
      .map(([a0, r0, a1, r1]) => lineKeyOf(norm([...W(a0, r0), ...W(a1, r1)])));
    assert.deepEqual(sf.innerLines.map(l => lineKeyOf(norm(l.points))), expected);
    for (const [a, r, z] of [[72.5, -8235, ZA43], [1747.5, -8145, ZB43], [865, -7352.5, ZA43 + 500], [72.5, -7352.5, ZA43 + 250], [1747.5, -7352.5, ZA43 + 750], [(865 + 72.5 + 72.5) / 3, (-8235 - 8235 - 7352.5) / 3, ZA43 + 250 / 3], [(865 + 1747.5 + 1747.5) / 3, (-8145 - 7352.5 - 8145) / 3, ZA43 + 1000 - 250 / 3], [500, -9100, 2400], [1500, -9100, ZEND43]]) {
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

// ---------------------------------------------------------------- 直進系の上階天井 zCap での頭打ち（E5-2 S2-2。U 字系 2026-10-16 規則と同じ）

test('直進系 zCap: 斜面が zCap を越えるなら交点 capRun で斜面を終え、そこから end まで zCap の平ら＋折れ目 1 本', () => {
  const L = { vertical: true, hasLanding: false, totalSteps: 12, across: { s0: 0, s1: 2000 }, run: { base: 4000, end: 0 } };
  const zCap = 4000;
  const s = straightSoffitFromLayout(L, { zStart: 2400, zTop, zCap });
  const capRun = 4000 - 4000 * (zCap - 2400) / (zTop(12) - 2400);
  assert.equal(s.footprint.rects.length, 2, '斜面＋平ら');
  assert.equal(s.innerLines.length, 1);
  near(s.innerLines[0].points[1], capRun, '折れ目は capRun');
  near(s.zHi, zCap, '最高点は zCap で頭打ち');
  near(s.zAt(1000, 4000), 2400, '上り口');
  near(s.zAt(1000, capRun), zCap, '交点');
  near(s.zAt(1000, 0), zCap, '到達側は zCap の平ら');
  // zCap 省略（null）は従来どおり: 1 矩形・折れ目なし・最高点 zTop(12)
  const plain = straightSoffitFromLayout(L, { zStart: 2400, zTop });
  assert.equal(plain.footprint.rects.length, 1);
  assert.equal(plain.innerLines, undefined);
  near(plain.zHi, zTop(12), '頭打ちなし');
  // zCap が最高点より高ければ従来と同じ
  const high = straightSoffitFromLayout(L, { zStart: 2400, zTop, zCap: 9000 });
  assert.deepEqual(high.footprint, plain.footprint);
  assert.equal(high.innerLines, undefined);
  near(high.zHi, plain.zHi, '高い zCap は頭打ちしない');
});

test('直進系 zCap（踊り場付）: 直進部 2 が zCap を越えるなら s3 の途中で頭打ち。踊り場の高さが zCap 以上なら直進部 2 は全体が平ら（防御・例外なし）', () => {
  const L = { vertical: true, hasLanding: true, landingNumber: 6, totalSteps: 12, across: { s0: 0, s1: 2000 }, run: { base: 4000, land1: 2000, land2: 1000, end: 0 } };
  const zCap = 4000;
  const s = straightSoffitFromLayout(L, { zStart: 2400, zTop, zCap });
  const capRun = 1000 - 1000 * (zCap - zTop(6)) / (zTop(12) - zTop(6));
  assert.equal(s.footprint.rects.length, 4, '直進部 1・踊り場・直進部 2 の斜面・平ら');
  assert.equal(s.innerLines.length, 3, 'land1・land2・capRun');
  assert.deepEqual(s.innerLines.slice(0, 2).map(l => l.points[1]), [2000, 1000]);
  near(s.innerLines[2].points[1], capRun, '折れ目は capRun');
  near(s.zAt(1000, 0), zCap, '到達側は zCap');
  near(s.zHi, zCap, '最高点は zCap');
  const low = straightSoffitFromLayout(L, { zStart: 2400, zTop, zCap: zTop(6) - 10 });
  assert.ok(low, '踊り場より低い zCap でも例外なく立体を返す');
  near(low.zAt(1000, 0), zTop(6) - 10, '平ら');
  assert.equal(low.footprint.rects.length, 3, '直進部 1・踊り場・平ら（斜面なし）');
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
  test(`柱あり（実物の layout）: ${type} upDirection=${upDirection} flip=${flip} — 矩形 4 枚（両基端が入口柱の面なら到達辺〜Q1 の平らな 1 枚を足して 5 枚）・折れ目が輪郭や互いに重ならない`, () => {
    const { graph, stair } = columnFixture(type, upDirection, flip);
    const L = uTurnPlanLayout(stair, graph);
    assert.equal(L.hasColumn, true, '前提: 柱あり');
    assert.ok(Math.abs(L.across.sA - L.across.sB) >= 1, '前提: 隔て板の厚みぶんのあき');
    const [sf] = solidsOf(stair, graph);
    const capped = sf.zHi < zTop(L.totalSteps) - 1e-6; // 上階の天井で頭打ち（復路が交点で 2 枚に割れる）
    assert.equal(sf.footprint.rects.length, capped || L.columnBases ? 5 : 4);
    assert.deepEqual(overlapProblems(sf), []);
  });
}

test('柱あり・張り出し（幅方向が反転・frontA≠front の実物の layout）: 前縁はレーンごと（往路の線は frontA で s0〜sA、復路の線は front で sB〜s1）。対角線の端点はピボット。折れ目が重ならない', () => {
  const { graph, stair } = overhangColumnFixture();
  const L = uTurnPlanLayout(stair, graph);
  assert.ok(L.across.s0 > L.across.s1 && L.run.frontA !== L.run.front, '前提');
  const [sf] = solidsOf(stair, graph);
  assert.equal(sf.footprint.rects.length, (sf.zHi < zTop(L.totalSteps) - 1e-6) || L.columnBases ? 5 : 4);
  assert.deepEqual(overlapProblems(sf), []);
  const ar = l => (L.vertical ? { a: [l.points[0], l.points[2]], r: [l.points[1], l.points[3]] } : { a: [l.points[1], l.points[3]], r: [l.points[0], l.points[2]] });
  const [fa, fb] = [ar(sf.innerLines[0]), ar(sf.innerLines[1])];
  assert.deepEqual(fa.r, [L.run.frontA, L.run.frontA], '往路の前縁は frontA');
  assert.deepEqual(fa.a, [L.across.s0, L.across.sA], '往路の前縁は s0 から sA で止まる');
  assert.deepEqual(fb.r, [L.run.front, L.run.front], '復路の前縁は front');
  assert.deepEqual(fb.a, [L.across.sB, L.across.s1], '復路の前縁は sB から s1');
  // 対角線（3・4 本目）はピボットから始まる
  const pv = L.pivotAcross;
  const d1 = ar(sf.innerLines[2]), d2 = ar(sf.innerLines[3]);
  assert.deepEqual([d1.a[0], d1.r[0]], [pv, L.run.frontA], '往路側の対角線の始点＝P_A');
  assert.deepEqual([d2.a[0], d2.r[0]], [pv, L.run.front], '復路側の対角線の始点＝P_B');
  assert.deepEqual([d1.a[1], d1.r[1]], [L.across.s0, L.run.back]);
  assert.deepEqual([d2.a[1], d2.r[1]], [L.across.s1, L.run.back]);
});

test('あきのある踊り場（Δ=0・sA≠sB・柱なし）: 回転部 Q_A・Q_B は全面が平ら（zA）で、折れ目は前縁の 2 区間だけ', () => {
  const L = { vertical: true, run: { baseA: 4000, frontA: 1000, front: 1000, baseB: 4000, back: 57.5 }, across: { s0: 57.5, sA: 940, sB: 1060, s1: 1942.5, mid: 1000 }, pivotAcross: 940, hasColumn: false, firstTurnNumber: 6, turnCells: 1, totalSteps: 12 };
  const sf = uTurnSoffitFromLayout(L, { zStart: 2400, zTop });
  assert.deepEqual(sf.innerLines.map(l => lineKeyOf(l.points)), ['57.5,1000,940,1000', '1060,1000,1942.5,1000']);
  for (const [x, y] of [[57.5, 57.5], [500, 500], [940, 57.5], [940, 1000], [1000, 500], [1500, 600], [1942.5, 1000], [1942.5, 57.5]]) near(sf.zAt(x, y), zTop(6), `(${x},${y}) は平ら`);
});
