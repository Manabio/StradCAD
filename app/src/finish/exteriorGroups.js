// 外部タブ（FinishTable.jsx GroupedExteriorTable。category==='exteriorRows'）の群構成の
// 唯一の供給源。react／store.js／.jsx を静的にimportしない純モジュール
// （node:testから直接importできる。roomNamingOptions.jsと同じ方針）。
import { RoomKind, RoomFeature } from '@core';

/**
 * 「屋外部屋の群」の対象か（ユーザー裁定: 屋外タブに削除ボタン・区分セレクタをRoom連動で置く対象）。
 * kind===EXTERIOR かつ feature!==STAIR（HEADの showLevelRow と同じ条件。QA指摘2026-09-29で訂正:
 * STAIR_VOID／UNDEFINEDは屋外Roomの生成経路が無い死んだ条件のため判定に含めない。昇降路（昇降機）
 * はHEADでは「改名入力＋仕上げレベル行」で表示されていたため除外しない）。
 * @param {import('@core').Room | null | undefined} room
 * @returns {boolean}
 */
export function isExteriorRoomGroupRoom(room) {
  if (!room) return false;
  return room.kind === RoomKind.EXTERIOR && room.feature !== RoomFeature.STAIR;
}

/**
 * GroupedExteriorTable が描く群の並びを組み立てる。
 *   1. rows（graph.exteriorRows）から現行どおり群を作る（roomId連動行は roomId 単位、
 *      手入力行は part 単位。行の出現順を保つ——同名 part の手入力群と連動群は
 *      キーの接頭辞（room:/part:）で混同しない）。
 *   2. 屋外・非階段の Room（isExteriorRoomGroupRoom）のうち、1 で連動群ができなかった
 *      （連動行が0件の）ものを、roomOrder 順で 1 のあとに追加する（見出し・仕上げレベル行・
 *      「＋ 行を追加」だけの空群。part は room.name）。
 * @param {{ rows: Array<{roomId: string|null, part: string}>, rooms: Array<import('@core').Room>, roomOrder: Array<string> }} args
 * @returns {Array<{ key: string, roomId: string|null, part: string, rows: Array }>}
 */
export function buildExteriorGroups({ rows, rooms, roomOrder }) {
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const key = row.roomId ? `room:${row.roomId}` : `part:${row.part}`;
    if (!groups.has(key)) {
      groups.set(key, { key, roomId: row.roomId ?? null, part: row.part, rows: [] });
      order.push(key);
    }
    groups.get(key).rows.push(row);
  }

  const roomById = new Map(rooms.map(r => [r.id, r]));
  const roomIdsWithGroup = new Set(
    [...groups.values()].filter(g => g.roomId != null).map(g => g.roomId));
  for (const roomId of roomOrder) {
    if (roomIdsWithGroup.has(roomId)) continue;
    const room = roomById.get(roomId);
    if (!isExteriorRoomGroupRoom(room)) continue;
    const key = `room:${roomId}`;
    groups.set(key, { key, roomId, part: room.name, rows: [] });
    order.push(key);
  }

  return order.map(key => groups.get(key));
}
