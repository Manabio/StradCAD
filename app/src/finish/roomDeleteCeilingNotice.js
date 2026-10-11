import { CeilingShape } from '../core/constants.js';
import { roomCeilingShapeOf } from '../ceiling/roomCeilingShape.js';

/**
 * 部屋の削除確認用の判定（純モジュール。react・store.js・.jsx を静的に引かない）。
 * 削除される部屋（本人＋カスケードで消える子孫）のうち、天伏の情報（天井区画 Room.ceilingZones、または平面でない部屋の天井形状 S12a）を持つものがあるか。
 * 存在しない id・ceilingZones／getFinishInfo 未定義の部屋は無視する（例外にしない）。
 * @param {{roomMap?: Map<string, {ceilingZones?: unknown[], getFinishInfo?: Function}>}|null|undefined} graph
 * @param {Iterable<string>|null|undefined} roomIds
 * @returns {boolean}
 */
export function roomsLosingCeilingZones(graph, roomIds) {
  if (!graph?.roomMap || !roomIds) return false;
  for (const id of roomIds) {
    const room = graph.roomMap.get(id);
    if (Array.isArray(room?.ceilingZones) && room.ceilingZones.length > 0) return true;
    if (roomCeilingShapeOf(room).shape !== CeilingShape.FLAT) return true;
  }
  return false;
}
