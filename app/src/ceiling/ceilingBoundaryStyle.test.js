// ceilingBoundaryStyle.js（同じ高さの天井の境目に細線グレーの印）の単体テスト。
// 純関数の挙動は手組みの線・天井面で、解決器を通した結果は実物の PlanGraph（planSolidsLayerPrimitivesUp）で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSameHeightCeilingBoundaries, sameHeightBoundarySegments, CEILING_BOUNDARY_STYLE } from './ceilingBoundaryStyle.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { assignZoneShape } from './ceilingZones.js';
import { planSolidsLayerPrimitivesUp, planSolidsLayerSolidsUp, drawnPrimitives } from '../plan/planSolidsLayerFilter.js';
import { planSectionFigureUp } from '../plan/planSectionUp.js';
import { makeGrid, rect, assignZoneHeight } from '../plan/planTestFixtures.js';

const CUT = 1500;
const line = (key, points, kind = 'ceiling', extra = {}) => ({
  kind: 'line', key, points, weight: 'thin', cls: 'below', detailOnly: false, source: { kind, id: key, layerFloorZ: 0 }, ...extra,
});
const surf = (rects, zMm) => ({ roomId: 'r', rects, zMm });
const norm = p => {
  const [a, b, c, d] = p.points;
  return a < c || (a === c && b <= d) ? [a, b, c, d] : [c, d, a, b];
};
const ceilingLines = prims => prims.filter(p => p.source.kind === 'ceiling');
const onX = (prims, x) => prims.filter(p => Math.abs(p.points[0] - x) < 1e-6 && Math.abs(p.points[2] - x) < 1e-6);
const lengthOf = prims => prims.reduce((n, p) => n + Math.hypot(p.points[2] - p.points[0], p.points[3] - p.points[1]), 0);

// ================================================================ 純関数（手組み）

test('sameHeightBoundarySegments: 同じ高さ（eps 0.5mm）の別の面が辺を共有する区間だけ。高さ違い・離れている・同一面の内側は出ない', () => {
  const a = surf([rect(0, 0, 2000, 3000)], 2400);
  const b = surf([rect(2000, 1000, 4000, 2000)], 2400.4);
  assert.deepEqual(sameHeightBoundarySegments([a, b]), [{ horizontal: false, c: 2000, lo: 1000, hi: 2000 }], '共有区間は y 1000..2000');
  assert.deepEqual(sameHeightBoundarySegments([a, surf([rect(2000, 0, 4000, 3000)], 2401)]), [], '高さが 0.5mm より違う');
  assert.deepEqual(sameHeightBoundarySegments([a, surf([rect(2100, 0, 4000, 3000)], 2400)]), [], '辺が離れている');
  assert.deepEqual(sameHeightBoundarySegments([a, surf([rect(2000, 3000, 4000, 4000)], 2400)]), [], '角が触れるだけ（共有長さ 0）');
  assert.deepEqual(sameHeightBoundarySegments([surf([rect(0, 0, 1000, 1000), rect(1000, 0, 2000, 1000)], 2400)]), [], '同一面の矩形どうしは対象外');
  const h = sameHeightBoundarySegments([surf([rect(0, 0, 1000, 1000)], 2400), surf([rect(0, 1000, 1000, 2000)], 2400)]);
  assert.deepEqual(h, [{ horizontal: true, c: 1000, lo: 0, hi: 1000 }]);
});

test('【失敗系】surfaces が空・配列でない／prims が配列でないときは入力をそのまま返す。共有辺の無い面は何もしない', () => {
  const prims = [line('a', [0, 0, 100, 0])];
  assert.ok(markSameHeightCeilingBoundaries(prims, []) === prims);
  assert.ok(markSameHeightCeilingBoundaries(prims, undefined) === prims);
  assert.ok(markSameHeightCeilingBoundaries(prims, null) === prims);
  assert.equal(markSameHeightCeilingBoundaries(null, [surf([rect(0, 0, 1, 1)], 1)]), null);
  assert.deepEqual(markSameHeightCeilingBoundaries(prims, [surf([rect(0, 0, 1000, 1000)], 2400), surf([rect(5000, 0, 6000, 1000)], 2400)]), prims, '共有辺なし＝内容は同じ');
});

test('【失敗系】source.kind が ceiling でない線・斜めの線・点は触らない（同じオブジェクトのまま・境界の上にあっても無印）', () => {
  const surfaces = [surf([rect(0, 0, 2000, 3000)], 2400), surf([rect(2000, 0, 4000, 3000)], 2400)];
  const beam = line('beam', [2000, 0, 2000, 3000], 'beam');
  const wall = line('wall', [2000, 0, 2000, 3000], 'wall');
  const diag = line('diag', [1900, 0, 2100, 3000]);
  const dot = line('dot', [2000, 0, 2000, 0]);
  const label = { kind: 'arrow', key: 'l', points: [2000, 0, 2000, 3000], source: { kind: 'ceiling', id: 'x' } };
  const out = markSameHeightCeilingBoundaries([beam, wall, diag, dot, label], surfaces);
  assert.equal(out.length, 5);
  out.forEach((p, i) => assert.ok(p === [beam, wall, diag, dot, label][i], `${p.key} は同じオブジェクト`));
  assert.ok(out.every(p => p.style === undefined));
});

test('境界の上の線は印が付き（style=ceilingBoundary・他の項目は不変）、境界の外の線は同じオブジェクトのまま。入力は変更しない', () => {
  const surfaces = [surf([rect(0, 0, 2000, 3000)], 2400), surf([rect(2000, 0, 4000, 3000)], 2400)];
  const edge = line('edge', [2000, 0, 2000, 3000]);
  const outer = line('outer', [0, 0, 0, 3000]);
  const before = JSON.stringify([edge, outer]);
  const out = markSameHeightCeilingBoundaries([edge, outer], surfaces);
  assert.equal(JSON.stringify([edge, outer]), before, '入力不変');
  assert.deepEqual(out[0], { ...edge, style: CEILING_BOUNDARY_STYLE });
  assert.equal(CEILING_BOUNDARY_STYLE, 'ceilingBoundary');
  assert.ok(out[1] === outer);
});

test('両立体から出た同じ座標の重複は印の付いた1本に畳む（向きが逆でも）。無印の ceiling 線も座標が完全一致なら1本に畳む。座標が違えば畳まない。ceiling 以外は畳まない', () => {
  const surfaces = [surf([rect(0, 0, 2000, 3000)], 2400), surf([rect(2000, 0, 4000, 3000)], 2400)];
  const out = markSameHeightCeilingBoundaries([
    line('a', [2000, 0, 2000, 3000]), line('b', [2000, 3000, 2000, 0]),
    line('o1', [0, 0, 0, 3000]), line('o2', [0, 3000, 0, 0]), line('o3', [0, 0, 0, 2999]),
    line('w1', [0, 0, 0, 3000], 'wall'), line('w2', [0, 0, 0, 3000], 'wall'),
  ], surfaces);
  assert.deepEqual(out.map(p => p.key), ['a', 'o1', 'o3', 'w1', 'w2']);
  assert.equal(out[0].style, CEILING_BOUNDARY_STYLE);
  assert.equal(out[1].style, undefined);
});

test('EPS 内の丸めの境目（x=100.24 と 100.26）でも印付きの線は1本に畳む。区間が部分的に重なるときは差し引いた残りだけを出す', () => {
  const surfaces = [surf([rect(0, 0, 100.24, 1000)], 2400), surf([rect(100.26, 0, 200, 1000)], 2400)];
  const out = markSameHeightCeilingBoundaries([line('a', [100.24, 0, 100.24, 1000]), line('b', [100.26, 0, 100.26, 1000])], surfaces);
  assert.deepEqual(out.map(p => p.key), ['a']);
  assert.equal(out[0].style, CEILING_BOUNDARY_STYLE);
  // 部分的に重なる: b は [0,1000] のうち a が出した [0,600] を差し引いた [600,1000] だけ
  const two = markSameHeightCeilingBoundaries([line('a', [100.24, 0, 100.24, 600]), line('b', [100.26, 0, 100.26, 1000])], surfaces);
  assert.deepEqual(two.map(p => [p.key, norm(p)]), [['a', [100.24, 0, 100.24, 600]], ['b', [100.26, 600, 100.26, 1000]]]);
});

test('T 字の境界: 1矩形の部屋 A が同じ高さの B・C に接すると、x=2000 上の印付き線の区間は重ならず合計長 3000', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  g.interior([[0, 0], [0, 1]]).setOverride('ceilingHeight', '2400');
  g.interior([[1, 0]]).setOverride('ceilingHeight', '2400');
  g.interior([[1, 1]]).setOverride('ceilingHeight', '2400');
  const ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  const marked = onX(ceil, 2000).filter(p => p.style === CEILING_BOUNDARY_STYLE);
  assert.equal(lengthOf(marked), 3000, `合計長: ${JSON.stringify(marked.map(norm))}`);
  const sorted = marked.map(norm).sort((p, q) => p[1] - q[1]);
  sorted.slice(1).forEach((s, i) => assert.ok(s[1] >= sorted[i][3] - 1e-6, `区間が重なる: ${JSON.stringify(sorted)}`));
  assert.equal(new Set(ceil.map(p => p.key)).size, ceil.length, 'key は一意');
  assert.equal(onX(ceil, 2000).length, marked.length, 'x=2000 に無印は残らない');
});

test('同じ高さの面が無い（段差だけ）でも、無印の ceiling 線の完全一致の重複は1本に畳む', () => {
  const out = markSameHeightCeilingBoundaries([line('s1', [2000, 0, 2000, 3000]), line('s2', [2000, 0, 2000, 3000])],
    [surf([rect(0, 0, 2000, 3000)], 2600), surf([rect(2000, 0, 4000, 3000)], 2200)]);
  assert.deepEqual(out.map(p => p.key), ['s1']);
  assert.equal(out[0].style, undefined);
});

test('一部だけ境界に乗る線は分割される（境界の部分だけ印・残りは無印）。片の key は元の key に :p番号を付けて一意', () => {
  const surfaces = [surf([rect(0, 0, 2000, 3000)], 2400), surf([rect(2000, 1000, 4000, 2000)], 2400)];
  const out = markSameHeightCeilingBoundaries([line('e', [2000, 0, 2000, 3000])], surfaces);
  assert.deepEqual(out.map(p => [p.key, norm(p), p.style]), [
    ['e:p0', [2000, 0, 2000, 1000], undefined],
    ['e:p1', [2000, 1000, 2000, 2000], CEILING_BOUNDARY_STYLE],
    ['e:p2', [2000, 2000, 2000, 3000], undefined],
  ]);
  assert.equal(new Set(out.map(p => p.key)).size, 3);
  // 横線も同様
  const h = markSameHeightCeilingBoundaries([line('h', [0, 1000, 3000, 1000])], [surf([rect(0, 0, 1000, 1000)], 2400), surf([rect(500, 1000, 1500, 2000)], 2400)]);
  assert.deepEqual(h.map(p => [norm(p), p.style]), [[[0, 1000, 500, 1000], undefined], [[500, 1000, 1000, 1000], CEILING_BOUNDARY_STYLE], [[1000, 1000, 3000, 1000], undefined]]);
});

// ================================================================ 解決器を通した結果（実物の graph）

test('同じ高さの2部屋（壁なし）: 境界の線は1本で印あり。外形は印なし。畳む前は境界が2本（両立体から1本ずつ）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  g.interior([[1, 0]]).setOverride('ceilingHeight', '2400');
  const prims = planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT });
  const ceil = ceilingLines(prims);
  const boundary = onX(ceil, 2000);
  assert.equal(boundary.length, 1, `境界は1本: ${JSON.stringify(boundary.map(norm))}`);
  assert.equal(boundary[0].style, CEILING_BOUNDARY_STYLE);
  assert.deepEqual(norm(boundary[0]), [2000, 0, 2000, 3000]);
  assert.equal(ceil.filter(p => p.style).length, 1, '印は境界の1本だけ');
  assert.equal(ceil.length, 7, '外形 6 本＋境界 1 本');
  // 印の処理を通す前（解決器の素の出力）は境界が2本あった
  const raw = ceilingLines(drawnPrimitives(planSectionFigureUp(planSolidsLayerSolidsUp({ graph: g.graph }), CUT), 'up'));
  assert.equal(onX(raw, 2000).length, 2, `畳む前は両立体から1本ずつ: ${raw.length}`);
  assert.equal(ceilingSurfacesOf(g.graph).length, 2);
});

test('高さが違う2部屋（壁なし）: 段差の見切り線は印なしの1本（解決器が出す同座標の2本は畳まれる）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2600');
  g.interior([[1, 0]]).setOverride('ceilingHeight', '2200');
  const ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  const step = onX(ceil, 2000);
  assert.deepEqual(step.map(norm), [[2000, 0, 2000, 3000]], '段差の線は1本');
  const raw = ceilingLines(drawnPrimitives(planSectionFigureUp(planSolidsLayerSolidsUp({ graph: g.graph }), CUT), 'up'));
  assert.equal(onX(raw, 2000).length, 2, '畳む前は両立体から同座標の2本');
  assert.ok(ceil.every(p => p.style === undefined), '印は1本も付かない');
  assert.equal(new Set(ceil.map(p => p.key)).size, ceil.length, 'key は一意');
});

test('3部屋で一部だけ同じ高さ: 線が分割され、同じ高さの区間だけ印が付く（段差の区間・外形は無印）', () => {
  // A（左の縦長・2400）／B（右上・2400）／C（右下・2200）。A|B は同じ高さ、A|C・B/C は段差
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  g.interior([[0, 0], [0, 1]]).setOverride('ceilingHeight', '2400');
  g.interior([[1, 0]]).setOverride('ceilingHeight', '2400');
  g.interior([[1, 1]]).setOverride('ceilingHeight', '2200');
  const ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  const marked = ceil.filter(p => p.style === CEILING_BOUNDARY_STYLE);
  assert.deepEqual(marked.map(norm), [[2000, 0, 2000, 1500]], `印は A|B の区間 y0..1500 だけ: ${JSON.stringify(marked.map(norm))}`);
  const unmarkedOn2000 = onX(ceil, 2000).filter(p => !p.style);
  assert.equal(lengthOf(unmarkedOn2000), 1500, 'x=2000 の残り（A|C の段差）は y1500..3000 の無印1本');
  assert.deepEqual(unmarkedOn2000.map(norm), [[2000, 1500, 2000, 3000]]);
  assert.equal(new Set(ceil.map(p => p.key)).size, ceil.length, 'key は一意');
});

test('壁のある境界: 解決器が天井の線を隠すので、境界に印の付く線は無い（壁の取り合いの短い断片が残るだけ）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0]], { walls: true }).setOverride('ceilingHeight', '2400');
  g.interior([[1, 0]], { walls: true }).setOverride('ceilingHeight', '2400');
  const ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  assert.ok(ceil.every(p => p.style === undefined), `印なし: ${JSON.stringify(ceil.filter(p => p.style).map(norm))}`);
  assert.ok(onX(ceil, 2000).every(p => lengthOf([p]) <= 57.5 + 1e-6), '境界の線は壁の隅の短い断片だけ');
});

// ---- 天井区画（S5）どうし・区画と残りの境界 ----

test('区画と残りの境界: 高さが違えば印なしの1本（段差の見切り線）、同じ高さ（部屋の CH と同値の区画）ならグレーの印あり', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneHeight(g.graph, room, [g.cell(1, 0)], 2800));
  let ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  assert.deepEqual(onX(ceil, 2000).map(norm), [[2000, 0, 2000, 3000]], '段差の境界は1本');
  assert.ok(ceil.every(p => p.style === undefined), '高さ違いは無印');

  room.setCeilingZones(assignZoneHeight(g.graph, room, [g.cell(1, 0)], 2400));
  ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  const boundary = onX(ceil, 2000);
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].style, CEILING_BOUNDARY_STYLE, '同じ高さの区画と残りの境界はグレー');
});

test('区画どうしの境界: 同じ高さでも別の区画（flat・高さ違いは別区画）。高さ違いは印なし、同じ高さを別区画に持たせた境界は印あり', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  room.setCeilingZones(assignZoneHeight(g.graph, room, [g.cell(0, 0)], 2500));
  room.setCeilingZones(assignZoneHeight(g.graph, room, [g.cell(1, 0)], 2800));
  let ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  assert.ok(onX(ceil, 2000).every(p => p.style === undefined), '2500|2800 は段差＝無印');
  // 同じ高さの別区画は assign が束ねるので、直接 2 区画を置く（S6 で形状の違う同高さ区画がありうる箱の確認）
  const [z0, z1] = room.ceilingZones;
  room.setCeilingZones([z0.withHeight(2600), z1.withHeight(2600)]);
  ceil = ceilingLines(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  const marked = onX(ceil, 2000).filter(p => p.style === CEILING_BOUNDARY_STYLE);
  assert.equal(marked.length, 1, '同じ高さの区画どうしの境界はグレー1本');
});

// ---- 形状（S6a）: 灰色の対象は平面どうしだけ ----

test('sameHeightBoundarySegments: 傾斜の面が一方でも入る組は対象外（基準高が同じでも）。shape 省略は平面と見なす', () => {
  const flat = surf([rect(0, 0, 2000, 3000)], 2400);
  const next = { ...surf([rect(2000, 0, 4000, 3000)], 2400) };
  assert.equal(sameHeightBoundarySegments([flat, next]).length, 1, '前提: 省略どうしは対象（S5 の挙動）');
  assert.equal(sameHeightBoundarySegments([{ ...flat, shape: 'flat' }, { ...next, shape: 'flat' }]).length, 1);
  assert.deepEqual(sameHeightBoundarySegments([{ ...flat, shape: 'slope' }, { ...next, shape: 'flat' }]), [], '傾斜|平面');
  assert.deepEqual(sameHeightBoundarySegments([{ ...flat, shape: 'flat' }, { ...next, shape: 'slope' }]), [], '平面|傾斜');
  assert.deepEqual(sameHeightBoundarySegments([{ ...flat, shape: 'slope' }, { ...next, shape: 'slope' }]), [], '傾斜|傾斜');
});

test('傾斜の区画と平面の境界は通常の細線（グレーの印なし）。基準高が同じ平面どうしの境界はグレーのまま', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneShape(g.graph, room, [g.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [1000, 0] }));
  const lineOnly = prims => ceilingLines(prims).filter(p => p.kind === 'line'); // 傾斜の注記（arrow・text）は除く
  const ceil = lineOnly(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  assert.ok(onX(ceil, 2000).length > 0, '前提: 傾斜の左端（基準高＝低い側）と平面の境界に線が出る');
  assert.ok(ceil.every(p => p.style === undefined), `傾斜に接する境界にグレーの印が付いている: ${JSON.stringify(ceil.filter(p => p.style).map(norm))}`);
  // 対照: 傾斜を平面（同じ高さ）に置き換えるとグレーの印が付く
  room.setCeilingZones(assignZoneShape(g.graph, room, [g.cell(1, 0)], { heightMm: 2400, shape: 'flat', dims: [] }));
  const flatCeil = lineOnly(planSolidsLayerPrimitivesUp({ graph: g.graph, cutZ: CUT }));
  assert.ok(flatCeil.some(p => p.style === CEILING_BOUNDARY_STYLE), '対照: 平面どうしならグレー');
});
