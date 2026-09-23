// 断面マスター（structural/sectionCatalog.js）の実データ検証probe。
// matCodeProbe.mjs / matCodeDiff.mjs と同じ実行形式・ヘッダ・終了コード規約・同じ関数列
// （conformWoodBacking→wallFreshnessKey比較→resolveStairContext→regenerateWalls→
// wallBackingCenters/mapBackingCenterMoves→followWallBeamAxes→全階 sweepUntilConverged('desc')）を通し、
// 柱・梁・耐力壁・スラブ・基礎の sectionDefId と、断面マスターから解決した値（柱の width/height/
// diaphragmProjection、梁のsectionWidth）の安定ダンプ（idを除く位置・寸法基準のキー）を出す。
//
// 【golden系との位置づけ】既存の golden JSON（golden13/struct-*.json 等）は断面カタログ由来の
// 寸法（findSectionEntry の解決結果）を一切含まない（columns/beamsは id・role・memberNo のみで
// sectionDefIdの解決値を持たない）ため検出力ゼロ——本probeが断面カタログ変更に対する唯一の
// 実データ検証（ステップ8a・2026-09-23）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/sectionProbe.mjs <入力.stq> [出力.json]
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
import { findSectionEntry, diaphragmProjection } from '../../src/structural/sectionCatalog.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const src = process.argv[2];
const outFile = process.argv[3] ?? null;
if (!src) {
  console.error('使い方: node --import ./scripts/testSetup.mjs scripts/probe/sectionProbe.mjs <入力.stq> [出力.json]');
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

// footingの種別（新規サブクラスを増やさない既存規約: 'footingType' in entity が独立フーチング）。
function footingKind(f) {
  return 'footingType' in f ? 'independent' : 'base';
}

// 解決断面の寸法系フィールドを丸ごと安定文字列化する（幅・成に加え、H形鋼のweb/flange厚・
// 角形鋼管のwallThicknessも含む——sectionWidthやwidth/heightだけでは変化しないカタログ改変
// （例: webThicknessのみの変更）も本probeで検出できるようにするため。keyが無い/null=断面未解決）。
function secDims(sec) {
  if (!sec) return 'null';
  return [r(sec.width ?? null), r(sec.height ?? null), r(sec.webThickness ?? null), r(sec.flangeThickness ?? null), r(sec.wallThickness ?? null)].join(',');
}

function dumpPlane(graph) {
  const unresolved = new Set();
  const noteUnresolved = (sectionDefId) => {
    if (sectionDefId != null && !findSectionEntry(sectionDefId)) unresolved.add(sectionDefId);
  };

  const columns = (graph.columns ?? []).map(c => {
    noteUnresolved(c.sectionDefId);
    const sec = findSectionEntry(c.sectionDefId);
    return [
      c.role ?? null, r(c.x), r(c.y), r(c.axisX), r(c.axisY),
      c.sectionDefId ?? null, secDims(sec), r(diaphragmProjection(sec)),
      c.memberNo ?? null,
    ].join(':');
  }).sort();

  const beams = (graph.beams ?? []).map(b => {
    noteUnresolved(b.sectionDefId);
    const sec = findSectionEntry(b.sectionDefId);
    return [
      b.role ?? null, b.isVertical, r(b.axisValue), r(b.clStart?.effectiveValue ?? null), r(b.clEnd?.effectiveValue ?? null),
      b.sectionDefId ?? null, r(b.sectionWidth), secDims(sec), b.memberNo ?? null,
    ].join(':');
  }).sort();

  const structuralWalls = (graph.structuralWalls ?? []).map(w => {
    noteUnresolved(w.sectionDefId);
    return [
      w.materialType ?? null, w.isVertical, r(w.axisValue), r(w.coord1), r(w.coord2),
      w.sectionDefId ?? null, findSectionEntry(w.sectionDefId) != null,
    ].join(':');
  }).sort();

  const slabs = (graph.slabs ?? []).map(s => {
    noteUnresolved(s.sectionDefId);
    return [
      s.materialType ?? null, s.role ?? null, s.slabKind ?? null, s.deckDirection ?? null,
      r(s.thickness), s.cells?.size ?? 0,
      s.sectionDefId ?? null, findSectionEntry(s.sectionDefId) != null,
    ].join(':');
  }).sort();

  const footings = (graph.footings ?? []).map(f => {
    noteUnresolved(f.sectionDefId);
    return [
      footingKind(f), f.materialType ?? null, r(f.x), r(f.y), f.sectionShape ?? null, r(f.widthX), r(f.widthY),
      f.sectionDefId ?? null, findSectionEntry(f.sectionDefId) != null,
    ].join(':');
  }).sort();

  return {
    columnCount: columns.length, beamCount: beams.length,
    wallCount: structuralWalls.length, slabCount: slabs.length, footingCount: footings.length,
    columns, beams, structuralWalls, slabs, footings,
    unresolvedSectionIds: [...unresolved].sort(),
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
    name, columns: d.columnCount, beams: d.beamCount, walls: d.wallCount, slabs: d.slabCount, footings: d.footingCount,
    unresolvedSectionIds: d.unresolvedSectionIds,
  })),
}, null, 1));
