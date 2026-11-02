// ================================================================
// 巾木高さ文字列の解釈。import を持たない葉（catalog/usedEntries.js など葉モジュールからも引ける）。
// 公開名は core/room.js が再エクスポートする（従来の import 元を変えない）。
// ================================================================

/**
 * 巾木文字列（自由入力。RoomFinish.baseboardHeight）から高さ(mm)を解釈する。
 * "h=60"/"H=60mm" 等の "h=<数値>" 表記のみを対象とする——巾木は自由入力文字列のままで構わず
 * （既存構造は変えない）、展開側は解釈できた場合だけ巾木線を足す（解釈不能なら非描画。ユーザー仕様）。
 * @param {string} str
 * @returns {number|null}
 */
export function parseBaseboardHeightMm(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/h\s*=\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}
