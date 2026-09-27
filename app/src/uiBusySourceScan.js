/**
 * uiBusyGate.test.js・uiBusyClassification.test.js が共用する、App.jsx をソーステキストとして
 * 走査するためのテスト専用の純関数。App.jsx はreact-konva等を静的に引くためnode:testから直接
 * importできないため、両テストとも「ソーステキストを波括弧の対応数で関数本体を抽出し、行コメントを
 * 落としてから正規表現/indexOfで判定する」という同じ作法を使う（structuralSync.test.jsの
 * 「App.jsx: switchHistoryContext…」系と同型）。
 *
 * 製品コード（App.jsx・store.js等）からは import されない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const appSrcPath = path.resolve(import.meta.dirname, 'App.jsx');

/** App.jsxのソーステキストをそのまま返す（コメント除去はしない）。 */
export function readAppSrc() {
  return fs.readFileSync(appSrcPath, 'utf8');
}

/** 行コメント（`//`で始まる行）を除いたテキストを返す（ソース走査の既知の弱点＝コメント文への
 * 誤マッチを避けるため、走査対象は必ずこれを通す）。 */
export function stripCommentLines(src) {
  return src.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
}

/** `functionStartNeedle`（例: 'async function handleFloorSwitch'）で始まる関数の本体を、
 * 波括弧の対応数で抽出し、行コメントを落として返す。 */
export function extractFunctionBody(src, functionStartNeedle) {
  const startIdx = src.indexOf(functionStartNeedle);
  assert.ok(startIdx >= 0, `${functionStartNeedle} が見つからない`);
  const parenCloseIdx = src.indexOf(') {', startIdx);
  const braceStart = src.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  return stripCommentLines(body);
}

/** 本体内で最初に現れる`await`が、`await runBusy(`のそれと一致することを確認する
 * ——「関門(runBusy)へ最初のawaitより前に同期で入る」（他のawait可能な処理が
 * 関門より先に走らない）を保証する。ガード（if(...) return;等の同期文）は本体の先頭に
 * あってよい（awaitを含まないため最初のawait位置には影響しない）。 */
export function assertRunBusyIsFirstAwait(body, label) {
  const rtCallIdx = body.indexOf('runBusy(');
  assert.ok(rtCallIdx >= 0, `${label} の本体に runBusy( の呼び出しが無い`);
  const rtAwaitIdx = body.lastIndexOf('await', rtCallIdx);
  assert.ok(rtAwaitIdx >= 0 && body.slice(rtAwaitIdx, rtCallIdx).trim() === 'await',
    `${label} の runBusy( はawaitされている必要がある`);
  const firstAwaitIdx = body.indexOf('await');
  assert.equal(firstAwaitIdx, rtAwaitIdx,
    `${label} では runBusy( より前に他のawaitが無い必要がある（実際: 最初のawaitは位置${firstAwaitIdx}、runBusyのawaitは位置${rtAwaitIdx}）`);
}

// beginUiTransition()はrunBusy(より前（同期）に呼ぶ必要がある——入力中フィールドの
// blur・ESC相当の中断を、関門に入る（isUiBusy()が真になる）前ではなく必ず前に
// 済ませておくため（任意項目・QAコメント2026-09-27）。
export function assertBeginUiTransitionBeforeRunBusy(body, label) {
  const beginIdx = body.indexOf('beginUiTransition()');
  assert.ok(beginIdx >= 0, `${label} の本体に beginUiTransition() の呼び出しが無い`);
  const rtIdx = body.indexOf('runBusy(');
  assert.ok(rtIdx >= 0, `${label} の本体に runBusy( の呼び出しが無い`);
  assert.ok(beginIdx < rtIdx, `${label} では beginUiTransition() が runBusy( より前である必要がある`);
}
