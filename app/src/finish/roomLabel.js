// 部屋名ラベルの配置ルール（単一情報源）。
// 描画（FinishModeLayer.jsx）と名前セルのクリック判定（FinishModeState._nameCellKeyOf）の
// 両方がこのアンカーを参照する——二重実装だと片方だけ直ってクリック位置と表示がずれるため。
import { cellBoundsFromKey, roomBounds, refreshCells } from './gridCells.js';

/**
 * 部屋名ラベルのアンカー位置と参照幅（フォントサイズ導出用）。
 *
 * 配置ルール:
 *   1. room.namePosition の明示指定があればそれを使う（refWidth は包絡矩形の幅）
 *   2. 自動配置は「最大面積セルの中心」。ただし部分指定を持つ親（参照元）は、
 *      部分指定に奪われていないセルの中から選ぶ——親と部分指定はセルを共有する
 *      （親は全セルを保持したまま部分指定が部分集合を持つ）ため、無条件に最大セルを
 *      選ぶと両者のラベルが同一セルに落ちて重なる。照合は親・部分指定の両方を
 *      refreshCells で現行グリッド分割のキーへ正規化してから行う（親が粗い旧分割
 *      キーのままだと粒度差で除外漏れするため。粗いセルの奪われていない断片が
 *      候補に残るのも意図どおり）。除外で候補が尽きる退化ケース
 *      （部分指定が全域を覆う等）は全セルから選ぶ。
 *      部分指定を持たない部屋は生キーのまま走査する（従来挙動の維持）。
 *
 * @param {import('@core').Room} room
 * @param {import('@core').FloorGraph} graph
 * @returns {{ x: number, y: number, refWidth: number|null } | null} セル解決不能なら null
 */
export function roomNameAnchor(room, graph) {
  if (room.namePosition) {
    const bounds = roomBounds(room.cells, graph);
    return {
      x: room.namePosition.x,
      y: room.namePosition.y,
      refWidth: isFinite(bounds.x1) ? bounds.x2 - bounds.x1 : null,
    };
  }

  // 参照元（親）のみ: 部分指定が占めるセルキーを現行分割へ正規化して収集する
  let claimedKeys = null;
  if (room.referenceRoomIds.size === 0) {
    for (const r of graph.rooms) {
      if (!r.referenceRoomIds.has(room.id)) continue;
      for (const key of refreshCells(r.cells, graph)) (claimedKeys ??= new Set()).add(key);
    }
  }
  const candidateCells = claimedKeys ? refreshCells(room.cells, graph) : room.cells;

  const pickLargest = (excludeClaimed) => {
    let largest = null, maxArea = 0;
    for (const key of candidateCells) {
      if (excludeClaimed && claimedKeys.has(key)) continue;
      const b = cellBoundsFromKey(key, graph);
      if (!b) continue;
      const area = (b.x2 - b.x1) * (b.y2 - b.y1);
      if (area > maxArea) { maxArea = area; largest = b; }
    }
    return largest;
  };

  const largest = claimedKeys ? (pickLargest(true) ?? pickLargest(false)) : pickLargest(false);
  if (!largest) return null;
  return {
    x: (largest.x1 + largest.x2) / 2,
    y: (largest.y1 + largest.y2) / 2,
    refWidth: largest.x2 - largest.x1,
  };
}
