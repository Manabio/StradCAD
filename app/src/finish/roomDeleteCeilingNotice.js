/**
 * 部屋の削除確認用の判定（純モジュール。react・store.js・.jsx を静的に引かない）。
 * 削除される部屋（本人＋カスケードで消える子孫）のうち、天伏の天井区画（Room.ceilingZones）を持つものがあるか。
 * 存在しない id・ceilingZones 未定義の部屋は無視する（例外にしない）。
 * @param {{roomMap?: Map<string, {ceilingZones?: unknown[]}>}|null|undefined} graph
 * @param {Iterable<string>|null|undefined} roomIds
 * @returns {boolean}
 */
export function roomsLosingCeilingZones(graph, roomIds) {
  if (!graph?.roomMap || !roomIds) return false;
  for (const id of roomIds) {
    const zones = graph.roomMap.get(id)?.ceilingZones;
    if (Array.isArray(zones) && zones.length > 0) return true;
  }
  return false;
}
