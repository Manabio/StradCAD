// 階段帯の天井＝階段の裏面（E5）の配線テスト: applyStairSoffitToCut（体裁の ceilingProfile とエンジンの cut.ceilClip を同じ区間列から）・
// spaceModel.cellAt（層スタックの天井）・stairChDimChains（CH 寸法の上端）・stairFaceSequence（歩行順 5 面）。
// 供給源そのもの（節・段・あき）は space/stairSoffitCeiling.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType } from '@core';
import { STAIR_SOFFIT_THICKNESS_MM } from '../core/constants.js';
import { uTurnSoffitFromLayout } from '../ceiling/stairSoffit.js';
import { makeGrid } from '../plan/planTestFixtures.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { stairFaceSequence, applyStairSoffitToCut, stairChDimChains, extendLowerCeilingAcrossStrip, partitionStripOf } from './elevationStairSequence.js';
import { stairSoffitAbove } from './space/stairSoffitCeiling.js';
import { buildSpaceIndex } from './space/spaceModel.js';
import { buildBandLayers } from './section/sectionBandLayers.js';
import { drawnFloorProfileZAt } from './elevationFloorProfile.js';

const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

// ---------------------------------------------------------------- applyStairSoffitToCut（layout を模した立体 × 手組みの cut）

const FL = 2800, RISER = 200;
const DZ = STAIR_SOFFIT_THICKNESS_MM * Math.sqrt(1 + (RISER / 250) ** 2);
const zTop = n => FL + n * RISER - DZ;
const L0 = {
  vertical: true,
  run: { baseA: 4000, frontA: 1000, front: 1000, baseB: 4000, back: 57.5 },
  across: { s0: 57.5, sA: 1000, sB: 1000, s1: 1942.5, mid: 1000 },
  pivotAcross: 1000, hasColumn: false, firstTurnNumber: 6, turnCells: 1, totalSteps: 12,
};
const soffitOf = L => ({ solid: uTurnSoffitFromLayout(L, { zStart: 2400, zTop }), floorStepMm: 0 });
const laneCut = (extra = {}) => ({
  line: { isVertical: true, axisValue: 500, lo: 57.5, hi: 4000 }, dirSign: 1, zRange: { loZ: 0, hiZ: 5400 }, ...extra,
});

test('【E5】applyStairSoffitToCut: 体裁の ceilingProfile とエンジンの cut.ceilClip は同じ区間列。ceilProfile は付けない（階段帯の性格判定を変えない）', () => {
  const cut = laneCut();
  const applied = applyStairSoffitToCut(soffitOf(L0), cut, null, 5400);
  // 断面ローカル x = 世界の走り − 57.5（dirSign=+1）。奥 57.5→0・前縁 1000→942.5・上り口 4000→3942.5
  assert.equal(cut.ceilProfile, undefined, 'ceilProfile は付けない（打ち切り専用の ceilClip だけ）');
  assert.equal(cut.ceilClip.length, 2);
  near(cut.ceilClip[0].loX, 0, 'ceilClip[0].loX'); near(cut.ceilClip[0].hiX, 942.5, 'ceilClip[0].hiX');
  near(cut.ceilClip[0].ceilZ, zTop(6), '踊り場は平ら'); near(cut.ceilClip[0].ceilZHi, zTop(6), '踊り場は平ら（hi）');
  near(cut.ceilClip[1].loX, 942.5, 'ceilClip[1].loX'); near(cut.ceilClip[1].hiX, 3942.5, 'ceilClip[1].hiX');
  near(cut.ceilClip[1].ceilZ, zTop(6), 'ceilClip[1].ceilZ'); near(cut.ceilClip[1].ceilZHi, 2400, 'ceilClip[1].ceilZHi');
  // 体裁の折れ線は、ceilClip の各区間の両端をつないだもの（同じ節列）
  const expected = [[0, zTop(6)], [942.5, zTop(6)], [3942.5, 2400]];
  assert.equal(applied.ceilingProfile.length, expected.length);
  expected.forEach(([x, z], i) => { near(applied.ceilingProfile[i][0], x, `profile[${i}].x`); near(applied.ceilingProfile[i][1], z, `profile[${i}].z`); });
  for (const s of cut.ceilClip) {
    near(drawnFloorProfileZAt(applied.ceilingProfile, s.loX + 1e-3), s.ceilZ, 'ceilClip の lo 端が折れ線上', 0.01);
    near(drawnFloorProfileZAt(applied.ceilingProfile, s.hiX - 1e-3), s.ceilZHi, 'ceilClip の hi 端が折れ線上', 0.01);
  }
  near(applied.ends.left, zTop(6), '面の左端の裏面'); near(applied.ends.right, 2400, '面の右端の裏面');
});

test('【E5】applyStairSoffitToCut: dirSign=-1 は断面ローカル x が逆向き。折れ線・ceilClip とも昇順に並べ直す', () => {
  const cut = laneCut({ dirSign: -1 }); // 原点は line.hi=4000: x = 4000 − 走り
  const applied = applyStairSoffitToCut(soffitOf(L0), cut, null, 5400);
  assert.deepEqual(cut.ceilClip.map(s => [Math.round(s.loX * 1000) / 1000 + 0, Math.round(s.hiX * 1000) / 1000]), [[0, 3000], [3000, 3942.5]]);
  near(cut.ceilClip[0].ceilZ, 2400, '上り口が x=0'); near(cut.ceilClip[0].ceilZHi, zTop(6), '前縁');
  near(cut.ceilClip[1].ceilZ, zTop(6), '踊り場');
  near(applied.ends.left, 2400, '左端＝上り口'); near(applied.ends.right, zTop(6), '右端＝踊り場');
});

test('【E5】applyStairSoffitToCut: cut.zRange.hiZ は裏面の最高点まで広げる（頭打ちしない）。共有の zRange オブジェクトは書き換えない', () => {
  const shared = { loZ: 0, hiZ: 3000 };
  const cut = laneCut({ zRange: shared });
  applyStairSoffitToCut(soffitOf(L0), cut, null, 5400);
  near(cut.zRange.hiZ, zTop(6), '裏面の最高点（3000 を超える）');
  assert.equal(shared.hiZ, 3000, '共有オブジェクトは不変（cut1/2/4/5 が同じ zRange を持つ）');
  const high = laneCut({ zRange: { loZ: 0, hiZ: 9000 } });
  applyStairSoffitToCut(soffitOf(L0), high, null, 5400);
  assert.equal(high.zRange.hiZ, 9000, '裏面より高い hiZ はそのまま');
});

test('【E5】applyStairSoffitToCut: 足元が途切れる区間（あき）は base でつなぐ。境目で値が違えば折れ線は垂直の段・ceilClip は平らな base 区間', () => {
  const gapL = { ...L0, across: { ...L0.across, sA: 940, sB: 1060 }, pivotAcross: 940 };
  const cut = { line: { isVertical: false, axisValue: 2000, lo: 57.5, hi: 1942.5 }, dirSign: 1, zRange: { loZ: 0, hiZ: 5400 } };
  const applied = applyStairSoffitToCut(soffitOf(gapL), cut, [[0, 5400], [1885, 5400]], 5400);
  const zRA = 2400 + (zTop(6) - 2400) * 2000 / 3000, zRB = zTop(6) + (zTop(12) - zTop(6)) * 1000 / 3000;
  assert.equal(cut.ceilClip.length, 3, '往路・あき（base）・復路');
  near(cut.ceilClip[0].hiX, 882.5, '往路の端'); near(cut.ceilClip[1].loX, 882.5, 'あきの始まり'); near(cut.ceilClip[1].hiX, 1002.5, 'あきの終わり');
  near(cut.ceilClip[1].ceilZ, 5400, 'あきは base の値'); near(cut.ceilClip[1].ceilZHi, 5400, 'あきは平ら');
  near(cut.ceilClip[2].ceilZ, zRB, '復路');
  assert.deepEqual(applied.ceilingProfile.map(p => Math.round(p[0] * 1000) / 1000), [0, 882.5, 882.5, 1002.5, 1002.5, 1885], '段は同じ x を 2 点');
  near(applied.ceilingProfile[1][1], zRA, '往路'); near(applied.ceilingProfile[2][1], 5400, '段の上'); near(applied.ceilingProfile[4][1], zRB, '段の下');
});

test('【E5・失敗系】applyStairSoffitToCut: 裏面なし・切断線が足元の外・line なしは null で cut を一切変えない', () => {
  const frozen = c => JSON.stringify(c);
  const a = laneCut(); const before = frozen(a);
  assert.equal(applyStairSoffitToCut(null, a, null, 5400), null);
  assert.equal(frozen(a), before, '裏面なしでは不変');
  const b = laneCut({ line: { isVertical: true, axisValue: 5000, lo: 57.5, hi: 4000 } }); const bBefore = frozen(b);
  assert.equal(applyStairSoffitToCut(soffitOf(L0), b, null, 5400), null, '切断線が足元の外');
  assert.equal(frozen(b), bBefore);
  assert.equal(b.ceilClip, undefined);
  assert.equal(applyStairSoffitToCut(soffitOf(L0), { dirSign: 1 }, null, 5400), null, 'line なし');
});

// ---------------------------------------------------------------- 隔て板の帯をはさむ裏面（ユーザー指示 2026-10-15 moku4-3 1階 C）

const SER = [{ loX: 0, hiX: 780, z0: 3600, z1: 3600 }, { loX: 780, hiX: 895, z0: 5400, z1: 5400 }, { loX: 895, hiX: 1675, z0: 4700, z1: 4700 }];

test('【指示2026-10-15】extendLowerCeilingAcrossStrip: 帯をはさんで低い側の天井を向こう面まで水平に延ばし、立下りは高い側の面', () => {
  const out = extendLowerCeilingAcrossStrip(SER, 780, 895);
  assert.deepEqual(out, [{ loX: 0, hiX: 780, z0: 3600, z1: 3600 }, { loX: 780, hiX: 895, z0: 3600, z1: 3600 }, { loX: 895, hiX: 1675, z0: 4700, z1: 4700 }],
    '帯は低い側（左 3600）の値。立下りは右の面 895');
  assert.deepEqual(SER[1], { loX: 780, hiX: 895, z0: 5400, z1: 5400 }, '引数は書き換えない');
  const mirrored = extendLowerCeilingAcrossStrip([...SER].map(s => ({ ...s })).reverse().map(s => ({ loX: 1675 - s.hiX, hiX: 1675 - s.loX, z0: s.z1, z1: s.z0 })), 780, 895);
  assert.deepEqual(mirrored.map(s => [s.loX, s.hiX, s.z0]), [[0, 780, 4700], [780, 895, 3600], [895, 1675, 3600]], '低い側が右なら帯は右の値。立下りは左の面 780');
});

test('【指示2026-10-15】extendLowerCeilingAcrossStrip: 帯が傾いた区間の中にあれば面で割り、帯の両側の値は割った端の値そのもの', () => {
  // 面 C: X2 側の裏面が帯の上まで傾いて続き、X1 側の面で立下る → X1 側の値で帯を平らに、立下りを X2 側の面へ
  const ser = [{ loX: 0, hiX: 895, z0: 4583, z1: 4551 }, { loX: 895, hiX: 1082, z0: 3735, z1: 3675 }];
  const out = extendLowerCeilingAcrossStrip(ser, 780, 895);
  assert.equal(out.length, 3);
  near(out[0].hiX, 780, '帯の面で割る'); near(out[0].z1, 4583 + (4551 - 4583) * 780 / 895, '割った端は補間');
  assert.deepEqual([out[1].loX, out[1].hiX, out[1].z0, out[1].z1], [780, 895, 3735, 3735], '帯は低い側（右）の端の値そのもの');
  assert.deepEqual(out[2], ser[1], '右の区間は不変');
});

test('【指示2026-10-15・失敗系】extendLowerCeilingAcrossStrip: 両側が同じ高さ・帯が端に掛かる・帯が退化・空の区間列は不変', () => {
  const same = [{ loX: 0, hiX: 780, z0: 3600, z1: 3600 }, { loX: 780, hiX: 895, z0: 5400, z1: 5400 }, { loX: 895, hiX: 1675, z0: 3600, z1: 3600 }];
  assert.deepEqual(extendLowerCeilingAcrossStrip(same, 780, 895), same, '両側が同じなら帯は base のまま（どちらの天井も続かない）');
  assert.equal(extendLowerCeilingAcrossStrip(SER, 0, 895), SER, '帯が左端に掛かる');
  assert.equal(extendLowerCeilingAcrossStrip(SER, 780, 1675), SER, '帯が右端に掛かる');
  assert.equal(extendLowerCeilingAcrossStrip(SER, 800, 800), SER, '退化した帯');
  assert.equal(extendLowerCeilingAcrossStrip([], 780, 895).length, 0, '空');
  assert.equal(extendLowerCeilingAcrossStrip(null, 780, 895), null, 'null');
});

test('【指示2026-10-15】applyStairSoffitToCut: partitionStrip（世界の幅方向座標）があれば、あき（base）の帯が低い側の裏面になる。無効な帯は無視', () => {
  const gapL = { ...L0, across: { ...L0.across, sA: 940, sB: 1060 }, pivotAcross: 940 };
  const cutOf = () => ({ line: { isVertical: false, axisValue: 2000, lo: 57.5, hi: 1942.5 }, dirSign: 1, zRange: { loZ: 0, hiZ: 5400 } });
  const plain = cutOf();
  applyStairSoffitToCut(soffitOf(gapL), plain, [[0, 5400], [1885, 5400]], 5400);
  const cut = cutOf();
  const applied = applyStairSoffitToCut(soffitOf(gapL), cut, [[0, 5400], [1885, 5400]], 5400, { partitionStrip: { lo: 940, hi: 1060 } });
  const zRA = plain.ceilClip[0].ceilZHi, zRB = plain.ceilClip[2].ceilZ;
  assert.ok(zRA < zRB, '前提: 往路側が低い');
  near(cut.ceilClip[1].loX, 882.5, '帯の始まり'); near(cut.ceilClip[1].hiX, 1002.5, '帯の終わり');
  near(cut.ceilClip[1].ceilZ, zRA, '帯は低い側の値'); near(cut.ceilClip[1].ceilZHi, zRA, '平ら');
  assert.deepEqual(applied.ceilingProfile.map(p => Math.round(p[0] * 1000) / 1000), [0, 882.5, 1002.5, 1002.5, 1885], '段は向こう面 1002.5 だけ');
  near(applied.ceilingProfile[2][1], zRA, '折れ線も帯の向こう面まで低い側'); near(applied.ceilingProfile[3][1], zRB, '向こう面で立下り');
  const bad = cutOf();
  applyStairSoffitToCut(soffitOf(gapL), bad, [[0, 5400], [1885, 5400]], 5400, { partitionStrip: { lo: NaN, hi: 1060 } });
  assert.deepEqual(bad.ceilClip, plain.ceilClip, '無効な帯は無視（従来どおり base）');
});

test('【指示2026-10-15】partitionStripOf: 同じ軸 CL 上で走りが重なる壁（オーナー壁＋薄壁）の材の範囲を合併。重ならない壁・別の CL は入れない', () => {
  const cl = { effectiveValue: 910 };
  const w = (range, c1, c2, axisCL = cl) => ({ materialRange: range, coord1: c1, coord2: c2, axisCL, isVertical: true });
  const owner = w({ lo: 865, hi: 967.5 }, -9157.5, -8132.5);
  const thin = w({ lo: 852.5, hi: 865 }, -9157.5, -8132.5);
  const far = w({ lo: 800, hi: 865 }, -7000, -6000);
  const other = w({ lo: 700, hi: 865 }, -9157.5, -8132.5, { effectiveValue: 910 });
  assert.deepEqual(partitionStripOf(owner, { walls: [owner, thin, far, other] }), { lo: 852.5, hi: 967.5 });
  assert.deepEqual(partitionStripOf(owner, { walls: [owner] }), { lo: 865, hi: 967.5 }, '1 枚だけ');
  assert.equal(partitionStripOf(null, { walls: [] }), null, '壁なし');
  assert.equal(partitionStripOf({ materialRange: null, coord1: 0, coord2: 1 }, { walls: [] }), null, '材の範囲なし');
});

// ---------------------------------------------------------------- stairChDimChains（CH 寸法の上端）

test('【E5】stairChDimChains: 踊り場側の端の上端はその端の裏面の実測値（四捨五入）。通常の断面の端（壁の向こう）は変えない', () => {
  const h = { landingAbs: 1500, hasRoomUnder: true, chLowerMm: 2400, floorHeight: 3000, chUpperAbsMm: 5400 };
  const base = stairChDimChains([{ seqNo: '1' }, { seqNo: '2' }], h);
  assert.deepEqual(base[0].left, [[1500, 3000], [3000, 5400]], '裏面なしは従来の上階天井');
  const soffitEnds = { 1: { left: 4158.27, right: 4158.27 }, 2: { left: 2400, right: 4158.27 } };
  const chains = stairChDimChains([{ seqNo: '1' }, { seqNo: '2' }], { ...h, soffitEnds });
  assert.deepEqual(chains[0].left, [[1500, 3000], [3000, 4158]], 'seq1 の左端＝踊り場側（両端とも）');
  assert.equal(chains[0].right, null, '前の端と同じ鎖は記入しない');
  assert.deepEqual(chains[1].left, [[0, 2400], [3000, 5400]], 'seq2 の左端＝壁の向こうの通常断面は裏面と無関係');
  assert.deepEqual(chains[1].right, [[1500, 3000], [3000, 4158]], 'seq2 の右端＝踊り場側');
});

test('【E5・失敗系】stairChDimChains: 裏面の値が非有限・欠落なら上階天井のまま。部屋が無いとき（床から踊り場）も上端だけ置き換える', () => {
  const h = { landingAbs: 1500, hasRoomUnder: false, chLowerMm: 2400, floorHeight: 3000, chUpperAbsMm: 5400 };
  const chains = stairChDimChains([{ seqNo: '5' }], { ...h, soffitEnds: { 5: { left: null, right: NaN } } });
  assert.deepEqual(chains[0].right, [[0, 1500], [1500, 5400]]);
  const ok = stairChDimChains([{ seqNo: '5' }], { ...h, soffitEnds: { 5: { left: null, right: 4158.6 } } });
  assert.deepEqual(ok[0].right, [[0, 1500], [1500, 4159]]);
});

// ---------------------------------------------------------------- 実物の階（N と N+1 の同じ足元の階段）

function stairFloor(id, floor, { walls = false, structure = StructuralMaterialType.WOOD, floorLevel = null } = {}) {
  const g = makeGrid([0, 1000, 2000], [0, 1000, 4000], { id, startFloor: floor });
  const room = g.interior([[0, 0], [1, 0], [0, 1], [1, 1]], { walls });
  if (floorLevel != null) room.setFloorLevel(floorLevel);
  const cells = new Set([g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)]);
  const stair = g.graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', roomId: room.id });
  stair.structure = structure;
  return { graph: g.graph, room, stair };
}
const FLOOR_H = 2400; // 階高 2400・総蹴上 12 → 蹴上 200
const sofArgs = (n, u) => ({ stair: n.stair, graph: n.graph, upperGraph: u.graph, floorHeightMm: FLOOR_H, riserOf: () => 200 });
const ZA = FLOOR_H + 6 * RISER - DZ; // 回転部（踊り場）の最初の段の天端−dz（N+1 の FL=2400）

test('【E5】cellAt: 階段室のセルの天井は階段の裏面（点・列の幅の最大）。床段差を二重に足さない（floorZ + ch ＝ 立体の絶対 z）。裏面なしの層・他の部屋は従来', () => {
  const n = stairFloor('p1', 1, { floorLevel: 300 }), u = stairFloor('p2', 2);
  const soffit = stairSoffitAbove(sofArgs(n, u));
  assert.equal(soffit.floorStepMm, 300);
  const selfLayer = { graph: n.graph, floorZMm: 0, role: 'self', stairSoffit: { roomId: n.room.id, soffit } };
  const idx = buildSpaceIndex([selfLayer]);
  const pt = idx.cellAt(selfLayer, 500, 2000);
  assert.equal(pt.room.id, n.room.id);
  near(pt.floorZ, 300, 'floorZ＝階段室の床レベル');
  near(pt.ceilZ, soffit.solid.zAt(500, 2000), '点: 床段差 300 は floorZ に 1 回だけ（立体の絶対 z と一致）');
  const span = idx.cellAt(selfLayer, 500, 2000, { isVertical: true, depthCoord: 500, lo: 1500, hi: 2500 });
  near(span.ceilZ, soffit.solid.zAt(500, 1500), '列の幅の最大＝高い側（y が小さい側）の端の絶対 z');
  // 裏面なしの層は従来どおり（部屋の CH 2400 + 床段差 300）
  const plain = { graph: n.graph, floorZMm: 0, role: 'self' };
  near(buildSpaceIndex([plain]).cellAt(plain, 500, 2000).ceilZ, 300 + 2400, '従来');
  // 階段室でない部屋のセル（roomId が違う）は裏面の対象外
  const other = { graph: n.graph, floorZMm: 0, role: 'self', stairSoffit: { roomId: 'someone-else', soffit } };
  near(buildSpaceIndex([other]).cellAt(other, 500, 2000).ceilZ, 300 + 2400, '別の部屋');
  // 足元の外（階段室の中でも立体の矩形に掛からない点・列）は従来の天井
  near(idx.cellAt(selfLayer, 500, 2000, { isVertical: true, depthCoord: 5000, lo: 0, hi: 100 }).ceilZ, 300 + 2400, '【失敗系】深さが足元の外');
});

// 歩行順 5 面の体裁とエンジン
function sequenceOf({ structure = StructuralMaterialType.WOOD, withSoffit = true } = {}) {
  const n = stairFloor('p1', 1, { walls: true }), u = stairFloor('p2', 2, { structure, walls: true }); // 上階の外壁が裏面で打ち切られて天井に届く
  const faces = composeRoomFaces(n.room, n.graph, { keepWallLessFaces: true });
  const layers = buildBandLayers(n.graph, { above: [{ graph: u.graph, floorHeightMm: FLOOR_H }] });
  const soffit = withSoffit ? stairSoffitAbove(sofArgs(n, u)) : null;
  if (soffit) layers.find(l => l.role === 'self').stairSoffit = { roomId: n.room.id, soffit };
  const entries = stairFaceSequence(n.stair, faces, n.graph, {
    floorHeight: FLOOR_H, chUpperAbsMm: 4800, chLowerMm: 2400, upperGraph: u.graph, layers, stairSoffit: soffit,
  });
  return { n, u, soffit, entries };
}
const worldRunOf = (face, x) => face.originWorld + x * face.dirSign;
/** 各 seq の切断線の深さ（走りに直交する座標）。往路レーン x≈500・復路レーン x≈1500（どちらも R/Q の平らな幅の中）・seq1/3 は走行方向の y。 */
const AXIS_OF = { 1: 1000, 2: 500, 3: 900, 4: 500, 5: 1500 }; // seq3 は前縁（y=1000）から踊り場側（y が小さい側）へ 100 入る

test('【E5】stairFaceSequence: 各 seq の天井（ceilingProfile）が、切断線の深さで切った裏面の絶対 z と一致（向き・原点・段の取り違えの検出）', () => {
  const { soffit, entries } = sequenceOf();
  assert.ok(soffit && entries);
  for (const e of entries) {
    assert.ok(Array.isArray(e.ceilingProfile) && e.ceilingProfile.length >= 2, `seq${e.seqNo}: 裏面の天井断面がある`);
    for (let x = 1; x < e.face.run; x += 97) {
      const run = worldRunOf(e.face, x);
      const [wx, wy] = e.face.isVertical ? [AXIS_OF[e.seqNo], run] : [run, AXIS_OF[e.seqNo]];
      const expected = soffit.solid.zAt(wx, wy);
      near(drawnFloorProfileZAt(e.ceilingProfile, x), expected, `seq${e.seqNo} x=${x}`, 0.05);
    }
  }
  // 往路（seq2）は上り口 2400 付近から踊り場 ZA まで登り、踊り場は平ら。復路（seq5）は上階（N+2 側）へさらに登る
  const e2 = entries.find(e => e.seqNo === '2');
  const seq2 = e2.ceilingProfile, seq5 = entries.find(e => e.seqNo === '5').ceilingProfile;
  // 上り口が左右どちらかは回転方向次第（裁定2026-10-15。この fixture は flip=false で上り口が右）。踊り場側の端は landingEnd。
  const [entryZ, landingZ] = e2.landingEnd === 'right'
    ? [seq2[0][1], seq2[seq2.length - 1][1]] : [seq2[seq2.length - 1][1], seq2[0][1]];
  assert.ok(entryZ < 2500 && Math.abs(landingZ - ZA) < 0.05, `seq2: 上り口 → 踊り場（landingEnd=${e2.landingEnd}）`);
  assert.ok(Math.max(...seq5.map(p => p[1])) > ZA + 1000, 'seq5: 復路は踊り場より高く登る');
});

test('【E5】stairFaceSequence: 裏面のあるとき CH 寸法の鎖の踊り場側の上端は裏面の実測値（四捨五入）。裏面なしは上階天井 4800', () => {
  const withS = sequenceOf().entries, without = sequenceOf({ withSoffit: false }).entries;
  const upperOf = chains => chains.filter(Boolean).map(c => c[c.length - 1][1]);
  const a = withS.flatMap(e => [e.chDimChains.left, e.chDimChains.right]);
  const b = without.flatMap(e => [e.chDimChains.left, e.chDimChains.right]);
  assert.ok(upperOf(a).includes(Math.round(ZA)), `裏面の値が上端に入る: ${upperOf(a)}`);
  assert.ok(!upperOf(b).includes(Math.round(ZA)), '裏面なしでは入らない');
  assert.ok(upperOf(b).every(v => v === 4800 || v === 2400), `裏面なしは従来の上端: ${upperOf(b)}`);
});

test('【E5・失敗系】stairFaceSequence: 上階が鉄骨（裏面なし）・stairSoffit 未指定のとき ceilingProfile は従来（seq1/3/5 は付かない・seq2/4 は N の CH／上階天井の階段状）', () => {
  for (const r of [sequenceOf({ structure: StructuralMaterialType.STEEL }), sequenceOf({ withSoffit: false })]) {
    assert.equal(r.soffit, null);
    for (const e of r.entries.filter(x => ['1', '3', '5'].includes(x.seqNo))) assert.equal(e.ceilingProfile, undefined, `seq${e.seqNo}`);
    for (const e of r.entries.filter(x => ['2', '4'].includes(x.seqNo))) assert.ok(e.ceilingProfile.every(p => p[1] === 2400 || p[1] === 4800), `seq${e.seqNo}: ${JSON.stringify(e.ceilingProfile)}`);
  }
});

test('【E5】帯レベル: 面の内側（端の壁の厚みを除く）で、エンジンの線は天井断面より上に出ない。傾いた線（天井の斜線）をエンジンが重ねて引くこともない', () => {
  const { entries } = sequenceOf();
  assert.deepEqual(doubleHorizontals(entries), [], '水平の二重線（天井の折れ線と重なる太線・笠木の下線）');
  const TOL = 0.5, END = 130;
  for (const e of entries) {
    const ceilAt = x => Math.max(drawnFloorProfileZAt(e.ceilingProfile, x - 0.01), drawnFloorProfileZAt(e.ceilingProfile, x + 0.01));
    const inner = x => x > END && x < e.face.run - END;
    const pts = [];
    for (const p of e.content) {
      if (p.type === 'line') pts.push([p.x1, p.y1], [p.x2, p.y2]);
      else if (p.type === 'polyline') for (const [x, y] of p.points) pts.push([x, y]);
    }
    for (const [x, y] of pts) if (inner(x)) assert.ok(-y <= ceilAt(x) + TOL, `seq${e.seqNo}: (${x}, z=${-y}) が天井 ${ceilAt(x)} より上`);
    // 斜線（水平でも垂直でもない 2 点線）が天井断面の折れ線の上に載っていない
    const prof = e.ceilingProfile;
    for (const p of e.content.filter(q => q.type === 'line' && q.x1 !== q.x2 && q.y1 !== q.y2)) {
      for (let i = 0; i + 1 < prof.length; i++) {
        if (prof[i][0] === prof[i + 1][0]) continue;
        const onProf = (x, y) => Math.abs(-y - drawnFloorProfileZAt(prof, x)) < 0.05;
        assert.ok(!(onProf(p.x1, p.y1) && onProf(p.x2, p.y2)), `seq${e.seqNo}: 天井の斜線をエンジンが二重に引いている`);
      }
    }
  }
});

// 天井まで届く切断壁（面の端の壁・踊り場の壁）の天端は露出していない: 天井の折れ線と重なる太線も、50mm 下の笠木の細線も出ない
function doubleHorizontals(entries) {
  const bad = [];
  for (const e of entries) {
    const prof = e.ceilingProfile;
    const ceilAt = x => drawnFloorProfileZAt(prof, x);
    for (const p of e.content) {
      if (p.type !== 'line' || p.y1 !== p.y2 || p.x1 === p.x2) continue;
      const z = -p.y1, xm = (p.x1 + p.x2) / 2;
      const flat = Math.abs(ceilAt(Math.min(p.x1, p.x2) + 0.01) - ceilAt(Math.max(p.x1, p.x2) - 0.01)) < 0.01 && Math.abs(ceilAt(xm) - z) < 0.01;
      if (flat && p.weight === 'thick') bad.push(`seq${e.seqNo} 天端の太線 z=${z} x=${p.x1}..${p.x2}`);
      if (p.weight === 'thin' && Math.abs(ceilAt(xm) - 50 - z) < 0.01) bad.push(`seq${e.seqNo} 笠木の下線 z=${z} x=${p.x1}..${p.x2}`);
    }
  }
  return bad;
}

test('【階段帯の天井まで届く切断壁に天端線と笠木の下線が出ない】天井の折れ線の平らな区間と重なる水平の太線 0・50mm 下の細線 0', () => {
  const { entries } = sequenceOf();
  assert.deepEqual(doubleHorizontals(entries), []);
});

test('【床段差 300 での ceilClip と cellAt の差（記録）】階段室の床レベル 300: ceilClip は ch のまま・cellAt は floorZ+ch で、ceilClip が層スタックより床段差ぶん低い（階段帯の makeProbeContext は floorOffset 無しの既存の差）', () => {
  const n = stairFloor('p1', 1, { walls: true, floorLevel: 300 }), u = stairFloor('p2', 2);
  const soffit = stairSoffitAbove(sofArgs(n, u));
  const cut = { line: { isVertical: true, axisValue: 500, lo: 57.5, hi: 3942.5 }, dirSign: 1, zRange: { loZ: 0, hiZ: 9000 } };
  applyStairSoffitToCut(soffit, cut, null, 5400);
  const layer = { graph: n.graph, floorZMm: 0, role: 'self', stairSoffit: { roomId: n.room.id, soffit } };
  const stackCeil = buildSpaceIndex([layer]).cellAt(layer, 500, 1500).ceilZ;
  const cx = 1500 - 57.5; // y=1500 ↔ 断面ローカル x（dirSign=+1・原点 line.lo）
  const clipCeil = cut.ceilClip.find(s => s.loX <= cx && cx <= s.hiX);
  const z = clipCeil.ceilZ + (clipCeil.ceilZHi - clipCeil.ceilZ) * (cx - clipCeil.loX) / (clipCeil.hiX - clipCeil.loX);
  near(stackCeil - z, 300, '層スタックの天井 − ceilClip の天井 ＝ 床段差');
});
