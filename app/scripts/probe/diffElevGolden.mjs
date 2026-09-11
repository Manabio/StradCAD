// ゴールデン（旧設計の展開図出力。dumpElevFigure.mjsの出力ディレクトリ）と、
// 新設計の出力（同じくdumpElevFigure.mjs互換の形式でダンプしたディレクトリ）を比較する。
// 階（elevfig-*.jsonファイル）×部屋ごとに、プリミティブの追加／削除／変更／分割合併を数える。
//
// 使い方:
//   node scripts/probe/diffElevGolden.mjs <goldenDir> <newDir> [--merge] [--json <out.json>] [--top N]
//   --merge  同一直線上・同一線種の線分群を合併してから比較する（層境界での分割は「分割合併」に分類）
//   --json   機械可読な結果を指定パスへ書き出す
//   --top    差分の具体例を各カテゴリ何件まで表示するか（既定5。正の整数のみ）
//
// 終了コード: 差分あり=1、完全一致=0、引数・入力エラー（用法違反）=2。
import fs from 'node:fs';
import path from 'node:path';
import { diffRoomPrimitives } from './elevGoldenDiff.mjs';

const USAGE = '用法: diffElevGolden.mjs <goldenDir> <newDir> [--merge] [--json <out.json>] [--top N]';

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const opts = { merge: false, json: null, top: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--merge') { opts.merge = true; continue; }
    if (a === '--json') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--json にはファイルパスを指定してください');
      opts.json = v;
      continue;
    }
    if (a === '--top') {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n <= 0) {
        throw new UsageError(`--top には正の整数を指定してください（指定値: ${v}）`);
      }
      opts.top = n;
      continue;
    }
    positional.push(a);
  }
  if (positional.length < 2) throw new UsageError('goldenDir/newDirの指定が不足しています');
  return { goldenDir: positional[0], newDir: positional[1], opts };
}

function ensureDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new UsageError(`${label}が見つかりません: ${dir}`);
  }
}

function listElevfigFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('elevfig-') && f.endsWith('.json') && f !== 'elevfig-summary.json')
    .sort();
}

function loadRows(dir, file) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`${file}を読めません（JSONが壊れています）: ${dir}`);
  }
}

function fmtLine(p) {
  if (p.type === 'line') {
    const dash = p.dash ? ` dash:${p.dash}${p.dashAnchor != null ? `(${p.dashAnchor})` : ''}` : '';
    return `${p.x1},${p.y1}→${p.x2},${p.y2} ${p.weight ?? '(既定)'}${dash}`;
  }
  if (p.type === 'polyline') return `polyline[${p.points.map(([x, y]) => `${x},${y}`).join(' ')}] ${p.weight ?? '(既定)'}`;
  if (p.type === 'dim') return `dim(${p.dir}) at:${p.at} ${p.from}→${p.to} label:${p.label}`;
  if (p.type === 'text') return `text"${p.text}" @${p.x},${p.y}`;
  if (p.type === 'rect') return `rect @${p.x},${p.y} ${p.w}x${p.h}`;
  if (p.type === 'tag') return `tag @${p.cx},${p.cy} ${p.top}/${p.bottom}`;
  if (p.type === 'circle') return `circle @${p.cx},${p.cy} r:${p.rPx}`;
  if (p.type === 'miterTriangle') return `miterTriangle @${p.x},${p.y} dir:${p.dir}`;
  return JSON.stringify(p);
}

/** splitMergedの一言。減った（本当に解消した）ときだけ「解消」、それ以外は中立表現。 */
function splitMergedNote(sm) {
  if (!sm || (!sm.beforeAdded && !sm.beforeRemoved)) return '';
  const resolvedRemoved = sm.beforeRemoved - sm.afterRemoved;
  const resolvedAdded = sm.beforeAdded - sm.afterAdded;
  if (resolvedRemoved > 0 || resolvedAdded > 0) {
    return ` 分割合併で解消:旧${sm.beforeRemoved}本/新${sm.beforeAdded}本→残${sm.afterRemoved}/${sm.afterAdded}`;
  }
  return ` 分割合併判定:旧${sm.beforeRemoved}本/新${sm.beforeAdded}本→変化なし(残${sm.afterRemoved}/${sm.afterAdded})`;
}

function main() {
  const { goldenDir, newDir, opts } = parseArgs(process.argv.slice(2));
  ensureDir(goldenDir, 'goldenDir');
  ensureDir(newDir, 'newDir');

  const goldenFiles = listElevfigFiles(goldenDir);
  const newFiles = listElevfigFiles(newDir);
  const fileSet = new Set([...goldenFiles, ...newFiles]);

  const report = { files: [] };
  let hasDiff = false;
  // !hasDiffでも分割合併の件数だけは報告する（QA指摘: 分割合併のみの差分が「一致」の一言に
  // 埋もれると、合併相当の書き換えが起きたこと自体が読み取れなくなる）。
  const totalSplitMerged = { beforeAdded: 0, beforeRemoved: 0, afterAdded: 0, afterRemoved: 0 };

  for (const file of [...fileSet].sort()) {
    const inGolden = goldenFiles.includes(file);
    const inNew = newFiles.includes(file);
    const fileEntry = { file, onlyInGolden: !inNew, onlyInNew: !inGolden, rooms: [] };
    if (!inGolden || !inNew) {
      hasDiff = true;
      report.files.push(fileEntry);
      continue;
    }

    const goldenRows = loadRows(goldenDir, file);
    const newRows = loadRows(newDir, file);
    const newById = new Map(newRows.map(r => [r.room, r]));
    const newByName = new Map(newRows.map(r => [r.name, r]));
    const matchedNewIds = new Set();

    for (const gRow of goldenRows) {
      const nRow = newById.get(gRow.room) ?? newByName.get(gRow.name) ?? null;
      if (nRow) matchedNewIds.add(nRow.room);
      const roomEntry = { room: gRow.room, name: gRow.name, kind: gRow.kind };
      if (!nRow) {
        roomEntry.onlyInGolden = true;
        hasDiff = true;
        fileEntry.rooms.push(roomEntry);
        continue;
      }
      if (gRow.error || nRow.error) {
        roomEntry.goldenError = gRow.error ?? null;
        roomEntry.newError = nRow.error ?? null;
        if (gRow.error !== nRow.error) hasDiff = true;
        fileEntry.rooms.push(roomEntry);
        continue;
      }
      const { added, removed, changed, splitMerged } =
        diffRoomPrimitives(gRow.prims ?? [], nRow.prims ?? [], { merge: opts.merge });
      if (splitMerged) {
        totalSplitMerged.beforeAdded += splitMerged.beforeAdded;
        totalSplitMerged.beforeRemoved += splitMerged.beforeRemoved;
        totalSplitMerged.afterAdded += splitMerged.afterAdded;
        totalSplitMerged.afterRemoved += splitMerged.afterRemoved;
      }
      if (added.length || removed.length || changed.length) hasDiff = true;
      if (added.length || removed.length || changed.length
        || (splitMerged && (splitMerged.beforeAdded || splitMerged.beforeRemoved))) {
        roomEntry.added = added;
        roomEntry.removed = removed;
        roomEntry.changed = changed;
        roomEntry.splitMerged = splitMerged;
        fileEntry.rooms.push(roomEntry);
      }
    }
    for (const nRow of newRows) {
      if (matchedNewIds.has(nRow.room)) continue;
      hasDiff = true;
      fileEntry.rooms.push({ room: nRow.room, name: nRow.name, kind: nRow.kind, onlyInNew: true });
    }
    if (fileEntry.rooms.length > 0) report.files.push(fileEntry);
  }

  // ---- 人が読めるテキスト出力 ----
  if (!hasDiff) {
    const hasSplitMerged = totalSplitMerged.beforeAdded || totalSplitMerged.beforeRemoved;
    console.log(hasSplitMerged
      ? `一致（分割合併:旧${totalSplitMerged.beforeRemoved}本/新${totalSplitMerged.beforeAdded}本→残${totalSplitMerged.afterRemoved}/${totalSplitMerged.afterAdded}）`
      : '一致');
  } else {
    for (const f of report.files) {
      if (f.onlyInGolden) { console.log(`== ${f.file} ==\n  旧側のみに存在（新側に階が無い）`); continue; }
      if (f.onlyInNew) { console.log(`== ${f.file} ==\n  新側のみに存在（旧側に階が無い）`); continue; }
      console.log(`== ${f.file} ==`);
      for (const r of f.rooms) {
        if (r.onlyInGolden) { console.log(`  部屋「${r.name}」(${r.kind}) 旧側のみに存在`); continue; }
        if (r.onlyInNew) { console.log(`  部屋「${r.name}」(${r.kind}) 新側のみに存在`); continue; }
        if (r.goldenError !== undefined) {
          console.log(`  部屋「${r.name}」(${r.kind}) エラー差分: 旧="${r.goldenError}" 新="${r.newError}"`);
          continue;
        }
        console.log(`  部屋「${r.name}」(${r.kind}) 追加${r.added.length}件 削除${r.removed.length}件 変更${r.changed.length}件${splitMergedNote(r.splitMerged)}`);
        for (const p of r.added.slice(0, opts.top)) console.log(`    + ${fmtLine(p)}`);
        for (const p of r.removed.slice(0, opts.top)) console.log(`    - ${fmtLine(p)}`);
        for (const c of r.changed.slice(0, opts.top)) console.log(`    ~ ${fmtLine(c.before)}  →  ${fmtLine(c.after)}`);
      }
    }
  }

  if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 1));
  }

  process.exit(hasDiff ? 1 : 0);
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
