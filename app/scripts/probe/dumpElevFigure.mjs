// 11.stq の各階・各部屋の展開図の**描画プリミティブ**をJSONへ落とす（回帰の基準）。
//
// 部屋ごとの帯ビルダーの振り分け（buildOne を写す）は elevBandDump.mjs の dumpFloorBands にある。
//
// 使い方: node dumpElevFigure.mjs [outDir] [src.stq] [--regen] [--move=<CL id|label|auto>:<mm>] [--strip-struct]
//   --regen  保存済みの壁のまま比べず、実アプリが文書を開いたときと同じく全階の壁を再生成してから描く
//            （dumpPlanRegen.mjs と同じ手順: conformWoodBacking → resolveStairContext → regenerateWalls）。
//            隔て板（在来木造の折返し・回り階段の隔て壁）のように、壁の生成規則が変わって保存済みの
//            文書に壁が無いものを展開図の基準に含めたいときに使う（moku1-6 の golden-elev-moku16）。
//            階ごとの壁数と隔て壁数を標準エラーへ出す（再生成で壁が実際に入ったことの裏取り）。
//   --move   --regen の前に通り芯（または中心線）を mm だけ動かす（elevBandDump.mjs moveCenterLine。
//            commitCLMoveOp 経由。構造再計算は走らない）。viewEntryProbe.mjs の帯比較の基準側に使う。
//   --struct  --regen の後に、本番の反映パスと同じ全階の構造再計算（sweepOrder.mjs sweepUntilConverged 'desc'）を
//            収束まで回してから帯を描く。保存時点に無い部材（読込み時の再計算で生まれる LG 等）を含めて基準を
//            採るため（13.stq「7」C の踊り場受け梁 LG は保存データに無く、--struct 無しの golden では検出できなかった）。
//            構造 golden（golden13-struct）の採取に使う。--regen と併用する。
//   --strip-struct  壁の再生成のあと、全階から柱・梁を除いてから描く（viewEntryProbe.mjs が柱・梁の差を切り分けるのに使う）。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { dumpFloorBands, moveCenterLine, stripStructuralMembers } from './elevBandDump.mjs';

const allArgs = process.argv.slice(2);
const unknownOption = allArgs.find(a => a.startsWith('-') && a !== '--regen' && a !== '--strip-struct' && a !== '--struct' && !a.startsWith('--move='));
if (unknownOption) {
  console.error(`unknown option: ${unknownOption}`);
  process.exit(1);
}
const regen = allArgs.includes('--regen');
const stripStruct = allArgs.includes('--strip-struct');
const recomputeStruct = allArgs.includes('--struct');
if (recomputeStruct && !allArgs.includes('--regen')) {
  console.error('--struct は --regen と併用する（壁の再生成のあとに構造を再計算する）');
  process.exit(1);
}
const moveSpec = allArgs.find(a => a.startsWith('--move='))?.slice('--move='.length) ?? null;
const rawArgs = allArgs.filter(a => !a.startsWith('-'));
const outDir = rawArgs[0] ?? path.join(import.meta.dirname, 'golden');
const src = rawArgs[1] ?? 'D:/tatsuya/Download/11.stq';
fs.mkdirSync(outDir, { recursive: true });

const { project } = loadDocument(src);
if (moveSpec) {
  const m = moveCenterLine(project, moveSpec);
  console.error(`[move] ${m.cl.label || m.cl.id}: ${m.from} → ${m.to}`);
}
if (regen) {
  const { runInAction } = await import('mobx');
  const { resolveStairContext } = await import('../../src/finish/stair/stairUnderRooms.js');
  const { regenerateWalls, loadMaterialMap } = await import('../../src/finish/wallRegeneration.js');
  const { conformWoodBacking } = await import('../../src/structural/woodAutoFill.js');
  const { alignPortStairsOnGraph } = await import('../../src/finish/stair/stairSectionEdit.js');
  const { isStairPartitionWall, stairPartitionLines } = await import('../../src/finish/stair/stairPartition.js');
  const materialMap = await loadMaterialMap();
  const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (!graph) continue;
    runInAction(() => conformWoodBacking(graph, project));
    const aligned = runInAction(() => alignPortStairsOnGraph(graph));
    if (aligned) console.error(`[regen] ${p.name}: 木造の側面の取りつき蹴上 0 を 1 へそろえた`);
    const { stairUnderEntries, extraStairOpenings, belowGraph } = await resolveStairContext(graph, project, graphMapPeek);
    const before = graph.walls.length;
    await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings, belowGraph });
    const lines = stairPartitionLines(graph);
    const partitions = [...graph.walls].filter(w => isStairPartitionWall(w, lines)).length;
    console.error(`[regen] ${p.name}: 壁 ${before}→${graph.walls.length}・隔て壁 ${partitions}`);
  }
}
if (recomputeStruct) {
  const { floorSwapManager } = await import('../../src/storage/FloorSwapManager.js');
  const { sweepUntilConverged } = await import('./sweepOrder.mjs');
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  const sweeps = await sweepUntilConverged(project, 'desc', 8,
    (i, changed) => console.error(`[struct] sweep ${i}: ${changed.join(' ') || '収束'}`));
  if (sweeps == null) console.error('[struct] 8 回で収束しなかった');
}
if (stripStruct) for (const g of project.graphMap.values()) stripStructuralMembers(g);
const tabs = project.orderedTabs;
const summary = [];
for (let i = 0; i < tabs.length; i++) {
  const p = tabs[i];
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const upperGraph = project.graphMap.get(tabs[i + 1]?.id) ?? null;
  const lowerGraph = project.graphMap.get(tabs[i - 1]?.id) ?? null;
  const upperUpperGraph = project.graphMap.get(tabs[i + 2]?.id) ?? null;
  const rows = dumpFloorBands(project, graph, upperGraph, lowerGraph, upperUpperGraph);

  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `elevfig-${name}.json`), JSON.stringify(rows, null, 1));
  summary.push({ plane: p.name, rooms: rows.length,
    prims: rows.reduce((n, x) => n + (x.count ?? 0), 0), errors: rows.filter(x => x.error).length });
}
fs.writeFileSync(path.join(outDir, 'elevfig-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
