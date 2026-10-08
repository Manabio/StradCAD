// planSectionFigure.js（平面の断面解決器。S3）の単体テスト。立体はリテラル（planTestFixtures.js solid）で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSectionFigure, PLAN_LINE_STYLE, PLAN_GAP_CLOSE_MM } from './planSectionFigure.js';
import { SOLID_KIND_ORDER } from './planSolids.js';
import {
  rect, solid, linesOf, sortedLines, mergedLines, totalLength,
} from './planTestFixtures.js';

const CUT = 1500;
const fig = (solids, cutZ = CUT, opts) => planSectionFigure(solids, cutZ, opts);
const sq = (x1, y1, x2, y2) => ({ rects: [rect(x1, y1, x2, y2)] });
const ofId = (prims, id) => prims.filter(p => p.source.id === id);
/** 「すべての X について」の検査が空振りしないよう、対象が空でないことを先に確かめる。 */
const nonEmpty = (arr, what) => { assert.ok(arr.length > 0, `${what} が空（検査が空振りする）`); return arr; };
const SQ1000 = [[0, 0, 0, 1000], [0, 0, 1000, 0], [0, 1000, 1000, 1000], [1000, 0, 1000, 1000]];
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}±${tol}`);

// ================================================================ 線種・分類

test('PLAN_LINE_STYLE: cut=thick・below=thin。出力の weight は必ずこの表から', () => {
  assert.deepEqual(PLAN_LINE_STYLE, { cut: { weight: 'thick' }, below: { weight: 'thin' } });
  const prims = fig([solid('generic', sq(0, 0, 1000, 1000), 0, 2000, { id: 'c' }), solid('generic', sq(3000, 0, 4000, 1000), 0, 1000, { id: 'b' })]);
  nonEmpty(prims, 'prims').forEach(p => assert.equal(p.weight, PLAN_LINE_STYLE[p.cls].weight));
  assert.equal(new Set(prims.map(p => p.cls)).size, 2, 'cut と below の両方を含む入力');
});

test('分類: zHi==cutZ は below（腰壁の天端が切断高ちょうど）。細線4本', () => {
  const prims = fig([solid('generic', sq(0, 0, 1000, 1000), 0, CUT)]);
  assert.deepEqual(sortedLines(prims), SQ1000);
  nonEmpty(prims, 'prims').forEach(p => { assert.equal(p.cls, 'below'); assert.equal(p.weight, 'thin'); });
});

test('分類: zLo==cutZ は above（非表示）、zLo<cutZ<zHi は cut（太線4本）', () => {
  assert.deepEqual(fig([solid('generic', sq(0, 0, 1000, 1000), CUT, 2000)]), []);
  const prims = fig([solid('generic', sq(0, 0, 1000, 1000), 0, 2000)]);
  assert.deepEqual(sortedLines(prims), SQ1000);
  nonEmpty(prims, 'prims').forEach(p => { assert.equal(p.cls, 'cut'); assert.equal(p.weight, 'thick'); });
});

test('分類: 厚み0（zLo==zHi==cutZ）は below（zHi<=cutZ が先）', () => {
  const prims = fig([solid('generic', sq(0, 0, 1000, 1000), CUT, CUT)]);
  assert.equal(prims.length, 4);
  prims.forEach(p => assert.equal(p.cls, 'below'));
});

test('分類: EPS の内外（±0.4 は同じ側、±0.6 は反対側）', () => {
  const cls = (zLo, zHi) => [...new Set(fig([solid('generic', sq(0, 0, 1000, 1000), zLo, zHi)]).map(p => p.cls))];
  assert.deepEqual(cls(0, CUT + 0.4), ['below'], 'zHi が cutZ+0.4 → below');
  assert.deepEqual(cls(0, CUT + 0.6), ['cut'], 'zHi が cutZ+0.6 → cut');
  assert.deepEqual(cls(CUT - 0.4, 2000), [], 'zLo が cutZ-0.4 → above');
  assert.deepEqual(cls(CUT - 0.6, 2000), ['cut'], 'zLo が cutZ-0.6 → cut');
  assert.deepEqual(cls(0, CUT + 0.5), ['below'], 'zHi がちょうど cutZ+EPS → below（<= ）');
  assert.deepEqual(cls(CUT - 0.5, 2000), [], 'zLo がちょうど cutZ-EPS → above（>= ）');
  assert.deepEqual([...new Set(fig([solid('generic', sq(0, 0, 1000, 1000), 0, CUT + 1.5)], CUT, { eps: 2 }).map(p => p.cls))], ['below'], 'opts.eps を広げると境界が動く');
});

// ================================================================ 遮蔽 (i)(ii)(iii)

test('遮蔽(i): 高い below は低い below の内部の線を隠す。低い方は高い方を隠さない', () => {
  const tall = solid('generic', sq(0, 0, 1000, 1000), 0, 1000, { id: 'a' });
  const low = solid('generic', sq(200, 200, 600, 600), 0, 500, { id: 'b' });
  const prims = fig([tall, low]);
  assert.equal(ofId(prims, 'a').length, 4, '高い方の線は全部残る');
  assert.equal(ofId(prims, 'b').length, 0, '低い方は高い方の内部にあるので全部隠れる');
  // 高さを入れ替える（内側が高い）と、内側の線も外側の線も全部描く
  const prims2 = fig([solid('generic', sq(0, 0, 1000, 1000), 0, 500, { id: 'a' }), solid('generic', sq(200, 200, 600, 600), 0, 1000, { id: 'b' })]);
  assert.equal(ofId(prims2, 'a').length, 4);
  assert.equal(ofId(prims2, 'b').length, 4);
});

test('遮蔽(i): 一部だけ重なる低い線は、高い立体の内側の区間だけ消える', () => {
  const prims = fig([
    solid('generic', sq(0, 0, 1000, 1000), 0, 1000, { id: 'a' }),
    solid('generic', sq(500, 200, 1500, 600), 0, 500, { id: 'b' }),
  ]);
  assert.deepEqual(sortedLines(ofId(prims, 'a')), SQ1000);
  assert.deepEqual(sortedLines(ofId(prims, 'b')), [[1000, 200, 1500, 200], [1000, 600, 1500, 600], [1500, 200, 1500, 600]]);
});

test('遮蔽(i): 同じ高さの below は隠し合わず両方描く', () => {
  const prims = fig([
    solid('generic', sq(0, 0, 1000, 1000), 0, 1000, { id: 'a' }),
    solid('generic', sq(200, 200, 600, 600), 0, 1000, { id: 'b' }),
  ]);
  assert.equal(ofId(prims, 'a').length, 4);
  assert.equal(ofId(prims, 'b').length, 4);
});

test('遮蔽(i): 切断面で切れる cut の壁は、内側の低い below（梁）を隠す', () => {
  const prims = fig([
    solid('wall', sq(0, 0, 1000, 300), 0, 2400, { id: 'w' }),
    solid('beam', sq(200, 100, 600, 200), -200, 0, { id: 'b' }),
  ]);
  assert.equal(ofId(prims, 'b').length, 0);
  assert.equal(ofId(prims, 'w').length, 4);
});

test('遮蔽(ii): 床と同じ高さの梁は、床の穴の外では消え、穴の中では見える', () => {
  const floor = solid('floor', { rects: [rect(0, 0, 2000, 2000)], holes: [rect(500, 500, 1000, 1000)] }, 0, 0, { id: 'f' });
  const beam = solid('beam', sq(100, 700, 1900, 800), -200, 0, { id: 'b' });
  const prims = fig([floor, beam]);
  assert.deepEqual(sortedLines(ofId(prims, 'b')), [[500, 700, 1000, 700], [500, 800, 1000, 800]], '穴の中の区間だけ');
  assert.equal(ofId(prims, 'f').length, 8, '床の外形4＋穴の縁4は梁に隠されない');
  // 穴の中に収まる梁は全部見える
  const inHole = fig([floor, solid('beam', sq(600, 600, 900, 900), -200, 0, { id: 'in' })]);
  assert.deepEqual(sortedLines(ofId(inHole, 'in')), [[600, 600, 600, 900], [600, 600, 900, 600], [600, 900, 900, 900], [900, 600, 900, 900]]);
});

test('遮蔽(ii): 床でない同じ高さの立体は梁を隠さない', () => {
  const prims = fig([
    solid('generic', sq(0, 0, 2000, 2000), 0, 0, { id: 'g' }),
    solid('beam', sq(100, 700, 1900, 800), -200, 0, { id: 'b' }),
  ]);
  assert.equal(ofId(prims, 'b').length, 4);
});

test('床の穴が外形に接するとき、接する辺は描かない（床の無い所に線を出さない）', () => {
  const floor = solid('floor', { rects: [rect(0, 0, 2000, 2000)], holes: [rect(0, 0, 1000, 1000)] }, 0, 0, { id: 'f' });
  assert.deepEqual(sortedLines(fig([floor])), [
    [0, 1000, 0, 2000], [0, 1000, 1000, 1000], [0, 2000, 2000, 2000],
    [1000, 0, 1000, 1000], [1000, 0, 2000, 0], [2000, 0, 2000, 2000],
  ]);
});

test('遮蔽(ii): 隣り合う床矩形の共有辺の上に乗る梁の線も床の内部として隠れる', () => {
  const floor = solid('floor', { rects: [rect(0, 0, 1000, 1000), rect(1000, 0, 2000, 1000)] }, 0, 0, { id: 'f' });
  const beam = solid('beam', sq(800, 400, 1200, 500), -200, 0, { id: 'b' }); // 水平辺の中点が共有辺 x=1000 の上
  assert.equal(ofId(fig([floor, beam]), 'b').length, 0);
});

test('遮蔽(iii): cut の壁2本の L 字は内部の辺が消え、和の輪郭だけが残る（重複線なし）', () => {
  const a = solid('wall', sq(0, 0, 1000, 100), 0, 2400, { id: 'a' });
  const b = solid('wall', sq(0, 0, 100, 1000), 0, 2400, { id: 'b' });
  const prims = fig([a, b]);
  assert.deepEqual(mergedLines(prims), [
    [0, 0, 0, 1000], [0, 0, 1000, 0], [0, 1000, 100, 1000], [100, 100, 100, 1000], [100, 100, 1000, 100], [1000, 0, 1000, 100],
  ]);
  assert.equal(totalLength(prims), 4000, 'L 字の外周の長さに一致＝重なって二重に描いた線が無い');
  nonEmpty(prims, 'prims').forEach(p => assert.equal(p.cls, 'cut'));
});

test('遮蔽(iii): 柱と壁が面で接するとき、共有面の線は両方とも消える', () => {
  const prims = fig([
    solid('column', sq(0, 0, 100, 100), 0, 2400, { id: 'c' }),
    solid('wall', sq(100, 0, 1000, 100), 0, 2400, { id: 'w' }),
  ]);
  assert.deepEqual(mergedLines(prims), [[0, 0, 0, 100], [0, 0, 1000, 0], [0, 100, 1000, 100], [1000, 0, 1000, 100]]);
  assert.equal(totalLength(prims), 2200);
});

test('境界上は隠さない: 壁の面に接する below 梁の辺は残る', () => {
  const wall = solid('wall', sq(0, 0, 1000, 100), 0, 2400, { id: 'w' });
  const beam = solid('beam', sq(200, 100, 600, 300), -200, 0, { id: 'b' }); // 上辺 y=100 が壁の面の上
  const prims = fig([wall, beam]);
  assert.deepEqual(sortedLines(ofId(prims, 'b')), [[200, 100, 200, 300], [200, 100, 600, 100], [200, 300, 600, 300], [600, 100, 600, 300]]);
  assert.equal(linesOf(prims, 'below', 'beam').length, 4);
});

test('遮蔽（和の内部）: 隣り合う 2 つの cut 壁の継ぎ目の上に乗る below 梁の線は消える。単独の壁の面に接する辺と和の外縁は残る', () => {
  const w1 = solid('wall', sq(0, 0, 100, 1000), 0, 2400, { id: 'w1' });
  const w2 = solid('wall', sq(100, 0, 200, 1000), 0, 2400, { id: 'w2' }); // w1 と x=100 の継ぎ目で接する
  const seam = solid('beam', sq(100, 300, 600, 400), -200, 0, { id: 'seam' }); // 左辺 x=100 が継ぎ目の上（y 300..400）
  const prims = fig([w1, w2, seam]);
  const lines = sortedLines(ofId(prims, 'seam'));
  assert.ok(!lines.some(l => l[0] === 100 && l[2] === 100), `継ぎ目の上の線が残っている: ${JSON.stringify(lines)}`);
  // 壁の外へ出る部分（x>200 の上辺・下辺）は残る
  assert.deepEqual(lines, [[200, 300, 600, 300], [200, 400, 600, 400], [600, 300, 600, 400]]);
  // 和の外縁: 梁の右辺が和（x=0..200）の外縁 x=200 の上にあるとき、外へ出る斜め点があるので残る
  const edge = fig([w1, w2, solid('beam', sq(200, 300, 600, 400), -200, 0, { id: 'edge' })]);
  assert.ok(sortedLines(ofId(edge, 'edge')).some(l => l[0] === 200 && l[2] === 200), '和の外縁の上の線は残る');
});

test('遮蔽（和の内部）: 継ぎ目の先に隙間があれば、その隙間（斜め点が壁の外）では線が残る', () => {
  const w1 = solid('wall', sq(0, 0, 100, 1000), 0, 2400, { id: 'w1' });
  const w2 = solid('wall', sq(100, 0, 200, 300), 0, 2400, { id: 'w2' }); // y 300 より先は w2 が無い
  const beam = solid('beam', sq(100, 100, 600, 700), -200, 0, { id: 'b' }); // 左辺 x=100 が y100..300 は継ぎ目、300..700 は w1 の面
  const left = sortedLines(ofId(fig([w1, w2, beam]), 'b')).filter(l => l[0] === 100 && l[2] === 100);
  assert.deepEqual(left, [[100, 300, 100, 700]], '継ぎ目（y100..300）だけ消え、w1 の面に接するだけの部分は残る');
});

test('遮蔽: above の立体は遮蔽物にしない', () => {
  const prims = fig([
    solid('generic', sq(0, 0, 2000, 2000), 3000, 3200, { id: 'up' }),
    solid('beam', sq(100, 700, 1900, 800), -200, 0, { id: 'b' }),
  ]);
  assert.equal(prims.length, 4);
  assert.deepEqual(prims.map(p => p.source.id), ['b', 'b', 'b', 'b']);
});

// ================================================================ 層・穴越しの下階

const SELF_FLOOR = () => solid('floor', { rects: [rect(0, 0, 4000, 4000)], holes: [rect(1000, 1000, 2000, 2000)] }, 0, 0, { id: 'f0', layerFloorZ: 0 });

test('下階: 自階の床の穴の中だけ見える（穴の外は見えない）', () => {
  const lower = solid('beam', sq(0, 1400, 4000, 1500), -3200, -3000, { id: 'lb', layerFloorZ: -3000 });
  const prims = fig([SELF_FLOOR(), lower]);
  assert.deepEqual(sortedLines(ofId(prims, 'lb')), [[1000, 1400, 2000, 1400], [1000, 1500, 2000, 1500]]);
  const outside = solid('beam', sq(3000, 3000, 3500, 3100), -3200, -3000, { id: 'out', layerFloorZ: -3000 });
  assert.equal(ofId(fig([SELF_FLOOR(), outside]), 'out').length, 0, '穴の外の下階は全部隠れる');
});

test('下階: 自階に床が無ければ下階は一切出ない／床に穴が無くても出ない', () => {
  const lower = solid('beam', sq(0, 1400, 4000, 1500), -3200, -3000, { id: 'lb', layerFloorZ: -3000 });
  assert.deepEqual(fig([lower]), []);
  const noHole = solid('floor', sq(0, 0, 4000, 4000), 0, 0, { id: 'f0' });
  assert.equal(ofId(fig([noHole, lower]), 'lb').length, 0);
});

test('3層: 上階は 0 件・自階は見える・下階は穴の中だけ', () => {
  const upper = [
    solid('wall', sq(0, 0, 1000, 100), 3000, 5400, { id: 'uw', layerFloorZ: 3000 }),
    solid('floor', sq(0, 0, 4000, 4000), 3000, 3000, { id: 'uf', layerFloorZ: 3000 }),
  ];
  const selfWall = solid('wall', sq(2500, 2500, 3500, 2600), 0, 2400, { id: 'sw' });
  const lower = solid('beam', sq(1200, 1400, 1800, 1500), -3200, -3000, { id: 'lb', layerFloorZ: -3000 });
  const prims = fig([...upper, SELF_FLOOR(), selfWall, lower]);
  assert.equal(prims.filter(p => p.source.layerFloorZ > 0).length, 0, '上階の線は出ない');
  assert.equal(ofId(prims, 'sw').length, 4);
  assert.equal(ofId(prims, 'lb').length, 4, '下階の梁は穴の中に収まるので全部見える');
  assert.ok(prims.some(p => p.source.layerFloorZ === 0 || p.source.layerFloorZ === undefined));
});

test('途中の階の床が更に下の層を隠す。同じ位置に穴があれば見える', () => {
  const deep = solid('beam', sq(1200, 1400, 1800, 1500), -6200, -6000, { id: 'b2', layerFloorZ: -6000 });
  const midClosed = solid('floor', sq(0, 0, 4000, 4000), -3000, -3000, { id: 'f1', layerFloorZ: -3000 });
  assert.equal(ofId(fig([SELF_FLOOR(), midClosed, deep]), 'b2').length, 0, '途中の階の床に穴が無ければ隠れる');
  const midOpen = solid('floor', { rects: [rect(0, 0, 4000, 4000)], holes: [rect(1000, 1000, 2000, 2000)] }, -3000, -3000, { id: 'f1', layerFloorZ: -3000 });
  const prims = fig([SELF_FLOOR(), midOpen, deep]);
  assert.equal(ofId(prims, 'b2').length, 4, '穴が重なっていれば見える');
  assert.equal(ofId(prims, 'f1').length, 4, '途中の階の床は穴の縁だけが窓の中に出る');
});

// ================================================================ 勾配

test('勾配: 下の梁を roof の zAt が隠す区間の切り替わりが ±1mm で正しい', () => {
  const roof = solid('roof', { poly: [0, 0, 2000, 0, 2000, 2000, 0, 2000] }, -2000, 0, { id: 'r', zAt: x => -2000 + x });
  const beam = solid('beam', sq(200, 900, 1800, 1000), -1237, -1037, { id: 'b' }); // 天端 -1037 → 面材の roof が -1037.5 以上になる x=962.5 から隠れる（同点でも勝つ）
  const prims = fig([roof, beam]);
  const beamLines = ofId(prims, 'b');
  assert.equal(beamLines.length, 3, '水平2本＋隠れない側の端の辺');
  const horizontals = nonEmpty(beamLines.filter(p => p.points[1] === p.points[3]), '水平辺');
  assert.equal(horizontals.length, 2);
  for (const p of horizontals) {
    near(Math.min(p.points[0], p.points[2]), 200, 0, '始点');
    near(Math.max(p.points[0], p.points[2]), 962.5, 1, '切り替わり点（roof の上端が梁の天端−EPS 以上になる所）');
  }
  assert.ok(beamLines.some(p => p.points[0] === 200 && p.points[2] === 200), 'x=200 の端の辺は残る');
  assert.ok(!beamLines.some(p => p.points[0] === 1800 && p.points[2] === 1800), 'x=1800 の端の辺は roof に隠れる');
});

test('勾配: 区間の端から半ステップ内で可視が切り替わっても取りこぼさない（始端側 x=0..15・終端側 x=985..1000）', () => {
  const beam = solid('beam', sq(0, 100, 1000, 200), -200, 0, { id: 'b' }); // 天端 0。面材の roof が −0.5 以上になると隠れる
  const horizontals = prims => nonEmpty(ofId(prims, 'b').filter(p => p.points[1] === p.points[3]), '水平辺');
  const startSide = solid('roof', { poly: [-500, 0, 1500, 0, 1500, 300, -500, 300] }, -52, 150, { id: 'r', zAt: x => 0.1 * x - 2 });
  const a = horizontals(fig([startSide, beam]));
  assert.equal(a.length, 2);
  for (const p of a) {
    near(Math.min(p.points[0], p.points[2]), 0, 0, '始点');
    near(Math.max(p.points[0], p.points[2]), 15, 1, '始端側の切り替わり');
  }
  const endSide = solid('roof', { poly: [-500, 0, 1500, 0, 1500, 300, -500, 300] }, -52, 150, { id: 'r', zAt: x => 0.1 * (1000 - x) - 2 });
  const b = horizontals(fig([endSide, beam]));
  assert.equal(b.length, 2);
  for (const p of b) {
    near(Math.min(p.points[0], p.points[2]), 985, 1, '終端側の切り替わり');
    near(Math.max(p.points[0], p.points[2]), 1000, 0, '終点');
  }
});

test('勾配: 隠れない below の屋根は輪郭全部が細線', () => {
  const roof = solid('roof', { poly: [0, 0, 2000, 0, 2000, 2000, 0, 2000] }, -2000, 0, { id: 'r', zAt: x => -2000 + x });
  const prims = fig([roof]);
  assert.equal(prims.length, 4);
  prims.forEach(p => { assert.equal(p.cls, 'below'); assert.equal(p.weight, 'thin'); });
});

test('勾配: 切断面をまたぐ立体は zAt < cutZ の部分の輪郭だけが細線（等高線なし）', () => {
  const s = solid('generic', { poly: [0, 0, 1000, 0, 1000, 1000, 0, 1000] }, -1000, 3000, { id: 's', zAt: x => 2 * x });
  const prims = fig([s]);
  nonEmpty(prims, 'prims').forEach(p => { assert.equal(p.cls, 'below'); assert.equal(p.weight, 'thin'); });
  assert.ok(prims.some(p => p.points[0] === 0 && p.points[2] === 0), 'x=0 の辺は zAt=0 なので全部出る');
  assert.ok(!prims.some(p => p.points[0] === 1000 && p.points[2] === 1000), 'x=1000 の辺は zAt=2000 ≥ cutZ で出ない');
  const horizontals = prims.filter(p => p.points[1] === p.points[3]);
  assert.equal(horizontals.length, 2);
  horizontals.forEach(p => near(Math.max(p.points[0], p.points[2]), 750, 1, 'zAt が cutZ に達する x'));
});

// ================================================================ 汎用立体・内側の線

test('generic の style.dash が伝わる。style 無し・generic 以外は dash 無し', () => {
  const dashed = fig([solid('generic', sq(0, 0, 1000, 1000), 0, 1000, { id: 'd', style: { dash: [100, 50] } })]);
  nonEmpty(dashed, 'dashed').forEach(p => assert.deepEqual(p.dash, [100, 50]));
  const plain = fig([solid('generic', sq(0, 0, 1000, 1000), 0, 1000, { id: 'p' })]);
  nonEmpty(plain, 'plain').forEach(p => assert.equal('dash' in p, false));
  const wall = fig([solid('wall', sq(0, 0, 1000, 1000), 0, 1000, { id: 'w', style: { dash: [10, 10] } })]);
  nonEmpty(wall, 'wall').forEach(p => assert.equal('dash' in p, false));
});

test('innerLines: 立体の内側の線（棟木など）も候補になり、role が source に残る', () => {
  const roof = solid('roof', { poly: [0, 0, 2000, 0, 2000, 1000, 0, 1000] }, -500, 0, {
    id: 'r', innerLines: [{ points: [0, 500, 2000, 500], role: 'ridge' }],
  });
  const prims = fig([roof]);
  const ridge = nonEmpty(prims.filter(p => p.source.role === 'ridge'), 'ridge');
  assert.deepEqual(ridge[0].points, [0, 500, 2000, 500]);
  assert.equal(prims.length, 5);
});

// ================================================================ 縮退・失敗系

test('縮退: 面積0・長さ<EPS・空入力は出さない／不正な立体は捨てる', () => {
  assert.deepEqual(fig([solid('generic', sq(0, 0, 0, 1000), 0, 1000)]), [], '幅0の矩形');
  assert.deepEqual(fig([solid('generic', { poly: [0, 0, 500, 0, 1000, 0] }, 0, 1000)]), [], '面積0の多角形');
  const thin = fig([solid('generic', sq(0, 0, 0.3, 1000), 0, 1000)]);
  assert.equal(thin.length, 2, '長さ0.3mm の辺は捨てて縦の2本だけ残る');
  // 遮蔽の残りが 0.3mm の断片になる線は捨てる（壁 x0..1000 に隠れ、梁が 1000.3 まで）
  const sliver = fig([solid('wall', sq(0, 0, 1000, 300), 0, 2400, { id: 'w' }), solid('beam', sq(0, 50, 1000.3, 100), -200, 0, { id: 'b' })]);
  assert.equal(ofId(sliver, 'b').filter(p => p.points[1] === 50 && p.points[3] === 50).length, 0, '0.3mm の断片は出さない');
  assert.ok(ofId(sliver, 'b').length > 0, '梁の他の辺は残る');
  assert.deepEqual(fig([]), []);
  assert.deepEqual(fig(undefined), []);
  assert.deepEqual(fig([null, solid('generic', sq(0, 0, 10, 10), 1000, 0), solid('generic', sq(0, 0, 10, 10), NaN, 5)]), [], 'zLo>zHi・非有限は捨てる');
  assert.deepEqual(fig([{ kind: 'generic', zLo: 0, zHi: 10, footprint: { rects: [] }, source: { kind: 'generic', id: 'e' } }]), []);
});

test('cutZ が有限でなければ TypeError（黙って空を返さない）', () => {
  for (const bad of [NaN, undefined, null, Infinity, '1500']) {
    assert.throws(() => planSectionFigure([], bad), TypeError, String(bad));
  }
});

test('入力の立体を書き換えない', () => {
  const solids = [
    solid('wall', sq(0, 0, 1000, 100), 0, 2400, { id: 'a' }),
    solid('beam', { rects: [rect(0, 0, 500, 500)], holes: [rect(100, 100, 200, 200)] }, -200, 0, { id: 'b' }),
  ];
  const before = JSON.stringify(solids);
  fig(solids);
  assert.equal(JSON.stringify(solids), before);
});

// ================================================================ 決定性

function sceneSolids() {
  return [
    solid('floor', { rects: [rect(0, 0, 2000, 4000), rect(2000, 0, 4000, 4000)], holes: [rect(1000, 1000, 2000, 2000), rect(2000, 1000, 2500, 2000)] }, 0, 0, { id: 'f0' }),
    solid('wall', sq(0, 0, 4000, 100), 0, 2400, { id: 'w1' }),
    solid('wall', sq(0, 0, 100, 4000), 0, 2400, { id: 'w2' }),
    solid('wall', sq(1500, 3000, 2500, 3100), 0, 900, { id: 'w3' }),
    solid('column', sq(3900, 3900, 4000, 4000), 0, 2400, { id: 'c1' }),
    solid('beam', sq(100, 1400, 3900, 1500), -200, 0, { id: 'b1' }),
    solid('beam', sq(1200, 1200, 1300, 1900), -200, 0, { id: 'b2' }),
    solid('roof', { poly: [4000, 0, 5000, 0, 5000, 1000, 4000, 1000] }, -500, 0, { id: 'r1', zAt: x => -500 + (x - 4000) / 2 }),
    solid('generic', sq(500, 500, 900, 900), 0, 1000, { id: 'g1', style: { dash: [100, 50] } }),
    solid('floor', sq(0, 0, 4000, 4000), -3000, -3000, { id: 'f1', layerFloorZ: -3000 }),
    solid('beam', sq(1200, 1400, 1800, 1500), -3200, -3000, { id: 'lb', layerFloorZ: -3000 }),
    solid('wall', sq(0, 0, 1000, 100), 3000, 5400, { id: 'uw', layerFloorZ: 3000 }),
  ];
}

test('決定性: 入力の順序（配列・矩形）が逆でも出力が JSON 一致。key は一意で形式どおり', () => {
  const base = sceneSolids();
  const reversed = [...sceneSolids()].reverse().map(s => (s.footprint.rects
    ? { ...s, footprint: { ...s.footprint, rects: [...s.footprint.rects].reverse(), ...(s.footprint.holes ? { holes: [...s.footprint.holes].reverse() } : {}) } }
    : s));
  const a = fig(base), b = fig(reversed);
  nonEmpty(a, 'a');
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.equal(new Set(a.map(p => p.key)).size, a.length, 'key が一意');
  a.forEach(p => assert.match(p.key, /^(cut|below):[^:]+:[^:]+:\d+$/));
});

test('key: ${cls}:${kind}:${id}:${n}（同じ立体内の連番）', () => {
  const prims = fig([solid('wall', sq(0, 0, 1000, 100), 0, 2400, { id: 'a' })]);
  assert.deepEqual(prims.map(p => p.key), ['cut:wall:a:0', 'cut:wall:a:1', 'cut:wall:a:2', 'cut:wall:a:3']);
});

test('順序: cls（cut→below）→ source.kind 固定表 → 層の FL 降順', () => {
  const prims = nonEmpty(fig(sceneSolids()), 'prims');
  const clsRank = { cut: 0, below: 1 };
  const kindRank = p => { const i = SOLID_KIND_ORDER.indexOf(p.source.kind); return i >= 0 ? i : SOLID_KIND_ORDER.length; };
  for (let i = 1; i < prims.length; i++) {
    const p = prims[i - 1], q = prims[i];
    const a = [clsRank[p.cls], kindRank(p), -(p.source.layerFloorZ ?? 0)];
    const b = [clsRank[q.cls], kindRank(q), -(q.source.layerFloorZ ?? 0)];
    const ord = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(ord <= 0, `順序違反 ${p.key} → ${q.key}`);
  }
  assert.equal(prims[0].cls, 'cut');
  assert.equal(prims.at(-1).cls, 'below');
});

// ================================================================ S5: 下屋（drawEdges・面材の同点・marks）

const ROOF_POLY = { poly: [0, 0, 4000, 0, 4000, 2000, 0, 2000] };
const arrowMark = (anchor, key = 'm:arrow:0') => ({
  anchor, prims: [
    { kind: 'arrow', key, points: [anchor.x, anchor.y, anchor.x + 900, anchor.y], head: [1, 2, 3, 4, 5, 6] },
    { kind: 'text', key: 'm:text:0', x: anchor.x, y: anchor.y + 100, text: '屋根', fontSizeMm: 200 },
  ],
});

test('S5 drawEdges:false: 輪郭は描かず innerLines だけ描く。遮蔽物としては働く（中の梁は隠れる）', () => {
  const roof = solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: false, innerLines: [{ points: [0, 1000, 4000, 1000], role: 'ridge' }] });
  const prims = fig([roof]);
  assert.deepEqual(sortedLines(prims), [[0, 1000, 4000, 1000]], '輪郭4辺は出ず、内側の線だけ');
  assert.equal(prims[0].source.role, 'ridge');
  // drawEdges 省略・true は輪郭を描く（既存の挙動）
  assert.equal(fig([solid('roof', ROOF_POLY, 0, 0, { id: 'r' })]).length, 4);
  assert.equal(fig([solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: true })]).length, 4);
  // 遮蔽は drawEdges に依らない
  const beam = solid('beam', sq(500, 500, 3500, 600), -200, 0, { id: 'b' });
  assert.equal(ofId(fig([roof, beam]), 'b').length, 0, 'drawEdges:false の roof も梁を隠す');
});

test('S5 面材の同点: roof は同じ高さの梁に勝つ。梁は roof の線を隠さない。切断の壁は roof の線を隠す', () => {
  const roof = solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: false, innerLines: [{ points: [0, 1000, 4000, 1000], role: 'ridge' }] });
  const sameTop = solid('beam', sq(500, 1500, 3500, 1600), -200, 0, { id: 'b' });
  assert.equal(ofId(fig([roof, sameTop]), 'b').length, 0, '梁の天端＝roof の天端なら roof が勝つ');
  const higher = solid('beam', sq(500, 1500, 3500, 1600), -200, 100, { id: 'b' });
  assert.equal(ofId(fig([roof, higher]), 'b').length, 4, '梁の天端が roof より高ければ梁は見える');
  const across = solid('beam', sq(1000, 800, 1100, 1200), -200, 0, { id: 'b2' });
  assert.deepEqual(sortedLines(ofId(fig([roof, across]), 'r')), [[0, 1000, 4000, 1000]], '梁（同点）は roof の棟木を隠さない');
  const wall = solid('wall', sq(1000, 800, 1200, 1200), 0, 2400, { id: 'w' });
  assert.deepEqual(sortedLines(ofId(fig([roof, wall]), 'r')), [[0, 1000, 1000, 1000], [1200, 1000, 4000, 1000]], '切断の壁の内側の区間は消える（外壁面どまりの元）');
});

test('S5 innerLines の閉路: 先頭の点を末尾へ足した折れ線は全辺が線になる（足さないと最後の辺が欠ける）', () => {
  const loop = (pts) => fig([solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: false, innerLines: [{ points: pts, role: 'outline' }] })]);
  assert.equal(loop([100, 100, 900, 100, 900, 900, 100, 900, 100, 100]).length, 4);
  assert.equal(loop([100, 100, 900, 100, 900, 900, 100, 900]).length, 3);
});

test('S5 marks: anchor が見えるときだけ prims を出す（細線・below・detailOnly・key 形式）。線は detailOnly:false', () => {
  const roof = solid('roof', ROOF_POLY, 0, 0, { id: 'r1', drawEdges: false, marks: [arrowMark({ x: 1000, y: 1000 })], innerLines: [{ points: [0, 1000, 4000, 1000], role: 'ridge' }] });
  const prims = fig([roof]);
  const marks = nonEmpty(prims.filter(p => p.kind !== 'line'), 'marks');
  assert.deepEqual(marks.map(p => p.kind), ['arrow', 'text']);
  for (const p of marks) {
    assert.equal(p.weight, 'thin');
    assert.equal(p.cls, 'below');
    assert.equal(p.detailOnly, true);
    assert.equal(p.source.kind, 'roof');
  }
  assert.deepEqual(marks.map(p => p.key), ['below:roof:r1:m:arrow:0', 'below:roof:r1:m:text:0']);
  assert.deepEqual(marks[0].points, [1000, 1000, 1900, 1000], '座標は mark のまま');
  assert.equal(marks[1].text, '屋根');
  prims.filter(p => p.kind === 'line').forEach(p => assert.equal(p.detailOnly, false));
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
});

test('S5 marks: anchor が切断の壁の面のちょうど上（境界）なら出る（境界は隠さない規則）。1mm 内側なら落ちる', () => {
  const mk = anchor => solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: false, marks: [arrowMark(anchor)] });
  const wall = solid('wall', sq(900, 900, 1000, 1100), 0, 2400, { id: 'w' }); // 東の面は x=1000
  const labelCount = prims => prims.filter(p => p.kind !== 'line').length;
  assert.equal(labelCount(fig([mk({ x: 1000, y: 1000 }), wall])), 2, '壁の面 x=1000 の上 → ラベル1件（矢印＋文字）');
  assert.equal(labelCount(fig([mk({ x: 999, y: 1000 }), wall])), 0, '壁の内側は落ちる');
});

test('S5 marks: anchor が切断の壁の内側・より高い roof の内側なら prims 全部が落ちる。外なら出る', () => {
  const mk = anchor => solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: false, marks: [arrowMark(anchor)] });
  const wall = solid('wall', sq(900, 900, 1100, 1100), 0, 2400, { id: 'w' });
  const labelCount = prims => prims.filter(p => p.kind !== 'line').length;
  assert.equal(labelCount(fig([mk({ x: 1000, y: 1000 }), wall])), 0, '壁の内側');
  assert.equal(labelCount(fig([mk({ x: 1500, y: 1000 }), wall])), 2, '壁の外');
  const taller = solid('roof', { poly: [800, 800, 1200, 800, 1200, 1200, 800, 1200] }, 0, 300, { id: 'r2', drawEdges: false });
  assert.equal(labelCount(fig([mk({ x: 1000, y: 1000 }), taller])), 0, 'より高い roof の内側');
  assert.equal(labelCount(fig([mk({ x: 1000, y: 1000 })])), 2, '遮蔽物が無ければ出る');
});

test('【失敗系】S5 marks: 不正な mark（anchor 非有限・prims 欠落・不正な prim）は捨てる。壊れた marks でも例外にしない', () => {
  const good = arrowMark({ x: 1000, y: 1000 });
  const marks = [
    { anchor: { x: NaN, y: 0 }, prims: good.prims },
    { anchor: { x: 0, y: Infinity }, prims: good.prims },
    { anchor: null, prims: good.prims },
    { anchor: { x: 500, y: 500 } },
    { anchor: { x: 500, y: 500 }, prims: [{ kind: 'arrow', key: 'a', points: [0, 0, NaN, 0], head: [1, 2] }, { kind: 'text', key: 't', x: 0, y: 0, text: 5, fontSizeMm: 200 }, { kind: 'line', key: 'l' }, null, { kind: 'text', x: 0, y: 0, text: 'x', fontSizeMm: 200 }] },
    null, 'x',
    good,
  ];
  const prims = fig([solid('roof', ROOF_POLY, 0, 0, { id: 'r', drawEdges: false, marks })]);
  assert.deepEqual(prims.filter(p => p.kind !== 'line').map(p => p.key), ['below:roof:r:m:arrow:0', 'below:roof:r:m:text:0'], '有効な mark だけ残る');
  assert.deepEqual(fig([solid('roof', ROOF_POLY, 0, 0, { id: 'r', marks: 'bad' })]).filter(p => p.kind !== 'line'), []);
});

// ================================================================ 隙間の規則（below の線だけ。cut の遮蔽物の間の狭い隙間は覗かせない）

/** 縦の壁 w1（x 0..100）と w2（x gapEnd..gapEnd+100）。どちらも y 0..1000・cut。間の隙間は 100..gapEnd。 */
const wallsWithGap = gapMm => [
  solid('wall', sq(0, 0, 100, 1000), 0, 2400, { id: 'w1' }),
  solid('wall', sq(100 + gapMm, 0, 200 + gapMm, 1000), 0, 2400, { id: 'w2' }),
];
/** y=300 の水平線だけ（向き正規化済み）。 */
const horizontalAt = (prims, id, y) => sortedLines(ofId(prims, id)).filter(l => l[1] === y && l[3] === y);

test('隙間の規則: 定数は 20。壁の角の仕上げ厚の切り欠き（12.5mm）から覗く below の梁の線は消える（壁の中・切り欠きの両側の線は従来どおり）', () => {
  assert.equal(PLAN_GAP_CLOSE_MM, 20);
  const beam = solid('beam', sq(-200, 300, 400, 400), -200, 0, { id: 'b' });
  const prims = fig([...wallsWithGap(12.5), beam]);
  assert.deepEqual(horizontalAt(prims, 'b', 300), [[-200, 300, 0, 300], [212.5, 300, 400, 300]], '切り欠き x100..112.5 の線が消える。壁の中も消える');
  assert.deepEqual(horizontalAt(prims, 'b', 400), [[-200, 400, 0, 400], [212.5, 400, 400, 400]]);
  assert.ok(nonEmpty(ofId(prims, 'b'), '梁の線').every(p => p.cls === 'below'));
});

test('隙間の規則: 閾値の境界は <=（ちょうど 20mm の隙間は隠し、20.5mm は残す）。25mm の隙間は残る', () => {
  const beam = solid('beam', sq(-200, 300, 400, 400), -200, 0, { id: 'b' });
  const at = gap => horizontalAt(fig([...wallsWithGap(gap), beam]), 'b', 300);
  assert.deepEqual(at(PLAN_GAP_CLOSE_MM), [[-200, 300, 0, 300], [220, 300, 400, 300]], 'ちょうど 20: 隠す');
  assert.deepEqual(at(PLAN_GAP_CLOSE_MM + 0.5), [[-200, 300, 0, 300], [100, 300, 120.5, 300], [220.5, 300, 400, 300]], '20.5: 残す');
  assert.deepEqual(at(25), [[-200, 300, 0, 300], [100, 300, 125, 300], [225, 300, 400, 300]], '25: 残す');
});

test('隙間の規則: 切り欠きの中に収まる短い線（端点が両側の壁の輪郭の上）は隠す。切り欠きの縁に沿う長い線は残る', () => {
  // 梁（x100..112.5 × y300..700）の上辺・下辺は長さ 12.5 の短線で、両端が w1 の右面・w2 の左面の上
  const slot = solid('beam', sq(100, 300, 112.5, 700), -200, 0, { id: 'slot' });
  const prims = fig([...wallsWithGap(12.5), slot]);
  assert.deepEqual(sortedLines(ofId(prims, 'slot')), [[100, 300, 100, 700], [112.5, 300, 112.5, 700]], '短い蓋の線 2 本だけが消える');
  // 壁が無ければ（端点が cut の輪郭の上でない）短い線も残る
  assert.equal(sortedLines(ofId(fig([slot]), 'slot')).length, 4);
});

test('隙間の規則: cut に縁取られない短線は残る（below の立体同士の間の隙間・片側だけ cut の短線）', () => {
  const beam = solid('beam', sq(-200, 300, 400, 400), -200, 0, { id: 'b' });
  // 壁が cut でなく below（天端 1000）なら、隙間 12.5mm は残る
  const lowWalls = wallsWithGap(12.5).map(w => ({ ...w, zHi: 1000 }));
  assert.deepEqual(horizontalAt(fig([...lowWalls, beam]), 'b', 300), [[-200, 300, 0, 300], [100, 300, 112.5, 300], [212.5, 300, 400, 300]], 'below 同士の間');
  // 片側だけ cut（w2 が無い）: 梁の右端が w1 の外へ 10mm だけ出た短線は、右が端点で cut の上でないので残る
  const short = solid('beam', sq(-200, 300, 110, 400), -200, 0, { id: 'short' });
  assert.deepEqual(horizontalAt(fig([wallsWithGap(12.5)[0], short]), 'short', 300), [[-200, 300, 0, 300], [100, 300, 110, 300]]);
});

test('隙間の規則: cut の線は対象外（cut の壁どうしの隙間 12.5mm の線は残る）。below の線にだけ働く', () => {
  // cut の汎用立体 s（0..2400）の線 y=300 は、cut の壁 w1・w2 の中では隠れ、切り欠きの 12.5mm は残る
  const s = solid('generic', sq(-200, 300, 400, 400), 0, 2400, { id: 's' });
  const prims = fig([...wallsWithGap(12.5), s]);
  const lines = prims.filter(p => p.source.id === 's');
  nonEmpty(lines, 's の線');
  assert.ok(lines.every(p => p.cls === 'cut'));
  assert.ok(horizontalAt(prims, 's', 300).some(l => l[0] === 100 && l[2] === 112.5), '切り欠きの 12.5mm の cut の線は残る');
});

test('隙間の規則: 切り欠きの片側が cut の2枚の壁の継ぎ目（線がちょうど継ぎ目の上）でも隠す。両側が継ぎ目の版も', () => {
  const beam = solid('beam', sq(-200, 60, 400, 400), -200, 0, { id: 'b' }); // 上辺 y=60 が A1／A2 の継ぎ目の上
  const a = [solid('wall', sq(0, 0, 100, 60), 0, 2400, { id: 'a1' }), solid('wall', sq(0, 60, 100, 1000), 0, 2400, { id: 'a2' })];
  const c = solid('wall', sq(112.5, 0, 300, 1000), 0, 2400, { id: 'c' });
  assert.deepEqual(horizontalAt(fig([...a, c, beam]), 'b', 60), [[-200, 60, 0, 60], [300, 60, 400, 60]], '左の壁が継ぎ目の上でも切り欠き 100..112.5 は消える');
  const c12 = [solid('wall', sq(112.5, 0, 300, 60), 0, 2400, { id: 'c1' }), solid('wall', sq(112.5, 60, 300, 1000), 0, 2400, { id: 'c2' })];
  assert.deepEqual(horizontalAt(fig([...a, ...c12, beam]), 'b', 60), [[-200, 60, 0, 60], [300, 60, 400, 60]], '両側が継ぎ目でも消える');
});

test('隙間の規則: 勾配のある cut（可視部分は below で出る）にも働く。cut の壁の間の 12.5mm が消える', () => {
  const s = solid('generic', sq(-200, 300, 400, 400), -1000, 3000, { id: 'sl', zAt: () => 100 }); // 切断面をまたぐが zAt<cutZ なので全域 below
  const prims = fig([...wallsWithGap(12.5), s]);
  const mine = nonEmpty(ofId(prims, 'sl'), '勾配 cut の線');
  assert.ok(mine.every(p => p.cls === 'below'), '前提: 出力は below');
  assert.deepEqual(horizontalAt(prims, 'sl', 300), [[-200, 300, 0, 300], [212.5, 300, 400, 300]]);
});

test('隙間の規則: 下階の層（窓の中）の below の線にも働く', () => {
  // 自階の床の穴（x-500..1000 × y0..1000）の窓の上に自階の cut の壁が立ち、その間の 12.5mm の隙間から下階の梁が覗く場合は消える
  const floor = solid('floor', { rects: [rect(-1000, -1000, 2000, 2000)], holes: [rect(-500, 0, 1000, 1000)] }, 0, 0, { id: 'f0', layerFloorZ: 0 });
  const lower = solid('beam', sq(-200, 300, 400, 400), -3200, -3000, { id: 'lb', layerFloorZ: -3000 });
  const prims = fig([floor, ...wallsWithGap(12.5), lower]);
  assert.deepEqual(horizontalAt(prims, 'lb', 300), [[-200, 300, 0, 300], [212.5, 300, 400, 300]]);
});
