// 寸法線・引出線（基準線・足）の共通線太さキー。
// DimensionLayer.jsx / CenterDimensionLayer.jsx の両方がここを参照することで、
// 太さ変更時に参照漏れが起きない（viewport.lineWeightsPx の thin/medium/thick/ultraThick から選ぶ）。
export const DIMENSION_LINE_WEIGHT = 'thin';
