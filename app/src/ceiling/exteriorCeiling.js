/**
 * 屋外部屋の天井（屋外 S1。純モジュール。react・store.js・snap.js・.jsx・graphDerived を静的に引かない）。
 * 裁定 2026-10-18: 屋外部屋（ポーチ等。feature なし）は既定で天井を持ち、部屋ごとに外せる。
 * 屋根・屋外階段・昇降路・未定義・階段吹抜けは feature を持つので対象外。
 *
 * 保存先は Room.customOverrides の 1 キー（FBS・graphSnapshot・undo スナップショット・仕上げ再解釈は汎用の keys/vals で往復するので変更なし）:
 *   exteriorCeiling … 天井を外したときだけ '0'（既定 ON はキー無し。roomCeilingShape.js の ceilingShape と同じ流儀）
 * 読みは roomCeilingShapeOf と同じく getFinishInfo 経由（マスター値との合成を 1 か所に保つ）。
 */
import { RoomKind } from '../core/constants.js';

export const EXTERIOR_CEILING_KEY = 'exteriorCeiling';

/** 屋外の部屋で feature なし（天井を持ちうる屋外部屋）か。null・undefined は false。 */
export function isExteriorCeilingRoom(room) {
  return room?.kind === RoomKind.EXTERIOR && room.feature == null;
}

/** 屋外部屋が天井を持つか（既定 ON。'0' で OFF）。対象外の部屋・getFinishInfo の無い物体は false。 */
export function exteriorCeilingEnabled(room) {
  if (!isExteriorCeilingRoom(room)) return false;
  if (typeof room.getFinishInfo !== 'function') return false;
  return room.getFinishInfo()?.[EXTERIOR_CEILING_KEY] !== '0';
}

/** 屋外部屋の天井の ON/OFF を書く。ON はキーを消し、OFF は '0'。呼び側が withFinishUndo で包む前提（ここは undo を積まない）。 */
export function setExteriorCeilingEnabled(room, on) {
  if (on) room.clearOverride(EXTERIOR_CEILING_KEY);
  else room.setOverride(EXTERIOR_CEILING_KEY, '0');
}
