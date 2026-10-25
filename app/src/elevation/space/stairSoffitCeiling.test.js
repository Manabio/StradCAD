// stairSoffitCeiling.js（階段帯の天井＝階段の裏面。E5）の単体テスト。
// 幾何は layout を模した入力（uTurnSoffitFromLayout）で手計算の値と照合し、供給（stairSoffitAbove）は実物の PlanGraph で
// 見上げの立体（planSolids の stairSoffit）と同じ式であることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType } from '@core';
import { STAIR_SOFFIT_THICKNESS_MM } from '../../core/constants.js';
import { uTurnSoffitFromLayout, straightSoffitFromLayout } from '../../ceiling/stairSoffit.js';
import { planSolidsLayerSolidsUp } from '../../plan/planSolidsLayerFilter.js';
import { makeGrid } from '../../plan/planTestFixtures.js';
import {
  stairSoffitAbove, stairSoffitChAlong, stairSoffitChMaxOver, stairSoffitChAt, minCeilingSegmentsWithSoffits,
} from './stairSoffitCeiling.js';

const FL = 2800;   // N+1 の FL
const RISER = 200;
const TREAD = 250; // Stair の既定の踏面
const DZ = STAIR_SOFFIT_THICKNESS_MM * Math.sqrt(1 + (RISER / TREAD) ** 2);
const zTop = n => FL + n * RISER - DZ;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

/** 縦走行（y が走行）・踊り場 1 マス（Δ=0）・あき 0 の U 字。stairSoffit.test.js の SWITCHBACK と同じ配置。 */
const SWITCHBACK_L = {
  vertical: true,
  run: { baseA: 4000, frontA: 1000, front: 1000, baseB: 4000, back: 57.5 },
  across: { s0: 57.5, sA: 1000, sB: 1000, s1: 1942.5, mid: 1000 },
  pivotAcross: 1000, hasColumn: false, firstTurnNumber: 6, turnCells: 1, totalSteps: 12,
};
/** 回転部 6 マス（Δ=1000）の WINDING。 */
const WINDING_L = { ...SWITCHBACK_L, firstTurnNumber: 5, turnCells: 6, totalSteps: 15 };
const soffitOf = (L, { floorStepMm = 0, zStart = 2400 } = {}) => ({ solid: uTurnSoffitFromLayout(L, { zStart, zTop }), floorStepMm });
const along = (soffit, q) => stairSoffitChAlong(soffit, { isVertical: true, depthCoord: 500, lo: 57.5, hi: 4000, ...q });

// ---------------------------------------------------------------- stairSoffitChAlong（節・段・あき）

test('【E5】往路レーン（SWITCHBACK）を縦に切ると、上り口 2400 → 前縁 zTop(6) の斜線 → 踊り場は平ら。節は矩形の辺だけ（対角線が無い）', () => {
  const nodes = along(soffitOf(SWITCHBACK_L));
  assert.deepEqual(nodes.map(n => n.run), [57.5, 1000, 4000], '節＝奥・前縁・上り口（昇順）');
  near(nodes[0].ch, zTop(6), '奥（踊り場は平ら）');
  near(nodes[1].ch, zTop(6), '前縁');
  near(nodes[2].ch, 2400, '上り口＝当該階天井');
  assert.ok(nodes.every(n => n.gapBefore === undefined), '途切れは無い');
  // 節の間は厳密に直線: 区間の途中の値は線形補間と一致
  const mid = (1000 + 4000) / 2;
  near(2400 + (zTop(6) - 2400) * (4000 - mid) / 3000, (nodes[1].ch + nodes[2].ch) / 2, '前縁〜上り口の中点');
});

test('【E5】WINDING の回転部: 対角線との交点が節になる（手計算 zA+250×(500/942.5)）。区間の途中は線形', () => {
  const nodes = along(soffitOf(WINDING_L));
  const zA = zTop(5);
  assert.deepEqual(nodes.map(n => Math.round(n.run * 1000) / 1000), [57.5, 500, 1000, 4000], '節＝奥・対角線との交点（y=500）・前縁・上り口');
  near(nodes[0].ch, zA + 250 + 250 * (442.5 / 942.5), '奥の辺（O〜I の間）');
  near(nodes[1].ch, zA + 250 * (500 / 942.5), '対角線 P〜O 上（P から 500/942.5）');
  near(nodes[2].ch, zA, '前縁 P');
  near(nodes[3].ch, 2400, '上り口');
});

test('【E5】回転部 A/B の境（x=pv）を横切る切断は同じ run に 2 節（垂直の段）。段の手前は A 側・奥は B 側の手計算の値', () => {
  const nodes = stairSoffitChAlong(soffitOf(WINDING_L), { isVertical: false, depthCoord: 500, lo: 57.5, hi: 1942.5 });
  const zA = zTop(5), delta = 1000, t = (1000 - 500) / 942.5;
  // 節＝左端・A 側の対角線（x=500）・段（x=1000 の 2 節）・B 側の対角線（x=1500）・右端
  assert.deepEqual(nodes.map(n => Math.round(n.run * 1000) / 1000), [57.5, 500, 1000, 1000, 1500, 1942.5]);
  near(nodes[0].ch, zA + delta / 4 * t, '左端（F〜O の辺）');
  near(nodes[2].ch, zA + delta / 2 * t, '段の手前＝回転部 A の x=pv の辺（P〜I）');
  near(nodes[3].ch, zA + delta / 2 + delta / 2 * (1 - t), '段の奥＝回転部 B の x=pv の辺');
  near(nodes[5].ch, zA + delta - delta / 4 * t, '右端（F_B〜O_B の辺）');
  assert.ok(nodes[3].ch - nodes[2].ch > 100, '段がある（Δ>0）');
});

test('【E5】あきがある（sA≠sB）レーンを横切る切断: 足元が途切れる区間の後の最初の節に gapBefore。途切れの中は節を作らない', () => {
  const gapL = { ...SWITCHBACK_L, across: { ...SWITCHBACK_L.across, sA: 940, sB: 1060 }, pivotAcross: 940 };
  const nodes = stairSoffitChAlong(soffitOf(gapL), { isVertical: false, depthCoord: 2000, lo: 57.5, hi: 1942.5 });
  const zRA = 2400 + (zTop(6) - 2400) * (4000 - 2000) / 3000;
  const zRB = zTop(6) + (zTop(12) - zTop(6)) * (2000 - 1000) / 3000;
  assert.deepEqual(nodes.map(n => n.run), [57.5, 940, 1060, 1942.5]);
  assert.deepEqual(nodes.map(n => n.gapBefore), [undefined, undefined, true, undefined]);
  near(nodes[0].ch, zRA, '往路'); near(nodes[1].ch, zRA, '往路の端');
  near(nodes[2].ch, zRB, '復路'); near(nodes[3].ch, zRB, '復路の端');
});

test('【E5】範囲 [lo, hi] で切る: 端の節は範囲の端・値は直線の途中（手計算）', () => {
  const nodes = along(soffitOf(SWITCHBACK_L), { lo: 1500, hi: 3000 });
  assert.deepEqual(nodes.map(n => n.run), [1500, 3000]);
  near(nodes[0].ch, 2400 + (zTop(6) - 2400) * (4000 - 1500) / 3000, 'lo 端');
  near(nodes[1].ch, 2400 + (zTop(6) - 2400) * (4000 - 3000) / 3000, 'hi 端');
});

test('【E5】直進（踊り場付き）の裏面を縦に切ると、節は end・land2・land1・base（昇順）。上り口 2400 → 踊り場 zTop(6) は平ら → 到達 zTop(12)', () => {
  const STRAIGHT_LANDING_L = {
    vertical: true, hasLanding: true, landingNumber: 6, totalSteps: 12,
    run: { base: 4000, land1: 3000, land2: 2500, end: 500 },
    across: { s0: 0, s1: 1000, mid: 500 },
  };
  const s = { solid: straightSoffitFromLayout(STRAIGHT_LANDING_L, { zStart: 2400, zTop }), floorStepMm: 0 };
  const nodes = stairSoffitChAlong(s, { isVertical: true, depthCoord: 500, lo: 0, hi: 4000 });
  assert.deepEqual(nodes.map(n => n.run), [500, 2500, 3000, 4000], '節＝到達・踊り場奥・踊り場手前・上り口');
  near(nodes[0].ch, zTop(12), '到達'); near(nodes[1].ch, zTop(6), '踊り場奥');
  near(nodes[2].ch, zTop(6), '踊り場手前'); near(nodes[3].ch, 2400, '上り口＝当該階天井');
  assert.equal(stairSoffitChAlong(s, { isVertical: true, depthCoord: 5000, lo: 0, hi: 4000 }), null, '【失敗系】足元の外');
});

test('【E5・失敗系】足元の外の深さ・範囲が足元に掛からない・非有限・裏面なし・幅 0 は null', () => {
  const s = soffitOf(SWITCHBACK_L);
  assert.equal(along(s, { depthCoord: 5000 }), null, '深さが足元の外');
  assert.equal(along(s, { depthCoord: -100 }), null);
  assert.equal(along(s, { lo: 5000, hi: 6000 }), null, '走りの範囲が足元の外');
  assert.equal(along(s, { depthCoord: NaN }), null);
  assert.equal(along(s, { lo: NaN }), null);
  assert.equal(along(s, { lo: 3000, hi: 3000 }), null, '幅 0');
  assert.equal(stairSoffitChAlong(null, { isVertical: true, depthCoord: 500, lo: 0, hi: 1 }), null);
  assert.equal(stairSoffitChAlong({ floorStepMm: 0 }, { isVertical: true, depthCoord: 500, lo: 0, hi: 1 }), null);
});

test('【E5】ch は部屋 FL 基準（絶対 z − 床段差）。上り口の値は対の部屋の CH そのもの（床段差を足さない＝エンジン・体裁が後で足すので二重にしない）', () => {
  // 当該階天井（N の FL 基準・床段差込み）= 対の部屋の CH 2400 + 床段差 300 = 2700
  const stepped = soffitOf(SWITCHBACK_L, { floorStepMm: 300, zStart: 2700 });
  const nodes = along(stepped);
  near(nodes[2].ch, 2400, '上り口の ch ＝ 対の部屋の CH（2700 でも 3000 でもない）');
  near(stepped.solid.zAt(500, 4000), 2700, '前提: 立体の絶対 z は床段差込み');
  near(nodes[0].ch, zTop(6) - 300, '奥は絶対 z − 床段差');
  near(stairSoffitChAt(stepped, 500, 4000), 2400, '点の値も同じ契約');
});

// ---------------------------------------------------------------- stairSoffitChMaxOver / ChAt

test('【E5】列の幅での最大: 勾配の低い側から高い側へ向かう区間は高い端の値・踊り場を含む幅は踊り場の高さ', () => {
  const s = soffitOf(SWITCHBACK_L);
  near(stairSoffitChMaxOver(s, { isVertical: true, depthCoord: 500, lo: 2000, hi: 3000 }), 2400 + (zTop(6) - 2400) * (4000 - 2000) / 3000, '勾配の中（y が小さい側が高い）');
  near(stairSoffitChMaxOver(s, { isVertical: true, depthCoord: 500, lo: 500, hi: 1500 }), zTop(6), '前縁をまたぐ幅は踊り場の高さ');
});

test('【E5】WINDING 回転部の段（x=pv）をまたぐ列の幅の最大は段の高い側（回転部 B の右端 x=1100）。手計算: 平面 (P_B,O_B,I) の勾配 dz/dx=250/942.5・dz/dy=500/942.5', () => {
  const max = stairSoffitChMaxOver(soffitOf(WINDING_L), { isVertical: false, depthCoord: 500, lo: 900, hi: 1100 });
  near(max, zTop(5) + 500 + 100 * 250 / 942.5 + (500 - 57.5) * 500 / 942.5, '右端');
});

test('【E5・失敗系】MaxOver／ChAt: 足元の外・非有限は null', () => {
  const s = soffitOf(SWITCHBACK_L);
  assert.equal(stairSoffitChMaxOver(s, { isVertical: true, depthCoord: 5000, lo: 0, hi: 100 }), null);
  assert.equal(stairSoffitChMaxOver(s, { isVertical: true, depthCoord: 500, lo: NaN, hi: 100 }), null);
  assert.equal(stairSoffitChMaxOver(null, { isVertical: true, depthCoord: 500, lo: 0, hi: 100 }), null);
  assert.equal(stairSoffitChAt(s, 5000, 5000), null);
  assert.equal(stairSoffitChAt(s, NaN, 500), null);
  assert.equal(stairSoffitChAt(null, 500, 500), null);
});

// ---------------------------------------------------------------- stairSoffitAbove（供給・見上げとの一致）

/** N 階と N+1 階に同じ足元の階段（折返し・踊り場 1 マス）。N の階段室は room（床レベル floorLevel）。 */
function pair({ upperStructure = StructuralMaterialType.WOOD, upperType = StairType.SWITCHBACK, floorLevel = null, shift = 0 } = {}) {
  const mk = (id, floor, type, structure, dx = 0) => {
    const g = makeGrid([dx, dx + 1000, dx + 2000], [0, 1000, 4000], { id, startFloor: floor });
    const room = g.interior([[0, 0], [1, 0], [0, 1], [1, 1]]);
    const cells = new Set([g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)]);
    const stair = g.graph.addStair({ type, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', roomId: room.id });
    stair.structure = structure;
    return { ...g, room, stair };
  };
  const n = mk('p1', 1, StairType.SWITCHBACK, StructuralMaterialType.WOOD);
  if (floorLevel != null) n.room.setFloorLevel(floorLevel);
  const u = mk('p2', 2, upperType, upperStructure, shift);
  return { n, u };
}
const ARGS = (n, u, extra = {}) => ({
  stair: n.stair, graph: n.graph, upperGraph: u.graph, floorHeightMm: 2400, riserOf: () => 200, ...extra,
});

test('【E5】stairSoffitAbove: 見上げ（planSolids の stairSoffit 立体）と同じ立体——矩形・各矩形の中心と四隅の高さが一致（同じ述語・同じ引数）', () => {
  const { n, u } = pair();
  const soffit = stairSoffitAbove(ARGS(n, u));
  assert.ok(soffit, '続きのある木造階段なら裏面が引ける');
  assert.equal(soffit.upperStairId, String(u.stair.id));
  assert.equal(soffit.upperRoomId, u.room.id);
  assert.equal(soffit.floorStepMm, 0);
  const viaPlan = planSolidsLayerSolidsUp({
    graph: n.graph, abovePeek: { graph: u.graph, floorHeightMm: 2400 }, aboveRiserOf: () => 200,
  }).find(s => s.source?.kind === 'stairSoffit' && s.source.id === String(u.stair.id));
  assert.ok(viaPlan, '前提: 見上げの立体が引ける');
  assert.deepEqual(soffit.solid.footprint.rects, viaPlan.footprint.rects);
  const pts = [];
  for (const r of viaPlan.footprint.rects) pts.push([(r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2], [r.x1 + 1, r.y1 + 1], [r.x2 - 1, r.y2 - 1], [r.x1 + 1, r.y2 - 1], [r.x2 - 1, r.y1 + 1]);
  for (const [x, y] of pts) near(soffit.solid.zAt(x, y), viaPlan.zAt(x, y), `(${x},${y})`);
});

test('【E5】stairSoffitAbove: 階段室の床レベルが 300 なら floorStepMm=300、上り口の ch は対の部屋の CH（床段差を足さない）', () => {
  const { n, u } = pair({ floorLevel: 300 });
  const soffit = stairSoffitAbove(ARGS(n, u));
  assert.equal(soffit.floorStepMm, 300);
  const nodes = stairSoffitChAlong(soffit, { isVertical: true, depthCoord: 500, lo: 0, hi: 4100 });
  const entrance = nodes[nodes.length - 1];
  near(soffit.solid.zAt(500, entrance.run), 2700, '立体の絶対 z は CH 2400 + 床段差 300');
  near(entrance.ch, 2400, 'ch は部屋 FL 基準');
});

test('【E5・失敗系】stairSoffitAbove: 鉄骨・L_TURN・蹴上が決まらない（N+2 が無い）・上階なし・足元が違う・引数欠落は null', () => {
  { const { n, u } = pair({ upperStructure: StructuralMaterialType.STEEL }); assert.equal(stairSoffitAbove(ARGS(n, u)), null, '鉄骨は裏面なし（踏面線を描く側）'); }
  { const { n, u } = pair({ upperType: StairType.L_TURN }); assert.equal(stairSoffitAbove(ARGS(n, u)), null, 'L_TURN は裏面なし'); }
  { const { n, u } = pair(); assert.equal(stairSoffitAbove(ARGS(n, u, { riserOf: () => null })), null, '蹴上が決まらない'); }
  { const { n, u } = pair(); assert.equal(stairSoffitAbove(ARGS(n, u, { upperGraph: null })), null, '上階なし'); }
  { const { n, u } = pair(); assert.equal(stairSoffitAbove(ARGS(n, u, { floorHeightMm: NaN })), null, '階高が未確定'); }
  { const { n, u } = pair(); assert.equal(stairSoffitAbove(ARGS(n, u, { riserOf: undefined })), null, 'riserOf 欠落'); }
  { const { n, u } = pair({ shift: 500 }); assert.equal(stairSoffitAbove(ARGS(n, u)), null, '足元が違う階段は続きではない'); }
  { const { n, u } = pair(); assert.equal(stairSoffitAbove(ARGS(n, u, { stair: null })), null, 'stair なし'); }
});

// ---------------------------------------------------------------- minCeilingSegmentsWithSoffits（S8-4）

// SWITCHBACK_L を x=500 で縦に切る: y=1000..57.5 は平ら zTop(6)、y=1000→4000 は zTop(6)→2400 の直線
const surfaceOf = (zAtOverride) => {
  const solid = uTurnSoffitFromLayout(SWITCHBACK_L, { zStart: 2400, zTop });
  return zAtOverride ? { ...solid, zAt: zAtOverride } : solid;
};
const FACE = { faceValue: 500, isVertical: true, dirSign: 1, originWorld: 0 };
const soffitsOf = (surface, stairRoomId = 'stairRoom') => [{ stairId: 's1', stairRoomId, surface }];
const OPTS = { floorZFor: () => 0 };
const SEG = { loX: 57.5, hiX: 4000, floorDeltaMm: 0, chMm: 3000, loCLId: 'a', hiCLId: 'b' };
const yAt = ch => 4000 - 3000 * (ch - 2400) / (zTop(6) - 2400); // 裏面の斜線が ch になる y

test('【S8-4】平らな天井(3000)と傾いた裏面の交点で区間が割れ、裏面側は chMm→chHiMm＝裏面の値（min）になる。項目は保たれ、内側の割れ目の CL id は null', () => {
  const out = minCeilingSegmentsWithSoffits([SEG], FACE, soffitsOf(surfaceOf()), OPTS);
  const yc = yAt(3000);
  assert.equal(out.length, 2, '平ら（元のまま）＋傾斜（裏面）');
  near(out[0].loX, 57.5, '先頭の loX'); near(out[0].hiX, yc, '交点');
  assert.equal(out[0].chMm, 3000); assert.equal(out[0].chHiMm, undefined, '元のまま平ら');
  near(out[1].loX, yc, '交点'); near(out[1].hiX, 4000, '末尾');
  near(out[1].chMm, 3000, '交点の天井高'); near(out[1].chHiMm, 2400, '上り口は裏面 2400');
  assert.equal(out[0].loCLId, 'a'); assert.equal(out[0].hiCLId, null, '内側の割れ目');
  assert.equal(out[1].loCLId, null, '内側の割れ目'); assert.equal(out[1].hiCLId, 'b');
  assert.ok(out.every(s => s.floorDeltaMm === 0), '他の項目を落とさない');
});

test('【S8-4】元の天井 3500（前縁の平ら部 ≈3950 より低い）でも、斜線との交点で割れて上り口側だけ裏面になる', () => {
  const out = minCeilingSegmentsWithSoffits([{ ...SEG, chMm: 3500 }], FACE, soffitsOf(surfaceOf()), OPTS);
  // 3500 は前縁 zTop(6)(≈3950) より低く、y=yAt(3500) で裏面と交わる
  assert.equal(out.length, 2);
  near(out[0].hiX, yAt(3500), '交点で割れる');
  near(out[1].chHiMm, 2400, '上り口');
});

test('【S8-4】floorZFor の FL を引いた値（所有部屋の FL 基準）。傾いた元の天井（chHiMm）とも min', () => {
  const out = minCeilingSegmentsWithSoffits([{ ...SEG, chMm: 3000, chHiMm: 2500 }], FACE, soffitsOf(surfaceOf()), { floorZFor: () => 100 });
  // 裏面（FL 基準）= 絶対 − 100。上り口 2400−100=2300 は元の chHiMm=2500 より低い
  const last = out[out.length - 1];
  near(last.hiX, 4000, '末尾'); near(last.chHiMm, 2300, '上り口の裏面（FL 基準）');
  assert.ok(out.every(s => s.chMm <= 3000 + 1e-6));
});

test('【S8-4】裏面が天井より上の区間・足元の外は不変（同じ配列を返す）', () => {
  const low = [{ ...SEG, chMm: 2000, chHiMm: undefined }];
  assert.equal(minCeilingSegmentsWithSoffits(low, FACE, soffitsOf(surfaceOf()), OPTS), low, '裏面は常に 2400 以上＝天井 2000 より上');
  const far = [SEG];
  assert.equal(minCeilingSegmentsWithSoffits(far, { ...FACE, faceValue: 9000 }, soffitsOf(surfaceOf()), OPTS), far, '面が足元の外');
});

test('【S8-4】階段の対の部屋（stairRoomId）が所有する区間は対象外', () => {
  const segs = [SEG];
  const opts = { ...OPTS, ownerRoomIdOf: () => 'stairRoom' };
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, soffitsOf(surfaceOf(), 'stairRoom'), opts), segs);
  const other = minCeilingSegmentsWithSoffits(segs, FACE, soffitsOf(surfaceOf(), 'stairRoom'), { ...OPTS, ownerRoomIdOf: () => 'underRoom' });
  assert.equal(other.length, 2, '別の部屋（階段下の部屋）は対象');
});

test('【S8-4】dirSign=-1（面ローカル x が世界と逆向き）でも同じ世界位置で割れ、区間は局所 x の昇順', () => {
  const face = { faceValue: 500, isVertical: true, dirSign: -1, originWorld: 4000 };
  const seg = { ...SEG, loX: 0, hiX: 3942.5 }; // 世界 y = 4000−x
  const out = minCeilingSegmentsWithSoffits([seg], face, soffitsOf(surfaceOf()), OPTS);
  assert.equal(out.length, 2);
  near(out[0].hiX, 4000 - yAt(3000), '交点（局所）');
  near(out[0].chMm, 2400, '局所 0＝世界 y=4000＝上り口の裏面'); near(out[0].chHiMm, 3000, '交点で元の天井に接する');
  assert.equal(out[1].chMm, 3000); assert.equal(out[1].chHiMm, undefined);
});

test('【S8-4・B-1】chMm 未指定の区間: defaultCh 省略（Infinity）なら裏面が勝ち chMm/chHiMm＝裏面の値・掛からない部分は chMm を付けない。defaultCh:3000 は chMm:3000 と同じ割れ方', () => {
  const noCh = { loX: 57.5, hiX: 5000, floorDeltaMm: 0 }; // 足元は y≈4000 まで＝4000 以降は裏面が掛からない
  const out = minCeilingSegmentsWithSoffits([noCh], FACE, soffitsOf(surfaceOf()), OPTS);
  assert.ok(out.length >= 2, `割れる: ${out.length}`);
  const covered = out.filter(s => s.hiX <= 4000 + 1e-6), rest = out.filter(s => s.loX >= 4000 - 1e-6);
  assert.ok(covered.length > 0 && rest.length === 1, '裏面に掛かる部分と掛からない部分');
  assert.ok(covered.every(s => Number.isFinite(s.chMm)), '裏面の値（NaN・Infinity にならない）');
  near(covered[0].chMm, zTop(6), '前縁の平ら部＝裏面の値');
  near(covered[covered.length - 1].chHiMm, 2400, '上り口は裏面 2400');
  assert.ok(!('chMm' in rest[0]) && !('chHiMm' in rest[0]), '掛からない部分は chMm を付けない');
  const d3 = minCeilingSegmentsWithSoffits([{ ...noCh, hiX: 4000 }], FACE, soffitsOf(surfaceOf()), { ...OPTS, defaultCh: 3000 });
  const c3 = minCeilingSegmentsWithSoffits([{ ...SEG, loCLId: undefined, hiCLId: undefined }], FACE, soffitsOf(surfaceOf()), OPTS);
  // 元のまま平らな部品は chMm の有無だけが違う（未指定は未指定のまま・指定は指定のまま＝既存の規約）ので、傾斜の無い部品の chMm は比べない
  const strip = a => a.map(s => { const r = { ...s }; delete r.loCLId; delete r.hiCLId; if (r.chHiMm === undefined) delete r.chMm; return r; });
  assert.deepEqual(strip(d3), strip(c3), 'defaultCh:3000 は chMm:3000 と同じ');
  const hiOnly = minCeilingSegmentsWithSoffits([{ ...noCh, hiX: 4000, chHiMm: 3000 }], FACE, soffitsOf(surfaceOf()), OPTS);
  assert.deepEqual(strip(hiOnly), strip(c3), 'chHiMm だけの区間は水平（chMm 未指定でも NaN にならない）');
});

test('【S8-4・失敗系】soffits 空・引数欠落・zAt が NaN の裏面・face が不正は元の配列をそのまま返し、例外を投げない', () => {
  const segs = [SEG];
  const orig = JSON.parse(JSON.stringify(segs));
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, [], OPTS), segs, 'soffits 空');
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, undefined, OPTS), segs, 'soffits なし');
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, soffitsOf(surfaceOf(() => NaN)), OPTS), segs, 'zAt が NaN');
  assert.equal(minCeilingSegmentsWithSoffits(segs, { ...FACE, faceValue: NaN }, soffitsOf(surfaceOf()), OPTS), segs, 'face が NaN');
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, soffitsOf(surfaceOf()), {}), segs, 'floorZFor 欠落');
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, soffitsOf(surfaceOf()), { floorZFor: () => NaN }), segs, 'FL が NaN');
  assert.equal(minCeilingSegmentsWithSoffits(segs, FACE, [{ stairId: 's', stairRoomId: null, surface: null }], OPTS), segs, 'surface なし');
  assert.deepEqual(segs, orig, '入力を破壊しない');
  assert.deepEqual(minCeilingSegmentsWithSoffits([], FACE, soffitsOf(surfaceOf()), OPTS), []);
});
