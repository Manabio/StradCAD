// diffElevGolden.mjs（CLI）の引数検証・終了コードの統合テスト。
// スクリプト自体を子プロセスとして起動する——トップレベルでprocess.exit()するスクリプトを
// そのままimportするとテストランナーごと終了してしまうため（node:testの既定ダイアレクト内で
// できる範囲の安全策）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(import.meta.dirname, 'diffElevGolden.mjs');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// 最小限のelevfig-*.json一式を持つ使い捨てディレクトリ（実データ golden13 に依存しない）。
function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgolden-'));
  const rows = [{ room: 'r1', name: 'A', kind: 'room', count: 1,
    prims: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }] }];
  fs.writeFileSync(path.join(dir, 'elevfig-1階.json'), JSON.stringify(rows));
  return dir;
}

test('CLI: goldenDir/newDirが同一（自己一致）なら「一致」でexit 0', () => {
  const dir = makeFixtureDir();
  const r = run([dir, dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /一致/);
});

test('【失敗系】CLI: --topに数値以外を渡すと用法エラーでexit 2（具体例が黙って消えない）', () => {
  const dir = makeFixtureDir();
  const r = run([dir, dir, '--top', 'abc']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--top/);
});

test('【失敗系】CLI: --topに0や負数を渡すと用法エラーでexit 2', () => {
  const dir = makeFixtureDir();
  const r = run([dir, dir, '--top', '0']);
  assert.equal(r.code, 2);
});

test('【失敗系】CLI: 存在しないgoldenDirを渡すと生スタックでなく日本語1行エラー・exit 2になる（差分ありexit1と区別する）', () => {
  const dir = makeFixtureDir();
  const missing = path.join(dir, '__no_such_dir__');
  const r = run([missing, dir]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /見つかりません/);
  assert.doesNotMatch(r.stderr, /at main|node:internal/, 'スタックトレースではなく用法エラー文であること');
});

test('【失敗系】CLI: --jsonに値を渡さない（末尾で終わる）と用法エラーでexit 2', () => {
  const dir = makeFixtureDir();
  const r = run([dir, dir, '--json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--json/);
});

test('【失敗系】CLI: ゴールデンJSONが壊れていると生スタックでなく用法エラー・exit 2になる（差分ありexit1と区別する）', () => {
  const dir = makeFixtureDir();
  fs.writeFileSync(path.join(dir, 'elevfig-2階.json'), '{ not valid json');
  const r = run([dir, dir]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /elevfig-2階\.json/);
  assert.match(r.stderr, /JSON/);
  assert.doesNotMatch(r.stderr, /at loadRows|node:internal|SyntaxError:/, 'スタックトレースではなく用法エラー文であること');
});

test('CLI: 分割合併のみの差分は「一致」の一言でも合併件数が出る', () => {
  const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgolden-g-'));
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevgolden-n-'));
  const goldenRows = [{ room: 'r1', name: 'A', kind: 'room', count: 1,
    prims: [{ type: 'line', x1: 100, y1: -2400, x2: 100, y2: 2900, weight: 'medium' }] }];
  const newRows = [{ room: 'r1', name: 'A', kind: 'room', count: 2,
    prims: [
      { type: 'line', x1: 100, y1: -2400, x2: 100, y2: 0, weight: 'medium' },
      { type: 'line', x1: 100, y1: 0, x2: 100, y2: 2900, weight: 'medium' },
    ] }];
  fs.writeFileSync(path.join(goldenDir, 'elevfig-1階.json'), JSON.stringify(goldenRows));
  fs.writeFileSync(path.join(newDir, 'elevfig-1階.json'), JSON.stringify(newRows));

  const r = run([goldenDir, newDir, '--merge']);
  assert.equal(r.code, 0, '見た目は変わらないので一致扱い（exit 0）');
  assert.match(r.stdout, /一致/);
  assert.match(r.stdout, /分割合併/, '分割合併が起きたこと自体は一致の一言に埋もれず出る');
});
