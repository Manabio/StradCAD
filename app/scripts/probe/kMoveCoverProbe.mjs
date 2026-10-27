// 課題(k) k2: kMoveSweepProbe.mjs の拡張。試行ごとに「開口の辺が梁で覆われているか」も測る（k2＝直交辺の端のつなぎ先が
// 範囲を見ず、同じ線上に並ぶ2つ目の開口の直交する辺に梁が乗らない件の効果測定）。
// 開口の源が乗る軸 CL を、同じ向きの別の中心線の座標へ commitCLMoveOp で動かし、本番と同じ並びの全階再計算（sweep）を
// 収束まで（最大 maxSweeps 回）通し、試行ごとの収束回数・覆われない辺（measurePlane の coveredLen < edgeLen）・最後の位置キーを出す。
// 試行ごとに全階を restoreGraph で元へ戻す。修正前（HEAD の worktree にこのファイルを置く）と修正後で同じスクリプトを走らせ、
// kMoveCoverCompare.mjs で比べる。
// 引数: <入力.stq> <出力.json> [maxSweeps=6]
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/kMoveCoverProbe.mjs D:/tatsuya/Download/opening-test.stq out.json
// 簡略化（実アプリとの差）: 結合（mergeCenterLineChain）・IDB への書込みは通さない。他階 peek は project.graphMap の生きたグラフ。
// 出力: { src, maxSweeps, base:{edges,partial,zero,uncovered}, trials:[{plane,dir,from,to,convergedAt,counts,edges,partial,zero,uncovered,final}] }。
//   既存出力は上書きしない。標準出力に試行数・未収束数・エラー数・覆われない辺ありの試行数の要約を1行出す。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel, roofMainStructure } from './sweepOrder.mjs';
import { measurePlane } from './kOpeningBeamProbe.mjs';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure, effectiveStructure, rulesFor } from '../../src/structural/structureRules.js';
import { openingBeamSourcesFor } from '../../src/structural/openingBeamAxes.js';
import { belowPlaneOf } from '../../src/structural/wallBeamAxes.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { BeamAxisOrigin, centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';

const [src, outPath, maxArg] = process.argv.slice(2);
if (!src || !outPath) { console.error('usage: kMoveCoverProbe.mjs <in.stq> <out.json> [maxSweeps]'); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
const maxSweeps = Number(maxArg ?? 6);
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');

const { project } = loadDocument(src);
await convergeProject(project);
const saved = new Map(project.planes.map(p => [p.id, serializeGraph(project.graphMap.get(p.id))]));

function snapshot() {
  const out = {}; let open = 0, beams = 0;
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    const axes = g.centerLines.filter(c => centerLineKind(c) === 'beam')
      .map(c => `${dirChar(c)}:${rnd(c.effectiveValue)}:${c.beamAxisOrigin ?? '-'}:${rnd(c.extentLo)}:${rnd(c.extentHi)}`).sort();
    const beamKeys = g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${rnd(b.axisValue)}:${rnd(b.clStart.effectiveValue)}:${rnd(b.clEnd.effectiveValue)}`).sort();
    out[planeLabel(p)] = { axes, beams: beamKeys, columns: g.columns.map(c => `${rnd(c.axisX)}:${rnd(c.axisY)}:${c.role ?? '-'}`).sort() };
    open += g.centerLines.filter(c => c.beamAxisOrigin === BeamAxisOrigin.OPENING).length;
    beams += g.beams.length;
  }
  return { out, open, beams };
}
function cover() {
  let edges = 0, partial = 0, zero = 0; const uncovered = [];
  for (const p of project.planes) {
    const m = measurePlane(p, project);
    for (const e of m.edges) {
      edges++;
      if (e.coveredLen < e.edgeLen - 1) { partial++; if (e.coveredLen < 1) zero++; uncovered.push(`${p.name}|${e.key}|${e.status}|${e.coveredLen}/${e.edgeLen}`); }
    }
  }
  return { edges, partial, zero, uncovered };
}
async function sweeps() {
  const roofPlane = project.roofPlane;
  const includeRoof = !!roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure);
  const real = [...project.planes].reverse();
  const planes = includeRoof ? [roofPlane, ...real] : real;
  const counts = [];
  for (let i = 1; i <= maxSweeps; i++) {
    let any = false;
    for (const p of planes) {
      const g = project.graphMap.get(p.id);
      const ms = p.isRoofPlane ? roofMainStructure(project) : (g.structureOverride ?? project.structuralInfo.mainStructure);
      const { changed } = await recomputeStructuralForGraph(g, project, ms);
      if (changed) any = true;
    }
    const s = snapshot();
    counts.push(`${s.open}/${s.beams}`);
    if (!any) return { convergedAt: i, counts };
  }
  return { convergedAt: null, counts };
}

const base = cover();
const trials = [];
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  const rules = rulesFor(effectiveStructure(graph, project));
  if (rules.openingBeamAxes !== 'slabOpenings') continue;
  const belowPlane = belowPlaneOf(plane, project);
  const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
  const sources = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
  const axisIds = [...new Set(sources.map(s => s.axisCLId).filter(Boolean))];
  const axes = axisIds.map(id => graph.shapeMap.get(id)).filter(cl => cl && cl.value != null && centerLineKind(cl) !== 'beam');
  const plan = axes.map(cl => ({
    id: cl.id, type: cl.centerLineType, from: cl.value,
    targets: [...new Set(graph.centerLines
      .filter(o => o !== cl && o.centerLineType === cl.centerLineType && centerLineKind(o) !== 'beam' && o.value != null && Math.abs(o.value - cl.value) > 0.5)
      .map(o => o.value))],
  }));
  for (const { id, from, targets } of plan) {
    for (const to of targets) {
      const cl = graph.shapeMap.get(id);
      let rec;
      try {
        runInAction(() => { cl.pendingDelta = to - from; });
        commitCLMoveOp(graph, project, cl, from);
        const r = await sweeps();
        const c = cover();
        rec = { plane: planeLabel(plane), dir: dirChar(cl), from: rnd(from), to: rnd(to), ...r, edges: c.edges, partial: c.partial, zero: c.zero, uncovered: c.uncovered, final: snapshot().out };
      } catch (e) {
        rec = { plane: planeLabel(plane), dir: dirChar(cl), from: rnd(from), to: rnd(to), error: String(e?.message ?? e) };
      } finally {
        for (const p of project.planes) restoreGraph(project.graphMap.get(p.id), saved.get(p.id));
      }
      trials.push(rec);
    }
  }
}
fs.writeFileSync(outPath, JSON.stringify({ src, maxSweeps, base, trials }, null, 1));
console.log(JSON.stringify({ src, trials: trials.length, nonConverged: trials.filter(t => t.convergedAt == null && !t.error).length, errors: trials.filter(t => t.error).length, uncoveredTrials: trials.filter(t => t.partial > 0).length }));
