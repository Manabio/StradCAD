// 階段の足元の中の壁の天端（stairFootWallTop.js。planSolids.js から出力不変で移した純関数群）の単体テスト。
// フィクスチャは plan/planSolidsUnderReturnTop.test.js の EQUAL_UP（往路 x0〜1000・復路 x1000〜2000・踊り場 y0〜1000）を最小にしたもの。
// planSolids 経由の結果（壁の立体の zHi）は planSolidsUnderReturnTop.test.js が覆う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomKind } from '@core';
import { stairFootSurfaces, wallFootIntervals, wallFootTop, FOOT_EPS_MM } from './stairFootWallTop.js';

const FH = 2400;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

function makeFloor() {
  const graph = new PlanGraph(new Plane('p1', 0, 'p1', 0, 1));
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const cells = new Set(EQUAL_UP.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const room = graph.addRoom(new Set(cells), '階段');
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up', structure: StructuralMaterialType.STEEL });
  return { graph, stair, room };
}
const opts = { floorHeightOf: () => FH, floorZOf: () => 0 };

test('足元の中の区間の天端は 3×3 点の裏面 zAt の最小（1e-6 量子化）。足元の外は Infinity。軸が足元の外の壁は区間なし', () => {
  const { graph } = makeFloor();
  const surfaces = stairFootSurfaces(graph, opts);
  assert.ok(surfaces.length === 1, `前提: 面が 1 つ（${surfaces.length}）`);
  const [surface] = surfaces;
  assert.ok(surface.stepXs.length > 0 && surface.stepYs.length > 0, '段の境界がある');
  // 足元の矩形の 1 つに、軸が厚み方向の中央に来る横向きの壁を置く
  const r = surface.footprint.rects[0];
  const wall = { isVertical: false };
  const cr = { lo: (r.y1 + r.y2) / 2 - 57.5, hi: (r.y1 + r.y2) / 2 + 57.5 };
  // 壁の長さ方向の範囲は足元の矩形に合わせる（隣の矩形とは端の 1 点でしか接しないので区間にならない）
  const foot = wallFootIntervals(wall, cr, r.x1, r.x2, surfaces);
  assert.equal(foot.length, 1, JSON.stringify(surface.footprint.rects));
  assert.ok(Math.abs(foot[0].lo - r.x1) < FOOT_EPS_MM && Math.abs(foot[0].hi - r.x2) < FOOT_EPS_MM, '区間は足元の範囲');
  const [lo, hi] = [foot[0].lo, foot[0].hi];
  const mid = (lo + hi) / 2;
  const mids = [cr.lo, (cr.lo + cr.hi) / 2, cr.hi];
  const expected = Math.min(...[lo, mid, hi].flatMap(a => mids.map(b => (surface.zAt ? surface.zAt(a, b) : surface.zLo))));
  const top = wallFootTop(wall, cr, lo, hi, foot);
  assert.ok(Number.isFinite(top) && top < FH, `天井高より低い（${top}）`);
  assert.ok(Math.abs(top - expected) <= 1e-6, `top=${top} は 9 点の最小 ${expected} と一致`);
  // 足元の外の区間（foot に中点が入らない）は Infinity
  assert.equal(wallFootTop(wall, cr, hi + 100, hi + 200, foot), Infinity);
  assert.equal(wallFootTop(wall, cr, lo, hi, []), Infinity);
  // 軸が足元の外の壁（階段室の外周壁など）は区間なし
  const outer = { lo: r.y2 + 200, hi: r.y2 + 315 };
  assert.deepEqual(wallFootIntervals(wall, outer, r.x1, r.x2, surfaces), []);
});

test('【失敗系】階高が決まらない（floorHeightOf が null・0）→ 面 []。例外なし', () => {
  const { graph } = makeFloor();
  assert.deepEqual(stairFootSurfaces(graph, { ...opts, floorHeightOf: () => null }), []);
  assert.deepEqual(stairFootSurfaces(graph, { ...opts, floorHeightOf: () => 0 }), []);
});

test('【失敗系】屋外階段（RoomKind.EXTERIOR）→ 面 []。例外なし', () => {
  const { graph, room } = makeFloor();
  assert.ok(stairFootSurfaces(graph, opts).length === 1, '前提: 屋内なら面がある');
  room.kind = RoomKind.EXTERIOR;
  assert.deepEqual(stairFootSurfaces(graph, opts), []);
});

test('treadPolysOf を渡すと段の境界はそれから作る（省略時は stairTreadFootprints と同じ結果）', () => {
  const { graph } = makeFloor();
  const [dflt] = stairFootSurfaces(graph, opts);
  const [custom] = stairFootSurfaces(graph, { ...opts, treadPolysOf: () => [[1, 2, 3, 4, 5, 6]] });
  assert.deepEqual(custom.stepXs, [1, 3, 5]);
  assert.deepEqual(custom.stepYs, [2, 4, 6]);
  assert.ok(dflt.stepXs.length > 3, '省略時は全段の境界');
});
