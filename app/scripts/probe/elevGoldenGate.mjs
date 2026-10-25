// 展開図の視覚回帰ゲート（S0）。全展開図 golden を現在のツリーで dumpElevFigure.mjs へ採り直して突き合わせ、
// 1 行 1 golden の表と総合判定を出す。展開図描画のリファクタの前後で回す。
//
// 使い方（cwd=app）:
//   node scripts/probe/elevGoldenGate.mjs [--out <dir>] [--base <dir>] [--only <部分文字列>] [--jobs N] [--test]
//   --out   ダンプ先（既定 scripts/probe/.gate-out/。.gitignore の scripts/probe/*/ に落ちる）
//   --base  golden ではなく、以前このランナーで採った --out ディレクトリと比べる
//           （HEAD で golden と一致しない golden があっても「前後で一致」を言うため。不変ステップはこれで前後比較）
//   --only  対象（golden ディレクトリ名）の部分文字列で絞る
//   --jobs  子プロセスの並列数（1〜3。既定 2。メモリ制約）
//   --test  最後に npm test も走らせ、合格数・失敗数を足す
// 終了コード: 全一致=0、差分・ダンプ失敗・テスト失敗あり=1、用法違反=2。
//
// 比較は elevGoldenDiff.mjs の diffRoomPrimitives を再利用する（diffElevGolden.mjs と同じ部屋の突き合わせ:
// room id→name。--merge 無し＝最も厳しい比較）。
// 純関数は export してあり、CLI 本体は直接実行されたときだけ動く（node:test から import できる）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { diffRoomPrimitives } from './elevGoldenDiff.mjs';

const PROBE_DIR = import.meta.dirname;
const APP_DIR = path.resolve(PROBE_DIR, '..', '..');
const STQ_DIR = 'D:/tatsuya/Download';
const DEFAULT_OUT = path.join(PROBE_DIR, '.gate-out');
const MAX_JOBS = 3;

const USAGE = '用法: elevGoldenGate.mjs [--out <dir>] [--base <dir>] [--only <部分文字列>] [--jobs N(1-3)] [--test]';

export class UsageError extends Error {}

const REGEN = ['--regen'];
const STRUCT = ['--regen', '--struct'];
const ceiling = (n) => ({ dir: `golden-elev-ceiling/${n}`, stq: n, flags: REGEN });
const ports = (i) => ({ dir: `golden-elev-stairports/stair-ports-test${i}`, stq: `stair-ports-test${i}`, flags: REGEN });

/** 対象表: golden ディレクトリ（probe 直下からの相対）→ 元 .stq（STQ_DIR 直下の名前）→ dumpElevFigure.mjs のフラグ。 */
export const TARGETS = [
  { dir: 'golden', stq: '11', flags: [] },
  { dir: 'golden11', stq: '11', flags: [] },
  { dir: 'golden13', stq: '13', flags: [] },
  { dir: 'golden13-struct', stq: '13', flags: STRUCT },
  { dir: 'golden-knee', stq: 'knee-drop-test', flags: [] },
  { dir: 'golden-elev-moku16', stq: 'moku1-6', flags: REGEN },
  ...['ceiling-steel-stair-test', 'ceiling-wood-stair-test', 'ceiling-zone-far-test',
    'ceiling-zone-slope-far-test', 'ceiling-zone-test', 'moku4-3'].map(ceiling),
  ...[1, 2, 3, 4, 5, 6, 7].map(ports),
];

/** 出力・基準ディレクトリ内の、対象ごとのサブディレクトリ名。 */
export const labelOf = (target) => target.dir.replace(/\//g, '_');

export function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, base: null, only: null, jobs: 2, test: false };
  const value = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} には値を指定してください`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test') opts.test = true;
    else if (a === '--out') opts.out = path.resolve(value(++i, '--out'));
    else if (a === '--base') opts.base = path.resolve(value(++i, '--base'));
    else if (a === '--only') opts.only = value(++i, '--only');
    else if (a === '--jobs') {
      const v = value(++i, '--jobs');
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_JOBS) {
        throw new UsageError(`--jobs には 1〜${MAX_JOBS} の整数を指定してください（指定値: ${v}）`);
      }
      opts.jobs = n;
    } else throw new UsageError(`不明な引数: ${a}`);
  }
  validatePaths(opts);
  return opts;
}

/** 存在する最も近い祖先を realpath してから残りを結合（存在しないパスも正規化できる）。大文字小文字は比較側で無視。 */
export function canonPath(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** 同じ、または一方が他方の中（Windows 前提で大文字小文字を無視）。 */
export function overlaps(a, b) {
  const x = canonPath(a).toLowerCase();
  const y = canonPath(b).toLowerCase();
  const inside = (c, p) => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  return inside(x, y) || inside(y, x);
}

/** 消してはならない基準: 全対象の golden ディレクトリと、probe 直下の golden* ディレクトリ。 */
export function protectedDirs(probeDir = PROBE_DIR, targets = TARGETS) {
  const set = new Set(targets.map(t => path.join(probeDir, t.dir)));
  for (const e of fs.readdirSync(probeDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith('golden')) set.add(path.join(probeDir, e.name));
  }
  return [...set];
}

/** --out / --base の安全確認。出力先の削除が golden や基準に及ぶ指定は UsageError。 */
export function validatePaths(opts, probeDir = PROBE_DIR, targets = TARGETS) {
  if (fs.existsSync(opts.out) && !fs.statSync(opts.out).isDirectory()) {
    throw new UsageError(`--out にファイルは指定できません: ${opts.out}`);
  }
  if (opts.base && overlaps(opts.base, opts.out)) {
    throw new UsageError('--base と --out に同じ（または親子の）ディレクトリは指定できません');
  }
  const prot = protectedDirs(probeDir, targets);
  for (const t of targets) {
    const outDir = path.join(opts.out, labelOf(t));
    const hit = prot.find(p => overlaps(p, outDir));
    if (hit) throw new UsageError(`--out の出力先 ${outDir} が golden/基準 ${hit} と重なります。別のディレクトリを指定してください`);
  }
}

export const OUT_MARK = '.elev-gate-out';

/** 出力サブディレクトリを空にして印を置く。印の無い空でない既存ディレクトリは消さず UsageError。 */
export function prepareOutDir(outDir) {
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) throw new UsageError(`出力先がファイルです: ${outDir}`);
    if (fs.readdirSync(outDir).length > 0 && !fs.existsSync(path.join(outDir, OUT_MARK))) {
      throw new UsageError(`出力先 ${outDir} は空でなく、このゲートが作った印（${OUT_MARK}）がないため消しません`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, OUT_MARK), '');
}

/** 全結果が一致（エラー・差分なし）か。 */
export const isAllOk = (results) => results.every(r => !r.error && r.cmp?.ok);

export function selectTargets(only, targets = TARGETS) {
  if (only == null) return targets;
  const sel = targets.filter(t => t.dir.includes(only));
  if (sel.length === 0) throw new UsageError(`--only "${only}" に一致する対象がありません`);
  return sel;
}

export function listElevfigFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('elevfig-') && f.endsWith('.json') && f !== 'elevfig-summary.json')
    .sort();
}

const readRows = (dir, file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    throw new Error(`${file} を読めません（JSON が壊れています）: ${dir}`);
  }
};

/**
 * 基準ディレクトリと新ディレクトリを比べる（帯＝elevfig の 1 行＝部屋 1 件）。
 * @returns {{bands:number, changed:number, add:number, rem:number, chg:number,
 *   missingFiles:string[], extraFiles:string[], ok:boolean}}
 *   bands=基準側の帯数 / changed=差のある帯数（基準に無い帯・新側だけの帯も含む）/
 *   add・rem・chg=追加・削除・線種変更のプリミティブ数 / missingFiles=新側に無い基準のファイル /
 *   extraFiles=基準側に無い新側のファイル（golden に無い elevfig は差分扱い）
 */
export function compareDirs(baseDir, newDir) {
  const baseFiles = listElevfigFiles(baseDir);
  const newFiles = listElevfigFiles(newDir);
  const r = { bands: 0, changed: 0, add: 0, rem: 0, chg: 0, missingFiles: [], extraFiles: [], ok: true };
  const primCount = (row) => (row.prims ?? []).length;
  for (const f of baseFiles) {
    const baseRows = readRows(baseDir, f);
    r.bands += baseRows.length;
    if (!newFiles.includes(f)) {
      r.missingFiles.push(f);
      r.changed += baseRows.length;
      for (const row of baseRows) r.rem += primCount(row);
      continue;
    }
    const newRows = readRows(newDir, f);
    const byId = new Map(newRows.map(x => [x.room, x]));
    const byName = new Map(newRows.map(x => [x.name, x]));
    const matched = new Set();
    for (const g of baseRows) {
      const n = byId.get(g.room) ?? byName.get(g.name) ?? null;
      if (!n) { r.changed++; r.rem += primCount(g); continue; }
      matched.add(n.room);
      if (g.error || n.error) {
        if (g.error !== n.error) r.changed++;
        continue;
      }
      const { added, removed, changed } = diffRoomPrimitives(g.prims ?? [], n.prims ?? []);
      if (added.length || removed.length || changed.length) r.changed++;
      r.add += added.length; r.rem += removed.length; r.chg += changed.length;
    }
    for (const n of newRows) {
      if (matched.has(n.room)) continue;
      r.changed++; r.add += primCount(n);
    }
  }
  for (const f of newFiles) {
    if (baseFiles.includes(f)) continue;
    r.extraFiles.push(f);
    const rows = readRows(newDir, f);
    r.changed += rows.length;
    for (const row of rows) r.add += primCount(row);
  }
  r.ok = r.changed === 0 && r.missingFiles.length === 0 && r.extraFiles.length === 0;
  return r;
}

/** 1 対象 1 行の表示。 */
export function formatRow(label, res) {
  const head = label.padEnd(52);
  if (res.error) return `${head} ERR   ${res.error}`;
  const c = res.cmp;
  const files = (c.missingFiles.length || c.extraFiles.length)
    ? ` ファイル欠${c.missingFiles.length}/余${c.extraFiles.length}` : '';
  const status = c.ok ? '一致' : '差あり';
  return `${head} ${status.padEnd(4)} ${String(c.bands).padStart(3)}帯中 差${String(c.changed).padStart(3)}帯 `
    + `+${c.add} -${c.rem} ~${c.chg}${files}  ${res.sec.toFixed(1)}s`;
}

/** npm test の出力（node:test の TAP/spec サマリ）から合格数・失敗数を拾う。 */
export function parseTestSummary(text) {
  const num = (name) => {
    const m = text.match(new RegExp(`^\\s*[#ℹ]\\s*${name}\\s+(\\d+)`, 'mu'));
    return m ? Number(m[1]) : null;
  };
  return { pass: num('pass'), fail: num('fail') };
}

function runChild(cmd, args, options) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { ...options, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: -1, out, err: String(e), sec: (Date.now() - t0) / 1000 }));
    child.on('close', code => resolve({ code, out, err, sec: (Date.now() - t0) / 1000 }));
  });
}

const DUMP_SCRIPT = path.join(PROBE_DIR, 'dumpElevFigure.mjs');

/** 出力サブディレクトリは呼び出し側が prepareOutDir 済みであること（ここでは消さない）。 */
export async function runTarget(target, opts, { stqDir = STQ_DIR, dumpScript = DUMP_SCRIPT } = {}) {
  const label = labelOf(target);
  const stq = `${stqDir}/${target.stq}.stq`;
  if (!fs.existsSync(stq)) return { error: `.stq がありません: ${stq}`, sec: 0 };
  const refDir = opts.base ? path.join(opts.base, label) : path.join(PROBE_DIR, target.dir);
  if (!fs.existsSync(refDir)) return { error: `基準ディレクトリがありません: ${refDir}`, sec: 0 };
  const outDir = path.join(opts.out, label);
  const r = await runChild(process.execPath,
    ['--import', './scripts/testSetup.mjs', dumpScript, outDir, stq, ...target.flags],
    { cwd: APP_DIR });
  if (r.code !== 0) return { error: `dump 失敗(exit ${r.code}): ${r.err.slice(-160).replace(/\s+/g, ' ')}`, sec: r.sec };
  try {
    return { cmp: compareDirs(refDir, outDir), sec: r.sec };
  } catch (e) {
    return { error: e.message, sec: r.sec };
  }
}

async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.base && !(fs.existsSync(opts.base) && fs.statSync(opts.base).isDirectory())) {
    throw new UsageError(`--base が見つかりません: ${opts.base}`);
  }
  const targets = selectTargets(opts.only);
  fs.mkdirSync(opts.out, { recursive: true });
  for (const t of targets) prepareOutDir(path.join(opts.out, labelOf(t)));
  console.log(`基準: ${opts.base ?? 'golden（scripts/probe/<dir>）'}  出力: ${opts.out}  並列: ${opts.jobs}`);
  const results = await pool(targets, opts.jobs, t => runTarget(t, opts));
  let allOk = isAllOk(results);
  let totalSec = 0;
  targets.forEach((t, i) => {
    console.log(formatRow(t.dir, results[i]));
    totalSec += results[i].sec;
  });
  console.log(`対象 ${targets.length} 枚 / 一致 ${results.filter(r => r.cmp?.ok).length} / ダンプ所要合計 ${totalSec.toFixed(1)}s`);

  if (opts.test) {
    // Windows では npm が .cmd のため shell 経由。引数を渡さず 1 本の文字列にして DEP0190 を避ける。
    const r = await runChild('npm test', [], { cwd: APP_DIR, shell: true });
    const { pass, fail } = parseTestSummary(r.out + r.err);
    const testOk = r.code === 0 && fail === 0;
    console.log(`npm test: 合格 ${pass ?? '?'} / 失敗 ${fail ?? '?'} (exit ${r.code}) ${r.sec.toFixed(1)}s`);
    if (!testOk) allOk = false;
  }
  console.log(allOk ? '総合: 全一致' : '総合: 差分またはエラーあり');
  process.exit(allOk ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    if (e instanceof UsageError) {
      console.error(e.message);
      console.error(USAGE);
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  });
}
