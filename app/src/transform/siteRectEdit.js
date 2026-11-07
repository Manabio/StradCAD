// 敷地モード（長方形入力）の確定操作＋Undo登録。三斜の commitSiteTapLine（siteEdit.js）と同じ作法
// （runInAction で実体を作り、undoManager.push で removeRect / 同 id の addRect）。
// 選択状態（SiteModeState）は undo 対象外。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import { computeAttachedRect, isEdgeAttachable } from '../site/siteRectGeometry.js';

export const TOAST_RECT_EDGE_INNER   = '内側の辺には長方形を付けられません';
export const TOAST_RECT_ATTACH_BAD   = '長方形を構成できません（辺長が不正）';
export const TOAST_RECT_SIZE_BAD     = '長方形を構成できません（寸法が不正）';
export const TOAST_RECT_BASE_MISSING = '基になる長方形がありません';

function pushRectUndo(site, rect) {
  const { id, x, y, w, h } = rect;
  undoManager.push(
    () => runInAction(() => { site.removeRect(id); }),
    () => runInAction(() => { site.addRect(x, y, w, h, id); }),
  );
}

function addRectWithUndo(site, x, y, w, h) {
  let rect;
  runInAction(() => { rect = site.addRect(x, y, w, h); });
  pushRectUndo(site, rect);
  return rect.id;
}

/**
 * 最初の長方形（origin=左上角）を追加する。
 * @returns {{ ok: boolean, rectId: string|null, toast: string|null }}
 */
export function commitFirstRect(site, origin, w, h) {
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)
      || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, rectId: null, toast: TOAST_RECT_SIZE_BAD };
  }
  const rectId = addRectWithUndo(site, origin.x, origin.y, w, h);
  return { ok: true, rectId, toast: null };
}

/**
 * 共有辺（baseRectId の side）の外側に長方形を付ける。
 * @param {'a'|'b'} anchor 基点
 * @returns {{ ok: boolean, rectId: string|null, toast: string|null }}
 */
export function commitAttachedRect(site, baseRectId, side, anchor, alongLen, depthLen) {
  const base = site.rectMap.get(baseRectId);
  if (!base) return { ok: false, rectId: null, toast: TOAST_RECT_BASE_MISSING };
  if (!isEdgeAttachable(site.rects, baseRectId, side)) {
    return { ok: false, rectId: null, toast: TOAST_RECT_EDGE_INNER };
  }
  const g = computeAttachedRect(base, side, anchor, alongLen, depthLen);
  if (!g) return { ok: false, rectId: null, toast: TOAST_RECT_ATTACH_BAD };
  const rectId = addRectWithUndo(site, g.x, g.y, g.w, g.h);
  return { ok: true, rectId, toast: null };
}
