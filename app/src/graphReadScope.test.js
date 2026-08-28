// graphReadScope.js（graph 読み取りスコープ）の単体テスト。
// 正常系（スコープ内で1回だけ計算する）と、失敗経路（例外・ネスト・スコープ外・
// プロパティ欠落）でスコープが漏れない／挙動が変わらないことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeObservable, observable, computed, runInAction } from 'mobx';
import { withGraphReadScope, scopedValue, graphList } from './graphReadScope.js';

const fakeGraph = () => ({ walls: [{ id: 'w1' }], rooms: [] });

// MobX の computed を持つ最小のフェイク（観測下でキャッシュされるかの検証用）。
class Counted {
  constructor() {
    this.base = 1;
    this.evals = 0;
    makeObservable(this, { base: observable, doubled: computed });
  }
  get doubled() { this.evals++; return this.base * 2; }
}

test('scopedValue: スコープ内は1回だけ計算し、同じ値を返す', () => {
  const g = fakeGraph();
  let calls = 0;
  const compute = () => { calls++; return { n: calls }; };
  const [a, b] = withGraphReadScope(g, () => [scopedValue(g, 'k', compute), scopedValue(g, 'k', compute)]);
  assert.equal(calls, 1);
  assert.equal(a, b); // 同一インスタンス（呼び出し側は読み取り専用として扱う契約）
});

test('scopedValue: スコープ外は毎回計算する（キャッシュしない＝挙動は素の実装と同じ）', () => {
  const g = fakeGraph();
  let calls = 0;
  const compute = () => ++calls;
  scopedValue(g, 'k', compute);
  scopedValue(g, 'k', compute);
  assert.equal(calls, 2);
});

test('scopedValue: スコープはgraphごとに独立（別graphの値を混ぜない）', () => {
  const g1 = fakeGraph(), g2 = fakeGraph();
  const v = withGraphReadScope(g1, () => {
    const a = scopedValue(g1, 'k', () => 'g1');
    const b = scopedValue(g2, 'k', () => 'g2'); // g2はスコープ外 → 都度計算
    return [a, b];
  });
  assert.deepEqual(v, ['g1', 'g2']);
});

test('withGraphReadScope: ネストしても最外周を抜けるまでキャッシュが維持される', () => {
  const g = fakeGraph();
  let calls = 0;
  const compute = () => ++calls;
  withGraphReadScope(g, () => {
    scopedValue(g, 'k', compute);
    withGraphReadScope(g, () => { scopedValue(g, 'k', compute); });
    scopedValue(g, 'k', compute); // 内側スコープを抜けてもまだ有効
  });
  assert.equal(calls, 1);
  scopedValue(g, 'k', compute); // 最外周を抜けたら破棄されている
  assert.equal(calls, 2);
});

test('withGraphReadScope: fnが例外を投げてもスコープは解放される（次の呼び出しへ漏れない）', () => {
  const g = fakeGraph();
  let calls = 0;
  const compute = () => ++calls;
  assert.throws(() => withGraphReadScope(g, () => {
    scopedValue(g, 'k', compute);
    throw new Error('boom');
  }), /boom/);
  scopedValue(g, 'k', compute);
  assert.equal(calls, 2); // 前回のキャッシュが残っていない
});

test('withGraphReadScope: graphがnull/undefinedならfnをそのまま実行する', () => {
  assert.equal(withGraphReadScope(null, () => 42), 42);
  assert.equal(withGraphReadScope(undefined, () => 42), 42);
});

test('graphList: 該当プロパティが無いgraph（単体テストの最小フェイク）はundefinedを返す', () => {
  const g = { walls: [] };
  assert.equal(withGraphReadScope(g, () => graphList(g, 'openings')), undefined);
  assert.deepEqual(withGraphReadScope(g, () => graphList(g, 'walls')), []);
});

test('graphList: スコープ内は同じ配列インスタンスを返す（読み取り専用契約）', () => {
  const g = fakeGraph();
  let reads = 0;
  Object.defineProperty(g, 'openings', { get() { reads++; return [{ id: 'o1' }]; } });
  const [a, b] = withGraphReadScope(g, () => [graphList(g, 'openings'), graphList(g, 'openings')]);
  assert.equal(reads, 1);
  assert.equal(a, b);
});

// ---- 観測下で実行する（computed が効く）ことの検証 ----

test('withGraphReadScope: スコープ内では MobX の computed が1回しか評価されない（観測下で走る）', () => {
  const g = fakeGraph();
  const c = new Counted();
  // スコープ外: 観測者がいないため読むたびに再計算される
  c.doubled; c.doubled; c.doubled;
  assert.equal(c.evals, 3);

  c.evals = 0;
  withGraphReadScope(g, () => { c.doubled; c.doubled; c.doubled; });
  assert.equal(c.evals, 1, 'スコープ内は観測下＝キャッシュされる');

  // スコープを抜けたら観測者は残らない（再び毎回再計算＝リークしていない）
  c.evals = 0;
  c.doubled; c.doubled;
  assert.equal(c.evals, 2);
});

test('withGraphReadScope: computedの依存が変わればスコープをまたいで正しく再計算される', () => {
  const g = fakeGraph();
  const c = new Counted();
  assert.equal(withGraphReadScope(g, () => c.doubled), 2);
  runInAction(() => { c.base = 5; });
  assert.equal(withGraphReadScope(g, () => c.doubled), 10);
});

test('withGraphReadScope: action（MobXバッチ）の中から呼んでも同期的に結果を返す', () => {
  // 回帰ガード: autorun は初回実行がバッチ終了まで遅延されるため、バッチ内で使うと
  // 結果が undefined になる（建具変更reaction→_rebuildBands 経路がこれで壊れた）。
  const g = fakeGraph();
  const c = new Counted();
  let got;
  runInAction(() => { got = withGraphReadScope(g, () => c.doubled + 1); });
  assert.equal(got, 3);
});
