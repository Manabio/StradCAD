// ヘルパー画面の PDF 読込み（S7b）の配線を固定する不変条件テスト（detailHelperDxfWiring.test.js と同型——
// コメントを除いたソース本体の正規表現検査）。純ロジックは ui/detailHelperPdf.test.js・detail/pdf/pdf.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');

// 文字列リテラルは保持し、// と /* */ のコメントだけを取り除く（コメント中の言及で「配線されている」と誤検知しない）。
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractBalancedBody(src, signature) {
  const startIdx = src.indexOf(signature);
  if (startIdx < 0) return null;
  const braceStart = startIdx + signature.length - 1;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

// ---- 判定（本体文字列 → 真偽。検出力テストにも同じ関数を渡す）----
// 内容判定（先頭が %PDF- か）→ PDF なら loadPdfFile、そうでなければ loadDxf。どちらも runBusy の中。
const sniffsBeforeLoading = body => {
  if (!body) return false;
  const busyAt = body.search(/runBusy\('図面読込み'/);
  const sniffAt = body.search(/isPdfBytes\(/);
  const pdfAt = body.search(/loadPdfFile\(/);
  const dxfAt = body.search(/loadDxf\(/);
  return busyAt >= 0 && sniffAt > busyAt && pdfAt > sniffAt && dxfAt > pdfAt;
};
// pdfjs は初回の PDF を開くときだけ動的 import（独立チャンク）。
const loadsLoaderDynamically = body => !!body && /await import\('\.\/pdfLoader\.js'\)/.test(body);
// 抽出は runBusy の中で、ページの演算子列を読んでから extractPdf へ渡す。
const extractsInsideRunBusy = body => {
  if (!body) return false;
  const busyAt = body.search(/runBusy\('図面読込み'/);
  const readAt = body.search(/readPdfPage\(/);
  const extractAt = body.search(/extractPdf\(/);
  return busyAt >= 0 && readAt > busyAt && extractAt > readAt;
};
// 「写す」「抽出」の無効条件は純関数（縮尺必須）へ寄せ、パネルはそれを渡すだけ。
const gatesViaPureFunctions = src => /canCopy=\{pdfCanCopy\(pdf\)\}/.test(src) && /disabled=\{busy \|\| !pdfCanExtract\(pdf\)\}/.test(src);
const copyButtonUsesCanCopy = src => /disabled=\{busy \|\| !canCopy( \|\| !!copyNotice)?\}/.test(src); // 一式のときは copyNotice でも無効（C5）
// pdfjs を import してよいのは ui/pdfLoader.js だけ（静的にも動的にも）。
const importsPdfjs = src => /from\s+['"]pdfjs-dist|import\(\s*['"]pdfjs-dist/.test(src);
const staticallyImportsLoader = src => /^\s*import[^;]*from\s+['"]\.\/pdfLoader\.js['"]/m.test(src);

function productFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...productFiles(p));
    else if (/\.(js|jsx)$/.test(e.name) && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

test('【配線】handleImportFile: runBusy の中で isPdfBytes による内容判定 → PDF は loadPdfFile、それ以外は loadDxf', () => {
  const body = extractBalancedBody(stripComments(readSrc('ui/DetailHelperPanel.jsx')), 'async function handleImportFile(e) {');
  assert.ok(sniffsBeforeLoading(body), body);
});

// 先頭だけ読んで判定 → PDF の上限は全体を読む前に file.size で見る。
const checksSizeBeforeFullRead = body => {
  if (!body) return false;
  const sliceAt = body.search(/file\.slice\(0, PDF_SIGNATURE_SCAN_BYTES\)/);
  const sizeAt = body.search(/file\.size > PDF_MAX_BYTES/);
  const fullAt = body.search(/await file\.arrayBuffer\(\)/);
  return sliceAt >= 0 && sizeAt > sliceAt && fullAt > sizeAt;
};

test('【配線】handleImportFile: 先頭だけ読んで判定し、PDF の大きさの上限は全体を読む前に見る', () => {
  const body = extractBalancedBody(stripComments(readSrc('ui/DetailHelperPanel.jsx')), 'async function handleImportFile(e) {');
  assert.ok(checksSizeBeforeFullRead(body), body);
  assert.equal(checksSizeBeforeFullRead('{ const b = await file.arrayBuffer(); if (file.size > PDF_MAX_BYTES) x; file.slice(0, PDF_SIGNATURE_SCAN_BYTES); }'), false);
});

test('【配線】loadPdfFile: pdfLoader.js は動的 import（静的 import しない）。pdfjs-dist を引くのは ui/pdfLoader.js だけ', () => {
  const panel = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(loadsLoaderDynamically(extractBalancedBody(panel, 'async function loadPdfFile(bytes, fileName) {')));
  assert.equal(staticallyImportsLoader(panel), false);
  const importers = productFiles(appSrc).filter(f => importsPdfjs(stripComments(fs.readFileSync(f, 'utf8')))).map(f => path.relative(appSrc, f).replace(/\\/g, '/'));
  assert.deepEqual(importers, ['ui/pdfLoader.js']);
  assert.match(stripComments(readSrc('ui/pdfLoader.js')), /pdf\.worker\.min\.mjs\?url/, 'worker は ?url で同梱');
});

test('【配線】handlePdfExtract: runBusy の中で readPdfPage → extractPdf の順', () => {
  const body = extractBalancedBody(stripComments(readSrc('ui/DetailHelperPanel.jsx')), 'async function handlePdfExtract() {');
  assert.ok(extractsInsideRunBusy(body), body);
});

test('【配線】「下書きへ写す」「抽出」の無効条件は pdfCanCopy／pdfCanExtract（縮尺必須の判定）を通る。ボタンは canCopy で無効化', () => {
  const panel = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(gatesViaPureFunctions(panel));
  assert.ok(copyButtonUsesCanCopy(panel));
});

test('【検出力】判定は壊れた配線を落とす（判定が先に無い・runBusy の外・静的 import・pdfjs の直 import・無効条件の素通し）', () => {
  assert.equal(sniffsBeforeLoading("{ runBusy('図面読込み', async () => { if (isPdfBytes(b)) return loadPdfFile(b); return loadDxf(b); }); }"), true);
  assert.equal(sniffsBeforeLoading("{ runBusy('図面読込み', async () => { return loadDxf(b); }); }"), false);
  assert.equal(sniffsBeforeLoading("{ runBusy('図面読込み', async () => { if (isPdfBytes(b)) return loadPdfFile(b); }); loadDxf(b); }".replace('runBusy(', 'x(')), false);
  assert.equal(sniffsBeforeLoading("{ runBusy('図面読込み', async () => { return loadDxf(b) || loadPdfFile(b) || isPdfBytes(b); }); }"), false);
  assert.equal(loadsLoaderDynamically("{ x ??= await import('./pdfLoader.js'); }"), true);
  assert.equal(loadsLoaderDynamically("{ x = pdfLoader; }"), false);
  assert.equal(staticallyImportsLoader("import * as L from './pdfLoader.js';\nconst a = 1;"), true);
  assert.equal(staticallyImportsLoader("const L = () => import('./pdfLoader.js');"), false);
  assert.equal(importsPdfjs("import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';"), true);
  assert.equal(importsPdfjs("const m = await import('pdfjs-dist');"), true);
  assert.equal(importsPdfjs("import { x } from './detailHelperPdf.js';"), false);
  assert.equal(extractsInsideRunBusy("{ runBusy('図面読込み', async () => { const p = await readPdfPage(d, 1); return extractPdf(s, p); }); }"), true);
  assert.equal(extractsInsideRunBusy("{ const p = await readPdfPage(d, 1); runBusy('図面読込み', () => extractPdf(s, p)); }"), false);
  assert.equal(gatesViaPureFunctions('canCopy={pdfCanCopy(pdf)} disabled={busy || !pdfCanExtract(pdf)}'), true);
  assert.equal(gatesViaPureFunctions('canCopy={pdf.selected.length > 0} disabled={busy || !pdfCanExtract(pdf)}'), false);
  assert.equal(copyButtonUsesCanCopy('<button disabled={busy || !canCopy} />'), true);
  assert.equal(copyButtonUsesCanCopy('<button disabled={busy} />'), false);
});
