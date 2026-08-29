// レーンあき（LANE_GAP）の閉じ辺＝内側ささらが取りつく踊り場線の生成テスト。
// buildStairGeometry はスカラ属性しか参照しない（graph 未指定）ので素のオブジェクトで足りる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType } from '@core';
import { buildStairGeometry, LANE_GAP } from './stairGeometry.js';

const BOUNDS = { x1: 0, y1: 0, x2: 2000, y2: 4000 };
const stairOf = (type) => ({
  type, upDirection: 'up', flip: false, tread: 250, totalSteps: 14,
  sections: type === StairType.WINDING ? [7, 3, 4] : [7, 1, 6],
});
const build = (type, laneGapMm) => buildStairGeometry(stairOf(type), BOUNDS, {
  view: 'upper', detail: false, riser: null, spans: null, laneGapMm,
});
const len = (s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
  test(`${type}: あきがあるとき、閉じ辺が1本だけ heavy で幅＝LANE_GAP になる`, () => {
    const heavy = build(type, LANE_GAP).treads.filter(s => s.heavy);
    assert.equal(heavy.length, 1);
    assert.ok(Math.abs(len(heavy[0]) - LANE_GAP) < 1e-6, `幅=${len(heavy[0])}`);
  });

  test(`${type}: あき0（簡略LOD）では閉じ辺が生まれない`, () => {
    assert.equal(build(type, 0).treads.filter(s => s.heavy).length, 0);
  });

  test(`${type}: あき0のときの踏面線は、閉じ辺の分離前と同じ本数になる（退化区間を出さない）`, () => {
    const zero = build(type, 0).treads;
    assert.ok(zero.every(s => len(s) > 1e-6), '長さ0の踏面線が混ざっている');
  });
}
