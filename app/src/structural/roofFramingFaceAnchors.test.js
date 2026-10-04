// roofFramingGeometry.js drainFaceAnchors（水下ごとの面の基準点。平面の傾斜ラベルを置く点）のテスト。
// anchor がその水下の面の内部にあることは、製品の関数を使わないテスト側の総当たり（各水下への L∞ 距離の場）で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainFaceAnchors, orthogonalBoundaryLoops, leanToWingsOf } from './roofFramingGeometry.js';

const TOL = 0.5;
const R = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const D = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
/** 屋根範囲の外周の辺（穴の辺も）＝寄棟の水下の全部。入力の用意だけに使う（検証には使わない）。 */
const boundaryDrains = rects => orthogonalBoundaryLoops({ rects, tolMm: TOL }).flat()
  .map(({ isVertical, coord, lo, hi, outward }) => ({ isVertical, coord, lo, hi, outward }));

// ---- テスト側の独立な距離場（製品の関数は使わない） ----
/** 点 p から水下 d（線分）への L∞ 距離。 */
const linfDistance = (d, p) => {
  const [across, along] = d.isVertical ? [p.x, p.y] : [p.y, p.x];
  return Math.max(Math.abs(across - d.coord), d.lo - along, along - d.hi, 0);
};
/** 屋根範囲（セル矩形の和）の内側か。セルの境目の上でもよい（4つの斜めの近傍がすべてどれかのセルの中）。 */
const insideRoof = (rects, p) => [[-1, -1], [-1, 1], [1, -1], [1, 1]].every(([sx, sy]) => {
  const x = p.x + sx; // ±1mm の4点がすべて屋根のセルの中（屋根範囲の縁・建物の出隅の上は不可）
  const y = p.y + sy;
  return rects.some(r => r.x1 < x && x < r.x2 && r.y1 < y && y < r.y2);
});

/** 全 anchor について: 屋根範囲の内側にあり、自分の水下が他のどの水下より（1mm 超）厳密に近い。 */
function assertAnchorsInsideOwnFaces(rects, anchors, label) {
  assert.ok(anchors.length > 0, `${label}: 前提: 面が1つ以上`);
  anchors.forEach((a, i) => {
    assert.ok(insideRoof(rects, a.anchor), `${label} #${i}: anchor (${a.anchor.x}, ${a.anchor.y}) が屋根範囲の中`);
    const own = linfDistance(a.drain, a.anchor);
    anchors.forEach((b, k) => {
      if (k === i) return;
      assert.ok(linfDistance(b.drain, a.anchor) > own + 1, `${label} #${i}: 水下 #${k} が自分の水下 #${i} より厳密に遠い（${linfDistance(b.drain, a.anchor)} > ${own}）`);
    });
  });
}

test('片流れ（矩形）: 水下は1本。anchor は水下の中点から内向きに奥行きの半分（流れは水下の外向き）', () => {
  const rects = [R(0, 0, 4000, 3000)];
  const anchors = drainFaceAnchors({ rects, drains: [D(false, 3000, 0, 4000, 1)], tolMm: TOL });
  assert.deepEqual(anchors, [{ drainIndex: 0, drain: D(false, 3000, 0, 4000, 1), anchor: { x: 2000, y: 1500 }, flow: 'down' }]);
  assertAnchorsInsideOwnFaces(rects, anchors, '片流れ');
  // 4方向の flow（水下の外向き。y 下向き正）
  const flows = [D(false, 0, 0, 4000, -1), D(false, 3000, 0, 4000, 1), D(true, 0, 0, 3000, -1), D(true, 4000, 0, 3000, 1)]
    .map(d => drainFaceAnchors({ rects, drains: [d], tolMm: TOL })[0].flow);
  assert.deepEqual(flows, ['up', 'down', 'left', 'right']);
});

test('切妻（矩形）: 棟と平行な2辺が水下。2つの面の anchor は棟（中心線）をはさんで両側の面の内部（奥行きの 1/4）', () => {
  const rects = [R(0, 0, 8000, 4000)];
  const anchors = drainFaceAnchors({ rects, drains: [D(false, 0, 0, 8000, -1), D(false, 4000, 0, 8000, 1)], tolMm: TOL });
  assert.equal(anchors.length, 2);
  const byFlow = Object.fromEntries(anchors.map(a => [a.flow, a.anchor]));
  assert.deepEqual(byFlow.up, { x: 4000, y: 1000 });
  assert.deepEqual(byFlow.down, { x: 4000, y: 3000 });
  assertAnchorsInsideOwnFaces(rects, anchors, '切妻');
});

test('寄棟（矩形）: 4面。各 anchor はその辺の面の内部', () => {
  const rects = [R(0, 0, 8000, 4000)];
  const anchors = drainFaceAnchors({ rects, drains: boundaryDrains(rects), tolMm: TOL });
  assert.equal(anchors.length, 4);
  assert.deepEqual(anchors.map(a => a.flow).sort(), ['down', 'left', 'right', 'up']);
  assertAnchorsInsideOwnFaces(rects, anchors, '寄棟');
  const left = anchors.find(a => a.flow === 'left');
  assert.deepEqual(left.anchor, { x: 1000, y: 2000 });
});

test('寄棟（L字）: 外周の辺ごとに1面（6面）。各 anchor は屋根範囲の中で自分の辺の面の内部', () => {
  const rects = [R(0, 0, 4000, 4000), R(4000, 0, 8000, 4000), R(0, 4000, 4000, 8000)];
  const drains = boundaryDrains(rects);
  const anchors = drainFaceAnchors({ rects, drains, tolMm: TOL });
  assert.equal(anchors.length, drains.length);
  assert.equal(anchors.length, 6);
  assertAnchorsInsideOwnFaces(rects, anchors, 'L字の寄棟');
});

test('寄棟（穴あき）: 外周4辺と穴の4辺で8面。穴の辺の面の anchor は穴の中でなく屋根範囲の中', () => {
  const rects = [R(0, 0, 3000, 3000), R(3000, 0, 6000, 3000), R(6000, 0, 9000, 3000),
    R(0, 3000, 3000, 6000), R(6000, 3000, 9000, 6000),
    R(0, 6000, 3000, 9000), R(3000, 6000, 6000, 9000), R(6000, 6000, 9000, 9000)]; // 中央 (3000..6000)² が穴
  const drains = boundaryDrains(rects);
  const anchors = drainFaceAnchors({ rects, drains, tolMm: TOL });
  assert.equal(anchors.length, 8);
  assert.ok(!insideRoof(rects, { x: 4500, y: 4500 }) && anchors.every(a => !(a.anchor.x > 3000 && a.anchor.x < 6000 && a.anchor.y > 3000 && a.anchor.y < 6000)), '穴の中に anchor が出ない');
  assertAnchorsInsideOwnFaces(rects, anchors, '穴あき');
});

test('roof-test1 型の L字の片流れ（水下が右と下の2面）: depth で止めないと建物の中へ出る形。右の面 (8190,-4942)・下の面 (5460,-1820)', () => {
  const rects = [R(7280, -9884, 9100, -3640), R(7280, -3640, 9100, 0), R(3640, -3640, 7280, 0)];
  const drains = [D(true, 9100, -9884, 0, 1), D(false, 0, 3640, 9100, 1)];
  const anchors = drainFaceAnchors({ rects, drains, tolMm: TOL });
  assert.equal(anchors.length, 2);
  const right = anchors.find(a => a.flow === 'right');
  const down = anchors.find(a => a.flow === 'down');
  assert.deepEqual(right.anchor, { x: 8190, y: -4942 }, '右へ流れる面: 奥行き 1820 の半分だけ内向き（run/2 だと (6629,-4942) で建物の中）');
  assert.ok(right.anchor.x > 7280, '建物（x≦7280）の中へ出ない');
  assert.deepEqual(down.anchor, { x: 5460, y: -1820 }, '下へ流れる面: 水下の中点でなく奥行きがとれる区間の中点（候補の中で min(run, depth) が最大）');
  assertAnchorsInsideOwnFaces(rects, anchors, 'roof-test1 型');
});

test('T-C1 奥行の違う L字（水下の中点がセルの境目に乗る）でも、基準点は屋根範囲の内部（縁・建物の出隅でない）で最寄りの水下は自分の水下', () => {
  const contacts = [D(false, 3640, 0, 3640, -1), D(true, 3640, 0, 3640, -1)]; // 上と左（建物側）の壁
  const forms = {
    '右の腕が浅い（水下の中点 y=3640 が境目）': [R(0, 3640, 5460, 7280), R(3640, 0, 5460, 3640)],
    '左右を入れ替えた形': [R(0, 3640, 3640, 5460), R(3640, 0, 7280, 5460)],
  };
  for (const [label, rects] of Object.entries(forms)) {
    const { drains } = leanToWingsOf({ rects, contacts, tolMm: TOL });
    assert.equal(drains.length, 2, `${label}: 前提: 水下が2つ`);
    assert.ok(drains.some(d => Math.abs((d.lo + d.hi) / 2 - 3640) <= TOL), `${label}: 前提: 水下の中点が境目 3640 に乗る`);
    const anchors = drainFaceAnchors({ rects, drains, tolMm: TOL });
    assert.equal(anchors.length, 2, label);
    assertAnchorsInsideOwnFaces(rects, anchors, label);
    assert.ok(!anchors.some(a => a.anchor.x === 3640 && a.anchor.y === 3640), `${label}: 建物の出隅 (3640,3640) に来ない`);
  }
  const [a, b] = Object.values(forms).map(rects => drainFaceAnchors({ rects, drains: leanToWingsOf({ rects, contacts, tolMm: TOL }).drains, tolMm: TOL }));
  assert.deepEqual(a.map(p => [p.flow, p.anchor.x, p.anchor.y]).sort(), [['down', 1820, 5460], ['right', 4550, 1820]].sort());
  assert.deepEqual(b.map(p => [p.flow, p.anchor.x, p.anchor.y]).sort(), [['down', 1820, 4550], ['right', 5460, 1820]].sort());
});

test('水下が段違い（同じ壁・奥行きの違う2つの下屋）: 水下ごとに1面。各 anchor は自分の水下の面の内部', () => {
  const rects = [R(0, 0, 4000, 2000), R(4000, 0, 8000, 4000)];
  const drains = [D(false, 2000, 0, 4000, 1), D(false, 4000, 4000, 8000, 1)];
  const anchors = drainFaceAnchors({ rects, drains, tolMm: TOL });
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map(a => a.drainIndex), [0, 1]);
  const deep = anchors.find(a => a.drain.coord === 4000);
  const shallow = anchors.find(a => a.drain.coord === 2000);
  assert.deepEqual(deep.anchor, { x: 6000, y: 3000 });
  assert.deepEqual(shallow.anchor, { x: 2000, y: 1000 });
  assertAnchorsInsideOwnFaces(rects, anchors, '段違い');
});

test('drainIndex は mergeDrainEdges 後の水下の並び（長さの大きい順）。同じ直線で接する水下は1つにまとめる', () => {
  const rects = [R(0, 0, 8000, 3000)];
  const anchors = drainFaceAnchors({ rects, drains: [D(false, 3000, 0, 2000, 1), D(false, 3000, 2000, 8000, 1)], tolMm: TOL });
  assert.equal(anchors.length, 1, '同じ直線で接する2つは1面');
  assert.deepEqual(anchors[0].drain, D(false, 3000, 0, 8000, 1));
  const two = drainFaceAnchors({ rects: [R(0, 0, 8000, 3000)], drains: [D(false, 0, 0, 2000, -1), D(false, 3000, 0, 8000, 1)], tolMm: TOL });
  assert.deepEqual(two.map(a => a.drain.hi - a.drain.lo), [8000, 2000], '長さの大きい順');
  assert.deepEqual(two.map(a => a.drainIndex), [0, 1]);
});

test('【失敗系】drainFaceAnchors: 水下が空・屋根範囲が空は []。許容差が負・水下の値が不正・rects が配列でないは RangeError', () => {
  assert.deepEqual(drainFaceAnchors({ rects: [R(0, 0, 100, 100)], drains: [], tolMm: TOL }), []);
  assert.deepEqual(drainFaceAnchors({ rects: [], drains: [D(false, 100, 0, 100, 1)], tolMm: TOL }), []);
  assert.throws(() => drainFaceAnchors({ rects: [R(0, 0, 100, 100)], drains: [], tolMm: -1 }), RangeError);
  assert.throws(() => drainFaceAnchors({ rects: [R(0, 0, 100, 100)], drains: [D(false, 100, 0, 100, 0)], tolMm: TOL }), RangeError);
  assert.throws(() => drainFaceAnchors({ rects: [R(0, 0, 100, 100)], drains: null, tolMm: TOL }), RangeError);
  assert.throws(() => drainFaceAnchors({ rects: null, drains: [D(false, 100, 0, 100, 1)], tolMm: TOL }), RangeError);
});
