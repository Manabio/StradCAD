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
import { isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { sweepUntilConverged, productionSweepPlanes, planeLabel } from './sweepOrder.mjs';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
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

// 屋根の壁線通し梁（軒桁、role:'primary'）もこのヒストグラムの対象——R-5是正: sweepOrder.mjs
// productionSweepPlanes（本番の反映パスと同じ並び。在来なら屋根が先頭）で屋根込みにする。
const before = new Map();
for (const p of productionSweepPlanes(project)) {
  const g = project.graphMap.get(p.id);
  before.set(p.id, beamHistogram(g));
}

// 【小屋伏図にも梁・柱ルールを適用する計画のステップ7・R-5是正】本番の反映パス
// （reflectStructuralToOtherFloors）と同じ並び（在来なら降順・屋根が先頭）で回す（sweepOrder.mjs）。
// 冪等収束チェック: 最大4スイープまで全階再計算を回し、changed=[]（変化した階が無い）になった回を
// 報告する。旧来「2回目で必ずchanged=false」固定だったが、在来木造の上階柱直下の柱（ステップ3b）は
// elevation昇順のスイープ順に由来して1階分遅れて反映されるため、moku1では2回のchangedスイープを経て
// 3回目に収束する（.claude/structural-model.md 3b節「結果整合性」）。S造等の非対象構造はsweep1から
// changed=[]で収束1回のはず。
// 在来木造の収束期待はsweep4以内（2026-09-18裁定で3から改定。woodTieBeamProbe.mjsと同じ根拠
// ——3h-2の点源に床梁を加えたことで3階またぎの連鎖が成立し、1スイープでは1段ずつしか伝播しない）。
const MAX_SWEEPS = 8; // 【QA第2巡Minor-4】convergeLimit(5)に対して余裕を持たせる（below候補が階をまたぐ依存を1段追加するため。woodSupportSpanProbe.mjsと同じ8に統一）
let changedSweeps = 0;
const convergedAt = await sweepUntilConverged(project, 'desc', MAX_SWEEPS, (i, changedPlanes) => {
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
  if (changedPlanes.length > 0) changedSweeps++;
});

console.log(`--- 収束後（sweep${convergedAt ?? MAX_SWEEPS}時点）の階ごとヒストグラム ---`);
for (const p of productionSweepPlanes(project)) {
  const g = project.graphMap.get(p.id);
  console.log(`[${planeLabel(p)}]`);
  showHistogram('before', before.get(p.id));
  showHistogram('after ', beamHistogram(g));
}

// QA裁定（F8）：期待値を固定する——非在来はsweep1で収束（changed=[]）しなければNG、在来は
// 昇順スイープ由来で3b・3dが互いに1スイープ遅れうるためsweep5までに収束しなければNG（緩めっぱなしにしない。【QA第2巡Minor-4】below候補の追加で3→5へ緩和）。
const convergeLimit = isTraditionalWoodStructure(project.structuralInfo.mainStructure) ? 5 : 1; // 【QA第2巡Minor-4】below候補（3i）が階をまたぐ依存を1段追加するため4は余裕ゼロだった（moku4実測でも収束sweep4ちょうど）。5に緩和。5超はNGのまま
if (convergedAt != null && convergedAt <= convergeLimit) {
  console.log(`OK: 収束（sweep${convergedAt} で changed=[]。changed があったスイープ数=${changedSweeps}）`);
} else if (convergedAt != null) {
  console.log(`NG: 収束はしたが遅すぎる（sweep${convergedAt}。期待はsweep${convergeLimit}以内）`);
  process.exitCode = 1;
} else {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
}
