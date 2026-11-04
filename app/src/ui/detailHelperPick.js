// 図面読込み（DXF・PDF 共通）のプレビュー上の矩形で成分を絞る純ロジック（S7c-1）。
// 矩形は選択の補助: bbox が矩形に完全に収まる成分（窓選択）で選択を置き換え、一覧もその成分だけに絞る。成分の分割は変えない。
// 矩形は「引いたときの scene」に結び付く（state.pick.scene === state.scene のときだけ有効）。単位の変更・再抽出で scene が
// 作り直されると自動で無効になるので、無効化の処理は他の関数に要らない（detailHelperForm.js・detailHelperPdf.js は触らない）。
// state は DXF（detailHelperForm.js の dxf）も PDF（detailHelperPdf.js の pdf）も { scene, selected, pick } の形。
// import は clip 検査・矩形の丸め・タップ判定の 3 つだけ（detailHelperForm.js からは引かない＝循環回避）。
import { isValidClip } from '../detail/pdf/pdfClip.js';
import { clipFromDrag } from './detailHelperPdf.js';
import { isTapDistance } from '../interaction/holdGesture.js';

/** bbox が矩形（{x,y,w,h}。x=s・y=t・t 下向き正。境界を含む）に完全に収まる成分の index（昇順）。矩形が無効なら []。bbox の無い成分は対象外。 */
export function componentsInRect(components, rect) {
  if (!isValidClip(rect)) return [];
  const maxX = rect.x + rect.w;
  const maxY = rect.y + rect.h;
  const picked = [];
  for (const c of components) {
    const b = c.bbox;
    if (b && b.minS >= rect.x && b.maxS <= maxX && b.minT >= rect.y && b.maxT <= maxY) picked.push(c.index);
  }
  return picked;
}

/** 今有効な矩形（scene が引いたときと同じオブジェクトで、矩形が有効）。無ければ null。 */
export function activePickRect(state) {
  const pick = state?.pick;
  return pick && state.scene && pick.scene === state.scene && isValidClip(pick.rect) ? pick.rect : null;
}

/** 矩形を指定し、矩形内の成分で選択を置き換える。矩形が無効なら state をそのまま返す。 */
export function setPickRect(state, rect) {
  if (!state?.scene || !isValidClip(rect)) return state;
  return {
    ...state,
    pick: { scene: state.scene, rect: { ...rect } },
    selected: componentsInRect(state.scene.components, rect),
  };
}

/** 矩形だけを外す（選択はそのまま）。 */
export function clearPickRect(state) {
  return { ...state, pick: null };
}

/** 成分一覧の行（dxfComponentRows の結果 rows）。矩形があれば矩形内の成分の行だけ、無ければそのまま。 */
export function pickedComponentRows(state, rows) {
  if (!activePickRect(state)) return rows;
  const inRect = new Set(componentsInRect(state.scene.components, activePickRect(state)));
  return rows.filter(r => inRect.has(r.index));
}

/** 一覧の見出し用の件数。矩形が無ければ null。 */
export function pickSummaryOf(state) {
  const rect = activePickRect(state);
  if (!rect) return null;
  return { inRect: componentsInRect(state.scene.components, rect).length, total: state.scene.components.length, selected: state.selected.length };
}

/** 画面の点 → 図の座標 mm（rect=プレビュー SVG の getBoundingClientRect、t=makeTransform の結果）。CSS で拡大縮小されていても合う。 */
export function figurePointToMm({ clientX, clientY }, rect, t) {
  const px = (clientX - rect.left) * t.pxWidth / rect.width;
  const py = (clientY - rect.top) * t.pxHeight / rect.height;
  return { x: t.mmX(px), y: t.mmY(py) };
}

/** ドラッグの 2 点（{clientX, clientY, mm}）→ 矩形。タップの距離なら null（選択も矩形も変えない）。 */
export function pickRectFromDrag(from, to) {
  if (isTapDistance(Math.hypot(to.clientX - from.clientX, to.clientY - from.clientY))) return null;
  return clipFromDrag(from.mm, to.mm);
}

/** 矩形の枠の CSS（プレビュー px。無効なら null）。 */
export function pickOverlayStyle(rect, t) {
  if (!isValidClip(rect)) return null;
  return { left: t.tx(rect.x), top: t.ty(rect.y), width: t.sx(rect.w), height: t.sx(rect.h) };
}
