// finish/wallFaces.js outerWallFaceNear の単体テスト（座標で引く外壁面。下屋の平面の線の端止めが使う）。
// 壁は本番の graph.addWall で作る（finishGuideGeometry.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { outerWallFaceNear } from './wallFaces.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

/** 横の通り芯 y=0 と、縦の通り芯 x=0・1000・2000・3000・4000 を持つ階。 */
function makeGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  const axis = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const xs = [0, 1000, 2000, 3000, 4000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  return { graph, axis, xs };
}

const wallOn = (graph, axis, offset, from, to, props = { wallFinish: 12.5, backingDepth: 0 }) =>
  graph.addWall(axis, offset, false, from, 0, to, 0, props);

test('outerWallFaceNear: outward>0 は材の上端(hi)・outward<0 は下端(lo)。backing がある壁は material∪backing の外端', () => {
  const { graph, axis, xs } = makeGraph();
  // 下地なし（仕上げのみ）の薄壁: axisOffset -60・仕上げ 12.5 → 材は [-60, -47.5]
  const thin = wallOn(graph, axis, -60, xs[0], xs[4]);
  assert.deepEqual(thin.materialRange, { lo: -60, hi: -47.5 }, '前提');
  const q = { isVertical: false, coord: 0, at: 2000, reachMm: 0 };
  assert.equal(outerWallFaceNear(graph, { ...q, outward: 1 }), -47.5);
  assert.equal(outerWallFaceNear(graph, { ...q, outward: -1 }), -60);
  // 下地あり（backing [-52.5, 52.5]）で仕上げ面 +60: material は [-52.5, 60]。2つの範囲の外端
  const g2 = makeGraph();
  const thick = wallOn(g2.graph, g2.axis, 60, g2.xs[0], g2.xs[4], { wallFinish: 12.5, backingDepth: 105, backingOffset: 0 });
  assert.deepEqual(thick.backingRange, { lo: -52.5, hi: 52.5 }, '前提');
  assert.deepEqual(thick.materialRange, { lo: -52.5, hi: 60 }, '前提');
  assert.equal(outerWallFaceNear(g2.graph, { ...q, outward: 1 }), 60);
  assert.equal(outerWallFaceNear(g2.graph, { ...q, outward: -1 }), -52.5);
});

test('outerWallFaceNear: reach の内外（壁の区間と at の距離が reach 以下なら対象。区間の中は距離 0）', () => {
  const { graph, axis, xs } = makeGraph();
  wallOn(graph, axis, 60, xs[1], xs[3]); // 区間 x 1000..3000
  const face = (at, reachMm) => outerWallFaceNear(graph, { isVertical: false, coord: 0, at, reachMm, outward: 1 });
  assert.equal(face(2000, 0), 60, '区間の中（距離 0）は reach 0 でも対象');
  assert.equal(face(3500, 500), 60, '距離 500 ちょうどは reach 500 で対象');
  assert.equal(face(3500, 499), null, '距離 500 は reach 499 では対象外');
  assert.equal(face(100, 899), null);
  assert.equal(face(100, 900), 60, '区間の手前 900');
});

test('outerWallFaceNear: 最も近い壁の面を返す（同じ通り芯上の別の壁と混ぜない）。近さが同じなら最も外の面', () => {
  const { graph, axis, xs } = makeGraph();
  wallOn(graph, axis, 60, xs[0], xs[1]); // x 0..1000 の面 +60
  wallOn(graph, axis, 80, xs[2], xs[3]); // x 2000..3000 の面 +80
  const face = at => outerWallFaceNear(graph, { isVertical: false, coord: 0, at, reachMm: 2000, outward: 1 });
  assert.equal(face(1200), 60, '左の壁まで 200・右の壁まで 800');
  assert.equal(face(1900), 80, '左の壁まで 900・右の壁まで 100');
  assert.equal(face(1500), 80, '近さが同じ（500）なら最も外の面（outward>0 は大きい方）');
  assert.equal(outerWallFaceNear(graph, { isVertical: false, coord: 0, at: 1500, reachMm: 2000, outward: -1 }), Math.min(
    ...graph.walls.map(w => w.materialRange.lo)), '近さが同じなら outward<0 は小さい方');
});

test('【失敗系】outerWallFaceNear: 壁が無い・向きが違う・通り芯の座標が合わない・reach の外は null', () => {
  const empty = makeGraph();
  assert.equal(outerWallFaceNear(empty.graph, { isVertical: false, coord: 0, at: 0, reachMm: 1000, outward: 1 }), null, '壁が無い階');
  const { graph, axis, xs } = makeGraph();
  wallOn(graph, axis, 60, xs[0], xs[4]);
  const base = { at: 2000, reachMm: 1000, outward: 1 };
  assert.equal(outerWallFaceNear(graph, { ...base, isVertical: false, coord: 0 }), 60, '前提: 合う条件では面が返る');
  assert.equal(outerWallFaceNear(graph, { ...base, isVertical: true, coord: 0 }), null, '向き（縦）が違う');
  assert.equal(outerWallFaceNear(graph, { ...base, isVertical: false, coord: 100 }), null, '座標が違う');
});

test('outerWallFaceNear: 座標の許容差は CL_OVERLAP_TOL_MM（以内は同じ通り芯、超えると別）', () => {
  const { graph, axis, xs } = makeGraph();
  wallOn(graph, axis, 60, xs[0], xs[4]);
  const at = coord => outerWallFaceNear(graph, { isVertical: false, coord, at: 2000, reachMm: 0, outward: 1 });
  assert.equal(at(CL_OVERLAP_TOL_MM), 60);
  assert.equal(at(-CL_OVERLAP_TOL_MM), 60);
  assert.equal(at(CL_OVERLAP_TOL_MM * 2), null);
});
