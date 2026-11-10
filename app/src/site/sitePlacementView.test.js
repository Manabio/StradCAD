// 敷地の配置図（site/sitePlacementView.js）の純モジュールのテスト。
// 屋根の region は roofPlanRegionFigure が受け付ける最小の形（exposedPaths＋outlineOnly＝外形線だけ）で作る。
// 実際の下屋・主屋根の region（leanToPlanRegions・topRoofPlanRegions）を通す経路は modes/SiteModeState.placement.test.js が見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { SitePlacementCenterSource } from '../core/constants.js';
import {
  roofPlanLines, siteOutlineSegments, siteOutlineCorners, boundsOfPointLists, placeSiteSegments,
  composeSitePlacementView,
  samePlacementVertex, placementVertexIndex,
  placementAlongVertexIndex, placementVertexLabels, placementVertexLabelText,
  placementVertexColorKind, PlacementVertexColorKind,
} from './sitePlacementView.js';
import { alongSharedVertex } from './sitePlacementVertex.js';
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

// ---- 屋根の重なり（S12）: 下屋の線を上の屋根の軒先線で止める ----

/** rectRegion に軒先線（outline＝閉路 1 本）を付けた region。 */
const withOutline = (region, x0, y0, x1, y1) => ({ ...region, outline: [{ points: [x0, y0, x1, y0, x1, y1, x0, y1] }] });
const mainRegion = (x0, y0, x1, y1) => withOutline(rectRegion('main', x0, y0, x1, y1), x0, y0, x1, y1);
const leanRegion = (id, x0, y0, x1, y1) => withOutline(rectRegion(`lean:${id}`, x0, y0, x1, y1), x0, y0, x1, y1);

test('roofPlanLines: 主屋根の軒先線の内側にかかる下屋の線は軒先で止まる（主屋根 0..4000×0..3000・下屋 −1000..3000×1000..2000）', () => {
  const { lines, rawLines } = roofPlanLines([
    { planeId: 'p1', order: 1, regions: [leanRegion('a', -1000, 1000, 3000, 2000)] },
    { planeId: 'p2', order: 2, regions: [mainRegion(0, 0, 4000, 3000)] },
  ]);
  // 下屋の閉じた外形は主屋根の内側（x 0..3000）が隠れ、始点 (−1000,1000) をまたぐ 1 本 [0,2000]→[−1000,2000]→[−1000,1000]→[0,1000] だけ残る
  assert.deepEqual(lines.filter(l => l.key.startsWith('p1/')).map(l => ({ key: l.key, points: l.points, closed: l.closed })), [
    { key: 'p1/lean:a/0', points: [0, 2000, -1000, 2000, -1000, 1000, 0, 1000], closed: false },
  ]);
  assert.equal(rawLines.filter(l => l.key.startsWith('p1/'))[0].closed, true, '切る前は閉じた外形のまま');
});

test('roofPlanLines: 主屋根・屋根区画の線は切らない（下屋と重なっても不変）', () => {
  const main = mainRegion(0, 0, 4000, 3000);
  // 区画は主屋根の東に隣接（4000..6000）。下屋 −1000..5000×1000..2000 は主屋根と区画の両方にまたがる（x 0..5000 が隠れる）
  const zone = withOutline(rectRegion('zone:z1', 4000, 0, 6000, 3000), 4000, 0, 6000, 3000);
  const { lines } = roofPlanLines([
    { planeId: 'p1', order: 1, regions: [leanRegion('a', -1000, 1000, 5000, 2000)] },
    { planeId: 'p2', order: 2, regions: [zone, main] },
  ]);
  const top = lines.filter(l => l.key.startsWith('p2/'));
  assert.deepEqual(top.map(l => [l.key, l.points, l.closed]), [
    ['p2/zone:z1/0', [4000, 0, 6000, 0, 6000, 3000, 4000, 3000], true],
    ['p2/main/0', [0, 0, 4000, 0, 4000, 3000, 0, 3000], true],
  ]);
  assert.deepEqual(lines.filter(l => l.key.startsWith('p1/')).map(l => [l.points, l.closed]), [
    [[0, 2000, -1000, 2000, -1000, 1000, 0, 1000], false],
  ]);
});

test('roofPlanLines: 3 階建て。1F 下屋が 2F 下屋と 3F 主屋根の両方に重なる区間（x 0..1500）は残らない（隠す側は和集合で偶奇に打ち消されない）', () => {
  const { lines } = roofPlanLines([
    { planeId: 'p1', order: 1, regions: [leanRegion('a', -1000, 1000, 3000, 2000)] },
    { planeId: 'p2', order: 2, regions: [leanRegion('b', -500, 500, 1500, 2500)] },
    { planeId: 'p3', order: 3, regions: [mainRegion(0, 0, 4000, 3000)] },
  ]);
  // a の閉じた外形のうち x −500..3000 は b か主屋根の内側。残るのは x −1000..−500 の部分だけ（始点をまたいで 1 本）
  assert.deepEqual(lines.filter(l => l.key.startsWith('p1/')).map(l => [l.points, l.closed]), [
    [[-500, 2000, -1000, 2000, -1000, 1000, -500, 1000], false],
  ]);
});

test('roofPlanLines: 上の階の下屋が下の階の下屋を隠す。下屋 a（下階 0..2000×0..1000）は b（上階 1000..3000×−500..1500）の軒先で止まり、b は不変', () => {
  const { lines } = roofPlanLines([
    { planeId: 'p1', order: 1, regions: [leanRegion('a', 0, 0, 2000, 1000)] },
    { planeId: 'p2', order: 2, regions: [leanRegion('b', 1000, -500, 3000, 1500)] },
  ]);
  assert.deepEqual(lines.find(l => l.key.startsWith('p1/')).points, [1000, 1000, 0, 1000, 0, 0, 1000, 0]);
  assert.deepEqual(lines.filter(l => l.key.startsWith('p2/')).map(l => [l.points, l.closed]), [
    [[1000, -500, 3000, -500, 3000, 1500, 1000, 1500], true],
  ]);
});

test('roofPlanLines: 同じ階の下屋どうし・order が無い階どうしは切らない', () => {
  const a = leanRegion('a', 0, 0, 2000, 1000);
  const b = leanRegion('b', 1000, -500, 3000, 1500);
  const same = roofPlanLines([{ planeId: 'p1', order: 1, regions: [a, b] }]);
  assert.deepEqual(same.lines.map(l => [l.points, l.closed]), [
    [[0, 0, 2000, 0, 2000, 1000, 0, 1000], true],
    [[1000, -500, 3000, -500, 3000, 1500, 1000, 1500], true],
  ]);
  // 上の階の下屋が下の階を隠す向きだけ。逆（下の階の下屋は上の階を隠さない）は上の検証で b 不変として確認済み
  const noOrder = roofPlanLines([{ planeId: 'p1', regions: [a] }, { planeId: 'p2', regions: [b] }]);
  assert.equal(noOrder.lines.length, 2, 'order が無ければ下屋どうしは切らない');
  assert.equal(noOrder.lines[0].closed, true);
});

test('roofPlanLines: 主屋根が無ければ下屋は上の階の下屋にだけ切られる（主屋根の (a) は効かない）', () => {
  const { lines } = roofPlanLines([{ planeId: 'p1', order: 1, regions: [leanRegion('a', -1000, 1000, 3000, 2000)] }]);
  assert.deepEqual(lines.map(l => [l.points, l.closed]), [[[-1000, 1000, 3000, 1000, 3000, 2000, -1000, 2000], true]]);
});

test('roofPlanLines: 外形線に一致する下屋の線は隠れる側（主屋根と軒先どうしが一致する下屋 → 線なし）', () => {
  const { lines } = roofPlanLines([
    { planeId: 'p1', order: 1, regions: [leanRegion('a', 0, 0, 4000, 3000)] },
    { planeId: 'p2', order: 2, regions: [mainRegion(0, 0, 4000, 3000)] },
  ]);
  assert.deepEqual(lines.map(l => l.key), ['p2/main/0']);
});

test('【失敗系】roofPlanLines: outline を読むと例外の region は隠す側に使わず、他の下屋は切られない。自身の例外は failedCount', () => {
  const bad = { key: 'zone:bad', get outline() { throw new Error('壊れた outline'); }, outlineOnly: true, exposedPaths: [{ points: [0, 0, 10, 0], closed: false }] };
  const { lines, failedCount } = roofPlanLines([
    { planeId: 'p1', order: 1, regions: [leanRegion('a', 0, 0, 2000, 1000)] },
    { planeId: 'p2', order: 2, regions: [bad] },
  ]);
  assert.equal(failedCount, 0, 'outline の例外は region の線を組む握りには入らない（exposedPaths は読める）');
  assert.deepEqual(lines.find(l => l.key.startsWith('p1/')).points, [0, 0, 2000, 0, 2000, 1000, 0, 1000]);
});

test('composeSitePlacementView: 図芯と枠は切る前の線から（隠れた下屋の分も含める。切った後の線なら (1500,1500)）', () => {
  // 主屋根は描く線（exposedPaths）が 1000..2000 の正方形・軒先線（outline）は 0..4000×0..3000。下屋 100..300 はその軒先線の内側にすっかり隠れる
  const main = { ...rectRegion('main', 1000, 1000, 2000, 2000), outline: [{ points: [0, 0, 4000, 0, 4000, 3000, 0, 3000] }] };
  const roof = {
    floors: [
      { planeId: 'p1', order: 1, regions: [leanRegion('a', 100, 100, 300, 300)] },
      { planeId: 'p2', order: 2, regions: [main] },
    ],
    gridBounds: null, readFailed: false,
  };
  const v = composeSitePlacementView({ site: new Site(), roof });
  assert.deepEqual(v.roofLines.map(l => l.key), ['p2/main/0'], '隠れた下屋の線は描かない');
  assert.deepEqual(v.buildingCenter, { x: 1050, y: 1050 }, '切る前の外接矩形 100..2000 の中心');
  assert.equal(v.centerSource, SitePlacementCenterSource.ROOF);
  assert.equal(v.roofEmpty, false);
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

test('composeSitePlacementView: grid.frame は配置図座標の敷地の外接矩形を含む（回転 90°: 長方形 4000×2000・tx=10000・ty=5000 → x 8000..10000・y 5000..9000）', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 2000);
  const input = { v1: { x: 0, y: 0 }, v2: { x: 4000, y: 0 }, centerLineId: 'c1', distance: 3000, rotationFlipped: false, sideFlipped: false };
  site.setPlacement({ rotationDeg: 90, tx: 10000, ty: 5000, input });
  const roof = {
    floors: [{ planeId: 'p1', regions: [{ key: 'r', outlineOnly: true, exposedPaths: [{ points: [9000, 6000, 9500, 6000, 9500, 7000, 9000, 7000], closed: true }] }] }],
    gridBounds: null,
    gridLines: [{ id: 'x0', centerLineType: 'X', value: 9000, label: 'X1' }, { id: 'y0', centerLineType: 'Y', value: 6000, label: 'Y1' }],
    readFailed: false,
  };
  const v = composeSitePlacementView({ site, roof });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  near(v.grid.frame.x[0], 8000); near(v.grid.frame.x[1], 10000);
  near(v.grid.frame.y[0], 5000); near(v.grid.frame.y[1], 9000);
});

test('placeSiteSegments: 敷地の線分を配置図座標へ写す（回転 90°・tx=10000・ty=5000: (0,0)-(4000,0) → (10000,5000)-(10000,9000)）。applySiteTransform と同じ写像', () => {
  const t = { rotationDeg: 90, tx: 10000, ty: 5000 };
  const placed = placeSiteSegments([{ key: 'a', points: [0, 0, 4000, 0] }, { key: 'b', points: [4000, 0, 4000, 2000] }], t);
  assert.equal(placed.length, 2);
  placed[0].points.forEach((v, i) => assert.ok(Math.abs(v - [10000, 5000, 10000, 9000][i]) < 1e-6, `${i}: ${v}`));
  const p = applySiteTransform({ x: 4000, y: 2000 }, t);
  assert.ok(Math.abs(placed[1].points[2] - p.x) < 1e-6 && Math.abs(placed[1].points[3] - p.y) < 1e-6);
  assert.deepEqual(placeSiteSegments([], t), []);
});

test('composeSitePlacementView: はなれ寸法は敷地を配置図座標へ写して測る（回転 90°: 敷地 x 8000..10000・y 5000..9000、通り芯 X=9000・Y=6000 → 左右 1000・上 1000・下 3000）', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 2000);
  const input = { v1: { x: 0, y: 0 }, v2: { x: 4000, y: 0 }, centerLineId: 'c1', distance: 3000, rotationFlipped: false, sideFlipped: false };
  site.setPlacement({ rotationDeg: 90, tx: 10000, ty: 5000, input });
  const roof = {
    floors: [{ planeId: 'p1', regions: [{ key: 'r', outlineOnly: true, exposedPaths: [{ points: [9000, 6000, 9500, 6000, 9500, 7000, 9000, 7000], closed: true }] }] }],
    gridBounds: null,
    gridLines: [{ id: 'x0', centerLineType: 'X', value: 9000, label: 'X1' }, { id: 'y0', centerLineType: 'Y', value: 6000, label: 'Y1' }],
    readFailed: false,
  };
  const rows = composeSitePlacementView({ site, roof }).grid.rows;
  assert.equal(rows.length, 4, '通り芯は各軸 1 本なので既存の段は無く、はなれだけ（測った側ごとに 1 行）');
  const segsOf = side => rows.filter(r => r.side === side).map(r => r.segments);
  assert.deepEqual(segsOf('top'), [[{ v1: 8000, v2: 9000, length: 1000 }], [{ v1: 9000, v2: 10000, length: 1000 }]]);
  assert.deepEqual(segsOf('left'), [[{ v1: 5000, v2: 6000, length: 1000 }], [{ v1: 6000, v2: 9000, length: 3000 }]]);
});

test('composeSitePlacementView: 実機相当（敷地 13000×15000・配置 tx=−2000・ty=−13500）で左 2000・下 1500・右 1900（13000−2000−9100）・上 886（15000−1500−12614）', () => {
  const site = new Site();
  site.addRect(0, 0, 13000, 15000);
  const input = { v1: { x: 0, y: 0 }, v2: { x: 0, y: 15000 }, centerLineId: 'x0', distance: 2000, rotationFlipped: false, sideFlipped: false };
  site.setPlacement({ rotationDeg: 0, tx: -2000, ty: -13500, input });
  const mk = (ids, type, vals) => vals.map((value, i) => ({ id: `${ids}${i}`, centerLineType: type, value, label: `${ids}${i}` }));
  const roof = {
    floors: [{ planeId: 'p1', regions: [{ key: 'r', outlineOnly: true, exposedPaths: [{ points: [-500, -13000, 9600, -13000, 9600, 500, -500, 500], closed: true }] }] }],
    gridBounds: null,
    gridLines: [...mk('x', 'X', [0, 1820, 3640, 7280, 9100]), ...mk('y', 'Y', [-12614, -7000, -3640, 0])],
    readFailed: false,
  };
  const rows = composeSitePlacementView({ site, roof }).grid.rows;
  const lens = side => rows.find(r => r.side === side && r.tier === 0).segments.map(s => s.length);
  assert.deepEqual(lens('top'), [2000, 1820, 1820, 3640, 1820, 1900], '間隔の段の先頭・末尾にはなれ（S15）');
  assert.deepEqual(lens('left'), [886, 5614, 3360, 3640, 1500]);
  assert.equal(rows.length, 4, '間隔・全長の 4 行（はなれだけの行なし）。下・右は上・左と同じ値なので出さない');
  assert.ok(rows.every(r => !r.key.includes('/gap/')));
});

test('【失敗系】composeSitePlacementView: 敷地が空なら、はなれ寸法は出ない（通り芯の寸法だけ）', () => {
  const roof = {
    floors: [], gridBounds: null, readFailed: false,
    gridLines: [{ id: 'x0', centerLineType: 'X', value: 0, label: 'X1' }, { id: 'x1', centerLineType: 'X', value: 5000, label: 'X2' },
      { id: 'y0', centerLineType: 'Y', value: 0, label: 'Y1' }, { id: 'y1', centerLineType: 'Y', value: 4000, label: 'Y2' }],
  };
  const rows = composeSitePlacementView({ site: new Site(), roof }).grid.rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => !r.key.includes('/gap/')));
});

test('【失敗系】composeSitePlacementView: 敷地が空なら siteBounds が無く frame は屋根の外接矩形のまま', () => {
  const v = composeSitePlacementView({ site: new Site(), roof: farRoof() });
  assert.deepEqual(v.grid.frame, { x: [50000, 56000], y: [30000, 34000] });
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

const PAIRS = { v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 }, along: { v1: { x: 3, y: 4 }, v2: { x: 5, y: 6 } } };

test('placementVertexLabels: 1 対目は「1」「2」・2 対目は「1\'」「2\'」・共有の角は両方（1 対目→2 対目の順）・どの枠でもなければ []', () => {
  assert.deepEqual(placementVertexLabels(PAIRS, { x: 1, y: 2 }), ['1']);
  assert.deepEqual(placementVertexLabels(PAIRS, { x: 3, y: 4 }), ['2', "1'"], '1 対目の頂点2 と 2 対目の頂点1 の共有');
  assert.deepEqual(placementVertexLabels(PAIRS, { x: 5, y: 6 }), ["2'"]);
  assert.deepEqual(placementVertexLabels(PAIRS, { x: 9, y: 9 }), []);
  assert.deepEqual(placementVertexLabels({ ...PAIRS, along: { v1: { x: 1, y: 2 }, v2: { x: 5, y: 6 } } }, { x: 1, y: 2 }), ['1', "1'"], '1 対目の頂点1 との共有');
});

test('placementVertexColorKind: 1 対目だけ first・2 対目だけ second・両方 shared・どれでもない／input なしは null', () => {
  assert.equal(placementVertexColorKind(PAIRS, { x: 1, y: 2 }), PlacementVertexColorKind.FIRST);
  assert.equal(placementVertexColorKind(PAIRS, { x: 5, y: 6 }), PlacementVertexColorKind.SECOND);
  assert.equal(placementVertexColorKind(PAIRS, { x: 3, y: 4 }), PlacementVertexColorKind.SHARED);
  assert.equal(placementVertexColorKind(PAIRS, { x: 9, y: 9 }), null);
  assert.equal(placementVertexColorKind(null, { x: 1, y: 2 }), null);
  assert.deepEqual([PlacementVertexColorKind.FIRST, PlacementVertexColorKind.SECOND, PlacementVertexColorKind.SHARED], ['first', 'second', 'shared']);
});

test('placementVertexColorKind: 共有していない 2 対目の頂点1（unshared）は SECOND', () => {
  const input = { v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 }, along: { v1: { x: 7, y: 7 }, v2: { x: 5, y: 6 } } };
  assert.equal(placementVertexColorKind(input, { x: 7, y: 7 }), PlacementVertexColorKind.SECOND);
});

test('placementVertexLabelText: 共有の角は「·」で連結（「2·1\'」）。単独は 1 つだけ・枠なしは空文字', () => {
  assert.equal(placementVertexLabelText(PAIRS, { x: 3, y: 4 }), "2·1'");
  assert.equal(placementVertexLabelText(PAIRS, { x: 1, y: 2 }), '1');
  assert.equal(placementVertexLabelText(PAIRS, { x: 5, y: 6 }), "2'");
  assert.equal(placementVertexLabelText(PAIRS, { x: 0, y: 0 }), '');
});

test('【失敗系】placementVertexLabels: input が null・along が null・頂点が null の枠は無視（落ちない）', () => {
  assert.deepEqual(placementVertexLabels(null, { x: 1, y: 2 }), []);
  assert.deepEqual(placementVertexLabels({ v1: { x: 1, y: 2 }, v2: null, along: null }, { x: 1, y: 2 }), ['1']);
  assert.deepEqual(placementVertexLabels({ v1: null, v2: null, along: { v1: null, v2: { x: 5, y: 6 } } }, { x: 5, y: 6 }), ["2'"]);
  assert.equal(placementVertexLabelText(undefined, { x: 1, y: 2 }), '');
});

test('placementAlongVertexIndex: 2 対目の頂点1 なら 1・頂点2 なら 2・それ以外は null（along.v1 を優先）', () => {
  assert.equal(placementAlongVertexIndex(PAIRS, { x: 3, y: 4 }), 1);
  assert.equal(placementAlongVertexIndex(PAIRS, { x: 5, y: 6 }), 2);
  assert.equal(placementAlongVertexIndex(PAIRS, { x: 1, y: 2 }), null);
  assert.equal(placementAlongVertexIndex({ v1: null, v2: null, along: null }, { x: 1, y: 2 }), null);
});

test('alongSharedVertex: 2 対目の頂点1 が 1 対目の頂点1 なら 1・頂点2 なら 2・どちらでもなければ null・2 対目が無ければ null（1 対目の頂点1 が優先）', () => {
  assert.equal(alongSharedVertex({ v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 }, along: { v1: { x: 1, y: 2 } } }), 1);
  assert.equal(alongSharedVertex({ v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 }, along: { v1: { x: 3, y: 4 } } }), 2);
  assert.equal(alongSharedVertex({ v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 }, along: { v1: { x: 7, y: 8 } } }), null);
  assert.equal(alongSharedVertex({ v1: { x: 1, y: 2 }, v2: { x: 3, y: 4 }, along: null }), null);
  assert.equal(alongSharedVertex({ v1: null, v2: null, along: { v1: { x: 1, y: 2 } } }), null);
  assert.equal(alongSharedVertex(null), null);
  assert.equal(alongSharedVertex({ v1: { x: 1, y: 1 }, v2: { x: 1, y: 1 }, along: { v1: { x: 1, y: 1 } } }), 1);
});
