// ================================================================
// DXF のバイト列 → 文字列（純関数）。
//   - 先頭が "AutoCAD Binary DXF" ならバイナリ DXF として拒否する（読めない）。
//   - 文字コードは UTF-8 と Shift_JIS の両方で復号し、置換文字（U+FFFD）の少ない方を採る（同数なら UTF-8）。
//     レイヤ名などの日本語が Shift_JIS の DXF が実在するため。ランタイムが shift_jis を持たなければ UTF-8 だけ。
// ================================================================

import { DXF_BINARY_SIGNATURE, DxfReject } from '../../core/constants.js';

const REPLACEMENT_CHAR = '�';
export const DxfEncoding = Object.freeze({ UTF8: 'utf-8', SHIFT_JIS: 'shift_jis' });

const countReplacement = s => s.split(REPLACEMENT_CHAR).length - 1;

function hasBinarySignature(bytes) {
  if (bytes.length < DXF_BINARY_SIGNATURE.length) return false;
  for (let i = 0; i < DXF_BINARY_SIGNATURE.length; i++) {
    if (bytes[i] !== DXF_BINARY_SIGNATURE.charCodeAt(i)) return false;
  }
  return true;
}

function tryDecode(encoding, bytes) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null; // そのエンコーディングを持たないランタイム
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{text: string, encoding: string} | {error: {code: string}}}
 */
export function dxfDecode(bytes) {
  if (!(bytes instanceof Uint8Array)) return { error: { code: DxfReject.NOT_BYTES } };
  if (hasBinarySignature(bytes)) return { error: { code: DxfReject.BINARY } };
  const utf8 = tryDecode(DxfEncoding.UTF8, bytes) ?? '';
  const sjis = tryDecode(DxfEncoding.SHIFT_JIS, bytes);
  if (sjis !== null && countReplacement(sjis) < countReplacement(utf8)) return { text: sjis, encoding: DxfEncoding.SHIFT_JIS };
  return { text: utf8, encoding: DxfEncoding.UTF8 };
}
