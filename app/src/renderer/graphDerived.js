/**
 * graph 由来の「レンダー間で使い回せる派生値」を MobX の computed としてグラフ単位に持つ仕組み。
 *
 * ## なぜ必要か
 * 平面のレンダラは observer なので、**viewport の変化（パン・ズーム）やポインタ移動による
 * App の setState のたびに再レンダーする**。壁のT字取り合い・柱の仕上げ包み・壁ごとの開口
 * といった派生値は graph が変わらない限り同じ結果なのに、毎レンダーやり直していた
 * （壁224本・柱64本の合成平面で実測 約30ms/レンダー。60fps の予算16.7msを
 * 1回で使い切る＝カクつきの主因）。
 *
 * MobX の computed は**観測者がいる間だけ**キャッシュされる（graphReadScope.js のヘッダ参照）。
 * observer コンポーネントの render は追跡下なので、そこから読んだ computed はその
 * コンポーネントが購読し続ける限りキャッシュが生き、**依存する observable（壁の座標・
 * 柱の断面など）が変わったときだけ**再計算される。viewport だけが変わる再レンダーでは
 * 計算がまるごと飛ぶ。
 *
 * ## 設計
 * - キャッシュは `WeakMap<graph, Map<key, IComputedValue>>`。graph が捨てられれば一緒に消える。
 * - **keepAlive は使わない**——恒久キャッシュにすると、peek で作られる一時グラフ
 *   （FloorSwapManager.peek）の computed が共有 structGraph の observer として残り続けて
 *   リークする（graphReadScope.js が同じ理由で keepAlive を退けている）。
 *
 * ## 使う側の約束
 * - `compute` は **graph の observable と `key` に符号化した値だけ**から結果を決めること。
 *   key に現れない引数（viewport・選択状態など）を閉じ込めると、キャッシュが古い値を返す。
 * - `compute` は observable を変更してはならない（MobX の computed の規約。
 *   refreshCells のように書き込む処理はここへ通さない）。
 * - 返り値は読み取り専用として扱うこと（同じインスタンスが複数レンダーで共有される）。
 */
import { computed } from 'mobx';

const caches = new WeakMap(); // graph → Map<key, IComputedValue>

/**
 * graph 単位・key 単位に computed を作って値を返す（graph が falsy なら素通しで毎回計算）。
 * @template T
 * @param {object|null|undefined} graph
 * @param {string} key - 同じ graph 内で一意なキー。`compute` が依存する非observable
 *   （LODレベル等）はすべてこのキーに符号化すること。
 * @param {() => T} compute
 * @returns {T}
 */
export function graphComputed(graph, key, compute) {
  if (!graph) return compute();
  let byKey = caches.get(graph);
  if (!byKey) caches.set(graph, byKey = new Map());
  let box = byKey.get(key);
  if (!box) byKey.set(key, box = computed(compute, { name: `graphDerived:${key}` }));
  return box.get();
}
