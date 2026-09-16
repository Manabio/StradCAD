// 寸法線・引出線（基準線・足）の共通線太さキー。
// DimensionLayer.jsx / CenterDimensionLayer.jsx の両方がここを参照することで、
// 太さ変更時に参照漏れが起きない（viewport.lineWeightsPx の thin/medium/thick/ultraThick から選ぶ）。
export const DIMENSION_LINE_WEIGHT = 'thin';

// 寸法値の文字サイズ・寸法線からの離れ（画面px）。renderer/gutterLabelHits.js（通り芯寸法）から移設
// （GutterLayer.jsx・structural/StructuralLayer.jsx の非正角材の梁標記が同じ値を共有する単一の入口）。
export const NUM_FONT_PX = 11;
export const TEXT_GAP_PX = 2;
