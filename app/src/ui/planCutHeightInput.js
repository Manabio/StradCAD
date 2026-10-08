// 平面の切断高ダイアログ（PlanCutHeightDialog.jsx）の入力検証。node:test から単体で引けるよう分離。

/**
 * 入力文字列を切断高(mm)へ。有限の正数でなければ null（確定不可）。
 * @param {string} text
 * @returns {number|null}
 */
export function parsePlanCutHeightInput(text) {
  const n = Number(String(text).trim());
  if (String(text).trim() === '' || !Number.isFinite(n) || n <= 0) return null;
  return n;
}
