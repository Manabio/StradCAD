/**
 * uiBusyGate.test.js・uiBusyClassification.test.js が共用する、App.jsx をソーステキストとして
 * 走査するためのテスト専用の純関数。App.jsx はreact-konva等を静的に引くためnode:testから直接
 * importできないため、両テストとも「ソーステキストを波括弧の対応数で関数本体を抽出し、行コメントを
 * 落としてから正規表現/indexOfで判定する」という同じ作法を使う（structuralSync.test.jsの
 * 「App.jsx: switchHistoryContext…」系と同型）。
 *
 * 現在は uiBusy 以外の多数の配線テスト（*Wiring.test.js 等）も共用するソース走査の部品置き場。
 * コメント除去は出力の違う関数が複数ある。互いに置き換えてはいけない（テストが見る文字列が変わる）。
 *  - stripCommentLines            : `//` で始まる行だけを落とす（ブロックコメントは残る）
 *  - stripBlockAndCommentLines    : `/＊ ＊/` を先に消し、`//` で始まる行を落とす
 *  - stripCommentLikeLines        : `//`・`*`・`/＊` で始まる行を落とす（行単位。ブロックコメントの途中の行を想定）
 *  - stripBlockAndTrailingComments: `/＊ ＊/` と、`//` から行末までを消す（行の途中の `//` も消す）
 *  - stripCommentsKeepStrings     : 1 文字ずつ走査し、文字列リテラルの中身は残して `//`・`/＊ ＊/` を消す
 * 本体抽出も同様に別物: extractFunctionBody / extractArrowFunctionBody（コメント除去込み）、
 * extractBalancedBody（シグネチャ末尾の `{` から対応する `}` まで）、extractBodyAfterParams（引数の
 * 丸括弧を対応させてから本体の `{`）、topLevelBlock（次の行頭 `}` まで）。
 *
 * 製品コード（App.jsx・store.js等）からは import されない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ---- ソース走査用のリテラル（テスト専用モジュールのため core/constants.js へは置かない）----
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g; // ブロックコメント。replace 専用（g フラグ。.test/.exec には使わない）
const LINE_COMMENT_TAIL_RE = /\/\/[^\n]*/g; // `//` から行末。replace 専用
const LINE_BREAK_RE = /\r?\n/; // 行の区切り
const NEWLINE = '\n';
const COMMENT_MARK = Object.freeze({ LINE: '//', BLOCK_OPEN: '/*', BLOCK_CLOSE: '*/', STAR: '*' });
const QUOTES = Object.freeze(['\'', '"', '`']);
const ESCAPE = '\\';
const BRACKET = Object.freeze({ BRACE_OPEN: '{', BRACE_CLOSE: '}', PAREN_OPEN: '(', PAREN_CLOSE: ')', ARROW_BRACE: '=> {' });
const TOP_LEVEL_CLOSE = '\n}\n'; // トップレベルの関数・ブロックの閉じ（行頭の `}` の行）

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

/** `functionStartNeedle`（末尾が`{`で終わる。例: 'const handlePointerDown = (e) => {'）で始まる
 * アロー関数の本体を、波括弧の対応数で抽出し、行コメントを落として返す。extractFunctionBodyは
 * `") {"`探索（`async function <name>(...) {`型）を前提にするため、`") => {"`型のアロー関数
 * には使えない——ニードル自体が末尾`{`で終わるようにし、その位置から直接波括弧の対応数で
 * 本体を抽出する（入力規制ステップ3・§5-4）。 */
export function extractArrowFunctionBody(src, functionStartNeedle) {
  const startIdx = src.indexOf(functionStartNeedle);
  assert.ok(startIdx >= 0, `${functionStartNeedle} が見つからない`);
  const braceStart = startIdx + functionStartNeedle.length - 1;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return stripCommentLines(src.slice(braceStart, i + 1));
}

/** 本体（`{`から始まる）の最初の文（先頭の空白・改行を除いた直後）が、ちょうど
 * `expectedStatement`で始まることを確認する——本体の途中・末尾にあるだけでは緑にしない
 * （§5-4「本体のどこかにあるだけでは緑にしない」QA指摘・2026-09-28）。同一行の末尾コメントは
 * 許容する（startsWithで判定するため）。 */
export function assertFirstStatementIs(body, expectedStatement, label) {
  const inner = body.slice(1).replace(/^\s+/, '');
  assert.ok(inner.startsWith(expectedStatement),
    `${label} の本体の最初の文が \`${expectedStatement}\` ではない（実際の先頭: ${inner.slice(0, 60)}...）`);
}

/** ブロックコメントを消し、行頭（trim 後）が `//` の行を落とす。 */
export function stripBlockAndCommentLines(text) {
  return text.replace(BLOCK_COMMENT_RE, '').split(LINE_BREAK_RE)
    .filter(line => !line.trim().startsWith(COMMENT_MARK.LINE))
    .join(NEWLINE);
}

/** 文字列リテラル（引用符で囲まれた部分）は残し、`//`（行末の手前まで）と `/＊ ＊/` だけを消す。 */
export function stripCommentsKeepStrings(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + COMMENT_MARK.LINE.length); // 印はどれも同じ長さ
    if (two === COMMENT_MARK.LINE) {
      const nl = src.indexOf(NEWLINE, i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === COMMENT_MARK.BLOCK_OPEN) {
      const end = src.indexOf(COMMENT_MARK.BLOCK_CLOSE, i + COMMENT_MARK.BLOCK_OPEN.length);
      i = end === -1 ? src.length : end + COMMENT_MARK.BLOCK_CLOSE.length;
      continue;
    }
    const ch = src[i];
    if (QUOTES.includes(ch)) {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === ESCAPE ? ESCAPE.length + 1 : 1; // エスケープは次の 1 文字ごと飛ばす
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 行頭（trim 後）が `//`・`*`・`/＊` のどれかの行を落とす。 */
export function stripCommentLikeLines(text) {
  return text.split(LINE_BREAK_RE)
    .filter(line => {
      const t = line.trim();
      return !t.startsWith(COMMENT_MARK.LINE) && !t.startsWith(COMMENT_MARK.STAR) && !t.startsWith(COMMENT_MARK.BLOCK_OPEN);
    })
    .join(NEWLINE);
}

/** ブロックコメントと、`//` から行末までを消す（行の途中の `//` も消える）。 */
export function stripBlockAndTrailingComments(text) {
  return text.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_TAIL_RE, '');
}

/** `signature`（末尾が本体開始の `{`）の本体を、波括弧の対応数で `{`〜`}` まで切り出す。
 * 見つからなければ null。コメント除去はしない。 */
export function extractBalancedBody(src, signature) {
  const startIdx = src.indexOf(signature);
  if (startIdx < 0) return null;
  const braceStart = startIdx + signature.length - 1;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === BRACKET.BRACE_OPEN) depth++;
    else if (src[i] === BRACKET.BRACE_CLOSE) { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

/** 通常の関数は、先に引数の丸括弧を対応させて閉じてから、その後の最初の `{` を本体開始とする
 * （分割代入引数の `{` を本体開始と誤認しない）。`isArrowIife` のときは最初の `=> {` の `{`。
 * 見つからなければ null。コメント除去はしない。 */
export function extractBodyAfterParams(src, signatureOrConstName, { isArrowIife = false } = {}) {
  const startIdx = src.indexOf(signatureOrConstName);
  if (startIdx < 0) return null;
  let braceStart;
  if (isArrowIife) {
    braceStart = src.indexOf(BRACKET.BRACE_OPEN, src.indexOf(BRACKET.ARROW_BRACE, startIdx));
  } else {
    const parenStart = src.indexOf(BRACKET.PAREN_OPEN, startIdx);
    let pdepth = 0, j = parenStart;
    for (; j < src.length; j++) {
      if (src[j] === BRACKET.PAREN_OPEN) pdepth++;
      else if (src[j] === BRACKET.PAREN_CLOSE) { pdepth--; if (pdepth === 0) break; }
    }
    braceStart = src.indexOf(BRACKET.BRACE_OPEN, j);
  }
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === BRACKET.BRACE_OPEN) depth++;
    else if (src[i] === BRACKET.BRACE_CLOSE) { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

/** `startMarker` から次の行頭の `}`（`\n}\n`）の行までを返す。見つからなければ null。 */
export function topLevelBlock(src, startMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const e = src.indexOf(TOP_LEVEL_CLOSE, s);
  return e < 0 ? null : src.slice(s, e + TOP_LEVEL_CLOSE.length);
}
