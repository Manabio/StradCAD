// 敷地の配置（Site.placement）の確定操作＋Undo登録。siteRectEdit.js と同じ作法
// （runInAction で書き、undoManager.push で前の値／新しい値へ戻す）。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';

// 配置の確定（modes/SiteModeState.js commitPlacement）の拒否理由。siteRectEdit.js の TOAST_ と同じ置き方
export const TOAST_PLACEMENT_INCOMPLETE   = '頂点2点・通り芯・距離を指定してください';
export const TOAST_PLACEMENT_DISTANCE_BAD = '距離は 0 より大きい値で指定してください';
export const TOAST_PLACEMENT_UNSOLVABLE   = '配置を解けませんでした';
export const TOAST_PLACEMENT_ALONG_INCOMPLETE = '2 対目は頂点1・通り芯・離れをそろえて指定してください';
export const TOAST_PLACEMENT_ALONG_AXIS   = '2 対目の通り芯は 1 対目と直交する軸から選んでください';
export const TOAST_PLACEMENT_ALONG_UNSHARED = '2 対目の頂点1 は 1 対目の頂点のどちらかにしてください';

/**
 * 敷地の配置を next（null＝配置の解除）へ変える（undo あり）。
 * 参照が同じ値なら何もせず undo も積まない。
 * @returns {boolean} 変更したか
 */
export function applySitePlacementWithUndo(site, next) {
  const prev = site.placement;
  if (prev === next) return false;
  runInAction(() => site.setPlacement(next));
  undoManager.push(
    () => runInAction(() => site.setPlacement(prev)),
    () => runInAction(() => site.setPlacement(next)),
  );
  return true;
}
