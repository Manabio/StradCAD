/**
 * 階段の破れ線先セル（beyondCells）に交差する部屋（2a部屋候補）の抽出。
 *
 * FinishModeState.stairUnderRooms（脱出時の壁生成の入力）と、stairUnderClip.js（描画クリップの
 * 対象2a部屋の同定）の双方が同じ判定を必要とするため、部屋抽出部分だけを単一ソース化する。
 * 中間階ガード（下階階段の見下げ位置）・riser・splitCLIds の算出は呼び出し側の責務のまま
 * （stair・graph・beyondCells だけで完結する部分のみここに置く）。
 */

import { RoomFeature } from '@core';
import { refreshCells } from '../gridCells.js';

/**
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {Set<string>} beyondCells - cellsBeyondBreak(stair, graph, riser) の結果
 * @returns {import('@core').Room[]} beyondCells に交差する部屋（階段ペアRoom・階段吹抜け・
 *   UNDEFINED・stair自身のペアRoomは除外）
 */
export function stairUnderRoomsOf(stair, graph, beyondCells) {
  const result = [];
  for (const room of graph.rooms) {
    if (room.feature === RoomFeature.STAIR || room.feature === RoomFeature.STAIR_VOID
      || room.feature === RoomFeature.UNDEFINED) continue;
    if (stair.roomId && room.id === stair.roomId) continue;
    let intersects = false;
    for (const key of refreshCells(room.cells, graph)) {
      if (beyondCells.has(key)) { intersects = true; break; }
    }
    if (!intersects) continue;
    result.push(room);
  }
  return result;
}
