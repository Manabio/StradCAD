// 「全階保持」高速化案の検討材料として、実際の操作列（構造突入→自階柱削除→階切替→
// 下階柱を編集可能peekで削除→階切替→脱出→2階IDB直接書換え→再突入→階切替）を製品コードの
// まま流し、各手順後の全階（柱・梁・採番・壁枚数）を固定するprobe（構造再計算の高速化 ステップ0）。
// 試作段階では KEEP（保持の寿命）/REV（他モードの書込みタイミング）で挙動を比較していたが、
// どちらも試作専用キャッシュ（globalThis.__PEEKCACHE。今回移植した structPerfHooks.mjs には無い）
// に依存する分岐だったため、本ファイルには移植していない——製品コードをそのまま1系統流すだけの
// シナリオになっている（試作結果 scenario-base-call.json と同じ「保持なし」の基準系統に相当）。
//
// 使い方（app/ で）:
//   node --import ./scripts/testSetup.mjs --import ./scripts/probe/structPerfSetup.mjs \
//     scripts/probe/structPerfScenario.mjs [src.stq] [--check]
//
// 出力: 通常実行は out/structperf/scenario-<docベース名>.json へ手順ごとの全階ダンプを書く。
// --check を付けると golden-structperf/ の対応ファイルと比較し、不一致なら手順・階・件数・
// 差分の先頭数件を表示して exit code 1 で終わる（一致なら0。比較は structPerfCompare.mjs）。
//
// 実データが踏まない経路: moku5.stq（在来木造）を前提にした手順（3階以上・下階の編集可能peek）
// のため、S造（13.stq相当）の経路はこのシナリオでは検証できない（structPerfEntry.mjsが担当）。
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { diffDump, reportDiffs } from './structPerfCompare.mjs';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { PlanGraph } from '../../src/core.js';
import { saveFloor } from '../../src/storage/db.js';
import { runStructuralModeSetup, reflectStructuralToOtherFloors } from '../../src/structural/structuralOrchestration.js';
import { figureBindingManager } from '../../src/figure/FigureBindingManager.js';
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
  return { src: positional[0] ?? 'D:/tatsuya/Download/moku5.stq', opts };
}

const { src, opts } = parseArgs(process.argv.slice(2));
const docBase = path.basename(src, path.extname(src));
const outDir = opts.out ?? path.join(import.meta.dirname, 'out', 'structperf');
const goldenDir = path.join(import.meta.dirname, 'golden-structperf');
const outName = `scenario-${docBase}.json`;

const { project, doc } = loadDocument(src);
const allPlanes = [...project.planeMap.values()];
const label = (p) => (p.isRoofPlane ? '屋根' : p.name);
const planeByName = (n) => allPlanes.find((p) => label(p) === n);

// 本番と同じ初期状態: 全階をIDBへ、アクティブ（1階）以外のメモリ上graphは空にする
// （store.js起動直後・非アクティブ階はIDBにしか無い状態を模す）。
project.activePlaneId = planeByName('1階').id;
for (const p of allPlanes) await saveFloor(p.id, serializeGraph(project.graphMap.get(p.id)));
for (const p of allPlanes) if (p.id !== project.activePlaneId) project.graphMap.get(p.id).clearFloorData();

const dumpG = (g) => ({
  columns: g.columns.map(c => `${Math.round(c.x)},${Math.round(c.y)}:${c.sectionDefId}:${c.memberNo ?? ''}`).sort(),
  beams: g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${Math.round(b.axisValue)}:${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}:${b.memberNo ?? ''}`).sort(),
  walls: g.walls.length, rooms: g.roomMap.size,
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
  log[step] = out;
  console.log(`${step}: ` + allPlanes.map(p => `${label(p)} 柱${out[label(p)].columns.length}/梁${out[label(p)].beams.length}/壁${out[label(p)].walls}`).join('  '));
}

let comp = null;
async function enter() { comp = await runStructuralModeSetup(project.activeGraph, project, {}); }
async function switchFloorKeepingMode(name) { // App.jsx switchFloorKeepingMode と同じ順序
  await figureBindingManager.deactivate();                         // 脱出境界（floorSwitch:true＝他階反映なし）
  const cur = project.activePlane, next = planeByName(name);
  await floorSwapManager.deactivate(cur, project.activeGraph);     // store.js switchFloor
  runInAction(() => { project.activePlaneId = next.id; });
  await floorSwapManager.activate(next, project.graphMap.get(next.id));
  await enter();
}
async function exitToPlan() { // App.jsx runStructuralExitBoundary（壁の鍵照合refreshWallsAllFloorsは今回の論点外のため省く）
  await figureBindingManager.deactivate();
  await saveFloor(project.activePlane.id, serializeGraph(project.activeGraph));
  await reflectStructuralToOtherFloors(project);
}

console.log(`=== src=${path.basename(src)}${opts.check ? ' (--check)' : ''}`);
await enter();                                  await snapshot('1 突入(1階)');
// 2: 自階（1階）の柱をユーザーが手動削除 → そのまま2階伏図へ階切替
runInAction(() => { const c = project.activeGraph.columns.find(c => c.dimensionStatus === 'auto'); project.activeGraph.removeColumn(c.id); });
await switchFloorKeepingMode('2階');            await snapshot('2 1階の柱削除→2階へ切替');
// 3: 2階伏図に映る「下階（1階）の柱」を構造リストから削除（編集可能peek＝デバウンス保存）→3階へ
{ const below = comp.graphForCategory('columnMap'); runInAction(() => { const c = below.columns.find(c => c.dimensionStatus === 'auto'); below.removeColumn(c.id); }); }
await switchFloorKeepingMode('3階');            await snapshot('3 下階(1階)の柱削除→3階へ切替');
// 4: 平面モードへ出る → 他モードの階間同期（階段・偏芯・またぎundo等）が非アクティブ2階のIDBを直接書き換える→構造へ戻る
await exitToPlan();                             await snapshot('4 構造を脱出');
{ // 他モードの書込みの代役: 2階の壁を1枚減らし、構造部材を保存時の状態へ戻したバイト列をIDBへ直接書く
  const p2 = planeByName('2階'); const g = new PlanGraph(p2); g._structGraph = project.structGraph;
  restoreGraph(g, doc.floors.find(f => f.planeId === p2.id).bytes);
  runInAction(() => { const w = g.walls[g.walls.length - 1]; g.removeShape?.(w.id) ?? g.shapeMap.delete(w.id); });
  await saveFloor(p2.id, serializeGraph(g));
}
await snapshot('5 他モードが2階を書換え');
await enter();                                  await snapshot('6 構造へ再突入(3階)');
await switchFloorKeepingMode('1階');            await snapshot('7 1階へ切替');

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
