// ================================================================
// PDF の単位と座標系（純関数）。
//   ページ座標（pt・左上原点・y 下向き）: ユーザー空間（y 上向き）を view=[x0,y0,x1,y1] で反転した座標。クリップ矩形はこの座標。
//   図の座標（mm・s 右／t 下向き正）: ページ座標 × PDF_PT_TO_MM × 縮尺分母 N（縮尺 1/N）。y の反転はページ座標へ写すときに済んでいる。
// ================================================================

import { PDF_PT_TO_MM } from '../../core/constants.js';
import { bboxOf } from './pdfOps.js';

/** 縮尺 1/N の分母の文字列 → N。0 以下・非数・空は null（縮尺は必須で既定なし）。 */
export function parseScaleDenominator(text) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** pt の長さ → 図の mm（縮尺 1/N の図面上の 1 pt は実物の N 倍）。 */
export const ptToMm = (pt, scaleDenominator) => pt * PDF_PT_TO_MM * scaleDenominator;
/** 図の mm → pt（ptToMm の逆。曲線の弦公差を pt に直すのに使う）。 */
export const mmToPt = (mm, scaleDenominator) => mm / (PDF_PT_TO_MM * scaleDenominator);

/** ユーザー空間の点 → ページ座標（左上原点・y 下向き）。 */
export function toPageSpace(p, view) {
  return { x: p.x - view[0] + 0, y: view[3] - p.y + 0 };
}

/** ページ座標の経路列へ写す（経路 {segments, bbox} の座標を toPageSpace し、bbox を作り直す）。 */
export function pathsToPageSpace(paths, view) {
  return paths.map(path => {
    const segments = path.segments.map(({ a, b }) => ({ a: toPageSpace(a, view), b: toPageSpace(b, view) }));
    return { segments, bbox: bboxOf(segments) };
  });
}

/** ページ座標の線分 → 図の座標（mm）の線分（dxfToComponents の入力）。 */
export function segmentsToFigureMm(segments, scaleDenominator) {
  const f = p => ({ s: ptToMm(p.x, scaleDenominator), t: ptToMm(p.y, scaleDenominator) });
  return segments.map(({ a, b }) => ({ a: f(a), b: f(b) }));
}
