// 壁の再生成をFinishModeStateから独立させる計画のゴール確認用probe:
// 「主構造を切り替えて戻しても柱・梁芯が増減しないこと」を実データ（.stq）で確認する。
// 手順は wallRefreshProbe.mjs と同じインメモリ方式（IndexedDB抜き・保存なし）。
//   0) 読込みsweep＋構造再計算 → 基準（baseline）
//   1) 建物全体の主構造を別構造へ変更 → 構造再計算（onStructureChanged相当）→ 構造脱出相当
//      （sweep＋構造再計算）
//   2) 元の主構造へ戻す → 同上
//   3) 2) の結果（柱本数・梁芯CLの本数と座標・壁本数と幾何）が baseline と一致すれば OK
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/structureToggleProbe.mjs [入力.stq] [往復先の主構造]
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { centerLineKind } from '../../src/core/centerLine.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const toStructure = process.argv[3] ?? 'S造';
const { project } = loadDocument(src);
const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
const materialMap = await loadMaterialMap();

async function runSweep() {
  const changed = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (graph.wallFreshnessKey == null && graph.walls.length === 0) continue;
    runInAction(() => conformWoodBacking(graph, project));
    if (wallFreshnessKey(graph, project) === graph.wallFreshnessKey) continue;
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = wallBackingCenters(graph);
    const { regenerated } = await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    if (!regenerated) continue;
    const moves = mapBackingCenterMoves(before, wallBackingCenters(graph));
    if (moves.length > 0) followWallBeamAxes(graph, moves);
    graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
    changed.push(p.name);
  }
  return changed;
}

async function recomputeAll() {
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    await recomputeStructuralForGraph(graph, project, graph.structureOverride ?? project.structuralInfo.mainStructure);
  }
}

function wallDigest(graph) {
  return graph.walls.map(w => [
    w.isVertical, Math.round(w.axisValue), Math.round(w.coord1), Math.round(w.coord2),
    Math.round(w.materialRange?.lo ?? NaN), Math.round(w.materialRange?.hi ?? NaN),
  ].join(':')).sort().join('|');
}
function beamAxes(graph) {
  return graph.centerLines.filter(cl => centerLineKind(cl) === 'beam')
    .map(cl => `${cl.type}:${Math.round(cl.value)}`).sort();
}
function summary() {
  return project.planes.map(p => {
    const g = project.graphMap.get(p.id);
    return {
      plane: p.name, columns: g.columns.length, beamAxes: beamAxes(g).length,
      beamAxesList: beamAxes(g).join(','), walls: g.walls.length, wallDigest: wallDigest(g),
    };
  });
}
function show(label, s) {
  console.log(`=== ${label} ===`);
  for (const r of s) console.log(JSON.stringify({ plane: r.plane, columns: r.columns, beamAxes: r.beamAxes, walls: r.walls }));
}

// 0) 基準
console.log('読込みsweep changed:', await runSweep());
await recomputeAll();
const baseline = summary();
show('baseline', baseline);

const original = project.structuralInfo.mainStructure;
console.log(`主構造: ${original} → ${toStructure}`);
runInAction(() => project.structuralInfo.setField('mainStructure', toStructure));
await recomputeAll();                     // onStructureChanged（recomputeStructuralComposition）相当
console.log('構造脱出sweep changed:', await runSweep());
await recomputeAll();                     // refreshWallsAllFloors 末尾の構造反映相当
show(`after ${toStructure}`, summary());

console.log(`主構造: ${toStructure} → ${original}`);
runInAction(() => project.structuralInfo.setField('mainStructure', original));
await recomputeAll();
console.log('構造脱出sweep changed:', await runSweep());
await recomputeAll();
const back = summary();
show('after back', back);

let ng = 0;
for (let i = 0; i < baseline.length; i++) {
  const a = baseline[i], b = back[i];
  for (const k of ['columns', 'beamAxes', 'beamAxesList', 'walls', 'wallDigest']) {
    if (a[k] !== b[k]) {
      ng++;
      console.error(`NG: ${a.plane} ${k} が往復で変化: ${String(a[k]).slice(0, 200)} → ${String(b[k]).slice(0, 200)}`);
    }
  }
}
if (ng === 0) console.log('OK: 主構造の往復で柱・梁芯・壁は増減せず一致');
else process.exitCode = 1;
