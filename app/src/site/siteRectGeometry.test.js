import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RectSide, rectEdge, rectEdges, computeAttachedRect, computeOutlineSegments,
  isEdgeAttachable, computeUnionAreaM2, pickRectEdgeAnchor,
} from './siteRectGeometry.js';

const R = (id, x, y, w, h) => ({ id, x, y, w, h });

// 線分集合を向き・順序に依存せず比較できる文字列へ
const norm = (segs) => segs
  .map(s => `${s.a.x},${s.a.y}-${s.b.x},${s.b.y}`)
  .sort();

// ---- rectEdge / rectEdges ----

test('rectEdge: 4辺の端点は a=座標の小さい側（N:NW→NE / S:SW→SE / W:NW→SW / E:NE→SE）', () => {
  const r = R('r', 100, 200, 300, 400);
  assert.deepEqual(rectEdge(r, RectSide.N), { rectId: 'r', side: 'n', a: { x: 100, y: 200 }, b: { x: 400, y: 200 } });
  assert.deepEqual(rectEdge(r, RectSide.S), { rectId: 'r', side: 's', a: { x: 100, y: 600 }, b: { x: 400, y: 600 } });
  assert.deepEqual(rectEdge(r, RectSide.W), { rectId: 'r', side: 'w', a: { x: 100, y: 200 }, b: { x: 100, y: 600 } });
  assert.deepEqual(rectEdge(r, RectSide.E), { rectId: 'r', side: 'e', a: { x: 400, y: 200 }, b: { x: 400, y: 600 } });
});

test('rectEdges: 4辺を返す', () => {
  assert.equal(rectEdges(R('r', 0, 0, 10, 10)).length, 4);
});

test('【失敗系】rectEdge: 未知の辺は例外', () => {
  assert.throws(() => rectEdge(R('r', 0, 0, 10, 10), 'x'), /未知の辺/);
});

// ---- computeAttachedRect（基の長方形 (0,0) 1000x600）----

const BASE = R('b', 0, 0, 1000, 600);

test('computeAttachedRect: 北辺 基点a(NW)→NE方向へ along、外側(上)へ depth', () => {
  assert.deepEqual(computeAttachedRect(BASE, 'n', 'a', 400, 300), { x: 0, y: -300, w: 400, h: 300 });
});

test('computeAttachedRect: 北辺 基点b(NE)→NW方向へ along', () => {
  assert.deepEqual(computeAttachedRect(BASE, 'n', 'b', 400, 300), { x: 600, y: -300, w: 400, h: 300 });
});

test('computeAttachedRect: 南辺 基点a(SW)/b(SE)、外側(下)へ depth', () => {
  assert.deepEqual(computeAttachedRect(BASE, 's', 'a', 400, 300), { x: 0, y: 600, w: 400, h: 300 });
  assert.deepEqual(computeAttachedRect(BASE, 's', 'b', 400, 300), { x: 600, y: 600, w: 400, h: 300 });
});

test('computeAttachedRect: 西辺 基点a(NW)/b(SW)、外側(左)へ depth', () => {
  assert.deepEqual(computeAttachedRect(BASE, 'w', 'a', 200, 300), { x: -300, y: 0, w: 300, h: 200 });
  assert.deepEqual(computeAttachedRect(BASE, 'w', 'b', 200, 300), { x: -300, y: 400, w: 300, h: 200 });
});

test('computeAttachedRect: 東辺 基点a(NE)/b(SE)、外側(右)へ depth', () => {
  assert.deepEqual(computeAttachedRect(BASE, 'e', 'a', 200, 300), { x: 1000, y: 0, w: 300, h: 200 });
  assert.deepEqual(computeAttachedRect(BASE, 'e', 'b', 200, 300), { x: 1000, y: 400, w: 300, h: 200 });
});

test('computeAttachedRect: 辺長が共有辺より長くても基点から他端を越えて伸びる', () => {
  assert.deepEqual(computeAttachedRect(BASE, 'n', 'a', 1500, 300), { x: 0, y: -300, w: 1500, h: 300 });
  assert.deepEqual(computeAttachedRect(BASE, 'n', 'b', 1500, 300), { x: -500, y: -300, w: 1500, h: 300 });
});

test('【失敗系】computeAttachedRect: 長さが 0 以下・非有限は null', () => {
  assert.equal(computeAttachedRect(BASE, 'n', 'a', 0, 300), null);
  assert.equal(computeAttachedRect(BASE, 'n', 'a', 400, -1), null);
  assert.equal(computeAttachedRect(BASE, 'n', 'a', NaN, 300), null);
  assert.equal(computeAttachedRect(BASE, 'n', 'a', 400, Infinity), null);
});

// ---- computeOutlineSegments ----

test('computeOutlineSegments: 空なら []', () => {
  assert.deepEqual(computeOutlineSegments([]), []);
});

test('computeOutlineSegments: 長方形1個＝4辺', () => {
  const segs = computeOutlineSegments([R('a', 0, 0, 1000, 600)]);
  assert.deepEqual(norm(segs), norm([
    { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 } },
    { a: { x: 0, y: 600 }, b: { x: 1000, y: 600 } },
    { a: { x: 0, y: 0 }, b: { x: 0, y: 600 } },
    { a: { x: 1000, y: 0 }, b: { x: 1000, y: 600 } },
  ]));
});

test('computeOutlineSegments: L字（左上 1000x1000 の右下に 1000x500 を付ける）＝6辺', () => {
  const segs = computeOutlineSegments([R('a', 0, 0, 1000, 1000), R('b', 1000, 500, 1000, 500)]);
  assert.equal(segs.length, 6);
  assert.deepEqual(norm(segs), norm([
    { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 } },
    { a: { x: 1000, y: 0 }, b: { x: 1000, y: 500 } },
    { a: { x: 1000, y: 500 }, b: { x: 2000, y: 500 } },
    { a: { x: 2000, y: 500 }, b: { x: 2000, y: 1000 } },
    { a: { x: 0, y: 1000 }, b: { x: 2000, y: 1000 } },
    { a: { x: 0, y: 0 }, b: { x: 0, y: 1000 } },
  ]));
});

test('computeOutlineSegments: 同じ座標で接する2個＝共有辺が外周に出ず、同一直線の辺は結合される', () => {
  const segs = computeOutlineSegments([R('a', 0, 0, 1000, 600), R('b', 1000, 0, 1000, 600)]);
  assert.equal(segs.length, 4, '2000x600 の長方形 1 個と同じ外周');
  assert.deepEqual(norm(segs), norm([
    { a: { x: 0, y: 0 }, b: { x: 2000, y: 0 } },
    { a: { x: 0, y: 600 }, b: { x: 2000, y: 600 } },
    { a: { x: 0, y: 0 }, b: { x: 0, y: 600 } },
    { a: { x: 2000, y: 0 }, b: { x: 2000, y: 600 } },
  ]));
});

test('computeOutlineSegments: 辺の一部だけ共有＝共有していない残部が外周に残る', () => {
  // a の東辺（x=1000, y 0..1000）のうち y 0..400 だけに b が接する
  const segs = computeOutlineSegments([R('a', 0, 0, 1000, 1000), R('b', 1000, 0, 500, 400)]);
  const s = norm(segs);
  assert.ok(s.includes('1000,400-1000,1000'), '共有していない東辺の残部 y 400..1000 は外周');
  assert.ok(!s.some(t => t.startsWith('1000,0-1000,')), '共有部分 y 0..400 は外周に出ない');
});

// ---- isEdgeAttachable ----

test('isEdgeAttachable: 外周上の辺は真・完全に内側の辺は偽（接する2個の共有辺）', () => {
  const rects = [R('a', 0, 0, 1000, 600), R('b', 1000, 0, 1000, 600)];
  assert.equal(isEdgeAttachable(rects, 'a', 'n'), true);
  assert.equal(isEdgeAttachable(rects, 'a', 'e'), false, 'a の東辺は b との共有辺で内側');
  assert.equal(isEdgeAttachable(rects, 'b', 'w'), false, 'b の西辺も同じ共有辺');
});

test('isEdgeAttachable: 上下に接する2個の外周は4本で、水平の共有辺（上の南・下の北）は偽', () => {
  const rects = [R('a', 0, 0, 1000, 600), R('b', 0, 600, 1000, 600)];
  assert.equal(computeOutlineSegments(rects).length, 4);
  assert.equal(isEdgeAttachable(rects, 'a', 's'), false);
  assert.equal(isEdgeAttachable(rects, 'b', 'n'), false);
});

test('isEdgeAttachable: 辺の一部だけが共有されていれば真', () => {
  const rects = [R('a', 0, 0, 1000, 1000), R('b', 1000, 0, 500, 400)];
  assert.equal(isEdgeAttachable(rects, 'a', 'e'), true);
});

test('【失敗系】isEdgeAttachable: 存在しない rectId は偽', () => {
  assert.equal(isEdgeAttachable([R('a', 0, 0, 10, 10)], 'zzz', 'n'), false);
});

// ---- computeUnionAreaM2 ----

test('computeUnionAreaM2: 空は 0、1個は w*h/1e6', () => {
  assert.equal(computeUnionAreaM2([]), 0);
  assert.equal(computeUnionAreaM2([R('a', 0, 0, 2000, 3000)]), 6);
});

test('computeUnionAreaM2: 接する2個は和、重なりは数えない', () => {
  assert.equal(computeUnionAreaM2([R('a', 0, 0, 1000, 1000), R('b', 1000, 0, 1000, 1000)]), 2);
  // 1000x1000 が 500x1000 だけ重なる → 1 + 1 - 0.5 = 1.5
  assert.equal(computeUnionAreaM2([R('a', 0, 0, 1000, 1000), R('b', 500, 0, 1000, 1000)]), 1.5);
});

// ---- pickRectEdgeAnchor ----

test('pickRectEdgeAnchor: 画面左上原点に近い端点が基点（pickRedPointId と同じ規則）', () => {
  const vp = { worldToScreen: (x, y) => ({ x: x * 0.1, y: y * 0.1 }) };
  const edge = rectEdge(R('r', 100, 100, 1000, 600), 'n');
  assert.equal(pickRectEdgeAnchor(edge, vp), 'a');
  // 反転ビューポートでは b が原点に近い
  const flipped = { worldToScreen: (x, y) => ({ x: (2000 - x) * 0.1, y: y * 0.1 }) };
  assert.equal(pickRectEdgeAnchor(edge, flipped), 'b');
});
