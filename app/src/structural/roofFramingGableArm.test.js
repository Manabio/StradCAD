// L字（矩形でない）の切妻の下屋（腕ごとに棟木）の軒・けらばの決め方（roofFramingGeometry.js gableArmDrainsOf）と、その水下を
// leanToDrainFraming（水下だけが進む場）に渡した棟木・母屋・隅木・谷木・面のテスト。期待値は手計算（y は下向き正）。
// 規則: 屋根範囲の外周の辺ごとに、辺の幅いっぱいのまま内側へ掃いて一部でも外周に当たるまでの距離 L を求め、辺の長さ w に対し
// L > w＋tol ならけらば（腕の端）、それ以外は軒（水下）。同じ長さは軒。長手方向の腕＝けらばの L が最大の腕（同じなら幅が広い方）。
// 母屋の段の始まり r＝その腕の半スパンに purlinLayoutFromRidge を当てた残り（割付: ピッチ910・1本目の候補 [455,910]）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gableArmDrainsOf, leanToDrainFraming, purlinLayoutFromRidge, roofFramingLines, roofHipDiagonals, drainFaceAnchors } from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const DR = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const DG = (kind, x1, y1, x2, y2) => ({ kind, x1, y1, x2, y2 });
const ln = (isVertical, coord, lo, hi) => ({ isVertical, coord, lo, hi });
const plain = lines => lines.map(({ isVertical, coord, lo, hi }) => ln(isVertical, coord, lo, hi));
const KZ = (isVertical, coord, lo, hi, outward, kind) => ({ isVertical, coord, lo, hi, outward, kind });

// ---- 形（座標は mm） ----
// roof-test8 の2階の下屋（屋内に接する辺は壁だが、種別は幾何だけで決まる）。横の腕 x3640..9100 × y-3640..0（幅 3640）・縦の腕 x7280..9100 × y-9884..-3640（幅 1820）
const R8 = [rc(3640, -3640, 7280, 0), rc(7280, -3640, 9100, 0), rc(7280, -7280, 9100, -3640), rc(7280, -9884, 9100, -9100), rc(7280, -9100, 9100, -7280)];
// T字: 横の棒 x0..9000 × y0..3000・縦の棒 x3000..6000 × y3000..9000
const T = [rc(0, 0, 9000, 3000), rc(3000, 3000, 6000, 9000)];
// 正方形3つの L字（辺 3000）
const SQ3 = [rc(0, 0, 3000, 3000), rc(3000, 0, 6000, 3000), rc(0, 3000, 3000, 6000)];
// コの字（下の横棒 y6000..9000 と、左右の腕 x0..3000・x6000..9000 × y0..6000）
const U = [rc(0, 6000, 9000, 9000), rc(0, 0, 3000, 6000), rc(6000, 0, 9000, 6000)];
// 十字（腕は 3000 角）
const CROSS = [rc(3000, 0, 6000, 3000), rc(0, 3000, 9000, 6000), rc(3000, 6000, 6000, 9000)];
// 穴あき（外周 9000 角・中央に 3000 角の穴）
const RING = [rc(0, 0, 9000, 3000), rc(0, 3000, 3000, 6000), rc(6000, 3000, 9000, 6000), rc(0, 6000, 9000, 9000)];
// 段違い（上の辺は一直線・右が x6000 から y3000 までの段）
const STEP = [rc(0, 0, 6000, 6000), rc(6000, 0, 9000, 3000)];
const RECT = [rc(0, 0, 9000, 3000)];
// 同じ深さ（9000）のけらばを2つ持つ L字。横の腕の幅 3000・縦の腕の幅 2000
const EQ_DEPTH = [rc(0, 0, 9000, 3000), rc(0, 3000, 2000, 9000)];
// 深い腕（横の腕 幅 2000・深さ 9100）が狭く、浅い腕（縦の腕 幅 3640・深さ 5460）が広い
const DEEP_NARROW = [rc(0, 0, 9100, 2000), rc(0, 2000, 3640, 5460)];
// 腕の幅 2000（半スパン 1000＝455 の倍数でない奥行き。r=545）
const R545 = [rc(0, 0, 9100, 2000), rc(0, 2000, 2000, 9100)];

const kindsOf = rects => gableArmDrainsOf({ rects, tolMm: TOL }).kindZones;
const gablesOf = rects => kindsOf(rects).filter(z => z.kind === 'gable').map(z => `${z.isVertical ? 'x' : 'y'}=${z.coord}`).sort();

// ---- gableArmDrainsOf: 軒とけらばの決め方 ----

test('gableArmDrainsOf: roof-test8 型の L字は軒4辺（下辺・右辺・壁2辺。同じ長さの壁 y=-3640 も軒）・けらば2辺（左辺・上辺）。水下は軒の辺、kindZones は全辺', () => {
  const g = gableArmDrainsOf({ rects: R8, tolMm: TOL });
  assert.equal(g.kindZones.length, 6, '前提: 外周は6辺');
  assert.deepEqual(g.kindZones, [
    KZ(false, -9884, 7280, 9100, -1, 'gable'), // 上辺（幅 1820・掃いた深さ 9884）
    KZ(true, 9100, -9884, 0, 1, 'eave'), // 右辺（幅 9884・深さ 1820）
    KZ(false, 0, 3640, 9100, 1, 'eave'), // 下辺（幅 5460・深さ 3640）
    KZ(true, 3640, -3640, 0, -1, 'gable'), // 左辺（幅 3640・深さ 5460）
    KZ(false, -3640, 3640, 7280, -1, 'eave'), // 壁（幅 3640・深さ 3640＝同じ長さは軒）
    KZ(true, 7280, -9884, -3640, -1, 'eave'), // 壁（幅 6244・深さ 1820）
  ]);
  assert.deepEqual(g.drains, [DR(true, 9100, -9884, 0, 1), DR(false, 0, 3640, 9100, 1), DR(false, -3640, 3640, 7280, -1), DR(true, 7280, -9884, -3640, -1)]);
  assert.equal(g.longHalfSpanMm, 910, '長手方向の腕＝けらばの深さが最大（上辺の 9884）の腕。幅 1820 の半分');
  assert.deepEqual(g.longArmRect, rc(7280, -9884, 9100, 0), '長手方向の腕の矩形＝上辺の幅いっぱいを掃いた深さ 9884 まで（leanToDrainRoute が壁を除いた水下の D の最大値を測る範囲）');
});

test('gableArmDrainsOf: 長手方向の腕の矩形（longArmRect）は、けらばの辺の幅いっぱいを掃いた深さまでの矩形。けらばが無い形は null', () => {
  assert.deepEqual(gableArmDrainsOf({ rects: RECT, tolMm: TOL }).longArmRect, rc(0, 0, 9000, 3000), '矩形は幅 3000 の短辺（左端）から長手いっぱい。左右どちらのけらばも同じ矩形');
  assert.deepEqual(gableArmDrainsOf({ rects: DEEP_NARROW, tolMm: TOL }).longArmRect, rc(0, 0, 9100, 2000), '深い腕（右端のけらば。深さ 9100）が長手方向の腕');
  assert.deepEqual(gableArmDrainsOf({ rects: T, tolMm: TOL }).longArmRect, rc(0, 0, 9000, 3000), 'T字は棒の左端と縦の棒の下端が同じ深さ 9000・同じ幅 3000＝先に出会う左端が勝つ');
  assert.equal(gableArmDrainsOf({ rects: [rc(0, 0, 3000, 3000)], tolMm: TOL }).longArmRect, null, '正方形はけらばが無い（4辺とも軒）');
  assert.equal(gableArmDrainsOf({ rects: RING, tolMm: TOL }).longArmRect, null, '環もけらばが無い');
});

test('gableArmDrainsOf: 形ごとの辺の種別（T字・正方形3つの L字・コの字・十字・穴あき・段違い・矩形・正方形）', () => {
  // T字: 横の棒の両端と縦の棒の下端がけらば。他（棒の上辺・棒の付け根の辺・縦の棒の両側）は軒
  assert.deepEqual(gablesOf(T), ['x=0', 'x=9000', 'y=9000']);
  assert.equal(gableArmDrainsOf({ rects: T, tolMm: TOL }).drains.length, 5);
  // 正方形3つの L字: 腕ごとに端の1辺だけがけらば（右端 x=6000・下端 y=6000）。正方形の腕（深さ＝幅）は端以外がけらばを持たない
  assert.deepEqual(gablesOf(SQ3), ['x=6000', 'y=6000']);
  assert.equal(gableArmDrainsOf({ rects: SQ3, tolMm: TOL }).drains.length, 4);
  // コの字: 左右の腕の先端がけらば
  assert.deepEqual(gablesOf(U), ['y=0', 'y=0']);
  assert.equal(gableArmDrainsOf({ rects: U, tolMm: TOL }).drains.length, 6);
  // 十字: 4つの腕の先端がけらば・側面8辺は軒
  assert.deepEqual(gablesOf(CROSS), ['x=0', 'x=9000', 'y=0', 'y=9000']);
  assert.equal(gableArmDrainsOf({ rects: CROSS, tolMm: TOL }).drains.length, 8);
  // 穴あき: 穴の辺も軒（外周も全辺軒）。けらばが無いので長手方向の腕は決まらない
  const ring = gableArmDrainsOf({ rects: RING, tolMm: TOL });
  assert.equal(ring.kindZones.length, 8, '前提: 外周4辺＋穴の4辺');
  assert.equal(ring.drains.length, 8);
  assert.equal(ring.longHalfSpanMm, null);
  // 段違い
  assert.deepEqual(gablesOf(STEP), ['x=9000'], '段の内側の辺 x=6000 は深さが長くても入隅に接するので軒');
  // 矩形（呼び出し側は使わない）: 長辺が軒・短辺がけらば。正方形は4辺とも軒
  assert.deepEqual(gablesOf(RECT), ['x=0', 'x=9000']);
  assert.equal(gableArmDrainsOf({ rects: RECT, tolMm: TOL }).longHalfSpanMm, 1500);
  const square = gableArmDrainsOf({ rects: [rc(0, 0, 3000, 3000)], tolMm: TOL });
  assert.equal(square.drains.length, 4, '同じ長さ（深さ＝幅）は軒＝正方形はけらばを持たない');
  assert.equal(square.longHalfSpanMm, null);
});

test('gableArmDrainsOf: 入隅（凹の角）に接する辺は、掃いた深さが長くても必ず軒。けらばは腕の端（両端が出隅）だけ。腕の突き出しが幅より短い形でも水下4・棟木2', () => {
  const cases = [
    // roof-test8 の横の腕を x=4550 始まりにした形（突き出し 2730 ＜ 幅 3640）。壁 y=-3640[4550..7280] は入隅に接するので軒
    { name: '横の腕 x=4550 始まり', cells: [rc(4550, -3640, 9100, 0), rc(7280, -9884, 9100, -3640)], gables: ['x=4550', 'y=-9884'], drains: 4, ridges: 2 },
    // 横の腕 4000×1500・縦の腕 2000×1500。縦の腕の右の辺 x=4000[3000..4500] は入隅に接するので軒（深さ 2000 ＞ 長さ 1500 でも）
    { name: '明示切妻の L字', cells: [rc(2000, 1500, 6000, 3000), rc(2000, 3000, 4000, 4500)], gables: ['x=6000', 'y=4500'], drains: 4, ridges: 2 },
    // 本体 7280×5460 の下に突起 2730×910
    { name: '本体＋突起', cells: [rc(0, 0, 7280, 5460), rc(0, 5460, 2730, 6370)], gables: ['x=7280', 'y=6370'], drains: 4, ridges: 2 },
    // 十字（短い腕の側辺は全部軒・腕の先端4辺がけらば）
    { name: '十字', cells: CROSS, gables: ['x=0', 'x=9000', 'y=0', 'y=9000'], drains: 8, ridges: 2 },
  ];
  for (const c of cases) {
    assert.deepEqual(gablesOf(c.cells), c.gables, `${c.name}: けらばは腕の端だけ`);
    const { g, fr } = fieldOf(c.cells);
    assert.equal(g.drains.length, c.drains, `${c.name}: 水下の本数`);
    assert.ok(fr.ridges.length >= c.ridges, `${c.name}: 棟木が腕ごとに出る（${fr.ridges.length} 本）`);
    assert.equal(fr.faces.filter(f => f.lines.length > 0).length >= 1, true);
  }
});

test('gableArmDrainsOf: 腕の長さが幅±1mm でも分類は連続（けらば2・軒4）。L字・コの字・T字・Z字・段違い・穴あきの腕の端だけがけらば', () => {
  for (const len of [3639, 3640, 3641]) {
    const cells = [rc(0, 0, 5460, 1820), rc(0, 1820, 1820, len)]; // 縦の腕 幅 1820・長さ len−1820 ＋ 1820
    assert.deepEqual(gablesOf(cells), ['x=5460', `y=${len}`], `縦の腕の長さ ${len}`);
    assert.equal(gableArmDrainsOf({ rects: cells, tolMm: TOL }).drains.length, 4);
  }
  const Zs = [rc(0, 0, 5460, 1820), rc(3640, 1820, 5460, 5460), rc(3640, 5460, 9100, 7280)];
  assert.deepEqual(gablesOf(Zs), ['x=0', 'x=9100'], 'Z字: 両端の腕の先端だけ');
  assert.deepEqual(gablesOf(T), ['x=0', 'x=9000', 'y=9000'], 'T字');
  assert.deepEqual(gablesOf(U), ['y=0', 'y=0'], 'コの字');
  assert.deepEqual(gablesOf(SQ3), ['x=6000', 'y=6000'], '正方形3つ');
  assert.equal(gableArmDrainsOf({ rects: RING, tolMm: TOL }).kindZones.some(z => z.kind === 'gable'), false, '穴あき: 穴の辺（入隅）も外周も軒');
});

test('gableArmDrainsOf: 許容差。深さが幅を tolMm 以内で上回るだけなら軒・tolMm を超えて上回ればけらば', () => {
  const eave = gableArmDrainsOf({ rects: [rc(0, 0, 3000, 3000.4)], tolMm: TOL });
  assert.equal(eave.kindZones.length, 4, '前提: 4辺');
  assert.equal(eave.drains.length, 4, '3000.4 ≦ 3000+0.5 は軒');
  assert.equal(eave.longHalfSpanMm, null);
  const gable = gableArmDrainsOf({ rects: [rc(0, 0, 3000, 3000.6)], tolMm: TOL });
  assert.equal(gable.drains.length, 2, '3000.6 > 3000+0.5 はけらば（上下の辺）');
  assert.equal(gable.longHalfSpanMm, 1500);
});

// ---- 長手方向の腕（母屋の段の基準） ----

test('gableArmDrainsOf: longHalfSpanMm＝けらばの掃いた深さが最大の腕の幅の半分。幅が広い腕でなく深い腕が勝つ（roof-test8 型: 縦の腕 1820 の半分）', () => {
  assert.equal(gableArmDrainsOf({ rects: R8, tolMm: TOL }).longHalfSpanMm, 910, '縦の腕（幅 1820・深さ 9884）が横の腕（幅 3640・深さ 5460）に勝つ');
  assert.equal(gableArmDrainsOf({ rects: T, tolMm: TOL }).longHalfSpanMm, 1500);
  assert.equal(gableArmDrainsOf({ rects: R545, tolMm: TOL }).longHalfSpanMm, 1000);
});

test('gableArmDrainsOf: 深い腕が狭いと半スパンは狭い腕のもの（横の腕 幅 2000・深さ 9100 と縦の腕 幅 3640・深さ 5460 → 1000＝r 545。広い腕の半スパン 1820＝r 910 ではない）', () => {
  const g = gableArmDrainsOf({ rects: DEEP_NARROW, tolMm: TOL });
  assert.deepEqual(gablesOf(DEEP_NARROW), ['x=9100', 'y=5460'], '前提: けらばは右端（深さ 9100）と下端（深さ 5460）。縦の腕の右の辺 x=3640 は入隅に接するので軒');
  assert.equal(g.longHalfSpanMm, 1000);
  const { r, fr } = fieldOf(DEEP_NARROW);
  assert.equal(r, 545, '母屋の段の始まり（長手方向の腕＝深い腕の半スパンから）');
  assert.ok(fr.purlins.length > 0, '前提: 母屋が出る');
  assert.ok(fr.purlins.every(l => (l.levelMm - r) % 910 === 0), '全ての母屋が r + k×910 の段（910 の倍数ではない）');
});

test('gableArmDrainsOf: 深さが同じなら幅が広い腕が勝つ（横の腕 幅 3000・縦の腕 幅 2000・どちらも深さ 9000 → 1500）。矩形の並び順に依らない', () => {
  const g = gableArmDrainsOf({ rects: EQ_DEPTH, tolMm: TOL });
  assert.deepEqual(gablesOf(EQ_DEPTH), ['x=9000', 'y=9000'], '前提: 2つのけらば（右端・下端）');
  assert.equal(g.longHalfSpanMm, 1500);
  assert.equal(gableArmDrainsOf({ rects: [...EQ_DEPTH].reverse(), tolMm: TOL }).longHalfSpanMm, 1500, '並びを逆にしても同じ');
});

// ---- 失敗系 ----

test('【失敗系】gableArmDrainsOf: 空・有効な矩形が無い入力は空の結果（例外にしない）。tolMm・rects の不正は RangeError', () => {
  const empty = { drains: [], kindZones: [], longHalfSpanMm: null, longArmRect: null };
  assert.deepEqual(gableArmDrainsOf({ rects: [], tolMm: TOL }), empty);
  assert.deepEqual(gableArmDrainsOf({ rects: [rc(0, 0, 0, 3000), rc(0, 0, 3000, 0.3)], tolMm: TOL }), empty, '幅か高さが tolMm 以下の矩形は無視');
  for (const tolMm of [-1, NaN, undefined, '0.5']) assert.throws(() => gableArmDrainsOf({ rects: RECT, tolMm }), RangeError, `tolMm=${tolMm}`);
  for (const rects of [null, undefined, 'x', {}]) assert.throws(() => gableArmDrainsOf({ rects, tolMm: TOL }), RangeError, `rects=${JSON.stringify(rects)}`);
  assert.throws(() => gableArmDrainsOf({ rects: [rc(0, 0, NaN, 3000)], tolMm: TOL }), RangeError, '座標が非有限');
  assert.throws(() => gableArmDrainsOf({ rects: [rc(3000, 0, 0, 3000)], tolMm: TOL }), RangeError, '座標が逆順');
});

// ---- 水下を場に渡した結果（棟木・母屋・隅木・谷木・面） ----

/** 形から場を求める（入口の roofFramingLines と同じ導き方: 水下は gableArmDrainsOf・段の始まり r は半スパンの purlinLayoutFromRidge）。 */
function fieldOf(rects) {
  const g = gableArmDrainsOf({ rects, tolMm: TOL });
  assert.ok(g.drains.length > 0 && g.longHalfSpanMm > 0, '前提: 水下と長手方向の腕がある');
  const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: g.longHalfSpanMm, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL });
  return { g, r: eaveGapMm, fr: leanToDrainFraming({ rects, drains: g.drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL }) };
}

test('場: roof-test8 型は棟木2（横の腕 y=-1820・縦の腕 x=8190）・隅木2・谷木1・面4・母屋3（r=910）', () => {
  const { r, fr } = fieldOf(R8);
  assert.equal(r, 910);
  assert.deepEqual(plain(fr.ridges), [ln(false, -1820, 3640, 7280), ln(true, 8190, -9884, -2730)], '縦の腕の棟木は壁 y=-3640 へ下る面に (8190,-2730) で当たって止まる');
  assert.deepEqual(plain(fr.purlins), [ln(false, -2730, 3640, 8190), ln(false, -910, 3640, 8190), ln(true, 8190, -2730, -910)]);
  assert.deepEqual(fr.diagonals, [DG('hip', 8190, -2730, 7280, -1820), DG('hip', 9100, 0, 7280, -1820), DG('valley', 7280, -3640, 8190, -2730)]);
  assert.equal(fr.faces.length, 4, '水下ごとに面');
  assert.deepEqual(fr.faces.map(f => [f.drain.isVertical, f.drain.coord, plain(f.lines)]), [
    [true, 9100, [ln(true, 8190, -9884, -2730), ln(true, 8190, -2730, -910)]],
    [true, 7280, []],
    [false, 0, [ln(false, -1820, 3640, 7280), ln(false, -910, 3640, 8190)]],
    [false, -3640, [ln(false, -2730, 3640, 8190)]],
  ]);
});

test('場: 入口（roofFramingLines・roofHipDiagonals）は水下を渡せば形状（切妻）を問わず場と同じ線を返す', () => {
  const { g, fr } = fieldOf(R8);
  const lines = roofFramingLines({
    rect: null, rects: R8, shape: RoofShape.GABLE, leanToDrains: g.drains, leanToPurlinDepthMm: g.longHalfSpanMm,
    purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL,
  });
  assert.deepEqual(lines, { ridges: fr.ridges, purlins: fr.purlins });
  assert.deepEqual(roofHipDiagonals({ rect: null, rects: R8, shape: RoofShape.GABLE, leanToDrains: g.drains, tolMm: TOL }), fr.diagonals);
});

test('場: T字は棟木2（横の棒・縦の棒が交点で出会う）・谷木2。正方形3つの L字は棟木2・隅木1・谷木1', () => {
  const t = fieldOf(T).fr;
  assert.deepEqual(plain(t.ridges), [ln(false, 1500, 0, 9000), ln(true, 4500, 1500, 9000)]);
  assert.deepEqual(t.diagonals, [DG('valley', 3000, 3000, 4500, 1500), DG('valley', 6000, 3000, 4500, 1500)]);
  const s = fieldOf(SQ3).fr;
  assert.deepEqual(plain(s.ridges), [ln(false, 1500, 1500, 6000), ln(true, 1500, 1500, 6000)]);
  assert.deepEqual(s.diagonals, [DG('hip', 0, 0, 1500, 1500), DG('valley', 3000, 3000, 1500, 1500)]);
});

test('場: 奥行きが 455 の倍数でない腕（半スパン 1000＝r 545。910 ではない）でも全ての面の母屋が同じ段 r + k×910 に載る', () => {
  const { r, fr } = fieldOf(R545);
  assert.equal(r, 545, '前提: r は 910 ではない');
  assert.ok(fr.purlins.length >= 4, '前提: 母屋が出る（検査が空振りしない）');
  assert.deepEqual(fr.purlins.map(l => (l.levelMm - r) % 910), fr.purlins.map(() => 0), '全ての母屋の水下からの距離が r + k×910');
  assert.deepEqual(plain(fr.purlins), [ln(false, 545, 545, 9100), ln(false, 1455, 1455, 9100), ln(true, 545, 545, 9100), ln(true, 1455, 1455, 9100)]);
  assert.equal(fr.faces.length, 4);
  assert.ok(fr.faces.every(f => f.lines.length > 0), '全ての面が母屋・棟木を持つ');
});

// ---- 既知の限界（受容）の固定。限界が解消されたら赤になる（今の値を固定。structural-model.md「L字の切妻の既知の限界」） ----

// 旧（既知の限界⑤）: 腕の長さが違うコの字で、短い腕の先端（けらば）が寄棟のように終わる（先端の両角から隅木が出て、棟木は先端まで来ず、
// 三角の面にラベルが出ない。別の腕の水下の帯が先端の外側を覆うため）。新（2026-10-05 水下だけが進む屋根面）: けらばは動かないので、
// 短い腕の先端は切妻のまま終わる（棟木が先端まで来る）。解消
test('腕の長さが違うコの字: 短い腕の先端（けらば）は切妻のまま終わる。棟木3（x=910・y=4550・x=8190）・隅木2・谷木2・母屋なし。先端の角から隅木は出ない', () => {
  const SHORT = [rc(0, 3640, 9100, 5460), rc(0, 0, 1820, 3640), rc(7280, 1820, 9100, 3640)]; // 右の腕が 1820 短い
  assert.deepEqual(gablesOf(SHORT), ['y=0', 'y=1820'], '前提: 短い腕の先端 y=1820[7280..9100] は正しくけらばに分類される');
  const { g, fr } = fieldOf(SHORT);
  assert.equal(g.drains.length, 6);
  assert.equal(fr.valid, true);
  assert.deepEqual(plain(fr.ridges), [ln(false, 4550, 910, 8190), ln(true, 910, 0, 4550), ln(true, 8190, 1820, 4550)], '棟木 x=8190 は先端 y=1820 まで来る');
  assert.deepEqual(fr.purlins, [], '幅 1820 で段 910 は棟木と重なるので母屋なし');
  assert.deepEqual(fr.diagonals, [
    DG('hip', 0, 5460, 910, 4550), DG('hip', 9100, 5460, 8190, 4550),
    DG('valley', 1820, 3640, 910, 4550), DG('valley', 7280, 3640, 8190, 4550),
  ], '隅木は下の両角から・谷木は入隅から。けらばの先端の角（y=0・y=1820）から斜め線は出ない');
  assert.equal(drainFaceAnchors({ rects: SHORT, drains: g.drains, tolMm: TOL }).length, g.drains.length, 'ラベルの数＝水下の数');
  // 対照: 腕の長さが同じでも同じ形（棟木 x=8190 は先端 y=0 まで）
  const eq = fieldOf([rc(0, 3640, 9100, 5460), rc(0, 0, 1820, 3640), rc(7280, 0, 9100, 3640)]);
  assert.deepEqual(plain(eq.fr.ridges).filter(l => l.isVertical && l.coord === 8190), [ln(true, 8190, 0, 4550)], '対照: 腕が同じ長さなら棟木は先端 y=0 まで');
});

test('【既知の限界（受容）④】腕の長さ＝幅−1mm の形は分類は連続（水下4・けらば2）だが、場が棟木を出さない（leanToDrainField の既存の癖）。＋1mm では棟木が出る', () => {
  const minus = [rc(0, 0, 5460, 1820), rc(0, 1820, 1820, 3639)];
  const plus = [rc(0, 0, 5460, 1820), rc(0, 1820, 1820, 3641)];
  assert.deepEqual(gablesOf(minus), ['x=5460', 'y=3639'], '前提: 分類は連続');
  assert.equal(gableArmDrainsOf({ rects: minus, tolMm: TOL }).drains.length, 4);
  assert.equal(fieldOf(minus).fr.ridges.length, 0, '−1mm: 棟木が0本');
  assert.deepEqual(gablesOf(plus), ['x=5460', 'y=3641']);
  assert.equal(fieldOf(plus).fr.ridges.length, 2, '＋1mm: 棟木が2本');
});

test('gableArmDrainsOf: 角だけで接する形は、出隅の判定で内側の行を見る（x=9100[0..1820]・y=1820[9100..10920] はけらば）', () => {
  const PINCH = [rc(0, 0, 9100, 1820), rc(9100, 1820, 10920, 9100)];
  assert.deepEqual(gablesOf(PINCH), ['x=0', 'x=9100', 'y=1820', 'y=9100'], '4辺ともけらば（角で接する2つの矩形）');
  assert.equal(gableArmDrainsOf({ rects: PINCH, tolMm: TOL }).drains.length, 4);
});
