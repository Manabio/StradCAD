// 屋根の外形線（軒先・けらば。ステップ D1。roofFramingGeometry.js の orthogonalBoundaryLoops・roofEdgeKind・roofOutline）のテスト。
// 期待値は手計算（y は下向き正。閉路は内側が進行方向の右＝画面で時計回り。先頭は左上の辺）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orthogonalBoundaryLoops, roofEdgeKind, roofOutline } from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const E = (isVertical, coord, lo, hi, outward, overhangMm) => ({ isVertical, coord, lo, hi, outward, overhangMm });
const outline = (rects, shape, extra = {}) => roofOutline({
  rects, shape, ridgeIsVertical: null, highSide: null, eaveOverhangMm: 600, gableOverhangMm: 300, tolMm: TOL, ...extra,
});

const BOX = rc(0, 0, 9000, 6000);

// ---- roofEdgeKind ----

test('roofEdgeKind: 寄棟は全辺が軒。切妻は棟木に平行な辺が軒（縦の棟木なら縦の辺）、棟木の端の側がけらば', () => {
  for (const isVertical of [true, false]) assert.equal(roofEdgeKind({ shape: RoofShape.HIP, isVertical }), 'eave');
  assert.equal(roofEdgeKind({ shape: RoofShape.GABLE, ridgeIsVertical: true, isVertical: true }), 'eave');
  assert.equal(roofEdgeKind({ shape: RoofShape.GABLE, ridgeIsVertical: true, isVertical: false }), 'gable');
  assert.equal(roofEdgeKind({ shape: RoofShape.GABLE, ridgeIsVertical: false, isVertical: false }), 'eave');
  assert.equal(roofEdgeKind({ shape: RoofShape.GABLE, ridgeIsVertical: false, isVertical: true }), 'gable');
});

test('roofEdgeKind: 片流れは高い側とその反対の辺が軒（top/bottom は横の辺、left/right は縦の辺）、残る2辺がけらば', () => {
  for (const [highSide, eaveIsVertical] of [['top', false], ['bottom', false], ['left', true], ['right', true]]) {
    assert.equal(roofEdgeKind({ shape: RoofShape.MONO, highSide, isVertical: eaveIsVertical }), 'eave', highSide);
    assert.equal(roofEdgeKind({ shape: RoofShape.MONO, highSide, isVertical: !eaveIsVertical }), 'gable', highSide);
  }
});

test('【失敗系】roofEdgeKind: 陸屋根・棟違い・未知の形状、切妻の向き不正、片流れの highSide 不正は RangeError', () => {
  for (const shape of [RoofShape.FLAT, RoofShape.STAGGERED, 'no-such-shape', null]) {
    assert.throws(() => roofEdgeKind({ shape, isVertical: true }), RangeError, String(shape));
  }
  assert.throws(() => roofEdgeKind({ shape: RoofShape.GABLE, ridgeIsVertical: null, isVertical: true }), RangeError);
  assert.throws(() => roofEdgeKind({ shape: RoofShape.MONO, highSide: null, isVertical: true }), RangeError);
  assert.throws(() => roofEdgeKind({ shape: RoofShape.MONO, highSide: 'up', isVertical: true }), RangeError);
});

// ---- orthogonalBoundaryLoops ----

test('orthogonalBoundaryLoops: 矩形は4辺1閉路。辺は進行順（上→右→下→左）で outward は外側の向き', () => {
  assert.deepEqual(orthogonalBoundaryLoops({ rects: [BOX], tolMm: TOL }), [[
    { isVertical: false, coord: 0, lo: 0, hi: 9000, outward: -1, dir: 1 },
    { isVertical: true, coord: 9000, lo: 0, hi: 6000, outward: 1, dir: 1 },
    { isVertical: false, coord: 6000, lo: 0, hi: 9000, outward: 1, dir: -1 },
    { isVertical: true, coord: 0, lo: 0, hi: 6000, outward: -1, dir: -1 },
  ]]);
});

test('orthogonalBoundaryLoops: 隣り合う矩形の継ぎ目は辺にならず、同一直線上の辺は併合される（L字は6辺）', () => {
  const [loop, ...rest] = orthogonalBoundaryLoops({ rects: [rc(0, 0, 4000, 3000), rc(0, 3000, 2000, 6000)], tolMm: TOL });
  assert.equal(rest.length, 0);
  assert.deepEqual(loop.map(e => [e.isVertical, e.coord, e.lo, e.hi, e.outward]), [
    [false, 0, 0, 4000, -1], [true, 4000, 0, 3000, 1], [false, 3000, 2000, 4000, 1],
    [true, 2000, 3000, 6000, 1], [false, 6000, 0, 2000, 1], [true, 0, 0, 6000, -1],
  ]);
});

test('orthogonalBoundaryLoops: 中庭の穴は別の閉路（外周＋穴）。穴の辺の outward は穴の中向き', () => {
  const ring = [rc(0, 0, 3000, 1000), rc(0, 2000, 3000, 3000), rc(0, 1000, 1000, 2000), rc(2000, 1000, 3000, 2000)];
  const loops = orthogonalBoundaryLoops({ rects: ring, tolMm: TOL });
  assert.equal(loops.length, 2);
  assert.deepEqual(loops[1].map(e => [e.isVertical, e.coord, e.lo, e.hi, e.outward]), [
    [false, 1000, 1000, 2000, 1], [true, 1000, 1000, 2000, 1], [false, 2000, 1000, 2000, -1], [true, 2000, 1000, 2000, -1],
  ]);
});

test('orthogonalBoundaryLoops: 角で斜めに接する2つの矩形でも、全周の辺がどれかの閉路に入る（長さの和＝周長）', () => {
  const loops = orthogonalBoundaryLoops({ rects: [rc(0, 0, 1000, 1000), rc(1000, 1000, 2000, 2000)], tolMm: TOL });
  const total = loops.flat().reduce((s, e) => s + (e.hi - e.lo), 0);
  assert.equal(total, 8000);
});

test('【失敗系】orthogonalBoundaryLoops: 矩形が無い・幅0は空。rects が配列でない・座標が非有限か逆順・tolMm 不正は RangeError', () => {
  assert.deepEqual(orthogonalBoundaryLoops({ rects: [], tolMm: TOL }), []);
  assert.deepEqual(orthogonalBoundaryLoops({ rects: [rc(0, 0, 0, 100)], tolMm: TOL }), []);
  assert.throws(() => orthogonalBoundaryLoops({ rects: null, tolMm: TOL }), RangeError);
  assert.throws(() => orthogonalBoundaryLoops({ rects: [rc(0, 0, NaN, 1)], tolMm: TOL }), RangeError);
  assert.throws(() => orthogonalBoundaryLoops({ rects: [rc(5, 0, 1, 1)], tolMm: TOL }), RangeError);
  assert.throws(() => orthogonalBoundaryLoops({ rects: [BOX], tolMm: -1 }), RangeError);
});

// ---- roofOutline ----

test('roofOutline: 寄棟（矩形）は全辺が軒の出幅 600 で外へ。頂点は4つ', () => {
  assert.deepEqual(outline([BOX], RoofShape.HIP), {
    edges: [
      E(false, 0, 0, 9000, -1, 600), E(true, 9000, 0, 6000, 1, 600), E(false, 6000, 0, 9000, 1, 600), E(true, 0, 0, 6000, -1, 600),
    ],
    outline: [{ points: [9600, -600, 9600, 6600, -600, 6600, -600, -600] }],
  });
});

test('roofOutline: 切妻は棟木に平行な辺が軒 600・棟木の端の辺がけらば 300。棟木の向きを変えると入れ替わる', () => {
  // 横長の棟木（横）: 横の辺＝軒（上下に 600）、縦の辺＝けらば（左右に 300）
  assert.deepEqual(outline([BOX], RoofShape.GABLE, { ridgeIsVertical: false }), {
    edges: [
      E(false, 0, 0, 9000, -1, 600), E(true, 9000, 0, 6000, 1, 300), E(false, 6000, 0, 9000, 1, 600), E(true, 0, 0, 6000, -1, 300),
    ],
    outline: [{ points: [9300, -600, 9300, 6600, -300, 6600, -300, -600] }],
  });
  // 縦の棟木: 縦の辺＝軒（左右に 600）、横の辺＝けらば（上下に 300）
  assert.deepEqual(outline([BOX], RoofShape.GABLE, { ridgeIsVertical: true }), {
    edges: [
      E(false, 0, 0, 9000, -1, 300), E(true, 9000, 0, 6000, 1, 600), E(false, 6000, 0, 9000, 1, 300), E(true, 0, 0, 6000, -1, 600),
    ],
    outline: [{ points: [9600, -300, 9600, 6300, -600, 6300, -600, -300] }],
  });
});

test('roofOutline: 片流れは高い側4方向とも、高い側と低い側が軒 600・残る2辺がけらば 300', () => {
  for (const [highSide, horizontalOverhang, verticalOverhang] of [['top', 600, 300], ['bottom', 600, 300], ['left', 300, 600], ['right', 300, 600]]) {
    assert.deepEqual(outline([BOX], RoofShape.MONO, { highSide }), {
      edges: [
        E(false, 0, 0, 9000, -1, horizontalOverhang), E(true, 9000, 0, 6000, 1, verticalOverhang),
        E(false, 6000, 0, 9000, 1, horizontalOverhang), E(true, 0, 0, 6000, -1, verticalOverhang),
      ],
      outline: [{ points: [9000 + verticalOverhang, -horizontalOverhang, 9000 + verticalOverhang, 6000 + horizontalOverhang,
        -verticalOverhang, 6000 + horizontalOverhang, -verticalOverhang, -horizontalOverhang] }],
    }, highSide);
  }
});

test('roofOutline: L字（矩形でない寄棟）は入隅も交点で結ぶ。頂点6つ・入隅は (2600,3600)', () => {
  const l = [rc(0, 0, 4000, 3000), rc(0, 3000, 2000, 6000)];
  assert.deepEqual(outline(l, RoofShape.HIP), {
    edges: [
      E(false, 0, 0, 4000, -1, 600), E(true, 4000, 0, 3000, 1, 600), E(false, 3000, 2000, 4000, 1, 600),
      E(true, 2000, 3000, 6000, 1, 600), E(false, 6000, 0, 2000, 1, 600), E(true, 0, 0, 6000, -1, 600),
    ],
    outline: [{ points: [4600, -600, 4600, 3600, 2600, 3600, 2600, 6600, -600, 6600, -600, -600] }],
  });
});

test('roofOutline: T字（矩形でない寄棟）は頂点8つ', () => {
  const t = [rc(0, 0, 6000, 2000), rc(2000, 2000, 4000, 5000)];
  assert.deepEqual(outline(t, RoofShape.HIP).outline, [{
    points: [6600, -600, 6600, 2600, 4600, 2600, 4600, 5600, 1400, 5600, 1400, 2600, -600, 2600, -600, -600],
  }]);
});

test('roofOutline: 中庭の穴は外周が外へ・穴の外形線は穴の中へ縮む（出幅 100）', () => {
  const ring = [rc(0, 0, 3000, 1000), rc(0, 2000, 3000, 3000), rc(0, 1000, 1000, 2000), rc(2000, 1000, 3000, 2000)];
  const r = outline(ring, RoofShape.HIP, { eaveOverhangMm: 100 });
  assert.deepEqual(r.outline, [
    { points: [3100, -100, 3100, 3100, -100, 3100, -100, -100] },
    { points: [1100, 1100, 1100, 1900, 1900, 1900, 1900, 1100] },
  ]);
  assert.equal(r.edges.length, 8);
});

test('roofOutline: 下屋の辺が一部だけ屋内に接する（出幅 0 の区間）と、その辺を部分に分けて段差の小辺を挿入する', () => {
  const rect = rc(0, 0, 4000, 3000);
  const zeroZones = [{ isVertical: false, coord: 3000, lo: 1000, hi: 2500, outward: 1 }];
  assert.deepEqual(outline([rect], RoofShape.HIP, { zeroZones }), {
    edges: [
      E(false, 0, 0, 4000, -1, 600), E(true, 4000, 0, 3000, 1, 600),
      E(false, 3000, 2500, 4000, 1, 600), E(false, 3000, 1000, 2500, 1, 0), E(false, 3000, 0, 1000, 1, 600),
      E(true, 0, 0, 3000, -1, 600),
    ],
    outline: [{ points: [4600, -600, 4600, 3600, 2500, 3600, 2500, 3000, 1000, 3000, 1000, 3600, -600, 3600, -600, -600] }],
  });
});

test('roofOutline: 辺の全体が屋内に接する辺は出幅 0 の1辺（段差なし）。外側の向き・直線が違う区間は無視される', () => {
  const rect = rc(0, 0, 4000, 3000);
  const whole = { isVertical: false, coord: 3000, lo: -500, hi: 4500, outward: 1 };
  const r = outline([rect], RoofShape.HIP, { zeroZones: [whole] });
  assert.deepEqual(r.outline, [{ points: [4600, -600, 4600, 3000, -600, 3000, -600, -600] }]);
  assert.deepEqual(r.edges[2], E(false, 3000, 0, 4000, 1, 0));
  const ignored = outline([rect], RoofShape.HIP, {
    zeroZones: [{ ...whole, outward: -1 }, { ...whole, coord: 2000 }, { ...whole, isVertical: true }],
  });
  assert.deepEqual(ignored.outline, outline([rect], RoofShape.HIP).outline);
});

test('roofOutline: 出幅 0 の屋根の外形線は屋根範囲そのもの', () => {
  const r = outline([rc(0, 0, 4000, 3000)], RoofShape.GABLE, { ridgeIsVertical: false, eaveOverhangMm: 0, gableOverhangMm: 0 });
  assert.deepEqual(r.outline, [{ points: [4000, 0, 4000, 3000, 0, 3000, 0, 0] }]);
});

test('【失敗系】roofOutline: 負・NaN・非有限の出幅は RangeError（軒・けらばとも）。形状が不正・rects が不正も RangeError', () => {
  for (const bad of [-1, NaN, Infinity, '600', null]) {
    assert.throws(() => outline([BOX], RoofShape.HIP, { eaveOverhangMm: bad }), RangeError, `eave ${bad}`);
    assert.throws(() => outline([BOX], RoofShape.HIP, { gableOverhangMm: bad }), RangeError, `gable ${bad}`);
  }
  assert.throws(() => outline([BOX], RoofShape.FLAT), RangeError);
  assert.throws(() => outline(null, RoofShape.HIP), RangeError);
  assert.throws(() => outline([rc(5, 0, 1, 1)], RoofShape.HIP), RangeError);
});

test('【失敗系】roofOutline: 使える矩形が無い（空・幅0）なら外形線なし', () => {
  assert.deepEqual(outline([], RoofShape.HIP), { edges: [], outline: [] });
  assert.deepEqual(outline([rc(0, 0, 0, 100)], RoofShape.HIP), { edges: [], outline: [] });
});
