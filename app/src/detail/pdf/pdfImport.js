// ================================================================
// PDF 読込みの入口（純関数。pdfjs は引かない）。
//   checkPdfBytes(bytes)         : サイズ上限・署名（%PDF-）の確認。pdfjs へ渡す前の関門。
//   selectablePageCount(count)   : 選べるページ数（PDF_MAX_PAGES まで）と PAGE_LIMIT。
//   buildPdfScene(page, params)  : ページの演算子列 → 経路 → ページ座標 → クリップ選別 → mm → 連結成分（dxfToComponents を共用）。
// 例外は握って { ok:false, error }（外部ファイルは信用しない）。縮尺が無ければ成分は作らず SCALE_MISSING。
// ================================================================

import {
  PdfReject, PdfWarning, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_SIGNATURE, PDF_SIGNATURE_SCAN_BYTES, DXF_CHORD_TOL_MM,
} from '../../core/constants.js';
import { dxfToComponents } from '../dxf/dxfToStrokes.js';
import { pdfExtractPaths } from './pdfOps.js';
import { selectPathsInClip, isValidClip } from './pdfClip.js';
import { pathsToPageSpace, segmentsToFigureMm, mmToPt } from './pdfUnits.js';

const LATIN1 = 'latin1';

/** 先頭の署名が %PDF- か（先頭 PDF_SIGNATURE_SCAN_BYTES バイト以内。ファイル名・拡張子は見ない）。 */
export function isPdfBytes(bytes) {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return false;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder(LATIN1).decode(u8.subarray(0, PDF_SIGNATURE_SCAN_BYTES));
  return head.includes(PDF_SIGNATURE);
}

/** @returns {{ok:true} | {ok:false, error:{code:string, limit?:number}}} */
export function checkPdfBytes(bytes) {
  const size = bytes?.byteLength;
  if (!Number.isFinite(size)) return { ok: false, error: { code: PdfReject.NOT_PDF } };
  if (size > PDF_MAX_BYTES) return { ok: false, error: { code: PdfReject.SIZE_LIMIT, limit: PDF_MAX_BYTES } };
  if (!isPdfBytes(bytes)) return { ok: false, error: { code: PdfReject.NOT_PDF } };
  return { ok: true };
}

/** @returns {{count:number, warnings:object[]}} */
export function selectablePageCount(pageCount) {
  const count = Math.min(Math.max(0, Math.floor(pageCount) || 0), PDF_MAX_PAGES);
  return { count, warnings: pageCount > PDF_MAX_PAGES ? [{ code: PdfWarning.PAGE_LIMIT, limit: PDF_MAX_PAGES, total: pageCount }] : [] };
}

/**
 * @param {{opList:{fnArray:number[], argsArray:any[]}, ops:Record<string,number>, view:number[]}} page
 * @param {{clip:{x:number,y:number,w:number,h:number}, scaleDenominator:number|null}} params clip はページ座標（pt・左上原点）
 * @returns {{ok:true, components:object[], warnings:object[], pathCount:number, selectedCount:number}
 *          | {ok:false, error:{code:string, message:string}}}
 */
export function buildPdfScene(page, { clip, scaleDenominator }) {
  try {
    if (!(scaleDenominator > 0)) {
      return { ok: true, components: [], warnings: [{ code: PdfWarning.SCALE_MISSING }], pathCount: 0, selectedCount: 0 };
    }
    const chordTolPt = mmToPt(DXF_CHORD_TOL_MM, scaleDenominator);
    const { paths, warnings } = pdfExtractPaths(page.opList, page.ops, { chordTolPt });
    const inPage = pathsToPageSpace(paths, page.view);
    const picked = isValidClip(clip) ? selectPathsInClip(inPage, clip) : [];
    const segments = segmentsToFigureMm(picked.flatMap(p => p.segments), scaleDenominator);
    const { components } = dxfToComponents(segments);
    const out = [...warnings];
    if (picked.length === 0) out.push({ code: PdfWarning.NO_PATHS });
    return { ok: true, components, warnings: out, pathCount: paths.length, selectedCount: picked.length };
  } catch (e) {
    return { ok: false, error: { code: PdfReject.UNEXPECTED, message: e instanceof Error ? e.message : String(e) } };
  }
}
