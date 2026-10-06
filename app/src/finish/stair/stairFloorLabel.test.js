import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stairFloorName, stairChainTitle, chainArrivalPlane } from './stairFloorLabel.js';

const P = (id, startFloor, stories = 1) => ({ id, startFloor, stories });

// 単独の階段（連鎖の先頭＝最後が同じ階）の表記。本番の組み立て（StairTab）と同じ: 出発階＋chainArrivalPlane
const soloTitle = (planes, planeId) =>
  stairChainTitle(0, planes.find(p => p.id === planeId), chainArrivalPlane(planes, planeId));

test('階1つの表記: 整数階は「階」付き・中間階は付かない・負階は B・plane なしは空', () => {
  assert.equal(stairFloorName(P('a', 2)), '2階');
  assert.equal(stairFloorName(P('a', -1)), 'B1階');
  assert.equal(stairFloorName(P('m', 1.5, 0.5)), '1ML');
  assert.equal(stairFloorName(null), '');
});

test('階1つの表記: 複数階ぶんの平面は出発側（最上の階番号）の規則', () => {
  assert.equal(stairFloorName(P('a', 2, 3)), '4階');
  assert.equal(stairFloorName(P('a', -3, 2)), 'B2階');
});

test('連鎖のグループ名: 出発階->到達階（最後の階段の階の直上）・N は index+1', () => {
  assert.equal(stairChainTitle(0, P('a', 1), P('d', 4)), '階段1（1->4階）');
  assert.equal(stairChainTitle(1, P('a', 1), P('b', 2)), '階段2（1->2階）');
  assert.equal(stairChainTitle(2, P('a', 1), P('m', 1.5, 0.5)), '階段3（1->1ML）');
  assert.equal(stairChainTitle(0, P('a', -1), P('b', 1)), '階段1（B1->1階）');
});

test('連鎖のグループ名: 最後の階段の上に採用階が無い（最上階の階段）なら到達階を空にする', () => {
  assert.equal(stairChainTitle(0, P('c', 3), undefined), '階段1（3階->）');
  assert.equal(stairChainTitle(1, P('m', 1.5, 0.5), null), '階段2（1ML->）');
});

test('【失敗系】連鎖のグループ名: 出発階の plane が引けなければ括弧を付けない（階段N のみ）', () => {
  assert.equal(stairChainTitle(0, undefined, undefined), '階段1');
  assert.equal(stairChainTitle(0, undefined, P('b', 2)), '階段1');
});

test('chainArrivalPlane（T4）: 3階建てで p2 で終わる→p3／p3 で終わる→undefined／無い id→undefined', () => {
  const planes = [P('p1', 1), P('p2', 2), P('p3', 3)];
  assert.equal(chainArrivalPlane(planes, 'p2'), planes[2]);
  assert.equal(chainArrivalPlane(planes, 'p1'), planes[1]);
  assert.equal(chainArrivalPlane(planes, 'p3'), undefined);
  assert.equal(chainArrivalPlane(planes, 'zzz'), undefined);
});

test('【失敗系】chainArrivalPlane: planes が空・undefined なら undefined', () => {
  assert.equal(chainArrivalPlane([], 'p1'), undefined);
  assert.equal(chainArrivalPlane(undefined, 'p1'), undefined);
});

test('単独の階段の表記（T5）: 3階建ての各階・最上階・地下・中間階・stories>1・地下の一般階', () => {
  const three = [P('a', 1), P('b', 2), P('c', 3)];
  assert.equal(soloTitle(three, 'a'), '階段1（1->2階）');
  assert.equal(soloTitle(three, 'b'), '階段1（2->3階）');
  assert.equal(soloTitle(three, 'c'), '階段1（3階->）');
  assert.equal(soloTitle([P('a', -1), P('b', 1)], 'a'), '階段1（B1->1階）');
  // 一般階（stories>1）の出発側は最上の階番号
  assert.equal(soloTitle([P('a', 2, 3), P('b', 5)], 'a'), '階段1（4->5階）');
  assert.equal(soloTitle([P('a', -1, 2), P('b', 2)], 'a'), '階段1（1->2階）');
  assert.equal(soloTitle([P('a', -3, 2), P('b', -1)], 'a'), '階段1（B2->B1階）');
  // 中間階
  const mid = [P('a', 1), P('m', 1.5, 0.5), P('b', 2)];
  assert.equal(soloTitle(mid, 'a'), '階段1（1->1ML）');
  assert.equal(soloTitle(mid, 'm'), '階段1（1ML->2階）');
  assert.equal(soloTitle([P('a', 1), P('m', 1.5, 0.5)], 'm'), '階段1（1ML->）');
});
