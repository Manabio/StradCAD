// 姿図の配置（PlacedFigure）の値クラス・回転の正規化・復元のテスト。roofZone.test.js と同じ方針。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacedFigure, PLACED_FIGURE_KEYS, normalizePlacedFigureRotation, restorePlacedFigures } from './placedFigure.js';

const data = (over = {}) => ({
  id: 'p1', figureKey: 'df-a', x: 1820, y: -455, rotationDeg: 270, mirror: true, zMm: 850, note: 'メモ', ...over,
});

test('normalizePlacedFigureRotation: 90 の整数倍を [0,360) に畳む（-90→270・450→90・360→0・-0→0）', () => {
  assert.equal(normalizePlacedFigureRotation(0), 0);
  assert.equal(normalizePlacedFigureRotation(90), 90);
  assert.equal(normalizePlacedFigureRotation(270), 270);
  assert.equal(normalizePlacedFigureRotation(360), 0);
  assert.equal(normalizePlacedFigureRotation(-90), 270);
  assert.equal(normalizePlacedFigureRotation(450), 90);
  assert.equal(normalizePlacedFigureRotation(-360), 0);
  assert.ok(Object.is(normalizePlacedFigureRotation(-0), 0), '-0 は 0');
});

test('【失敗系】normalizePlacedFigureRotation: 90 の倍数でない・非有限・非数は null', () => {
  for (const v of [45, 89.9999, -45, 91, NaN, Infinity, -Infinity, '90', null, undefined, {}]) {
    assert.equal(normalizePlacedFigureRotation(v), null, String(v));
  }
});

test('toData のキー集合は PLACED_FIGURE_KEYS と一致し、fromData と往復する', () => {
  const pf = new PlacedFigure(data());
  assert.deepEqual(Object.keys(pf.toData()).sort(), [...PLACED_FIGURE_KEYS].sort());
  assert.deepEqual(pf.toData(), data());
  assert.deepEqual(PlacedFigure.fromData(pf.toData()).toData(), data());
  assert.ok(Object.isFrozen(pf));
});

test('fromData: 回転は正規化され、mirror は === true だけ true、note は非文字列で空文字', () => {
  const pf = PlacedFigure.fromData(data({ rotationDeg: -90, mirror: 'true', note: 5 }));
  assert.equal(pf.rotationDeg, 270);
  assert.equal(pf.mirror, false);
  assert.equal(pf.note, '');
  assert.equal(PlacedFigure.fromData(data({ mirror: 1 })).mirror, false);
  assert.equal(PlacedFigure.fromData(data({ mirror: true })).mirror, true);
});

test('【失敗系】fromData: id・figureKey が空/非文字列、x・y・zMm が非有限、回転が不正なら null', () => {
  assert.equal(PlacedFigure.fromData(null), null);
  assert.equal(PlacedFigure.fromData('x'), null);
  for (const over of [
    { id: '' }, { id: 3 }, { id: undefined }, { figureKey: '' }, { figureKey: null },
    { x: NaN }, { x: '1' }, { y: Infinity }, { y: undefined }, { zMm: NaN }, { zMm: undefined },
    { rotationDeg: 45 }, { rotationDeg: NaN }, { rotationDeg: undefined },
  ]) {
    assert.equal(PlacedFigure.fromData(data(over)), null, JSON.stringify(over));
  }
});

test('with: 差し替えた新しい値を返し、元は変わらない。回転は正規化される', () => {
  const pf = new PlacedFigure(data());
  const next = pf.with({ x: 5, rotationDeg: 450, mirror: false });
  assert.notEqual(next, pf);
  assert.deepEqual(next.toData(), data({ x: 5, rotationDeg: 90, mirror: false }));
  assert.deepEqual(pf.toData(), data(), '元は不変');
});

test('【失敗系】with: 不正な回転・非有限・未知の項目・id の変更は RangeError', () => {
  const pf = new PlacedFigure(data());
  assert.throws(() => pf.with({ rotationDeg: 45 }), RangeError);
  assert.throws(() => pf.with({ x: NaN }), RangeError);
  assert.throws(() => pf.with({ figureKey: '' }), RangeError);
  assert.throws(() => pf.with({ bogus: 1 }), RangeError);
  assert.throws(() => pf.with({ id: 'other' }), RangeError);
});

test('【失敗系】constructor: 不正な値は RangeError（回転省略は 0・zMm 省略は 0）', () => {
  assert.throws(() => new PlacedFigure({ id: 'a', figureKey: 'k', x: 0, y: NaN }), RangeError);
  assert.throws(() => new PlacedFigure({ id: 'a', figureKey: 'k', x: 0, y: 0, rotationDeg: 45 }), RangeError);
  const pf = new PlacedFigure({ id: 'a', figureKey: 'k', x: 0, y: 0 });
  assert.equal(pf.rotationDeg, 0);
  assert.equal(pf.zMm, 0);
  assert.equal(pf.note, '');
});

test('constructor: rotationDeg・zMm を undefined で明示しても省略と同じく 0', () => {
  const p = new PlacedFigure({ id: 'u', figureKey: 'df-a', x: 10, y: 20, rotationDeg: undefined, zMm: undefined });
  assert.equal(p.rotationDeg, 0);
  assert.equal(p.zMm, 0);
});

test('restorePlacedFigures: 正常な配列は順序そのまま・凍結配列で返る', () => {
  const out = restorePlacedFigures([data({ id: 'a' }), data({ id: 'b', rotationDeg: 0 })]);
  assert.deepEqual(out.map(p => p.id), ['a', 'b']);
  assert.ok(Object.isFrozen(out));
  assert.ok(out.every(p => p instanceof PlacedFigure));
});

test('【失敗系】restorePlacedFigures: null・非配列は空の凍結配列、不正な要素は捨て、同じ id は先勝ち', () => {
  for (const v of [null, undefined, {}, 'x', 3]) {
    const out = restorePlacedFigures(v);
    assert.deepEqual(out, []);
    assert.ok(Object.isFrozen(out));
  }
  const out = restorePlacedFigures([
    data({ id: 'a', x: 1 }), data({ id: '' }), data({ id: 'bad', rotationDeg: 45 }), null,
    data({ id: 'a', x: 2 }), data({ id: 'c' }),
  ]);
  assert.deepEqual(out.map(p => [p.id, p.x]), [['a', 1], ['c', 1820]], '重複 id は先勝ち・不正は捨てる');
});
