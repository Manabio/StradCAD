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

export function makeRoomUndefined(room) {
  room.setName('');
  room.setFeature(RoomFeature.UNDEFINED);
  room.setTemplateKey(null);
  room.customOverrides.clear();
  for (const f of FINISH_FIELDS) room.finish.setField(f, '');
  room.setFloorLevel(null);
  room.namePosition = null;
  room.generatedWallIds.clear();
}
