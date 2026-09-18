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
import { isTraditionalWoodStructure } from '../../src/structural/structureRules.js';

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

// 冪等収束チェック: 最大4スイープまで全階再計算を回し、changed=[]（変化した階が無い）になった回を
// 報告する。旧来「2回目で必ずchanged=false」固定だったが、在来木造の上階柱直下の柱（ステップ3b）は
// elevation昇順のスイープ順に由来して1階分遅れて反映されるため、moku1では2回のchangedスイープを経て
// 3回目に収束する（.claude/structural-model.md 3b節「結果整合性」）。S造等の非対象構造はsweep1から
// changed=[]で収束1回のはず。
// 在来木造の収束期待はsweep4以内（2026-09-18裁定で3から改定。woodTieBeamProbe.mjsと同じ根拠
// ——3h-2の点源に床梁を加えたことで3階またぎの連鎖が成立し、1スイープでは1段ずつしか伝播しない）。
const MAX_SWEEPS = 5;
let convergedAt = null;
let changedSweeps = 0;
for (let i = 1; i <= MAX_SWEEPS; i++) {
  const changedPlanes = [];
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    const { changed } = await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
    if (changed) changedPlanes.push(p.name);
  }
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
  if (changedPlanes.length === 0) { convergedAt = i; break; }
  changedSweeps++;
}

console.log(`--- 収束後（sweep${convergedAt ?? MAX_SWEEPS}時点）の階ごとヒストグラム ---`);
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  console.log(`[${p.name}]`);
  showHistogram('before', before.get(p.id));
  showHistogram('after ', beamHistogram(g));
}

// QA裁定（F8）：期待値を固定する——非在来はsweep1で収束（changed=[]）しなければNG、在来は
// 昇順スイープ由来で3b・3dが互いに1スイープ遅れうるためsweep3までに収束しなければNG（緩めっぱなしにしない）。
const convergeLimit = isTraditionalWoodStructure(project.structuralInfo.mainStructure) ? 4 : 1;
if (convergedAt != null && convergedAt <= convergeLimit) {
  console.log(`OK: 収束（sweep${convergedAt} で changed=[]。changed があったスイープ数=${changedSweeps}）`);
} else if (convergedAt != null) {
  console.log(`NG: 収束はしたが遅すぎる（sweep${convergedAt}。期待はsweep${convergeLimit}以内）`);
  process.exitCode = 1;
} else {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
}
