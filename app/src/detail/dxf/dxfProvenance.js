// ================================================================
// DXF 由来の図の出所（provenance。純関数）。
//   { source:'dxf', fileName, sha256, maker, series, licenseNote }
// 原本のバイト列は保存しない（sha256 で「どのファイルから」を残すだけ）。ライセンス注記が空なら LICENSE_UNKNOWN を
// 警告する（保存は止めない）。sha256 は digest(bytes) → Promise<hex> を注入する（ブラウザは crypto.subtle・
// テストは node:crypto の webcrypto。この純モジュールは crypto を直接引かない）。
// ================================================================

import { DetailProvenanceSource, DxfWarning } from '../../core/constants.js';

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const SHA256 = 'SHA-256';

/** subtle（crypto.subtle 互換）→ digest(bytes) → Promise<hex 文字列>。 */
export function sha256HexWith(subtle) {
  return async bytes => {
    const buf = await subtle.digest(SHA256, bytes);
    return [...new Uint8Array(buf)].map(b => b.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0')).join('');
  };
}

/** パス区切りより後ろのファイル名だけにする（ブラウザは通常ファイル名のみだが、パスが混ざっても漏らさない）。 */
export const baseNameOf = name => String(name ?? '').split(/[\\/]/).pop();

const clean = v => String(v ?? '').trim();

/**
 * @param {{fileName: string, sha256: string, maker?: string, series?: string, licenseNote?: string}} input
 * @returns {{provenance: object, warnings: {code: string}[]}}
 */
export function buildDxfProvenance({ fileName, sha256, maker, series, licenseNote }) {
  const provenance = {
    source: DetailProvenanceSource.DXF,
    fileName: baseNameOf(fileName), sha256: clean(sha256),
    maker: clean(maker), series: clean(series), licenseNote: clean(licenseNote),
  };
  const warnings = provenance.licenseNote === '' ? [{ code: DxfWarning.LICENSE_UNKNOWN }] : [];
  return { provenance, warnings };
}
