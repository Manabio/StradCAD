// 課題(h)（cl-conversion-limits.md 限界16 (h)）S0: 壁由来梁芯のアンカー解決に範囲判定が無いことの実データ計測。
// 目的: 全階を収束まで再計算した後、壁源（wallBeamSourcesFor の統合後）ごとに findBeamAnchorCL が返した
//   アンカーの種別・由来・extent と、壁区間（直交通り芯へブラケット後の範囲 bracketExtent）に対する被覆
//   （覆う／一部重なる／重ならない／アンカーなし）を数え、由来別・主構造別に集計する。読み取り専用。
// 引数: <入力.stq> [出力.json]  （出力省略時は標準出力へJSON）
// 前処理: structAnchorProbe.mjs と同じ（conformWoodBacking→壁再生成→梁芯追従→sweepUntilConverged 'desc'）。
//   他階 peek は project.graphMap の生きたグラフ（structAnchorProbe.mjs と同じ限界）。IDBへは書かない。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/hAnchorCoverageProbe.mjs D:/tatsuya/Download/moku4.stq out.json
// 出力: { src, planes:[{plane,effectiveStructure,wallBeamAxes,sources:[...]}], tally:{...} }
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap, regenerateWalls } from '../../src/finish/wallRegeneration.js';
import { wallFreshnessKey } from '../../src/finish/wallFreshnessKey.js';
import { resolveStairContext } from '../../src/finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from '../../src/structural/woodAutoFill.js';
import {
  wallBackingCenters, mapBackingCenterMoves, wallBeamSourcesFor, belowPlaneOf, findBeamAnchorCL, bracketExtent,
} from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { effectiveStructure, rulesFor } from '../../src/structural/structureRules.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType, CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('hAnchorCoverageProbe.mjs');
const src = isMain ? process.argv[2] : null;
const outPath = isMain ? (process.argv[3] ?? null) : null;
if (isMain && !src) { console.error('usage: hAnchorCoverageProbe.mjs <in.stq> [out.json]'); process.exit(1); }

export const rnd = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);

/** project を収束まで再計算する（structAnchorProbe.mjs と同じ前処理）。 */
export async function convergeProject(project) {
  const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
  floorSwapManager.peek = graphMapPeek;
  const materialMap = await loadMaterialMap();
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
  }
  return sweepUntilConverged(project, 'desc');
}

/** 壁源ごとのアンカー被覆を採る。 */
export function measurePlane(plane, project) {
  const graph = project.graphMap.get(plane.id);
  const structure = effectiveStructure(graph, project);
  const mode = rulesFor(structure).wallBeamAxes;
  const belowPlane = belowPlaneOf(plane, project);
  const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
  const sources = wallBeamSourcesFor(graph, project, belowGraph);
  const rows = sources.map(s => {
    const type = s.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const gridCLs = s.isVertical ? graph.gridYs : graph.gridXs;
    const { loCL, hiCL } = bracketExtent(gridCLs, s.lo, s.hi);
    const rLo = loCL ? loCL.effectiveValue : s.lo;
    const rHi = hiCL ? hiCL.effectiveValue : s.hi;
    const anchor = findBeamAnchorCL(graph, type, s.coord);
    let kind = null, origin = null, eLo = null, eHi = null, coverage = 'none';
    if (anchor) {
      kind = centerLineKind(anchor);
      origin = anchor.beamAxisOrigin ?? null;
      eLo = anchor.extentLo; eHi = anchor.extentHi;
      const lo = eLo == null ? -Infinity : eLo, hi = eHi == null ? Infinity : eHi;
      const tol = CL_OVERLAP_TOL_MM;
      if (kind === 'struct' || (lo <= rLo + tol && hi >= rHi - tol)) coverage = 'cover';
      else if (Math.min(hi, rHi) - Math.max(lo, rLo) > tol) coverage = 'partial';
      else coverage = 'disjoint';
    }
    return {
      dir: s.isVertical ? 'V' : 'H', coord: rnd(s.coord), srcLo: rnd(s.lo), srcHi: rnd(s.hi), bracketLo: rnd(rLo), bracketHi: rnd(rHi),
      anchorKind: kind, anchorOrigin: origin, anchorExtentLo: rnd(eLo), anchorExtentHi: rnd(eHi), coverage,
    };
  });
  return { plane: plane.name, effectiveStructure: structure, wallBeamAxes: mode, sources: rows };
}

export function tallyOf(planes) {
  const t = {};
  for (const pl of planes) {
    for (const r of pl.sources) {
      const key = `${pl.effectiveStructure}|${pl.wallBeamAxes}|kind=${r.anchorKind}|origin=${r.anchorOrigin}|${r.coverage}`;
      t[key] = (t[key] ?? 0) + 1;
    }
  }
  return t;
}

if (isMain) {
  const { project } = loadDocument(src);
  const conv = await convergeProject(project);
  const planes = project.planes.map(p => measurePlane(p, project));
  const out = { src, mainStructure: project.structuralInfo?.mainStructure ?? null, convergedSweeps: conv, planes, tally: tallyOf(planes) };
  const text = JSON.stringify(out, null, 1);
  if (outPath) fs.writeFileSync(outPath, text); else console.log(text);
  console.error(`${src}: 収束sweep=${conv}`);
  for (const pl of planes) console.error(`  ${pl.plane}: ${pl.effectiveStructure} wallBeamAxes=${pl.wallBeamAxes} 壁源=${pl.sources.length}`);
  for (const [k, n] of Object.entries(out.tally)) console.error(`  ${n}\t${k}`);
}
