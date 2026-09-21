// 「各階柱寸法を細くすると、外壁の面を通り芯±60に固定したまま壁の帯と柱が外壁側へ寄る」
// （.claude/structural-model.md「外壁の面は通り芯±60に固定する」節）が、構造再計算まわりの変更で
// 壊れていないことを固定するprobe（構造再計算の高速化の検証に後から足した——他のstructPerf系の
// golden は全データが既定の柱寸120＝帯の寄せ0で、この機能を一度も発火させていなかった）。
// 本番と同じ操作列を製品コードのまま流す:
//   1 構造突入 → 2 構造リスト「各階柱寸法」の変更と同じ経路（recomputeStructuralComposition＋mutate）
//   → 3 構造モードを脱出（App.jsx runStructuralExitBoundary と同じ順序＝自階保存→他階反映→
//     refreshWallsAllFloors（壁の鍵照合＝作り直し→自階再計算→他階反映））→ 4 構造へ再突入
// 期待する形: 手順2の直後は壁が古いまま＝寄せ0（壁の作り直しはモード境界だけ。即時再生成の経路は
// 設けない裁定）、手順3で壁の bandOffset が ±(120−W)/2 になり、柱の偏心が同量になる。
//
// 使い方（app/ で）:
//   node --import ./scripts/testSetup.mjs --import ./scripts/probe/structPerfSetup.mjs \
//     scripts/probe/structPerfColumnWidth.mjs [アクティブ階index=0] [src.stq] [--width 105] [--check] [--out dir]
//
// 出力: 通常実行は out/structperf/colwidth-<docベース名>-a<idx>-w<幅>.json。--check は
// golden-structperf/ の同名ファイルと比較し、不一致なら exit code 1（比較は structPerfCompare.mjs）。
//
// 実データが踏まない経路: 個別柱（柱ごとの柱寸指定・woodOffsetSide）、柱寸アップ（階の値より太い柱）、
// 2a壁、S造など在来木造以外（帯の寄せ自体が無い）。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { diffDump, reportDiffs } from './structPerfCompare.mjs';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { PlanGraph } from '../../src/core.js';
import { saveFloor } from '../../src/storage/db.js';
import { runStructuralModeSetup, reflectStructuralToOtherFloors, recomputeStructuralComposition } from '../../src/structural/structuralOrchestration.js';
import { normalizeColumnOverridesToFloor } from '../../src/structural/columnWidthScope.js';
import { refreshWallsAllFloors } from '../../src/wallRefresh.js';
import { figureBindingManager } from '../../src/figure/FigureBindingManager.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { check: false, out: null, width: 105 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--out') { opts.out = argv[++i]; continue; }
    if (a === '--width') { opts.width = Number(argv[++i]); continue; }
    positional.push(a);
  }
  return { activeIdx: Number(positional[0] ?? 0), src: positional[1] ?? 'D:/tatsuya/Download/moku5.stq', opts };
}

const { activeIdx, src, opts } = parseArgs(process.argv.slice(2));
const docBase = path.basename(src, path.extname(src));
const outDir = opts.out ?? path.join(import.meta.dirname, 'out', 'structperf');
const goldenDir = path.join(import.meta.dirname, 'golden-structperf');
const outName = `colwidth-${docBase}-a${activeIdx}-w${opts.width}.json`;

globalThis.__STRUCT_PERF_STAT = { peek: 0, peekMs: 0, rec: 0, recMs: 0, ctxCreated: 0, ctxHit: 0, ctxInvalidated: 0 };
const { project } = loadDocument(src);
const allPlanes = [...project.planeMap.values()];
const label = (p) => (p.isRoofPlane ? '屋根' : p.name);
const active = project.planes[activeIdx];
project.activePlaneId = active.id;
for (const p of allPlanes) await saveFloor(p.id, serializeGraph(project.graphMap.get(p.id)));
for (const p of allPlanes) if (p.id !== project.activePlaneId) project.graphMap.get(p.id).clearFloorData();

// 7.5mm の寄せを潰さないよう 0.1mm 単位（他のstructPerf系のダンプは整数mm丸め）。
const r1 = (v) => Math.round(v * 10) / 10;
const dumpG = (g) => {
  const bandOffsets = {};
  for (const w of g.walls) { const k = String(r1(w.bandOffset ?? 0)); bandOffsets[k] = (bandOffsets[k] ?? 0) + 1; }
  return {
    woodColumnWidthMm: g.woodColumnWidthMm ?? null,
    // 柱は AXIS（通り芯基準・偏心を含まない）と偏心（ACTUAL−AXIS）を分けて出す——AXIS が動いたら
    // 「梁芯CL・柱アンカーは帯の寄せに追従させない」不変条件の違反。
    columns: g.columns.map(c => `${c.role}:axis=${r1(c.axisX)},${r1(c.axisY)}:ecc=${r1(c.x - c.axisX)},${r1(c.y - c.axisY)}:${c.sectionDefId}:${c.memberNo ?? ''}`).sort(),
    beams: g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${r1(b.axisValue)}:${r1(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${r1(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}:${b.memberNo ?? ''}`).sort(),
    walls: g.walls.length,
    wallBandOffsets: Object.entries(bandOffsets).map(([k, n]) => `${k}:${n}枚`).sort(),
  };
};
const log = {};
async function snapshot(step) {
  await floorSwapManager.flushEditablePeek();
  const out = {};
  for (const p of allPlanes) {
    let g;
    if (p.id === project.activePlaneId) {
      g = project.activeGraph;
    } else {
      g = new PlanGraph(p);
      g._structGraph = project.structGraph;
      const b = globalThis.__STRUCT_PERF_MEM.floors.get(p.id);
      if (b) restoreGraph(g, b);
    }
    out[label(p)] = dumpG(g);
  }
  log[step] = out;
  const d = out[label(active)];
  const shifted = d.columns.filter(c => !c.includes(':ecc=0,0:')).length;
  console.log(`${step}: ${label(active)} 階柱寸=${d.woodColumnWidthMm} 柱${d.columns.length}本（偏心あり${shifted}本） 壁の寄せ=${d.wallBandOffsets.join(' ')}`);
}

console.log(`=== active=${label(active)} src=${path.basename(src)} width=${opts.width}${opts.check ? ' (--check)' : ''}`);
let comp = await runStructuralModeSetup(project.activeGraph, project, {});
await snapshot('1 突入');
// mutate は本番（MemberListTab.jsx WoodColumnWidthSelect の handleChange）と同じ2行。
await recomputeStructuralComposition(comp, project.activeGraph, project, {
  mutate: () => {
    project.activeGraph.setWoodColumnWidthMm(opts.width);
    normalizeColumnOverridesToFloor(project.activeGraph, opts.width);
  },
});
await snapshot('2 構造モード内で柱寸変更');
await figureBindingManager.deactivate();
await saveFloor(project.activePlane.id, serializeGraph(project.activeGraph));
await reflectStructuralToOtherFloors(project);
await refreshWallsAllFloors(project, { pushUndo: true });
await snapshot('3 構造を脱出');
comp = await runStructuralModeSetup(project.activeGraph, project, {});
await snapshot('4 再突入');

if (opts.check) {
  const goldenPath = path.join(goldenDir, outName);
  if (!fs.existsSync(goldenPath)) {
    console.error(`golden が見つかりません: ${goldenPath}`);
    process.exit(2);
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const diffs = diffDump(golden, log);
  if (diffs.length === 0) {
    console.log(`一致: ${outName}`);
    process.exit(0);
  }
  console.log(`不一致: ${outName}（${diffs.length}箇所）`);
  reportDiffs(diffs);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, outName), JSON.stringify(log, null, 1));
console.log(`書き出し: ${path.join(outDir, outName)}`);
process.exit(0);
