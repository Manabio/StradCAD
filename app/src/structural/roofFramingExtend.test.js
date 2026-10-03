// 母屋・棟木・隅木の出幅ぶんの延長（描画用。ステップ D2。roofFramingGeometry.js の extendLinesToOutline・extendDiagonalsToOutline）のテスト。
// 期待値は手計算（y は下向き正）。辺は roofOutline の edges（D1）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extendLinesToOutline, extendDiagonalsToOutline, roofOutline, roofFramingLines, roofHipDiagonals,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const BOX = rc(0, 0, 9000, 6000);
const L = (isVertical, coord, lo, hi) => ({ isVertical, coord, lo, hi });
const edgesOf = (rects, shape, extra = {}) => roofOutline({
  rects, shape, ridgeIsVertical: null, highSide: null, eaveOverhangMm: 600, gableOverhangMm: 300, tolMm: TOL, ...extra,
}).edges;
const extend = (lines, edges) => extendLinesToOutline({ lines, edges, tolMm: TOL });

// ---- extendLinesToOutline ----

test('extendLinesToOutline: 切妻（棟が縦）は棟木・母屋の両端がけらば（横の辺）の出幅 300 ぶん外へ延びる。入力は変えない', () => {
  const edges = edgesOf([BOX], RoofShape.GABLE, { ridgeIsVertical: true });
  const lines = [L(true, 4500, 0, 6000), L(true, 2000, 0, 6000), L(true, 7000, 0, 6000)];
  const copy = JSON.parse(JSON.stringify(lines));
  assert.deepEqual(extend(lines, edges), [L(true, 4500, -300, 6300), L(true, 2000, -300, 6300), L(true, 7000, -300, 6300)]);
  assert.deepEqual(lines, copy, '入力は不変');
});

test('extendLinesToOutline: 切妻（棟が横）は横の棟木・母屋が縦の辺（けらば）の出幅ぶん左右へ延びる', () => {
  const edges = edgesOf([BOX], RoofShape.GABLE, { ridgeIsVertical: false, gableOverhangMm: 455 });
  assert.deepEqual(extend([L(false, 3000, 0, 9000), L(false, 1000, 0, 9000)], edges), [L(false, 3000, -455, 9455), L(false, 1000, -455, 9455)]);
});

test('extendLinesToOutline: 片流れは高い側4方向とも、母屋はけらば側の両端だけ延びる（軒に平行な方向の端）', () => {
  const horizontal = [L(false, 1000, 0, 9000), L(false, 4000, 0, 9000)]; // top/bottom: 縦の辺がけらば
  const vertical = [L(true, 1000, 0, 6000), L(true, 4000, 0, 6000)]; // left/right: 横の辺がけらば
  for (const highSide of ['top', 'bottom']) {
    assert.deepEqual(extend(horizontal, edgesOf([BOX], RoofShape.MONO, { highSide })),
      [L(false, 1000, -300, 9300), L(false, 4000, -300, 9300)], highSide);
  }
  for (const highSide of ['left', 'right']) {
    assert.deepEqual(extend(vertical, edgesOf([BOX], RoofShape.MONO, { highSide })),
      [L(true, 1000, -300, 6300), L(true, 4000, -300, 6300)], highSide);
  }
});

test('extendLinesToOutline: 寄棟（矩形・L字）の棟木・母屋は端が屋根範囲の内部なので延びない（roofFramingLines の戻り値そのまま）', () => {
  const layout = { purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL };
  const rect = roofFramingLines({ rect: BOX, shape: RoofShape.HIP, ridgeIsVertical: false, ...layout });
  assert.ok(rect.ridges.length + rect.purlins.length > 0, '前提: 線がある');
  assert.deepEqual(extend(rect.ridges, edgesOf([BOX], RoofShape.HIP)), rect.ridges);
  assert.deepEqual(extend(rect.purlins, edgesOf([BOX], RoofShape.HIP)), rect.purlins);
  const rects = [rc(0, 0, 9000, 3000), rc(0, 3000, 2000, 6000)];
  const ell = roofFramingLines({ rect: null, rects, shape: RoofShape.HIP, ...layout });
  assert.ok(ell.ridges.length + ell.purlins.length > 0, '前提: 線がある');
  assert.deepEqual(extend(ell.ridges, edgesOf(rects, RoofShape.HIP)), ell.ridges);
  assert.deepEqual(extend(ell.purlins, edgesOf(rects, RoofShape.HIP)), ell.purlins);
});

test('extendLinesToOutline: 下屋で屋内に接する辺（出幅 0）では延びない。辺の途中で出幅が変わる境目の線は小さい方（0）', () => {
  const zeroZones = [{ isVertical: true, coord: 9000, lo: 0, hi: 3000, outward: 1 }]; // 右辺の上半分が屋内に接する
  const edges = edgesOf([BOX], RoofShape.MONO, { highSide: 'top', zeroZones });
  assert.deepEqual(extend([L(false, 1000, 0, 9000), L(false, 3000, 0, 9000), L(false, 4000, 0, 9000)], edges), [
    L(false, 1000, -300, 9000), // 右端は接する部分（0）、左端は300
    L(false, 3000, -300, 9000), // 境目（接する部分の端）は小さい方
    L(false, 4000, -300, 9300),
  ]);
});

test('extendLinesToOutline: 出幅 0 の屋根は延びない。辺が null・空なら線はそのまま', () => {
  const lines = [L(true, 4500, 0, 6000)];
  assert.deepEqual(extend(lines, edgesOf([BOX], RoofShape.GABLE, { ridgeIsVertical: true, eaveOverhangMm: 0, gableOverhangMm: 0 })), lines);
  assert.deepEqual(extend(lines, null), lines);
  assert.deepEqual(extend(lines, undefined), lines);
  assert.deepEqual(extend(lines, []), lines);
});

test('【失敗系】extendLinesToOutline: 端が辺の上に無い線・辺の区間の外の線・外側の向きが逆の辺は延びない', () => {
  const edges = edgesOf([BOX], RoofShape.GABLE, { ridgeIsVertical: true });
  const inner = [L(true, 4500, 500, 5500), L(true, 12000, 0, 6000)]; // 内部で終わる線／辺の区間 [0,9000] の外
  assert.deepEqual(extend(inner, edges), inner);
  // 線の下端 (y=0) に、外側が +y（線の側）を向く辺（穴の辺のような向き）があっても延ばさない
  assert.deepEqual(extend([L(true, 100, 0, 600)], [{ ...L(false, 0, 0, 200), outward: 1, overhangMm: 300 }]), [L(true, 100, 0, 600)]);
});

test('【失敗系】extendLinesToOutline: tolMm 不正・edges が配列でない・辺の値が不正は RangeError', () => {
  const lines = [L(true, 1, 0, 2)];
  const ok = { ...L(false, 0, 0, 5), outward: -1, overhangMm: 1 };
  assert.throws(() => extendLinesToOutline({ lines, edges: [ok], tolMm: -1 }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: {}, tolMm: TOL }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: [{ ...ok, overhangMm: -1 }], tolMm: TOL }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: [{ ...ok, overhangMm: NaN }], tolMm: TOL }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: [{ ...ok, outward: 0 }], tolMm: TOL }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: [{ ...ok, isVertical: 'x' }], tolMm: TOL }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: [{ ...ok, coord: NaN }], tolMm: TOL }), RangeError);
  assert.throws(() => extendLinesToOutline({ lines, edges: [null], tolMm: TOL }), RangeError);
});

// ---- extendDiagonalsToOutline ----

const hipDiagonals = rects => roofHipDiagonals({ rect: null, rects, shape: RoofShape.HIP, tolMm: TOL });

test('extendDiagonalsToOutline: 矩形の寄棟は4隅の隅木の軒側の端が軒の出幅 600 ぶん斜め外へ延び、上端は変わらない', () => {
  const diagonals = hipDiagonals([BOX]);
  assert.deepEqual(diagonals.map(d => [d.x1, d.y1, d.x2, d.y2]), [
    [0, 0, 3000, 3000], [0, 6000, 3000, 3000], [9000, 0, 6000, 3000], [9000, 6000, 6000, 3000],
  ], '前提: 入力の隅木');
  assert.deepEqual(extendDiagonalsToOutline({ diagonals, edges: edgesOf([BOX], RoofShape.HIP), tolMm: TOL }), [
    { kind: 'hip', x1: -600, y1: -600, x2: 3000, y2: 3000 },
    { kind: 'hip', x1: -600, y1: 6600, x2: 3000, y2: 3000 },
    { kind: 'hip', x1: 9600, y1: -600, x2: 6000, y2: 3000 },
    { kind: 'hip', x1: 9600, y1: 6600, x2: 6000, y2: 3000 },
  ]);
});

test('extendDiagonalsToOutline: L字の寄棟は出隅の隅木だけ延び、谷木と隠れた出隅の隅木（軒側の端が内部）は延びない', () => {
  const rects = [rc(0, 0, 9000, 3000), rc(0, 3000, 2000, 6000)];
  const diagonals = hipDiagonals(rects);
  assert.deepEqual(diagonals.map(d => [d.kind, d.x1, d.y1]), [
    ['hip', 0, 0], ['hip', 0, 6000], ['hip', 1000, 2000], ['hip', 2000, 6000], ['hip', 9000, 0], ['hip', 9000, 3000], ['valley', 2000, 3000],
  ], '前提: 入力の斜め線（1000,2000 は隠れた出隅、谷木は入隅 2000,3000 から）');
  assert.deepEqual(extendDiagonalsToOutline({ diagonals, edges: edgesOf(rects, RoofShape.HIP), tolMm: TOL }).map(d => [d.kind, d.x1, d.y1, d.x2, d.y2]), [
    ['hip', -600, -600, 1500, 1500],
    ['hip', -600, 6600, 1000, 5000],
    ['hip', 1000, 2000, 1500, 1500], // 隠れた出隅
    ['hip', 2600, 6600, 1000, 5000],
    ['hip', 9600, -600, 7500, 1500],
    ['hip', 9600, 3600, 7500, 1500],
    ['valley', 2000, 3000, 1000, 2000], // 谷木
  ]);
});

test('extendDiagonalsToOutline: 角を作る2辺の出幅が違う（下屋の辺が屋内に接する）隅木は延ばさない。出幅が揃う側は延びる', () => {
  const zeroZones = [{ isVertical: false, coord: 0, lo: 0, hi: 9000, outward: -1 }]; // 上辺が屋内に接する
  const edges = edgesOf([BOX], RoofShape.HIP, { zeroZones });
  const diagonals = hipDiagonals([BOX]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals, edges, tolMm: TOL }).map(d => [d.x1, d.y1]), [
    [0, 0], [-600, 6600], [9000, 0], [9600, 6600],
  ]);
});

test('extendDiagonalsToOutline: 出幅 0・辺が null/空なら隅木は不変（入力も変えない）', () => {
  const diagonals = hipDiagonals([BOX]);
  const copy = JSON.parse(JSON.stringify(diagonals));
  assert.deepEqual(extendDiagonalsToOutline({ diagonals, edges: edgesOf([BOX], RoofShape.HIP, { eaveOverhangMm: 0 }), tolMm: TOL }), diagonals);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals, edges: null, tolMm: TOL }), diagonals);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals, edges: [], tolMm: TOL }), diagonals);
  assert.deepEqual(diagonals, copy);
});

test('【失敗系】extendDiagonalsToOutline: 辺が角の片方しか無い・外側の向きが逆の斜め線は延びない。tolMm 不正・edges 不正は RangeError', () => {
  const d = [{ kind: 'hip', x1: 0, y1: 0, x2: 100, y2: 100 }];
  const v = { ...L(true, 0, 0, 500), outward: -1, overhangMm: 50 };
  const h = { ...L(false, 0, 0, 500), outward: -1, overhangMm: 50 };
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: d, edges: [v], tolMm: TOL }), d);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: d, edges: [v, { ...h, outward: 1 }], tolMm: TOL }), d);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: d, edges: [v, h], tolMm: TOL }), [{ kind: 'hip', x1: -50, y1: -50, x2: 100, y2: 100 }], '前提: 両辺が揃えば延びる');
  assert.throws(() => extendDiagonalsToOutline({ diagonals: d, edges: [v, h], tolMm: NaN }), RangeError);
  assert.throws(() => extendDiagonalsToOutline({ diagonals: d, edges: 'x', tolMm: TOL }), RangeError);
  assert.throws(() => extendDiagonalsToOutline({ diagonals: d, edges: [{ ...v, overhangMm: -5 }], tolMm: TOL }), RangeError);
});
