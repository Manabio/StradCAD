// stairPath.js（選択順＝歩行順の確定）の単体テスト。
// フィクスチャは 2列×3行のセル格子（y下向き正）:
//   d c
//   a b
//   e f
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { resolveStairPath } from './stairPath.js';

function grid(cols, rows, cw = 1000, ch = 1000) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = Array.from({ length: cols + 1 }, (_, i) => V(i * cw));
  const ys = Array.from({ length: rows + 1 }, (_, j) => H(j * ch));
  const key = (i, j) => `${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`;
  return { graph, key };
}

// 問題の 2列×3行レイアウト（d c / a b / e f）
function layout(cw = 1000, ch = 1000) {
  const { graph, key } = grid(2, 3, cw, ch);
  return { graph, c: { d: key(0, 0), c: key(1, 0), a: key(0, 1), b: key(1, 1), e: key(0, 2), f: key(1, 2) } };
}
const run = (graph, c, order) => resolveStairPath(order.map(n => c[n]), new Set(order.map(n => c[n])), graph);

test('resolveStairPath: 2×2 a,b,c,d は U字（往路 a・回転 b,c・復路 d）、往路方向は right', () => {
  const { graph, c } = layout();
  const p = run(graph, c, ['a', 'b', 'c', 'd']);
  assert.equal(p.kind, 'uTurn');
  assert.equal(p.dir, 'right');
  assert.deepEqual(p.segments, [[c.a], [c.b, c.c], [c.d]]);
});

test('resolveStairPath: セル寸法の縦横比（1200×1000／1000×1200）に依らず同じ経路になる', () => {
  for (const [cw, ch] of [[1200, 1000], [1000, 1200]]) {
    const { graph, c } = layout(cw, ch);
    const p = run(graph, c, ['a', 'b', 'c', 'd']);
    assert.equal(p.kind, 'uTurn', `${cw}x${ch}`);
    assert.equal(p.dir, 'right', `${cw}x${ch}`);
    assert.deepEqual(p.segments, [[c.a], [c.b, c.c], [c.d]], `${cw}x${ch}`);
  }
});

test('resolveStairPath: 往路が長い f,b,c,d,a は往路 [f,b]・回転 [c,d]・復路 [a]、往路方向 up', () => {
  const { graph, c } = layout();
  const p = run(graph, c, ['f', 'b', 'c', 'd', 'a']);
  assert.equal(p.kind, 'uTurn');
  assert.equal(p.dir, 'up');
  assert.deepEqual(p.segments, [[c.f, c.b], [c.c, c.d], [c.a]]);
});

test('resolveStairPath: 復路が長い b,c,d,a,e は往路 [b]・回転 [c,d]・復路 [a,e]', () => {
  const { graph, c } = layout();
  const p = run(graph, c, ['b', 'c', 'd', 'a', 'e']);
  assert.equal(p.kind, 'uTurn');
  assert.equal(p.dir, 'up');
  assert.deepEqual(p.segments, [[c.b], [c.c, c.d], [c.a, c.e]]);
});

test('resolveStairPath: 全幅の踊り場セル1つでの 180° 反転（従来の3セル折返し）も U字', () => {
  // 2列×2行の下段2セル＋上段を1セルに統合した格子: 上段は x0..x2 の全幅
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = H(0), ym = H(1500), y1 = H(4500);
  const landing = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const left    = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const right   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const p = resolveStairPath([left, landing, right], new Set([left, landing, right]), graph);
  assert.equal(p.kind, 'uTurn');
  assert.equal(p.dir, 'up');
  assert.deepEqual(p.segments, [[left], [landing], [right]]);
});

test('resolveStairPath: 先頭の全幅セル（両レーンにまたがる踏み込み）は往路の取りつき（entryStrip=1）として往路区間に含む', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const cd = k(x0, y0, x2, y1), a = k(x0, y1, x1, y2), b = k(x1, y1, x2, y2), f = k(x0, y2, x2, y3);
  const p = resolveStairPath([f, b, cd, a], new Set([f, b, cd, a]), graph);
  assert.equal(p.kind, 'uTurn');
  assert.equal(p.dir, 'up');
  assert.equal(p.entryStrip, 1);
  assert.deepEqual(p.segments, [[f, b], [cd], [a]]);
  // 全幅セルだけで往路レーンが無い（f, cd, a）は null
  assert.equal(resolveStairPath([f, cd, a], new Set([f, cd, a]), graph), null);
});

test('resolveStairPath: 直進（e,a,d）は kind=straight・dir=up。L字（a,b,c）は lTurn・dirs=[right,up]', () => {
  const { graph, c } = layout();
  const s = run(graph, c, ['e', 'a', 'd']);
  assert.equal(s.kind, 'straight');
  assert.equal(s.dir, 'up');
  const l = run(graph, c, ['a', 'b', 'c']);
  assert.equal(l.kind, 'lTurn');
  assert.deepEqual(l.dirs, ['right', 'up']);
  assert.deepEqual(l.segments, [[c.a], [c.b], [c.c]]);
});

test('【失敗系】resolveStairPath: 非隣接（a,c,b,d）・重複・全セル未網羅・cells外キー・1セルは null', () => {
  const { graph, c } = layout();
  assert.equal(run(graph, c, ['a', 'c', 'b', 'd']), null, '非隣接');
  const cells = new Set([c.a, c.b, c.c, c.d]);
  assert.equal(resolveStairPath([c.a, c.b, c.b, c.d], cells, graph), null, '重複');
  assert.equal(resolveStairPath([c.a, c.b, c.c], cells, graph), null, '全セル未網羅');
  assert.equal(resolveStairPath([c.a, c.b, c.c, c.e], cells, graph), null, 'cells外キー');
  assert.equal(resolveStairPath([c.a], new Set([c.a]), graph), null, '1セル');
  assert.equal(resolveStairPath(null, cells, graph), null, '選択順なし');
});

test('【失敗系】resolveStairPath: S字（逆向きの90°が2回）・3回以上の折れは null（幾何推定へ）', () => {
  const { graph, key } = grid(3, 3);
  // S字: (0,2)→(1,2) right →(1,1) up →(2,1) right
  const s = [key(0, 2), key(1, 2), key(1, 1), key(2, 1)];
  assert.equal(resolveStairPath(s, new Set(s), graph), null, 'S字');
  // C字（3回折れ）: (0,2)→(1,2)→(2,2)→(2,1)→(2,0)→(1,0)→(0,0)→(0,1) ... 中空きの周回
  const cshape = [key(0, 2), key(1, 2), key(2, 2), key(2, 1), key(2, 0), key(1, 0), key(0, 0), key(0, 1)];
  assert.equal(resolveStairPath(cshape, new Set(cshape), graph), null, '3回以上');
});
