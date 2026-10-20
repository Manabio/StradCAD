// 階設定表ダイアログ（FloorSettingsDialog.jsx）のキー操作の判断を切り出した純モジュール。
// .jsx は node:test から import できないため、フォーカスの循環と Enter 確定の可否はここを唯一の供給源にする。

import { evalNumpadExpr } from './numpadUtils.js';

/**
 * Tab / Shift+Tab でフォーカスをダイアログ内に閉じ込めるときの次の要素の添字。
 * count＝ダイアログ内のフォーカス可能な要素数、current＝いま Focus のある要素の添字（ダイアログ外・無しは -1）。
 * 端で循環する。外にいるときは先頭（Shift なら末尾）へ入る。count が 0 なら -1。
 */
export function trapFocusIndex(count, current, shift) {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * Enter でダイアログを確定してよいか。ボタン上の Enter はそのボタン自身の click に任せる
 * （キャンセルボタンで Enter を押して確定が走らない）。IME の変換確定の Enter（isComposing / keyCode 229）は確定しない。
 */
export function shouldConfirmOnEnter({ key, tagName, isComposing, keyCode }) {
  if (key !== 'Enter') return false;
  if (isComposing || keyCode === 229) return false;
  return tagName !== 'BUTTON';
}

/**
 * NumPad の ✓ で欄の文字列を確定する。式（3000*2 など。NumPad は × ÷ を * / に置換して持つ）が整数に評価できれば
 * その整数の文字列に置き換える。評価できない（3000+ 等）・非整数（3000/7）・すでに整数だけの文字列は**そのまま**返し、
 * 判定は欄の既存の検査（赤表示）に任せる（丸めない）。
 */
export function resolvePadText(text) {
  if (/^\s*-?\d+\s*$/.test(text)) return text;
  const v = evalNumpadExpr(text, { positiveOnly: false });
  return Number.isInteger(v) ? String(v) : text;
}
