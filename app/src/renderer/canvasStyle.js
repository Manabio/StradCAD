// 描画エリア（Konva Stage）の背景色（製図用紙色）。index.css の
// `html, body, #root { background: #f5f5f0; }` を映す——Konva Stage自体は透明で背景は
// #root越しに見えているため、これが実質的な「キャンバス背景色」。
// QA I2: 元は elevation/elevationStyle.js に置いていたが、展開モードに限らず汎用的に使いうる
// 値のため、renderer/配下の共通スタイルモジュールへ移した（elevationStyle.js からは既存参照
// （elevationFigure.js の通り芯丸の塗り等）を壊さないよう re-export している）。
//
// QA A3: この値は index.css の `#root` の background と重複定義（1箇所に一本化できず2箇所
// 手動同期になる既知のトレードオフ。index.css側はCSSでJSの定数を参照できないため）。
// 値を変更するときは index.css の該当行も必ず一緒に更新すること。
export const CANVAS_BG_COLOR = '#f5f5f0';

// ---- 由来色（origin color） ----
// 色は「由来」を表す。CL（通り芯・中心・補助・梁芯）・梁芯・柱の×の3表で同じ色＝同じ由来という
// 前提のもと、色相・明度を1箇所に集約する（renderer/originColorKey.js が種別→由来キーへ変換し、
// 各レイヤーは本モジュールの originColor(key) だけを stroke/fill に渡す）。

// 濃さ（明度）パラメータ。1箇所で持ち、将来の差し替え口。ダークモードは無い。
export const ORIGIN_LIGHTNESS = 35;
// 「やや明るい」の持ち上げ量（裁定C: 濃い水色（中心線）と見分けるため明るさ差を大きくとる）。
export const ORIGIN_LIGHT_LIFT = 25;

// 由来キー→色相表。h=色相(0-360)・s=彩度(%)・lift=明度の追加持ち上げ（省略時0）。
export const ORIGIN_HUES = Object.freeze({
  grid:        { h: 0,   s: 75 },                        // 濃い赤   ＝通り芯由来
  center:      { h: 190, s: 90 },                         // 濃い水色 ＝中心線由来
  aux:         { h: 0,   s: 0 },                          // 濃いグレー＝補助・手動
  above:       { h: 28,  s: 95 },                         // 濃いオレンジ＝上階荷重の自動判断
  supportSpan: { h: 120, s: 70 },                         // 濃い緑   ＝支持長の自動判断
  generated:   { h: 217, s: 91, lift: ORIGIN_LIGHT_LIFT }, // やや明るい青＝壁・床梁割付けからの自動生成
});

// 該当なし（'none'・未知キー・null）は黒。
export const ORIGIN_NONE_COLOR = '#000000';

/**
 * 由来キーから stroke/fill 用の色文字列を返す。
 * Konva の stroke は CSS 色文字列を canvas strokeStyle にそのまま渡すため hsl() を受理する
 * （このリポジトリで hsl() 表記は本関数が初出。hex 前提の処理（文字列としての `#` 判定等）へ
 * 渡すときは変換が必要になる点に注意）。
 * @param {string} key ORIGIN_HUES のキー、または 'none'
 * @param {number} [lightness]
 * @returns {string}
 */
export function originColor(key, lightness = ORIGIN_LIGHTNESS) {
  const entry = ORIGIN_HUES[key];
  if (!entry) return ORIGIN_NONE_COLOR;
  const l = lightness + (entry.lift ?? 0);
  return `hsl(${entry.h}, ${entry.s}%, ${l}%)`;
}
