// 本番の構造モード突入（structural/structuralOrchestration.js runStructuralModeSetup）を
// IDB抜き（メモリMap。structPerfHooks.mjs差し替え）でそのまま動かし、時間・recompute/peek回数・
// IDB load/save回数を計測する（構造再計算の高速化 ステップ0: 変更前の挙動を固定するgolden採取用）。
//
// 使い方（app/ で）:
//   node --import ./scripts/testSetup.mjs --import ./scripts/probe/structPerfSetup.mjs \
//     scripts/probe/structPerfEntry.mjs [アクティブ階index] [src.stq] [--check]
//   例: node --import ./scripts/testSetup.mjs --import ./scripts/probe/structPerfSetup.mjs \
//     scripts/probe/structPerfEntry.mjs 0 D:/tatsuya/Download/moku5.stq --check
//
// 出力: 通常実行は out/structperf/entry-<docベース名>-a<index>.json へ全階（柱・梁。屋根含む）を書く
// （時間・回数はコンソール表示のみ・JSONには含めない——実行のたびに変わる値のため）。
// --check を付けると同じ内容を golden-structperf/ の対応ファイルと比較し、不一致があれば
// 階・件数・差分の先頭数件を表示して exit code 1 で終わる（一致なら0）。比較は structPerfCompare.mjs
// （ソート済み文字列配列としての多重集合比較。idでの突き合わせはしない）。
//
// 本番からの意図的な省略: 本番の switchFloorKeepingMode 相当（figureBindingManager.deactivate等）は
// 呼ばない——本probeは「1つの階へ突入したときの挙動・性能」だけを見るため（複数階をまたぐ操作列の
// 検証は structPerfScenario.mjs が担う）。
//
// 実データが踏まない経路（2026-09-19時点。structAnchorProbe.mjsの実測と同じ）:
//   13.stq（S造）: columnPlacement='gridIntersections'・wallBeamAxes=null のため、在来木造の
//   柱・梁生成経路（woodAutoFill.js等）を通らない——recompute/peek回数・柱梁本数のみが検証対象になる。
//   moku4.stq・moku5.stq（在来木造）: columnPlacement='wallIntersections'・wallBeamAxes='selfAndBelow'
//   で全経路を通る。
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadDocument } from './loadDoc.mjs';
import { diffDump, reportDiffs } from './structPerfCompare.mjs';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { PlanGraph } from '../../src/core.js';
import { saveFloor } from '../../src/storage/db.js';
import { runStructuralModeSetup } from '../../src/structural/structuralOrchestration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { check: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--out') { opts.out = argv[++i]; continue; }
    positional.push(a);
  }
  return {
    activeIdx: Number(positional[0] ?? 0),
    src: positional[1] ?? 'D:/tatsuya/Download/moku5.stq',
    opts,
  };
}

const { activeIdx, src, opts } = parseArgs(process.argv.slice(2));
const docBase = path.basename(src, path.extname(src));
const outDir = opts.out ?? path.join(import.meta.dirname, 'out', 'structperf');
const goldenDir = path.join(import.meta.dirname, 'golden-structperf');
const outName = `entry-${docBase}-a${activeIdx}.json`;

const S = (globalThis.__STRUCT_PERF_STAT = { peek: 0, peekMs: 0, rec: 0, recMs: 0, ctxCreated: 0, ctxHit: 0, ctxInvalidated: 0 });

const { project } = loadDocument(src);
const active = project.planes[activeIdx];
if (!active) {
  console.error(`アクティブ階indexが範囲外です: ${activeIdx}（階数: ${project.planes.length}）`);
  process.exit(2);
}
project.activePlaneId = active.id;
// 全階（屋根含む）をメモリIDBへ。アクティブ階以外は graphMap から外す＝本番と同じ
// 「非アクティブ階はIDBにしか無い」状態にする（floorSwapManager.peekが実際にIDB読み込み経路を通る）。
const allPlanes = [...project.planeMap.values()];
for (const p of allPlanes) {
  const g = project.graphMap.get(p.id);
  if (g) await saveFloor(p.id, serializeGraph(g));
}
globalThis.__STRUCT_PERF_MEM.stat.save = 0;

function dump(g) {
  return {
    columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}:${c.sectionDefId}:${c.memberNo ?? ''}`).sort(),
    beams: g.beams.map(b => `${b.role}:${b.beamType ?? ''}:${b.isVertical ? 'V' : 'H'}:${Math.round(b.axisValue)}:` +
      `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..` +
      `${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}:${b.memberNo ?? ''}`).sort(),
  };
}
const label = (p) => (p.isRoofPlane ? '屋根' : p.name);

async function entry(tag) {
  Object.assign(S, { peek: 0, peekMs: 0, rec: 0, recMs: 0, ctxCreated: 0, ctxHit: 0, ctxInvalidated: 0 });
  const M = globalThis.__STRUCT_PERF_MEM.stat;
  M.load = 0; M.save = 0;
  const t = performance.now();
  const comp = await runStructuralModeSetup(project.activeGraph, project, {});
  const ms = performance.now() - t;
  await floorSwapManager.flushEditablePeek?.();
  console.log(`${tag}: ${ms.toFixed(0)}ms  recompute=${S.rec}回/${S.recMs.toFixed(0)}ms  peek=${S.peek}回/${S.peekMs.toFixed(0)}ms  ` +
    `IDB load=${M.load} save=${M.save}  ctx生成=${S.ctxCreated}回 hit=${S.ctxHit} invalidated=${S.ctxInvalidated}`);
  return comp;
}

console.log(`=== active=${label(active)} src=${path.basename(src)}${opts.check ? ' (--check)' : ''}`);
await entry('突入1回目（保存状態→収束）');
await saveFloor(active.id, serializeGraph(project.activeGraph));
await entry('突入2回目（収束済み・無変化）');
await saveFloor(active.id, serializeGraph(project.activeGraph));
await entry('突入3回目（収束済み・無変化）');
await saveFloor(active.id, serializeGraph(project.activeGraph));

const out = {};
for (const p of allPlanes) {
  let g;
  if (p.id === active.id) {
    g = project.activeGraph;
  } else {
    g = new PlanGraph(p);
    g._structGraph = project.structGraph;
    restoreGraph(g, globalThis.__STRUCT_PERF_MEM.floors.get(p.id));
  }
  out[label(p)] = dump(g);
  console.log(`  ${label(p)}: 柱${out[label(p)].columns.length} 梁${out[label(p)].beams.length}`);
}

if (opts.check) {
  const goldenPath = path.join(goldenDir, outName);
  if (!fs.existsSync(goldenPath)) {
    console.error(`golden が見つかりません: ${goldenPath}`);
    process.exit(2);
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const diffs = diffDump(golden, out);
  if (diffs.length === 0) {
    console.log(`一致: ${outName}`);
    process.exit(0);
  }
  console.log(`不一致: ${outName}（${diffs.length}箇所）`);
  reportDiffs(diffs);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, outName), JSON.stringify(out, null, 1));
console.log(`書き出し: ${path.join(outDir, outName)}`);
process.exit(0);
