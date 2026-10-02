import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roofShortSpanMm } from './roofGeometry.js';

const rect = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

test('roofShortSpanMm: 1つの矩形は短辺', () => {
  assert.equal(roofShortSpanMm([rect(0, 0, 4000, 2000)]), 2000);
  assert.equal(roofShortSpanMm([rect(0, 0, 1500, 6000)]), 1500);
});

test('roofShortSpanMm: セルに分割された矩形（格子）も全体の短辺', () => {
  // 4000x3000 を 2x2 のセルに分割
  const cells = [rect(0, 0, 2000, 1500), rect(2000, 0, 4000, 1500), rect(0, 1500, 2000, 3000), rect(2000, 1500, 4000, 3000)];
  assert.equal(roofShortSpanMm(cells), 3000);
});

test('roofShortSpanMm: L字は2本の腕のうち太い方の幅（分割の取り方に依存しない）', () => {
  // 横腕 6000x2000（y:0..2000）＋縦腕 3000 幅（x:0..3000, y:2000..7000）。内接矩形の短辺の最大は縦腕の 3000
  const lShape = [rect(0, 0, 6000, 2000), rect(0, 2000, 3000, 7000)];
  assert.equal(roofShortSpanMm(lShape), 3000);
  // 同じ L 字を別の分割（縦割り）で与えても同じ
  const lShapeOther = [rect(0, 0, 3000, 7000), rect(3000, 0, 6000, 2000)];
  assert.equal(roofShortSpanMm(lShapeOther), 3000);
});

test('roofShortSpanMm: 離れた2成分はそれぞれ測った最大', () => {
  const two = [rect(0, 0, 1000, 8000), rect(5000, 0, 9000, 3000)];
  assert.equal(roofShortSpanMm(two), 3000);
});

test('roofShortSpanMm: 辺で接する2セルは1つの矩形として測る（ちょうど 3640 の境界）', () => {
  const cells = [rect(0, 0, 2000, 3640), rect(2000, 0, 5000, 3640)];
  assert.equal(roofShortSpanMm(cells), 3640);
});

test('【失敗系】roofShortSpanMm: 空・null・面積0だけなら 0', () => {
  assert.equal(roofShortSpanMm([]), 0);
  assert.equal(roofShortSpanMm(null), 0);
  assert.equal(roofShortSpanMm(undefined), 0);
  assert.equal(roofShortSpanMm([rect(0, 0, 0, 1000), null]), 0);
});

test('roofShortSpanMm: 辺が一致しない（角でだけ接する）2矩形は連結せずそれぞれ測る', () => {
  const diag = [rect(0, 0, 2000, 2000), rect(2000, 2000, 5000, 4000)];
  assert.equal(roofShortSpanMm(diag), 2000);
});
