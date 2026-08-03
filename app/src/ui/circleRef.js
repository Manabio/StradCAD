// ラベルなしCL（中心線・補助線・梁芯）を参照候補として示す「丸数字」表記の単一ソース。
// AddCLDialog.jsx・WallDialog.jsx（参照候補ドロップダウン）・renderer/WallRefIndicator.jsx（キャンバス
// オーバーレイ）が同じ配列・同じ index を共有することで、ダイアログの候補列とキャンバス表示の番号を
// 二系統に分岐させない（採番の一貫性。.claude/structural-model.md 参照）。
import { centerLineKind } from '../core.js';

export const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/** 配列index i の丸数字表記（10件を超える分は "(11)" 形式にフォールバック）。 */
export function circleRefSymbol(i) {
  return CIRCLE_NUMS[i] ?? `(${i + 1})`;
}

/** 参照候補CLの種別ラベル（ラベル済みCLはcl.labelをそのまま使うため通常は該当しない）。
 *  梁芯（centerLineKind==='beam'）だけ「梁芯」、それ以外は従来通り「中心線」。 */
export function circleRefKindLabel(cl) {
  return cl.label || (centerLineKind(cl) === 'beam' ? '梁芯' : '中心線');
}
