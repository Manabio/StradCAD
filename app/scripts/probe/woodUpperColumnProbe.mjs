// 在来木造の「上階柱直下の柱」(ステップ3b) 実データ計測用probe。
// QA裁定（2026-09-16 F7）：本番経路の証拠になるよう、計測は selfWallSegments／wallLineThroughRuns／
// pointsOnWallLines の本番実装を直接呼ぶ（自前複製はしない。旧版はgroupWallLines等を自前複製しており
// halfDepthの所在についてのコメントも古くなっていた）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodUpperColumnProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { CenterLineType, centerLineKind, columnSlotKey } from '../../src/core.js';
import { CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { selfWallSegments, wallRunSegments, peekBelowGraph, findBeamAnchorCL } from '../../src/structural/wallBeamAxes.js';
import { wallIntersectionPoints, wallLineThroughRuns, WALL_JUNCTION_TOL_MM } from '../../src/structural/woodAutoFill.js';
import { pointsOnWallLines } from '../../src/structural/woodFraming.js';
import { rulesFor, effectiveStructure, isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku1.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （woodWallBeamProbe.mjs等と同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

// 冪等収束チェック: 最大4スイープまで全階再計算を回し、changed=[]（変化した階が無い）になった回を
// 報告する（他3つのprobeと同じ形式。.claude/structural-model.md 3b節「結果整合性」）。以降の候補
// 計測（(i)〜(iv)）は、この収束後の安定状態に対して行う。
// QA裁定（F8）：期待値を固定する——非在来はsweep1で収束（changed=[]）しなければNG、
// 在来は昇順スイープ由来で3b・3dが互いに1スイープ遅れうるためsweep3までに収束しなければNG。
const MAX_SWEEPS = 4;
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
const isTraditional = isTraditionalWoodStructure(project.structuralInfo.mainStructure);
const convergeLimit = isTraditional ? 3 : 1;
if (convergedAt != null && convergedAt <= convergeLimit) {
  console.log(`OK: 収束（sweep${convergedAt} で changed=[]。changed があったスイープ数=${changedSweeps}）`);
} else if (convergedAt != null) {
  console.log(`NG: 収束はしたが遅すぎる（sweep${convergedAt}。期待はsweep${convergeLimit}以内）`);
  process.exitCode = 1;
} else {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
}

function aboveGraphOf(graph) {
  const planes = project.planes; // elevation昇順
  const idx = planes.findIndex(p => p.id === graph.plane.id);
  if (idx < 0 || idx + 1 >= planes.length) return null;
  return project.graphMap.get(planes[idx + 1].id);
}

// 壁のある意匠中心線アンカー（woodAutoFill.jsのfindCenterAnchorCLと同じ述語。private実装のため複製）。
function findCenterAnchorCL(graph, centerLineType, coord) {
  return graph.centerLines.find(cl =>
    cl.centerLineType === centerLineType &&
    centerLineKind(cl) === 'center' &&
    Math.abs(cl.effectiveValue - coord) < CL_OVERLAP_TOL_MM) ?? null;
}
// 3b本番と同じ2段のアンカー解決（QA F2で寄せは廃止済み）。
function resolveAnchor(graph, centerLineType, coord) {
  return findBeamAnchorCL(graph, centerLineType, coord) ?? findCenterAnchorCL(graph, centerLineType, coord);
}

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

let totalAbove = 0, totalInBandAndRun = 0, totalSameAs3a = 0;
const anchorCounts = { exact: 0, unresolved: 0 };

for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  const structure = effectiveStructure(graph, project);
  if (!isTraditionalWoodStructure(structure)) continue;

  const aboveGraph = aboveGraphOf(graph);
  const aboveColumns = aboveGraph ? aboveGraph.columns.filter(c => c.role !== 'foundation') : [];
  totalAbove += aboveColumns.length;
  if (aboveColumns.length === 0) continue;

  // 本番と同じ入力（selfWallSegments・wallRunSegments・wallLineThroughRuns・pointsOnWallLines）。
  const selfSegs = selfWallSegments(graph);
  const belowGraph = await peekBelowGraph(graph, project);
  const runSegs = wallRunSegments(graph, belowGraph, structure);
  const lineRuns = wallLineThroughRuns(runSegs);

  // 3aの交点候補スロット（本番のautoFillWoodColumnsと同じ列挙。既存柱の有無は見ない＝候補集合のみ）。
  const slots3a = new Set();
  for (const p of wallIntersectionPoints(selfSegs)) {
    const v = resolveAnchor(graph, CenterLineType.VERTICAL, p.x);
    const h = resolveAnchor(graph, CenterLineType.HORIZONTAL, p.y);
    if (v && h) slots3a.add(columnSlotKey(v, h));
  }

  // 本番のpointsOnWallLines（全一致を返す）に、本番と同じ決定的タイブレーク（run優先→dist最小→
  // coord昇順）を適用して1点につき1件へ絞る（woodAutoFill.js autoFillWoodColumnsと同じロジック）。
  const points = aboveColumns.map(c => ({ x: c.x, y: c.y }));
  const bestByPoint = new Map();
  for (const m of pointsOnWallLines(points, selfSegs, WALL_JUNCTION_TOL_MM)) {
    const key = `${m.x}:${m.y}`;
    const line = lineRuns.find(l => l.isVertical === m.isVertical && Math.abs(l.coord - m.coord) < CL_OVERLAP_TOL_MM);
    const inRun = !!line?.runs.some(r => m.along >= r.lo - CL_OVERLAP_TOL_MM && m.along <= r.hi + CL_OVERLAP_TOL_MM);
    const candidate = { ...m, inRun };
    const cur = bestByPoint.get(key);
    if (!cur
      || (candidate.inRun && !cur.inRun)
      || (candidate.inRun === cur.inRun && candidate.dist < cur.dist)
      || (candidate.inRun === cur.inRun && candidate.dist === cur.dist && candidate.coord < cur.coord)) {
      bestByPoint.set(key, candidate);
    }
  }

  let inBandAndRun = 0, sameAs3a = 0;
  for (const best of bestByPoint.values()) {
    if (!best.inRun) continue;
    inBandAndRun++;
    totalInBandAndRun++;

    const axisType = best.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const crossType = best.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const axisCL = resolveAnchor(graph, axisType, best.coord);
    const crossCL = resolveAnchor(graph, crossType, best.along);
    if (axisCL && crossCL) {
      const key = best.isVertical ? columnSlotKey(axisCL, crossCL) : columnSlotKey(crossCL, axisCL);
      if (slots3a.has(key)) { sameAs3a++; totalSameAs3a++; }
      anchorCounts.exact++;
    } else {
      anchorCounts.unresolved++;
    }
  }

  console.log(`[${plane.name}] 上階柱=${aboveColumns.length} 帯内かつrun内=${inBandAndRun} うち3a同一スロット=${sameAs3a}`);
}

console.log('--- 集計 ---');
console.log('上階柱の総数:', totalAbove);
console.log('自階壁の下地帯内かつrun内の数:', totalInBandAndRun);
console.log('うち3a柱と同スロット:', totalSameAs3a);
console.log('アンカー内訳(帯内かつrun内の候補のみ。QA F2で寄せは廃止済み・2区分):', anchorCounts);
const unresolvedRatio = totalInBandAndRun > 0 ? anchorCounts.unresolved / totalInBandAndRun : 0;
console.log('解決不能の割合:', (unresolvedRatio * 100).toFixed(1) + '%');
if (unresolvedRatio > 0.1) {
  console.log('NG: 解決不能が候補の1割超');
  process.exitCode = 1;
}
