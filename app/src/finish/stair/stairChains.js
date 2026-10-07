/**
 * 階段の連鎖（上下に連なる階段）の導出（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 *
 * 階段の上階展開は直上1階の吹抜けだけで、各階の階段はユーザーが個別に指定する。
 * 「続きの階段」は保存せず、隣接階で足元が重なる階段の連なりとして毎回導出する（系列 id を持たない）。
 */
import { refreshCells } from '../gridCells.js';
import { mapFootprint } from './stairRemoval.js';

const memberKey = (planeId, stairId) => `${planeId}:${stairId}`;

/**
 * 階段 stair（loGraph の階）の続き（hiGraph＝直上階で足元が重なる階段）を返す。無ければ null。
 * 足元を直上階へ写し（写せなければ null）、直上階の階段のうち原子セルが1つでも重なる最初の1つ。
 * isClaimed(t) が真の階段は選ばない（buildStairChains が「既に別の下階の続き」を除くのに使う）。
 * @param {object} stair
 * @param {object} loGraph
 * @param {object} hiGraph
 * @param {object} structGraph
 * @param {(t:object)=>boolean} [isClaimed]
 * @returns {object|null}
 */
export function findContinuation(stair, loGraph, hiGraph, structGraph, isClaimed = () => false) {
  const mapped = mapFootprint(stair, loGraph, structGraph, hiGraph);
  if (!mapped) return null;
  return (hiGraph.stairs ?? []).find(t =>
    !isClaimed(t)
    && [...refreshCells(t.cells, hiGraph)].some(k => mapped.has(k))) ?? null;
}

/**
 * 階段の上に続きの階段があるか。upperGraph が無ければ null（未知。呼び出し側は安全側＝フルハイトへ倒す）。
 * 型は問わない（上に重なる階段があれば続き）。
 * @returns {boolean|null}
 */
export function stairContinuesAbove(stair, graph, upperGraph, structGraph) {
  if (!upperGraph) return null;
  return findContinuation(stair, graph, upperGraph, structGraph) != null;
}

/**
 * 階段の連鎖を作る。
 * 各階の階段の足元を直上階へ写し（写せなければ連鎖はそこで切れる）、直上階の階段のうち原子セルが
 * 1つでも重なるものを「続き」とする（部分重なりは指定時に拒否されるので、重なれば続き）。
 * 連鎖は極大列。単独の階段も長さ1の連鎖。
 * 分岐（1つの階段が複数の続きを持つ）は想定しない——最初に見つかった（graph.stairs の並びで先頭の）
 * 1つだけを続きにする。続きが既に別の下階の階段の続きになっていれば、その階段は選ばず次の候補を見る
 * （1つの階段は高々1つの連鎖に属する）。
 * graph が null の階（読めなかった階）は階段なしの階として扱い、その位置で連鎖を切る（上下どちらの続きにもならない）。
 * @param {Array<{plane: object, graph: object|null}>} floors 採用階を elevation 昇順に並べたもの
 * @param {object} structGraph 通り芯
 * @returns {Array<{ key: string, members: Array<{planeId: string, stairId: string}>,
 *                   fromPlaneId: string, toPlaneId: string }>}
 *   並びは最下階の連鎖から・同じ階では graph.stairs の順。key は先頭メンバーの `planeId:stairId`
 */
export function buildStairChains(floors, structGraph) {
  if (!floors || floors.length === 0) return [];
  for (const f of floors) {
    if (!f?.plane) throw new Error('buildStairChains: plane がない階があります');
  }
  const stairsOf = (f) => f.graph?.stairs ?? [];

  // nextOf: メンバー key → 続きのメンバー。claimed: 続きとして取られた階段の key
  const nextOf = new Map();
  const claimed = new Set();
  for (let i = 0; i + 1 < floors.length; i++) {
    const lo = floors[i], hi = floors[i + 1];
    if (!lo.graph || !hi.graph) continue; // 読めなかった階をまたぐ続きは作らない（その位置で切れる）
    for (const stair of lo.graph.stairs) {
      const cont = findContinuation(stair, lo.graph, hi.graph, structGraph,
        t => claimed.has(memberKey(hi.plane.id, t.id)));
      if (!cont) continue;
      const next = { planeId: hi.plane.id, stairId: cont.id };
      nextOf.set(memberKey(lo.plane.id, stair.id), next);
      claimed.add(memberKey(next.planeId, next.stairId));
    }
  }

  const chains = [];
  for (const f of floors) {
    for (const stair of stairsOf(f)) {
      const headKey = memberKey(f.plane.id, stair.id);
      if (claimed.has(headKey)) continue; // 続き（先頭ではない）
      const members = [{ planeId: f.plane.id, stairId: stair.id }];
      for (let m = nextOf.get(headKey); m; m = nextOf.get(memberKey(m.planeId, m.stairId))) members.push(m);
      chains.push({
        key: headKey,
        members,
        fromPlaneId: members[0].planeId,
        toPlaneId: members[members.length - 1].planeId,
      });
    }
  }
  return chains;
}

/**
 * 連鎖グループを開いて表示するか。選択中の階段を含むグループは開く。
 * ユーザーの開閉操作（overrides: Map<key, boolean>）があれば、それを優先する。
 */
export function isChainOpen(chain, selectedStairId, overrides) {
  const o = overrides?.get(chain.key);
  if (o !== undefined) return o;
  return selectedStairId != null && chain.members.some(m => m.stairId === selectedStairId);
}
