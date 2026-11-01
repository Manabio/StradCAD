// PDF 読込み（部分詳細図 S7b）の純モジュール（detail/pdf/）のテスト。pdfjs は使わず、合成した演算子列（fnArray／argsArray）と
// 合成の OPS 表を入力にする（番号は pdfjs と無関係の任意値。純モジュールは名前→番号の表を受け取るだけ）。
// 期待値は定数（式の写しにしない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfExtractPaths } from './pdfOps.js';
import { selectPathsInClip, isValidClip } from './pdfClip.js';
import { parseScaleDenominator, ptToMm, mmToPt, toPageSpace, pathsToPageSpace, segmentsToFigureMm } from './pdfUnits.js';
import { buildPdfProvenance } from './pdfProvenance.js';
import { isPdfBytes, checkPdfBytes, selectablePageCount, buildPdfScene } from './pdfImport.js';
import {
  PdfDrawOp, PdfWarning, PdfLimitKind, PdfReject, DxfWarning, DetailProvenanceSource, PDF_PT_TO_MM, PDF_MAX_BYTES, PDF_MAX_PAGES, PenDir,
} from '../../core/constants.js';

const OPS = Object.freeze({
  save: 10, restore: 11, transform: 12, constructPath: 91,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, endPath: 28,
  setFillRGBColor: 59, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  showText: 44, paintImageXObject: 85,
});
const { MOVE_TO: M, LINE_TO: L, CURVE_TO: C, QUAD_TO: Q, CLOSE: Z } = PdfDrawOp;

const list = (...entries) => ({ fnArray: entries.map(e => e[0]), argsArray: entries.map(e => e[1]) });
const path = (paint, data) => [OPS.constructPath, [paint, [data], null]]; // pdfjs 6.4: 経路データは 1 要素の配列で包まれる
const RECT = [M, 0, 0, L, 10, 0, L, 10, 5, L, 0, 5, Z];
const pt = (x, y) => ({ x, y });
const segs = (...pairs) => pairs.map(([a, b]) => ({ a: pt(...a), b: pt(...b) }));
const extract = (ol, opts) => pdfExtractPaths(ol, OPS, opts);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---------------------------------------------------------------- pdfOps
test('pdfOps: moveTo/lineTo/closePath の矩形（stroke）は 4 線分と外接矩形になる', () => {
  const { paths, warnings } = extract(list(path(OPS.stroke, RECT)));
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].segments, segs([[0, 0], [10, 0]], [[10, 0], [10, 5]], [[10, 5], [0, 5]], [[0, 5], [0, 0]]));
  assert.deepEqual(paths[0].bbox, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  assert.deepEqual(warnings, []);
});

test('pdfOps: 開いた部分経路は stroke なら閉じず、fill では始点へ閉じる（塗りは暗黙に閉じる）', () => {
  const open = [M, 0, 0, L, 10, 0, L, 10, 5];
  assert.equal(extract(list(path(OPS.stroke, open))).paths[0].segments.length, 2);
  assert.equal(extract(list(path(OPS.fill, open))).paths[0].segments.length, 3);
  assert.equal(extract(list(path(OPS.fillStroke, open))).paths[0].segments.length, 3);
  assert.equal(extract(list(path(OPS.closeStroke, open))).paths[0].segments.length, 3, 'closeStroke は閉じる');
});

test('pdfOps: 経路データは平らな数列（1 要素の配列で包まない形）でも読める。複数の部分経路（moveTo の繰返し）', () => {
  const data = Float32Array.from([M, 0, 0, L, 4, 0, M, 10, 10, L, 10, 14]);
  const { paths } = extract(list([OPS.constructPath, [OPS.stroke, data, null]]));
  assert.deepEqual(paths[0].segments, segs([[0, 0], [4, 0]], [[10, 10], [10, 14]]));
});

test('pdfOps: endPath（クリップの経路）は何も描かないので捨てる', () => {
  assert.deepEqual(extract(list(path(OPS.endPath, RECT))).paths, []);
});

test('pdfOps: 塗りだけで色が白の経路は地（背景・白抜き）として捨てる。白以外・fillStroke・save/restore で戻った色は残る', () => {
  const white = [OPS.setFillRGBColor, ['#ffffff']];
  const black = [OPS.setFillRGBColor, ['#140700']];
  assert.equal(extract(list(white, path(OPS.fill, RECT))).paths.length, 0);
  assert.equal(extract(list(white, path(OPS.eoFill, RECT))).paths.length, 0);
  assert.equal(extract(list(black, path(OPS.fill, RECT))).paths.length, 1);
  assert.equal(extract(list(white, path(OPS.fillStroke, RECT))).paths.length, 1, '輪郭が見えるので残す');
  assert.equal(extract(list(white, path(OPS.stroke, RECT))).paths.length, 1, '線の色は見ない');
  assert.equal(extract(list(black, [OPS.save, []], white, [OPS.restore, []], path(OPS.fill, RECT))).paths.length, 1, 'restore で塗りの色が戻る');
});

test('pdfOps: 2 次ベジェは弦公差で等分割（M=20pt：公差 1pt→3 分割、0.1pt→8 分割）。端点は制御点列の始点・終点', () => {
  const quad = [M, 0, 0, Q, 5, 10, 10, 0];
  const a = extract(list(path(OPS.stroke, quad)), { chordTolPt: 1 }).paths[0].segments;
  assert.equal(a.length, 3);
  assert.deepEqual(a[0].a, pt(0, 0));
  assert.deepEqual(a[2].b, pt(10, 0));
  assert.equal(extract(list(path(OPS.stroke, quad)), { chordTolPt: 0.1 }).paths[0].segments.length, 8);
});

test('pdfOps: 3 次ベジェは弦公差で等分割（M≈14.14pt：公差 1pt→4 分割）。公差 0（未指定）は 1 線分。折れ線の頂点は曲線上にある', () => {
  const cubic = [M, 0, 0, C, 0, 10, 10, 10, 10, 0];
  const s = extract(list(path(OPS.stroke, cubic)), { chordTolPt: 1 }).paths[0].segments;
  assert.equal(s.length, 4);
  assert.deepEqual(s[3].b, pt(10, 0));
  // t=0.5 の点（B(0.5) = (5, 7.5)）
  close(s[1].b.x, 5);
  close(s[1].b.y, 7.5);
  assert.equal(extract(list(path(OPS.stroke, cubic))).paths[0].segments.length, 1);
});

test('pdfOps: CTM — transform は経路の座標へ掛かる（拡大×2 と平行移動）', () => {
  const ol = list([OPS.transform, [2, 0, 0, 2, 100, 50]], path(OPS.stroke, RECT));
  assert.deepEqual(extract(ol).paths[0].segments, segs([[100, 50], [120, 50]], [[120, 50], [120, 60]], [[120, 60], [100, 60]], [[100, 60], [100, 50]]));
});

test('pdfOps: CTM — 続けて掛けた transform は後のものが先に点へ作用する（新 CTM＝M×CTM）', () => {
  const ol = list([OPS.transform, [1, 0, 0, 1, 10, 0]], [OPS.transform, [2, 0, 0, 2, 0, 0]], path(OPS.stroke, [M, 1, 1, L, 2, 1]));
  assert.deepEqual(extract(ol).paths[0].segments, segs([[12, 2], [14, 2]]));
});

test('pdfOps: CTM — save/restore で積み戻す。回転 90° の行列も適用される', () => {
  const ol = list([OPS.save, []], [OPS.transform, [1, 0, 0, 1, 100, 0]], path(OPS.stroke, [M, 0, 0, L, 1, 0]), [OPS.restore, []], path(OPS.stroke, [M, 0, 0, L, 1, 0]));
  assert.deepEqual(extract(ol).paths.map(p => p.segments[0]), segs([[100, 0], [101, 0]], [[0, 0], [1, 0]]));
  const rot = list([OPS.transform, [0, 1, -1, 0, 0, 0]], path(OPS.stroke, [M, 0, 0, L, 1, 0]));
  assert.deepEqual(extract(rot).paths[0].segments, segs([[0, 0], [0, 1]]));
});

test('pdfOps: CTM — paintFormXObjectBegin（matrix）は save＋transform、End は restore。matrix が null なら変換なし。余分な restore で落ちない', () => {
  const ol = list(
    [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 5, 5], [0, 0, 100, 100]]], path(OPS.stroke, [M, 0, 0, L, 1, 0]), [OPS.paintFormXObjectEnd, []],
    path(OPS.stroke, [M, 0, 0, L, 1, 0]),
    [OPS.paintFormXObjectBegin, [null, null]], path(OPS.stroke, [M, 2, 2, L, 3, 2]), [OPS.paintFormXObjectEnd, []],
    [OPS.restore, []], [OPS.restore, []],
  );
  assert.deepEqual(extract(ol).paths.map(p => p.segments[0]), segs([[5, 5], [6, 5]], [[0, 0], [1, 0]], [[2, 2], [3, 2]]));
});

test('pdfOps: 文字・画像は読まず件数だけ警告（ページ全体の件数）', () => {
  const ol = list([OPS.showText, []], [OPS.showText, []], [OPS.paintImageXObject, []], path(OPS.stroke, RECT));
  const { paths, warnings } = extract(ol);
  assert.equal(paths.length, 1);
  assert.deepEqual(warnings, [{ code: PdfWarning.TEXT_IGNORED, count: 2 }, { code: PdfWarning.IMAGE_IGNORED, count: 1 }]);
});

test('【失敗系】pdfOps: パス数の上限で打ち切り PATH_LIMIT。線分数の予算を使い切っても同じ', () => {
  const three = list(path(OPS.stroke, RECT), path(OPS.stroke, RECT), path(OPS.stroke, RECT));
  const r = extract(three, { maxPaths: 2 });
  assert.equal(r.paths.length, 2);
  assert.deepEqual(r.warnings, [{ code: PdfWarning.PATH_LIMIT, kind: PdfLimitKind.PATHS, limit: 2 }]);
  const s = extract(list(path(OPS.stroke, RECT)), { maxSegments: 3 });
  assert.equal(s.paths[0].segments.length, 3);
  assert.deepEqual(s.warnings, [{ code: PdfWarning.PATH_LIMIT, kind: PdfLimitKind.SEGMENTS, limit: 3 }]);
});

test('【失敗系】pdfOps: 曲線 1 本で線分の予算を超えない（maxSegments:10 で 10 線分以下）。警告は経路数でなく線分の上限', () => {
  const cubic = [M, 0, 0, C, 0, 1000, 1000, 1000, 1000, 0];
  const r = extract(list(path(OPS.stroke, cubic)), { chordTolPt: 0.001, maxSegments: 10 });
  assert.equal(r.paths[0].segments.length, 10);
  assert.deepEqual(r.warnings, [{ code: PdfWarning.PATH_LIMIT, kind: PdfLimitKind.SEGMENTS, limit: 10 }]);
});

test('【失敗系】pdfOps: 壊れた入力（引数なし・未知の符号・非有限の座標・曲線の極端な公差）でも投げず、読める分だけ返す', () => {
  assert.deepEqual(extract(list([OPS.constructPath, undefined])).paths, []);
  assert.deepEqual(extract(list([OPS.transform, undefined], [OPS.paintFormXObjectBegin, undefined])).paths, []);
  const unknown = extract(list(path(OPS.stroke, [M, 0, 0, L, 1, 0, 99, 5, 5, L, 9, 9])));
  assert.deepEqual(unknown.paths[0].segments, segs([[0, 0], [1, 0]]), '未知の符号の手前までは読む');
  assert.deepEqual(unknown.warnings, [{ code: PdfWarning.UNKNOWN_DRAW_OP, count: 1 }], '打ち切りを黙らず件数で警告する');
  const twice = extract(list(path(OPS.stroke, [M, 0, 0, L, 1, 0, 99]), path(OPS.stroke, [M, 0, 0, L, 2, 0, 98])));
  assert.deepEqual(twice.warnings, [{ code: PdfWarning.UNKNOWN_DRAW_OP, count: 2 }]);
  const nan = extract(list(path(OPS.stroke, [M, 0, 0, L, NaN, 0, L, 5, 5])));
  assert.deepEqual(nan.paths, [], '非有限の端点を含む線分は捨てる（残る線分が無ければ経路ごと無い）');
  assert.deepEqual(nan.warnings, [{ code: PdfWarning.NON_FINITE_SEGMENT, count: 2 }], '捨てた線分は件数で警告する');
  const mixed = extract(list(path(OPS.stroke, [M, 0, 0, L, NaN, 0, M, 5, 5, L, 6, 5])));
  assert.deepEqual(mixed.paths[0].segments, segs([[5, 5], [6, 5]]));
  assert.deepEqual(mixed.warnings, [{ code: PdfWarning.NON_FINITE_SEGMENT, count: 1 }]);
  const huge = extract(list(path(OPS.stroke, [M, 0, 0, C, 0, 1e12, 1e12, 1e12, 1e12, 0])), { chordTolPt: 1e-12 });
  assert.ok(huge.paths[0].segments.length <= 200000, '分割数に上限がある');
});

// ---------------------------------------------------------------- pdfClip
const P = (x0, y0, x1, y1) => ({ segments: segs([[x0, y0], [x1, y1]]), bbox: { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) } });
const CLIP = { x: 10, y: 10, w: 20, h: 20 }; // 矩形 [10,30]×[10,30]

test('pdfClip: 矩形に掛かる経路だけ丸ごと採る（完全に内側・矩形の辺をまたぐ・外から貫く）。完全に外は捨てる', () => {
  const inside = P(12, 12, 18, 12);
  const crossing = P(25, 20, 60, 20);     // 一部だけ内側（切り取らず丸ごと採る）
  const through = P(0, 20, 40, 20);       // 両端が外で矩形を貫く
  const outside = P(40, 40, 50, 50);
  const picked = selectPathsInClip([inside, crossing, through, outside], CLIP);
  assert.deepEqual(picked, [inside, crossing, through]);
  assert.equal(picked[1].segments[0].b.x, 60, '線分は切り取らない');
});

test('pdfClip: 外接矩形が重なっても線が矩形に掛からなければ捨てる（図を囲む枠線）。辺上に触れるだけでも採る', () => {
  const frame = { segments: segs([[0, 0], [40, 0]], [[40, 0], [40, 40]], [[40, 40], [0, 40]], [[0, 40], [0, 0]]), bbox: { minX: 0, minY: 0, maxX: 40, maxY: 40 } };
  assert.deepEqual(selectPathsInClip([frame], CLIP), []);
  const touching = P(30, 0, 30, 10); // (30,10) は矩形の角
  assert.deepEqual(selectPathsInClip([touching], CLIP), [touching]);
});

test('【失敗系】pdfClip: 範囲が無効（幅・高さが 0 以下・非有限・null）なら何も採らない', () => {
  const p = P(12, 12, 18, 12);
  for (const bad of [null, { x: 0, y: 0, w: 0, h: 5 }, { x: 0, y: 0, w: 5, h: -1 }, { x: NaN, y: 0, w: 5, h: 5 }]) {
    assert.deepEqual(selectPathsInClip([p], bad), []);
    assert.equal(isValidClip(bad), false);
  }
  assert.equal(isValidClip(CLIP), true);
});

// ---------------------------------------------------------------- pdfUnits
test('pdfUnits: pt→mm は ×25.4/72 ×縮尺分母（1/6 で 10pt → 21.1666…mm）。逆変換で戻る', () => {
  close(PDF_PT_TO_MM, 0.352777777777, 1e-9);
  close(ptToMm(72, 1), 25.4);
  close(ptToMm(10, 6), 21.166666666667, 1e-9);
  close(mmToPt(ptToMm(37, 6), 6), 37);
});

test('pdfUnits: 縮尺分母は正の数だけ。空・0・負・非数は null（縮尺は必須で既定なし）', () => {
  assert.equal(parseScaleDenominator('6'), 6);
  assert.equal(parseScaleDenominator(' 12.5 '), 12.5);
  for (const bad of ['', '  ', '0', '-3', 'abc', 'Infinity', null, undefined]) assert.equal(parseScaleDenominator(bad), null, String(bad));
});

test('pdfUnits: y 反転 — ユーザー空間（y 上向き）→ ページ座標（左上原点・y 下向き）。view の原点がずれていても揃う', () => {
  assert.deepEqual(toPageSpace(pt(10, 742), [0, 0, 595, 842]), pt(10, 100));
  assert.deepEqual(toPageSpace(pt(30, 70), [10, 20, 110, 220]), pt(20, 150));
  const moved = pathsToPageSpace([{ segments: segs([[0, 0], [10, 20]]), bbox: null }], [0, 0, 100, 100]);
  assert.deepEqual(moved[0].segments, segs([[0, 100], [10, 80]]));
  assert.deepEqual(moved[0].bbox, { minX: 0, minY: 80, maxX: 10, maxY: 100 });
});

test('pdfUnits: ページ座標の線分 → 図の mm（s 右・t 下向き正。1/1 で 72pt＝25.4mm）', () => {
  const out = segmentsToFigureMm(segs([[0, 0], [72, 36]]), 1);
  close(out[0].b.s, 25.4);
  close(out[0].b.t, 12.7);
  const six = segmentsToFigureMm(segs([[0, 0], [10, 0]]), 6);
  close(six[0].b.s, 21.166666666667, 1e-9);
});

// ---------------------------------------------------------------- pdfProvenance
test('pdfProvenance: ファイル名（パスは落とす）・sha256・ページ・範囲（pt）・縮尺分母・出所欄（trim）を持つ。ライセンス未記入は警告', () => {
  const { provenance, warnings } = buildPdfProvenance({
    fileName: 'C:\\dl\\sub\\SM3300.pdf', sha256: ' ab ', page: 3, clip: { x: 10.5, y: 20, w: 30, h: 40 }, scaleDenominator: 6,
    maker: ' YKK ', series: '', licenseNote: '',
  });
  assert.deepEqual(provenance, {
    source: DetailProvenanceSource.PDF, fileName: 'SM3300.pdf', sha256: 'ab', page: 3, clip: { x: 10.5, y: 20, w: 30, h: 40 },
    scaleDenominator: 6, maker: 'YKK', series: '', licenseNote: '',
  });
  assert.deepEqual(warnings, [{ code: DxfWarning.LICENSE_UNKNOWN }]);
  assert.deepEqual(buildPdfProvenance({ fileName: 'a.pdf', sha256: '', page: 1, clip: CLIP, scaleDenominator: 6, licenseNote: '条件' }).warnings, []);
});

test('【失敗系】pdfProvenance: digest が取れない（sha256 空）でも作れる。page・clip・縮尺が非有限なら 0（壊れた値を保存形へ入れない）', () => {
  const { provenance } = buildPdfProvenance({ fileName: 'a.pdf', sha256: '', page: NaN, clip: { x: NaN, y: 1, w: Infinity, h: 2 }, scaleDenominator: undefined });
  assert.equal(provenance.sha256, '');
  assert.equal(provenance.page, 0);
  assert.deepEqual(provenance.clip, { x: 0, y: 1, w: 0, h: 2 });
  assert.equal(provenance.scaleDenominator, 0);
});

// ---------------------------------------------------------------- pdfImport
const bytesOf = s => new TextEncoder().encode(s);

test('pdfImport: 内容判定 — 先頭 1024 バイト以内に %PDF- があれば PDF（拡張子・ファイル名は見ない）。DXF・空・非バイト列は偽', () => {
  assert.equal(isPdfBytes(bytesOf('%PDF-1.7\n...')), true);
  assert.equal(isPdfBytes(bytesOf(`junk\n${'x'.repeat(100)}%PDF-1.4`)), true);
  assert.equal(isPdfBytes(bytesOf(`${'x'.repeat(1100)}%PDF-1.4`)), false, '1024 バイトより後ろは対象外');
  assert.equal(isPdfBytes(bytesOf('0\nSECTION\n2\nHEADER\n')), false);
  assert.equal(isPdfBytes(new Uint8Array(0)), false);
  assert.equal(isPdfBytes(bytesOf('%PDF-1.7').buffer), true, 'ArrayBuffer も可');
  assert.equal(isPdfBytes('%PDF-1.7'), false);
  assert.equal(isPdfBytes(null), false);
});

test('【失敗系】pdfImport: checkPdfBytes — PDF でない→NOT_PDF、サイズ超過→SIZE_LIMIT（署名より先に判定）、非バイト列→NOT_PDF', () => {
  assert.deepEqual(checkPdfBytes(bytesOf('%PDF-1.7')), { ok: true });
  assert.deepEqual(checkPdfBytes(bytesOf('hello')), { ok: false, error: { code: PdfReject.NOT_PDF } });
  assert.deepEqual(checkPdfBytes({ byteLength: PDF_MAX_BYTES + 1 }), { ok: false, error: { code: PdfReject.SIZE_LIMIT, limit: PDF_MAX_BYTES } });
  assert.equal(checkPdfBytes({ byteLength: PDF_MAX_BYTES }).ok, false, '上限ちょうどはサイズ判定を通り、署名で落ちる');
  assert.deepEqual(checkPdfBytes(null), { ok: false, error: { code: PdfReject.NOT_PDF } });
});

test('pdfImport: selectablePageCount — 上限（200）までを選べ、超えたら PAGE_LIMIT。0 以下・非数は 0', () => {
  assert.deepEqual(selectablePageCount(70), { count: 70, warnings: [] });
  assert.deepEqual(selectablePageCount(201), { count: PDF_MAX_PAGES, warnings: [{ code: PdfWarning.PAGE_LIMIT, limit: 200, total: 201 }] });
  assert.equal(selectablePageCount(0).count, 0);
  assert.equal(selectablePageCount(NaN).count, 0);
});

// 通しの入力: ページ 200×100pt（ユーザー空間 y 上向き）。矩形 100×50pt（範囲内）・範囲の外の線・文字 1 件。
const PAGE = {
  opList: list(
    path(OPS.stroke, [M, 0, 0, L, 100, 0, L, 100, 50, L, 0, 50, Z]),
    path(OPS.stroke, [M, 150, 80, L, 190, 80]),
    [OPS.showText, []],
  ),
  ops: OPS,
  view: [0, 0, 200, 100],
};
const HALF = { x: 0, y: 0, w: 120, h: 100 }; // ページ座標（左上原点）。右の線（x≥150）は外

test('pdfImport: 通し — 演算子列 → クリップ → mm（1/6）→ 連結成分。矩形 1 つが閉じた 1 ストローク（R・U・L）、y は反転済み', () => {
  const r = buildPdfScene(PAGE, { clip: HALF, scaleDenominator: 6 });
  assert.equal(r.ok, true);
  assert.equal(r.pathCount, 2);
  assert.equal(r.selectedCount, 1, '範囲の外の線は捨てる');
  assert.deepEqual(r.warnings, [{ code: PdfWarning.TEXT_IGNORED, count: 1 }]);
  assert.equal(r.components.length, 1);
  const [c] = r.components;
  assert.equal(c.closed, true);
  assert.equal(c.strokes.length, 1);
  const [s] = c.strokes;
  assert.equal(s.closed, true);
  assert.deepEqual(s.moves.map(m => m.dir), [PenDir.RIGHT, PenDir.UP, PenDir.LEFT]);
  close(s.moves[0].len.mm, 211.666667, 1e-6); // 100pt ×25.4/72 ×6
  close(s.moves[1].len.mm, 105.833333, 1e-6); // 50pt
  close(s.moves[2].len.mm, 211.666667, 1e-6);
});

test('pdfImport: 範囲を広げれば外の線も別の成分として入る（成分は連結ごと）。範囲に何もなければ NO_PATHS', () => {
  const all = buildPdfScene(PAGE, { clip: { x: 0, y: 0, w: 200, h: 100 }, scaleDenominator: 6 });
  assert.equal(all.components.length, 2);
  assert.equal(all.components[1].closed, false);
  const none = buildPdfScene(PAGE, { clip: { x: 120, y: 0, w: 10, h: 10 }, scaleDenominator: 6 });
  assert.equal(none.components.length, 0);
  assert.ok(none.warnings.some(w => w.code === PdfWarning.NO_PATHS));
});

test('【失敗系】pdfImport: 縮尺が無い・0 以下なら成分を作らず SCALE_MISSING（mm へ換算できない）', () => {
  for (const bad of [null, undefined, 0, -6, NaN]) {
    const r = buildPdfScene(PAGE, { clip: HALF, scaleDenominator: bad });
    assert.equal(r.ok, true);
    assert.deepEqual(r.components, []);
    assert.deepEqual(r.warnings, [{ code: PdfWarning.SCALE_MISSING }]);
  }
});

test('【失敗系】pdfImport: 範囲が無効なら何も採らず NO_PATHS。演算子列が壊れていて例外が出ても握って ok:false', () => {
  const bad = buildPdfScene(PAGE, { clip: null, scaleDenominator: 6 });
  assert.deepEqual(bad.components, []);
  assert.ok(bad.warnings.some(w => w.code === PdfWarning.NO_PATHS));
  const broken = { ...PAGE, opList: { get fnArray() { throw new Error('壊れた演算子列'); }, argsArray: [] } };
  const r = buildPdfScene(broken, { clip: HALF, scaleDenominator: 6 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, PdfReject.UNEXPECTED);
  assert.match(r.error.message, /壊れた演算子列/);
});
