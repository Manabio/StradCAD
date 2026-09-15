// 在来木造の床梁自動生成（ステップ3e-2・autoFillWoodFloorBeams）の実データ確認用probe。
// woodWallBeamProbe.mjs を骨格に、全階 recomputeStructuralForGraph を2回回して
// 階ごと・role別（primary/floor）の梁本数と床梁の成ヒストグラムの前後、冪等（2回目 changed=false）を確認する。
// 非在来（S造等）は beamPlacement:'gridEdges' のままrole:'floor'が生成されないため、11/13/14では
// 常に床梁0本・changed=falseになるはず（他probe・golden struct-11と同じ「非対象構造は完全不変」規律）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodFloorBeamProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku1.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （structureToggleProbe.mjs・woodBeamDepthProbe.mjs・woodWallBeamProbeと同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 階ごとのrole別梁本数（primary/floor/その他）＋床梁のsectionDefIdヒストグラム。
function beamHistogram(graph) {
  const h = {};
  for (const b of graph.beams) {
    const key = `${b.materialType}:${b.role}`;
    h[key] = (h[key] ?? 0) + 1;
  }
  return h;
}
function floorDepthHistogram(graph) {
  const h = {};
  for (const b of graph.beams) {
    if (b.role !== 'floor') continue;
    h[b.sectionDefId] = (h[b.sectionDefId] ?? 0) + 1;
  }
  return h;
}
function showHistogram(label, h) {
  console.log(`  ${label}:`, Object.entries(h).sort().map(([k, n]) => `${k}=${n}`).join(', ') || '(なし)');
}

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
}

console.log('--- 1回目再計算後（階・role別本数／床梁の成ヒストグラム） ---');
let totalFloor = 0;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const floorCount = g.beams.filter(b => b.role === 'floor').length;
  totalFloor += floorCount;
  console.log(`[${p.name}]`);
  showHistogram('梁本数', beamHistogram(g));
  showHistogram('床梁の成', floorDepthHistogram(g));
}
console.log(`床梁の合計本数: ${totalFloor}`);

// 冪等確認: 2回目の全階再計算は changed=false のはず。
let secondChanged = false;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const { changed } = await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
  if (changed) { secondChanged = true; console.log(`NG: ${p.name} は2回目もchanged=true`); }
}
console.log(secondChanged ? 'NG: 冪等ではない（2回目もchangedの階がある）' : 'OK: 冪等（2回目は全階changed=false）');
if (secondChanged) process.exitCode = 1;

if (project.structuralInfo.mainStructure !== '木造（在来）' && totalFloor > 0) {
  console.log(`NG: 非在来（${project.structuralInfo.mainStructure}）なのに床梁が${totalFloor}本生成されている`);
  process.exitCode = 1;
} else if (project.structuralInfo.mainStructure !== '木造（在来）') {
  console.log('OK: 非在来は床梁0本');
}
