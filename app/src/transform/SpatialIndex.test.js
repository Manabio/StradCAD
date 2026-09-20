// SpatialIndex: 交点だけを索引し、query は距離順の配列を直接返す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpatialIndex } from './SpatialIndex.js';

function node(id, x, y) {
  return { id, clVertical: { value: x }, clHorizontal: { value: y } };
}

function makeIndex() {
  const index = new SpatialIndex();
  index.rebuild([node('far', 5000, 0), node('near', 100, 0), node('origin', 0, 0)]);
  return index;
}

test('SpatialIndex.query: 半径内の交点を距離順の配列で返す', () => {
  const res = makeIndex().query(0, 0, 200);
  assert.equal(Array.isArray(res), true);
  assert.deepEqual(res.map(e => e.id), ['origin', 'near']);
  assert.equal(res[1].dist2, 100 * 100);
});

test('【失敗系】SpatialIndex.query: 半径内に交点が無ければ空配列、getNode は未登録idでnull', () => {
  const index = makeIndex();
  assert.deepEqual(index.query(2500, 2500, 10), []);
  assert.equal(index.getNode('missing'), null);
  assert.equal(index.getNode('near').clVertical.value, 100);
});
