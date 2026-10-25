// ================================================================
// SVG 図（建具モード姿図・構造断面図）のプリミティブ生成ヘルパー
//
// 消費側は AutoScaledFigure.jsx の renderPrimitive。展開図（Konva）の語彙は elevation/elevationPrimitives.js で、
// こちらとは別物（dim の引数順・line の role 変換・style キーが違う。混ぜない）。
//
// 規約: 「位置引数＋extra」。extra は渡されたキー順のまま展開するだけで、検証・既定値補完・undefined 落としはしない
// （undefined の値を持つキーもそのまま残る＝出力のバイト同一を保つ根拠）。
// 純モジュール（store/snap/.jsx を引かない）。
// ================================================================

import { SvgFigurePrimitiveType } from '../../core/constants.js';

export function rect(x, y, w, h, extra) {
  return { type: SvgFigurePrimitiveType.RECT, x, y, w, h, ...extra };
}

export function text(x, y, str, extra) {
  return { type: SvgFigurePrimitiveType.TEXT, x, y, text: str, ...extra };
}

export function line(x1, y1, x2, y2, extra) {
  return { type: SvgFigurePrimitiveType.LINE, x1, y1, x2, y2, ...extra };
}

export function polyline(points, extra) {
  return { type: SvgFigurePrimitiveType.POLYLINE, points, ...extra };
}

// 半径が mm の円（cx, cy, r）。
export function circleMm(cx, cy, r, extra) {
  return { type: SvgFigurePrimitiveType.CIRCLE, cx, cy, r, ...extra };
}

// 半径が px 固定の円（cx, cy, rPx）。縮尺に関わらず同じ大きさに見せる目印用。
export function circlePx(cx, cy, rPx, extra) {
  return { type: SvgFigurePrimitiveType.CIRCLE, cx, cy, rPx, ...extra };
}

export function hSection(x, y, w, h, web, flange, extra) {
  return { type: SvgFigurePrimitiveType.H_SECTION, x, y, w, h, web, flange, ...extra };
}

// dir='h' なら from/to=x・at=y、'v' なら from/to=y・at=x。label は undefined でもキーが残る。
export function dim(dir, from, to, at, label, opts = {}) {
  return { type: SvgFigurePrimitiveType.DIM, dir, from, to, at, label, ...opts };
}

// label も extra で渡す（無ラベルの基準線は label キー自体を持たない）。
export function levelLine(y, extra) {
  return { type: SvgFigurePrimitiveType.LEVEL_LINE, y, ...extra };
}

export function axisV(x, extra) {
  return { type: SvgFigurePrimitiveType.AXIS_V, x, ...extra };
}

export function arrow(x1, y1, x2, y2, extra) {
  return { type: SvgFigurePrimitiveType.ARROW, x1, y1, x2, y2, ...extra };
}
