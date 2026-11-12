// テスト一覧＋カバレッジの記録用 node:test カスタムレポーター（テストコード削減リファクタの関門の道具）。
// 前後で「テストが 1 件も消えていない」「製品コードの実行済み行・分岐・関数が減っていない」を diff.mjs で確かめる。
//
// 使い方（app/ で実行。出力先は任意）:
//   node --import ./scripts/testSetup.mjs --test --experimental-test-coverage \
//     --test-reporter=./scripts/suiteInventory/reporter.mjs --test-reporter-destination=<出力先>
//
// 出力はタブ区切り・1 行 1 レコード（ファイルは作業ディレクトリからの相対・区切りは /）:
//   T <ファイル> <入れ子の深さ> <結果> <JSON 文字列化したテスト名>
//   C <ファイル> <総行数> <実行済み行の範囲（1-13,17）> <分岐 line:0|1 のカンマ区切り> <関数 line:0|1 のカンマ区切り>
//   S coverage … / S summary …（集計。比較では読み飛ばす）
//
// この道具の定数は製品の定数表（core/constants.js）へ混ぜず、このモジュールに置く（承認済みの例外）。
// diff.mjs は形式の定数をここから import する（二重に書かない）。
import path from 'node:path';

// 形式の定数（区切り文字）
export const SEP = Object.freeze({ field: '\t', record: '\n', list: ',', pair: ':', range: '-', path: '/', ratio: '/' });
// レコード種別
export const RECORD = Object.freeze({ test: 'T', coverage: 'C', summary: 'S' });
// S レコードの見出し
export const SUMMARY_LABEL = Object.freeze({ coverage: 'coverage', summary: 'summary' });
// テストの結果
export const STATUS = Object.freeze({ pass: 'pass', fail: 'fail', skip: 'skip', todo: 'todo' });
// node:test のイベント名・種別
const EVENT = Object.freeze({ pass: 'test:pass', fail: 'test:fail', coverage: 'test:coverage', summary: 'test:summary' });
const SUITE_TYPE = 'suite';

const rel = (cwd, p) => path.relative(cwd, p).split(path.sep).join(SEP.path);

// 連続する行番号を a-b に畳む
function toRanges(nums) {
  const out = [];
  const push = (s, e) => out.push(s === e ? `${s}` : `${s}${SEP.range}${e}`);
  let s = null;
  let e = null;
  for (const n of nums) {
    if (s === null) { s = e = n; continue; }
    if (n === e + 1) { e = n; continue; }
    push(s, e);
    s = e = n;
  }
  if (s !== null) push(s, e);
  return out.join(SEP.list);
}

const record = (...cols) => cols.join(SEP.field) + SEP.record;
const pairs = items => items.map(x => `${x.line}${SEP.pair}${x.count > 0 ? 1 : 0}`).join(SEP.list);

function statusOf(type, d) {
  if (d.skip !== undefined) return STATUS.skip;
  if (d.todo !== undefined) return STATUS.todo;
  return type === EVENT.pass ? STATUS.pass : STATUS.fail;
}

export default async function* suiteInventoryReporter(source) {
  const cwd = process.cwd();
  for await (const event of source) {
    const d = event.data;
    if (event.type === EVENT.pass || event.type === EVENT.fail) {
      if (d.details?.type === SUITE_TYPE) continue;
      const file = d.file ? rel(cwd, d.file) : '';
      yield record(RECORD.test, file, d.nesting, statusOf(event.type, d), JSON.stringify(d.name));
    } else if (event.type === EVENT.coverage) {
      const base = d.summary.workingDirectory || cwd;
      for (const f of d.summary.files) {
        const lines = f.lines.filter(l => l.count > 0).map(l => l.line);
        yield record(RECORD.coverage, rel(base, f.path), f.totalLineCount, toRanges(lines), pairs(f.branches), pairs(f.functions));
      }
      const t = d.summary.totals;
      const ratio = (a, b) => `${a}${SEP.ratio}${b}`;
      yield record(RECORD.summary, SUMMARY_LABEL.coverage,
        ratio(t.coveredLineCount, t.totalLineCount),
        ratio(t.coveredBranchCount, t.totalBranchCount),
        ratio(t.coveredFunctionCount, t.totalFunctionCount));
    } else if (event.type === EVENT.summary && !d.file) {
      yield record(RECORD.summary, SUMMARY_LABEL.summary, JSON.stringify(d.counts), d.success);
    }
  }
}
