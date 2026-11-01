// ================================================================
// PDF 由来の図の出所（provenance。純関数）。
//   { source:'pdf', fileName, sha256, page, clip:{x,y,w,h}（ページ座標 pt）, scaleDenominator, maker, series, licenseNote }
// 原本のバイト列は保存しない（DXF と同じ。sha256 と「どのページのどの範囲を何分の 1 で」だけ残す）。
// 文字列欄の整形・LICENSE_UNKNOWN の警告・sha256 の注入は DXF と共通（dxfProvenance.js）。
// ================================================================

import { DetailProvenanceSource, DxfWarning } from '../../core/constants.js';
import { baseNameOf } from '../dxf/dxfProvenance.js';

const clean = v => String(v ?? '').trim();
const num = v => (Number.isFinite(v) ? v : 0);

/**
 * @param {{fileName: string, sha256: string, page: number, clip: {x:number,y:number,w:number,h:number}, scaleDenominator: number,
 *          maker?: string, series?: string, licenseNote?: string}} input
 * @returns {{provenance: object, warnings: {code: string}[]}}
 */
export function buildPdfProvenance({ fileName, sha256, page, clip, scaleDenominator, maker, series, licenseNote }) {
  const provenance = {
    source: DetailProvenanceSource.PDF,
    fileName: baseNameOf(fileName), sha256: clean(sha256),
    page: num(page), clip: { x: num(clip?.x), y: num(clip?.y), w: num(clip?.w), h: num(clip?.h) },
    scaleDenominator: num(scaleDenominator),
    maker: clean(maker), series: clean(series), licenseNote: clean(licenseNote),
  };
  const warnings = provenance.licenseNote === '' ? [{ code: DxfWarning.LICENSE_UNKNOWN }] : [];
  return { provenance, warnings };
}
