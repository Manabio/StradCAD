import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { SiteLineKind, CenterLineType } from '../core/constants.js';
import { computeSitePlacement } from './sitePlacementSolve.js';
import {
  boundaryPieces, mergeCollinearPieces, formatBoundaryLabel, normalizeLabelAngle, layoutBoundaryLabels, composeSiteBoundaryLabels,
} from './siteBoundaryLabels.js';

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''} actual=${actual} expected=${expected}`);
const closeVec = (v, x, y, msg) => { close(v.x, x, `${msg ?? ''}.x`); close(v.y, y, `${msg ?? ''}.y`); };
const IDENTITY = { rotationDeg: 0, tx: 0, ty: 0 };
// scale=1 のとき gap=TEXT_GAP_PX(2)・fontH=NUM_FONT_PX(11)
const GAP = 2, FONT_H = 11;
const piece = (key, ax, ay, bx, by, road = false, outward = null) => ({ key, a: { x: ax, y: ay }, b: { x: bx, y: by }, road, outward });

// ---- boundaryPieces ----

test('boundaryPieces: 三斜の三角形1個（A(0,0) B(10000,0) D(0,8000)）。外周3本の outward は第3頂点の反対側、road は lineKind から', () => {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(10000, 0), D = site.addPoint(0, 8000);
  const ab = site.addLine(A, B, SiteLineKind.ROAD);
  site.addLine(D, A);
  site.addLine(B, D);
  site.addTriangle(ab, D);
  const ps = boundaryPieces(site);
  assert.equal(ps.length, 3);
  const [pAB, pDA, pBD] = ps;
  assert.equal(pAB.road, true);
  assert.equal(pDA.road, false);
  assert.equal(pBD.road, false);
  closeVec(pAB.outward, 0, -1, 'AB は第3頂点 D（下）の反対＝上');
  closeVec(pDA.outward, -1, 0, 'DA は第3頂点 B（右）の反対＝左');
  closeVec(pBD.outward, 8000 / Math.hypot(10000, 8000), 10000 / Math.hypot(10000, 8000), 'BD は第3頂点 A（左上）の反対＝右下');
  closeVec(pAB.a, 0, 0); closeVec(pAB.b, 10000, 0);
});

test('boundaryPieces: 線が1本だけ（三角形なし）なら outward は null', () => {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(5000, 0);
  site.addLine(A, B);
  const ps = boundaryPieces(site);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].outward, null);
  assert.equal(ps[0].road, false);
});

test('boundaryPieces: 長方形1個（4000×3000・南辺だけ道路）。4片の outward は辺の外向き、road は南だけ', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 3000, 'r1', ['s']);
  const ps = boundaryPieces(site);
  assert.equal(ps.length, 4);
  const bySide = side => ps.find(p => p.key.includes(`/r1/${side}/`));
  closeVec(bySide('n').outward, 0, -1);
  closeVec(bySide('e').outward, 1, 0);
  closeVec(bySide('s').outward, 0, 1);
  closeVec(bySide('w').outward, -1, 0);
  assert.deepEqual(ps.map(p => p.road), ps.map(p => p.key.includes('/s/')));
});

test('boundaryPieces: 長方形2個を横に並べると北辺・南辺が2片に割れ、road は owners から決まる（r2 の北辺だけ道路）', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 3000, 'r1');
  site.addRect(4000, 0, 3000, 3000, 'r2', ['n']);
  const ps = boundaryPieces(site);
  const north = ps.filter(p => p.a.y === 0 && p.b.y === 0).sort((p, q) => p.a.x - q.a.x);
  assert.equal(north.length, 2);
  assert.deepEqual([north[0].a.x, north[0].b.x, north[0].road], [0, 4000, false]);
  assert.deepEqual([north[1].a.x, north[1].b.x, north[1].road], [4000, 7000, true]);
  const south = ps.filter(p => p.a.y === 3000 && p.b.y === 3000);
  assert.equal(south.length, 2);
  assert.ok(south.every(p => p.road === false));
});

test('【失敗系】boundaryPieces: 敷地が空なら片は無い', () => {
  assert.deepEqual(boundaryPieces(new Site()), []);
});

// ---- mergeCollinearPieces ----

test('mergeCollinearPieces: 同一直線・同種の隣接2片は1本（長さの和・key を + で結合・outward は先頭）', () => {
  const out = mergeCollinearPieces([
    piece('p', 0, 0, 4000, 0, false, { x: 0, y: -1 }),
    piece('q', 4000, 0, 7000, 0, false, { x: 0, y: 1 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'p+q');
  assert.deepEqual([out[0].a, out[0].b], [{ x: 0, y: 0 }, { x: 7000, y: 0 }]);
  assert.deepEqual(out[0].outward, { x: 0, y: -1 });
});

test('mergeCollinearPieces: 先頭の outward が null で相手が持つなら、結合後は相手の outward を残す', () => {
  const out = mergeCollinearPieces([piece('p', 0, 0, 4000, 0, false, null), piece('q', 4000, 0, 7000, 0, false, { x: 0, y: -1 })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].outward, { x: 0, y: -1 });
});

test('mergeCollinearPieces: 向きが逆の隣接片（q が b→a 向き）も結合する', () => {
  const out = mergeCollinearPieces([piece('p', 0, 0, 4000, 0), piece('q', 7000, 0, 4000, 0)]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].a, out[0].b], [{ x: 0, y: 0 }, { x: 7000, y: 0 }]);
});

test('【失敗系】mergeCollinearPieces: 種別違い・離れている片・折れる片・同じ向きに重なる片は結合しない', () => {
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 4000, 0, false), piece('q', 4000, 0, 7000, 0, true)]).length, 2, '種別違い');
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 4000, 0), piece('q', 4001, 0, 7000, 0)]).length, 2, '離れている');
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 4000, 0), piece('q', 4000, 0, 4000, 3000)]).length, 2, '折れる');
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 4000, 0), piece('q', 4000, 0, 2000, 0)]).length, 2, '折り返し（端点共有だが同じ側）');
});

test('mergeCollinearPieces: 3片連続（順不同）は1本。入力は破壊しない', () => {
  const input = [piece('p', 0, 0, 1000, 0), piece('r', 2000, 0, 3500, 0), piece('q', 1000, 0, 2000, 0)];
  const out = mergeCollinearPieces(input);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].a, out[0].b], [{ x: 0, y: 0 }, { x: 3500, y: 0 }]);
  assert.equal(input.length, 3);
});

// ---- formatBoundaryLabel ----

test('formatBoundaryLabel: mm を丸め、道路／隣地で名称を変える', () => {
  assert.equal(formatBoundaryLabel(false, 1234.6), '隣地境界線(1235)');
  assert.equal(formatBoundaryLabel(true, 1234.4), '道路境界線(1234)');
});

test('normalizeLabelAngle: [−90, 90) へ。90 は −90', () => {
  assert.equal(normalizeLabelAngle(90), -90);
  assert.equal(normalizeLabelAngle(-90), -90);
  assert.equal(normalizeLabelAngle(135), -45);
  assert.equal(normalizeLabelAngle(-135), 45);
  assert.equal(normalizeLabelAngle(0), 0);
  assert.equal(normalizeLabelAngle(180), 0);
});

// ---- layoutBoundaryLabels ----

test('layoutBoundaryLabels: 水平の上辺（外＝上）は字の上が外なので gap だけ上。下辺（外＝下）は gap＋字高さだけ下', () => {
  const [top] = layoutBoundaryLabels([piece('t', 0, 0, 1000, 0, false, { x: 0, y: -1 })], IDENTITY, 1, null);
  assert.equal(top.text, '隣地境界線(1000)');
  close(top.rotation, 0);
  close(top.x, 500); close(top.y, -GAP);
  const [bottom] = layoutBoundaryLabels([piece('b', 0, 100, 1000, 100, true, { x: 0, y: 1 })], IDENTITY, 1, null);
  assert.equal(bottom.text, '道路境界線(1000)');
  close(bottom.x, 500); close(bottom.y, 100 + GAP + FONT_H);
});

test('layoutBoundaryLabels: 鉛直の片は rotation −90。左辺（外＝左）は gap、右辺（外＝右）は gap＋字高さ離れる', () => {
  const [left] = layoutBoundaryLabels([piece('l', 0, 0, 0, 1000, false, { x: -1, y: 0 })], IDENTITY, 1, null);
  close(left.rotation, -90); close(left.x, -GAP); close(left.y, 500);
  const [right] = layoutBoundaryLabels([piece('r', 1000, 0, 1000, 1000, false, { x: 1, y: 0 })], IDENTITY, 1, null);
  close(right.rotation, -90); close(right.x, 1000 + GAP + FONT_H); close(right.y, 500);
});

test('layoutBoundaryLabels: 向きが逆の入力（b→a）でも rotation は同じ [−90, 90) に収まる', () => {
  const [l] = layoutBoundaryLabels([piece('l', 0, 1000, 0, 0, false, { x: -1, y: 0 })], IDENTITY, 1, null);
  close(l.rotation, -90); close(l.x, -GAP);
});

test('layoutBoundaryLabels: 斜め4象限の rotation は 45・−45・−45・45（[−90, 90)）', () => {
  const rots = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dy]) =>
    layoutBoundaryLabels([piece('d', 0, 0, dx * 1000, dy * 1000, false, { x: 0, y: -1 })], IDENTITY, 1, null)[0].rotation);
  rots.forEach((r, i) => close(r, [45, -45, -45, 45][i], `象限${i}`));
});

test('layoutBoundaryLabels: 敷地を 90° 回して平行移動した transform で rotation と anchor が追従する', () => {
  const t = { rotationDeg: 90, tx: 100, ty: 200 };
  const [l] = layoutBoundaryLabels([piece('t', 0, 0, 1000, 0, false, { x: 0, y: -1 })], t, 1, null);
  // 上辺は 90° 回すと (100,200)→(100,1200) の鉛直線、外は +x 側。字は −90 で上が左を向くので外とは逆＝gap＋字高さ
  close(l.rotation, -90);
  close(l.x, 100 + GAP + FONT_H); close(l.y, 700);
});

test('layoutBoundaryLabels: scale で離れが画面 px 一定（gap・字高さは px/scale の世界 mm）', () => {
  const [l] = layoutBoundaryLabels([piece('b', 0, 100, 1000, 100, false, { x: 0, y: 1 })], IDENTITY, 0.5, null);
  close(l.y, 100 + (GAP + FONT_H) / 0.5);
});

test('layoutBoundaryLabels: outward が null の片は fallbackCenter から離れる側を外とする', () => {
  const p = piece('n', 0, 0, 1000, 0);
  const [up] = layoutBoundaryLabels([p], IDENTITY, 1, { x: 500, y: 500 });
  close(up.x, 500); close(up.y, -GAP);
  const [down] = layoutBoundaryLabels([p], IDENTITY, 1, { x: 500, y: -500 });
  close(down.y, GAP + FONT_H);
});

test('【失敗系】layoutBoundaryLabels: outward が null で fallbackCenter も null の片は描かない。長さ0の片も描かない', () => {
  assert.deepEqual(layoutBoundaryLabels([piece('n', 0, 0, 1000, 0)], IDENTITY, 1, null), []);
  assert.deepEqual(layoutBoundaryLabels([piece('z', 5, 5, 5, 5, false, { x: 0, y: -1 })], IDENTITY, 1, null), []);
  const mixed = layoutBoundaryLabels([piece('n', 0, 0, 1000, 0), piece('o', 0, 0, 0, 1000, false, { x: -1, y: 0 })], IDENTITY, 1, null);
  assert.deepEqual(mixed.map(l => l.key), ['o']);
});

test('composeSiteBoundaryLabels: 頂点 B→D を縦の通り芯（value 0）へ配置（回転反転）した BD のラベルは rotation −90（浮動小数で 89.999… に落ちない）', () => {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(10000, 0), D = site.addPoint(-1483, 7077);
  const ab = site.addLine(A, B);
  site.addLine(D, A);
  const bd = site.addLine(B, D);
  site.addTriangle(ab, D);
  const t = computeSitePlacement({
    v1: { x: 10000, y: 0 }, v2: { x: -1483, y: 7077 }, centerLine: { centerLineType: CenterLineType.VERTICAL, value: 0 },
    distance: 3000, rotationFlipped: true, sideFlipped: false, buildingCenter: { x: -5000, y: 0 }, prevTransform: IDENTITY,
  });
  assert.ok(t, '解ける入力');
  const labels = composeSiteBoundaryLabels({ site, transform: t, scale: 1, fallbackCenter: null });
  const label = labels.find(l => l.key === `bl/${bd.id}`);
  assert.equal(label.rotation, -90);
});

test('layoutBoundaryLabels: ほぼ鉛直の片（dx=±1e-12）の rotation は −90（上向き・下向きどちらの誤差でも）', () => {
  for (const dx of [1e-12, -1e-12]) {
    const [l] = layoutBoundaryLabels([piece('v', 0, 0, dx, 1000, false, { x: -1, y: 0 })], IDENTITY, 1, null);
    assert.equal(l.rotation, -90, `dx=${dx}`);
  }
});

test('composeSiteBoundaryLabels: 三角形の無い外周線は fallbackCenter（外接矩形中心）の反対側に出る', () => {
  const site = new Site();
  site.addLine(site.addPoint(0, 0), site.addPoint(10000, 0));
  const above = composeSiteBoundaryLabels({ site, transform: IDENTITY, scale: 1, fallbackCenter: { x: 5000, y: 5000 } });
  assert.equal(above.length, 1);
  close(above[0].x, 5000); close(above[0].y, -GAP); close(above[0].rotation, 0);
  const below = composeSiteBoundaryLabels({ site, transform: IDENTITY, scale: 1, fallbackCenter: { x: 5000, y: -5000 } });
  close(below[0].y, GAP + FONT_H);
});

test('mergeCollinearPieces: 外積は無次元で比べる（長い片のわずかな折れは結合しない・長さ 0 の片は結合しない）', () => {
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 1e6, 0), piece('q', 1e6, 0, 2e6, 10)]).length, 2, 'sin≈1e-5（旧実装の生の外積なら 1e7 で同じく不結合）');
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 1, 0), piece('q', 1, 0, 2, 1e-5)]).length, 2, '短い片: 生の外積 1e-5 でも sin≈1e-5 は不結合');
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 1e6, 0), piece('q', 1e6, 0, 2e6, 1e-7)]).length, 1, '長い片: 生の外積 0.1 でも sin≈1e-13 は結合');
  assert.equal(mergeCollinearPieces([piece('p', 0, 0, 1000, 0), piece('z', 1000, 0, 1000, 0)]).length, 2, '長さ 0');
});

test('composeSiteBoundaryLabels: 長方形2個の北辺は種別が違えば2本、同種なら1本のラベルになる', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 3000, 'r1');
  site.addRect(4000, 0, 3000, 3000, 'r2');
  const labels = composeSiteBoundaryLabels({ site, transform: IDENTITY, scale: 1, fallbackCenter: null });
  const north = labels.filter(l => l.rotation === 0 && l.y < 0);
  assert.equal(north.length, 1, '同種の隣接片は結合');
  assert.equal(north[0].text, '隣地境界線(7000)');
  const site2 = new Site();
  site2.addRect(0, 0, 4000, 3000, 'r1');
  site2.addRect(4000, 0, 3000, 3000, 'r2', ['n']);
  const labels2 = composeSiteBoundaryLabels({ site: site2, transform: IDENTITY, scale: 1, fallbackCenter: null });
  assert.deepEqual(labels2.filter(l => l.y < 0).map(l => l.text).sort(), ['隣地境界線(4000)', '道路境界線(3000)'].sort());
});
