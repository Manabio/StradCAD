// 数値入力欄の全角→半角の正規化（純モジュール。node:test から単体 import 可）。

/** 全角数字（０-９）を半角へ直す。 */
export function toHalfWidthDigits(text) {
  return String(text ?? '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/** 全角数字と、全角マイナス（－ U+FF0D）・数学のマイナス（− U+2212）を半角へ直す。 */
export function toHalfWidthSignedNumber(text) {
  return toHalfWidthDigits(text).replace(/[－−]/g, '-');
}
