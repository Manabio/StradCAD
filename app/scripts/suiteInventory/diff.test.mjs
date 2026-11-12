// diff.mjs（テスト一覧・カバレッジの前後比較）と reporter.mjs の単体テスト。
// assert には数値・文字列・小さな配列だけを渡す（Map・Set・大きなオブジェクトは失敗時の差分生成でメモリが膨らむ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseInventory, mergeRuns, compareInventories, MERGE_MODE } from './diff.mjs';
import reporter, { RECORD, SEP, STATUS, SUMMARY_LABEL } from './reporter.mjs';

const row = (...cols) => cols.join(SEP.field) + SEP.record;
const T = (file, name, status = STATUS.pass, nesting = 0) => row(RECORD.test, file, nesting, status, JSON.stringify(name));
const C = (file, total, ranges, branches = '', functions = '') => row(RECORD.coverage, file, total, ranges, branches, functions);
const S = row(RECORD.summary, SUMMARY_LABEL.summary, '{}', true);

const A = 'src/a.js';
const base = () => T('src/a.test.js', 't1') + T('src/a.test.js', 't2') + C(A, 20, '1-10,15', '3:1,3:1,5:0', '1:1,8:1') + S;

function diffOf(beforeText, afterText) {
  const r = compareInventories(parseInventory(beforeText), parseInventory(afterText));
  return {
    missing: r.missingTests.length, added: r.addedTests.length, notPassed: r.notPassed.length, unstable: r.unstableTests.length,
    lostFiles: r.lostFiles.length, lostLines: r.lostLines.length, lostBranches: r.lostBranches.length,
    lostFunctions: r.lostFunctions.length, shape: r.shapeChanged.length, gained: r.gained,
  };
}
const ZERO = { missing: 0, added: 0, notPassed: 0, unstable: 0, lostFiles: 0, lostLines: 0, lostBranches: 0, lostFunctions: 0, shape: 0, gained: 0 };
const withOverride = o => ({ ...ZERO, ...o });

test('一致: 同じ入力どうしは全項目 0 件', () => {
  assert.deepEqual(diffOf(base(), base()), ZERO);
});

test('テスト削除を検出する', () => {
  const after = T('src/a.test.js', 't1') + C(A, 20, '1-10,15', '3:1,3:1,5:0', '1:1,8:1');
  assert.deepEqual(diffOf(base(), after), withOverride({ missing: 1 }));
  const r = compareInventories(parseInventory(base()), parseInventory(after));
  assert.equal(r.missingTests.join('|'), ['src/a.test.js', '0', JSON.stringify('t2'), '(1→0)'].join(SEP.field));
});

test('テスト追加を検出する', () => {
  assert.deepEqual(diffOf(base(), base() + T('src/a.test.js', 't3')), withOverride({ added: 1 }));
});

test('同名テストが 2 件から 1 件に減ったのを検出する（件数の多重集合）', () => {
  const before = T('src/a.test.js', 'dup') + T('src/a.test.js', 'dup');
  const after = T('src/a.test.js', 'dup');
  const r = compareInventories(parseInventory(before), parseInventory(after));
  assert.equal(r.missingTests.length, 1);
  assert.ok(r.missingTests[0].endsWith('(2→1)'));
});

test('合格でないテスト（fail・skip）を検出する', () => {
  const after = T('src/a.test.js', 't1', STATUS.fail) + T('src/a.test.js', 't2', STATUS.skip) + C(A, 20, '1-10,15', '3:1,3:1,5:0', '1:1,8:1');
  assert.deepEqual(diffOf(base(), after), withOverride({ notPassed: 2 }));
});

test('行の減少を検出し、増えた行は数える', () => {
  const after = T('src/a.test.js', 't1') + T('src/a.test.js', 't2') + C(A, 20, '1-9,16', '3:1,3:1,5:0', '1:1,8:1');
  assert.deepEqual(diffOf(base(), after), withOverride({ lostLines: 1, gained: 1 }));
  const r = compareInventories(parseInventory(base()), parseInventory(after));
  assert.equal(r.lostLines.join('|'), [A, '10,15', '(2行)'].join(SEP.field));
});

test('分岐の減少を検出する（行は同じで分岐だけ減る）', () => {
  const after = T('src/a.test.js', 't1') + T('src/a.test.js', 't2') + C(A, 20, '1-10,15', '3:1,3:0,5:0', '1:1,8:1');
  assert.deepEqual(diffOf(base(), after), withOverride({ lostBranches: 1 }));
  const r = compareInventories(parseInventory(base()), parseInventory(after));
  assert.equal(r.lostBranches.join('|'), [A, '3(2→1)', '(1件)'].join(SEP.field));
});

test('関数の減少を検出する', () => {
  const after = T('src/a.test.js', 't1') + T('src/a.test.js', 't2') + C(A, 20, '1-10,15', '3:1,3:1,5:0', '1:1,8:0');
  assert.deepEqual(diffOf(base(), after), withOverride({ lostFunctions: 1 }));
  const r = compareInventories(parseInventory(base()), parseInventory(after));
  assert.equal(r.lostFunctions.join('|'), [A, '8(1→0)', '(1件)'].join(SEP.field));
});

test('製品ファイルの消失を検出する', () => {
  const after = T('src/a.test.js', 't1') + T('src/a.test.js', 't2');
  assert.deepEqual(diffOf(base(), after), withOverride({ lostFiles: 1 }));
});

test('製品ファイルの行数変化を検出する', () => {
  const after = T('src/a.test.js', 't1') + T('src/a.test.js', 't2') + C(A, 21, '1-10,15', '3:1,3:1,5:0', '1:1,8:1');
  assert.deepEqual(diffOf(base(), after), withOverride({ shape: 1 }));
});

test('分岐・関数の並び順が違うだけなら 0 件', () => {
  const after = T('src/a.test.js', 't2') + T('src/a.test.js', 't1') + C(A, 20, '15,1-10', '5:0,3:1,3:1', '8:1,1:1');
  assert.deepEqual(diffOf(base(), after), ZERO);
});

test('実行されていない分岐（:0）の記録が増減しても 0 件', () => {
  const after = T('src/a.test.js', 't1') + T('src/a.test.js', 't2') + C(A, 20, '1-10,15', '3:1,3:1,5:0,5:0,9:0', '1:1,8:1');
  assert.deepEqual(diffOf(base(), after), ZERO);
});

test('複数回のまとめ: 前は共通（片方にしか無い行は前に数えない）', () => {
  const r1 = parseInventory(T('src/a.test.js', 't') + C(A, 20, '1-10', '3:1', '1:1'));
  const r2 = parseInventory(T('src/a.test.js', 't') + C(A, 20, '1-5', '3:0', '1:1'));
  const merged = mergeRuns([r1, r2], MERGE_MODE.all);
  const f = merged.cov.get(A);
  assert.equal([...f.lines].sort((x, y) => x - y).join(SEP.list), '1,2,3,4,5');
  assert.equal(f.branches.get(3), 0);
  assert.equal(f.functions.get(1), 1);
  // 後の実行が 1-5 だけでも、前が共通（1-5）なら減少なし
  const after = parseInventory(T('src/a.test.js', 't') + C(A, 20, '1-5', '3:0', '1:1'));
  assert.equal(compareInventories(merged, mergeRuns([after], MERGE_MODE.any)).lostLines.length, 0);
});

test('複数回のまとめ: 後は和（どれかにあれば足りる）', () => {
  const before = parseInventory(T('src/a.test.js', 't') + C(A, 20, '1-10', '3:1', '1:1'));
  const a1 = parseInventory(T('src/a.test.js', 't') + C(A, 20, '1-5', '3:0', '1:1'));
  const a2 = parseInventory(T('src/a.test.js', 't') + C(A, 20, '6-10', '3:1', '1:1'));
  const r = compareInventories(before, mergeRuns([a1, a2], MERGE_MODE.any));
  assert.equal(r.lostLines.length + r.lostBranches.length + r.lostFunctions.length, 0);
  // 和にしなければ（a1 だけなら）減少として出る
  assert.equal(compareInventories(before, a1).lostLines.length, 1);
});

test('実行ごとに出入りするテストを検出する', () => {
  const r1 = parseInventory(T('src/a.test.js', 't1') + T('src/a.test.js', 't2'));
  const r2 = parseInventory(T('src/a.test.js', 't1'));
  const r = compareInventories(mergeRuns([r1, r2], MERGE_MODE.all), mergeRuns([r1], MERGE_MODE.any));
  assert.equal(r.unstableTests.length, 1);
});

test('製品でないファイルのカバレッジは比較に入らない', () => {
  const noise = [
    C('src/x.test.js', 5, '1-5'), C('src/xTestFixtures.js', 5, '1-5'), C('src/y.test.mjs', 5, '1-5'),
    C('scripts/z.mjs', 5, '1-5'), C('D:/abs/w.js', 5, '1-5'),
  ].join('');
  const p = parseInventory(T('src/a.test.js', 't') + C(A, 20, '1') + noise);
  assert.equal([...p.cov.keys()].join(SEP.list), A);
});

test('レポーターの往復: 出力を parseInventory で読み戻して件数・名前・行集合が一致する', async () => {
  const cwd = process.cwd();
  const file = path.join(cwd, 'src', 'rt.test.js');
  const names = ['plain', 'タブ\tと改行\nと"引用符"と日本語', 'dup', 'dup'];
  async function* events() {
    for (const name of names) yield { type: 'test:pass', data: { name, nesting: 1, file } };
    yield { type: 'test:pass', data: { name: 'suite 名', nesting: 0, file, details: { type: 'suite' } } };
    yield { type: 'test:fail', data: { name: 'ng', nesting: 0, file } };
    yield { type: 'test:pass', data: { name: 'sk', nesting: 0, file, skip: true } };
    yield { type: 'test:pass', data: { name: 'td', nesting: 0, file, todo: true } };
    yield {
      type: 'test:coverage',
      data: {
        summary: {
          workingDirectory: cwd,
          files: [{
            path: path.join(cwd, 'src', 'p.js'), totalLineCount: 30,
            lines: [1, 2, 3, 7, 8, 12].map(line => ({ line, count: 1 })).concat([{ line: 20, count: 0 }]),
            branches: [{ line: 4, count: 1 }, { line: 4, count: 0 }, { line: 9, count: 0 }],
            functions: [{ line: 1, count: 2 }, { line: 10, count: 0 }],
          }],
          totals: { coveredLineCount: 6, totalLineCount: 30, coveredBranchCount: 1, totalBranchCount: 3, coveredFunctionCount: 1, totalFunctionCount: 2 },
        },
      },
    };
    yield { type: 'test:summary', data: { file, counts: { passed: 1 }, success: true } };
    yield { type: 'test:summary', data: { counts: { passed: 7 }, success: true } };
  }
  let text = '';
  for await (const chunk of reporter(events())) text += chunk;

  const p = parseInventory(text);
  const rel = 'src/rt.test.js';
  const key = name => [rel, 1, JSON.stringify(name)].join(SEP.field);
  assert.equal(p.tests.get(key(names[0])), 1);
  assert.equal(p.tests.get(key(names[1])), 1);
  assert.equal(p.tests.get(key('dup')), 2);
  assert.equal(p.tests.size, 3 + 3);
  assert.equal(p.notPassed.length, 3);
  assert.equal(['fail', 'skip', 'todo'].every(s => p.notPassed.some(x => x.startsWith(s + SEP.field))), true);
  const f = p.cov.get('src/p.js');
  assert.equal(f.total, 30);
  assert.equal([...f.lines].sort((x, y) => x - y).join(SEP.list), '1,2,3,7,8,12');
  assert.equal(`${f.branches.get(4)}/${f.branches.get(9)}`, '1/0');
  assert.equal(`${f.functions.get(1)}/${f.functions.get(10)}`, '1/0');
  // S レコードは全体の集計だけ（ファイル単位の summary は出さない）
  assert.equal(text.split(SEP.record).filter(l => l.startsWith(RECORD.summary + SEP.field + SUMMARY_LABEL.summary)).length, 1);
});

test('失敗側: parseInventory は T が 0 件・未知の種別・列不足・数値でない行番号で throw する', () => {
  assert.throws(() => parseInventory(''), /テストの記録/);
  assert.throws(() => parseInventory(C(A, 20, '1-5') + S), /テストの記録/);
  assert.throws(() => parseInventory(T('f', 't') + 'X\tfoo\n'), /未知のレコード種別/);
  assert.throws(() => parseInventory('T\tf\t0\tpass\n'), /列数が足りない/);
  assert.throws(() => parseInventory(T('f', 't') + 'C\tsrc/a.js\t5\t1-5\n'), /列数が足りない/);
  assert.throws(() => parseInventory(T('f', 't') + C(A, 20, '1-x')), /数値でない/);
  assert.throws(() => parseInventory(T('f', 't') + C(A, 20, '1', 'x:1')), /数値でない/);
  assert.throws(() => parseInventory(T('f', 't') + C(A, 20, '1', '', '3:y')), /数値でない/);
  assert.throws(() => parseInventory(T('f', 't') + C(A, 'many', '1')), /数値でない/);
});

test('失敗側: mergeRuns は runs が空・未知の mode で throw する', () => {
  const r = parseInventory(base());
  assert.throws(() => mergeRuns([], MERGE_MODE.all), /空/);
  assert.throws(() => mergeRuns([r], 'union'), /未知の mode/);
  assert.throws(() => mergeRuns([r], undefined), /未知の mode/);
});

test('CLI: 終了コード（一致 0・差分あり 1・引数不足 2・読めないファイル 2）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'suite-inventory-'));
  try {
    const cli = fileURLToPath(new URL('./diff.mjs', import.meta.url));
    const write = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
    const same = write('same.tsv', base());
    const fewer = write('fewer.tsv', T('src/a.test.js', 't1') + C(A, 20, '1-10,15', '3:1,3:1,5:0', '1:1,8:1'));
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

    const same2 = write('same2.tsv', base());
    const same3 = write('same3.tsv', base());
    const ok = run(`${same},${same2}`, same3);
    assert.equal(ok.status, 0);
    assert.ok(ok.stdout.includes('OK 消えたテスト: 0'));
    const ng = run(same, fewer);
    assert.equal(ng.status, 1);
    assert.ok(ng.stdout.includes('NG 消えたテスト: 1'));
    const usage = run(same);
    assert.equal(usage.status, 2);
    assert.ok(usage.stderr.includes('使い方'));
    const missing = run(same, path.join(dir, 'none.tsv'));
    assert.equal(missing.status, 2);
    assert.ok(missing.stderr.includes('使い方'));
    const empty = run(same, write('empty.tsv', ''));
    assert.equal(empty.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: カバレッジ（C）の無い一覧は前・後・両方とも終了コード 2 で側の名前を出す', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'suite-inventory-'));
  try {
    const cli = fileURLToPath(new URL('./diff.mjs', import.meta.url));
    const write = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
    const withCov = write('with.tsv', base());
    const noCov = write('none.tsv', T('src/a.test.js', 't1') + S);
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

    const a = run(noCov, withCov);
    assert.equal(a.status, 2);
    assert.ok(a.stderr.includes('無い側: 前'));
    assert.ok(!a.stderr.includes('前,後'));
    const b = run(withCov, noCov);
    assert.equal(b.status, 2);
    assert.ok(b.stderr.includes('無い側: 後'));
    assert.ok(!b.stderr.includes('前,後'));
    const c = run(noCov, write('none2.tsv', T('src/a.test.js', 't1') + S));
    assert.equal(c.status, 2);
    assert.ok(c.stderr.includes('無い側: 前,後'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 前と後に同じ一覧を渡すと終了コード 2（後の和に前が混ざるのを防ぐ）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'suite-inventory-'));
  try {
    const cli = fileURLToPath(new URL('./diff.mjs', import.meta.url));
    const write = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
    const a = write('a.tsv', base());
    const b = write('b.tsv', base());
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    const both = run(a, a);
    assert.equal(both.status, 2);
    assert.ok(both.stderr.includes('同じ一覧'));
    const partial = run(a, `${a},${b}`);
    assert.equal(partial.status, 2);
    assert.ok(partial.stderr.includes('同じ一覧'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI は import されただけでは走らない（子プロセスで確かめる）', () => {
  const url = new URL('./diff.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('mergeRuns: 後の 2 回目だけ fail したテストも合格でないテストとして出る', () => {
  const b = parseInventory(base());
  const second = parseInventory(T('src/a.test.js', 't1', STATUS.fail) + T('src/a.test.js', 't2') + C(A, 20, '1-10,15', '3:1,3:1,5:0', '1:1,8:1'));
  const r = compareInventories(b, mergeRuns([b, second], MERGE_MODE.any));
  assert.equal(r.notPassed.length, 1);
  assert.ok(r.notPassed[0].startsWith(STATUS.fail + SEP.field));
  assert.ok(r.notPassed[0].includes('src/a.test.js'));
  assert.ok(r.notPassed[0].includes(JSON.stringify('t1')));
});

test('実行ごとに出入りするテスト: 後の回にだけあるテストも検出する（逆向き）', () => {
  const r1 = parseInventory(T('src/a.test.js', 't1'));
  const r2 = parseInventory(T('src/a.test.js', 't1') + T('src/a.test.js', 't2'));
  const r = compareInventories(mergeRuns([r1, r2], MERGE_MODE.all), mergeRuns([r1], MERGE_MODE.any));
  assert.equal(r.unstableTests.length, 1);
  assert.equal(r.unstableTests[0], ['src/a.test.js', '0', JSON.stringify('t2')].join(SEP.field));
});

test('mergeRuns: 片方の回にしか無い製品ファイルは共通から落ち、和には入る', () => {
  const r1 = parseInventory(T('src/a.test.js', 't') + C('src/a.js', 5, '1') + C('src/b.js', 5, '1'));
  const r2 = parseInventory(T('src/a.test.js', 't') + C('src/a.js', 5, '1') + C('src/c.js', 5, '1'));
  const names = m => [...m.cov.keys()].sort().join(SEP.list);
  assert.equal(names(mergeRuns([r1, r2], MERGE_MODE.all)), 'src/a.js');
  assert.equal(names(mergeRuns([r1, r2], MERGE_MODE.any)), 'src/a.js,src/b.js,src/c.js');
});
