import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { fitLocal, placeStrokes, fitAndPlace } from './detailPlacement.js';
import { fitDetailFigure, DetailFitError } from './detailFit.js';
import { stretchFigure, rectFigure } from './detailTestFixtures.js';

const ZERO = { datums: { ds0: 0, dt0: 0 } };
// 矩形（幅 100・高さ 50）: 局所座標の頂点 4 つ (0,0) (100,0) (100,50) (0,50)。閉じ辺は描画側が補う
const IDENTITY = { ox: 0, oy: 0, sx: 1, sy: 0, tx: 0, ty: 1 };

test('placement: fitLocal は detailFit の fitDetailFigure と同一', () => {
  assert.equal(fitLocal, fitDetailFigure);
});

test('placement: 単位 frame は局所座標のまま（原点移動つき）', () => {
  const fitted = fitLocal(rectFigure(100, 50), ZERO);
  assert.deepEqual(placeStrokes(fitted, IDENTITY)[0].points, [[0, 0], [100, 0], [100, 50], [0, 50]]);
  assert.deepEqual(placeStrokes(fitted, { ...IDENTITY, ox: 1000, oy: 2000 })[0].points, [[1000, 2000], [1100, 2000], [1100, 2050], [1000, 2050]]);
});

test('placement: 鏡像 frame（sx=−1）は横だけ反転する', () => {
  const fitted = fitLocal(rectFigure(100, 50), ZERO);
  assert.deepEqual(placeStrokes(fitted, { ...IDENTITY, ox: 500, sx: -1 })[0].points, [[500, 0], [400, 0], [400, 50], [500, 50]]);
});

test('placement: 90° 回転 frame（s→図の下、t→図の左）', () => {
  const fitted = fitLocal(rectFigure(100, 50), ZERO);
  const rot = { ox: 0, oy: 0, sx: 0, sy: 1, tx: -1, ty: 0 };
  assert.deepEqual(placeStrokes(fitted, rot)[0].points, [[0, 0], [0, 100], [-50, 100], [-50, 0]]);
});

test('placement: t 軸の鏡像 frame（立面の上向き正）は縦だけ反転する', () => {
  const fitted = fitLocal(rectFigure(100, 50), ZERO);
  assert.deepEqual(placeStrokes(fitted, { ox: 0, oy: 1000, sx: 1, sy: 0, tx: 0, ty: -1 })[0].points, [[0, 1000], [100, 1000], [100, 950], [0, 950]]);
});

test("placement: 全要素に source==='detail'・id・closed・line が付く", () => {
  const fitted = fitLocal(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 70 } });
  const placed = placeStrokes(fitted, IDENTITY);
  assert.equal(placed.length, 1);
  for (const p of placed) assert.equal(p.source, DETAIL_PRIM_SOURCE);
  assert.equal(DETAIL_PRIM_SOURCE, 'detail');
  assert.equal(placed[0].id, 'a');
  assert.equal(placed[0].closed, false);
  assert.deepEqual(placed[0].line, { weightRole: 'medium', dashRole: 'solid' });
});

test('fitAndPlace: 成功時は配置済みストローク、fit が error ならそのまま返す', () => {
  const ok = fitAndPlace(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 105 } }, { ...IDENTITY, ox: 10 });
  assert.deepEqual(ok[0].points, [[10, 0], [30, 0], [30, 10], [30, 95], [30, 105], [10, 105]]);
  const ng = fitAndPlace(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 15 } }, IDENTITY);
  assert.equal(ng.error.code, DetailFitError.FIXED_EXCEEDS_TARGET);
  assert.deepEqual(ng, fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 15 } }));
  assert.equal(Array.isArray(ng), false);
});
