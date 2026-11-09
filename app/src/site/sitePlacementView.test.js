// 敷地の配置図（site/sitePlacementView.js）の純モジュールのテスト。
// 屋根の region は roofPlanRegionFigure が受け付ける最小の形（exposedPaths＋outlineOnly＝外形線だけ）で作る。
// 実際の下屋・主屋根の region（leanToPlanRegions・topRoofPlanRegions）を通す経路は modes/SiteModeState.placement.test.js が見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { SitePlacementCenterSource } from '../core/constants.js';
import {
  roofPlanLines, siteOutlineSegments, siteOutlineCorners, boundsOfPointLists,
  composeSitePlacementView,
  samePlacementVertex, placementVertexIndex,
} from './sitePlacementView.js';
import { applySiteTransform, siteTransformGroupProps } from './siteTransform.js';
import { SITE_PLACEMENT_VERTEX_EPS_MM } from '../core/constants.js';

/** 矩形の外形線だけの region（閉路1本）。 */
const rectRegion = (key, x0, y0, x1, y1) => ({
  key, outlineOnly: true,
  exposedPaths: [{ points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true }],
});

/** 三斜の四角形 A(0,0) B(10000,0) C(10000,8000) D(0,8000)＋対角線 BD（内側の線）。外周4本・角4つ・図芯 (5000,4000)。 */
function makeQuadSite() {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(10000, 0), C = site.addPoint(10000, 8000), D = site.addPoint(0, 8000);
  const ab = site.addLine(A, B);
  const da = site.addLine(D, A);
  const bd = site.addLine(B, D);
  const bc = site.addLine(B, C);
  const cd = site.addLine(C, D);
  site.addTriangle(ab, D); // AB 底辺・頂点 D → AB・DA・BD
  site.addTriangle(bc, D); // BC 底辺・頂点 D → BC・CD・BD（BD が2三角形に属して内側）
  return { site, ids: { ab, da, bd, bc, cd } };
}

// ---- 屋根の線 ----

test('roofPlanLines: 全 region の線を集め、key は planeId/region.key/index（階が違えば同じ region.key でも別）', () => {
  const floors = [
    { planeId: 'p1', regions: [rectRegion('r', 0, 0, 3000, 1000)] },
    { planeId: 'p2', regions: [rectRegion('r', 0, 0, 6000, 4000), { key: 'two', outlineOnly: true,
      exposedPaths: [{ points: [0, 0, 100, 0], closed: false }, { points: [0, 10, 100, 10], closed: false }] }] },
  ];
  const { lines, failedCount } = roofPlanLines(floors);
  assert.equal(failedCount, 0);
  assert.deepEqual(lines.map(l => l.key), ['p1/r/0', 'p2/r/0', 'p2/two/0', 'p2/two/1']);
  assert.equal(lines[0].closed, true);
  assert.equal(lines[2].closed, false);
  assert.deepEqual(lines[1].points, [0, 0, 6000, 0, 6000, 4000, 0, 4000]);
  assert.ok(!('role' in lines[0]), 'role は捨てる（全部同じ細線）');
});

test('roofPlanLines: region が空の階があっても残りの階で描く', () => {
  const { lines, failedCount } = roofPlanLines([
    { planeId: 'p1', regions: [] },
    { planeId: 'p2', regions: [rectRegion('r', 0, 0, 1000, 1000)] },
    { planeId: 'p3', regions: [] },
  ]);
  assert.equal(failedCount, 0);
  assert.deepEqual(lines.map(l => l.key), ['p2/r/0']);
});

test('【失敗系】roofPlanLines: 例外を投げる region は failedCount に数え、他の region は描く', () => {
  const bad = { key: 'bad', get exposedPaths() { throw new Error('壊れた region'); } };
  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = roofPlanLines([{ planeId: 'p1', regions: [rectRegion('a', 0, 0, 1000, 1000), bad, rectRegion('b', 0, 0, 2000, 2000)] }]);
  } finally { console.warn = warn; }
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.lines.map(l => l.key), ['p1/a/0', 'p1/b/0']);
});

// ---- 敷地の外周 ----

test('siteOutlineSegments / siteOutlineCorners: 三斜は外周だけ（内側の対角線は出さない）・角は外周が2本集まる点', () => {
  const { site, ids } = makeQuadSite();
  const segs = siteOutlineSegments(site);
  assert.equal(segs.length, 4, '外周4本（対角線 BD は内側）');
  assert.ok(!segs.some(s => s.key === `l/${ids.bd.id}`));
  assert.equal(siteOutlineCorners(site).length, 4);
});

test('siteOutlineSegments / siteOutlineCorners: 三斜＋長方形の混在は、三斜の外周と長方形の外周片の両方が出る（長方形の内側の辺は出ない）', () => {
  const { site } = makeQuadSite();
  site.addRect(20000, 0, 3000, 2000);
  site.addRect(23000, 0, 1000, 2000); // 先の長方形の東に隣接 → 共有辺は内側
  const segs = siteOutlineSegments(site);
  const rectSegs = segs.filter(s => s.key.startsWith('r/'));
  const total = rectSegs.reduce((a, s) => a + Math.hypot(s.points[2] - s.points[0], s.points[3] - s.points[1]), 0);
  assert.equal(segs.length - rectSegs.length, 4);
  assert.equal(total, 2 * (4000 + 2000), '2枚の長方形の和集合（4000×2000）の外周長');
  assert.equal(siteOutlineCorners(site).length, 4 + 4);
});

test('siteOutlineSegments / siteOutlineCorners: 空の敷地は []', () => {
  const site = new Site();
  assert.deepEqual(siteOutlineSegments(site), []);
  assert.deepEqual(siteOutlineCorners(site), []);
});

test('boundsOfPointLists: 外接矩形。点が無ければ null', () => {
  // 1本目は (10,20)・(−5,7) の2点、2本目 [3,40] は (3,40) の1点
  assert.deepEqual(boundsOfPointLists([[10, 20, -5, 7], [3, 40]]), { minX: -5, minY: 7, maxX: 10, maxY: 40 });
  assert.equal(boundsOfPointLists([]), null);
  assert.equal(boundsOfPointLists([[]]), null);
});

// ---- 図芯合わせ ----

/** 原点から離した屋根（外接矩形 x 50000..56000・y 30000..34000 → 図芯 (53000,32000)）。 */
const farRoof = () => ({
  floors: [
    { planeId: 'p1', regions: [rectRegion('lt', 50000, 30000, 52000, 32000)] },
    { planeId: 'p2', regions: [rectRegion('top', 51000, 31000, 56000, 34000)] },
  ],
  gridBounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
  readFailed: false,
});

test('composeSitePlacementView: 屋根の外接矩形の図芯へ敷地の図芯を重ねる（平行移動。敷地の図芯 (5000,4000)→(53000,32000)）', () => {
  const { site } = makeQuadSite();
  const v = composeSitePlacementView({ site, roof: farRoof() });
  assert.equal(v.centerSource, SitePlacementCenterSource.ROOF);
  assert.deepEqual(v.buildingCenter, { x: 53000, y: 32000 });
  assert.deepEqual(v.siteCenter, { x: 5000, y: 4000 });
  assert.equal(v.siteTransform.tx, 48000);
  assert.equal(v.siteTransform.ty, 28000);
  assert.equal(v.siteTransform.rotationDeg, 0);
  assert.deepEqual(applySiteTransform(v.siteCenter, v.siteTransform), v.buildingCenter);
  // 敷地の角 A(0,0) も同じ平行移動で動く
  assert.deepEqual(applySiteTransform({ x: 0, y: 0 }, v.siteTransform), { x: 48000, y: 28000 });
  assert.equal(v.roofLines.length, 2);
  assert.equal(v.roofEmpty, false);
  assert.equal(v.roofFailedCount, 0);
});

test('composeSitePlacementView: 屋根の線が無ければ通り芯の範囲の中心（GRID）。屋根も通り芯も無ければ合わせない（NONE・dx=dy=0）', () => {
  const { site } = makeQuadSite();
  const grid = composeSitePlacementView({ site, roof: { floors: [], gridBounds: { minX: 1000, minY: 2000, maxX: 9000, maxY: 6000 }, readFailed: false } });
  assert.equal(grid.centerSource, SitePlacementCenterSource.GRID);
  assert.deepEqual(grid.buildingCenter, { x: 5000, y: 4000 });
  assert.equal(grid.roofEmpty, true);
  assert.deepEqual([grid.siteTransform.tx, grid.siteTransform.ty], [0, 0], '図芯が一致しているので移動量は 0');
  const grid2 = composeSitePlacementView({ site, roof: { floors: [], gridBounds: { minX: 10000, minY: 10000, maxX: 12000, maxY: 12000 }, readFailed: false } });
  assert.deepEqual([grid2.siteTransform.tx, grid2.siteTransform.ty], [6000, 7000]);

  for (const roof of [{ floors: [], gridBounds: null, readFailed: false }, null]) {
    const none = composeSitePlacementView({ site, roof });
    assert.equal(none.centerSource, SitePlacementCenterSource.NONE);
    assert.equal(none.buildingCenter, null);
    assert.deepEqual(none.siteTransform, { rotationDeg: 0, tx: 0, ty: 0 });
    assert.equal(none.roofEmpty, true);
  }
});

test('composeSitePlacementView: boundaryPieces（敷地座標・結合済み）を戻す。同種で隣り合う長方形の北辺は1片、空の敷地は []', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 3000, 'r1');
  site.addRect(4000, 0, 3000, 3000, 'r2');
  const v = composeSitePlacementView({ site, roof: farRoof() });
  const north = v.boundaryPieces.filter(p => p.a.y === 0 && p.b.y === 0);
  assert.equal(north.length, 1);
  assert.deepEqual([north[0].a.x, north[0].b.x, north[0].road], [0, 7000, false]);
  assert.deepEqual(composeSitePlacementView({ site: new Site(), roof: farRoof() }).boundaryPieces, []);
});

test('【失敗系】composeSitePlacementView: 敷地が空なら敷地側の図芯が無く、tx=ty=0。屋根は描く', () => {
  const v = composeSitePlacementView({ site: new Site(), roof: farRoof() });
  assert.equal(v.siteCenter, null);
  assert.deepEqual(v.siteSegments, []);
  assert.deepEqual(v.siteTransform, { rotationDeg: 0, tx: 0, ty: 0 });
  assert.equal(v.placed, false);
  assert.equal(v.roofLines.length, 2);
});

test('【失敗系】composeSitePlacementView: 壊れた region は roofFailedCount に載り、残りで図芯合わせする', () => {
  const { site } = makeQuadSite();
  const roof = farRoof();
  roof.floors[1].regions.push({ key: 'bad', get exposedPaths() { throw new Error('x'); } });
  const warn = console.warn;
  console.warn = () => {};
  let v;
  try { v = composeSitePlacementView({ site, roof }); } finally { console.warn = warn; }
  assert.equal(v.roofFailedCount, 1);
  assert.equal(v.roofLines.length, 2);
  assert.equal(v.centerSource, SitePlacementCenterSource.ROOF);
});

// ---- 変換の口 ----

test('siteTransformGroupProps: Konva の Group（x,y 平行移動 → rotation）の写像が applySiteTransform と一致する（0°・90°・30°）。props は {x,y,rotation} だけ', () => {
  for (const rotationDeg of [0, 90, 30]) {
    const t = { rotationDeg, tx: 700, ty: -300 };
    const g = siteTransformGroupProps(t);
    const rad = rotationDeg * Math.PI / 180;
    // Konva の変換: p' = (x,y) + R(rotation)·p
    const konva = p => ({
      x: g.x + Math.cos(rad) * p.x - Math.sin(rad) * p.y,
      y: g.y + Math.sin(rad) * p.x + Math.cos(rad) * p.y,
    });
    assert.deepEqual(Object.keys(g).sort(), ['rotation', 'x', 'y']);
    assert.deepEqual([g.x, g.y, g.rotation], [700, -300, rotationDeg]);
    for (const p of [{ x: 0, y: 0 }, { x: 5000, y: 4000 }, { x: 10000, y: 8000 }]) {
      const a = applySiteTransform(p, t), b = konva(p);
      assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, `${rotationDeg}° ${JSON.stringify(p)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
});

test('applySiteTransform: 90° 回転は原点まわり（原点は (tx,ty) へ、(500,0) は原点の下 (tx, ty+500) へ。y 下向き正）', () => {
  const t = { rotationDeg: 90, tx: 100, ty: 200 };
  const c = applySiteTransform({ x: 0, y: 0 }, t);
  assert.deepEqual([c.x, c.y], [100, 200]);
  const r = applySiteTransform({ x: 500, y: 0 }, t);
  assert.ok(Math.abs(r.x - 100) < 1e-9 && Math.abs(r.y - 700) < 1e-9, JSON.stringify(r));
  const d = applySiteTransform({ x: 0, y: 500 }, t);
  assert.ok(Math.abs(d.x - (-400)) < 1e-9 && Math.abs(d.y - 200) < 1e-9, JSON.stringify(d));
});

// ---- 配置の指定（site.placement） ----

test('composeSitePlacementView: site.placement があればその {rotationDeg,tx,ty} を使い placed:true（図芯合わせは使わない）。無ければ placed:false', () => {
  const { site } = makeQuadSite();
  assert.equal(composeSitePlacementView({ site, roof: farRoof() }).placed, false);
  const input = { v1: { x: 0, y: 0 }, v2: { x: 10000, y: 0 }, centerLineId: 'c1', distance: 3000, rotationFlipped: false, sideFlipped: false };
  site.setPlacement({ rotationDeg: 30, tx: 1234, ty: -567, input });
  const v = composeSitePlacementView({ site, roof: farRoof() });
  assert.equal(v.placed, true);
  assert.deepEqual(v.siteTransform, { rotationDeg: 30, tx: 1234, ty: -567 });
  // 図芯合わせの情報自体は従来どおり返る
  assert.deepEqual(v.buildingCenter, { x: 53000, y: 32000 });
});

test('【失敗系】composeSitePlacementView: placement があれば敷地が空・屋根なしでも変換は placement のまま（placed:true）', () => {
  const site = new Site();
  site.setPlacement({ rotationDeg: -90, tx: 10, ty: 20, input: { v1: { x: 0, y: 0 }, v2: { x: 1, y: 0 }, centerLineId: 'c', distance: 1, rotationFlipped: true, sideFlipped: true } });
  const v = composeSitePlacementView({ site, roof: null });
  assert.equal(v.placed, true);
  assert.deepEqual(v.siteTransform, { rotationDeg: -90, tx: 10, ty: 20 });
});

test('samePlacementVertex: EPS 以内は同じ角（境界を含む）、超えると別の角。x・y どちらが外れても別', () => {
  const a = { x: 100, y: 200 };
  assert.equal(samePlacementVertex(a, { x: 100, y: 200 }), true);
  assert.equal(samePlacementVertex(a, { x: 100 + SITE_PLACEMENT_VERTEX_EPS_MM, y: 200 }), true, '境界は同じ角');
  assert.equal(samePlacementVertex(a, { x: 100 + SITE_PLACEMENT_VERTEX_EPS_MM * 2, y: 200 }), false);
  assert.equal(samePlacementVertex(a, { x: 100, y: 200 - SITE_PLACEMENT_VERTEX_EPS_MM * 2 }), false);
});

test('【失敗系】samePlacementVertex: どちらかが null／undefined なら false（両方 null でも false）', () => {
  const a = { x: 0, y: 0 };
  assert.equal(samePlacementVertex(null, a), false);
  assert.equal(samePlacementVertex(a, undefined), false);
  assert.equal(samePlacementVertex(null, null), false);
});

test('placementVertexIndex: v1 なら 1・v2 なら 2・どちらでもなければ null。input が null でも null。両方同じ点なら v1 を優先', () => {
  const input = { v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 } };
  assert.equal(placementVertexIndex(input, { x: 1, y: 2 }), 1);
  assert.equal(placementVertexIndex(input, { x: 3, y: 4 }), 2);
  assert.equal(placementVertexIndex(input, { x: 5, y: 6 }), null);
  assert.equal(placementVertexIndex(null, { x: 1, y: 2 }), null);
  assert.equal(placementVertexIndex({ v1: null, v2: { x: 3, y: 4 } }, { x: 3, y: 4 }), 2, 'v1 が空なら v2 だけを見る');
  assert.equal(placementVertexIndex({ v1: { x: 1, y: 1 }, v2: { x: 1, y: 1 } }, { x: 1, y: 1 }), 1);
});
