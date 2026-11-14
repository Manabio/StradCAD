// ヘルパー画面の PDF 読込み（S7b）の純ロジック（ui/detailHelperPdf.js）のテスト。pdfjs は使わず、open（ui/pdfLoader.js の openPdf）は
// 差し替え、ページの演算子列は合成する。読込み→ページ→範囲→縮尺→抽出→成分の選択→新規下書き→検証・出所。期待値は定数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPdf, setPdfPage, stepPdfPage, setPdfPageView, pageSizeOf, setPdfScale, setPdfClip, setPdfClipField, pdfClipText,
  pointToPage, clipFromDrag, clipOverlayStyle, pdfCanExtract, pdfCanCopy, extractPdf, pdfWarningTexts, describePdfWarning, describePdfReject,
} from './detailHelperPdf.js';
import {
  toggleDxfComponent, draftFromDxf, validation, saveBlockers, entryFromForm, provenanceNoticeOf, setProvenanceField, DETAIL_HELPER_MESSAGES,
  dxfComponentRows, describeDxfWarning,
} from './detailHelperForm.js';
import { formatDetailProvenance } from '../catalog/catalogMaintenance.js';
import {
  WARN_PDF_SCALE_MISSING, WARN_PDF_TEXT_IGNORED, WARN_PDF_PAGE_LIMIT, WARN_DXF_LICENSE_UNKNOWN, WARN_DXF_NO_DIGEST, WARN_PDF_NO_PATHS,
  ERR_PDF_NO_PAGES, ERR_PDF_NOT_PDF, ERR_PDF_LOAD_FAILED, ERR_PDF_WORKER_UNAVAILABLE, ERR_PDF_SIZE_LIMIT, ERR_PDF_PAGE_NOT_FOUND, ERR_PDF_PAGE_FAILED,
} from '../error.js';
import {
  PdfDrawOp, PdfReject, PdfWarning, DxfWarning, DetailProvenanceSource, DXF_PROVENANCE_FIELDS, PDF_MAX_BYTES, PDF_MAX_PAGES, PenDir,
} from '../core/constants.js';
import { dxfDigest as digest, fixedId as ids } from './detailHelperDxfTestFixtures.js';

const bytes = new TextEncoder().encode('%PDF-1.7\nsample');
const openOk = (pageCount = 3) => async () => ({ ok: true, doc: { tag: 'doc' }, pageCount });

const OPS = { constructPath: 91, stroke: 20, showText: 44 };
const { MOVE_TO: M, LINE_TO: L, CLOSE: Z } = PdfDrawOp;
const PAGE = {
  opList: {
    fnArray: [OPS.constructPath, OPS.constructPath, OPS.showText],
    argsArray: [[OPS.stroke, [[M, 0, 0, L, 100, 0, L, 100, 50, L, 0, 50, Z]], null], [OPS.stroke, [[M, 150, 80, L, 190, 80]], null], []],
  },
  ops: OPS,
  view: [0, 0, 200, 100],
};
const CLIP = { x: 0, y: 0, w: 120, h: 100 };

async function load(pageCount, fileName = 'SM3300.pdf') {
  const r = await loadPdf({ bytes, fileName, digest, open: openOk(pageCount) });
  assert.equal(r.ok, true, r.message);
  return r;
}
const ready = async () => {
  const { pdf } = await load();
  return setPdfScale(setPdfClip(setPdfPageView(pdf, PAGE.view), CLIP), '6');
};

test('loadPdf: ファイル名・sha256（注入した digest）・ページ数・先頭ページ・空の範囲と縮尺。pdfjs の文書は状態に入れず別に返す', async () => {
  const r = await load(70);
  assert.equal(r.doc.tag, 'doc');
  const { pdf } = r;
  assert.equal(pdf.source, DetailProvenanceSource.PDF);
  assert.equal(pdf.fileName, 'SM3300.pdf');
  assert.equal(pdf.sha256, await digest(bytes));
  assert.deepEqual([pdf.pageCount, pdf.selectableCount, pdf.page], [70, 70, 1]);
  assert.deepEqual([pdf.clip, pdf.scaleText, pdf.scene, pdf.selected, pdf.view], [null, '', null, [], null]);
  assert.ok(!('doc' in pdf) && !('opList' in pdf) && !('bytes' in pdf), '原本・文書は状態に持たない');
});

test('loadPdf: ページが多いと選べるのは先頭 200 まで（PAGE_LIMIT の警告）', async () => {
  const { pdf } = await load(PDF_MAX_PAGES + 5);
  assert.equal(pdf.selectableCount, PDF_MAX_PAGES);
  assert.equal(pdfWarningTexts(pdf)[0], WARN_PDF_PAGE_LIMIT(PDF_MAX_PAGES, PDF_MAX_PAGES + 5));
});

test('【失敗系】loadPdf: PDF でない・大きすぎる・開けない・worker を起動できない・0 ページは ok:false と理由の文言（例外にしない）', async () => {
  const notPdf = await loadPdf({ bytes: new TextEncoder().encode('0\nSECTION'), fileName: 'a.dxf', digest, open: openOk() });
  assert.deepEqual(notPdf, { ok: false, message: ERR_PDF_NOT_PDF });
  const big = await loadPdf({ bytes: { byteLength: PDF_MAX_BYTES + 1 }, fileName: 'big.pdf', digest, open: openOk() });
  assert.deepEqual(big, { ok: false, message: ERR_PDF_SIZE_LIMIT(50) });
  const thrown = await loadPdf({ bytes, fileName: 'b.pdf', digest, open: async () => { throw new Error('壊れた xref'); } });
  assert.deepEqual(thrown, { ok: false, message: ERR_PDF_LOAD_FAILED('壊れた xref') });
  const rejected = await loadPdf({ bytes, fileName: 'c.pdf', digest, open: async () => ({ ok: false, error: { code: PdfReject.LOAD_FAILED, message: '暗号化' } }) });
  assert.equal(rejected.message, ERR_PDF_LOAD_FAILED('暗号化'));
  const worker = await loadPdf({ bytes, fileName: 'd.pdf', digest, open: async () => ({ ok: false, error: { code: PdfReject.WORKER_UNAVAILABLE } }) });
  assert.equal(worker.message, ERR_PDF_WORKER_UNAVAILABLE);
  let destroyed = 0;
  // 実物の形: PDFDocumentProxy に destroy は無く、破棄は loadingTask.destroy()（ui/pdfLoader.js の closePdf と同じ）。
  const doc = { loadingTask: { destroy: async () => { destroyed += 1; } } };
  const zero = await loadPdf({
    bytes, fileName: 'e.pdf', digest, open: async () => ({ ok: true, doc, pageCount: 0 }), close: async d => { await d?.loadingTask?.destroy(); },
  });
  assert.deepEqual(zero, { ok: false, message: ERR_PDF_NO_PAGES });
  assert.equal(destroyed, 1, '0 ページで開いた文書の loadingTask を 1 回だけ destroy する');
  assert.equal(describePdfReject({ code: 'unknown', message: 'x' }), ERR_PDF_LOAD_FAILED('x'), '未知のコードは読込み失敗として message を添える');
});

test('loadPdf: digest が失敗・未定義でも読込みは続く（sha256 空・NO_DIGEST の警告）。出所の sha256 も空のまま下書きになる', async () => {
  for (const d of [async () => { throw new Error('subtle なし'); }, async () => undefined, undefined]) {
    const r = await loadPdf({ bytes, fileName: 'n.pdf', digest: d, open: openOk() });
    assert.equal(r.ok, true);
    assert.equal(r.pdf.sha256, '');
    assert.ok(pdfWarningTexts(r.pdf).includes(WARN_DXF_NO_DIGEST));
  }
});

test('ページ指定: 整数 1〜選べるページ数。前後ボタンは端で動かない。ページを変えると抽出結果・選択を捨て、範囲・縮尺は残す', async () => {
  const base = await ready();
  const extracted = { ...base, scene: { components: [], warnings: [], page: 1, clip: CLIP, scaleDenominator: 6 }, selected: [0] };
  const r = setPdfPage(extracted, '3');
  assert.equal(r.error, null);
  assert.deepEqual([r.pdf.page, r.pdf.scene, r.pdf.selected, r.pdf.view], [3, null, [], null]);
  assert.deepEqual([r.pdf.clip, r.pdf.scaleText], [CLIP, '6']);
  assert.equal(stepPdfPage(r.pdf, 1).pdf, r.pdf, '最終ページから進んでも動かない');
  assert.equal(stepPdfPage(r.pdf, 1).error, null);
  assert.equal(stepPdfPage(r.pdf, -1).pdf.page, 2);
  const first = stepPdfPage(base, -1);
  assert.equal(first.pdf, base);
  for (const bad of ['', '0', '-1', '1.5', 'abc']) assert.equal(setPdfPage(base, bad).error, DETAIL_HELPER_MESSAGES.pdfPageInvalid, bad);
  assert.equal(setPdfPage(base, '4').error, ERR_PDF_PAGE_NOT_FOUND(4));
  assert.equal(setPdfPage(base, '4').pdf, base);
});

test('範囲の同期: ドラッグの 2 点（どの向きでも）→ 左上と幅・高さ（小数 1 桁）。数値欄の表示・入力と往復で一致する', async () => {
  const size = pageSizeOf(PAGE.view);
  assert.deepEqual(size, { w: 200, h: 100 });
  const rect = { left: 100, top: 50, width: 400, height: 200 }; // 画面上のページ画像（2 倍表示）
  const a = pointToPage({ clientX: 300, clientY: 100 }, rect, size);
  const b = pointToPage({ clientX: 200, clientY: 150 }, rect, size);
  assert.deepEqual([a, b], [{ x: 100, y: 25 }, { x: 50, y: 50 }]);
  assert.deepEqual(clipFromDrag(a, b), { x: 50, y: 25, w: 50, h: 25 });
  assert.deepEqual(clipFromDrag(b, a), { x: 50, y: 25, w: 50, h: 25 }, '逆向きのドラッグも同じ');
  assert.deepEqual(clipFromDrag({ x: 0.04, y: 0.06 }, { x: 10.26, y: 20.36 }), { x: 0, y: 0.1, w: 10.2, h: 20.3 }, '小数 1 桁へ丸める');
  // ページ画像の外へはみ出したら、ページの中へ丸める
  assert.deepEqual(pointToPage({ clientX: 0, clientY: 999 }, rect, size), { x: 0, y: 100 });
  // ドラッグで入った範囲が数値欄に出て、欄を直すと範囲が変わる
  let pdf = setPdfClip(await ready(), clipFromDrag(a, b));
  assert.deepEqual(['x', 'y', 'w', 'h'].map(f => pdfClipText(pdf.clip, f)), ['50', '25', '50', '25']);
  const edited = setPdfClipField(pdf, 'w', '70');
  assert.equal(edited.error, null);
  pdf = edited.pdf;
  assert.deepEqual(pdf.clip, { x: 50, y: 25, w: 70, h: 25 });
  assert.equal(pdfClipText(null, 'x'), '');
});

test('範囲の枠の CSS はページ寸法に対する % 指定。範囲が無効・ページ寸法が未取得なら null', () => {
  const size = { w: 200, h: 100 };
  assert.deepEqual(clipOverlayStyle({ x: 50, y: 25, w: 50, h: 25 }, size), { left: '25%', top: '25%', width: '25%', height: '25%' });
  assert.equal(clipOverlayStyle({ x: 0, y: 0, w: 0, h: 5 }, size), null);
  assert.equal(clipOverlayStyle(CLIP, null), null);
});

test('【失敗系】数値欄: 数値でない入力は pdf を変えず理由を返す。未知の項目は無視', async () => {
  const pdf = setPdfClip(await ready(), CLIP);
  const bad = setPdfClipField(pdf, 'x', 'abc');
  assert.equal(bad.error, DETAIL_HELPER_MESSAGES.pdfClipInvalid);
  assert.equal(bad.pdf, pdf);
  assert.equal(setPdfClipField(pdf, 'z', '1').pdf, pdf);
  const fromNull = setPdfClipField((await load()).pdf, 'w', '5');
  assert.deepEqual(fromNull.pdf.clip, { x: 0, y: 0, w: 5, h: 0 }, '範囲が未指定でも欄から作れる（幅・高さが 0 のうちは抽出できない）');
});

test('「抽出」と「下書きへ写す」の可否: 縮尺・有効な範囲・ページ寸法がそろえば抽出でき、写すには縮尺の入力・抽出結果・成分の選択が要る（縮尺は必須で既定なし）', async () => {
  const base = await ready();
  assert.equal(pdfCanExtract(base), true);
  assert.equal(pdfCanExtract(setPdfScale(base, '')), false, '縮尺なし');
  assert.equal(pdfCanExtract(setPdfScale(base, '0')), false);
  assert.equal(pdfCanExtract(setPdfClip(base, { x: 0, y: 0, w: 0, h: 5 })), false, '範囲が無効');
  assert.equal(pdfCanExtract({ ...base, view: null }), false, 'ページ寸法が未取得');
  assert.equal(pdfCanCopy(base), false, '抽出前');
  const { pdf: extracted } = extractPdf(base, PAGE);
  assert.equal(pdfCanCopy(extracted), false, '成分を選んでいない');
  const picked = toggleDxfComponent(extracted, 0);
  assert.equal(pdfCanCopy(picked), true);
  assert.equal(pdfCanCopy({ ...picked, scaleText: '' }), false, '縮尺が未入力なら写せない');
  assert.equal(pdfCanCopy({ ...picked, scaleText: 'abc' }), false);
  // 縮尺・範囲を変えると抽出結果と選択は捨てる（古い結果を写さない）
  assert.equal(setPdfScale(picked, '12').scene, null);
  assert.deepEqual(setPdfScale(picked, '12').selected, []);
  assert.equal(setPdfClip(picked, { x: 1, y: 1, w: 5, h: 5 }).scene, null);
});

test('通し: 読込み→範囲→縮尺→抽出→成分選択→新規下書き。矩形 R/U/L の閉じた 1 ストローク・検証が通る・出所（pdf・ページ・範囲・縮尺・sha256）が entry に載る', async () => {
  const { pdf: loaded } = await load();
  let pdf = setPdfScale(setPdfClip(setPdfPageView(loaded, PAGE.view), CLIP), ' 6 ');
  const r = extractPdf(pdf, PAGE);
  assert.equal(r.error, null);
  pdf = r.pdf;
  assert.equal(pdf.scene.pathCount, 2);
  assert.equal(pdf.scene.selectedCount, 1);
  const rows = dxfComponentRows(pdf);
  assert.deepEqual(rows.map(x => x.detail), ['4 頂点・閉']);
  pdf = setPdfScale(pdf, '6'); // 縮尺を直すと結果は捨てられる
  assert.equal(pdf.scene, null);
  pdf = extractPdf(pdf, PAGE).pdf;
  pdf = { ...pdf, maker: ' YKK ', series: 'SM3300' };
  pdf = toggleDxfComponent(pdf, 0);
  const { form, error } = draftFromDxf({ dxf: pdf, idFactory: ids });
  assert.equal(error, undefined);
  assert.equal(form.label, 'SM3300');
  assert.equal(form.strokes.length, 1);
  assert.equal(form.strokes[0].closed, true);
  assert.deepEqual(form.strokes[0].moves.map(m => m.dir), [PenDir.RIGHT, PenDir.UP, PenDir.LEFT]);
  assert.deepEqual(form.strokes[0].moves.map(m => Number(m.len)), [211.666667, 105.833333, 211.666667]);
  const result = validation(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(saveBlockers(form, result), []);
  const entry = entryFromForm(form);
  assert.deepEqual(entry.provenance, {
    source: DetailProvenanceSource.PDF, fileName: 'SM3300.pdf', sha256: pdf.sha256, page: 1, clip: CLIP, scaleDenominator: 6,
    maker: 'YKK', series: 'SM3300', licenseNote: '',
  });
  const notice = provenanceNoticeOf(form);
  assert.ok(notice.startsWith('PDF・'));
  assert.ok(notice.includes('ページ: 1') && notice.includes('縮尺: 1/6'));
  assert.equal(formatDetailProvenance(entry.provenance), notice, '保守パネルの出所表示と同じ文');
});

test('下書きへ写した後も出所欄（メーカー等）を直せ、保存形では trim され、ページ・範囲・縮尺は保たれる', async () => {
  const pdf = toggleDxfComponent(extractPdf(await ready(), PAGE).pdf, 0);
  const { form } = draftFromDxf({ dxf: pdf, idFactory: ids });
  const edited = setProvenanceField(form, DXF_PROVENANCE_FIELDS.LICENSE_NOTE, '  条件 ');
  const p = entryFromForm(edited).provenance;
  assert.equal(p.licenseNote, '条件');
  assert.deepEqual([p.page, p.clip, p.scaleDenominator], [1, CLIP, 6]);
  assert.equal(setProvenanceField(form, 'page', 9), form, '出所欄以外は変えない');
});

test('【失敗系】extractPdf: 縮尺なし・範囲なしは理由を返して結果を捨てる。ページを読めなければ ERR_PDF_PAGE_FAILED。範囲に何も無ければ NO_PATHS の警告', async () => {
  const base = await ready();
  const noScale = extractPdf(setPdfScale(base, ''), PAGE);
  assert.equal(noScale.error, WARN_PDF_SCALE_MISSING);
  assert.equal(noScale.pdf.scene, null);
  const noClip = extractPdf({ ...base, clip: null }, PAGE);
  assert.equal(noClip.error, DETAIL_HELPER_MESSAGES.pdfNeedClip);
  const broken = extractPdf(base, { ...PAGE, opList: { get fnArray() { throw new Error('壊れた'); }, argsArray: [] } });
  assert.equal(broken.error, ERR_PDF_PAGE_FAILED('壊れた'));
  assert.equal(broken.pdf.scene, null);
  const empty = extractPdf(setPdfClip(base, { x: 120, y: 0, w: 10, h: 10 }), PAGE);
  assert.equal(empty.error, null);
  assert.deepEqual(empty.pdf.scene.components, []);
  assert.ok(pdfWarningTexts(empty.pdf).includes(WARN_PDF_NO_PATHS));
});

test('警告の表示: 縮尺未入力・ライセンス未記入が並び、抽出すると文字の無視件数が出る。縮尺を入れるとスケールの警告が消え、注記でライセンスの警告も消える', async () => {
  const { pdf } = await load();
  assert.deepEqual(pdfWarningTexts(pdf), [WARN_PDF_SCALE_MISSING, WARN_DXF_LICENSE_UNKNOWN]);
  const extracted = extractPdf(await ready(), PAGE).pdf;
  assert.deepEqual(pdfWarningTexts(extracted), [WARN_PDF_TEXT_IGNORED(1), WARN_DXF_LICENSE_UNKNOWN]);
  assert.deepEqual(pdfWarningTexts({ ...extracted, licenseNote: '配布条件に従う' }), [WARN_PDF_TEXT_IGNORED(1)]);
  assert.equal(describePdfWarning({ code: PdfWarning.TEXT_IGNORED, count: 2 }), WARN_PDF_TEXT_IGNORED(2));
  assert.equal(describePdfWarning({ code: DxfWarning.CONTOUR_OPEN }), describeDxfWarning({ code: DxfWarning.CONTOUR_OPEN }), 'PDF の表に無いコードは DXF 共通の表へ');
});
