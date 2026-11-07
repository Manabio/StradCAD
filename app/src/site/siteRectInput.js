// 敷地の長方形入力タブ・描画の判断を担う純関数（SiteInfoPanel.jsx / SiteRectsLayer.jsx が使う）。
// JSX は node:test で直接テストできないため、表の行・入力行・プレビュー矩形・Enter の遷移はここへ寄せる。
import { computeAttachedRect, computeUnionAreaM2 } from './siteRectGeometry.js';
import { evalNumpadExpr } from '../ui/numpadUtils.js';

// 基点の丸（赤・青）の Konva ノード名。pointerUp の「空白タップ＝選択解除」から除外するために使う
// （Konva は pointerup のあとで click を出すため、丸のタップが先に選択を消してしまう）
export const RECT_ANCHOR_NODE_NAME = 'site-rect-anchor';

// 入力欄の式を数値化する（有限かつ >0 のみ。それ以外は NaN）
export const evalRectLen = (s) => evalNumpadExpr(s, { positiveOnly: true });

/**
 * 長方形タブの表。番号は rects の順（1 始まり）。合計は和集合の面積（重なりは数えない）。
 * @returns {{ rows: {id:string, num:number, w:number, h:number, areaM2:number}[], totalAreaM2: number }}
 */
export function buildRectTableRows(rects) {
  const rows = rects.map((r, i) => ({
    id: r.id, num: i + 1, w: r.w, h: r.h, areaM2: (r.w * r.h) / 1_000_000,
  }));
  return { rows, totalAreaM2: computeUnionAreaM2(rects) };
}

// 入力状態 → 入力行の定義（cell は setRectFocusedCell へ渡す値）
export function rectInputRowDefs(st) {
  if (!st) return [];
  if (st.kind === 'first') {
    return [
      { cell: 'w', label: 'よこ', value: st.wValue },
      { cell: 'h', label: 'たて', value: st.hValue },
    ];
  }
  return [
    { cell: 'along', label: '辺長', value: st.alongValue },
    { cell: 'depth', label: '奥行', value: st.depthValue },
  ];
}

// 基点の端の表示名（赤丸が付く側）。a は座標の小さい側（辺が横なら左、縦なら上）
export function rectAnchorLabel(side, anchor) {
  const horizontal = side === 'n' || side === 's';
  if (anchor === 'a') return horizontal ? '左端' : '上端';
  return horizontal ? '右端' : '下端';
}

// フォーカス中のセルの値（キーボード・NumPad が現在値として使う）
export function rectFocusedValue(st) {
  return rectInputRowDefs(st).find(d => d.cell === st?.focusedCell)?.value ?? '';
}

// NumPad の見出し
export function rectNumpadLabel(st) {
  return rectInputRowDefs(st).find(d => d.cell === st?.focusedCell)?.label ?? '';
}

/**
 * Enter の遷移。1 つ目のセル（w / along）なら 2 つ目へ、2 つ目なら確定。
 * @returns {{ type:'focus', cell:string } | { type:'confirm' } | null}
 */
export function rectEnterAction(st) {
  if (!st) return null;
  if (st.focusedCell === 'w') return { type: 'focus', cell: 'h' };
  if (st.focusedCell === 'along') return { type: 'focus', cell: 'depth' };
  return { type: 'confirm' };
}

/**
 * 入力中の長方形のプレビュー矩形。両方の値が有効（有限かつ >0）でなければ null。
 * attach は共有辺（selectedEdge）の基の長方形と基点から computeAttachedRect で求める。
 * @returns {{x:number, y:number, w:number, h:number} | null}
 */
export function computeRectPreview(rectMap, selectedEdge, anchor, st) {
  if (!st) return null;
  if (st.kind === 'first') {
    const w = evalRectLen(st.wValue);
    const h = evalRectLen(st.hValue);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { x: st.origin.x, y: st.origin.y, w, h };
  }
  if (!selectedEdge) return null;
  const base = rectMap.get(selectedEdge.rectId);
  if (!base) return null;
  const along = evalRectLen(st.alongValue);
  const depth = evalRectLen(st.depthValue);
  if (!Number.isFinite(along) || !Number.isFinite(depth)) return null;
  return computeAttachedRect(base, selectedEdge.side, anchor, along, depth);
}
