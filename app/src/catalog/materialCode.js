// ================================================================
// 材料コード（R4: 12桁数字 = 大分類2桁 + 中分類2桁 + 材料id8桁）の
// パース・採番・体系判定。
//
// ゼロ依存の葉モジュール（他のsrcをimportしない）。
// ================================================================

const CODE_RE = /^\d{12}$/;

/** v が材料コード（12桁数字文字列）かどうか。 */
export function isMaterialCode(v) {
  return typeof v === 'string' && CODE_RE.test(v);
}

/** 材料コード → {major, minor, serial}（数値）。不正なコードは null。 */
export function parseMaterialCode(code) {
  if (!isMaterialCode(code)) return null;
  return {
    major: Number(code.slice(0, 2)),
    minor: Number(code.slice(2, 4)),
    serial: Number(code.slice(4, 12)),
  };
}

/** major・minor・serial（数値）→ 12桁の材料コード文字列。 */
export function formatMaterialCode(major, minor, serial) {
  const pad = (n, len) => String(n).padStart(len, '0');
  return `${pad(major, 2)}${pad(minor, 2)}${pad(serial, 8)}`;
}

/**
 * major・minor の帯の中で、usedCodes（builtin・ユーザーライブラリ・同梱の合成集合）の
 * どれとも重ならない最小の空き番号を、8桁ゼロ詰め文字列で返す。
 */
export function nextSerial(major, minor, usedCodes) {
  const prefix = `${String(major).padStart(2, '0')}${String(minor).padStart(2, '0')}`;
  const used = new Set();
  for (const code of usedCodes ?? []) {
    if (typeof code !== 'string' || code.length !== 12 || !code.startsWith(prefix)) continue;
    used.add(Number(code.slice(4, 12)));
  }
  let serial = 1;
  while (used.has(serial)) serial++;
  return String(serial).padStart(8, '0');
}

/** 先頭4桁が'1111'（旧体系＝大分類11・中分類11）かどうか。 */
export function isLegacyCode(code) {
  return typeof code === 'string' && code.length === 12 && code.slice(0, 4) === '1111';
}
