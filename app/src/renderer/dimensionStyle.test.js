// 通り芯の長鎖線（gridLineDash）の単体テスト。比率は線幅基準で、周期は 36d。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_LINE_DASH_RATIO, gridLineDash, OPENING_CROSS_DASH_RATIO, openingCrossDash } from './dimensionStyle.js';

test('gridLineDash: 線幅1pxで [24,3,6,3]', () => {
  assert.deepEqual(gridLineDash(1), [24, 3, 6, 3]);
});

test('gridLineDash: 線幅2pxで [48,6,12,6]（比率は線幅に比例）', () => {
  assert.deepEqual(gridLineDash(2), [48, 6, 12, 6]);
});

test('gridLineDash: 周期は 36d、比率定数は書き換え不可', () => {
  for (const d of [1, 2, 3]) {
    assert.equal(gridLineDash(d).reduce((a, b) => a + b, 0), 36 * d);
  }
  assert.ok(Object.isFrozen(GRID_LINE_DASH_RATIO));
});

test('openingCrossDash: 線幅2pxで [288,12,12,12]、周期は 162d、比率定数は書き換え不可', () => {
  assert.deepEqual(openingCrossDash(2), [288, 12, 12, 12]);
  assert.equal(openingCrossDash(1).reduce((a, b) => a + b, 0), 162);
  assert.ok(Object.isFrozen(OPENING_CROSS_DASH_RATIO));
});
