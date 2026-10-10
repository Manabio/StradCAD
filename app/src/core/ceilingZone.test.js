// CeilingZone（天井区画の値クラス）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CeilingZone, CEILING_ZONE_KEYS, CeilingShape, restoreCeilingZones,
  CEILING_SHAPE_DIM_COUNT, SLOPE_DIRS_DEG, ARC_AXES_DEG, validCeilingDims, normalizeCeilingShape,
} from '../core.js';
import { isEmptyCeilingZone } from './ceilingZone.js';

const FULL = { id: 'z1', cells: ['b:b:b:b', 'a:a:a:a'], heightMm: 2700, shape: CeilingShape.SLOPE, dims: [1200, 90] };

test('toData/fromData: 全項目を既定以外にした区画が往復し、cells は昇順になる。キー集合は CEILING_ZONE_KEYS', () => {
  const z = CeilingZone.fromData(FULL);
  const data = z.toData();
  assert.deepEqual(Object.keys(data).sort(), [...CEILING_ZONE_KEYS].sort());
  assert.deepEqual(data, { id: 'z1', cells: ['a:a:a:a', 'b:b:b:b'], heightMm: 2700, shape: 'slope', dims: [1200, 90] });
  assert.deepEqual(CeilingZone.fromData(data).toData(), data);
});

test('不変: 区画・cells・dims は凍結されている。withCells／withHeight は新しい区画を返す', () => {
  const z = CeilingZone.fromData(FULL);
  assert.ok(Object.isFrozen(z) && Object.isFrozen(z.cells) && Object.isFrozen(z.dims));
  const z2 = z.withCells(['c:c:c:c']).withHeight(2400);
  assert.deepEqual(z2.cells, ['c:c:c:c']);
  assert.equal(z2.heightMm, 2400);
  assert.equal(z.heightMm, 2700, '元は変わらない');
});

test('【失敗系】fromData: id 欠落・空・非文字列と null は null', () => {
  assert.equal(CeilingZone.fromData({ cells: ['a'] }), null);
  assert.equal(CeilingZone.fromData({ id: '', cells: ['a'] }), null);
  assert.equal(CeilingZone.fromData({ id: 5, cells: ['a'] }), null);
  assert.equal(CeilingZone.fromData(null), null);
  assert.equal(CeilingZone.fromData(undefined), null);
});

test('【失敗系】fromData: heightMm の 0・負・NaN・Infinity・非数は null。未知 shape は flat。平面の dims は []（正規化）。cells は文字列だけ・重複除去・昇順', () => {
  for (const bad of [0, -5, NaN, Infinity, '2400', undefined, null]) {
    assert.equal(CeilingZone.fromData({ id: 'z', cells: ['a'], heightMm: bad }).heightMm, null, String(bad));
  }
  assert.equal(CeilingZone.fromData({ id: 'z', cells: ['a'], heightMm: 0.5 }).heightMm, 0.5);
  assert.equal(CeilingZone.fromData({ id: 'z', cells: ['a'], shape: 'pyramid' }).shape, 'flat');
  assert.equal(CeilingZone.fromData({ id: 'z', cells: ['a'], shape: 'slope', dims: [500, 0] }).shape, 'slope');
  assert.deepEqual(CeilingZone.fromData({ id: 'z', cells: ['a'], dims: [1, NaN, '2', Infinity, 3] }).dims, [], '平面の寸法は持たない（S6a の正規化）');
  assert.deepEqual(CeilingZone.fromData({ id: 'z', cells: ['c', 'a', 'c', '', 7, null, 'b'] }).cells, ['a', 'b', 'c']);
  assert.deepEqual(CeilingZone.fromData({ id: 'z', cells: 'abc' }).cells, [], 'cells が配列でなければ空');
});

test('isEmptyCeilingZone: セルなし、または 高さ null・flat・寸法なし が空', () => {
  assert.equal(isEmptyCeilingZone(new CeilingZone({ id: 'z', cells: [], heightMm: 2400 })), true);
  assert.equal(isEmptyCeilingZone(new CeilingZone({ id: 'z', cells: ['a'], heightMm: null })), true);
  assert.equal(isEmptyCeilingZone(new CeilingZone({ id: 'z', cells: ['a'], heightMm: 2400 })), false);
  assert.equal(isEmptyCeilingZone(new CeilingZone({ id: 'z', cells: ['a'], heightMm: null, shape: 'dome' })), false);
  assert.equal(isEmptyCeilingZone(new CeilingZone({ id: 'z', cells: ['a'], heightMm: null, dims: [1] })), false);
});

test('restoreCeilingZones: 不正・空の区画を捨て、区画をまたいだ生キーの重複は先勝ちで後から除く。凍結配列を返す', () => {
  const out = restoreCeilingZones([
    { id: 'z1', cells: ['a', 'b'], heightMm: 2400 },
    null,
    { id: '', cells: ['q'], heightMm: 2400 },          // id なし
    { id: 'z2', cells: ['b', 'c'], heightMm: 2600 },   // b は z1 が先勝ち
    { id: 'z3', cells: ['a'], heightMm: 2800 },        // 全部取られて空 → 捨てる
    { id: 'z4', cells: ['d'], heightMm: null },        // 指定なし → 捨てる
    { id: 'z1', cells: ['e'], heightMm: 3000 },        // id 重複は後を捨てる
  ]);
  assert.deepEqual(out.map(z => z.toData()), [
    { id: 'z1', cells: ['a', 'b'], heightMm: 2400, shape: 'flat', dims: [] },
    { id: 'z2', cells: ['c'], heightMm: 2600, shape: 'flat', dims: [] },
  ]);
  assert.ok(Object.isFrozen(out));
});

test('CEILING_SHAPE_DIM_COUNT と列挙: 形状ごとの個数・向き・軸', () => {
  assert.deepEqual({ ...CEILING_SHAPE_DIM_COUNT }, { flat: 0, slope: 2, arc: 2, dome: 1 });
  assert.deepEqual([...SLOPE_DIRS_DEG], [0, 90, 180, 270]);
  assert.deepEqual([...ARC_AXES_DEG], [0, 90]);
  assert.deepEqual(Object.keys(CEILING_SHAPE_DIM_COUNT).sort(), Object.values(CeilingShape).sort(), '全形状に個数がある');
});

test('validCeilingDims: 個数が過不足なく、ライズ>0・向き/軸が列挙値のときだけ true', () => {
  assert.equal(validCeilingDims('flat', []), true);
  assert.equal(validCeilingDims('slope', [1200, 270]), true);
  assert.equal(validCeilingDims('arc', [300, 90]), true);
  assert.equal(validCeilingDims('dome', [500]), true);
  for (const [shape, dims] of [['flat', [1]], ['slope', [1200]], ['slope', [1200, 90, 1]], ['slope', [0, 90]], ['slope', [-5, 90]],
    ['slope', [1200, 45]], ['slope', [NaN, 90]], ['slope', [1200, Infinity]], ['arc', [300, 180]], ['dome', []], ['dome', [0]],
    ['pyramid', []], ['slope', null], ['slope', ['1200', 90]]]) {
    assert.equal(validCeilingDims(shape, dims), false, `${shape} ${JSON.stringify(dims)}`);
  }
});

test('【失敗系】normalizeCeilingShape: 未知 shape・個数不足・非有限・ライズ 0/負・向き 45 は flat・[] に落ちる。余分な dims は切り詰め', () => {
  const FLAT = { shape: 'flat', dims: [] };
  for (const [shape, dims] of [['pyramid', [1]], [undefined, undefined], ['slope', [1200]], ['slope', [NaN, 90]], ['slope', [0, 90]],
    ['slope', [-1, 90]], ['slope', [1200, 45]], ['arc', [300, 7]], ['dome', []], ['dome', null], ['slope', 'ab']]) {
    assert.deepEqual(normalizeCeilingShape(shape, dims), FLAT, `${shape} ${JSON.stringify(dims)}`);
  }
  assert.deepEqual(normalizeCeilingShape('slope', [1200, 90, 7, 8]), { shape: 'slope', dims: [1200, 90] }, '余分な dims は切り詰め');
  assert.deepEqual(normalizeCeilingShape('dome', [500, NaN]), { shape: 'dome', dims: [500] }, '切り詰めた後で検査する');
  assert.deepEqual(normalizeCeilingShape('flat', [5]), FLAT, '平面は寸法なし');
});

test('【失敗系】restoreCeilingZones: 壊れた形状・寸法の区画は捨てずに flat・[] へ落ち、セルと高さは残る。高さ null で落ちた区画は指定なしなので捨てる', () => {
  const out = restoreCeilingZones([
    { id: 'a', cells: ['x'], heightMm: 2600, shape: 'slope', dims: [0, 90] },   // ライズ 0
    { id: 'b', cells: ['y'], heightMm: 2500, shape: 'slope', dims: [1200, 45] }, // 向き 45
    { id: 'c', cells: ['z'], heightMm: 2400, shape: 'pyramid', dims: [1] },
    { id: 'd', cells: ['w'], heightMm: 2300, shape: 'slope', dims: [1200, 0, 9] }, // 余分は切り詰め（有効）
    { id: 'e', cells: ['v'], heightMm: null, shape: 'slope', dims: [] },           // flat・null＝指定なし
  ]);
  assert.deepEqual(out.map(z => z.toData()), [
    { id: 'a', cells: ['x'], heightMm: 2600, shape: 'flat', dims: [] },
    { id: 'b', cells: ['y'], heightMm: 2500, shape: 'flat', dims: [] },
    { id: 'c', cells: ['z'], heightMm: 2400, shape: 'flat', dims: [] },
    { id: 'd', cells: ['w'], heightMm: 2300, shape: 'slope', dims: [1200, 0] },
  ]);
});

test('【失敗系】restoreCeilingZones: 配列でない入力（旧データ・欠落・null）は空の凍結配列', () => {
  for (const bad of [undefined, null, {}, 'x', 3]) {
    const out = restoreCeilingZones(bad);
    assert.deepEqual([...out], []);
    assert.ok(Object.isFrozen(out));
  }
});
