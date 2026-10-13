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
//   --strip-struct  壁の再生成のあと、全階から柱・梁を除いてから描く（viewEntryProbe.mjs が柱・梁の差を切り分けるのに使う）。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { dumpFloorBands, moveCenterLine, stripStructuralMembers } from './elevBandDump.mjs';

const allArgs = process.argv.slice(2);
const unknownOption = allArgs.find(a => a.startsWith('-') && a !== '--regen' && a !== '--strip-struct' && !a.startsWith('--move='));
if (unknownOption) {
  console.error(`unknown option: ${unknownOption}`);
  process.exit(1);
}
const regen = allArgs.includes('--regen');
const stripStruct = allArgs.includes('--strip-struct');
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
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = graph.walls.length;
    await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    const lines = stairPartitionLines(graph);
    const partitions = [...graph.walls].filter(w => isStairPartitionWall(w, lines)).length;
    console.error(`[regen] ${p.name}: 壁 ${before}→${graph.walls.length}・隔て壁 ${partitions}`);
  }
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
  const rows = dumpFloorBands(project, graph, upperGraph, lowerGraph);

  const name = p.name.replace(/[^\w一-龥ぁ-んァ-ヶー]/g, '_');
  fs.writeFileSync(path.join(outDir, `elevfig-${name}.json`), JSON.stringify(rows, null, 1));
  summary.push({ plane: p.name, rooms: rows.length,
    prims: rows.reduce((n, x) => n + (x.count ?? 0), 0), errors: rows.filter(x => x.error).length });
}
fs.writeFileSync(path.join(outDir, 'elevfig-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
