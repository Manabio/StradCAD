// 敷地の配置（Site.placement）の確定操作＋Undo登録。siteRectEdit.js と同じ作法
// （runInAction で書き、undoManager.push で前の値／新しい値へ戻す）。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';

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
