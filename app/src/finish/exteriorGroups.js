// 外部タブ（FinishTable.jsx GroupedExteriorTable。category==='exteriorRows'）の群構成の
// 唯一の供給源。react／store.js／.jsx を静的にimportしない純モジュール
// （node:testから直接importできる。roomNamingOptions.jsと同じ方針）。
import { RoomKind, RoomFeature, isRoofFeature, ROOF_ROOM_NAME } from '@core';
import {
  ExteriorGroupType, ROOF_ZONE_LABEL, ROOF_ZONE_GROUP_KEY_PREFIX, MAIN_ROOF_GROUP_LABEL_WITH_ZONES, ROOF_ZONE_EMPTY_SUFFIX,
} from '../core/constants.js';

/**
 * 「屋外部屋の群」の対象か（ユーザー裁定: 屋外タブに削除ボタン・区分セレクタをRoom連動で置く対象）。
 * kind===EXTERIOR かつ feature!==STAIR（HEADの showLevelRow と同じ条件。QA指摘2026-09-29で訂正:
 * STAIR_VOID／UNDEFINEDは屋外Roomの生成経路が無い死んだ条件のため判定に含めない。昇降路（昇降機）
 * はHEADでは「改名入力＋仕上げレベル行」で表示されていたため除外しない）。
 * 屋根（ROOF）は除く——屋根は専用の群（type:'roof'）で出し、仕上げレベル行・改名入力・区分セレクタを持たない。
 * @param {import('@core').Room | null | undefined} room
 * @returns {boolean}
 */
export function isExteriorRoomGroupRoom(room) {
  if (!room) return false;
  return room.kind === RoomKind.EXTERIOR && room.feature !== RoomFeature.STAIR && !isRoofFeature(room.feature);
}

/**
 * 群が「選択中の屋根の群」か（平面で選んだ屋根の群だけを強調・スクロールする判定）。
 * 屋根の群（type:'roof'）で、roomId が選択中の部屋 id と一致するときだけ true。
 * 屋根区画の群（type:'roofZone'）は zoneId が選択中の区画 id（selectedRoofZoneId）と一致するときだけ true。
 * @param {{ type: string, roomId: string|null, zoneId?: string }} group
 * @param {string|null|undefined} selectedRoomId
 * @param {string|null|undefined} [selectedRoofZoneId]
 * @returns {boolean}
 */
export function isSelectedRoofGroup(group, selectedRoomId, selectedRoofZoneId = null) {
  if (group.type === ExteriorGroupType.ROOF_ZONE) return selectedRoofZoneId != null && group.zoneId === selectedRoofZoneId;
  return group.type === ExteriorGroupType.ROOF && selectedRoomId != null && group.roomId === selectedRoomId;
}

/** 主屋根の群の見出し（下屋の群の見出しは ROOF_ROOM_NAME＝「屋根」）。 */
export const MAIN_ROOF_GROUP_LABEL = '屋根（主屋根）';

/**
 * GroupedExteriorTable が描く群の並びを組み立てる。各群は type を持つ:
 * 'mainRoof'（主屋根。セルを持たない固定の群）／'roof'（屋根セルの群。下屋）／'room'（roomId連動群）／
 * 'part'（手入力の部位群）。
 *   0a. includeMainRoof（既定 false。最上階とその検討案のときだけ呼び出し側が true）なら、type:'mainRoof' の群を
 *      最初の1つとして出す（roomId なし・rows:[]・見出しは固定「屋根（主屋根）」＝下屋の群「屋根」と
 *      見分けるため。ユーザー裁定2026-10-02。削除ボタン・選択の青枠なし）。
 *      屋根区画が1件以上あるとき（roofZones.length ≥ 1）、見出しは MAIN_ROOF_GROUP_LABEL_WITH_ZONES
 *      （「屋根（主屋根・区画以外）」。ユーザー裁定 2026-10-30）。
 *   0b. roofZones（呼び出し側が graph.roofZones から作る { id, empty }。実効セルが0なら empty）ごとに
 *      type:'roofZone' の群（key=ROOF_ZONE_GROUP_KEY_PREFIX+id・zoneId・「屋根区画N」（N は 1 始まりの並び順）。
 *      empty なら末尾に「（範囲なし）」）を、主屋根の次・下屋の前に出す（rows:[]）。
 *   0. 屋根（feature===ROOF）の Room ごとに type:'roof' の群を、roomOrder 順で区画の次に出す
 *      （連動行は持たない＝rows:[]。見出しは固定「屋根」）。
 *   1. rows（graph.exteriorRows）から現行どおり群を作る（roomId連動行は roomId 単位、
 *      手入力行は part 単位。行の出現順を保つ——同名 part の手入力群と連動群は
 *      キーの接頭辞（room:/part:）で混同しない）。
 *   2. 屋外・非階段・非屋根の Room（isExteriorRoomGroupRoom）のうち、1 で連動群ができなかった
 *      （連動行が0件の）ものを、roomOrder 順で 1 のあとに追加する（見出し・仕上げレベル行・
 *      「＋ 行を追加」だけの空群。part は room.name）。
 * @param {{ rows: Array<{roomId: string|null, part: string}>, rooms: Array<import('@core').Room>, roomOrder: Array<string>, includeMainRoof?: boolean, roofZones?: Array<{ id: string, empty: boolean }> }} args
 * @returns {Array<{ key: string, type: 'mainRoof'|'roofZone'|'roof'|'room'|'part', roomId: string|null, zoneId?: string, part: string, rows: Array }>}
 */
export function buildExteriorGroups({ rows, rooms, roomOrder, includeMainRoof = false, roofZones = [] }) {
  const roomById = new Map(rooms.map(r => [r.id, r]));

  const mainRoofGroups = includeMainRoof
    ? [{
      key: ExteriorGroupType.MAIN_ROOF, type: ExteriorGroupType.MAIN_ROOF, roomId: null, rows: [],
      part: roofZones.length >= 1 ? MAIN_ROOF_GROUP_LABEL_WITH_ZONES : MAIN_ROOF_GROUP_LABEL,
    }]
    : [];

  // 区画は最上階の外部タブにだけ出す（includeMainRoof と同じ条件。呼び出し側が最上階以外では空を渡す／include を false にする）
  const roofZoneGroups = includeMainRoof
    ? roofZones.map((z, i) => ({
      key: ROOF_ZONE_GROUP_KEY_PREFIX + z.id, type: ExteriorGroupType.ROOF_ZONE, zoneId: z.id, roomId: null, rows: [],
      part: `${ROOF_ZONE_LABEL}${i + 1}${z.empty ? ROOF_ZONE_EMPTY_SUFFIX : ''}`,
    }))
    : [];

  const roofGroups = [];
  for (const roomId of roomOrder) {
    const room = roomById.get(roomId);
    if (!room || !isRoofFeature(room.feature)) continue;
    roofGroups.push({ key: `roof:${roomId}`, type: ExteriorGroupType.ROOF, roomId, part: ROOF_ROOM_NAME, rows: [] });
  }

  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const key = row.roomId ? `room:${row.roomId}` : `part:${row.part}`;
    if (!groups.has(key)) {
      groups.set(key, { key, type: row.roomId ? ExteriorGroupType.ROOM : ExteriorGroupType.PART, roomId: row.roomId ?? null, part: row.part, rows: [] });
      order.push(key);
    }
    groups.get(key).rows.push(row);
  }

  const roomIdsWithGroup = new Set(
    [...groups.values()].filter(g => g.roomId != null).map(g => g.roomId));
  for (const roomId of roomOrder) {
    if (roomIdsWithGroup.has(roomId)) continue;
    const room = roomById.get(roomId);
    if (!isExteriorRoomGroupRoom(room)) continue;
    const key = `room:${roomId}`;
    groups.set(key, { key, type: ExteriorGroupType.ROOM, roomId, part: room.name, rows: [] });
    order.push(key);
  }

  return [...mainRoofGroups, ...roofZoneGroups, ...roofGroups, ...order.map(key => groups.get(key))];
}
