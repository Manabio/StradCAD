// 材コード振り直し（ステップ3b・catalog/legacyMaterialCodes.js）の実データ検証probe。
// wallRefreshProbe.mjs / structAnchorProbe.mjs / sweepOrder.mjs と同じ関数列
// （conformWoodBacking→wallFreshnessKey比較→resolveStairContext→regenerateWalls→
// wallBackingCenters/mapBackingCenterMoves→followWallBeamAxes→鍵確定→
// 全階 sweepUntilConverged('desc')）を通し、壁・柱・梁の安定ダンプ（idを除く位置・寸法）と
// 各階の下地材コード4フィールド（exterior/interior/ceiling/floorBacking）を出す。
//
// 【検出力の限界（2026-09-22）】在来木造文書（例: moku4.stq）の exteriorWallBacking/
// interiorWallBacking は、本probeが通す conformWoodBacking（structural/woodAutoFill.js）が
// 柱寸法(graph.woodColumnWidthMm)から都度フレッシュに導出して上書きする——normalizeMaterialCode
// による振り直し結果を経由しても最終的に conformWoodBacking の出力で置き換わるため、
// 「対応表の当該2フィールドの誤り」はこの2フィールドでは検出できない。ceilingBacking/
// floorBackingはconformWoodBackingが触らないため常に検出できる。exterior/interiorWallBacking
// の誤りは、conformWoodBackingが発火しない非在来木造文書（rules.framing/backingが無い構造。
// 例: 13.stq＝S造）の壁側で検出する（実測: 13.stqのexteriorWallBackingは振り直し結果が
// そのまま残る）。両フィールドの検出力を確保するには moku4.stq（ceiling/floor向け）と
// 13.stq（exterior/interior向け）の両方を通すこと。
//
// 【golden系との位置づけ】既存の golden JSON（golden13/struct-*.json・golden-regen/等）は
// 材コードを一切含まない（検出力ゼロ）。本probeが材コード振り直しに対する唯一の実データ検証。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/matCodeProbe.mjs <入力.stq> [出力.json]
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { Project } from '../../src/core.js';
import { restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { structuralPlaneBelow } from '../../src/structural/drawingDesignation.js';
import { backingClassOf } from '../../src/finish/materials/backingClass.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const src = process.argv[2];
const outFile = process.argv[3] ?? null;
if (!src) {
  console.error('使い方: node --import ./scripts/testSetup.mjs scripts/probe/matCodeProbe.mjs <入力.stq> [出力.json]');
  process.exit(1);
}

function loadDocument(p) {
  const doc = parseDocumentEnvelope(JSON.parse(fs.readFileSync(p, 'utf8')));
  const project = new Project('probe', 'probe');
  if (doc.struct) restoreStructCLs(project.structGraph, project.structuralInfo, doc.struct, project.memberGroupLedger);
  const { planes, activePlaneId } = doc.planes ? decodePlanes(doc.planes) : { planes: [], activePlaneId: null };
  for (const p2 of planes) {
    project.addPlane(p2.elevation, p2.name, p2.id, p2.startFloor, p2.stories,
      p2.isAlternative, p2.referenceId, p2.altIndex, p2.isRoofPlane, p2.roofForPlaneId);
  }
  for (const f of doc.floors) {
    const graph = project.graphMap.get(f.planeId);
    if (!graph) continue;
    restoreGraph(graph, f.bytes);
  }
  if (activePlaneId && project.planeMap.has(activePlaneId)) project.activePlaneId = activePlaneId;
  return { project, doc };
}

const { project } = loadDocument(src);
const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
floorSwapManager.peek = graphMapPeek;

const materialMap = await loadMaterialMap();

async function runSweep() {
  const changedPlaneIds = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (graph.wallFreshnessKey == null && graph.walls.length === 0) continue;
    runInAction(() => conformWoodBacking(graph, project));
    const keyNow = wallFreshnessKey(graph, project);
    if (keyNow === graph.wallFreshnessKey) continue;
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = wallBackingCenters(graph);
    const { regenerated } = await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    if (!regenerated) continue;
    const moves = mapBackingCenterMoves(before, wallBackingCenters(graph));
    if (moves.length > 0) followWallBeamAxes(graph, moves);
    graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
    changedPlaneIds.push(p.id);
  }
  return changedPlaneIds;
}

function roofMainStructure() {
  const roofPlane = project.roofPlane;
  if (!roofPlane) return null;
  const topPlane = structuralPlaneBelow(roofPlane, project);
  const topGraph = topPlane ? project.graphMap.get(topPlane.id) : null;
  return topGraph ? (topGraph.structureOverride ?? project.structuralInfo.mainStructure) : project.structuralInfo.mainStructure;
}

async function sweepUntilConverged(order, maxSweeps = 8) {
  const roofPlane = project.roofPlane;
  const includeRoof = !!roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure);
  const realPlanes = order === 'desc' ? [...project.planes].reverse() : project.planes;
  const planes = includeRoof
    ? (order === 'desc' ? [roofPlane, ...realPlanes] : [...realPlanes, roofPlane])
    : realPlanes;
  for (let i = 1; i <= maxSweeps; i++) {
    const changedPlanes = [];
    for (const p of planes) {
      const g = project.graphMap.get(p.id);
      const mainStructure = p.isRoofPlane ? roofMainStructure() : (g.structureOverride ?? project.structuralInfo.mainStructure);
      const { changed } = await recomputeStructuralForGraph(g, project, mainStructure);
      if (changed) changedPlanes.push(p.name);
    }
    if (changedPlanes.length === 0) return i;
  }
  return null;
}

const t0 = performance.now();
await runSweep();
const converged = await sweepUntilConverged('desc');
const t1 = performance.now();
if (converged == null) console.error(`警告: 構造再計算が収束しなかった: ${src}`);

const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);

function dumpPlane(graph) {
  const walls = graph.walls.map(w => [
    w.isVertical, r(w.axisValue), r(w.coord1), r(w.coord2),
    r(w.materialRange?.lo ?? null), r(w.materialRange?.hi ?? null),
    w.isExteriorWall, r(w.wallFinish), r(w.backingOffset), r(w.backingDepth), r(w.bandOffset),
  ].join(':')).sort();
  const columns = (graph.columns ?? []).map(c => [
    c.role ?? null, r(c.x), r(c.y), r(c.axisX), r(c.axisY),
  ].join(':')).sort();
  const beams = (graph.beams ?? []).map(b => [
    b.role ?? null, b.isVertical, r(b.axisValue), r(b.clStart?.effectiveValue ?? null), r(b.clEnd?.effectiveValue ?? null),
  ].join(':')).sort();
  return {
    backing: {
      exteriorWallBacking: graph.exteriorWallBacking,
      interiorWallBacking: graph.interiorWallBacking,
      ceilingBacking: graph.ceilingBacking,
      floorBacking: graph.floorBacking,
      exteriorWallBackingClass: backingClassOf(graph.exteriorWallBacking),
    },
    wallCount: walls.length, columnCount: columns.length, beamCount: beams.length,
    walls, columns, beams,
  };
}

const out = {};
for (const p of project.orderedTabs) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  out[p.name] = dumpPlane(graph);
}

const result = { perf_ms: Math.round((t1 - t0) * 100) / 100, converged, planes: out };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(JSON.stringify({
  perf_ms: result.perf_ms, converged,
  summary: Object.entries(out).map(([name, d]) => ({
    name, walls: d.wallCount, columns: d.columnCount, beams: d.beamCount,
    exteriorWallBacking: d.backing.exteriorWallBacking, ceilingBacking: d.backing.ceilingBacking,
    floorBacking: d.backing.floorBacking,
  })),
}, null, 1));
