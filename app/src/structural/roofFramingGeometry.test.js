import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roofFramingLines, roofRidgeIsVertical, koyaBeamPositions, roofStrutPoints, purlinLayoutFromRidge,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const PITCH = 910;
const STARTS = [455, 910];
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const lines = (rect, shape, extra = {}) =>
  roofFramingLines({ rect, shape, purlinPitchMm: PITCH, purlinStartOffsetsMm: STARTS, tolMm: TOL, ...extra });
const coords = ls => ls.map(l => l.coord);
const layout = (halfSpanMm, extra = {}) =>
  purlinLayoutFromRidge({ halfSpanMm, pitchMm: PITCH, startOffsetsMm: STARTS, tolMm: TOL, ...extra });
const seq = (start, n) => Array.from({ length: n }, (_, i) => start + i * 910);

// ---- purlinLayoutFromRidge（母屋の割付の唯一の判断。2026-10-02 ユーザー裁定: 棟木から 455 か 910 始まり・910 ピッチ） ----

test('purlinLayoutFromRidge: 手計算の例（H→採る案・位置・残り）', () => {
  const cases = [
    [3640, 910, [910, 1820, 2730], 910],
    [3185, 455, [455, 1365, 2275], 910],
    [3000, 455, [455, 1365, 2275], 725],
    [2000, 455, [455, 1365], 635],
    [1830, 455, [455, 1365], 465],
    [1820, 910, [910], 910],
    [915, 455, [455], 460],
    [910, null, [], 910],
    [900, null, [], 900],
    [700, null, [], 700],
    [500, null, [], 500],
    [455, null, [], 455],
    [0, null, [], 0],
  ];
  for (const [h, startOffsetMm, offsetsMm, eaveGapMm] of cases) {
    assert.deepEqual(layout(h), { startOffsetMm, offsetsMm, eaveGapMm }, `H=${h}`);
  }
});

test('purlinLayoutFromRidge: 軒桁と重なる位置（H±tol）には置かない（H が 910 の倍数ちょうど・455+k*910 ちょうど）', () => {
  for (const h of [910, 1820, 3640, 455, 1365, 3185]) {
    const { offsetsMm } = layout(h);
    assert.ok(offsetsMm.every(o => o < h - TOL), `H=${h}: ${offsetsMm}`);
  }
  assert.deepEqual(layout(910).offsetsMm, [], '910 始まりの 910 は軒と重なる');
  assert.deepEqual(layout(1820).offsetsMm, [910], '1820 は軒と重なる');
  assert.deepEqual(layout(3640).offsetsMm, [910, 1820, 2730], '3640 は軒と重なる');
  assert.deepEqual(layout(3185).offsetsMm, [455, 1365, 2275], '3185 は軒と重なる');
  assert.deepEqual(layout(1365).offsetsMm, [455], '1365 は軒と重なる（455 始まりの 2 本目）');
  assert.deepEqual(layout(455).offsetsMm, [], '455 は軒と重なる');
});

test('purlinLayoutFromRidge: tol の境界（H=910.4/910.6、1365.4/1365.6）', () => {
  assert.deepEqual(layout(910.4).offsetsMm, [], '910.4 は tol 内＝軒と重なる');
  // 910.6: 910 始まり [910] 残り 0.6／455 始まり [455] 残り 455.6 → 455 始まり
  assert.deepEqual(layout(910.6).offsetsMm, [455]);
  // 1365.4: 910 始まり [910] 残り 455.4／455 始まり [455]（1365 は軒と重なる）残り 910.4 → 455 始まり
  assert.deepEqual(layout(1365.4).offsetsMm, [455]);
  // 1365.6: 455 始まり [455, 1365] 残り 0.6 ／910 始まり [910] 残り 455.6 → 910 始まり
  assert.deepEqual(layout(1365.6).offsetsMm, [910]);
});

test('purlinLayoutFromRidge: 2案の残りは同じにならない（H を 0〜8000 の 5 刻みで走査）。採った案は |910−残り| がもう一方以下', () => {
  for (let h = 0; h <= 8000; h += 5) {
    const a = layout(h, { startOffsetsMm: [455] });
    const b = layout(h, { startOffsetsMm: [910] });
    if (h > 455 + TOL) assert.notEqual(a.eaveGapMm, b.eaveGapMm, `H=${h}`); // 455 以下は両案とも母屋なし＝同じ残り
    const got = layout(h);
    const dist = c => Math.abs(910 - c.eaveGapMm);
    assert.ok(dist(got) <= Math.min(dist(a), dist(b)), `H=${h}`);
    // 位置は 始まり + k*910 で昇順・最後の位置 < H−tol・母屋があるとき残り ≤ 910+tol
    const { offsetsMm, startOffsetMm, eaveGapMm } = got;
    offsetsMm.forEach((o, k) => assert.equal(o, startOffsetMm + k * 910, `H=${h}`));
    if (offsetsMm.length > 0) {
      assert.ok(offsetsMm[offsetsMm.length - 1] < h - TOL, `H=${h}`);
      assert.ok(eaveGapMm <= 910 + TOL, `H=${h}`);
    } else {
      assert.equal(startOffsetMm, null);
      assert.equal(eaveGapMm, h);
    }
  }
});

test('【失敗系】purlinLayoutFromRidge: 不正入力（ピッチ・候補が空か 0 以下か非有限・許容差・半スパンが負か非有限）は RangeError', () => {
  assert.throws(() => layout(3000, { startOffsetsMm: [] }), RangeError);
  assert.throws(() => layout(3000, { startOffsetsMm: undefined }), RangeError);
  assert.throws(() => layout(3000, { startOffsetsMm: [455, 0] }), RangeError);
  assert.throws(() => layout(3000, { startOffsetsMm: [NaN] }), RangeError);
  assert.throws(() => layout(3000, { pitchMm: 0 }), RangeError);
  assert.throws(() => layout(3000, { pitchMm: undefined }), RangeError);
  assert.throws(() => layout(3000, { tolMm: -1 }), RangeError);
  assert.throws(() => layout(-1), RangeError);
  assert.throws(() => layout(Infinity), RangeError);
});

test('roofRidgeIsVertical: 縦長のみ true（横長・正方形は false）', () => {
  assert.equal(roofRidgeIsVertical(rc(0, 0, 3000, 5000)), true);
  assert.equal(roofRidgeIsVertical(rc(0, 0, 5000, 3000)), false);
  assert.equal(roofRidgeIsVertical(rc(0, 0, 4000, 4000)), false);
});

test('切妻 7280x8974（縦長）: 棟は x=3640 の縦線、母屋は片側3本（x=910,1820,2730 と 4550,5460,6370）計6本', () => {
  const r = rc(0, -12614, 7280, -3640);
  const { ridges, purlins } = lines(r, RoofShape.GABLE, { ridgeIsVertical: true });
  assert.deepEqual(ridges, [{ isVertical: true, coord: 3640, lo: -12614, hi: -3640 }]);
  assert.deepEqual(coords(purlins), [910, 1820, 2730, 4550, 5460, 6370]);
  for (const p of purlins) {
    assert.equal(p.isVertical, true);
    assert.equal(p.lo, -12614);
    assert.equal(p.hi, -3640);
  }
});

test('切妻: ridgeIsVertical 省略時は長手方向（縦長 7280x8974 なら縦の棟）', () => {
  const { ridges } = lines(rc(0, 0, 7280, 8974), RoofShape.GABLE);
  assert.equal(ridges[0].isVertical, true);
  assert.equal(ridges[0].coord, 3640);
});

test('切妻 6370x9000: 棟 3185、半スパン 3185 は 455 始まり（910 始まりだと軒桁の手前 455 しか残らないため）で棟から両側に 455・1365・2275 の3本ずつ計6本', () => {
  const { ridges, purlins } = lines(rc(0, 0, 6370, 9000), RoofShape.GABLE, { ridgeIsVertical: true });
  assert.equal(ridges[0].coord, 3185);
  assert.deepEqual(coords(purlins), [910, 1820, 2730, 3640, 4550, 5460]);
});

test('切妻 短手 3640（横長 5000x3640）: 棟 y=1820、母屋は y=910 と 2730 の1本ずつ。1820 には置かない', () => {
  const { ridges, purlins } = lines(rc(0, 0, 5000, 3640), RoofShape.GABLE);
  assert.deepEqual(ridges, [{ isVertical: false, coord: 1820, lo: 0, hi: 5000 }]);
  assert.deepEqual(coords(purlins), [910, 2730]);
  assert.ok(purlins.every(p => !p.isVertical && p.lo === 0 && p.hi === 5000));
});

test('切妻 正方形 4550x4550: 棟は横方向（x 方向に走る y=2275）、半スパン 2275 は 455 始まりで y=910,1820 と 2730,3640 計4本（残り 910）', () => {
  const { ridges, purlins } = lines(rc(0, 0, 4550, 4550), RoofShape.GABLE);
  assert.deepEqual(ridges, [{ isVertical: false, coord: 2275, lo: 0, hi: 4550 }]);
  assert.deepEqual(coords(purlins), [910, 1820, 2730, 3640]);
  assert.ok(purlins.every(p => !p.isVertical));
});

test('切妻 短手 1820: 棟 910 と母屋の位置が重なるので母屋 0 本', () => {
  const { ridges, purlins } = lines(rc(0, 0, 6000, 1820), RoofShape.GABLE);
  assert.equal(ridges[0].coord, 910);
  assert.deepEqual(purlins, []);
});

test('片流れ 6000x3640 high=top（y 小さい側が高い）: 母屋は高い側 y1=0 から 910,1820,2730 の3本（y=0 の高い辺には置かない）', () => {
  const { ridges, purlins } = lines(rc(0, 0, 6000, 3640), RoofShape.MONO, { highSide: 'top' });
  assert.deepEqual(ridges, []);
  assert.deepEqual(coords(purlins), [910, 1820, 2730]);
  assert.ok(purlins.every(p => !p.isVertical && p.lo === 0 && p.hi === 6000));
});

test('片流れ 6000x3640 high=bottom: 高い側 y2=3640 から 2730,1820,910（y=3640 の高い辺には置かない）', () => {
  const { purlins } = lines(rc(0, 0, 6000, 3640), RoofShape.MONO, { highSide: 'bottom' });
  assert.deepEqual(coords(purlins), [910, 1820, 2730]);
});

test('片流れ 4550x3000 high=left: 高い側 x1=0 から 910,1820,2730,3640 の4本（x=0 の高い辺には置かない）、縦線 y:0..3000', () => {
  const { purlins } = lines(rc(0, 0, 4550, 3000), RoofShape.MONO, { highSide: 'left' });
  assert.deepEqual(coords(purlins), [910, 1820, 2730, 3640]);
  assert.ok(purlins.every(p => p.isVertical && p.lo === 0 && p.hi === 3000));
});

test('片流れ 4550x3000 high=right: 高い側 x2=4650 から 3740,2830,1920,1010 の4本', () => {
  const { purlins } = lines(rc(100, 0, 4650, 3000), RoofShape.MONO, { highSide: 'right' });
  assert.deepEqual(coords(purlins), [1010, 1920, 2830, 3740]);
});

test('片流れ 5000x3000（端数あり・上下左右が非対称）: 4方向とも高い側の辺から数える（向きの取り違えを検出）', () => {
  const r = rc(0, 0, 5000, 3000);
  const at = highSide => coords(lines(r, RoofShape.MONO, { highSide }).purlins);
  // 高さ3000 は 455 始まり（残り 725）で3本。幅5000 は 455 始まり（残り 905）で5本（910 始まりは残り 450）。
  assert.deepEqual(at('top'), seq(455, 3), 'top: y=0 が高い。y=0 から 455・1365・2275');
  assert.deepEqual(at('bottom'), seq(455, 3).map(o => 3000 - o).reverse(), 'bottom: y=3000 が高い。y=3000 から');
  assert.deepEqual(at('left'), seq(455, 5), 'left: x=0 が高い。x=0 から 455 始まり');
  assert.deepEqual(at('right'), seq(455, 5).map(o => 5000 - o).reverse(), 'right: x=5000 が高い。x=5000 から');
  assert.ok(lines(r, RoofShape.MONO, { highSide: 'top' }).purlins.every(p => !p.isVertical));
  assert.ok(lines(r, RoofShape.MONO, { highSide: 'left' }).purlins.every(p => p.isVertical));
});

test('片流れ 3640 幅 high=right: 高い辺から 910,1820,2730 の3本のみ（0 は低い軒と一致するので置かない）', () => {
  const { purlins } = lines(rc(0, 0, 3640, 5000), RoofShape.MONO, { highSide: 'right' });
  assert.deepEqual(coords(purlins), [910, 1820, 2730]);
});

test('寄棟 7280x8974: 半スパン 3640 は 910 ピッチ。環は d=910,1820,2730 の3重（各4本=12本）、棟木は x=3640 の縦線 y:3640..5334（長さ 1694）', () => {
  const r = rc(0, 0, 7280, 8974);
  const { ridges, purlins } = lines(r, RoofShape.HIP);
  assert.deepEqual(ridges, [{ isVertical: true, coord: 3640, lo: 3640, hi: 5334 }]);
  assert.equal(purlins.length, 12);
  // d=910 の環: 横線 y=910 と y=8064（x 910..6370）、縦線 x=910 と x=6370（y 910..8064）
  const h = purlins.filter(p => !p.isVertical && p.coord === 910);
  assert.deepEqual(h, [{ isVertical: false, coord: 910, lo: 910, hi: 6370 }]);
  const v = purlins.filter(p => p.isVertical && p.coord === 6370);
  assert.deepEqual(v, [{ isVertical: true, coord: 6370, lo: 910, hi: 8064 }]);
  // d=2730 の環の端
  const inner = purlins.filter(p => p.isVertical && p.coord === 2730);
  assert.deepEqual(inner, [{ isVertical: true, coord: 2730, lo: 2730, hi: 6244 }]);
});

test('寄棟 横長 9000x3640: 棟木は y=1820 の横線 x:1820..7180、環は d=910 の1重（4本）', () => {
  const { ridges, purlins } = lines(rc(0, 0, 9000, 3640), RoofShape.HIP);
  assert.deepEqual(ridges, [{ isVertical: false, coord: 1820, lo: 1820, hi: 7180 }]);
  assert.equal(purlins.length, 4);
});

test('寄棟 正方形 5460x5460: 棟木なし（方形）、環は d=910,1820 の2重（8本。2730 は中心で置かない）', () => {
  const { ridges, purlins } = lines(rc(0, 0, 5460, 5460), RoofShape.HIP);
  assert.deepEqual(ridges, []);
  assert.equal(purlins.length, 8);
  assert.ok(!purlins.some(p => p.coord === 2730));
});

test('寄棟 短辺 1820: 環が棟に潰れるので母屋 0 本、棟木だけ', () => {
  const { ridges, purlins } = lines(rc(0, 0, 4000, 1820), RoofShape.HIP);
  assert.equal(ridges.length, 1);
  assert.deepEqual(purlins, []);
});

test('【失敗系】rect=null・陸屋根・棟違い・未知の形状は空', () => {
  const empty = { ridges: [], purlins: [] };
  assert.deepEqual(lines(null, RoofShape.GABLE), empty);
  assert.deepEqual(lines(rc(0, 0, 5000, 4000), RoofShape.FLAT), empty);
  assert.deepEqual(lines(rc(0, 0, 5000, 4000), RoofShape.STAGGERED), empty);
  assert.deepEqual(lines(rc(0, 0, 5000, 4000), 'dome'), empty);
  assert.deepEqual(lines(rc(0, 0, 5000, 4000), undefined), empty);
});

test('【失敗系】幅または高さが 0 の矩形は空（例外にしない）', () => {
  const empty = { ridges: [], purlins: [] };
  assert.deepEqual(lines(rc(0, 0, 0, 4000), RoofShape.GABLE), empty);
  assert.deepEqual(lines(rc(0, 0, 4000, 0), RoofShape.HIP), empty);
});

test('寄棟 9000x5000（端数あり）: 半スパン 2500 は 910 始まり（残り 680）。環は棟木側から 910,1820 ＝軒から d=1590,680', () => {
  const { purlins } = lines(rc(0, 0, 9000, 5000), RoofShape.HIP);
  assert.deepEqual(layout(2500), { startOffsetMm: 910, offsetsMm: [910, 1820], eaveGapMm: 680 });
  assert.equal(purlins.length, 8);
  const horizontal = purlins.filter(p => !p.isVertical);
  assert.deepEqual(coords(horizontal), [680, 1590, 3410, 4320]);
  assert.deepEqual(horizontal.filter(p => p.coord === 680), [{ isVertical: false, coord: 680, lo: 680, hi: 8320 }]);
  const vertical = purlins.filter(p => p.isVertical);
  assert.deepEqual(coords(vertical), [680, 1590, 7410, 8320]);
  assert.deepEqual(vertical.filter(p => p.coord === 1590), [{ isVertical: true, coord: 1590, lo: 1590, hi: 3410 }]);
});

test('寄棟 5460x4550: 半スパン 2275 は 455 始まり。環は棟木側から 455,1365 ＝軒から d=1820,910（軒基準に取り違えると位置が変わる）', () => {
  const { ridges, purlins } = lines(rc(0, 0, 5460, 4550), RoofShape.HIP);
  assert.deepEqual(layout(2275), { startOffsetMm: 455, offsetsMm: [455, 1365], eaveGapMm: 910 });
  assert.deepEqual(ridges, [{ isVertical: false, coord: 2275, lo: 2275, hi: 3185 }]);
  assert.deepEqual(coords(purlins.filter(p => !p.isVertical)), [910, 1820, 2730, 3640]);
});

test('【失敗系】母屋のピッチ・1本目の候補・許容差の不正は RangeError', () => {
  const r = rc(0, 0, 5000, 4000);
  const run = extra => roofFramingLines({
    rect: r, shape: RoofShape.GABLE, purlinPitchMm: PITCH, purlinStartOffsetsMm: STARTS, tolMm: TOL, ...extra,
  });
  for (const purlinStartOffsetsMm of [[], [0], [-455], [NaN], [Infinity], [455, 0], undefined, 455]) {
    assert.throws(() => run({ purlinStartOffsetsMm }), RangeError, String(purlinStartOffsetsMm));
  }
  for (const purlinPitchMm of [0, -1, NaN, undefined, Infinity]) {
    assert.throws(() => run({ purlinPitchMm }), RangeError, `purlinPitchMm ${purlinPitchMm}`);
  }
  assert.throws(() => run({ tolMm: -1 }), RangeError);
  assert.throws(() => run({ tolMm: undefined }), RangeError);
  // rect=null でも不正なら例外
  assert.throws(() => run({ rect: null, shape: RoofShape.FLAT, purlinStartOffsetsMm: [0] }), RangeError);
});

test('【失敗系】矩形の座標が非有限・逆順は RangeError。片流れの highSide が不正も RangeError', () => {
  assert.throws(() => lines(rc(0, 0, NaN, 4000), RoofShape.GABLE), RangeError);
  assert.throws(() => lines(rc(5000, 0, 0, 4000), RoofShape.GABLE), RangeError);
  assert.throws(() => lines(rc(0, 0, 5000, 4000), RoofShape.MONO, { highSide: 'up' }), RangeError);
  assert.throws(() => lines(rc(0, 0, 5000, 4000), RoofShape.MONO), RangeError);
});

// ---- koyaBeamPositions ----

const kb = (ls, extra = {}) => koyaBeamPositions({
  lines: ls, maxPitchMm: 1820, gridModuleMm: 910, tolMm: TOL, ...extra,
});
const hl = (coord, lo, hi) => ({ isVertical: false, coord, lo, hi });
const vl = (coord, lo, hi) => ({ isVertical: true, coord, lo, hi });

function maxGap(line, positions, supports = []) {
  const pts = [line.lo, line.hi, ...positions.filter(p => p > line.lo && p < line.hi),
    ...supports.filter(s => s.at > line.lo && s.at < line.hi).map(s => s.at)].sort((a, b) => a - b);
  let g = 0;
  for (let i = 0; i + 1 < pts.length; i++) g = Math.max(g, pts[i + 1] - pts[i]);
  return g;
}

test('koyaBeamPositions: 長さ 1820 以下の線は小屋梁なし（端を含む間隔が 1820 以下）', () => {
  assert.deepEqual(kb([hl(0, 0, 1820)]), []);
});

test('koyaBeamPositions: 長さ 3640 の線は端から 1820 の1本（tier・グリッド無しは a+max）', () => {
  assert.deepEqual(kb([hl(0, 0, 3640)]), [1820]);
});

test('koyaBeamPositions: 長さ 5000 は 2本（1820, 3640）。全間隔 ≤ 1820', () => {
  const l = hl(0, 0, 5000);
  const r = kb([l]);
  assert.deepEqual(r, [1820, 3640]);
  assert.ok(maxGap(l, r) <= 1820);
});

test('koyaBeamPositions: 座標が非ゼロ始まり（lo=-12614, hi=-3640 の縦線）でも全間隔 ≤ 1820', () => {
  const l = vl(3640, -12614, -3640); // 長さ 8974
  const r = kb([l]);
  assert.equal(r.length, 4); // ceil(8974/1820)-1 = 4
  assert.ok(maxGap(l, r) <= 1820);
});

test('koyaBeamPositions: tier の優先 — 通り芯があれば中心線・グリッドより優先（窓内の最大値）', () => {
  // 線 0..4000。a=0 の窓は (0.5, 1820.5]。通り芯 1500、中心線 1800、グリッド 1820 → 通り芯 1500
  const r = kb([hl(0, 0, 4000)], { tiers: [[1500], [1800]], gridOriginOf: () => 0 });
  assert.equal(r[0], 1500);
  // 次の a=1500 の窓は (1500.5, 3320.5]。tier に無いので中心線 1800 は窓内の最上位非空 tier＝中心線 → 1800
  assert.equal(r[1], 1800);
  // 次は a=1800 の窓 (1800.5, 3620.5] に tier の値が無く、原点 0 のグリッドの最大点 2730
  assert.deepEqual(r, [1500, 1800, 2730]);
});

test('koyaBeamPositions: tier 内は窓の最大値。通り芯が窓の外なら中心線、それも無ければ 910 グリッドの最大点', () => {
  // 通り芯 2000 は窓 (0.5,1820.5] の外 → 中心線 1000 と 1700 のうち大きい 1700
  assert.equal(kb([hl(0, 0, 3000)], { tiers: [[2000], [1000, 1700]] })[0], 1700);
  // tier 無し・原点 100 のグリッド: 100+910n ≤ 1820.5 の最大 → 1920 は超過、1010 → 1010
  assert.equal(kb([hl(0, 0, 3000)], { gridOriginOf: () => 100 })[0], 1010);
  // グリッドの原点が undefined なら a+max
  assert.equal(kb([hl(0, 0, 3000)], { gridOriginOf: () => undefined })[0], 1820);
});

test('koyaBeamPositions: グリッドの原点が負でも窓 (0.5,1820.5] 内の最大点（-10000+910*12=920。13 本目 1830 は窓外）', () => {
  assert.equal(kb([hl(0, 0, 3000)], { gridOriginOf: () => -10000 })[0], 920);
});

test('koyaBeamPositions: 既存の support が覆っていれば足さない（線の coord が support の範囲内）', () => {
  const l = hl(500, 0, 3640);
  const sup = [{ at: 1820, lo: 0, hi: 1000 }];
  assert.deepEqual(kb([l], { supports: sup }), []);
});

test('koyaBeamPositions: support の範囲が線の coord を覆わなければ無視される', () => {
  const l = hl(5000, 0, 3640);
  const sup = [{ at: 1820, lo: 0, hi: 1000 }];
  assert.deepEqual(kb([l], { supports: sup }), [1820]);
});

test('koyaBeamPositions: 冪等 — 出力を support として与え直すと []', () => {
  const ls = [hl(0, 0, 8974), hl(3640, 0, 8974), hl(7280, 0, 6000)];
  const r = kb(ls, { tiers: [[1500, 4500]] });
  assert.ok(r.length > 0);
  const sup = r.map(at => ({ at, lo: -1e9, hi: 1e9 }));
  assert.deepEqual(kb(ls, { tiers: [[1500, 4500]], supports: sup }), []);
});

test('koyaBeamPositions: 最少性 — 1本で複数の線の違反を同時に解く（線 0..3000 と 0..3500 は 1820 の1本）', () => {
  const r = kb([hl(0, 0, 3000), hl(1000, 0, 3500)]);
  assert.deepEqual(r, [1820]); // 別々に解くと 2 本
});

test('koyaBeamPositions: 複数の線の全てで間隔 ≤ 1820', () => {
  const ls = [hl(0, 0, 9000), hl(2000, 2500, 7000), hl(4000, 0, 3000)];
  const r = kb(ls);
  for (const l of ls) assert.ok(maxGap(l, r) <= 1820 + TOL, `line ${l.coord}`);
});

test('koyaBeamPositions: 間隔の判定は「1820 ちょうどは違反でない」（長さ 1820.5 まで許容、1822 は違反）', () => {
  assert.deepEqual(kb([hl(0, 0, 1820.4)]), []);
  assert.deepEqual(kb([hl(0, 0, 1820.5)]), []); // ちょうど max+tol は違反にしない
  assert.deepEqual(kb([hl(0, 0, 1822)]), [1820]);
});

test('【失敗系】空の入力・長さ 0 の線・lines 未指定は []', () => {
  assert.deepEqual(kb([]), []);
  assert.deepEqual(kb([hl(0, 100, 100)]), []);
  assert.deepEqual(kb(undefined), []);
});

test('【失敗系】不正入力は RangeError（max/grid/tol・非有限の座標・lo>hi・向きの混在）', () => {
  assert.throws(() => kb([hl(0, 0, 3000)], { maxPitchMm: 0 }), RangeError);
  assert.throws(() => kb([hl(0, 0, 3000)], { gridModuleMm: -1 }), RangeError);
  assert.throws(() => kb([hl(0, 0, 3000)], { tolMm: NaN }), RangeError);
  assert.throws(() => kb([hl(0, 0, NaN)]), RangeError);
  assert.throws(() => kb([hl(NaN, 0, 3000)]), RangeError);
  assert.throws(() => kb([hl(0, 3000, 0)]), RangeError);
  assert.throws(() => kb([hl(0, 0, 3000)], { supports: [{ at: NaN, lo: 0, hi: 1 }] }), RangeError);
  assert.throws(() => kb([hl(0, 0, 3000)], { supports: [{ at: 1, lo: 5, hi: 0 }] }), RangeError, 'support の lo>hi');
  assert.throws(() => kb([hl(0, 0, 3000), vl(0, 0, 3000)]), RangeError);
});

// ---- roofStrutPoints ----

const mem = (isVertical, axis, lo, hi) => ({ isVertical, axis, lo, hi });

test('roofStrutPoints: 縦の母屋 x=910 と横の梁 y=0,4000 の交点2つ（x 昇順・y 昇順）', () => {
  const pts = roofStrutPoints([vl(910, 0, 4000)], [mem(false, 4000, 0, 7000), mem(false, 0, 0, 7000)], TOL);
  assert.deepEqual(pts, [{ x: 910, y: 0 }, { x: 910, y: 4000 }]);
});

test('roofStrutPoints: 横の線と縦の材の交点（x=axis, y=coord）', () => {
  const pts = roofStrutPoints([hl(1820, 0, 5000)], [mem(true, 2500, 0, 4000)], TOL);
  assert.deepEqual(pts, [{ x: 2500, y: 1820 }]);
});

test('roofStrutPoints: 端で接する（材の端が線上・線の端が材上）は tol まで含め、tol を超えると含めない', () => {
  // 材 y=1000 は x 0..910 → 線 x=910 が材の端に接する
  assert.equal(roofStrutPoints([vl(910, 0, 4000)], [mem(false, 1000, 0, 910)], TOL).length, 1);
  assert.equal(roofStrutPoints([vl(910, 0, 4000)], [mem(false, 1000, 0, 909.4)], TOL).length, 0);
  // 線の端が材の上（材 y=4000.4、線 y 0..4000）
  assert.equal(roofStrutPoints([vl(910, 0, 4000)], [mem(false, 4000.4, 0, 2000)], TOL).length, 1);
  assert.equal(roofStrutPoints([vl(910, 0, 4000)], [mem(false, 4001, 0, 2000)], TOL).length, 0);
});

test('roofStrutPoints: 平行な組は交点なし', () => {
  assert.deepEqual(roofStrutPoints([vl(910, 0, 4000)], [mem(true, 910, 0, 4000)], TOL), []);
});

test('roofStrutPoints: 重複（同じ点を作る材）は除く', () => {
  const pts = roofStrutPoints([vl(910, 0, 4000)], [mem(false, 2000, 0, 5000), mem(false, 2000.2, 0, 5000)], TOL);
  assert.deepEqual(pts, [{ x: 910, y: 2000 }]);
});

test('roofStrutPoints: 範囲外の材は交点なし。空入力は []', () => {
  assert.deepEqual(roofStrutPoints([vl(910, 0, 4000)], [mem(false, 5000, 0, 7000)], TOL), []);
  assert.deepEqual(roofStrutPoints([], [], TOL), []);
  assert.deepEqual(roofStrutPoints(undefined, undefined, TOL), []);
});

test('【失敗系】roofStrutPoints: 非有限の座標・不正な許容差は RangeError', () => {
  assert.throws(() => roofStrutPoints([vl(NaN, 0, 4000)], [], TOL), RangeError);
  assert.throws(() => roofStrutPoints([], [mem(false, NaN, 0, 1)], TOL), RangeError);
  assert.throws(() => roofStrutPoints([], [], -1), RangeError);
});

test('切妻の母屋・棟木と横架材の束: 7280x8974 縦棟 × 軒桁2本（y=-12614,-3640）で 7本×2=14 点', () => {
  const r = rc(0, -12614, 7280, -3640);
  const { ridges, purlins } = lines(r, RoofShape.GABLE, { ridgeIsVertical: true });
  const pts = roofStrutPoints([...ridges, ...purlins], [mem(false, -12614, 0, 7280), mem(false, -3640, 0, 7280)], TOL);
  assert.equal(pts.length, 14);
});
