// 共通タブの「地階構造」の変更（S5d）を本番と同じ操作列で流し、undo/redo と脱出での全階の柱・梁を比べる検証probe。
// 本番と同じ操作列を製品コードのまま流す（structPerfColumnWidth.mjs :53-115 を写した）:
//   1 構造突入 → 2 共通タブの地階構造の変更（CommonInfoTab.jsx setBasementStructure と同じ mutate を
//   recomputeStructuralComposition へ。App.jsx handleStructureChanged の中身と同じ） → 3 undoManager.undo()
//   → 4 undoManager.redo() → 5 構造モードを脱出（App.jsx runStructuralExitBoundary と同じ順序＝自階保存→他階反映→
//   refreshWallsAllFloors）
// アクティブ階は project.planes の最初の地階（startFloor<0）。
// 合格: 2 で地階の柱・梁が変わる／3 が 1 と全文一致／4 が 2 と全文一致／地上階の柱・梁は 1〜4 で不変
//   （5 の地上階の差は表に出して記録する＝境界での反映）。
//
// 使い方（app/ で）:
//   node --import ./scripts/testSetup.mjs --import ./scripts/probe/structPerfSetup.mjs \
//     scripts/probe/basementStructureProbe.mjs [src.stq] [--to 'RC造(壁式)']
// --noop: 対照。mutate を空にして、5 脱出の境界（他階の反映・壁の再生成）が元々起こす地上階の差だけを見る。
// --to 省略時: 地階構造が未設定→ラーメン／ラーメン→壁式／壁式→ラーメン（逆方向は --to で指定）。
//
// 省いている前処理: App.jsx の関門（runBusy・structuralSync.whenIdle）。UI の入力規制で本probeの計算結果には影響しない。
// 実データが踏まない経路: 下階（B2）のある複数地階、検討案の地階、旧データの地階の上書き。
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { PlanGraph } from '../../src/core.js';
import { undoManager } from '../../src/undoManager.js';
import { saveFloor } from '../../src/storage/db.js';
import { runStructuralModeSetup, reflectStructuralToOtherFloors, recomputeStructuralComposition } from '../../src/structural/structuralOrchestration.js';
import { isBasementPlane, hasBasementFloor, foundationStructureFor, normalizeFoundationTypeFor } from '../../src/structural/structureRules.js';
import { refreshWallsAllFloors } from '../../src/wallRefresh.js';
import { figureBindingManager } from '../../src/figure/FigureBindingManager.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { to: null, noop: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to') { opts.to = argv[++i]; continue; }
    if (argv[i] === '--noop') { opts.noop = true; continue; } // 対照: mutate を空にして 5 脱出の境界の差だけを見る
    positional.push(argv[i]);
  }
  return { src: positional[0] ?? 'D:/tatsuya/Download/basement-test-null.stq', opts };
}
const { src, opts } = parseArgs(process.argv.slice(2));

globalThis.__STRUCT_PERF_STAT = { peek: 0, peekMs: 0, rec: 0, recMs: 0, ctxCreated: 0, ctxHit: 0, ctxInvalidated: 0 };
const { project } = loadDocument(src);
const info = project.structuralInfo;
const allPlanes = [...project.planeMap.values()];
const label = (p) => (p.isRoofPlane ? '屋根' : p.name);
const active = project.planes.find(isBasementPlane);
if (!active) { console.error(`地階がありません: ${src}`); process.exit(2); }
project.activePlaneId = active.id;
for (const p of allPlanes) await saveFloor(p.id, serializeGraph(project.graphMap.get(p.id)));
for (const p of allPlanes) if (p.id !== project.activePlaneId) project.graphMap.get(p.id).clearFloorData();

const target = opts.to ?? (info.basementStructure === 'RC造(ラーメン)' ? 'RC造(壁式)' : 'RC造(ラーメン)');

const r1 = (v) => Math.round(v * 10) / 10;
const dumpG = (g) => ({
  columns: g.columns.map(c => `${c.role}:axis=${r1(c.axisX)},${r1(c.axisY)}:${c.sectionDefId}:${c.memberNo ?? ''}`).sort(),
  beams: g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${r1(b.axisValue)}:${r1(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${r1(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}:${b.memberNo ?? ''}`).sort(),
  footings: g.footings?.length ?? 0,
});
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
  log[step] = { floors: out, basementStructure: info.basementStructure, foundationType: info.foundationType, mainStructure: info.mainStructure };
}

console.log(`=== src=${path.basename(src)} active=${label(active)} 主構造=${info.mainStructure} 地階構造 ${info.basementStructure ?? '(null)'} → ${target} 基礎種別=${info.foundationType}`);
let comp = await runStructuralModeSetup(project.activeGraph, project, {});
await snapshot('1 突入');
// CommonInfoTab.jsx setBasementStructure と同じ mutate。
await recomputeStructuralComposition(comp, project.activeGraph, project, {
  mutate: opts.noop ? () => {} : () => {
    info.setBasementStructure(target);
    const next = normalizeFoundationTypeFor(foundationStructureFor(info, hasBasementFloor(project.planes)), info.foundationType);
    if (next !== info.foundationType) info.setField('foundationType', next);
  },
});
await snapshot('2 地階構造を変更');
undoManager.undo();
await snapshot('3 undo');
undoManager.redo();
await snapshot('4 redo');
await figureBindingManager.deactivate();
await saveFloor(project.activePlane.id, serializeGraph(project.activeGraph));
await reflectStructuralToOtherFloors(project);
await refreshWallsAllFloors(project, { pushUndo: true });
await snapshot('5 脱出');

// ---- 表 ----
const steps = Object.keys(log);
console.log('\n段階 | 地階構造 | 基礎種別 | ' + Object.keys(log['1 突入'].floors).map(n => `${n}(柱/梁)`).join(' | '));
for (const s of steps) {
  const cells = Object.entries(log[s].floors).map(([, d]) => `${d.columns.length}/${d.beams.length}`);
  console.log(`${s} | ${log[s].basementStructure ?? '(null)'} | ${log[s].foundationType} | ${cells.join(' | ')}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const groundNames = allPlanes.filter(p => !isBasementPlane(p)).map(label);
const activeName = label(active);
const checks = [
  ['2 で地階の柱・梁が変わる', !same(log['1 突入'].floors[activeName], log['2 地階構造を変更'].floors[activeName])],
  ['3 undo が 1 突入 と全階全文一致', same(log['3 undo'].floors, log['1 突入'].floors)],
  ['3 undo で地階構造・基礎種別・主構造も 1 と一致', log['3 undo'].basementStructure === log['1 突入'].basementStructure
    && log['3 undo'].foundationType === log['1 突入'].foundationType && log['3 undo'].mainStructure === log['1 突入'].mainStructure],
  ['4 redo が 2 と全階全文一致', same(log['4 redo'].floors, log['2 地階構造を変更'].floors)],
  ['4 redo で地階構造・基礎種別も 2 と一致', log['4 redo'].basementStructure === log['2 地階構造を変更'].basementStructure
    && log['4 redo'].foundationType === log['2 地階構造を変更'].foundationType],
  ['地上階の柱・梁は 1〜4 で不変', groundNames.every(n => ['2 地階構造を変更', '3 undo', '4 redo'].every(s => same(log[s].floors[n], log['1 突入'].floors[n])))],
];
console.log('');
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? '合格' : '不合格'}: ${name}`); if (!ok) failed++; }
// 5 の差（記録）。差があれば行の差分を最大6行出す。
function reportStepDiff(n, a, b) {
  console.log(`記録: 5 脱出 の ${n}: 柱 ${a.columns.length}→${b.columns.length} 梁 ${a.beams.length}→${b.beams.length} ${same(a, b) ? '(全文一致)' : '(差あり)'}`);
  for (const key of ['columns', 'beams']) {
    const sa = new Set(a[key]), sb = new Set(b[key]);
    for (const [mark, lines] of [['-', a[key].filter(x => !sb.has(x))], ['+', b[key].filter(x => !sa.has(x))]]) {
      for (const l of lines.slice(0, 2)) console.log(`    ${mark} ${key}: ${l}`);
      if (lines.length > 2) console.log(`    …${mark} ${key} 他 ${lines.length - 2} 行`);
    }
  }
}
for (const n of groundNames) reportStepDiff(n, log['4 redo'].floors[n], log['5 脱出'].floors[n]);
reportStepDiff(activeName, log['4 redo'].floors[activeName], log['5 脱出'].floors[activeName]);
process.exit(failed ? 1 : 0);
