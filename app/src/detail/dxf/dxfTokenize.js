// ================================================================
// ASCII DXF の字句分解（純関数）。2 行で 1 対（group code の行・値の行）。
// 外部ファイルは信用しない: 不正な group code・途中で切れたファイルは例外にせず { error } を返す。
// 末尾は「0 / EOF」の対であること（無ければ切れたファイルとして拒否する）。
// ================================================================

import { DxfReject, DXF_ERROR_TEXT_MAX } from '../../core/constants.js';
const BOM = 0xFEFF;
const GROUP_CODE_RE = /^-?\d+$/;
const EOF_CODE = 0;
const EOF_VALUE = 'EOF';

/**
 * @param {string} text
 * @returns {{pairs: {code:number, value:string}[]} | {error: {code:string, line:number, text?:string}}}
 */
export function dxfTokenize(text) {
  const src = typeof text === 'string' && text.charCodeAt(0) === BOM ? text.slice(1) : String(text ?? '');
  const lines = src.split(/\r\n|\r|\n/);
  // 末尾の空行は捨てる（EOF の後ろの改行・空行）。最後の対は EOF なので、値が空の対を削ってしまうことはない。
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length % 2 === 1) return { error: { code: DxfReject.TRUNCATED, line: lines.length } };
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    const raw = lines[i].trim();
    if (!GROUP_CODE_RE.test(raw)) return { error: { code: DxfReject.BAD_GROUP_CODE, line: i + 1, text: raw.slice(0, DXF_ERROR_TEXT_MAX) } };
    pairs.push({ code: Number(raw), value: lines[i + 1].trim() });
  }
  const last = pairs[pairs.length - 1];
  if (!last || last.code !== EOF_CODE || last.value !== EOF_VALUE) return { error: { code: DxfReject.TRUNCATED, line: lines.length } };
  return { pairs };
}
