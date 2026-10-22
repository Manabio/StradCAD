import { graphComputed } from './graphDerived.js';
import { ceilingCutResolverOf } from '../ceiling/ceilingCutHeight.js';
import { ceilingHiddenOpeningIds } from '../ceiling/ceilingOpeningVisibility.js';

/**
 * 見上げ（天伏）の描画が共有する graph 由来の値を 1 回で解く（graph 単位にキャッシュ。graphDerived.js）。
 * ShapesLayer（壁の欠き取り・腰壁垂れ壁）と OpeningsLayer（建具の記号）が同じ切断高の解決を使うため、解決器を二重に組まない。
 * 向きに依らない graph だけで決まる値（鍵は固定）。呼ぶのは見上げのときだけ。
 * @param {object} graph
 * @returns {{wallCutAt: Function, hiddenOpeningIds: Set<string>}}
 */
export function ceilingUpDerived(graph) {
  return graphComputed(graph, 'ceilingUp', () => {
    const resolver = ceilingCutResolverOf(graph);
    return { wallCutAt: resolver.wallCutAt, hiddenOpeningIds: ceilingHiddenOpeningIds(graph, resolver) };
  });
}
