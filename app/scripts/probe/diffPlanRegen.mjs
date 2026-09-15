// 壁再生成の「保存済み(golden) vs 再生成後(golden-regen)」を比較する（diffElevGolden.mjsと
// 同じ位置づけ）。dumpPlan.mjs / dumpPlanRegen.mjs が出力する plan-<階>.json を対象に、
// regenerateWalls のたびに変わるUUID（key・wallId・ids）を落とし、(kind, vertical, at, lo, hi)
// の多重集合で階ごとの一致件数・mismatch件数を数える。
//
// 使い方: node scripts/probe/diffPlanRegen.mjs <dirA> <dirB> [--json <out.json>]
//   dirA/dirB は dumpPlan.mjs（scripts/probe/golden/）・dumpPlanRegen.mjs（golden-regen/<doc>/）の
//   出力ディレクトリ。plan-standard-*.json・plan-summary.json・defects-*.json 等は対象外
//   （plan-<階名>.json のみ比較する）。
// 終了コード: mismatchあり=1、完全一致=0、引数・入力エラー（用法違反）=2。
import fs from 'node:fs';
import path from 'node:path';

const USAGE = '用法: diffPlanRegen.mjs <dirA> <dirB> [--json <out.json>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const opts = { json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--json にはファイルパスを指定してください');
      opts.json = v;
      continue;
    }
    positional.push(a);
  }
  if (positional.length < 2) throw new UsageError('dirA/dirBの指定が不足しています');
  return { dirA: positional[0], dirB: positional[1], opts };
}

function ensureDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new UsageError(`${label}が見つかりません: ${dir}`);
  }
}

// plan-<階名>.json だけを対象にする（plan-standard-*.json・plan-summary.json・defects-*.json等は除外）。
function listPlanFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('plan-') && f.endsWith('.json') && f !== 'plan-summary.json' && !f.startsWith('plan-standard-'))
    .sort();
}

function loadSegs(dir, file) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`${file}を読めません（JSONが壊れています）: ${dir}`);
  }
}

// key・wallId・ids（regenerateWallsのたびに変わるUUID）だけを落とし、幾何＋depth/styleで正規化する。
function normSeg(s) {
  return `${s.kind}|${s.vertical}|${s.at}|${s.lo}|${s.hi}|${s.depth ?? ''}|${s.style ?? ''}`;
}

function countMap(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function main() {
  const { dirA, dirB, opts } = parseArgs(process.argv.slice(2));
  ensureDir(dirA, 'dirA');
  ensureDir(dirB, 'dirB');

  const filesA = listPlanFiles(dirA);
  const filesB = listPlanFiles(dirB);
  const fileSet = new Set([...filesA, ...filesB]);

  const report = { files: [] };
  let hasMismatch = false;

  for (const file of [...fileSet].sort()) {
    const inA = filesA.includes(file);
    const inB = filesB.includes(file);
    if (!inA || !inB) {
      hasMismatch = true;
      report.files.push({ file, onlyInA: !inB, onlyInB: !inA });
      continue;
    }

    const segsA = loadSegs(dirA, file).map(normSeg);
    const segsB = loadSegs(dirB, file).map(normSeg);
    const mapA = countMap(segsA);
    const mapB = countMap(segsB);
    let onlyInA = 0, onlyInB = 0;
    for (const k of new Set([...mapA.keys(), ...mapB.keys()])) {
      const ca = mapA.get(k) ?? 0, cb = mapB.get(k) ?? 0;
      if (ca > cb) onlyInA += ca - cb;
      if (cb > ca) onlyInB += cb - ca;
    }
    const mismatch = onlyInA + onlyInB;
    if (mismatch > 0) hasMismatch = true;
    report.files.push({ file, countA: segsA.length, countB: segsB.length, onlyInA, onlyInB, mismatch });
  }

  for (const f of report.files) {
    if (f.countA === undefined) {
      console.log(`== ${f.file} == ${f.onlyInA ? 'dirAのみに存在' : 'dirBのみに存在'}`);
      continue;
    }
    console.log(`== ${f.file} == countA:${f.countA} countB:${f.countB} mismatch:${f.mismatch}（onlyInA:${f.onlyInA} onlyInB:${f.onlyInB}）`);
  }
  console.log(hasMismatch ? 'MISMATCH' : '一致');

  if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 1));
  }

  process.exit(hasMismatch ? 1 : 0);
}

try {
  main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  throw e;
}
