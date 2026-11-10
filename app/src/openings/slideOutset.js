// ================================================================
// 外付け引き戸（SLIDE_SINGLE）の幅・穴・引き代の純関数。
// react-konva・store.js・snap.js・.jsx を静的に引かない（node:test から単体 import 可能に保つ。
// openingPlanSymbolGeometry.js と同じ流儀）。
//
// 用語: W＝建具幅（最外の縦枠の内法＝扉の可動部。裁定 R2。縦枠の本体は W の外）。
//   DW＝扉 1 枚の幅＝(W+50)/2。穴＝壁を全厚で欠く区間（長さ DW−50）。引き代＝扉が引き込まれる壁面側の区間（長さ DW）。
//   戸先＝扉の閉じ側の端、戸尻＝引き代側の端（hingeSide で持つ。−1＝coord1〔lo〕側）。
// ================================================================

import { OpeningMechanism } from './openingCatalog.js';
import { swingSideTowardPerp } from './openingGeometry.js';
import { SLIDE_OUTSET_WIDTH_DEDUCT_MM, SLIDE_OUTSET_RECESS_DEPTH_MM } from '../core/constants.js';

/** 外付け引き戸か（唯一の定義）。 */
export function isOutsetSlide(mechanism) {
  return mechanism === OpeningMechanism.SLIDE_SINGLE;
}

/** 建具幅 W から扉幅 DW＝(W+50)/2 を返す。W が有限でない・50 以下（穴が 0 以下＝不正）は null。 */
export function slideDoorWidth(width) {
  if (!Number.isFinite(width) || width <= SLIDE_OUTSET_WIDTH_DEDUCT_MM) return null;
  return (width + SLIDE_OUTSET_WIDTH_DEDUCT_MM) / 2;
}

/** 引き代側（戸尻側）の端。opening.hingeSide が −1/1 ならそれ、それ以外は −1（裁定 R7 既定。−1＝coord1〔lo〕側）。 */
export function slideTailSide(opening) {
  const h = opening?.hingeSide;
  return h === -1 || h === 1 ? h : -1;
}

/**
 * 外付け引き戸の配置。引き戸でない・W 不正・coord 非有限は null。
 * W＝|coord2−coord1|、doorWidth＝DW、cutLength＝DW−50（穴の長さ）。戸先端＝tailSide の反対の端。
 * cut＝穴の区間 [lo,hi]、pull＝引き代の区間 [lo,hi]（cut と pull で [lo,hi] を隙間なく覆う）。
 * runPerpDir＝扉が走る面の直交方向の符号＝(isVertical?1:−1)×swingSide×hingeSide（開き戸の開く側と同じ積。openingGeometry.js
 * swingSideTowardPerp に委ねる）。swingSide が ±1 でないときは 0（走る面が決まらない。swingSideTowardPerp の「0→1 の fallback」は
 * 開き戸の既定値決定のためのもので、ここで黙って片面に寄せると平面・展開の穴の側が一致しないので採らない）。
 * recess＝引き代区間の欠き込み { span: pull, perpSide: runPerpDir, depth }（runPerpDir 0＝走る面不定は null＝欠き込まない）。
 * host（任意・ホスト壁）が外壁（isExteriorWall===true）なら null（R12: 外壁の引き戸は外付けにしない＝従来描き）。
 */
export function outsetSlideLayout(opening, mechanism, host = null) {
  if (!isOutsetSlide(mechanism)) return null;
  if (host?.isExteriorWall === true) return null; // R12: 外壁をホストにする引き戸は従来描き（外付けにしない）
  const { coord1, coord2 } = opening ?? {};
  if (!Number.isFinite(coord1) || !Number.isFinite(coord2)) return null;
  const lo = Math.min(coord1, coord2);
  const hi = Math.max(coord1, coord2);
  const doorWidth = slideDoorWidth(hi - lo);
  if (doorWidth === null) return null;
  const cutLength = doorWidth - SLIDE_OUTSET_WIDTH_DEDUCT_MM;
  const tailSide = slideTailSide(opening);
  const cut = tailSide < 0 ? [hi - cutLength, hi] : [lo, lo + cutLength];
  const pull = tailSide < 0 ? [lo, hi - cutLength] : [lo + cutLength, hi];
  const swingSide = opening.swingSide;
  const runPerpDir = swingSide === 1 || swingSide === -1 ? swingSideTowardPerp(opening.isVertical, tailSide, swingSide) : 0;
  const recess = runPerpDir === 0 ? null : { span: pull, perpSide: runPerpDir, depth: SLIDE_OUTSET_RECESS_DEPTH_MM };
  return { doorWidth, cutLength, tailSide, cut, pull, runPerpDir, recess };
}

/** 壁を全厚で欠く区間 [lo,hi]。外付け引き戸（配置が決まる）は穴 cut、それ以外（引き戸でない・不正・host が外壁〔R12〕）は開口全幅（恒等）。coord 非有限は null。 */
export function openingCutSpan(opening, mechanism, host = null) {
  const { coord1, coord2 } = opening ?? {};
  if (!Number.isFinite(coord1) || !Number.isFinite(coord2)) return null;
  return outsetSlideLayout(opening, mechanism, host)?.cut ?? [Math.min(coord1, coord2), Math.max(coord1, coord2)];
}

/**
 * 引き代区間の欠き込みの帯（世界座標）。recess は outsetSlideLayout().recess、faceRange は実ホスト壁の
 * wallFaceRange(host, graph)＝[面の小, 面の大]（呼び元が実ホスト壁で求める）。
 * 走る面＝perpSide>0 なら faceRange[1]・perpSide<0 なら faceRange[0]。across＝その面から深さ d だけ壁の内側。
 * recess が無い・perpSide 0・faceRange が非有限・壁厚（faceRange の幅）が d 以下（T3）は null（欠き込まない）。
 * @returns {{along:[number,number], across:[number,number]}|null}
 */
export function slideRecessBand(recess, faceRange) {
  if (!recess || !Array.isArray(recess.span) || !Array.isArray(faceRange)) return null;
  const [f0, f1] = faceRange;
  const d = recess.depth;
  if (![f0, f1, d, recess.span[0], recess.span[1]].every(Number.isFinite)) return null;
  if (f1 - f0 <= d) return null;
  const along = [recess.span[0], recess.span[1]];
  if (recess.perpSide > 0) return { along, across: [f1 - d, f1] };
  if (recess.perpSide < 0) return { along, across: [f0, f0 + d] };
  return null;
}
