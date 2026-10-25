// elevGoldenGate.mjs（展開図の視覚回帰ゲート）の純粋部分と CLI の用法エラーの固定。
// 実データ .stq には依存しない（使い捨ての elevfig-*.json だけを使う）。
// CLI の用法エラー系は diffElevGolden.cli.test.mjs と同じく子プロセスで起動する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OUT_MARK, TARGETS, UsageError, compareDirs, formatRow, isAllOk, labelOf, parseArgs, parseTestSummary,
  prepareOutDir, runTarget, selectTargets,
} from './elevGoldenGate.mjs';

const CLI = path.join(import.meta.dirname, 'elevGoldenGate.mjs');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgate-'));
  for (const [name, rows] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(rows));
  return dir;
}
const row = (prims, room = 'r1') => ({ room, name: room, kind: 'room', count: prims.length, prims });
const line = (x2) => ({ type: 'line', x1: 0, y1: 0, x2, y2: 0, weight: 'medium' });

test('対象表: 22 枚・dir が重複せず golden ディレクトリが実在・ラベルが衝突しない', () => {
  assert.equal(TARGETS.length, 22);
  assert.equal(new Set(TARGETS.map(t => t.dir)).size, TARGETS.length);
  assert.equal(new Set(TARGETS.map(labelOf)).size, TARGETS.length);
  for (const t of TARGETS) {
    const dir = path.join(import.meta.dirname, t.dir);
    assert.ok(fs.existsSync(dir), `golden ディレクトリがありません: ${t.dir}`);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('elevfig-')), `elevfig が無い: ${t.dir}`);
    for (const f of t.flags) assert.ok(['--regen', '--struct'].includes(f), `未知のフラグ: ${f}`);
    if (t.flags.includes('--struct')) assert.ok(t.flags.includes('--regen'), '--struct は --regen と併用');
  }
});

test('引数解析: 既定値と全オプション', () => {
  const d = parseArgs([]);
  assert.equal(d.jobs, 2);
  assert.equal(d.test, false);
  assert.equal(d.base, null);
  const o = parseArgs(['--out', 'x', '--base', 'y', '--only', 'moku', '--jobs', '3', '--test']);
  assert.equal(o.out, path.resolve('x'));
  assert.equal(o.base, path.resolve('y'));
  assert.equal(o.only, 'moku');
  assert.equal(o.jobs, 3);
  assert.equal(o.test, true);
});

test('【失敗系】引数解析: 不正な --jobs・値の欠落・不明な引数・--base=--out は UsageError', () => {
  for (const bad of ['0', '4', 'abc', '1.5']) {
    assert.throws(() => parseArgs(['--jobs', bad]), UsageError, `--jobs ${bad}`);
  }
  assert.throws(() => parseArgs(['--jobs']), UsageError);
  assert.throws(() => parseArgs(['--base']), UsageError);
  assert.throws(() => parseArgs(['--out', '--test']), UsageError);
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--base', 'z', '--out', 'z']), UsageError);
});

test('対象の絞り込み: 部分文字列で絞れ、一致なしは UsageError', () => {
  assert.equal(selectTargets(null).length, 22);
  assert.equal(selectTargets('stairports').length, 7);
  assert.throws(() => selectTargets('__none__'), UsageError);
});

test('compareDirs: 自己一致は ok・帯数を数える', () => {
  const dir = makeDir({ 'elevfig-1階.json': [row([line(10)], 'a'), row([line(20)], 'b')] });
  const r = compareDirs(dir, dir);
  assert.equal(r.ok, true);
  assert.equal(r.bands, 2);
  assert.equal(r.changed, 0);
});

test('compareDirs: 追加・削除・線種変更を帯単位で数える', () => {
  const g = makeDir({ 'elevfig-1階.json': [row([line(10), line(11)], 'a'), row([line(20)], 'b')] });
  const n = makeDir({ 'elevfig-1階.json': [
    row([line(10), { ...line(12) }], 'a'),
    row([{ ...line(20), weight: 'thin' }], 'b'),
  ] });
  const r = compareDirs(g, n);
  assert.equal(r.ok, false);
  assert.equal(r.bands, 2);
  assert.equal(r.changed, 2);
  assert.equal(r.add, 1);
  assert.equal(r.rem, 1);
  assert.equal(r.chg, 1);
});

test('【失敗系】compareDirs: 新側に無いファイル・golden 側に無い elevfig は差分扱い', () => {
  const g = makeDir({ 'elevfig-1階.json': [row([line(10)])], 'elevfig-2階.json': [row([line(10)])] });
  const n = makeDir({ 'elevfig-1階.json': [row([line(10)])], 'elevfig-3階.json': [row([line(10), line(11)])] });
  const r = compareDirs(g, n);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingFiles, ['elevfig-2階.json']);
  assert.deepEqual(r.extraFiles, ['elevfig-3階.json']);
  assert.equal(r.rem, 1);
  assert.equal(r.add, 2);
  assert.equal(r.changed, 2);
});

test('【失敗系】compareDirs: 基準に無い部屋・壊れた JSON を黙って一致にしない', () => {
  const g = makeDir({ 'elevfig-1階.json': [row([line(10)], 'a'), row([line(10)], 'b')] });
  const n = makeDir({ 'elevfig-1階.json': [row([line(10)], 'a')] });
  const r = compareDirs(g, n);
  assert.equal(r.ok, false);
  assert.equal(r.changed, 1);
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgate-'));
  fs.writeFileSync(path.join(broken, 'elevfig-1階.json'), '{ not json');
  assert.throws(() => compareDirs(g, broken), /JSON/);
});

test('【失敗系】compareDirs: 新側にだけある部屋は差分', () => {
  const g = makeDir({ 'elevfig-1階.json': [row([line(10)], 'a')] });
  const n = makeDir({ 'elevfig-1階.json': [row([line(10)], 'a'), row([line(1), line(2), line(3)], 'b')] });
  const r = compareDirs(g, n);
  assert.equal(r.ok, false);
  assert.equal(r.changed, 1);
  assert.equal(r.add, 3);
  assert.equal(r.rem, 0);
});

test('【失敗系】出力先の安全確認: golden・probe 直下・大小違いの --base/--out・ファイルは UsageError', () => {
  const PROBE = import.meta.dirname;
  assert.throws(() => parseArgs(['--out', PROBE]), UsageError);
  assert.throws(() => parseArgs(['--out', path.join(PROBE, 'golden13')]), UsageError);
  assert.throws(() => parseArgs(['--out', path.join(PROBE, 'golden13', 'sub')]), UsageError);
  const tmp = path.join(os.tmpdir(), '__elevgate_case__');
  assert.throws(() => parseArgs(['--base', path.join(tmp, 'A'), '--out', path.join(tmp, 'a')]), UsageError);
  assert.throws(() => parseArgs(['--base', path.join(tmp, 'A'), '--out', path.join(tmp, 'a', 'x')]), UsageError);
  const file = path.join(makeDir({}), 'f.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => parseArgs(['--out', file]), UsageError);
  // 正常系: 無関係な一時ディレクトリは通る
  assert.doesNotThrow(() => parseArgs(['--out', path.join(tmp, 'ok')]));
});

test('【失敗系】prepareOutDir: 印の無い空でない既存ディレクトリは消さず UsageError／印があれば作り直す', () => {
  const dir = makeDir({ 'keep.txt': 'x' });
  assert.throws(() => prepareOutDir(dir), UsageError);
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), '消してはいけない');
  const fresh = path.join(dir, 'new');
  prepareOutDir(fresh);
  assert.ok(fs.existsSync(path.join(fresh, OUT_MARK)));
  fs.writeFileSync(path.join(fresh, 'old.json'), '[]');
  prepareOutDir(fresh);
  assert.deepEqual(fs.readdirSync(fresh), [OUT_MARK]);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgate-'));
  prepareOutDir(empty);
  assert.ok(fs.existsSync(path.join(empty, OUT_MARK)));
});

test('【失敗系】runTarget: .stq が無い・dump が非 0 終了は error（ERR 行）で、全体は不一致扱い', async () => {
  const target = { dir: 'golden-knee', stq: 'knee-drop-test', flags: [] };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgate-'));
  const opts = { out, base: null };
  const noStq = await runTarget(target, opts, { stqDir: path.join(os.tmpdir(), '__no_such_stq_dir__') });
  assert.match(noStq.error, /\.stq がありません/);

  const stqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgate-'));
  fs.writeFileSync(path.join(stqDir, 'knee-drop-test.stq'), '');
  const failing = path.join(stqDir, 'fail.mjs');
  fs.writeFileSync(failing, 'process.exit(3);\n');
  const bad = await runTarget(target, opts, { stqDir, dumpScript: failing });
  assert.match(bad.error, /dump 失敗\(exit 3\)/);

  assert.match(formatRow('golden-knee', bad), /ERR /);
  assert.equal(isAllOk([noStq, bad]), false);
  assert.equal(isAllOk([{ cmp: { ok: true } }]), true);
  assert.equal(isAllOk([{ cmp: { ok: true } }, bad]), false);
});

test('compareDirs: elevfig-summary.json は比較対象外', () => {
  const g = makeDir({ 'elevfig-1階.json': [row([line(10)])], 'elevfig-summary.json': { a: 1 } });
  const n = makeDir({ 'elevfig-1階.json': [row([line(10)])], 'elevfig-summary.json': { a: 2 } });
  assert.equal(compareDirs(g, n).ok, true);
});

test('formatRow: 一致・差あり・ERR の表示', () => {
  const ok = { cmp: { ok: true, bands: 3, changed: 0, add: 0, rem: 0, chg: 0, missingFiles: [], extraFiles: [] }, sec: 1.25 };
  assert.match(formatRow('golden', ok), /一致.*3帯中 *差 *0帯 \+0 -0 ~0 .*1\.3s/);
  const ng = { cmp: { ok: false, bands: 3, changed: 1, add: 2, rem: 1, chg: 0, missingFiles: ['a'], extraFiles: [] }, sec: 0 };
  assert.match(formatRow('golden', ng), /差あり.*\+2 -1 ~0 ファイル欠1\/余0/);
  assert.match(formatRow('golden', { error: '.stq がありません', sec: 0 }), /ERR .*\.stq がありません/);
});

test('parseTestSummary: node:test のサマリから合格・失敗数を拾う（拾えなければ null）', () => {
  assert.deepEqual(parseTestSummary('ℹ tests 10\nℹ pass 9\nℹ fail 1\n'), { pass: 9, fail: 1 });
  assert.deepEqual(parseTestSummary('# pass 5\n# fail 0\n'), { pass: 5, fail: 0 });
  assert.deepEqual(parseTestSummary('なし'), { pass: null, fail: null });
});

test('【失敗系】CLI: 不正な --jobs は日本語エラー・exit 2（スタックトレースなし）', () => {
  const r = run(['--jobs', '9']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--jobs/);
  assert.doesNotMatch(r.stderr, /node:internal|at main/);
});

test('【失敗系】CLI: 存在しない --base は exit 2', () => {
  const r = run(['--base', path.join(os.tmpdir(), '__no_such_gate_base__'), '--only', 'golden-knee']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--base が見つかりません/);
});

test('【失敗系】CLI: 一致する対象が無い --only は exit 2', () => {
  const r = run(['--only', '__none__']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /一致する対象がありません/);
});
