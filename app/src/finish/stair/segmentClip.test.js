// segmentClip.js（軸平行矩形に対する線分クリップ・点内外判定）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInRects, clipSegmentToRect, clipSegmentsToRects } from './segmentClip.js';

const RECT = { x1: 0, y1: 0, x2: 100, y2: 100 };

test('pointInRects: 矩形群の内外判定（境界を含む）', () => {
  assert.equal(pointInRects([RECT], 50, 50), true);
  assert.equal(pointInRects([RECT], 0, 100), true);
  assert.equal(pointInRects([RECT], 50, 150), false);
  assert.equal(pointInRects([], 50, 50), false);
});

test('clipSegmentToRect: 境界をまたぐ線分は交点で切られる（中点判定では切れない不良の対策）', () => {
  // 中点(50,100)は矩形の内側判定になるが、線分は境界 y=100 を突き抜けている
  const out = clipSegmentToRect({ x1: 50, y1: 50, x2: 50, y2: 150 }, RECT);
  assert.deepEqual([out.x1, out.y1, out.x2, out.y2], [50, 50, 50, 100]);
});

test('clipSegmentToRect: 両端が外側でも横断していれば内側の区間を返す', () => {
  const out = clipSegmentToRect({ x1: -50, y1: 50, x2: 150, y2: 50 }, RECT);
  assert.deepEqual([out.x1, out.x2], [0, 100]);
});

test('clipSegmentToRect: 完全に外側・境界を掠めるだけの線分は null', () => {
  assert.equal(clipSegmentToRect({ x1: 200, y1: 0, x2: 300, y2: 0 }, RECT), null);
  assert.equal(clipSegmentToRect({ x1: -50, y1: 100, x2: 0, y2: 100 }, RECT), null); // 角で点に退化
});

test('clipSegmentToRect: 付随プロパティ（thin/side/port 等）を保持する', () => {
  const out = clipSegmentToRect({ x1: 50, y1: 50, x2: 50, y2: 150, side: true, port: 'arrival' }, RECT);
  assert.equal(out.side, true);
  assert.equal(out.port, 'arrival');
});

test('clipSegmentsToRects: 矩形が空／未指定なら安全側でクリップしない', () => {
  const segs = [{ x1: 200, y1: 0, x2: 300, y2: 0 }];
  assert.deepEqual(clipSegmentsToRects(segs, []), segs);
  assert.deepEqual(clipSegmentsToRects(segs, null), segs);
});

test('clipSegmentsToRects: 隣接する複数矩形をまたぐ線分は接する断片になる', () => {
  const rects = [RECT, { x1: 100, y1: 0, x2: 200, y2: 100 }];
  const out = clipSegmentsToRects([{ x1: -50, y1: 50, x2: 250, y2: 50 }], rects);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(s => [s.x1, s.x2]), [[0, 100], [100, 200]]);
});
