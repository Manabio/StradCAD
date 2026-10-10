/**
 * Room を「未定義」へ変換する（削除しても外壁線を維持するための残置）。
 * kind と cells は保持し、名前・feature・仕上げ関連のみ初期化する。
 * 未定義Room は仕上げ表から除外・無描画だがセル選択は可能（ドラッグで親指定Roomとして切り出せる）。
 *
 * modes/FinishModeState.js の `_makeUndefined` の中身をここへ移した（昇降機の仕様追加 ステップ3・
 * S3）。`removeEquipment`（finish/equipment/equipmentOps.js）が「Room の削除」と「空いたセルの
 * 未定義部屋化」を同時に成立させるために、モード状態を経由せず直接呼べる純関数として切り出す。
 */
import { RoomFeature } from '@core';
import { FINISH_FIELDS } from './roomReinterpret.js';
import { refreshCells } from './gridCells.js';

export function makeRoomUndefined(room) {
  room.setName('');
  room.setFeature(RoomFeature.UNDEFINED);
  room.setTemplateKey(null);
  room.customOverrides.clear();
  room.setCeilingZones([]); // 天井区画も初期化（仕上げ関連。天井を持たない未定義に区画は残さない）
  for (const f of FINISH_FIELDS) room.finish.setField(f, '');
  room.setFloorLevel(null);
  room.namePosition = null;
  room.generatedWallIds.clear();
}

/**
 * cells を未定義Room群から取り除く（命名確定・新規候補室の削除取消・昇降機の上階自動設置で呼ぶ）。
 * refreshCells で現行キーへ正規化した集合から差し引き、空になった未定義Roomは削除する。
 *
 * modes/FinishModeState.js の `_subtractCellsFromUndefined` の中身をここへ移した（昇降機の仕様追加
 * ステップ4・S2）。`installOnUpperFloor`（finish/equipment/equipmentFloorPlan.js）が上階の一時グラフへ
 * モード状態を経由せず直接呼ぶため。
 * @param {object} graph
 * @param {Set<string>} cells
 */
export function subtractCellsFromUndefinedRooms(graph, cells) {
  for (const u of graph.rooms) {
    if (u.feature !== RoomFeature.UNDEFINED) continue;
    const current = refreshCells(u.cells, graph);
    const remaining = new Set([...current].filter(c => !cells.has(c)));
    if (remaining.size === 0) graph.removeRoom(u.id);
    else u.setCells(remaining);
  }
}
