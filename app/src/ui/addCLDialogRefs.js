// ================================================================
// CL追加ダイアログ（AddCLDialog.jsx）の「参照」まわりの純ロジック。
//  - 既定の参照（最寄りの選択肢）と距離の初期値
//  - 確定時に参照を永続化する形（refId・refOffset）へ畳む処理
// 吸着専用の参照（構造モードの中心線。core/centerLineKindPolicy.js ADD_DIALOG_SNAP_ONLY_KINDS_BY_MODE）は
// 「その位置へ吸着するための目印」で、参照としては保存しない（絶対座標・refId なし。中心線を後で動かしても
// 追従しない。規則C 案c・S3-3）。
// react/store/.jsx を静的に引かない（node:test から単体 import 可能）。
// ================================================================
import { isRenderTarget, isAddDialogSnapOnlyRef } from '../core/centerLineKindPolicy.js';
import { AddCLOptionKind } from '../core/constants.js';

/**
 * 追加ダイアログの参照候補にする実CLか。描画対象（isRenderTarget）に加え、吸着専用の参照
 * （構造モードの中心線。isAddDialogSnapOnlyRef）は主構造が許すときだけ（rules.manualBeamAxisOnArchLines＝S造。
 * 2026-10-27 限定）。ポリシー（core）は主構造を知らないため、主構造の判定はここ（呼び出し側の rules）で行う。
 * @param {object} cl
 * @param {string} appMode
 * @param {{manualBeamAxisOnArchLines: boolean}} rules rulesFor(effectiveStructure(graph, project))
 * @returns {boolean}
 */
export function isAddDialogRefCandidate(cl, appMode, rules) {
  if (rules == null) throw new Error('isAddDialogRefCandidate: rules が必要です');
  return isRenderTarget(cl, appMode) || (rules.manualBeamAxisOnArchLines && isAddDialogSnapOnlyRef(cl, appMode));
}

// 合成の選択肢（柱芯）か。印 optionKind（core/constants.js AddCLOptionKind）で見分け、実CLの選択肢は持たない。
// 印が無いのに clId を持つ形は合成の選択肢の作り忘れ（centerLineKind が既定種別 'center' に黙って落ちる）
// なので、推定せず throw する。
function isSynthetic(option) {
  if (option.optionKind == null) {
    if (option.clId != null) throw new Error(`参照の選択肢に optionKind がありません: ${option.id}`);
    return false;
  }
  if (!Object.values(AddCLOptionKind).includes(option.optionKind)) {
    throw new Error(`未知の optionKind: ${option.optionKind}`);
  }
  return true;
}

// 吸着専用の選択肢か。種別の自動導出には実CLだけを通す（合成の選択肢は対象外）。
function isSnapOnlyOption(option, appMode) {
  return !isSynthetic(option) && isAddDialogSnapOnlyRef(option, appMode);
}

/**
 * 参照 refCL を選んだときの距離欄の初期値。参照なしは絶対座標（sign * worldCoord。Y軸は符号反転）、
 * 吸着専用の参照は '0'（その線そのものの位置）、それ以外は参照との距離。
 * @param {object|null} refCL
 * @param {number} worldCoord
 * @param {string} appMode
 * @param {number} sign 垂直線 1・水平線 -1
 * @returns {string}
 */
export function distStrForRef(refCL, worldCoord, appMode, sign) {
  if (!refCL) return String(Math.round(sign * worldCoord));
  if (isSnapOnlyOption(refCL, appMode)) return '0';
  return String(Math.round(Math.abs(worldCoord - refCL.value)));
}

/**
 * 既定の参照（値が worldCoord に最も近い選択肢。同距離は先頭）と距離欄の初期値。選択肢0件は絶対座標。
 * @param {Array<object>} allOptions
 * @param {number} worldCoord
 * @param {string} appMode
 * @param {number} sign 垂直線 1・水平線 -1
 * @returns {{refId: string, distStr: string}}
 */
export function initialRef(allOptions, worldCoord, appMode, sign) {
  const nearest = allOptions.length > 0
    ? allOptions.reduce((best, cl) =>
        Math.abs(cl.value - worldCoord) < Math.abs(best.value - worldCoord) ? cl : best)
    : null;
  return { refId: nearest?.id ?? '', distStr: distStrForRef(nearest, worldCoord, appMode, sign) };
}

/**
 * 確定時に onConfirm へ渡す参照を畳む。
 *  - 参照なし・吸着専用: 絶対座標（refId null・refOffset null）。値は呼び出し側が previewWorld を渡す。
 *  - 柱芯（合成CL）: 元の通り芯 clId＋静的オフセット（柱芯偏芯量＋距離）。通り芯の移動には追従するが、
 *    出幅編集による柱芯の再計算には追従しない（割り切り）。
 *  - それ以外: 選んだCLの id＋符号つき距離。
 * @param {object|null} refCL
 * @param {string} appMode
 * @param {{dist: number, dir: number|null}} offset 距離（非負）と方向（参照から目標への +1/-1）
 * @returns {{refId: string|null, refOffset: number|null}}
 */
export function foldRefForConfirm(refCL, appMode, { dist, dir }) {
  if (!refCL || isSnapOnlyOption(refCL, appMode)) return { refId: null, refOffset: null };
  if (refCL.optionKind === AddCLOptionKind.COLUMN_AXIS) return { refId: refCL.clId, refOffset: refCL.axisOffset + dist * dir };
  return { refId: refCL.id, refOffset: dist * dir };
}
