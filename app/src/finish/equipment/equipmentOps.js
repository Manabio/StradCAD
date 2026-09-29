/**
 * 昇降機器具の確定・削除（graph を書き換える）。モード状態・undo・非同期は持たない
 * （純粋にgraphを引数で受け取り書き換えるだけ。store.js/snap.js/.jsx を静的importしない）。
 */
import { RoomKind, RoomFeature, EvUsage } from '@core';
import { refreshCells, connectedCellComponents, isRectangularCellSet } from '../gridCells.js';
import { findAdjacentShaftRooms } from './equipmentGeometry.js';
import { renumberEquipment, selfFloorEquipmentCatalog } from './equipmentNumbering.js';
import { makeRoomUndefined } from '../roomUndefined.js';
import {
  ERR_ELEVATOR_NOT_UNASSIGNED, ERR_ELEVATOR_NOT_RECTANGLE, ERR_ELEVATOR_EXTERIOR,
} from '../../error.js';

/**
 * 昇降機の設置可否を検証する。拒否理由の文言（error.jsの定数）を返す。通れば null。
 * 1. 新規候補でない、または部分指定 → ERR_ELEVATOR_NOT_UNASSIGNED
 * 2. 器具単位で矩形でない → ERR_ELEVATOR_NOT_RECTANGLE
 * 3. 屋外区分 → ERR_ELEVATOR_EXTERIOR
 * @returns {string|null}
 */
export function validateElevatorInstall({ graph, room, kind, isNewCandidate }) {
  if (!isNewCandidate || (room.referenceRoomIds?.size ?? 0) > 0) return ERR_ELEVATOR_NOT_UNASSIGNED;
  if (!isRectangularCellSet(refreshCells(room.cells, graph), graph)) return ERR_ELEVATOR_NOT_RECTANGLE;
  if (kind !== RoomKind.INTERIOR) return ERR_ELEVATOR_EXTERIOR;
  return null;
}

/**
 * 昇降機器具を1基設置する。辺で隣接する登録済み昇降路Roomがあれば統合し（複数あれば全部
 * まとめる。Q7）、無ければ候補Room（あれば）を昇降路化するか、新規Roomを作る。
 * @returns {{equipmentId:string, roomId:string}}
 */
export function installEquipment(graph, { id, category, usage, no, cells, candidateRoomId = null }) {
  if (!cells || cells.size === 0) throw new Error('installEquipment: cells is empty');
  const cellSet = new Set(cells);
  const adjacent = findAdjacentShaftRooms(graph, cellSet, { excludeRoomId: candidateRoomId });

  let targetRoomId;
  if (adjacent.length === 0) {
    if (candidateRoomId && graph.roomMap.has(candidateRoomId)) {
      const candidate = graph.roomMap.get(candidateRoomId);
      candidate.setKind(RoomKind.INTERIOR);
      candidate.setName('');
      candidate.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
      targetRoomId = candidate.id;
    } else {
      const room = graph.addRoom(new Set(cellSet), '', undefined, new Set());
      room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
      targetRoomId = room.id;
    }
  } else {
    // 先頭（roomOrder順。findAdjacentShaftRooms は graph.rooms=roomOrder順を走査する）を統合先にする。
    const [target, ...rest] = adjacent;
    const mergedCells = new Set(refreshCells(target.cells, graph)); // refreshCellsの返り値はscope内でmemo化されうるため複製してから書き換える
    for (const c of cellSet) mergedCells.add(c);
    for (const r of rest) {
      for (const c of refreshCells(r.cells, graph)) mergedCells.add(c);
    }
    target.setCells(mergedCells);
    target.generatedWallIds.clear();
    for (const r of rest) {
      for (const row of graph.equipmentRows) {
        if (row.roomId === r.id) row.setRoomId(target.id);
      }
      graph.removeRoom(r.id);
    }
    if (candidateRoomId && graph.roomMap.has(candidateRoomId)) graph.removeRoom(candidateRoomId);
    targetRoomId = target.id;
  }

  const row = graph.addEquipmentRow({ id, category, usage, no, cellKeys: new Set(cellSet), roomId: targetRoomId });
  return { equipmentId: row.id, roomId: targetRoomId };
}

/**
 * 分類ごとの採番を graph.equipmentRows へ反映する（renumberEquipment の戻り値をそのまま渡す）。
 * @param {object} graph
 * @param {Map<string, number>} noById id → 新no
 * @returns {number} 変更した行数
 */
export function applyEquipmentNumbers(graph, noById) {
  let changed = 0;
  for (const row of graph.equipmentRows) {
    const newNo = noById.get(row.id);
    if (newNo != null && row.no !== newNo) {
      row.setNo(newNo);
      changed++;
    }
  }
  return changed;
}

/**
 * 昇降機器具を1基削除する（単階）。
 * @param {object} graph
 * @param {string} equipmentId
 * @param {{noById?: Map<string, number>|null}} [opts] - 渡されれば建物全体で詰めた番号
 *   （finish/equipment/equipmentNumbering.js buildingNumbersAfterRemoval の戻り値）をそのまま
 *   反映する（applyEquipmentNumbers）。省略時は従来どおり自階だけで詰め直す
 *   （renumberEquipment(selfFloorEquipmentCatalog(graph.equipmentRows))）。
 * @returns {{removed:boolean, keptRoomId:string|null, createdShaftRoomIds:string[], undefinedRoomId:string|null}}
 */
export function removeEquipment(graph, equipmentId, { noById = null } = {}) {
  const row = graph.equipmentRows.find(r => r.id === equipmentId);
  if (!row) return { removed: false, keptRoomId: null, createdShaftRoomIds: [], undefinedRoomId: null };

  const rowCells = refreshCells(row.cellKeys, graph);
  graph.removeEquipmentRow(equipmentId);

  const room = row.roomId ? graph.roomMap.get(row.roomId) : null;
  const createdShaftRoomIds = [];
  let keptRoomId = null, undefinedRoomId = null;

  if (room) {
    const remaining = new Set([...refreshCells(room.cells, graph)].filter(c => !rowCells.has(c)));
    if (remaining.size === 0) {
      // 同じid・セルのまま未定義になる＝「Roomの削除」と「空いたセルの未定義部屋化」が同時に成り立つ
      makeRoomUndefined(room);
      undefinedRoomId = room.id;
    } else {
      const comps = connectedCellComponents(remaining, graph);
      const remainingRows = graph.equipmentRows.filter(r => r.roomId === room.id);
      let keepIdx = 0;
      if (remainingRows.length > 0) {
        const minRow = remainingRows.reduce((a, b) => (a.no < b.no ? a : b));
        const minRowCells = refreshCells(minRow.cellKeys, graph);
        const idx = comps.findIndex(comp => [...minRowCells].some(c => comp.has(c)));
        if (idx >= 0) keepIdx = idx;
      }
      for (let i = 0; i < comps.length; i++) {
        const comp = comps[i];
        if (i === keepIdx) {
          room.setCells(comp);
          room.generatedWallIds.clear();
          keptRoomId = room.id;
        } else {
          const newRoom = graph.addRoom(comp, '', undefined, new Set());
          newRoom.setKind(room.kind);
          newRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
          createdShaftRoomIds.push(newRoom.id);
          for (const r of graph.equipmentRows) {
            if (r.roomId === room.id && [...refreshCells(r.cellKeys, graph)].some(c => comp.has(c))) {
              r.setRoomId(newRoom.id);
            }
          }
        }
      }
      const undefRoom = graph.addRoom(new Set(rowCells), '', undefined, new Set());
      undefRoom.setKind(RoomKind.INTERIOR);
      undefRoom.setFeature(RoomFeature.UNDEFINED);
      undefinedRoomId = undefRoom.id;
    }
  }

  applyEquipmentNumbers(graph, noById ?? renumberEquipment(selfFloorEquipmentCatalog(graph.equipmentRows)));
  return { removed: true, keptRoomId, createdShaftRoomIds, undefinedRoomId };
}

/**
 * 昇降機の全階連動削除（ステップ5）の1階ぶん。その階に equipmentId の行があれば
 * removeEquipment(graph, equipmentId, { noById }) を行い、無ければ applyEquipmentNumbers(graph,
 * noById) だけ（番号だけ変わる階。行の無い階も再採番の対象にする仕様）。
 * @param {object} graph
 * @param {string} equipmentId
 * @param {Map<string, number>} noById
 * @returns {boolean} グラフが変わったら true（行削除は常にtrue。番号だけの階は変更があった場合のみ）
 */
export function applyEquipmentRemovalToFloor(graph, equipmentId, noById) {
  const hasRow = graph.equipmentRows.some(r => r.id === equipmentId);
  if (hasRow) {
    removeEquipment(graph, equipmentId, { noById });
    return true;
  }
  return applyEquipmentNumbers(graph, noById) > 0;
}

/**
 * 昇降機の全階連動用途変更（ステップ5）の1階ぶん。その階に equipmentId の行があり、用途が
 * 異なれば setUsage する。usage が EvUsage のいずれでもなければ throw する（黙って無視しない）。
 * @param {object} graph
 * @param {string} equipmentId
 * @param {string} usage
 * @returns {boolean} 変わったら true。行が無い・同値なら false。
 */
export function applyEquipmentUsageToFloor(graph, equipmentId, usage) {
  if (!Object.values(EvUsage).includes(usage)) throw new Error(`applyEquipmentUsageToFloor: 不正な用途: ${usage}`);
  const row = graph.equipmentRows.find(r => r.id === equipmentId);
  if (!row || row.usage === usage) return false;
  row.setUsage(usage);
  return true;
}
