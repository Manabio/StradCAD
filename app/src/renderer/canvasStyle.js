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
