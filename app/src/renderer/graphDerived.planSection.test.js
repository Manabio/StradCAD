// PlanSolidsLayer.jsx の断面解決キャッシュ設計の契約テスト。置き場・鍵・ドラッグ中の扱いは純関数
// （plan/planSolidsLayerFilter.js planSolidsLayerCacheSpec / planSolidsLayerResolve）に置いてあり、レイヤはそれを呼ぶだけ
// （呼び出しの形は PlanSolidsLayer.wiring.test.js が固定する）。
// graphComputed は (graph,key) ごとに最初の compute を使い回す——置き場が下階 peek に依存しないと、階を切り替えて
// 下階の peek が替わっても古い peek 基準の結果を返し続ける（graphDerived.openingCross.test.js と同型）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun, runInAction } from 'mobx';
import { graphComputed } from './graphDerived.js';
import { planSolidsLayerResolve, planSolidsLayerCacheSpec } from '../plan/planSolidsLayerFilter.js';
import { makeRoomGraph, addBeamH } from '../plan/planTestFixtures.js';

/** graphComputed を compute の呼び出し回数つきで包んだ memo。 */
function countingMemo() {
  const memo = (home, key, compute) => graphComputed(home, key, () => { memo.calls++; return compute(); });
  memo.calls = 0;
  return memo;
}
const peekOf = (graph, lower) => ({ graph: lower, floorHeightMm: 2800, activePlaneId: graph.plane.id });

function upperAndLowers() {
  const upper = makeRoomGraph(0, 0, 4000, 4000, { id: 'upper' });
  addBeamH(upper.graph, { axis: 1000, from: 500, to: 3500, levelOffset: 1200 });
  const lowerA = makeRoomGraph(0, 0, 4000, 4000, { id: 'lowerA' }).graph;
  const lowerB = makeRoomGraph(0, 0, 4000, 4000, { id: 'lowerB' }).graph;
  return { upper, lowerA, lowerB };
}

test('置き場は直下階の peek の graph: 下階 A→B に替えた2回目は B に基づき（鍵が下階で変わる）、同じ peek なら再利用する', () => {
  const { upper: { graph }, lowerA, lowerB } = upperAndLowers();
  // compute は observable を読まない文字列（観測者がいなくても一度計算したら使い回される。openingCross のテストと同型）。
  // 置き場・鍵は本物の planSolidsLayerCacheSpec から取る——home を graph 固定にすると B が A のまま返って赤になる。
  const draw = (lower, name) => {
    const { home, key } = planSolidsLayerCacheSpec(graph, lower ? peekOf(graph, lower) : null);
    return graphComputed(home, key, () => `below=${name}`);
  };
  assert.equal(draw(lowerA, 'A'), 'below=A');
  assert.equal(draw(lowerB, 'B'), 'below=B', '下階が A→B に替わった2回目は B に基づく');
  assert.equal(draw(lowerA, 'A!'), 'below=A', '同じ置き場は再利用');
  assert.equal(draw(null, 'none'), 'below=none', '下階なし＝自階が置き場');
  assert.equal(draw(null, 'none!'), 'below=none');
  // 鍵の切断高: 切断高が変わると同じ置き場でも別の計算
  runInAction(() => { graph.plane.planCutHeightMm = 1800; });
  assert.equal(draw(lowerA, 'A@1800'), 'below=A@1800', '鍵に切断高が入る');
});

test('置き場を自階に固定すると、同じ鍵のまま下階が替わったとき古い下階を握り続ける（旧設計の不具合の再現。home を graph 固定した memo）', () => {
  const { upper: { graph }, lowerA, lowerB } = upperAndLowers();
  const { key } = planSolidsLayerCacheSpec(graph, null);
  const draw = name => graphComputed(graph, key, () => `below=${name}`); // 置き場を自階に固定
  assert.equal(draw('A'), 'below=A');
  assert.equal(draw('B'), 'below=A', '固定すると B に替えても A の結果のまま');
  // 正しい設計（cacheSpec の home）では別の置き場になる
  assert.ok(planSolidsLayerCacheSpec(graph, peekOf(graph, lowerA)).home !== planSolidsLayerCacheSpec(graph, peekOf(graph, lowerB)).home);
});

test('観測されている間は同じ graph・切断高で compute が1回だけ。切断高が変わると再計算、梁が増えると観測者のもとで再計算', () => {
  const { upper: { graph } } = upperAndLowers();
  const memo = countingMemo();
  let first, second;
  const d1 = autorun(() => { first = planSolidsLayerResolve({ graph, belowPeek: null, memo }); });
  const d2 = autorun(() => { second = planSolidsLayerResolve({ graph, belowPeek: null, memo }); }); // viewport 変化などの再レンダー相当
  assert.equal(memo.calls, 1);
  assert.equal(first, second, '同じ配列インスタンスを共有');
  const n = first.length;
  runInAction(() => { graph.plane.planCutHeightMm = 1100; });
  assert.equal(memo.calls, 2, '切断高が変わると鍵が替わり、2つの観測者が共有して1回だけ再計算');
  runInAction(() => { addBeamH(graph, { axis: 3000, from: 500, to: 3500, levelOffset: 1000 }); });
  assert.equal(memo.calls, 3, '梁が増えると観測者のもとで1回だけ再計算');
  assert.ok(first.length > n, '足した梁の線が増える');
  assert.equal(first, second);
  d1(); d2();
});

test('通り芯ドラッグ中は再計算せず前回の線を返し続ける（pendingDelta を5回書き換えて compute 0 回）。戻すと1回だけ再計算', () => {
  const { upper: { graph, cx } } = upperAndLowers();
  const memo = countingMemo();
  let prev = null, out = null;
  const dispose = autorun(() => {
    out = planSolidsLayerResolve({ graph, belowPeek: null, memo, prevPrims: prev });
    if (out) prev = out;
  });
  assert.equal(memo.calls, 1);
  const before = out;
  assert.ok(before.length > 0);
  for (let i = 1; i <= 5; i++) {
    runInAction(() => { cx[0].pendingDelta = i * 10; });
    assert.equal(out, before, `ドラッグ中(${i}回目)は前回の配列をそのまま返す`);
  }
  assert.equal(memo.calls, 1, 'ドラッグ中は compute を1回も呼ばない');
  runInAction(() => { cx[0].pendingDelta = 0; });
  assert.equal(memo.calls, 2, 'ドラッグが終わると通常経路に戻り1回だけ再計算');
  assert.ok(Array.isArray(out));
  dispose();
});

test('ドラッグ中に前回の結果が無ければ null（描かない）。ドラッグを終えると計算する', () => {
  const { upper: { graph, cx } } = upperAndLowers();
  const memo = countingMemo();
  runInAction(() => { cx[0].pendingDelta = 10; });
  assert.equal(planSolidsLayerResolve({ graph, belowPeek: null, memo, prevPrims: null }), null);
  assert.equal(memo.calls, 0);
  runInAction(() => { cx[0].pendingDelta = 0; });
  assert.ok(Array.isArray(planSolidsLayerResolve({ graph, belowPeek: null, memo, prevPrims: null })));
  assert.equal(memo.calls, 1);
});
