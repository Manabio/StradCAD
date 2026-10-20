// 階高の変更に追従する階段の蹴上（stairRiserFollow.js。純）の不変条件。階設定表 S8。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stairRiserKey, stairItemsOfGraph, planesAfterUpdates, floorHeightAboveIn, stairRiserChanges, stairRiserChangesForEdit,
  formatRiserPair, riserChangeLine, riserChangeToastMessage,
} from './stairRiserFollow.js';
import { computeFloorHeightEdit } from '../../floorHeights.js';

const P = (id, elevation, startFloor = 1, stories = 1) => ({ id, name: id, elevation, startFloor, stories });
const item = (planeId, stairId, totalSteps, explicitRiser = null, label = `階段(${stairId})`) => ({ planeId, stairId, totalSteps, explicitRiser, label });

test('stairRiserKey / stairItemsOfGraph: 階 id と階段 id の組。明示 riser の有無を拾う', () => {
  assert.equal(stairRiserKey('p1', 's1'), 'p1:s1');
  const graph = { stairs: [{ id: 'a', totalSteps: 15, riser: 200 }, { id: 'b', totalSteps: 14, riser: null }, { id: 'c', totalSteps: 13 }] };
  assert.deepEqual(stairItemsOfGraph('p2', graph), [
    { planeId: 'p2', stairId: 'a', totalSteps: 15, explicitRiser: 200 },
    { planeId: 'p2', stairId: 'b', totalSteps: 14, explicitRiser: null },
    { planeId: 'p2', stairId: 'c', totalSteps: 13, explicitRiser: null },
  ]);
  assert.deepEqual(stairItemsOfGraph('p2', null), []);
});

test('floorHeightAboveIn: 上階との差。最上階・id なしは null', () => {
  const list = [{ id: 'a', elevation: 0 }, { id: 'b', elevation: 3000 }, { id: 'c', elevation: 6200 }];
  assert.equal(floorHeightAboveIn(list, 'a'), 3000);
  assert.equal(floorHeightAboveIn(list, 'b'), 3200);
  assert.equal(floorHeightAboveIn(list, 'c'), null);
  assert.equal(floorHeightAboveIn(list, 'zzz'), null);
});

test('自階の階高の変更: その階の階段だけが対象。明示 riser は前の値(明示)→後の値(階高/総段数)、自動は階高/総段数どうし', () => {
  const planes = [P('a', 0), P('b', 3000), P('c', 6000)];
  const items = [item('a', 'sa', 15, 200), item('b', 'sb', 15), item('c', 'sc', 15, 180)];
  const edit = computeFloorHeightEdit(planes, { heights: { a: 3300 } }, 2900, 0);
  const changes = stairRiserChangesForEdit(items, planes, edit.updates);
  assert.deepEqual(changes.map(c => [c.planeId, c.explicit, c.from, c.to]), [['a', true, 200, 220]]);
  // 自動の階段（b）: 階高 3000→3300
  const editB = computeFloorHeightEdit(planes, { heights: { b: 3300 } }, 2900, 0);
  const cb = stairRiserChangesForEdit(items, planes, editB.updates);
  assert.deepEqual(cb.map(c => [c.planeId, c.explicit, c.from, c.to]), [['b', false, 200, 220]]);
});

test('総段数を保つ: 新しい蹴上＝新しい階高÷総段数（明示値と階高/総段数が食い違っていても後の値は階高だけで決まる）', () => {
  const planes = [P('a', 0), P('b', 3000)];
  const edit = computeFloorHeightEdit(planes, { heights: { a: 3200 } }, 2900, 0);
  const [c] = stairRiserChangesForEdit([item('a', 's', 16, 190)], planes, edit.updates);
  assert.equal(c.from, 190);
  assert.equal(c.to, 200);
  assert.equal(c.totalSteps, 16);
});

test('複層(2-3階の Plane)の階高変更: 全高(上階 elevation−自階 elevation)で蹴上が決まる。層数ぶん倍で効く', () => {
  const planes = [P('a', 0), P('m', 3000, 2, 2), P('t', 9000, 4)];
  // m の1層分 3000→3100: 全高 6000→6200
  const edit = computeFloorHeightEdit(planes, { heights: { m: 3100 } }, 2900, 0);
  const [c] = stairRiserChangesForEdit([item('m', 's', 20)], planes, edit.updates);
  assert.deepEqual([c.from, c.to], [300, 310]);
});

test('地階の階高の変更で地階側がずれる: 地階の階段が対象で、1FL の階 a の階段は対象外', () => {
  const planes = [P('b1', -3000, -1), P('a', 0), P('b', 3000, 2)];
  const edit = computeFloorHeightEdit(planes, { heights: { b1: 3200 } }, 2900, 0);
  assert.equal(edit.updates.find(u => u.id === 'b1').elevation, -3200);
  const changes = stairRiserChangesForEdit([item('b1', 'sb1', 16), item('a', 'sa', 15)], planes, edit.updates);
  assert.deepEqual(changes.map(c => [c.planeId, c.from, c.to]), [['b1', 3000 / 16, 3200 / 16]]);
});

test('上の階の階高の変更でずれても、自階の floorHeightAbove が変わらなければ対象外', () => {
  const planes = [P('a', 0), P('b', 3000), P('c', 6000)];
  const edit = computeFloorHeightEdit(planes, { heights: { b: 3300 } }, 2900, 0);
  const changes = stairRiserChangesForEdit([item('a', 'sa', 15), item('c', 'sc', 15)], planes, edit.updates);
  assert.deepEqual(changes, [], 'a は階高不変・c は最上階');
});

test('最上階の階段は出ない（階高が求まらない）。最上階の階高(topStoryHeightMm)の変更も階段に影響しない', () => {
  const planes = [P('a', 0), P('b', 3000)];
  const edit = computeFloorHeightEdit(planes, { heights: { b: 2600 } }, 2900, 0);
  assert.deepEqual(stairRiserChangesForEdit([item('b', 'sb', 15, 180)], planes, edit.updates), []);
});

test('変化が無ければ出ない: 階高不変・updates 空(GL だけ)・items 空・蹴上の値が同じ', () => {
  const planes = [P('a', 0), P('b', 3000)];
  assert.deepEqual(stairRiserChangesForEdit([item('a', 's', 15)], planes, []), []);
  assert.deepEqual(stairRiserChangesForEdit([], planes, [{ id: 'b', elevation: 3300 }]), []);
  assert.deepEqual(stairRiserChangesForEdit(null, planes, [{ id: 'b', elevation: 3300 }]), []);
  // 明示 riser が変更後の 階高/総段数 と一致していれば値は変わらない
  assert.deepEqual(stairRiserChangesForEdit([item('a', 's', 15, 220)], planes, [{ id: 'b', elevation: 3300 }]), []);
});

test('【失敗系】不正な入力（階が存在しない階段・総段数 0）でも例外にならない。総段数 0 は 1 で割る', () => {
  const before = [{ id: 'a', elevation: 0 }, { id: 'b', elevation: 3000 }];
  const after = planesAfterUpdates([P('a', 0), P('b', 3000)], [{ id: 'b', elevation: 3300 }]);
  assert.deepEqual(stairRiserChanges([item('zzz', 's', 15)], before, after), []);
  const [c] = stairRiserChanges([item('a', 's', 0)], before, after);
  assert.deepEqual([c.from, c.to], [3000, 3300]);
});

test('planesAfterUpdates: updates の elevation を重ねる。元の planes は変えない', () => {
  const planes = [P('a', 0), P('b', 3000)];
  assert.deepEqual(planesAfterUpdates(planes, [{ id: 'b', elevation: 3300 }]), [{ id: 'a', elevation: 0 }, { id: 'b', elevation: 3300 }]);
  assert.equal(planes[1].elevation, 3000);
});

test('表記: 整数に丸めて違えば整数、同じになるときだけ小数1桁。確認の1行・トーストの文言', () => {
  assert.deepEqual(formatRiserPair(200, 220), ['200', '220']);
  assert.deepEqual(formatRiserPair(200, 200.07), ['200', '200.1']);
  const c = { label: '階段1（1->2階）', from: 200, to: 220 };
  assert.equal(riserChangeLine(c), '階段1（1->2階）: 蹴上 200→220');
  assert.equal(riserChangeToastMessage([c, { label: '階段2（2->3階）', from: 187.5, to: 200 }]),
    '階段1（1->2階）の蹴上を 200→220 に変更しました／階段2（2->3階）の蹴上を 188→200 に変更しました');
});
