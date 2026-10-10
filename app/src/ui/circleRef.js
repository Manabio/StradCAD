// ラベルなしCL（中心線・補助線・梁芯）を参照候補として示す「丸数字」表記の単一ソース。
// AddCLDialog.jsx（参照候補ドロップダウン）・renderer/WallRefIndicator.jsx（キャンバス
// オーバーレイ）が同じ配列・同じ index を共有することで、ダイアログの候補列とキャンバス表示の番号を
// 二系統に分岐させない（採番の一貫性。.claude/structural-model.md 参照）。
import { centerLineKind } from '../core.js';
import { KIND_LABEL } from '../error.js';

export const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/** 配列index i の丸数字表記（10件を超える分は "(11)" 形式にフォールバック）。 */
export function circleRefSymbol(i) {
  return CIRCLE_NUMS[i] ?? `(${i + 1})`;
}

/** 参照候補CLの種別ラベル（ラベル済みCLはcl.labelをそのまま使うため通常は該当しない）。
 *  梁芯は「梁芯」、天井芯は「天井芯」、それ以外は従来通り「中心線」。
 *  種別名のインライン比較（ガード G3）を避け、種別→表示名の表引きにしてある。 */
const REF_LABELED_KINDS = Object.freeze(['beam', 'ceiling']);
export function circleRefKindLabel(cl) {
  const kind = centerLineKind(cl);
  return cl.label || KIND_LABEL[REF_LABELED_KINDS.includes(kind) ? kind : 'center'];
}
