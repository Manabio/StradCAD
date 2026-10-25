// 階段の足元の中の壁の天端（stairFootWallTop.js。planSolids.js から出力不変で移した純関数群）の単体テスト。
// フィクスチャは plan/planSolidsUnderReturnTop.test.js の EQUAL_UP（往路 x0〜1000・復路 x1000〜2000・踊り場 y0〜1000）を最小にしたもの。
// planSolids 経由の結果（壁の立体の zHi）は planSolidsUnderReturnTop.test.js が覆う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomKind } from '@core';
import { stairFootSurfaces, wallFootIntervals, wallFootTop, wallFootTopProfile, FOOT_EPS_MM } from './stairFootWallTop.js';

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
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≒ ${b}`);

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

// 壁の代替（materialRange・coord1/2・isVertical だけ。wallConcealRange が読む）。横向き＝長さ方向 x・厚み方向 y
const fakeWall = (isVertical, c1, c2, lo, hi) => ({ id: 'w', isVertical, coord1: c1, coord2: c2, materialRange: { lo, hi }, backingRange: null });

test('wallFootTopProfile: 足元の中は節の値＝3 点最小に一致・足元の外は Infinity・crossings に足元の端と段の境界が入る', () => {
  const { graph } = makeFloor();
  const surfaces = stairFootSurfaces(graph, opts);
  const [surface] = surfaces;
  // 走行方向（y）に傾く往路の矩形に、縦向き（長さ方向 y・厚み方向 x）の壁を置く。足元の両側へ 500 はみ出す
  const r = surface.footprint.rects.find(rc => rc.y2 - rc.y1 > 2000);
  assert.ok(r, '前提: 走行方向に長い矩形がある');
  const xm = (r.x1 + r.x2) / 2;
  const wall = fakeWall(true, r.y1 - 500, r.y2 + 500, xm - 57.5, xm + 57.5);
  const cr = { lo: xm - 57.5, hi: xm + 57.5 };
  const prof = wallFootTopProfile(wall, surfaces);
  assert.ok(prof && prof.footCap === true && prof.junction === true);
  const [lo, hi] = [r.y1, r.y2];
  assert.ok(prof.spans.some(([a, b]) => Math.abs(a - lo) < FOOT_EPS_MM && Math.abs(b - hi) < FOOT_EPS_MM), `区間に足元の範囲を含む（${JSON.stringify(prof.spans)}）`);
  // 節（区間の端・段の境界）での値は 3 点最小（量子化）と一致
  const min3 = a => Math.min(...[cr.lo, xm, cr.hi].map(b => surface.zAt(b, a)));
  const stepYs = surface.stepYs.filter(y => y > lo + 1e-3 && y < hi - 1e-3);
  assert.ok(stepYs.length > 0, '前提: 区間内に段の境界がある');
  for (const a of [lo, hi, stepYs[0], stepYs.at(-1)]) {
    assert.ok(Math.abs(prof.zAt(a) - min3(a)) <= 1e-6, `a=${a}: ${prof.zAt(a)} ≒ ${min3(a)}`);
  }
  assert.ok(prof.zAt((lo + hi) / 2) < FH, '足元の中は天井高より低い');
  // 足元の外
  const allLo = Math.min(...prof.spans.map(s => s[0])), allHi = Math.max(...prof.spans.map(s => s[1]));
  const outsideAt = allHi < r.y2 + 500 - 1 ? allHi + 100 : allLo - 100;
  assert.equal(prof.zAt(outsideAt), Infinity);
  // crossings: 足元の端と段の境界を含む・昇順
  const cs = prof.crossings([]);
  assert.ok(cs.some(c => Math.abs(c - lo) < 1e-3) && cs.some(c => Math.abs(c - hi) < 1e-3), '足元の端');
  assert.ok(stepYs.every(y => cs.some(c => Math.abs(c - y) < 1e-3)), '段の境界');
  assert.deepEqual(cs, [...cs].sort((a, b) => a - b));
  // z の交点: 区間内の高さを指定すると、その高さを折れ線が横切る along が足される
  const level = (prof.zAt(lo) + prof.zAt(hi)) / 2;
  assert.ok(prof.crossings([level]).some(a => a > lo && a < hi && Math.abs(prof.zAt(a) - level) < 1e-3), '交点の along で zAt が z に等しい');
});

test('wallFootTopProfile: acrossMm（厚み方向の評価点）を渡すとその位置の裏面で評価する（省略の 3 点最小より高い）／zOffsetMm は節の値から引く', () => {
  const { graph } = makeFloor();
  const surfaces = stairFootSurfaces(graph, opts);
  const [surface] = surfaces;
  // 往路（走行方向 y に傾く）の矩形に、横向き（長さ方向 x・厚み方向 y）の壁を置く＝厚み方向が傾斜の向き
  const r = surface.footprint.rects.find(rc => rc.y2 - rc.y1 > 2000);
  const ym = (r.y1 + r.y2) / 2;
  const wall = fakeWall(false, r.x1, r.x2, ym - 100, ym + 100);
  const xm = (r.x1 + r.x2) / 2;
  const [zLo, zMid, zHi] = [ym - 100, ym, ym + 100].map(b => surface.zAt(xm, b));
  assert.ok(Math.abs(zHi - zLo) > 10, `前提: 厚み方向に傾斜（${zLo}→${zHi}）`);
  const min3 = wallFootTopProfile(wall, surfaces);
  const faceA = wallFootTopProfile(wall, surfaces, { acrossMm: ym + 100 });
  const faceB = wallFootTopProfile(wall, surfaces, { acrossMm: ym - 100 });
  near(min3.zAt(xm), Math.min(zLo, zMid, zHi));
  near(faceA.zAt(xm), zHi);
  near(faceB.zAt(xm), zLo);
  const higher = zHi > zLo ? faceA : faceB; // 傾斜の高い側の縁
  assert.ok(higher.zAt(xm) - min3.zAt(xm) > 10, '面の位置の評価は（高い側の縁で）3 点最小と値が違う');
  // zOffsetMm
  near(wallFootTopProfile(wall, surfaces, { acrossMm: ym + 100, zOffsetMm: 300 }).zAt(xm), zHi - 300);
  assert.ok(wallFootTopProfile(wall, surfaces, { zOffsetMm: 300 }).crossings([]).length > 0);
});

test('wallFootTopProfile: 帯が足元の矩形の和に覆われる壁（踊り場と往路の境をまたぐ復路下の壁型）は残り、矩形の外へはみ出す壁（起点側の端の外周壁型）は除く', () => {
  const { graph } = makeFloor();
  const surfaces = stairFootSurfaces(graph, opts);
  // 往路の矩形は x 57.5..950・y 1000..4000、踊り場の矩形は x 57.5..950（左半分）・y 57.5..1000。境 y=1000 に帯 942.5..1057.5 の壁
  const straddle = fakeWall(false, 57.5, 950, 942.5, 1057.5);
  const p = wallFootTopProfile(straddle, surfaces);
  assert.ok(p, '2 つの矩形にまたがっても和で覆われる＝足元の天端が付く');
  assert.ok(p.zAt(500) < FH, '足元の中は天井高より低い');
  // 往路の起点側の端（y=4000）に立つ外周壁: 軸 3993.75 は矩形の中だが、帯 3942.5..4045 は矩形の端 4000 を越える
  const endWall = fakeWall(false, 57.5, 950, 3942.5, 4045);
  assert.ok(wallFootIntervals(endWall, { lo: 3942.5, hi: 4045 }, 57.5, 950, surfaces).length > 0, '前提: wallFootIntervals（平面と同じ）は対象にする');
  assert.equal(wallFootTopProfile(endWall, surfaces), null, '帯が矩形の外へはみ出す壁は足元の天端を持たない（壁が消える・下がるのを防ぐ）');
});

test('【失敗系】wallFootTopProfile: 軸が足元の外の壁・面 []・帯が無い壁・座標が非有限の壁は null。acrossMm が非有限なら 3 点最小。例外なし', () => {
  const { graph } = makeFloor();
  const surfaces = stairFootSurfaces(graph, opts);
  const r = surfaces[0].footprint.rects[0];
  const outside = fakeWall(false, r.x1, r.x2, r.y2 + 5000, r.y2 + 5115); // 軸が足元の厚み方向の外
  assert.equal(wallFootTopProfile(outside, surfaces), null);
  const ym = (r.y1 + r.y2) / 2;
  const inside = fakeWall(false, r.x1, r.x2, ym - 57.5, ym + 57.5);
  assert.equal(wallFootTopProfile(inside, []), null);
  assert.equal(wallFootTopProfile(inside, undefined), null);
  assert.equal(wallFootTopProfile({ ...inside, materialRange: null }, surfaces), null);
  assert.equal(wallFootTopProfile({ ...inside, coord1: NaN }, surfaces), null);
  const dflt = wallFootTopProfile(inside, surfaces);
  const nan = wallFootTopProfile(inside, surfaces, { acrossMm: NaN });
  assert.ok(dflt && nan);
  near(nan.zAt((r.x1 + r.x2) / 2), dflt.zAt((r.x1 + r.x2) / 2));
});

test('treadPolysOf を渡すと段の境界はそれから作る（省略時は stairTreadFootprints と同じ結果）', () => {
  const { graph } = makeFloor();
  const [dflt] = stairFootSurfaces(graph, opts);
  const [custom] = stairFootSurfaces(graph, { ...opts, treadPolysOf: () => [[1, 2, 3, 4, 5, 6]] });
  assert.deepEqual(custom.stepXs, [1, 3, 5]);
  assert.deepEqual(custom.stepYs, [2, 4, 6]);
  assert.ok(dflt.stepXs.length > 3, '省略時は全段の境界');
});
