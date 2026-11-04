// ================================================================
// ヘルパー画面の PDF 読込み（S7b）の純ロジック。DetailHelperPanel.jsx は配線だけ（pdfjs は ui/pdfLoader.js が閉じ込める）。
//   pdf（パネルが持つ状態）= { source:'pdf', loadId, fileName, sha256, noDigest, pageCount, selectableCount, pageWarnings,
//     page, view, clip, scaleText, scene, selected:number[], maker, series, licenseNote }
//   scene = { components, warnings, pathCount, selectedCount, page, clip, scaleDenominator } は「抽出」の結果（抽出したときの
//   ページ・範囲・縮尺を持ち、出所に載る）。ページ・範囲・縮尺を変えると scene・選択は捨てる（古い結果を写さない）。
//   原本のバイト列・演算子列は状態に持たない（抽出のたびにページを読み直す）。成分の選択・出所欄・下書きへの変換は DXF と共通
//   （detailHelperForm.js の toggleDxfComponent・setDxfProvenanceField・dxfComponentRows・draftFromDxf）。
// ================================================================

import { PdfReject, PdfWarning, PdfLimitKind, DxfWarning, PDF_MAX_BYTES, DetailProvenanceSource } from '../core/constants.js';
import {
  WARN_PDF_PAGE_LIMIT, WARN_PDF_NO_PATHS, WARN_PDF_TEXT_IGNORED, WARN_PDF_IMAGE_IGNORED, WARN_PDF_PATH_LIMIT, WARN_PDF_SCALE_MISSING,
  WARN_PDF_SEGMENT_LIMIT, WARN_PDF_UNKNOWN_DRAW_OP, WARN_PDF_NON_FINITE_SEGMENT, ERR_PDF_NO_PAGES,
  WARN_DXF_NO_DIGEST, ERR_PDF_NOT_PDF, ERR_PDF_LOAD_FAILED, ERR_PDF_WORKER_UNAVAILABLE, ERR_PDF_SIZE_LIMIT, ERR_PDF_PAGE_NOT_FOUND,
  ERR_PDF_PAGE_FAILED,
} from '../error.js';
import { checkPdfBytes, selectablePageCount, buildPdfScene } from '../detail/pdf/pdfImport.js';
import { parseScaleDenominator } from '../detail/pdf/pdfUnits.js';
import { isValidClip } from '../detail/pdf/pdfClip.js';
import { buildPdfProvenance } from '../detail/pdf/pdfProvenance.js';
import { baseNameOf } from '../detail/dxf/dxfProvenance.js';
import { describeDxfWarning, DETAIL_HELPER_MESSAGES, parseNumberText, safeDigest } from './detailHelperForm.js';

const BYTES_PER_MB = 1024 * 1024;
const CLIP_FRACTION_DIGITS = 1;   // 範囲（pt。DXF の矩形では mm）の小数桁。ドラッグの値の丸め
const PERCENT = 100;
const CLIP_FIELDS = Object.freeze(['x', 'y', 'w', 'h']);
const EMPTY_CLIP = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

let loadSeq = 0;

const WARNING_TEXT = Object.freeze({
  [PdfWarning.PAGE_LIMIT]:    w => WARN_PDF_PAGE_LIMIT(w.limit, w.total),
  [PdfWarning.NO_PATHS]:      () => WARN_PDF_NO_PATHS,
  [PdfWarning.TEXT_IGNORED]:  w => WARN_PDF_TEXT_IGNORED(w.count),
  [PdfWarning.IMAGE_IGNORED]: w => WARN_PDF_IMAGE_IGNORED(w.count),
  [PdfWarning.PATH_LIMIT]:    w => (w.kind === PdfLimitKind.SEGMENTS ? WARN_PDF_SEGMENT_LIMIT(w.limit) : WARN_PDF_PATH_LIMIT(w.limit)),
  [PdfWarning.UNKNOWN_DRAW_OP]:    w => WARN_PDF_UNKNOWN_DRAW_OP(w.count),
  [PdfWarning.NON_FINITE_SEGMENT]: w => WARN_PDF_NON_FINITE_SEGMENT(w.count),
  [PdfWarning.SCALE_MISSING]: () => WARN_PDF_SCALE_MISSING,
  [DxfWarning.NO_DIGEST]:     () => WARN_DXF_NO_DIGEST,
});
const REJECT_TEXT = Object.freeze({
  [PdfReject.NOT_PDF]:            () => ERR_PDF_NOT_PDF,
  [PdfReject.LOAD_FAILED]:        e => ERR_PDF_LOAD_FAILED(e.message ?? ''),
  [PdfReject.WORKER_UNAVAILABLE]: () => ERR_PDF_WORKER_UNAVAILABLE,
  [PdfReject.UNEXPECTED]:         e => ERR_PDF_PAGE_FAILED(e.message ?? ''),
  [PdfReject.SIZE_LIMIT]:         () => ERR_PDF_SIZE_LIMIT(Math.round(PDF_MAX_BYTES / BYTES_PER_MB)),
});

/** 警告 1 件の表示文（PDF の警告を先に引き、無ければ DXF 共通の警告＝輪郭が開いている等）。 */
export function describePdfWarning(w) {
  const f = WARNING_TEXT[w?.code];
  return f ? f(w) : describeDxfWarning(w);
}
/** 拒否（読み込めない）理由の表示文。未知のコードは読込み失敗として message を添える。 */
export function describePdfReject(error) {
  const f = REJECT_TEXT[error?.code];
  return f ? f(error) : ERR_PDF_LOAD_FAILED(String(error?.message ?? error?.code));
}

const scaleOf = pdf => parseScaleDenominator(pdf?.scaleText);
const reset = pdf => ({ ...pdf, scene: null, selected: [] });

/**
 * PDF のバイト列を開く。open(bytes)・close(doc) は ui/pdfLoader.js の openPdf・closePdf（pdfjs。注入）、digest は sha256（失敗は NO_DIGEST で続ける）。
 * 失敗は { ok:false, message }（例外にしない）。成功は pdf 状態と pdfjs の文書（パネルが ref で持つ）。
 */
export async function loadPdf({ bytes, fileName, digest, open, close }) {
  const checked = checkPdfBytes(bytes);
  if (!checked.ok) return { ok: false, message: describePdfReject(checked.error) };
  let opened;
  try {
    opened = await open(bytes);
  } catch (e) {
    return { ok: false, message: describePdfReject({ code: PdfReject.LOAD_FAILED, message: e instanceof Error ? e.message : String(e) }) };
  }
  if (!opened.ok) return { ok: false, message: describePdfReject(opened.error) };
  const { count, warnings } = selectablePageCount(opened.pageCount);
  if (count === 0) {
    await close(opened.doc); // 開いた文書（worker 側の資源）を捨てる
    return { ok: false, message: ERR_PDF_NO_PAGES };
  }
  const { sha256, noDigest } = await safeDigest(bytes, digest);
  loadSeq += 1;
  return {
    ok: true,
    doc: opened.doc,
    pdf: {
      source: DetailProvenanceSource.PDF, loadId: loadSeq, fileName: baseNameOf(fileName), sha256, noDigest,
      pageCount: opened.pageCount, selectableCount: count, pageWarnings: warnings,
      page: 1, view: null, clip: null, scaleText: '', scene: null, selected: [], maker: '', series: '', licenseNote: '',
    },
  };
}

/** ページ番号を指定する（整数・1〜選べるページ数）。変えると抽出結果は捨てる。範囲は残す。失敗は { error } で pdf は変えない。 */
export function setPdfPage(pdf, text) {
  const n = Number(String(text ?? '').trim());
  if (String(text ?? '').trim() === '' || !Number.isInteger(n) || n < 1) return { pdf, error: DETAIL_HELPER_MESSAGES.pdfPageInvalid };
  if (n > pdf.selectableCount) return { pdf, error: ERR_PDF_PAGE_NOT_FOUND(n) };
  return { pdf: { ...reset(pdf), page: n, view: null }, error: null };
}
/** 前後のページへ。端では動かない（エラーにしない）。 */
export function stepPdfPage(pdf, delta) {
  const n = pdf.page + delta;
  if (n < 1 || n > pdf.selectableCount) return { pdf, error: null };
  return setPdfPage(pdf, String(n));
}

/** ページの寸法（描画した結果の view=[x0,y0,x1,y1]）を記録する。抽出結果には触れない。 */
export function setPdfPageView(pdf, view) {
  return { ...pdf, view: Array.isArray(view) ? [...view] : null };
}

/** ページの寸法 { w, h }（pt）。view 未取得は null。 */
export function pageSizeOf(view) {
  return Array.isArray(view) ? { w: view[2] - view[0], h: view[3] - view[1] } : null;
}

/** 縮尺（1/N の N）の文字列を指定する。変えると抽出結果は捨てる（mm の値が変わるため）。 */
export function setPdfScale(pdf, text) {
  return reset({ ...pdf, scaleText: String(text ?? '').trim() });
}

/** 範囲（ページ座標 pt）をまとめて指定する（ドラッグ用）。抽出結果は捨てる。 */
export function setPdfClip(pdf, clip) {
  return reset({ ...pdf, clip: { ...clip } });
}
/** 範囲の 1 項目（x・y・w・h）を数値欄で指定する。数値でなければ { error } で pdf は変えない。 */
export function setPdfClipField(pdf, field, text) {
  if (!CLIP_FIELDS.includes(field)) return { pdf, error: null };
  const v = parseNumberText(text);
  if (!Number.isFinite(v)) return { pdf, error: DETAIL_HELPER_MESSAGES.pdfClipInvalid };
  return { pdf: setPdfClip(pdf, { ...(pdf.clip ?? EMPTY_CLIP), [field]: v }), error: null };
}

/** 画面座標の点 → ページ座標 pt（rect=ページ画像の getBoundingClientRect、size=ページの寸法 pt）。範囲外はページ内へ丸める。 */
export function pointToPage({ clientX, clientY }, rect, size) {
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  return {
    x: clamp((clientX - rect.left) / rect.width * size.w, size.w),
    y: clamp((clientY - rect.top) / rect.height * size.h, size.h),
  };
}
/** ドラッグの 2 点（ページ座標 pt）→ 範囲。向きに依らず左上と幅・高さ。小数は 1 桁へ丸める。 */
export function clipFromDrag(a, b) {
  const round = v => Number(v.toFixed(CLIP_FRACTION_DIGITS));
  return { x: round(Math.min(a.x, b.x)), y: round(Math.min(a.y, b.y)), w: round(Math.abs(a.x - b.x)), h: round(Math.abs(a.y - b.y)) };
}
/** 範囲の枠の CSS（ページ画像に対する % 指定）。範囲が無効・ページ寸法が無ければ null。 */
export function clipOverlayStyle(clip, size) {
  if (!size || !isValidClip(clip)) return null;
  const pct = (v, total) => `${(v / total) * PERCENT}%`;
  return { left: pct(clip.x, size.w), top: pct(clip.y, size.h), width: pct(clip.w, size.w), height: pct(clip.h, size.h) };
}

/** 数値欄の表示（範囲の 1 項目。未指定は空）。 */
export const pdfClipText = (clip, field) => (clip ? String(clip[field]) : '');

/** 「抽出」できるか（縮尺・範囲・ページ寸法がそろっている）。 */
export function pdfCanExtract(pdf) {
  return scaleOf(pdf) !== null && isValidClip(pdf?.clip) && !!pdf?.view;
}
/** 「下書きへ写す」できるか（縮尺が入力済みで、抽出結果があり、成分を選んでいる。縮尺は必須で既定なし）。 */
export function pdfCanCopy(pdf) {
  return !!pdf?.scene && pdf.selected.length > 0 && scaleOf(pdf) !== null;
}

/**
 * 選んだページの演算子列（pageData=ui/pdfLoader.js の readPdfPage の結果）から、範囲の成分を作る。
 * @returns {{pdf: object, error: string|null}}
 */
export function extractPdf(pdf, pageData) {
  const scaleDenominator = scaleOf(pdf);
  if (scaleDenominator === null) return { pdf: reset(pdf), error: WARN_PDF_SCALE_MISSING };
  if (!isValidClip(pdf.clip)) return { pdf: reset(pdf), error: DETAIL_HELPER_MESSAGES.pdfNeedClip };
  const r = buildPdfScene(pageData, { clip: pdf.clip, scaleDenominator });
  if (!r.ok) return { pdf: reset(pdf), error: ERR_PDF_PAGE_FAILED(r.error.message) };
  const scene = {
    components: r.components, warnings: r.warnings, pathCount: r.pathCount, selectedCount: r.selectedCount,
    page: pdf.page, clip: { ...pdf.clip }, scaleDenominator,
  };
  return { pdf: { ...pdf, scene, selected: [] }, error: null };
}

/** ファイル全体の警告（ページ数・縮尺未入力・抽出時の警告・digest）と出所欄から出る警告（ライセンス未記入）の表示文。 */
export function pdfWarningTexts(pdf) {
  const scale = scaleOf(pdf);
  const scaleWarn = scale === null ? [{ code: PdfWarning.SCALE_MISSING }] : [];
  // scene の SCALE_MISSING は extractPdf が作らない（縮尺なしでは抽出しない）ので、重複は出ない。
  const extracted = (pdf.scene?.warnings ?? []).filter(w => w.code !== PdfWarning.SCALE_MISSING);
  const digest = pdf.noDigest ? [{ code: DxfWarning.NO_DIGEST }] : [];
  const { warnings } = buildPdfProvenance({
    fileName: pdf.fileName, sha256: pdf.sha256, page: pdf.page, clip: pdf.clip, scaleDenominator: scale ?? 0, licenseNote: pdf.licenseNote,
  });
  return [...pdf.pageWarnings, ...scaleWarn, ...extracted, ...digest, ...warnings].map(describePdfWarning);
}
