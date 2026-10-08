// 寸法線・引出線（基準線・足）の共通線太さキー。
// DimensionLayer.jsx / CenterDimensionLayer.jsx の両方がここを参照することで、
// 太さ変更時に参照漏れが起きない（viewport.lineWeightsPx の thin/medium/thick/ultraThick から選ぶ）。
export const DIMENSION_LINE_WEIGHT = 'thin';

// 寸法値の文字サイズ・寸法線からの離れ（画面px）。renderer/gutterLabelHits.js（通り芯寸法）から移設
// （GutterLayer.jsx・structural/StructuralLayer.jsx の非正角材の梁標記が同じ値を共有する単一の入口）。
export const NUM_FONT_PX = 11;
export const TEXT_GAP_PX = 2;

// 通り芯だけ長鎖線（他の一点鎖線 [12,4,2,4]＝中心線・梁芯・母屋などと判別するため）。
// 比率は線幅 d 基準: 長線24d／すき間3d／短線（点）6d／すき間3d（周期36d）。
export const GRID_LINE_DASH_RATIO = Object.freeze([24, 3, 6, 3]);
export function gridLineDash(strokeWidthPx) {
  return GRID_LINE_DASH_RATIO.map(r => r * strokeWidthPx);
}

// 吹抜け・EV の×（平面 VoidLayer.jsx の自階・構造モード StructuralLayer.jsx）の一点破線。
// 通り芯と同じ線幅 d 基準: 長線144d／すき間3d／点6d／すき間3d（周期 156d）。
export const OPENING_CROSS_DASH_RATIO = Object.freeze([144, 3, 6, 3]);
export function openingCrossDash(strokeWidthPx) {
  return OPENING_CROSS_DASH_RATIO.map(r => r * strokeWidthPx);
}
