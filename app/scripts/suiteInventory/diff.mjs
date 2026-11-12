// テスト一覧（reporter.mjs の出力）の前後を比べる関門の道具。テストの消失と製品コードの実行済み範囲の減少を報告する。
//
// 使い方（app/ で実行）: node scripts/suiteInventory/diff.mjs <前1>[,<前2>…] <後1>[,<後2>…]
//   前は「全回で実行された分」（共通）、後は「どれかで実行された分」（和）にまとめて比べ、
//   項目ごとに OK/NG を出す。NG が 1 つでもあれば終了コード 1、引数不足・ファイルが読めないときは 2。
//
// カバレッジは実行ごとに揺れる（実測 2026-11-12）: 行は数行出入りし、分岐は記録の個数と行の帰属が変わり、
// 並び順も毎回違う。関数は安定。だから前＝2 回の共通・後＝2 回の和で比べ、分岐・関数は「行ごとの実行済み個数」へ畳む。
// 失敗経路のテストを落とすと、行は減らず分岐だけ減ることがある（だから分岐を外さない）。
//
// 揺れの原因（実測 2026-11-12・全テスト 5 回分）: 部屋・柱などの id が乱数（crypto.randomUUID）なので、id を比べる
// ソートの比較関数などで「どの分岐を通るか」が実行ごとに変わる。加えて V8 は、親と同じ回数だけ実行されたブロックを
// 記録から省く（通った分岐でも記録に出ないことがある）。前 2 回・後 2 回の 30 通りの組合せのうち 6 通りで
// 「実行されなくなった分岐」の誤検出が出た（箇所は finish/gridCells.js と ceiling/ceilingBoundaryStyle.js の
// ソート・区間走査の 2 か所）。行と関数の誤検出は 0。
// 分岐が NG になったときの見分け方: (1) その製品ファイルが、今回触ったテストから届くか（届かないなら揺れ）。
// (2) 後をもう 1 回採って和に足す（揺れなら消える）。どちらでも消えない NG は本物として扱う。
//
// 限界: assert を弱めても検出しない（実行されていれば同じ記録になる）。変更前に「呼ばれるたびに必ず通っていた」
// 分岐（V8 が記録を省く）が変更後に 1 度も通らなくなっても、同じ行の中なら分岐の個数は減って見えない
// （行が分かれていれば行の減少で出る）。テストの削除ではなく入力値の書き換えで起きるので、差分の目視で補う。
//
// テストのキーは「ファイル・入れ子の深さ・名前」で、親の describe 名を含まない。同じファイルの別の describe にある
// 同名テストの入れ替えは、件数が同じなら通る（このリポジトリは describe を使わず全テストが深さ 0＝2026-11-12 実測）。
//
// 定数はこの道具のモジュール内に置く（製品の定数表には混ぜない・承認済みの例外）。形式の定数は reporter.mjs から import。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RECORD, SEP, STATUS } from './reporter.mjs';

// 複数回のまとめ方（all＝共通・any＝和）
export const MERGE_MODE = Object.freeze({ all: 'all', any: 'any' });
// カバレッジの対象にしない（製品でない）ファイル: テスト・フィクスチャ・scripts/ 配下・絶対パス
const NON_PRODUCT_RE = /(\.test\.m?js|Fixtures\.js)$|^scripts\/|^[A-Za-z]:\/|^\//;
// 一覧の表示上限
const LIST_LIMIT = 10;
const ELLIPSIS = '…';
const EXIT = Object.freeze({ ok: 0, ng: 1, usage: 2 });

const INT_RE = /^\d+$/;
const ENCODING = 'utf8';
const isIntText = s => INT_RE.test(s);
function intOrThrow(text, what, lineNo) {
  if (!isIntText(text)) throw new Error(`インベントリ ${lineNo} 行目: ${what} が数値でない: ${JSON.stringify(text)}`);
  return Number(text);
}

function expandRanges(text, lineNo) {
  const set = new Set();
  if (!text) return set;
  for (const part of text.split(SEP.list)) {
    const [a, b] = part.split(SEP.range);
    const from = intOrThrow(a, '行の範囲', lineNo);
    const to = b === undefined ? from : intOrThrow(b, '行の範囲', lineNo);
    for (let n = from; n <= to; n++) set.add(n);
  }
  return set;
}

// "line:flag,…" を 行→実行済みの個数 へ畳む（並び順・記録の個数の揺れを吸収）
function executedPerLine(text, lineNo) {
  const m = new Map();
  if (!text) return m;
  for (const part of text.split(SEP.list)) {
    const [line, flag] = part.split(SEP.pair);
    const l = intOrThrow(line, '行番号', lineNo);
    const f = intOrThrow(flag, '実行フラグ', lineNo);
    m.set(l, (m.get(l) || 0) + f);
  }
  return m;
}

const MIN_COLS = Object.freeze({ [RECORD.test]: 5, [RECORD.coverage]: 6, [RECORD.summary]: 2 });

export function parseInventory(text) {
  const tests = new Map();
  const cov = new Map();
  const notPassed = [];
  const rows = text.split(SEP.record);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lineNo = i + 1;
    const c = row.split(SEP.field);
    const min = MIN_COLS[c[0]];
    if (min === undefined) throw new Error(`インベントリ ${lineNo} 行目: 未知のレコード種別 ${JSON.stringify(c[0])}`);
    if (c.length < min) throw new Error(`インベントリ ${lineNo} 行目: 列数が足りない（${c.length} < ${min}）`);
    if (c[0] === RECORD.test) {
      intOrThrow(c[2], '入れ子の深さ', lineNo);
      const key = [c[1], c[2], c[4]].join(SEP.field);
      tests.set(key, (tests.get(key) || 0) + 1);
      if (c[3] !== STATUS.pass) notPassed.push(`${c[3]}${SEP.field}${key}`);
    } else if (c[0] === RECORD.coverage) {
      const total = intOrThrow(c[2], '総行数', lineNo);
      const lines = expandRanges(c[3], lineNo);
      const branches = executedPerLine(c[4], lineNo);
      const functions = executedPerLine(c[5], lineNo);
      if (!NON_PRODUCT_RE.test(c[1])) cov.set(c[1], { total, lines, branches, functions });
    }
  }
  if (tests.size === 0) throw new Error('インベントリにテストの記録（T）が 1 件も無い');
  return { tests, cov, notPassed };
}

const cloneCov = v => ({ total: v.total, lines: new Set(v.lines), branches: new Map(v.branches), functions: new Map(v.functions) });
const PER_LINE_KEYS = Object.freeze(['branches', 'functions']);

// 複数回の実行を 1 つにまとめる。all＝全回で実行された分（共通）／any＝どれかで実行された分（和）
export function mergeRuns(runs, mode) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('mergeRuns: runs が空');
  if (mode !== MERGE_MODE.all && mode !== MERGE_MODE.any) throw new Error(`mergeRuns: 未知の mode ${JSON.stringify(mode)}`);
  const [first, ...rest] = runs;
  const cov = new Map();
  for (const [f, v] of first.cov) cov.set(f, cloneCov(v));
  for (const r of rest) {
    if (mode === MERGE_MODE.all) {
      for (const [f, a] of [...cov]) {
        const b = r.cov.get(f);
        if (!b) { cov.delete(f); continue; }
        for (const n of [...a.lines]) if (!b.lines.has(n)) a.lines.delete(n);
        for (const key of PER_LINE_KEYS) for (const [line, n] of a[key]) a[key].set(line, Math.min(n, b[key].get(line) || 0));
      }
    } else {
      for (const [f, b] of r.cov) {
        const a = cov.get(f);
        if (!a) { cov.set(f, cloneCov(b)); continue; }
        for (const n of b.lines) a.lines.add(n);
        for (const key of PER_LINE_KEYS) for (const [line, n] of b[key]) a[key].set(line, Math.max(n, a[key].get(line) || 0));
      }
    }
  }
  return { tests: first.tests, cov, notPassed: runs.flatMap(r => r.notPassed), runs };
}

const head = list => list.slice(0, LIST_LIMIT).join(SEP.list) + (list.length > LIST_LIMIT ? ELLIPSIS : '');

export function compareInventories(before, after) {
  const out = {
    missingTests: [], addedTests: [], notPassed: [...new Set(after.notPassed)], unstableTests: [],
    lostFiles: [], lostLines: [], lostBranches: [], lostFunctions: [], shapeChanged: [], gained: 0,
  };
  for (const side of [before, after]) {
    const runs = side.runs ?? [side];
    for (const r of runs.slice(1)) {
      for (const [k, n] of runs[0].tests) if ((r.tests.get(k) || 0) !== n) out.unstableTests.push(k);
      for (const k of r.tests.keys()) if (!runs[0].tests.has(k)) out.unstableTests.push(k);
    }
  }
  for (const [k, n] of before.tests) { const m = after.tests.get(k) || 0; if (m < n) out.missingTests.push(`${k}${SEP.field}(${n}→${m})`); }
  for (const [k, n] of after.tests) { const m = before.tests.get(k) || 0; if (m < n) out.addedTests.push(`${k}${SEP.field}(${m}→${n})`); }
  for (const [f, b] of before.cov) {
    const a = after.cov.get(f);
    if (!a) { if (b.lines.size) out.lostFiles.push(f); continue; }
    if (a.total !== b.total) out.shapeChanged.push(f);
    const lost = [...b.lines].filter(n => !a.lines.has(n));
    if (lost.length) out.lostLines.push(`${f}${SEP.field}${head(lost)}${SEP.field}(${lost.length}行)`);
    out.gained += [...a.lines].filter(n => !b.lines.has(n)).length;
    for (const [dest, key] of [[out.lostBranches, 'branches'], [out.lostFunctions, 'functions']]) {
      const bad = [];
      for (const [line, n] of b[key]) {
        const m = a[key].get(line) || 0;
        if (m < n) bad.push(`${line}(${n}→${m})`);
      }
      if (bad.length) dest.push(`${f}${SEP.field}${head(bad)}${SEP.field}(${bad.length}件)`);
    }
  }
  return out;
}

const sumCounts = m => [...m.values()].reduce((x, y) => x + y, 0);
const USAGE = '使い方: node scripts/suiteInventory/diff.mjs <前1>[,<前2>…] <後1>[,<後2>…]';

function main(argv) {
  if (argv.length < 2) { console.error(USAGE); return EXIT.usage; }
  const resolved = argv.slice(0, 2).map(arg => arg.split(SEP.list).map(f => path.resolve(f)));
  const shared = resolved[0].filter(f => resolved[1].includes(f));
  if (shared.length) {
    console.error(`前と後に同じ一覧がある（後の和に前が混ざって減少が隠れる）: ${shared.join(SEP.list)}\n${USAGE}`);
    return EXIT.usage;
  }
  let before, after;
  try {
    const load = arg => arg.split(SEP.list).map(f => parseInventory(readFileSync(f, ENCODING)));
    before = mergeRuns(load(argv[0]), MERGE_MODE.all);
    after = mergeRuns(load(argv[1]), MERGE_MODE.any);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return EXIT.usage;
  }
  const noCoverage = [['前', before], ['後', after]].filter(([, side]) => side.cov.size === 0).map(([name]) => name);
  if (noCoverage.length) {
    console.error(`カバレッジの記録（C）が無い側: ${noCoverage.join(SEP.list)}（--experimental-test-coverage の付け忘れでは）\n${USAGE}`);
    return EXIT.usage;
  }
  const r = compareInventories(before, after);
  console.log(`テスト: 前 ${sumCounts(before.tests)} 件 / 後 ${sumCounts(after.tests)} 件  製品ファイル: 前 ${before.cov.size} / 後 ${after.cov.size}`);
  let ng = 0;
  for (const [label, list] of [
    ['消えたテスト', r.missingTests], ['増えたテスト', r.addedTests], ['合格でないテスト（後）', r.notPassed],
    ['実行ごとに出入りするテスト', r.unstableTests],
    ['カバレッジから消えた製品ファイル', r.lostFiles], ['実行されなくなった行', r.lostLines],
    ['実行されなくなった分岐', r.lostBranches], ['実行されなくなった関数', r.lostFunctions],
    ['行数が変わった製品ファイル', r.shapeChanged],
  ]) {
    console.log(`${list.length ? 'NG' : 'OK'} ${label}: ${list.length}`);
    for (const x of list.slice(0, LIST_LIMIT)) console.log(`   ${x}`);
    if (list.length) ng++;
  }
  console.log(`新たに実行された行: ${r.gained}`);
  return ng ? EXIT.ng : EXIT.ok;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
