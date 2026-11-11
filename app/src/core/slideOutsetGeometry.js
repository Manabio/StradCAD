// ================================================================
// 外付け引き戸の寸法の純計算（W・扉幅・穴の幅・戸尻側・穴 cut の区間）。唯一の定義。
// constants.js だけを引く（core は openings/ を引けない。core/structuralEntities.js の袖柱 AXIS 導出と
// openings/slideOutset.js の配置の両方がここを呼ぶ＝式を 1 か所に保つ）。用語は openings/slideOutset.js の冒頭を参照。
// ================================================================

import { SLIDE_OUTSET_WIDTH_DEDUCT_MM, FRAME_JAMB_WIDTH_MM } from './constants.js';

/** 建具幅 W から扉幅 DW＝(W+50)/2 を返す。W が有限でない・50 以下（穴が 0 以下＝不正）は null。 */
export function slideDoorWidth(width) {
  if (!Number.isFinite(width) || width <= SLIDE_OUTSET_WIDTH_DEDUCT_MM) return null;
  return (width + SLIDE_OUTSET_WIDTH_DEDUCT_MM) / 2;
}

/** 建具幅 W から穴の幅（穴の長さ）DW−50 を返す。slideDoorWidth が null なら null。 */
export function slideClearWidth(width) {
  const doorWidth = slideDoorWidth(width);
  return doorWidth === null ? null : doorWidth - SLIDE_OUTSET_WIDTH_DEDUCT_MM;
}

/** 引き代側（戸尻側）の端。opening.hingeSide が −1/1 ならそれ、それ以外は −1（裁定 R7 既定。−1＝coord1〔lo〕側）。 */
export function slideTailSide(opening) {
  const h = opening?.hingeSide;
  return h === -1 || h === 1 ? h : -1;
}

/**
 * 穴 cut の区間 [小, 大]（枠の外面〜外面）。W＝hi−lo、戸先端 A＝tailSide<0 ? hi : lo、sx＝tailSide の符号。
 * cut＝[A−sx·J, A+sx·(cutLength+J)]。W 不正（非有限・50 以下）は null。
 */
export function outsetSlideCutSpanOf(lo, hi, tailSide) {
  const cutLength = slideClearWidth(hi - lo);
  if (cutLength === null) return null;
  const latchAlong = tailSide < 0 ? hi : lo;
  const sx = tailSide < 0 ? -1 : 1;
  const a = latchAlong - sx * FRAME_JAMB_WIDTH_MM;
  const b = latchAlong + sx * (cutLength + FRAME_JAMB_WIDTH_MM);
  return a <= b ? [a, b] : [b, a];
}
