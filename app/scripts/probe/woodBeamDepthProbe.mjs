// 在来木造の梁成自動更新（ステップ3d・autoFillWoodBeamDepths）の実データ確認用probe。
// structureToggleProbe.mjs を骨格に、sweep（壁再生成）は行わず全階 recomputeStructuralForGraph だけを回す
// （梁成の自動更新はconformWoodSectionsと同じく構造再計算パイプライン内で完結するため、壁の鮮度は問わない）。
// 出力: 階ごと・role（primary/secondary）ごとのsectionDefIdヒストグラム（前/後）と、
// 「120角(WOOD-120x120)→表の値になった本数」「非木造・非対象roleの断面が1本も変わらないこと」。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodBeamDepthProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { WOOD_DEPTH_BEAM_ROLES, isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { sweepUntilConverged, productionSweepPlanes, planeLabel } from './sweepOrder.mjs';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （structureToggleProbe.mjsと同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 対象梁（WOOD_DEPTH_BEAM_ROLES=primary/secondary）の断面を id 付きでスナップショットする。
// 材種は問わない——非木造の断面が1本も変わらないことを確認するのが目的の1つのため。
function snapshotBeams() {
  const out = new Map(); // planeId -> Map<beamId, {role, materialType, sectionDefId}>
  for (const p of productionSweepPlanes(project)) {
    const g = project.graphMap.get(p.id);
    const m = new Map();
    for (const b of g.beams) {
      if (!WOOD_DEPTH_BEAM_ROLES.includes(b.role)) continue;
      m.set(b.id, { role: b.role, materialType: b.materialType, sectionDefId: b.sectionDefId });
    }
    out.set(p.id, m);
  }
  return out;
}

// 建物全体・全role・全材種の断面ヒストグラム（S造等の非対象構造で「前後完全一致」を確認する用）。
function allBeamsHistogram() {
  const h = {};
  for (const p of productionSweepPlanes(project)) {
    const g = project.graphMap.get(p.id);
    for (const b of g.beams) {
      const key = `${b.materialType}:${b.role}:${b.sectionDefId}`;
      h[key] = (h[key] ?? 0) + 1;
    }
  }
  return h;
}

function histogram(map) {
  const h = {};
  for (const { role, materialType, sectionDefId } of map.values()) {
    const key = `${materialType}:${role}:${sectionDefId}`;
    h[key] = (h[key] ?? 0) + 1;
  }
  return h;
}

function showHistogram(label, h) {
  console.log(`  ${label}:`, Object.entries(h).sort().map(([k, n]) => `${k}=${n}`).join(', ') || '(なし)');
}

const before = snapshotBeams();
const allBefore = allBeamsHistogram();

// 冪等収束チェック: 最大4スイープまで全階再計算を回し、changed=[]（変化した階が無い）になった回を
// 報告する。在来木造の上階柱直下の柱（ステップ3b）はelevation昇順のスイープ順に由来して1階分遅れて
// 反映され、梁成（3d）もその柱の有無で変わるため、moku1では複数回のchangedスイープを経て収束する
// （.claude/structural-model.md 3b節「結果整合性」）。S造等の非対象構造はsweep1からchanged=[]で
// 収束1回のはず（他3つのprobeと同じ形式）。
// 在来木造の収束期待はsweep4以内（2026-09-18裁定で3から改定。woodTieBeamProbe.mjsと同じ根拠
// ——3h-2の点源に床梁を加えたことで3階またぎの連鎖が成立し、1スイープでは1段ずつしか伝播しない）。
// 【小屋伏図にも梁・柱ルールを適用する計画のステップ7・R-5是正】本番の反映パス
// （reflectStructuralToOtherFloors）と同じ並び（在来なら降順・屋根が先頭）で回す
// （sweepOrder.mjs。9本のwood probeが共有する単一実装）。
const MAX_SWEEPS = 8; // 【QA第2巡Minor-4】convergeLimit(5)に対して余裕を持たせる（below候補が階をまたぐ依存を1段追加するため。woodSupportSpanProbe.mjsと同じ8に統一）
let changedSweeps = 0;
const convergedAt = await sweepUntilConverged(project, 'desc', MAX_SWEEPS, (i, changedPlanes) => {
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
  if (changedPlanes.length > 0) changedSweeps++;
});
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

const after = snapshotBeams();
const allAfter = allBeamsHistogram();

let totalChanged = 0;
let from120ToTable = 0;
for (const p of productionSweepPlanes(project)) {
  const b = before.get(p.id), a = after.get(p.id);
  console.log(`--- ${planeLabel(p)} ---`);
  showHistogram('before', histogram(b));
  showHistogram('after ', histogram(a));
  for (const [id, bv] of b) {
    const av = a.get(id);
    if (!av) continue; // 削除された（想定外だが致命ではない）
    if (bv.sectionDefId !== av.sectionDefId) {
      totalChanged++;
      if (bv.sectionDefId === 'WOOD-120x120' && av.sectionDefId !== 'WOOD-120x120') from120ToTable++;
      console.log(`  更新: ${bv.materialType}:${bv.role} ${bv.sectionDefId} → ${av.sectionDefId}`);
    }
  }
}
console.log(`合計: 更新 ${totalChanged} 本（うち WOOD-120x120 → 表の値 ${from120ToTable} 本）`);
console.log(
  '注記: autoFillWoodBeamDepthsのrole/materialType絞り込み（foundation/eaves/roof/landing・非木造の断面は' +
  '更新されない）は woodAutoFill.test.js の「対象外role（foundation/eaves）・対象外材種（STEEL）の梁は' +
  '更新されず」テストで固定済み。recomputeStructuralForGraphへの配線（changed反映・下階peekの共有）は' +
  '同ファイルの【統合】recomputeStructuralForGraphテストで固定済み。',
);

// 建物全体・全role・全材種の断面ヒストグラム完全一致チェック（非在来構造の入力で使う。moku1等の在来では
// 上のtotalChanged分だけ意図的に差が出るため一致しなくてよい）。
const allKeys = new Set([...Object.keys(allBefore), ...Object.keys(allAfter)]);
const allDiffs = [...allKeys].filter(k => (allBefore[k] ?? 0) !== (allAfter[k] ?? 0));
if (allDiffs.length === 0) {
  console.log('OK: 建物全体の断面ヒストグラムは前後で完全一致（非対象構造ならこれが期待値）');
} else {
  console.log(`断面ヒストグラム差分あり（${allDiffs.length}件。在来木造の梁成更新が含まれる入力では想定どおり）:`);
  for (const k of allDiffs.sort()) console.log(`  ${k}: ${allBefore[k] ?? 0} → ${allAfter[k] ?? 0}`);
}
