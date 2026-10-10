/**
 * 仕上げ表「内部」タブに載せる部屋の述語（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 仕上げ表（FinishTable.jsx InteriorTable）と天伏の専用パネル（ceiling/ceilingPanelRows.js）の共用——二重定義しない。
 *
 * 屋外部屋（kind===EXTERIOR）は階段の有無によらず除外する（外部タブが担当。非階段は
 * 部位の仕上げレベル入力、屋外階段は階段タブ＋外部タブの部位「階段」行）。
 * 屋内階段（kind===INTERIOR）は通常部屋と同じカードで表示する
 * （続きの階段のペアRoomも同様に表示される＝意図どおり）。
 * 階段吹抜け（STAIR_VOID）は自動管理 Room のため表に出さない。
 * 未定義の部屋（UNDEFINED）も表に出さない（B: 名前未確定のため命名対象外）。
 * 昇降路（昇降機）は共通仕様「昇降路」で一括指定するため内部タブに出さない（Q5）。
 * 並びは graph.rooms の順（部分指定の子も1部屋として並ぶ）。
 */
import { RoomFeature, RoomKind, isShaftFeature } from '@core';
import { DEFAULT_STAIR_ROOM_NAME } from './roomNamingOptions.js';

/** 内部タブのカードの表示名（名前が空なら、階段室は既定名・それ以外は「（名称未設定）」）。 */
export function interiorRoomDisplayName(room) {
  return room.name || (room.feature === RoomFeature.STAIR ? DEFAULT_STAIR_ROOM_NAME : '（名称未設定）');
}

/** @param {import('@core').Room} r */
export function isInteriorTabRoom(r) {
  return r.kind !== RoomKind.EXTERIOR
    && r.feature !== RoomFeature.STAIR_VOID && r.feature !== RoomFeature.UNDEFINED
    && !isShaftFeature(r.feature);
}

/** @param {{ rooms: import('@core').Room[] }} graph */
export function interiorTabRooms(graph) {
  return graph.rooms.filter(isInteriorTabRoom);
}
