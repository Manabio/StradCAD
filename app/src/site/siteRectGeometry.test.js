import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RectSide, rectEdge, rectEdges, computeAttachedRect, computeOutlineSegments,
  isEdgeAttachable, computeUnionAreaM2, pickRectEdgeAnchor,
  computeOutlinePieces, computeOutlineCorners, computeInnerEdgeSpans,
  rectNeighbors, isRectsConnected, canDeleteRect, deriveRectAttachment, canEditRect,
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

// ---- computeOutlinePieces / computeInnerEdgeSpans / computeOutlineCorners ----

const pieceKeys = (ps) => ps.map(p => `${p.rectId}:${p.side}:${p.a.x},${p.a.y}-${p.b.x},${p.b.y}`).sort();

test('computeOutlinePieces: 単独の長方形は4辺ぜんぶが外周片', () => {
  const ps = computeOutlinePieces([R('a', 0, 0, 100, 50)]);
  assert.deepEqual(pieceKeys(ps), [
    'a:e:100,0-100,50', 'a:n:0,0-100,0', 'a:s:0,50-100,50', 'a:w:0,0-0,50',
  ]);
});

test('computeOutlinePieces: 隣接する2つは共有辺が外周から消え、同一直線の片は結合しない（長方形ごと）', () => {
  const ps = computeOutlinePieces([R('a', 0, 0, 100, 50), R('b', 100, 0, 100, 50)]);
  assert.deepEqual(pieceKeys(ps), [
    'a:n:0,0-100,0', 'a:s:0,50-100,50', 'a:w:0,0-0,50',
    'b:e:200,0-200,50', 'b:n:100,0-200,0', 'b:s:100,50-200,50',
  ]);
});

test('computeOutlinePieces: 共有辺が一部だけ内側のとき、外周の部分だけが片になる', () => {
  // b は a の北辺の左半分に付く。a.n の右半分だけが外周
  const ps = computeOutlinePieces([R('a', 0, 0, 100, 50), R('b', 0, -30, 40, 30)]);
  assert.ok(pieceKeys(ps).includes('a:n:40,0-100,0'));
  assert.ok(!pieceKeys(ps).some(k => k.startsWith('a:n:0,0')), '内側の部分は片にならない');
});

test('computeOutlinePieces: 同一の片が2辺に属する（同じ辺で重なる長方形）ときは重複を除き owners に束ねる', () => {
  const ps = computeOutlinePieces([R('a', 0, 0, 100, 50), R('b', 0, 0, 100, 50)]);
  const n = ps.filter(p => p.a.y === 0 && p.b.y === 0);
  assert.equal(n.length, 1, '北辺は1片');
  assert.deepEqual(n[0].owners.map(o => `${o.rectId}:${o.side}`).sort(), ['a:n', 'b:n']);
  assert.equal(ps.length, 4);
});

test('【失敗系】computeOutlinePieces: 長方形が無ければ空', () => {
  assert.deepEqual(computeOutlinePieces([]), []);
  assert.deepEqual(computeOutlinePieces(null), []);
});

test('computeInnerEdgeSpans: 内側の辺は辺全体・一部外周の辺は外周でない残りだけ', () => {
  const rects = [R('a', 0, 0, 100, 50), R('b', 0, -30, 40, 30)];
  const spans = computeInnerEdgeSpans(rects, computeOutlinePieces(rects));
  assert.deepEqual(pieceKeys(spans), ['a:n:0,0-40,0', 'b:s:0,0-40,0']);
});

test('computeOutlinePieces: 同一直線で部分的に重なる長方形でも片は幾何的に一意（合計＝外周長）', () => {
  const rects = [R('a', 0, 0, 100, 100), R('b', 100, 0, 100, 50), R('c', 0, 100, 200, 50), R('d', 100, 50, 100, 100)];
  const ps = computeOutlinePieces(rects);
  const total = ps.reduce((s, p) => s + Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y), 0);
  assert.equal(total, 700);
  const geo = ps.map(p => `${p.a.x},${p.a.y}-${p.b.x},${p.b.y}`);
  assert.equal(new Set(geo).size, geo.length, '同じ区間の片が二重に出ない');
  const owners = (k) => ps.find(p => `${p.a.x},${p.a.y}-${p.b.x},${p.b.y}` === k).owners.map(o => `${o.rectId}:${o.side}`);
  assert.deepEqual(owners('0,150-100,150'), ['c:s']);
  assert.deepEqual(owners('100,150-200,150'), ['c:s', 'd:s']);
  assert.deepEqual(owners('200,0-200,50'), ['b:e']);
  assert.deepEqual(owners('200,50-200,100'), ['d:e']);
  assert.deepEqual(owners('200,100-200,150'), ['c:e', 'd:e']);
  assert.deepEqual(owners('0,0-100,0'), ['a:n']);
  assert.deepEqual(owners('100,0-200,0'), ['b:n']);
});

test('computeOutlineCorners: 市松（角だけ接する2つ）で接点が 1 回だけ出る', () => {
  const rects = [R('a', 0, 0, 100, 100), R('b', 100, 100, 100, 100)];
  const cs = computeOutlineCorners(computeOutlinePieces(rects));
  assert.equal(cs.filter(c => c.x === 100 && c.y === 100).length, 1);
});

test('computeOutlineCorners: 水平片と垂直片の共有端点だけを返し、同一直線の継ぎ目は除く', () => {
  const rects = [R('a', 0, 0, 100, 50), R('b', 100, 0, 100, 50)]; // 継ぎ目 x=100 は水平片どうし
  const cs = computeOutlineCorners(computeOutlinePieces(rects));
  const keys = cs.map(c => `${c.x},${c.y}`).sort();
  assert.deepEqual(keys, ['0,0', '0,50', '200,0', '200,50'], '4隅のみ。(100,0)(100,50) の継ぎ目は出ない');
});

// ---- 隣接・連結・修正/削除の自動選定 ----

test('rectNeighbors: 辺の共有・面積の重なりは隣接、角だけの接触・離れは隣接でない', () => {
  const a = R('a', 0, 0, 100, 100);
  const share = R('share', 100, 20, 50, 50);   // 辺 x=100 を正の長さで共有
  const overlap = R('overlap', 50, 50, 100, 100); // 面積が重なる
  const corner = R('corner', 100, 100, 50, 50);   // 角 (100,100) だけ
  const far = R('far', 300, 0, 10, 10);
  assert.deepEqual(rectNeighbors([a, share, overlap, corner, far], 'a').map(r => r.id), ['share', 'overlap']);
  assert.deepEqual(rectNeighbors([a], 'none'), [], '存在しない id は空');
});

test('isRectsConnected: 0・1 個は true、鎖はつながる、離れた長方形が混じれば false', () => {
  const a = R('a', 0, 0, 100, 100), b = R('b', 100, 0, 100, 100), c = R('c', 200, 0, 100, 100);
  assert.equal(isRectsConnected([]), true);
  assert.equal(isRectsConnected([a]), true);
  assert.equal(isRectsConnected([a, b, c]), true);
  assert.equal(isRectsConnected([a, c]), false, '間の B を除くと離れる');
  assert.equal(isRectsConnected([a, R('d', 100, 100, 50, 50)]), false, '角だけの接触は連結でない');
});

test('canDeleteRect: 鎖 A-B-C は両端だけ削除可（B は残りが分かれて不可）、単独は削除可', () => {
  const rects = [R('a', 0, 0, 100, 100), R('b', 100, 0, 100, 100), R('c', 200, 0, 100, 100)];
  assert.equal(canDeleteRect(rects, 'a'), true);
  assert.equal(canDeleteRect(rects, 'b'), false);
  assert.equal(canDeleteRect(rects, 'c'), true);
  assert.equal(canDeleteRect([R('x', 0, 0, 10, 10)], 'x'), true);
  assert.equal(canDeleteRect(rects, 'none'), false);
});

// 基 B(1000,1000,400x300) の各辺に、基点 a/b ごとに対象を computeAttachedRect で作り、復元して往復一致を見る
test('deriveRectAttachment: 4辺×基点 a/b の往復で computeAttachedRect が対象に一致（along/depth・side も復元）', () => {
  const base = R('base', 1000, 1000, 400, 300);
  for (const side of ['n', 'e', 's', 'w']) {
    for (const anchor of ['a', 'b']) {
      const horiz = side === 'n' || side === 's';
      const edgeLen = horiz ? base.w : base.h;
      const along = edgeLen - 100; // 辺より短い（片側の端だけ一致）
      const depth = 250;
      const g = computeAttachedRect(base, side, anchor, along, depth);
      const target = R('t', g.x, g.y, g.w, g.h);
      const d = deriveRectAttachment([base, target], 't');
      assert.ok(d, `${side}/${anchor}`);
      assert.equal(d.baseRectId, 'base');
      assert.equal(d.side, side);
      assert.equal(d.along, along);
      assert.equal(d.depth, depth);
      assert.deepEqual(d.anchors, [anchor], '片方の端だけ一致');
      for (const an of d.anchors) {
        const re = computeAttachedRect(base, d.side, an, d.along, d.depth);
        assert.deepEqual(re, { x: target.x, y: target.y, w: target.w, h: target.h });
      }
    }
  }
});

test('deriveRectAttachment: 辺と同じ長さなら両端一致（anchors が2つ）で、どちらの基点でも対象に一致', () => {
  const base = R('base', 0, 0, 400, 300);
  const target = R('t', 400, 0, 200, 300);
  const d = deriveRectAttachment([base, target], 't');
  assert.deepEqual(d.anchors, ['a', 'b']);
  assert.equal(d.side, 'e');
  for (const an of d.anchors) {
    assert.deepEqual(computeAttachedRect(base, d.side, an, d.along, d.depth), { x: 400, y: 0, w: 200, h: 300 });
  }
});

test('【失敗系】deriveRectAttachment: 基点が辺の端と一致しない・面積が重なる・隣接 2・存在しないは null', () => {
  const base = R('base', 0, 0, 400, 300);
  assert.equal(deriveRectAttachment([base, R('t', 400, 50, 100, 100)], 't'), null, '辺の中ほどに付く＝どちらの端とも不一致');
  assert.equal(deriveRectAttachment([base, R('t', 300, 100, 200, 100)], 't'), null, '面積が重なる');
  assert.equal(deriveRectAttachment([base, R('far', 900, 900, 10, 10)], 'far'), null, '隣接 0');
  assert.equal(deriveRectAttachment([base], 'none'), null);
  const mid = [R('a', 0, 0, 100, 100), R('b', 100, 0, 100, 100), R('c', 200, 0, 100, 100)];
  assert.equal(deriveRectAttachment(mid, 'b'), null, '隣接 2');
});

test('canEditRect: 角だけ接する長方形は隣接に数えない', () => {
  const a = R('a', 0, 0, 1000, 1000);
  const b = R('b', 1000, 0, 500, 500);   // A の東に付加
  const c = R('c', 1500, 500, 300, 300); // B と角 (1500,500) だけで接する
  assert.equal(canEditRect([a, b, c], 'b'), true, 'B の隣接は A だけ');
  assert.deepEqual(rectNeighbors([a, b, c], 'c'), []);
});

test('canEditRect: 隣接 0 と 隣接 1（復元可）は可、隣接 2 以上・基点不一致・存在しないは不可', () => {
  const chain = [R('a', 0, 0, 100, 100), R('b', 100, 0, 100, 100), R('c', 200, 0, 100, 100)];
  assert.equal(canEditRect(chain, 'a'), true);
  assert.equal(canEditRect(chain, 'c'), true);
  assert.equal(canEditRect(chain, 'b'), false, '隣接 2');
  assert.equal(canEditRect([R('x', 0, 0, 10, 10)], 'x'), true, '隣接 0');
  assert.equal(canEditRect([R('a', 0, 0, 400, 300), R('t', 400, 50, 100, 100)], 't'), false, '基点が復元できない');
  assert.equal(canEditRect(chain, 'none'), false);
});
