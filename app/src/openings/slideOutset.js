// ================================================================
// 外付け引き戸（SLIDE_SINGLE）の幅・穴・引き代の純関数。
// react-konva・store.js・snap.js・.jsx を静的に引かない（node:test から単体 import 可能に保つ。
// openingPlanSymbolGeometry.js と同じ流儀）。
//
// 用語: W＝建具幅（最外の縦枠の内法＝扉の可動部。裁定 R2。縦枠の本体は W の外）。
//   DW＝扉 1 枚の幅＝(W+50)/2。穴＝壁を全厚で欠く区間（長さ DW−50）。引き代＝扉が引き込まれる壁面側の区間（長さ DW）。
//   戸先＝扉の閉じ側の端、戸尻＝引き代側の端（hingeSide で持つ。−1＝coord1〔lo〕側）。
// ================================================================

import { OpeningMechanism, findCatalogEntry } from './openingCatalog.js';
import { swingSideTowardPerp, findHostWall } from './openingGeometry.js';
import { SLIDE_OUTSET_WIDTH_DEDUCT_MM, SLIDE_OUTSET_RECESS_DEPTH_MM, FRAME_JAMB_WIDTH_MM } from '../core/constants.js';
import { slideDoorWidth, slideClearWidth, slideTailSide, outsetSlideCutSpanOf } from '../core/slideOutsetGeometry.js';

/** 外付け引き戸か（唯一の定義）。 */
export function isOutsetSlide(mechanism) {
  return mechanism === OpeningMechanism.SLIDE_SINGLE;
}

// 寸法の純計算（slideDoorWidth・slideClearWidth・slideTailSide・穴 cut の式）は core/slideOutsetGeometry.js が唯一の定義
// （core の袖柱 AXIS 導出と共有）。ここから再輸出する。
export { slideDoorWidth, slideClearWidth, slideTailSide };

/**
 * 外付け引き戸の配置。引き戸でない・W 不正・coord 非有限は null。
 * W＝|coord2−coord1|、doorWidth＝DW、cutLength＝DW−50（穴の長さ）。戸先端＝tailSide の反対の端。
 * latchAlong＝戸先端 A、jambWidth＝縦枠の見付 J。cut＝穴の区間 [A−sx·J, A+sx·(cutLength+J)]（枠の外面〜外面。sx＝戸尻へ向かう符号）、
 * recess.span＝欠き込みの区間 [A+sx·(cutLength+J), A+sx·(W+J)]、footprint＝占有区間 [lo−J, hi+J]（可動範囲・重なり判定用）。
 * pull＝W 内の引き代の区間 [lo,hi]（開けた扉の位置。cut とは J ずれる）。壁端・直交壁でのクリップは持たない
 * （壁の穴は wallSpanIntervals が壁の外を捨て、欠き込みは壁ごとの矩形からだけ引く）。
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
  const cutLength = slideClearWidth(hi - lo);
  const tailSide = slideTailSide(opening);
  const pull = tailSide < 0 ? [lo, hi - cutLength] : [lo + cutLength, hi];
  // 戸先端 A と戸尻へ向かう符号 sx。穴・欠き込みは縦枠の見付 J だけ W の外へ広がる（枠の外面〜外面。S3c）。
  const jambWidth = FRAME_JAMB_WIDTH_MM;
  const latchAlong = tailSide < 0 ? hi : lo;
  const sx = tailSide < 0 ? -1 : 1;
  const sorted = (a, b) => (a <= b ? [a, b] : [b, a]);
  const cut = outsetSlideCutSpanOf(lo, hi, tailSide); // 穴の式は core/slideOutsetGeometry.js の 1 か所
  const recessSpan = sorted(latchAlong + sx * (cutLength + jambWidth), latchAlong + sx * (hi - lo + jambWidth));
  const footprint = [lo - jambWidth, hi + jambWidth];
  const swingSide = opening.swingSide;
  const runPerpDir = swingSide === 1 || swingSide === -1 ? swingSideTowardPerp(opening.isVertical, tailSide, swingSide) : 0;
  const recess = runPerpDir === 0 ? null : { span: recessSpan, perpSide: runPerpDir, depth: SLIDE_OUTSET_RECESS_DEPTH_MM };
  return { doorWidth, cutLength, tailSide, latchAlong, jambWidth, cut, pull, footprint, runPerpDir, recess };
}

/** 建具の占有区間 [lo,hi]（可動範囲・重なり判定用）。外付け引き戸は枠の外面〜外面（W+2J）、それ以外（引き戸でない・不正・外壁ホスト）は開口全幅（恒等）。coord 非有限は null。 */
export function openingFootprint(opening, mechanism, host = null) {
  const { coord1, coord2 } = opening ?? {};
  if (!Number.isFinite(coord1) || !Number.isFinite(coord2)) return null;
  return outsetSlideLayout(opening, mechanism, host)?.footprint ?? [Math.min(coord1, coord2), Math.max(coord1, coord2)];
}

/** 配置前（建具がまだ無い）に使う、占有区間が W の両側へ広がる量 J。引き戸かつ host が外壁でなければ J、他は 0。 */
export function openingFootprintExtraHalf(mechanism, host = null) {
  if (!isOutsetSlide(mechanism) || host?.isExteriorWall === true) return 0;
  return FRAME_JAMB_WIDTH_MM;
}

const mechanismOf = opening => findCatalogEntry(opening?.category, opening?.subType)?.mechanism;

/**
 * 既存の建具の「いまの」占有区間が W の両側へ広がる量＝(footprint 幅 − W)/2（openingMoveRange の extraHalf 用）。
 * layout が引けない引き戸（W≤50・外壁ホスト・coord 非有限）は footprint が恒等なので 0（half と footprint 幅を合わせる）。
 */
export function openingFootprintExtraHalfOf(opening, wall) {
  const layout = outsetSlideLayout(opening, mechanismOf(opening), wall);
  if (!layout) return 0;
  const width = Math.abs(opening.coord2 - opening.coord1);
  return ((layout.footprint[1] - layout.footprint[0]) - width) / 2;
}

/** 幅を編集した「後」の占有が W の両側へ広がる量（機構と host から。W が小さくて今は layout が引けない建具の編集にも使う）。 */
export function openingEditExtraHalfOf(opening, wall) {
  return openingFootprintExtraHalf(mechanismOf(opening), wall);
}

/** 建具幅の下限（これ以下は外付け引き戸にならない）。外付け引き戸なら SLIDE_OUTSET_WIDTH_DEDUCT_MM、他は 0。 */
export function openingMinWidthOf(opening, wall) {
  return openingEditExtraHalfOf(opening, wall) > 0 ? SLIDE_OUTSET_WIDTH_DEDUCT_MM : 0;
}

/** graph 上の建具 → 占有区間の解決関数（openingGeometry.js / openingMove.js の footprintOf 引数へ渡す。編集時だけ使う）。 */
export function footprintResolver(graph) {
  // coord 非有限は openingFootprint が null。defaultSpanOf と同じ区間（NaN の比較は常に false）へ揃え、呼び出し側を TypeError にしない。
  return o => openingFootprint(o, mechanismOf(o), findHostWall(o, graph)) ?? [o.coord1, o.coord2];
}

/** 壁を全厚で欠く区間 [lo,hi]。外付け引き戸（配置が決まる）は穴 cut、それ以外（引き戸でない・不正・host が外壁〔R12〕）は開口全幅（恒等）。coord 非有限は null。 */
export function openingCutSpan(opening, mechanism, host = null) {
  const { coord1, coord2 } = opening ?? {};
  if (!Number.isFinite(coord1) || !Number.isFinite(coord2)) return null;
  return outsetSlideLayout(opening, mechanism, host)?.cut ?? [Math.min(coord1, coord2), Math.max(coord1, coord2)];
}

/**
 * 展開図用の「穴の代理」建具。外付け引き戸（layout 非 null）は coord1/coord2/width/centerCoord を穴 cut に替えた
 * 浅いコピー、それ以外（引き戸でない・外壁ホスト〔R12〕・不正）は**同じオブジェクト**（参照の同一性＝他の建具の出力不変の根拠）。
 * `{...opening}` は MobX の computed（centerCoord/coord1/coord2）を拾わないので 4 値を明示で上書きする
 * （innerSpanOpening と同じ注意）。refOffset・hingeSide 等の observable は own enumerable なので spread で残る。
 */
export function cutSpanOpening(opening, mechanism, host = null) {
  const cut = outsetSlideLayout(opening, mechanism, host)?.cut;
  if (!cut) return opening;
  // entityCenterCoord＝実体の中心（W の中心）。面の所属判定（手前の部屋の引き当て）は穴の中心でなく実体の位置で行うために残す。
  return {
    ...opening, id: opening.id, coord1: cut[0], coord2: cut[1], width: cut[1] - cut[0], centerCoord: (cut[0] + cut[1]) / 2,
    entityCenterCoord: opening.centerCoord,
  };
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
