/**
 * graph 読み取りスコープ — 「graph を一切変更しない同期の一括処理」の実行中だけ、
 * graph 由来の派生値をキャッシュする仕組み。
 *
 * ## なぜ必要か
 * **MobX の computed は観測者がいる間しかキャッシュされない**。モード突入時の一括構築は
 * reaction の外＝観測者ゼロのため、`cl.effectiveValue` / `wall.axisValue` / `wall.coord1,coord2` /
 * `wall.materialRange` / `graph.centerLines,walls,openings,rooms` といった computed が読み出しの
 * たびに再計算され、依存の bind/unbind まで毎回走る。「部屋×面×セル」の多重ループを回す
 * 展開図の帯構築では、実機でこれが処理時間の大半を占めていた（12室の階で 14.2秒 → 0.4秒）。
 *
 * 本モジュールは2段構えで効く:
 *   1. 処理全体を「その場限りの Reaction の追跡下」で走らせる（下記 runTracked）＝全 computed が効く
 *   2. `graphList` / `scopedValue` で、computed に依らない算術的な重複計算も畳む
 *
 * ## 設計（キャッシュ寿命をスコープの実行中に限定する理由）
 * MobX の keepAlive computed でグラフへ恒久キャッシュを持たせる案は採らない——
 * peek で作られる一時グラフ（FloorSwapManager.peek）の computed が、共有 structGraph の
 * observer として残り続けてリークするため。実行中に限定すれば**無効化の問題が原理的に起きない**
 * （スコープ内で graph を変更しないことが前提条件）。
 *
 * ## 使う側の約束
 * - `fn` は同期関数。中で graph（CL・Wall・Opening・Room.cells 等）を変更してはならない。
 * - スコープ外で `scopedValue` / `graphList` を呼んでも動く（キャッシュしないだけ・挙動は同じ）。
 */

import { Reaction } from 'mobx';

const scopes = new Map(); // graph → { depth, values: Map }

// ---- 観測下で実行する（computed を効かせる） ----
// MobX の computed は **観測者がいる間だけ**キャッシュされる。観測者のいない文脈では
// 読み出しのたびに再計算され、しかも依存の bind/unbind（addObserver/removeObserver/
// bindDependencies/clearObserving）まで毎回走る——`cl.effectiveValue`・`wall.axisValue`・
// `wall.coord1/2`・`wall.materialRange` のようなオブジェクト単位の computed を多重ループから
// 読む展開図の帯構築では、実データでこれが処理時間の大半を占めていた（実測で約13秒/16秒）。
//
// そこで一括処理そのものを、その場限りの Reaction の追跡下で走らせて直後に破棄する。
// 追跡中に読まれた computed は全て観測下＝キャッシュ有効になり、dispose で observer は残らない
// （keepAlive computed のようなリークが生じない）。
// **autorun ではなく低レベルの Reaction.track を使う**——autorun の初回実行はバッチ内
// （runInAction の最中。建具変更 reaction からの再構築がまさにこれ）だとバッチ終了まで
// 遅延されるため、その場で結果を返す用途には使えない。
// **fn 内で observable を変更してはならない**という前提は、このスコープの元々の契約と同じ。
let tracking = false;
function runTracked(fn) {
  if (tracking) return fn(); // 入れ子は最外周の追跡下にあるためそのまま実行する
  tracking = true;
  let result, error, thrown = false;
  const reaction = new Reaction('graphReadScope', () => {}); // 再実行はしない（追跡のためだけ）
  try {
    reaction.track(() => {
      try { result = fn(); } catch (e) { error = e; thrown = true; }
    });
  } finally {
    reaction.dispose();
    tracking = false;
  }
  if (thrown) throw error;
  return result;
}

/**
 * fn の実行中だけ graph の派生値をキャッシュする（ネスト可・graph が null なら素通し）。
 * @template T
 * @param {object|null|undefined} graph
 * @param {() => T} fn
 * @returns {T}
 */
export function withGraphReadScope(graph, fn) {
  if (!graph) return fn();
  const scope = scopes.get(graph);
  if (scope) { // ネスト: 最外周のスコープが解放するまで維持する
    scope.depth++;
    try { return fn(); } finally { scope.depth--; }
  }
  scopes.set(graph, { depth: 1, values: new Map() });
  try { return runTracked(fn); } finally { scopes.delete(graph); }
}

/**
 * スコープ内なら key で memo 化して compute の結果を返す（スコープ外は毎回 compute する）。
 * @template T
 * @param {object} graph
 * @param {string|object} key - 同一スコープ内で一意なキー（オブジェクトは同一性で判定）
 * @param {() => T} compute
 * @returns {T}
 */
export function scopedValue(graph, key, compute) {
  const scope = scopes.get(graph);
  if (!scope) return compute();
  if (scope.values.has(key)) return scope.values.get(key);
  const v = compute();
  scope.values.set(key, v);
  return v;
}

// graphList のキー（文字列連結を毎回作らないための固定キー）。
const LIST_KEYS = new Map();
const listKey = name => {
  let k = LIST_KEYS.get(name);
  if (!k) { k = `list:${name}`; LIST_KEYS.set(name, k); }
  return k;
};

/**
 * `graph[name]`（MobX computed の配列）をスコープ内でキャッシュして返す。
 * **返り値は読み取り専用として扱うこと**（in-place の sort/push 等をしてはならない。
 * スコープ内では同じ配列インスタンスが使い回されるため）。
 * @param {object} graph
 * @param {'centerLines'|'walls'|'openings'|'rooms'|'shapes'} name
 * @returns {any[]|undefined} graph が該当プロパティを持たない場合は undefined（単体テストの
 *   最小フェイクgraph用。呼び出し側の `?? []` フォールバックをそのまま活かす）
 */
export function graphList(graph, name) {
  return scopedValue(graph, listKey(name), () => graph[name]);
}
