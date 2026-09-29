/**
 * 昇降機器具の幾何（graph を読むだけ。react / store.js / snap.js / .jsx を静的 import しない）。
 */
import { isShaftFeature, RoomKind } from '@core';
import { refreshCells, cellBoundsFromKey, boundsShareEdge } from '../gridCells.js';

/**
 * room が「登録済みの昇降路Room」（その Room を指す器具行が1件以上ある Room）かどうか。
 * isShaftFeature(room.feature) かつ屋内 かつ referenceRoomIds.size===0 かつ
 * roomId===room.id の器具行が1件以上。
 */
export function isRegisteredShaftRoom(graph, room) {
  if (!room || !isShaftFeature(room.feature)) return false;
  if (room.kind !== RoomKind.INTERIOR) return false;
  if (room.referenceRoomIds.size !== 0) return false;
  return graph.equipmentRows.some(r => r.roomId === room.id);
}

function boundsListOf(cells, graph) {
  return [...cells].map(key => cellBoundsFromKey(key, graph)).filter(Boolean);
}

/**
 * cells（refresh済み）と辺で隣接する「登録済みの昇降路Room」を roomOrder 順で返す。
 * @param {object} graph
 * @param {Set<string>} cells
 * @param {{excludeRoomId?: string|null}} [opts]
 * @returns {object[]} Room[]
 */
export function findAdjacentShaftRooms(graph, cells, { excludeRoomId = null } = {}) {
  const boundsList = boundsListOf(cells, graph);
  const result = [];
  for (const room of graph.rooms) {
    if (room.id === excludeRoomId) continue;
    if (!isRegisteredShaftRoom(graph, room)) continue;
    const roomBoundsList = boundsListOf(refreshCells(room.cells, graph), graph);
    if (boundsList.some(a => roomBoundsList.some(b => boundsShareEdge(a, b)))) result.push(room);
  }
  return result;
}

/**
 * cellKey が指す昇降機器具（行または行の無い旧データの昇降路Room）を返す。
 * まず器具行の refresh 済みセル、次に行を持たない昇降路Roomの refresh 済みセル
 * （id は Room の id）を見る。
 * @returns {{id:string, kind:'row'|'unregistered'}|null}
 */
export function equipmentAtCell(graph, cellKey) {
  for (const row of graph.equipmentRows) {
    if (refreshCells(row.cellKeys, graph).has(cellKey)) return { id: row.id, kind: 'row' };
  }
  for (const room of graph.rooms) {
    if (!isShaftFeature(room.feature)) continue;
    if (graph.equipmentRows.some(r => r.roomId === room.id)) continue; // 行を持つRoomは上のループで判定済み
    if (refreshCells(room.cells, graph).has(cellKey)) return { id: room.id, kind: 'unregistered' };
  }
  return null;
}

/**
 * 行ごとの refresh 済みセルを列挙する（空のものは除く）。
 * @returns {Array<{id:string, roomId:string|null, cells:Set<string>}>}
 */
export function equipmentFootprints(graph) {
  const result = [];
  for (const row of graph.equipmentRows) {
    const cells = refreshCells(row.cellKeys, graph);
    if (cells.size === 0) continue;
    result.push({ id: row.id, roomId: row.roomId, cells });
  }
  return result;
}
