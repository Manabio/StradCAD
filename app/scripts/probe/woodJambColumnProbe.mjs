// 建具の袖柱（開口の両袖にクリアランス5mmをとって立てる柱。他の柱と重なる場合は省略。2026-09-18仕様）の
// 実データ確認用probe。階ごとの開口数・生成された袖柱数・省略理由の内訳（overlap/noHost/noAnchor）を
// 集計し、収束（sweepがchanged=[]になる）・冪等（もう1回回しても本数不変）を確認する。
// 非在来（framingを持たない主構造）は袖柱が1本も生成されないことを確認する。
//
// 省略理由の内訳は、収束後にautoFillWoodColumnsを実アプリ（structuralRecompute.js）と同じ引数の
// 組み立て（buildStructuralWallGate・wallRunSegments・peekAboveGraph・columnSeedBeamSegments）で1回だけ
// 直接呼び直して得る——収束済みのため冪等（created/removedは空のまま）で、jambSkipped配列だけを
// 診断用に読む（実アプリの前処理を省いた別実装を作らない。.claude/team-lessons「probeは実アプリと
// 同じ関数列を通す」規律）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodJambColumnProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure, effectiveStructure, rulesFor } from '../../src/structural/structureRules.js';
import { buildStructuralWallGate } from '../../src/structural/wallGate.js';
import { wallRunSegments, columnSeedBeamSegments, peekBelowGraph, peekAboveGraph } from '../../src/structural/wallBeamAxes.js';
import { autoFillWoodColumns } from '../../src/structural/woodAutoFill.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （woodSillProbe.mjs・woodTieBeamProbe.mjs等と同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

// 冪等収束チェック（他probeと同じ規律。在来木造の収束期待はsweep4以内——2026-09-18裁定で3から
// 改定。woodTieBeamProbe.mjsと同じ根拠——3h-2の点源に床梁を加えたことで3階またぎの連鎖が成立し、
// 1スイープでは1段ずつしか伝播しない。本probeは元々MAX_SWEEPS自体を上限として直接OK判定に使って
// いた＝実測sweep4でちょうど通るだけの余裕ゼロだったため、超過を検知できるよう5へ引き上げる）。
const MAX_SWEEPS = 5;
let convergedAt = null;
for (let i = 1; i <= MAX_SWEEPS; i++) {
  const changedPlanes = [];
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    const { changed } = await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
    if (changed) changedPlanes.push(p.name);
  }
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
  if (changedPlanes.length === 0) { convergedAt = i; break; }
}
if (convergedAt == null) {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
}

console.log('--- 階ごとの開口数・袖柱数・省略理由の内訳 ---');
let totalOpenings = 0, totalJambs = 0, nonWoodWithJambs = 0;
const skipTotals = { overlap: 0, noHost: 0, noAnchor: 0 };
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const structure = effectiveStructure(g, project);
  const isWood = isTraditionalWoodStructure(structure);
  const openings = g.openings.length;
  const jambs = g.columns.filter(c => c.woodJambRef).length;
  totalOpenings += openings;
  totalJambs += jambs;
  if (!isWood && jambs > 0) nonWoodWithJambs++;

  let jambSkipped = [];
  if (isWood) {
    // 実アプリ（structuralRecompute.js）と同じ引数の組み立て。収束済みのため冪等呼び直し。
    const belowGraph = await peekBelowGraph(g, project);
    const aboveGraph = await peekAboveGraph(g, project);
    const wallGate = await buildStructuralWallGate(g.plane, project, g);
    const wallSegments = wallRunSegments(g, belowGraph, structure);
    const aboveColumns = aboveGraph?.columns ?? [];
    const ownRules = rulesFor(structure);
    const aboveBeamSegments = columnSeedBeamSegments(aboveGraph, aboveGraph ? rulesFor(effectiveStructure(aboveGraph, project)) : ownRules);
    const result = autoFillWoodColumns(g, project, wallGate, aboveColumns, wallSegments, aboveBeamSegments);
    jambSkipped = result.jambSkipped ?? [];
    if (result.created.length !== 0 || result.removed.length !== 0) {
      console.log(`NG（${p.name}）: 診断のための呼び直しでcreated/removedが空でない（収束していない）: created=${result.created.length} removed=${result.removed.length}`);
      process.exitCode = 1;
    }
    for (const s of jambSkipped) skipTotals[s.reason] = (skipTotals[s.reason] ?? 0) + 1;
  }

  const skipCounts = `overlap=${jambSkipped.filter(s => s.reason === 'overlap').length}`
    + `・noHost=${jambSkipped.filter(s => s.reason === 'noHost').length}`
    + `・noAnchor=${jambSkipped.filter(s => s.reason === 'noAnchor').length}`;
  console.log(`${p.name}（実効主構造=${structure}）: 開口${openings}件 / 袖柱${jambs}本${isWood ? `（省略内訳: ${skipCounts}）` : ''}`);
  if (isWood && jambs > 0) {
    const bySide = g.columns.filter(c => c.woodJambRef)
      .sort((a, b) => (a.woodJambRef.openingId < b.woodJambRef.openingId ? -1 : 1) || a.woodJambRef.side - b.woodJambRef.side);
    for (const c of bySide) {
      console.log(`  ${c.woodJambRef.isVertical ? 'V' : 'H'}壁 opening=${c.woodJambRef.openingId.slice(0, 8)} side=${c.woodJambRef.side} → x=${Math.round(c.x)}, y=${Math.round(c.y)}`);
    }
  }
  for (const s of jambSkipped) {
    const detail = s.reason === 'overlap' ? `overlapMm=${Math.round(s.overlapMm * 10) / 10}` : '';
    console.log(`  [省略] opening=${s.openingId.slice(0, 8)} side=${s.side} jamb座標=${Math.round(s.jamb)} 理由=${s.reason} ${detail}`);
  }
}
console.log(`合計: 開口${totalOpenings}件 / 袖柱${totalJambs}本 / 省略内訳: overlap=${skipTotals.overlap}・noHost=${skipTotals.noHost}・noAnchor=${skipTotals.noAnchor}`);
if (nonWoodWithJambs > 0) {
  console.log(`NG: 非在来の階に袖柱が生成されている（${nonWoodWithJambs}階）`);
  process.exitCode = 1;
}

// 冪等性の再確認: もう一度全階回しても袖柱本数が変わらないこと（作って→撤去のチャーンが無いこと）。
const before = totalJambs;
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
}
let after = 0;
for (const p of project.planes) after += project.graphMap.get(p.id).columns.filter(c => c.woodJambRef).length;
if (before !== after) {
  console.log(`NG: 袖柱本数が再計算のたびに変わる（チャーン。${before}→${after}）`);
  process.exitCode = 1;
} else if (convergedAt != null) {
  console.log(`OK: 収束（sweep${convergedAt}で changed=[]）かつ袖柱本数が安定（${after}本）`);
}
