// 在来木造の壁線上の通し梁（ステップ3c-2・autoFillWoodWallBeams）の実データ確認用probe。
// woodBeamDepthProbe.mjs を骨格に、全階 recomputeStructuralForGraph を2回回して
// 階ごと・role別の梁本数の前後と冪等（2回目 changed=false）を確認する。
// 非在来（S造）は beamPlacement:'gridEdges' のまま変わらないため、golden（scripts/probe/golden/
// struct-*.json、11.stq基準）とのバイト一致は別途 dumpStructural.mjs で確認する
// （本probeはmoku1（在来木造）向け）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodWallBeamProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku1.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （structureToggleProbe.mjs・woodBeamDepthProbe.mjsと同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 階・role別の梁本数ヒストグラム（材種:role:記号相当(beamType)）。
function beamHistogram(graph) {
  const h = {};
  for (const b of graph.beams) {
    const key = `${b.materialType}:${b.role}:${b.beamType ?? ''}`;
    h[key] = (h[key] ?? 0) + 1;
  }
  return h;
}
function showHistogram(label, h) {
  console.log(`  ${label}:`, Object.entries(h).sort().map(([k, n]) => `${k}=${n}`).join(', ') || '(なし)');
}

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

const before = new Map();
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  before.set(p.id, beamHistogram(g));
}

let anyChanged = false;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const { changed } = await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
  if (changed) anyChanged = true;
}

console.log('--- 1回目再計算後 ---');
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  console.log(`[${p.name}]`);
  showHistogram('before', before.get(p.id));
  showHistogram('after ', beamHistogram(g));
}
console.log('1回目で何か変わったか:', anyChanged);

// 冪等確認: 2回目の全階再計算は changed=false のはず。
let secondChanged = false;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const { changed } = await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
  if (changed) { secondChanged = true; console.log(`NG: ${p.name} は2回目もchanged=true`); }
}
console.log(secondChanged ? 'NG: 冪等ではない（2回目もchangedの階がある）' : 'OK: 冪等（2回目は全階changed=false）');
if (secondChanged) process.exitCode = 1;
