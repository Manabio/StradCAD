// 長方形入力の確定（モード状態 → commitFirstRect / commitAttachedRect の振り分け）。
// 三斜の confirmSiteTriangle（siteEdit.js）と同じ形: 値が無効なら何もせず toast なし、
// 失敗時は toast を返す。成功後は呼び出し側ではなくここで clearRectInput する。
import { commitFirstRect, commitAttachedRect } from './siteRectEdit.js';

/**
 * @param {import('../core/site.js').Site} site
 * @param {object} mode SiteModeState
 * @param {(s:string)=>number} evalExpr 式 → 数値（無効は NaN）
 * @returns {{ toast: string|null }}
 */
export function confirmSiteRect(site, mode, evalExpr) {
  const st = mode?.rectInputState;
  if (!st) return { toast: null };
  let result;
  if (st.kind === 'first') {
    const w = evalExpr(st.wValue);
    const h = evalExpr(st.hValue);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return { toast: null };
    result = commitFirstRect(site, st.origin, w, h);
  } else {
    const edge = mode.selectedRectEdge;
    if (!edge) return { toast: null };
    const along = evalExpr(st.alongValue);
    const depth = evalExpr(st.depthValue);
    if (!Number.isFinite(along) || !Number.isFinite(depth)) return { toast: null };
    result = commitAttachedRect(site, edge.rectId, edge.side, mode.rectAnchor, along, depth);
  }
  if (result.ok) mode.clearRectInput();
  return { toast: result.toast };
}
