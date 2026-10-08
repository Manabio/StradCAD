// planGeometry.js（立体モデルと解決器が共有する純幾何）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRect, isValidRect, isInsideFootprint, rectsOutlineSegments, footprintBounds,
} from './planGeometry.js';

const R = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

test('normalizeRect: x1<x2・y1<y2 に並べ替える。isValidRect は幅/高さ0・非有限を弾く', () => {
  assert.deepEqual(normalizeRect(R(10, 20, 0, 5)), R(0, 5, 10, 20));
  assert.equal(isValidRect(R(0, 0, 10, 10)), true);
  assert.equal(isValidRect(R(0, 0, 0, 10)), false);
  assert.equal(isValidRect(R(0, 0, 10, NaN)), false);
  assert.equal(isValidRect(null), false);
});

test('isInsideFootprint: 矩形は厳密な内側（辺の上は外）。穴の内側は外', () => {
  const fp = { rects: [R(0, 0, 100, 100)], holes: [R(40, 40, 60, 60)] };
  assert.equal(isInsideFootprint(fp, 20, 20), true);
  assert.equal(isInsideFootprint(fp, 50, 50), false, '穴の中');
  assert.equal(isInsideFootprint(fp, 40, 50), true, '穴の縁の上は穴の外＝床');
  assert.equal(isInsideFootprint(fp, 0, 50), false, '床の縁の上は外');
  assert.equal(isInsideFootprint(fp, 150, 50), false);
});

test('isInsideFootprint: 多角形は偶奇規則（L字の凹みは外）。辺・頂点の上は外', () => {
  const L = { poly: [0, 0, 100, 0, 100, 50, 50, 50, 50, 100, 0, 100] };
  assert.equal(isInsideFootprint(L, 25, 75), true);
  assert.equal(isInsideFootprint(L, 75, 25), true);
  assert.equal(isInsideFootprint(L, 75, 75), false, 'L字の凹み');
  assert.equal(isInsideFootprint(L, 50, 75), false, '辺の上');
  assert.equal(isInsideFootprint(L, 100, 50), false, '頂点の上');
});

test('isInsideFootprint・失敗系: null・形の違う footprint は false', () => {
  assert.equal(isInsideFootprint(null, 0, 0), false);
  assert.equal(isInsideFootprint({}, 0, 0), false);
  assert.equal(isInsideFootprint({ rects: [] }, 0, 0), false);
});

test('rectsOutlineSegments: 隣り合う矩形の共有辺は打ち消され、外周だけが残る', () => {
  const segs = rectsOutlineSegments([R(0, 0, 10, 10), R(10, 0, 20, 10)]);
  assert.ok(segs.length > 0);
  assert.ok(!segs.some(s => s.isVertical && s.value === 10), '共有辺 x=10 は消える');
  assert.deepEqual(segs.filter(s => s.isVertical).map(s => s.value).sort((a, b) => a - b), [0, 20]);
  const horizontalLen = segs.filter(s => !s.isVertical).reduce((sum, s) => sum + (s.hi - s.lo), 0);
  assert.equal(horizontalLen, 40, '上下の辺は合計 20×2');
  assert.deepEqual(rectsOutlineSegments([]), []);
  assert.deepEqual(rectsOutlineSegments(undefined), []);
});

test('footprintBounds: 矩形・多角形の外接矩形。空は null', () => {
  assert.deepEqual(footprintBounds({ rects: [R(0, 0, 10, 10), R(5, -5, 30, 5)] }), R(0, -5, 30, 10));
  assert.deepEqual(footprintBounds({ poly: [1, 2, 9, 2, 5, 8] }), R(1, 2, 9, 8));
  assert.equal(footprintBounds({ rects: [] }), null);
  assert.equal(footprintBounds(null), null);
});
