// 姿図の配置の一覧操作（純関数）のテスト。入力の凍結配列を変えないことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacedFigure } from '../../core/placedFigure.js';
import { addPlacedFigure, updatePlacedFigure, removePlacedFigure } from './placedFigureOps.js';

const pf = (id, x = 300) => new PlacedFigure({ id, figureKey: 'df-a', x, y: 100, rotationDeg: 90, zMm: 850 });
const frozen = (...items) => Object.freeze(items);

test('addPlacedFigure: 末尾に足した凍結配列を返し、入力は変えない', () => {
  const list = frozen(pf('a'));
  const out = addPlacedFigure(list, pf('b'));
  assert.deepEqual(out.map(p => p.id), ['a', 'b']);
  assert.ok(Object.isFrozen(out));
  assert.deepEqual(list.map(p => p.id), ['a']);
  assert.ok(Object.isFrozen(list));
  assert.equal(out[0], list[0], '既存要素は同一参照');
});

test('updatePlacedFigure: 該当 id だけ差し替えた凍結配列を返し、入力・他要素は不変', () => {
  const list = frozen(pf('a', 1), pf('b', 2));
  const out = updatePlacedFigure(list, 'b', { x: 99, rotationDeg: 270 });
  assert.deepEqual(out.map(p => [p.id, p.x, p.rotationDeg]), [['a', 1, 90], ['b', 99, 270]]);
  assert.ok(Object.isFrozen(out));
  assert.equal(out[0], list[0]);
  assert.equal(list[1].x, 2, '入力の要素は不変');
  assert.equal(list.length, 2);
});

test('removePlacedFigure: 該当 id を除いた凍結配列を返し、入力は変えない', () => {
  const list = frozen(pf('a'), pf('b'));
  const out = removePlacedFigure(list, 'a');
  assert.deepEqual(out.map(p => p.id), ['b']);
  assert.ok(Object.isFrozen(out));
  assert.deepEqual(list.map(p => p.id), ['a', 'b']);
});

test('【失敗系】update／remove: 無い id は null（入力は不変）', () => {
  const list = frozen(pf('a'));
  assert.equal(updatePlacedFigure(list, 'zz', { x: 1 }), null);
  assert.equal(removePlacedFigure(list, 'zz'), null);
  assert.equal(removePlacedFigure(frozen(), 'a'), null);
  assert.equal(list.length, 1);
});

test('【失敗系】add: PlacedFigure でない plain object は RangeError（入力は不変）', () => {
  const list = frozen(pf('a'));
  assert.throws(() => addPlacedFigure(list, { id: 'b', figureKey: 'df-a', x: 1, y: 2 }), RangeError);
  assert.equal(list.length, 1);
});

test('【失敗系】add: 重複 id は RangeError／update: 不正な値は RangeError（入力は不変）', () => {
  const list = frozen(pf('a'));
  assert.throws(() => addPlacedFigure(list, pf('a')), RangeError);
  assert.throws(() => updatePlacedFigure(list, 'a', { rotationDeg: 45 }), RangeError);
  assert.throws(() => updatePlacedFigure(list, 'a', { id: 'b' }), RangeError);
  assert.equal(list.length, 1);
  assert.equal(list[0].rotationDeg, 90);
});
