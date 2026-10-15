/**
 * 階段下の天井セル（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 階段の破れ線先セル（cellsBeyondBreak）のうち、直下階に階段が無いもの（＝階段下エリア。最下階は全部）を
 * 「階段下」として階段本体と別の群にするための、セルキーの集合を求める（ユーザー指示 2026-10-15
 * 「最下階にある階段下の天井を指定する経路がない」。仕上げモードで階段下セルを階段と二重に登録できるのと同じ）。
 * 選択専用: 所属索引（ceilingOwners.js）・描画（ceilingSurfaces.js）・保存形式は変えない。
 * 2a 部屋（仕上げで登録した階段下部屋）があるセルは所属索引で部屋が勝つので、ここでも階段所属のセルだけを採る。
 * 読み取りスコープで包まない（呼び側が必要なら withGraphReadScope で包む）。
 */
import { cellsBeyondBreak } from '../finish/stair/stairGeometry.js';
import { lowerStairAt } from '../finish/stair/stairUnderRooms.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { ceilingRefreshCells } from './ceilingGrid.js';
import { stairHasCeiling } from './ceilingOwners.js';

/**
 * @param {object} graph
 * @param {Map<string, {kind: 'room'|'stair', id: string, rowId: string}>} owners  所属索引
 * @param {{lowerStairCellBounds: Array<{stair: object, cellBounds: Array}>, floorHeightMm: number|null}|null} ctx
 *   直下階の階段（見下げ判定用。最下階は []）と自階の階高。null は「下階を判定できない」＝分けない。
 * @returns {Map<string, Set<string>>|null} stairId → 階段下の天井セルキー。ctx・graph・owners が無ければ null。
 */
export function stairUnderCeilingKeys(graph, owners, ctx) {
  if (!graph || !owners || !ctx) return null;
  const result = new Map();
  for (const stair of graph.stairs) {
    if (!stairHasCeiling(graph, stair)) continue;
    const riser = stair.riser ?? (ctx.floorHeightMm != null ? ctx.floorHeightMm / Math.max(1, stair.totalSteps) : null);
    const beyond = cellsBeyondBreak(stair, graph, riser);
    if (beyond.size === 0) continue;
    const underFinish = new Set();
    for (const key of beyond) {
      const cb = cellBoundsFromKey(key, graph);
      // 下階階段の見下げに当たるセルは階段下エリアではない（中間階。セル単位で判定）
      if (cb && lowerStairAt(ctx.lowerStairCellBounds, (cb.x1 + cb.x2) / 2, (cb.y1 + cb.y2) / 2)) continue;
      underFinish.add(key);
    }
    const keys = new Set();
    for (const key of ceilingRefreshCells(underFinish, graph)) {
      const owner = owners.get(key);
      if (owner?.kind === 'stair' && owner.id === stair.id) keys.add(key);
    }
    if (keys.size > 0) result.set(stair.id, keys);
  }
  return result;
}
