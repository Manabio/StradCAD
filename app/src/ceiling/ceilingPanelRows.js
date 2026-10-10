/**
 * 天伏パネルの行の組み立て（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 仕上げモードとは独立。仕上げ表との共有はデータ（Room の天井欄）と純モジュールだけ（ユーザー裁定 2026-10-10）。
 *
 * 既知の限界: CH は roomCeilingHeight().raw のみ。仕上げ表の内部タブが上階吹抜けの部屋で併記する計算値
 * （voidCHAbove）は出さない（S1a' の受容。他階 peek を持たないため）。
 *
 * 行: { id, kind, name, ceilingBoard, ceilingFinish, ch }
 *   kind … 'room'（部屋の行。選択できる）| 'stair'（部屋の無い階段の行。id は stair.id。選択対象外）。
 *   ceilingBoard … 天井材。S3 までデータが無いので常に null（描画側が「—」にする）。
 *   ceilingFinish … room.finish.ceilingMaterial（空なら null）。
 *   ch … roomCeilingHeight(graph, room).raw（レンジ表記は原文のまま）。部屋の無い階段は null。
 */
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { STAIR_TYPE_LABEL } from '../finish/stair/stairTypeLabel.js';
import { DEFAULT_STAIR_ROOM_NAME } from '../finish/roomNamingOptions.js';

function roomRow(graph, room, name) {
  return {
    id: room.id,
    kind: 'room',
    name,
    ceilingBoard: null,
    ceilingFinish: room.finish?.ceilingMaterial || null,
    ch: roomCeilingHeight(graph, room).raw,
  };
}

/**
 * 選択中の天井セルの要約（パネル上段）。selection が無ければ null。
 * name・ch は行（内部＋階段）から owner.rowId で引く（見つからなければ name='—'・ch=null）。
 * cellCount は現行の格子で解けるキーの数（CL 削除などで消えたキーは数えない）。
 * @returns {{name: string, cellCount: number, ch: string|null} | null}
 */
export function selectionSummary(graph, selection) {
  if (!selection) return null;
  const row = [...interiorRows(graph), ...stairRows(graph)].find(r => r.id === selection.owner.rowId);
  let cellCount = 0;
  for (const key of selection.cellKeys) if (cellBoundsFromKey(key, graph)) cellCount++;
  return { name: row ? row.name : '—', cellCount, ch: row ? row.ch : null };
}

/** 仕上げ表の内部タブと同じ部屋・同じ並び・同じ表示名。 */
export function interiorRows(graph) {
  return interiorTabRooms(graph).map(room => roomRow(graph, room, interiorRoomDisplayName(room)));
}

/**
 * 仕上げ表の階段タブが並べる階段（この階の graph.stairs。階段タブの自階メンバーと同じ集合・順）。
 * 名前は変換元の部屋（stair.roomId）があればその名前（空なら階段の既定名）、無ければ階段タブの行表記
 * 「タイプ 段数」。部屋の無い階段（旧データ・上階自動設置分）は仕上げ欄を持たないので ch も null。
 */
export function stairRows(graph) {
  return graph.stairs.map(stair => {
    const room = stair.roomId ? graph.roomMap.get(stair.roomId) : null;
    if (room) return roomRow(graph, room, room.name || DEFAULT_STAIR_ROOM_NAME);
    return {
      id: stair.id,
      kind: 'stair',
      name: `${STAIR_TYPE_LABEL[stair.type] ?? stair.type} ${stair.totalSteps}段`,
      ceilingBoard: null,
      ceilingFinish: null,
      ch: null,
    };
  });
}
