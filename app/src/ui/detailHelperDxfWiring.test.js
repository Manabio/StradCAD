// ヘルパー画面の DXF 読込み（S7a）の配線を固定する不変条件テスト（detailHelperWiring.test.js と同型——
// コメントを除いたソース本体の正規表現検査）。純ロジックは ui/detailHelperDxf.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsKeepStrings as stripComments, extractBalancedBody } from '../uiBusySourceScan.js';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');

// ---- 判定（本体文字列 → 真偽。検出力テストにも同じ関数を渡す）----
// 隠し input（DXF 選択）は accept を持たない（iOS の Files は未登録拡張子を accept に含むと全ファイルをグレーアウトする）。
const dxfInputWithoutAccept = src => {
  const m = /<input\s+ref=\{dxfInputRef\}[^>]*\/>/.exec(src);
  return !!m && /type="file"/.test(m[0]) && !/accept/.test(m[0]);
};
// 先に input の値を空へ戻し（同じファイルの再選択でも onChange が発火する）、runBusy('図面読込み') の中で読む。
const readsInsideRunBusy = body => {
  if (!body) return false;
  const reset = body.search(/e\.target\.value\s*=\s*''/);
  const busyAt = body.search(/runBusy\('図面読込み'/);
  const readAt = body.search(/await file\.arrayBuffer\(\)/);
  const loadAt = body.search(/loadDxf\(/);
  return reset >= 0 && busyAt > reset && readAt > busyAt && loadAt > readAt;
};
// 「下書きへ写す」は draftFromDxf（→ formFromEntry）で下書きを作り、guardDiscard を通して replaceDoc(draftDocOf(…)) へ。
const copiesThroughGuard = body => !!body
  && body.search(/draftFromDxf\(/) >= 0
  && body.search(/guardDiscard\(/) > body.search(/draftFromDxf\(/)
  && /replaceDoc\(draftDocOf\(/.test(body);
const buildsViaFormFromEntry = body => !!body && /formFromEntry\(/.test(body);

test('【配線】DXF の隠し input は accept を持たない', () => {
  assert.ok(dxfInputWithoutAccept(stripComments(readSrc('ui/DetailHelperPanel.jsx'))));
});

test('【配線】handleImportFile: value を空へ戻してから、runBusy の中で arrayBuffer→loadDxf の順に読む', () => {
  const body = extractBalancedBody(stripComments(readSrc('ui/DetailHelperPanel.jsx')), 'async function handleImportFile(e) {');
  assert.ok(readsInsideRunBusy(body), body);
});

test('【配線】handleDxfCopy: draftFromDxf → guardDiscard → replaceDoc(draftDocOf(…))。draftFromDxf は formFromEntry を通す', () => {
  const panel = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(copiesThroughGuard(extractBalancedBody(panel, 'function handleDxfCopy() {')));
  const form = stripComments(readSrc('ui/detailHelperForm.js'));
  assert.ok(buildsViaFormFromEntry(extractBalancedBody(form, 'export function draftFromDxf({ dxf, idFactory }) {')));
});

test('【検出力】判定は壊れた配線を落とす（accept 付き・runBusy の外で読む・guardDiscard を通さない・formFromEntry を通さない）', () => {
  assert.equal(dxfInputWithoutAccept('<input ref={dxfInputRef} type="file" accept=".dxf" onChange={f} />'), false);
  assert.equal(dxfInputWithoutAccept('<input ref={dxfInputRef} type="file" onChange={f} />'), true);
  const good = "{ e.target.value = ''; runBusy('図面読込み', async () => { const b = await file.arrayBuffer(); return loadDxf(b); }); }";
  assert.equal(readsInsideRunBusy(good), true);
  assert.equal(readsInsideRunBusy("{ e.target.value = ''; const b = await file.arrayBuffer(); runBusy('図面読込み', () => loadDxf(b)); }"), false);
  assert.equal(readsInsideRunBusy("{ runBusy('図面読込み', async () => { const b = await file.arrayBuffer(); return loadDxf(b); }); e.target.value = ''; }"), false);
  assert.equal(copiesThroughGuard('{ const r = draftFromDxf(x); guardDiscard(() => { replaceDoc(draftDocOf(r.form)); }); }'), true);
  assert.equal(copiesThroughGuard('{ const r = draftFromDxf(x); replaceDoc(draftDocOf(r.form)); }'), false);
  assert.equal(copiesThroughGuard('{ const r = draftFromDxf(x); guardDiscard(() => { replaceDoc(r.form); }); }'), false);
  assert.equal(buildsViaFormFromEntry('{ return { form: formFromEntry(e) }; }'), true);
  assert.equal(buildsViaFormFromEntry('{ return { form: e }; }'), false);
});
