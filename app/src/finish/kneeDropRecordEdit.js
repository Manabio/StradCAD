// ================================================================
// 腰壁・垂れ壁ダイアログ（ui/KneeDropWallDialog.jsx）の判断（部分詳細図 S8b-1）。配線はダイアログ、判断はここ（純）。
//   - kneeDropDetailSelects     「天端の部分詳細」（腰壁の値があるとき）・「下端の部分詳細」（垂れ壁の値があるとき）の select
//   - kneeDropFrontSideOptions  表の側の 2 択（部屋名つき。区間の両側の部屋 roomNeg／roomPos）
//   - buildKneeDropRecord       ダイアログの入力＋既存の記録 → 次の記録（detailRefs・frontSide を引き継ぐ。両方空なら null＝解除）
// 割当ては仕上げの undo ではなく App.jsx の記録丸ごとの before/after（handleKneeDropWallConfirm）に乗る。
// ================================================================

import { DetailSlot, KNEE_DROP_DETAIL_SLOTS, KneeDropFrontSide } from '../core/constants.js';
import { kneeDropFrontSideOf, normalizeKneeDropRecord } from '../core/kneeDropRecord.js';
import { KNEE_DROP_DETAIL_TEXT } from '../error.js';
import { detailRefSelectsFor } from './roomDetailRefsEdit.js';

const LABEL_OF = Object.freeze({
  [DetailSlot.KNEE_TOP]: KNEE_DROP_DETAIL_TEXT.topLabel,
  [DetailSlot.DROP_BOTTOM]: KNEE_DROP_DETAIL_TEXT.bottomLabel,
});

/**
 * 値が入っている側の select だけ（腰壁の値→kneeTop・垂れ壁の値→dropBottom）。
 * @param {{kneeVal:number|null, dropVal:number|null, detailRefs?:object|null}} p
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 */
export function kneeDropDetailSelects({ kneeVal, dropVal, detailRefs = null }, figureList) {
  const slots = KNEE_DROP_DETAIL_SLOTS.filter(slot => (slot === DetailSlot.KNEE_TOP ? kneeVal != null : dropVal != null));
  return detailRefSelectsFor(slots, detailRefs, figureList, { labelOf: slot => LABEL_OF[slot] });
}

/**
 * 表の側の選択肢（値は KneeDropFrontSide）。ラベルは区間の両側の部屋名（無名・部屋なしは「（部屋なし）」）。
 * @param {{roomNeg?:{name?:string}|null, roomPos?:{name?:string}|null}|null} geo kneeDropWallGeometry/edgeGeometry の結果（null＝解決不能）
 */
export function kneeDropFrontSideOptions(geo) {
  const nameOf = room => (room && typeof room.name === 'string' && room.name !== '' ? room.name : KNEE_DROP_DETAIL_TEXT.noRoom);
  return [
    { value: KneeDropFrontSide.ROOM_NEG, label: nameOf(geo?.roomNeg) },
    { value: KneeDropFrontSide.ROOM_POS, label: nameOf(geo?.roomPos) },
  ];
}

/**
 * 確定時の記録。knee・drop が両方 null なら null（解除）。既存の記録の detailRefs・frontSide は引き継ぎ、
 * 外した側の割当て（腰壁を外した kneeTop・垂れ壁を外した dropBottom）は落とす（正規化は core/kneeDropRecord.js）。
 * @param {{kneeVal:number|null, dropVal:number|null, detailRefs?:object|null, frontSide?:string}} p
 * @returns {object|null}
 */
export function buildKneeDropRecord({ kneeVal, dropVal, detailRefs = null, frontSide }) {
  if (kneeVal == null && dropVal == null) return null;
  return normalizeKneeDropRecord({
    knee: kneeVal != null ? { topHeight: kneeVal } : null,
    drop: dropVal != null ? { bottomHeight: dropVal } : null,
    detailRefs,
    frontSide: kneeDropFrontSideOf({ frontSide }),
  });
}
