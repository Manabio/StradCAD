// ================================================================
// 断面図プレビューのズーム／パン（純モジュール。import は sectionGeometry.js だけ）
//
// view = { scale, cx, cy }: 枠(frame)の中央に映る図の座標(mm)と縮尺(px/mm)。null は「全体」（従来の自動縮尺）。
// viewBounds で bounds に戻し makeTransform へ渡すと pxWidth＝frame.width・pxHeight＝frame.height の変換になる
// （描画・overlay・寸法ラベルは同じ t で追従する）。
//
// 入力の扱い（統一）:
//   - 呼び出し側のバグ（非有限・scale 0 以下・frame が余白以下・limits 不正）は RangeError を投げる。
//   - 「全体へ戻る」は null（zoomViewAt／pinchView／fitViewToRect で縮尺が minScale 以下になったとき）。
//   - fitViewToRect は矩形が無効（非有限・幅/高さ 0 以下）でも null（寄せる対象が無い）。
//   - limits = { minScale, maxScale }。minScale は全体の縮尺（chooseScale の値）、maxScale は FIGURE_VIEW_MAX_SCALE。
// ================================================================
import { FIGURE_MARGIN_PX, makeTransform, figureBounds, chooseScale } from './sectionGeometry.js';

// 最大の拡大（px/mm）。viewport.js の zoomAt の上限と同値（サッシの 1.2 mm の材が 24 px）。
export const FIGURE_VIEW_MAX_SCALE = 20;
// ホイール 1 回の倍率。interaction/usePointerInteraction.js のホイール倍率と同値（共通化は整理課題）。
export const FIGURE_WHEEL_ZOOM_FACTOR = 1.1;

const finite = (...vs) => vs.every(Number.isFinite);

function assertScale(scale, what) {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError(`${what}は正の有限値: ${scale}`);
}

function assertView(view) {
  if (!view || !finite(view.cx, view.cy)) throw new RangeError('view が不正');
  assertScale(view.scale, 'view.scale');
}

function assertLimits(limits) {
  if (!limits) throw new RangeError('limits が無い');
  assertScale(limits.minScale, 'minScale');
  assertScale(limits.maxScale, 'maxScale');
  if (limits.minScale > limits.maxScale) throw new RangeError(`minScale(${limits.minScale}) > maxScale(${limits.maxScale})`);
}

function assertFrame(frame) {
  if (!frame || !finite(frame.width, frame.height)
    || frame.width <= 2 * FIGURE_MARGIN_PX || frame.height <= 2 * FIGURE_MARGIN_PX) {
    throw new RangeError(`frame が余白(${FIGURE_MARGIN_PX}px×2)以下: ${JSON.stringify(frame)}`);
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 中心を図の範囲の中へ収める。
function clampCenter(view, contentBounds) {
  if (!contentBounds || !finite(contentBounds.minX, contentBounds.maxX, contentBounds.minY, contentBounds.maxY)) {
    throw new RangeError('contentBounds が不正');
  }
  return {
    scale: view.scale,
    cx: clamp(view.cx, contentBounds.minX, contentBounds.maxX),
    cy: clamp(view.cy, contentBounds.minY, contentBounds.maxY),
  };
}

/** view と枠(px)から makeTransform に渡す bounds を作る。 */
export function viewBounds(view, frame) {
  assertView(view);
  assertFrame(frame);
  const width = (frame.width - 2 * FIGURE_MARGIN_PX) / view.scale;
  const height = (frame.height - 2 * FIGURE_MARGIN_PX) / view.scale;
  const minX = view.cx - width / 2;
  const minY = view.cy - height / 2;
  return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
}

/** view で描いたときの変換 t（AutoScaledFigure が view のときに作るものと同じ。pinchView の startT に渡す）。 */
export function transformOfView(view, frame) {
  return makeTransform(viewBounds(view, frame), view.scale);
}

/** 全体の縮尺（AutoScaledFigure が primitives から決める autoScale と同じ式）。プリミティブが空なら RangeError。 */
export function autoScaleOfPrimitives(primitives, frame) {
  assertFrame(frame);
  if (!primitives?.length) throw new RangeError('primitives が空');
  const b = figureBounds(primitives);
  return chooseScale(b.width, b.height, frame.width, frame.height);
}

/** 図の範囲（AutoScaledFigure が overlay の第 2 引数 contentBounds に渡すものと同じ figureBounds）。空なら RangeError。 */
export function contentBoundsOfPrimitives(primitives) {
  if (!primitives?.length) throw new RangeError('primitives が空');
  return figureBounds(primitives);
}

/** 全体の縮尺から zoom の範囲。全体の縮尺が最大より大きい（極小の図）ときは最大を全体に合わせる（minScale ≤ maxScale を保つ）。 */
export function viewLimitsOf(autoScale) {
  return { minScale: autoScale, maxScale: Math.max(FIGURE_VIEW_MAX_SCALE, autoScale) };
}

/**
 * 自動縮尺の変換 t（makeTransform の戻り。左上基準）から、同じ見え方の view を作る。
 * AutoScaledFigure は view のとき枠(frame＝maxWidth×maxHeight)の中央基準で描くので、中心は frame の中央に当たる点。
 * これで tOf(view).tx(mm) ≡ t.tx(mm)（「全体」から最初にズームしても図が跳ばない）。
 */
export function viewOfTransform(t, frame) {
  assertFrame(frame);
  return { scale: t.scale, cx: t.mmX(frame.width / 2), cy: t.mmY(frame.height / 2) };
}

/**
 * pivotMm({x,y})の画面位置を保って factor 倍する。結果が minScale 以下なら null（＝全体）、maxScale で頭打ち。
 * 中心はクランプしない（pivot の不変を保つため）。ホイール後は呼び出し側が panView(view, 0, 0, contentBounds) で
 * 範囲に寄せる（S7d-2 の層で行う）。
 */
export function zoomViewAt(view, pivotMm, factor, limits) {
  assertView(view);
  assertLimits(limits);
  if (!pivotMm || !finite(pivotMm.x, pivotMm.y)) throw new RangeError('pivot が不正');
  assertScale(factor, 'factor');
  const scale = Math.min(limits.maxScale, view.scale * factor);
  if (scale <= limits.minScale) return null;
  // 画面位置 = 枠中央 + (mm − 中心) × scale なので、保つには (p − cx)·s ＝ (p − cx')·s'。
  const k = view.scale / scale;
  return { scale, cx: pivotMm.x - (pivotMm.x - view.cx) * k, cy: pivotMm.y - (pivotMm.y - view.cy) * k };
}

/** 画面を (dxPx, dyPx) だけドラッグしたときの view（図は指に付いてくる＝中心は逆向き）。中心は contentBounds の中へ。 */
export function panView(view, dxPx, dyPx, contentBounds) {
  assertView(view);
  if (!finite(dxPx, dyPx)) throw new RangeError('パン量が不正');
  return clampCenter({ scale: view.scale, cx: view.cx - dxPx / view.scale, cy: view.cy - dyPx / view.scale }, contentBounds);
}

/**
 * 2 指（開始 p0a,p0b → 現在 p1a,p1b。{x,y} は図の px 座標＝startT と同じ空間）のピンチ。
 * 距離比で縮尺、中点の移動でパン（開始の中点にあった図の点が現在の中点に来る）。minScale 以下は null。
 * startT は tOf(startView, frame)＝startView で描いた t（makeTransform(viewBounds(startView, frame), startView.scale)）。
 * 自動縮尺の t は不可（枠の中央基準でなく左上基準のため中心がずれる）。
 * 開始の 2 指が同じ点（距離 0）は UI 由来の入力なので例外にせず startView をそのまま返す（変化なし）。
 */
export function pinchView(startView, startT, p0a, p0b, p1a, p1b, limits, contentBounds) {
  assertView(startView);
  assertLimits(limits);
  for (const p of [p0a, p0b, p1a, p1b]) if (!p || !finite(p.x, p.y)) throw new RangeError('指の位置が不正');
  const d0 = Math.hypot(p0b.x - p0a.x, p0b.y - p0a.y);
  const d1 = Math.hypot(p1b.x - p1a.x, p1b.y - p1a.y);
  if (d0 <= 0) return startView;
  const scale = Math.min(limits.maxScale, startView.scale * (d1 / d0));
  if (scale <= limits.minScale) return null;
  const m0x = (p0a.x + p0b.x) / 2, m0y = (p0a.y + p0b.y) / 2;
  const m1x = (p1a.x + p1b.x) / 2, m1y = (p1a.y + p1b.y) / 2;
  const px = startT.mmX(m0x), py = startT.mmY(m0y); // 開始の中点の下にあった図の点
  return clampCenter({
    scale,
    cx: px - (m1x - startT.pxWidth / 2) / scale,
    cy: py - (m1y - startT.pxHeight / 2) / scale,
  }, contentBounds);
}

/**
 * 矩形 {x,y,w,h}(mm) が枠いっぱいに入る view。縮尺は範囲で頭打ち、中心は矩形の中心。
 * 矩形が無効なら null。縮尺が minScale 以下（全体で足りる）でも null。
 */
export function fitViewToRect(rect, frame, limits) {
  assertFrame(frame);
  assertLimits(limits);
  if (!rect || !finite(rect.x, rect.y, rect.w, rect.h) || rect.w <= 0 || rect.h <= 0) return null;
  const fit = Math.min(
    (frame.width - 2 * FIGURE_MARGIN_PX) / rect.w,
    (frame.height - 2 * FIGURE_MARGIN_PX) / rect.h,
  );
  const scale = Math.min(limits.maxScale, fit);
  if (scale <= limits.minScale) return null;
  return { scale, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 };
}
