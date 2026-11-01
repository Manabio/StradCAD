// ================================================================
// pdfjs-dist の薄いローダ（ブラウザ専用。node:test では読み込まない）。
// このファイルだけが pdfjs を引く。DetailHelperPanel が import() で読み込む＝独立チャンク（worker は ?url で同梱）。
// detail/pdf/ の純モジュールには「演算子列（fnArray／argsArray）と OPS の名前→番号表」だけを渡す。
// ================================================================

// legacy 版: modern 版は Map.prototype.getOrInsertComputed・Uint8Array.fromBase64 を polyfill なしで呼び、古い iOS Safari で TypeError になる。
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PdfReject } from '../core/constants.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const fail = (code, e) => ({ ok: false, error: { code, message: e instanceof Error ? e.message : String(e ?? '') } });

/**
 * バイト列から PDF 文書を開く（データは worker へ渡るので複製を渡す）。
 * @returns {Promise<{ok:true, doc:object, pageCount:number} | {ok:false, error:{code:string, message:string}}>}
 */
export async function openPdf(bytes) {
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const doc = await task.promise;
    return { ok: true, doc, pageCount: doc.numPages };
  } catch (e) {
    if (e instanceof pdfjs.InvalidPDFException) return fail(PdfReject.NOT_PDF, e);
    if (/worker/i.test(String(e?.message))) return fail(PdfReject.WORKER_UNAVAILABLE, e);
    return fail(PdfReject.LOAD_FAILED, e);
  }
}

/** 文書を破棄する（worker 側の資源を解放）。PDFDocumentProxy に destroy は無く、loadingTask が持つ。doc が無ければ何もしない。 */
export async function closePdf(doc) {
  await doc?.loadingTask?.destroy();
}

/** ページの演算子列と寸法（回転は無視＝ユーザー空間のまま）。 */
export async function readPdfPage(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const { fnArray, argsArray } = await page.getOperatorList();
  return { opList: { fnArray, argsArray }, ops: pdfjs.OPS, view: [...page.view] };
}

// 同じ canvas への render は並行できない（pdfjs が拒否する）。canvas ごとに直列に並べる。
const renderChains = new WeakMap();

/** ページ画像を canvas へ描く（表示専用。回転 0 固定＝演算子列の座標系と揃える）。返り値は canvas の px 寸法とページの view。 */
export function renderPdfPage(doc, pageNo, canvas, scale) {
  const run = async () => {
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale, rotation: 0 });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { width: canvas.width, height: canvas.height, view: [...page.view] };
  };
  const prev = renderChains.get(canvas) ?? Promise.resolve();
  const next = prev.then(run, run);
  renderChains.set(canvas, next.catch(() => undefined));
  return next;
}
