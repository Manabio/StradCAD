// 天伏の穴の縁を中線にする後処理（planOpeningEdges.js・純モジュール）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markOpeningEdges, OPENING_EDGE_WEIGHT } from './planOpeningEdges.js';

const HOLE = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
const line = (key, points, extra = {}) => ({ kind: 'line', key, points, weight: 'thin', cls: 'below', source: { kind: 'floor', id: 'f' }, ...extra });
const weightsOf = prims => prims.map(p => p.weight);

test('OPENING_EDGE_WEIGHT は viewport.lineWeightsPx のキー medium', () => {
  assert.equal(OPENING_EDGE_WEIGHT, 'medium');
});

test('外形線の上の線だけ medium になる。内部の線・穴の外の線は不変', () => {
  const prims = [
    line('a', [0, 0, 1000, 0]), // 外形（上辺）
    line('b', [0, 500, 1000, 500]), // 穴の内部
    line('c', [1000, 200, 1000, 800]), // 右辺の一部
    line('d', [2000, 0, 3000, 0]), // 穴の外
  ];
  const out = markOpeningEdges(prims, [HOLE]);
  assert.deepEqual(weightsOf(out), ['medium', 'thin', 'medium', 'thin']);
  assert.deepEqual(out.map(p => p.key), ['a', 'b', 'c', 'd']);
});

test('入力を変更しない（配列も prim も）', () => {
  const prims = [line('a', [0, 0, 1000, 0])];
  const snapshot = JSON.parse(JSON.stringify(prims));
  markOpeningEdges(prims, [HOLE]);
  assert.deepEqual(prims, snapshot);
});

test('内部の共有辺（隣り合う 2 つの穴の境）は外形ではないので対象外。外形は 2 つにまたがる 1 本の線も対象', () => {
  const holes = [{ x1: 0, y1: 0, x2: 500, y2: 1000 }, { x1: 500, y1: 0, x2: 1000, y2: 1000 }];
  const out = markOpeningEdges([line('shared', [500, 0, 500, 1000]), line('top', [0, 0, 1000, 0])], holes);
  assert.deepEqual(weightsOf(out), ['thin', 'medium']);
});

test('同じ直線上で重なる線は最初の 1 本だけが持ち、後の線は出力済みの区間を差し引いた残りだけ（全部重なれば落とす）', () => {
  const prims = [
    line('floor', [0, 0, 1000, 0]),
    line('ceil', [0, 0, 1000, 0], { source: { kind: 'ceiling', id: 'c' } }), // 同座標
    line('wall', [200, 0, 800, 0], { source: { kind: 'wall', id: 'w' } }), // 内側に含まれる
    line('rev', [1000, 0, 0, 0]), // 向きが逆でも同じ線
  ];
  const out = markOpeningEdges(prims, [HOLE]);
  assert.deepEqual(out.map(p => p.key), ['floor']);
  assert.equal(out[0].weight, 'medium');
  // 一部だけ重なる線は残りの区間だけ出る
  const part = markOpeningEdges([line('a', [0, 0, 600, 0]), line('b', [400, 0, 1000, 0])], [HOLE]);
  assert.deepEqual(part.map(p => p.points), [[0, 0, 600, 0], [600, 0, 1000, 0]]);
  assert.deepEqual(weightsOf(part), ['medium', 'medium']);
});

test('座標が少しずれた線（許容 1e-3 超）は外形の上ではないので対象外', () => {
  const out = markOpeningEdges([line('a', [0, 0.01, 1000, 0.01]), line('b', [0, -0.0005, 1000, -0.0005])], [HOLE]);
  assert.deepEqual(weightsOf(out), ['thin', 'medium']);
});

test('段差のある穴（L 字）の外形に沿う線も対象。同じ側の重なる矩形でも外形線が欠けない', () => {
  const holes = [{ x1: 0, y1: 0, x2: 1000, y2: 500 }, { x1: 0, y1: 0, x2: 500, y2: 1000 }]; // 重なりのある L 字
  const out = markOpeningEdges([line('a', [0, 1000, 500, 1000]), line('b', [1000, 0, 1000, 500]), line('c', [600, 600, 900, 600])], holes);
  assert.deepEqual(weightsOf(out), ['medium', 'medium', 'thin']);
});

test('ceilingBoundary（グレーの同高さ境界）の線は thin のまま、同座標の床の線が medium。cut の線は thick のまま', () => {
  const grey = line('g', [0, 0, 1000, 0], { style: 'ceilingBoundary', source: { kind: 'ceiling', id: 'c' } });
  const floor = line('f', [0, 0, 1000, 0]);
  const cut = line('k', [0, 1000, 1000, 1000], { cls: 'cut', weight: 'thick' });
  const out = markOpeningEdges([grey, floor, cut], [HOLE]);
  assert.deepEqual(out.map(p => [p.key, p.weight]), [['g', 'thin'], ['f', 'medium'], ['k', 'thick']]);
  assert.equal(out[0].style, 'ceilingBoundary');
});

test('一部だけ外形に乗る線は、外形の区間だけ medium にして分割する（外の区間は元の weight）', () => {
  const out = markOpeningEdges([line('a', [-500, 0, 500, 0])], [HOLE]);
  assert.deepEqual(out.map(p => [p.key, p.points, p.weight]), [['a:p0', [-500, 0, 0, 0], 'thin'], ['a:p1', [0, 0, 500, 0], 'medium']]);
  // 外に出る区間が両側にある線は 3 分割
  const three = markOpeningEdges([line('b', [-500, 0, 1500, 0])], [HOLE]);
  assert.deepEqual(three.map(p => p.weight), ['thin', 'medium', 'thin']);
});

test('【失敗系】穴が無い・空・不正な矩形だけ・prims が配列でないときは入力をそのまま返す', () => {
  const prims = [line('a', [0, 0, 1000, 0])];
  assert.equal(markOpeningEdges(prims, []), prims);
  assert.equal(markOpeningEdges(prims, undefined), prims);
  assert.equal(markOpeningEdges(prims, [{ x1: 0, y1: 0, x2: 0, y2: 10 }, { x1: NaN, y1: 0, x2: 1, y2: 1 }]), prims);
  assert.equal(markOpeningEdges(undefined, [HOLE]), undefined);
  assert.deepEqual(markOpeningEdges([], [HOLE]), []);
});

test('【失敗系】不正な線（points が 4 つの有限数でない）・線以外の prim・斜めの線・長さ 0 の線は触らずそのまま通す', () => {
  const bad = [
    line('nan', [0, 0, NaN, 0]), line('short', [0, 0, 1000]), { kind: 'text', key: 't', x: 0, y: 0, text: 'x' },
    line('diag', [0, 0, 1000, 1000]), line('zero', [0, 0, 0, 0]), null,
  ];
  const out = markOpeningEdges(bad, [HOLE]);
  assert.deepEqual(out, bad);
});
