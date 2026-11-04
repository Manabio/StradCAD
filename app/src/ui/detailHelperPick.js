// 図面読込み（DXF・PDF 共通）のプレビュー上の矩形で成分を絞る純ロジック（S7c-1）。
// 矩形は選択の補助: bbox が矩形に完全に収まる成分（窓選択）で選択を置き換え、一覧もその成分だけに絞る。成分の分割は変えない。
// 矩形は「引いたときの scene」に結び付く（state.pick.scene === state.scene のときだけ有効）。単位の変更・再抽出で scene が
// 作り直されると自動で無効になるので、無効化の処理は他の関数に要らない（detailHelperForm.js・detailHelperPdf.js は触らない）。
// state は DXF（detailHelperForm.js の dxf）も PDF（detailHelperPdf.js の pdf）も { scene, selected, pick } の形。
// import は clip 検査・矩形の丸め・タップ判定・ズーム／パンの純関数（figureView.js）だけ（detailHelperForm.js からは引かない＝循環回避）。
import { isValidClip } from '../detail/pdf/pdfClip.js';
import { clipFromDrag } from './detailHelperPdf.js';
import { isTapDistance } from '../interaction/holdGesture.js';
import { viewOfTransform, zoomViewAt, panView, viewLimitsOf, isFrameUsable } from '../structural/sectionFigure/figureView.js';

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

/**
 * 1 本指のドラッグの種類。長押しが成立してから動かしたら矩形（矩形を引ける図のときだけ）、それ以外は移動（パン）。
 * 長押し前に 8px 超動いたら fired=false なのでパン。
 */
export function dragKindOf({ fired, canPick }) {
  return fired && canPick ? 'rect' : 'pan';
}

/** ズーム／パンの view（figureView.js。null＝全体）をオーナー（scene・下書きの key）に結び付ける。 */
export function bindView(owner, view) {
  return { owner, view };
}

/** 今有効な view。オーナーが変わった（単位変更・再抽出・別の下書き）か無いときは null（＝全体）。 */
export function activeView(binding, owner) {
  return binding && owner != null && binding.owner === owner ? binding.view : null;
}

/**
 * 測定した描画域の内寸(px。ResizeObserver の contentRect)からプレビューの枠を作る。小数は切り捨て。
 * 測定前（null）・0 以下・余白以下・非有限（測定の途中で 0 が返る瞬間など）は fallback（既定の枠）へ落とす
 * ＝viewBounds などの RangeError に届かない。
 */
export function previewFrameOf(measured, fallback) {
  if (!measured) return fallback;
  const frame = { width: Math.floor(measured.width), height: Math.floor(measured.height) };
  return isFrameUsable(frame) ? frame : fallback;
}

/**
 * 残した view を新しい図（レイヤ切替で範囲と全体の縮尺が変わる）に合わせる。全体の縮尺以下なら全体（null）、
 * それ以外は中心を新しい図の範囲へ寄せる。view が無ければ null。
 */
export function reconcileView(view, autoScale, contentBounds) {
  if (!view || view.scale <= autoScale) return null;
  return panView(view, 0, 0, contentBounds);
}

/** 1 本指のパン量（図の px。向きは指と同じ）。g＝押下時の { t, rect, from }、e＝今の { clientX, clientY }。CSS で拡大縮小されていても合うよう層の rect で換算する。 */
export function panDeltaPx(g, e) {
  return {
    dx: (e.clientX - g.from.clientX) * g.t.pxWidth / g.rect.width,
    dy: (e.clientY - g.from.clientY) * g.t.pxHeight / g.rect.height,
  };
}

/** pinchView に渡す引数の並び（開始の 2 指 p0a・p0b、今の 2 指 now.p1a・now.p1b）。指の順を入れ替えると拡大縮小が逆になる。 */
export function pinchArgsOf(g, now) {
  return [g.base, g.startT, g.p0a, g.p0b, now.p1a, now.p1b, g.limits, g.contentBounds];
}

/**
 * ホイール 1 フレーム分の拡大縮小後の view。全体（view=null）のときの基準は枠つきの viewOfTransform、中心は点 client の下の図の座標、
 * 結果は図の範囲へ寄せる。全体の縮尺以下になったら null（全体へ戻る）。
 */
export function wheelZoomedView({ view, t, frame, client, rect, factor, autoScale, contentBounds }) {
  const base = view ?? viewOfTransform(t, frame);
  const zoomed = zoomViewAt(base, figurePointToMm(client, rect, t), factor, viewLimitsOf(autoScale));
  return zoomed === null ? null : panView(zoomed, 0, 0, contentBounds);
}

/**
 * 基準点を指すときのスナップ半径（px）。snap.js の SNAP_THRESHOLD_PX と同値。
 * この純モジュールは snap.js（store.js 等を引く）を静的に引けないので同値を持つ（片方を変えたらもう片方も見直す）。
 */
export const DETAIL_BASE_SNAP_PX = 20;

/** プレビューのプリミティブから、基準線（guide）でない polyline の頂点 {x, y}（mm）を集める。 */
export function previewVertexPoints(prims) {
  const out = [];
  for (const p of prims ?? []) {
    if (!Array.isArray(p?.points) || p.guide) continue; // points を持つのは polyline だけ（import を増やさないため型は見ない）
    for (const [x, y] of p.points) out.push({ x, y });
  }
  return out;
}

/** points（{x, y}）のうち mm（{x, y}）に最も近い点。radiusMm 以内に無ければ null（同距離は先勝ち。非有限の入力も null）。 */
export function nearestPointWithin(points, mm, radiusMm) {
  if (!Number.isFinite(mm?.x) || !Number.isFinite(mm?.y) || !Number.isFinite(radiusMm)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of points ?? []) {
    const d = Math.hypot(p.x - mm.x, p.y - mm.y);
    if (d <= radiusMm && d < bestDist) { best = p; bestDist = d; }
  }
  return best;
}

/**
 * 図読込みのプレビューの view を、下書きへ写した直後のペン入力の view にする。下書きの座標は基準点 P が原点
 * （Anchor.offsetMm＝start−P）なので、中心から P を引く。view が無い（全体）なら null。
 */
export function draftViewOfImport(view, basePoint) {
  return view ? { scale: view.scale, cx: view.cx - basePoint.s, cy: view.cy - basePoint.t } : null;
}

/** 矩形の枠の CSS（プレビュー px。無効なら null）。 */
export function pickOverlayStyle(rect, t) {
  if (!isValidClip(rect)) return null;
  return { left: t.tx(rect.x), top: t.ty(rect.y), width: t.sx(rect.w), height: t.sx(rect.h) };
}
