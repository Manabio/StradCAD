import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stairFloorLabels } from './stairFloorLabel.js';

const P = (id, startFloor, stories = 1) => ({ id, startFloor, stories });

test('1階の階段は 1->2階、下は無い', () => {
  const planes = [P('a', 1), P('b', 2)];
  assert.deepEqual(stairFloorLabels(planes, 'a'), { self: '1->2階', lower: null });
});

test('2階: 自階 2->3階・直下階 1->2階', () => {
  const planes = [P('a', 1), P('b', 2), P('c', 3)];
  assert.deepEqual(stairFloorLabels(planes, 'b'), { self: '2->3階', lower: '1->2階' });
});

test('地下1階→1階: B1->1階（0階を飛ばす）', () => {
  const planes = [P('a', -1), P('b', 1)];
  assert.deepEqual(stairFloorLabels(planes, 'a'), { self: 'B1->1階', lower: null });
  assert.equal(stairFloorLabels(planes, 'b').lower, 'B1->1階');
});

test('一般階（stories>1）の出発側は最上の階番号', () => {
  const planes = [P('a', 2, 3), P('b', 5)];
  assert.equal(stairFloorLabels(planes, 'a').self, '4->5階');
  assert.equal(stairFloorLabels(planes, 'b').lower, '4->5階');
  // 地下をまたぐ: -1 から2階ぶん → 0 を飛ばして 1
  assert.equal(stairFloorLabels([P('a', -1, 2), P('b', 2)], 'a').self, '1->2階');
});

test('中間階は makeFloorName 表記で末尾の階を付けない', () => {
  const planes = [P('a', 1), P('m', 1.5, 0.5), P('b', 2)];
  assert.equal(stairFloorLabels(planes, 'a').self, '1->1ML');
  assert.equal(stairFloorLabels(planes, 'm').self, '1ML->2階');
  assert.equal(stairFloorLabels(planes, 'm').lower, '1->1ML');
});

test('最上階は ->（上階なし）', () => {
  const planes = [P('a', 1), P('b', 2)];
  assert.equal(stairFloorLabels(planes, 'b').self, '2階->（上階なし）');
  // 中間階が最上階なら「階」を付けない
  assert.equal(stairFloorLabels([P('a', 1), P('m', 1.5, 0.5)], 'm').self, '1ML->（上階なし）');
});

test('地下の一般階の出発側は最上の階番号（B2->B1階）', () => {
  assert.equal(stairFloorLabels([P('a', -3, 2), P('b', -1)], 'a').self, 'B2->B1階');
});

test('アクティブ階が planes に無い・planes が空・未定義は null', () => {
  const none = { self: null, lower: null };
  assert.deepEqual(stairFloorLabels([P('a', 1)], 'alt'), none);
  assert.deepEqual(stairFloorLabels([], 'a'), none);
  assert.deepEqual(stairFloorLabels(undefined, 'a'), none);
  assert.deepEqual(stairFloorLabels([P('a', 1)], undefined), none);
});
