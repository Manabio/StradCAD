// 画面レイアウトの単一の真実（ガター・上部ツールバー・描画エリアの余白）。
// 4辺の内端オフセット INSET は基準値から派生させる。余白の調整はここだけを変更する。
//
//   [0 .. TOP_BAR]            上部ツールバー（Undo/Redo・階チップ・モードバー・☰）
//   [TOP_BAR .. INSET.top]   上ルーラ（通り芯・寸法・丸ラベル）
//   [INSET.top .. ]          描画エリア

export const RULER   = 48; // ルーラ帯の厚み（=通り芯ラベル円の半径基準）。左右ガター幅でもある。
export const TOP_BAR = 40; // 上部ツールバーの帯高。
export const BOTTOM  = 56; // 下ガター高さ（寸法数字を線の上に収めるため拡大）。

// 描画エリアの4辺内端オフセット（画面端からの距離）。
export const INSET = {
  top:    TOP_BAR + RULER, // ツールバー＋上ルーラ
  right:  RULER,
  bottom: BOTTOM,
  left:   RULER,
};

// スクリーン座標がガター帯（描画エリアの外周）にあるか。
export function inGutter(x, y, width, height) {
  return x < INSET.left || y < INSET.top || x > width - INSET.right || y > height - INSET.bottom;
}

// 丸ラベルを外側方向にずらす量 (px, 画面定数)。gutterPrimitives.jsx・renderer/gutterLabelHits.js
// （柱芯ラベルのヒット判定・純関数レイヤ）の両方が参照する単一の真実源。
export const OUTWARD = 6;

// 丸ラベルの半径。gutterPrimitives.jsx（描画）・renderer/gutterLabelHits.js（ヒット判定）双方が
// 参照する単一の真実源（純粋な数値計算のみ・react-konva等のJSX依存を持たない）。
export function labelCircleRadius(viewport) {
  return Math.round(RULER * 0.25) / viewport.scaleX;
}
