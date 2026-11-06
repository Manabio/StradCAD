// 画面レイアウトの単一の真実（ガター・上部ツールバー・描画エリアの余白）。
// 4辺の内端オフセット INSET は基準値から派生させる。余白の調整はここだけを変更する。
//
//   [0 .. TOP_BAR]            上部ツールバー（Undo/Redo・階チップ・モードバー・☰）
//   [TOP_BAR .. INSET.top]   上ルーラ（通り芯・寸法・丸ラベル）
//   [INSET.top .. ]          描画エリア

export const RULER   = 48; // ルーラ帯の厚み（=通り芯ラベル円の半径基準）。左右ガター幅でもある。
export const TOP_BAR = 40; // 上部ツールバーの帯高。
export const BOTTOM  = 56; // 下ガター高さ（寸法数字を線の上に収めるため拡大）。
// 横長のときの左帯（階ドラム。ui/FloorDrum.jsx の縦ドラム＝left 8 ＋ 階名「地下1階」4 文字 14px ≒ 56 ＋ 左右 padding 24）の幅。
// 階名 4 文字までを想定した固定幅（ドラムの実幅は階名の長さで変わる。5 文字「地下10階」等は約 10px 帯にかかる＝受容）。
// 展開図の描画域を左帯に重ねないために使う（elevationViewRect）。縦長のときドラムは下部に移るので使わない。
export const LEFT_BAR = 88;

/**
 * 展開図の描画域（画面 px。x/y は画面左上からの原点、width/height は描画域の大きさ）。
 * 横長（width > height）は上部ツールバー（モードバー・Undo/Redo・☰）と左帯（階ドラム）を除外する。
 * 縦長はボタン類が下部に集まるので全画面のまま。
 * ElevationModeState.viewSize（倍率・クランプ・タップ命中）・SceneLayers の Group（原点＋クリップ）の
 * 両方がこれを使う——どちらか片方だけ別の矩形にすると、見える位置と押した位置の帯がずれる。
 */
export function elevationViewRect({ width, height }) {
  if (width > height) {
    return { x: LEFT_BAR, y: TOP_BAR, width: Math.max(0, width - LEFT_BAR), height: Math.max(0, height - TOP_BAR) };
  }
  return { x: 0, y: 0, width, height };
}

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

/**
 * 平面系の描画エリア（画面 px。INSET の内側）。読込み後の初期表示（initialView.js）が
 * 「全体が入る倍率」を決めるときの収め先。ガター帯（寸法線・丸ラベル）は含まない。
 */
export function drawingAreaRect({ width, height }) {
  return {
    x: INSET.left, y: INSET.top,
    width:  Math.max(0, width  - INSET.left - INSET.right),
    height: Math.max(0, height - INSET.top  - INSET.bottom),
  };
}
