// 課題(k) k1c: 実データに「同座標に範囲違いの開口の源が 2 つ」の配置が無い（0 階）ため、静止状態の比較は検出力が無い。
// そこで開口の源が乗る軸 CL を、同じ向きの別の開口の源の軸 CL の座標へ commitCLMoveOp で動かして（辺を同座標に重ねて）
// から、本番と同じ並びの全階再計算（sweep）を収束まで（最大 maxSweeps 回）通し、試行ごとの収束回数と最後の位置キーを出す。
// 試行ごとに全階を restoreGraph で元へ戻す。修正前（HEAD の worktree）と修正後で同じスクリプトを走らせて比べる。
// 引数: <入力.stq> <出力.json> [maxSweeps=6]
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/kMoveSweepProbe.mjs D:/tatsuya/Download/opening-test.stq out.json
// 簡略化（実アプリとの差）: 結合（mergeCenterLineChain）・IDB への書込みは通さない。他階 peek は project.graphMap の生きたグラフ。
// 出力: { src, trials:[{plane,dir,from,to,convergedAt,counts:[sweepごとの開口梁芯数/梁数],final:{階:{axes,beams,columns}}}] }。既存出力は上書きしない。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel, roofMainStructure } from './sweepOrder.mjs';
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
if (!src || !outPath) { console.error('usage: kMoveSweepProbe.mjs <in.stq> <out.json> [maxSweeps]'); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
const maxSweeps = Number(maxArg ?? 6);
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');

const { project } = loadDocument(src);
await convergeProject(project);
const saved = new Map(project.planes.map(p => [p.id, serializeGraph(project.graphMap.get(p.id))]));

function snapshot() {
  const out = {};
  let open = 0, beams = 0;
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
  // restoreGraph は図形を作り直すため、試行ごとに id から CL を引き直す（先に引いた CL は古いオブジェクトになる）
  const plan = axes.map(cl => ({
    id: cl.id, type: cl.centerLineType, from: cl.value,
    // 行き先: 同じ向きの意匠・通り芯・補助線の座標すべて（辺を既存の辺・通り芯と同座標へ重ねる）
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
        rec = { plane: planeLabel(plane), dir: dirChar(cl), from: rnd(from), to: rnd(to), ...r, final: snapshot().out };
      } catch (e) {
        rec = { plane: planeLabel(plane), dir: dirChar(cl), from: rnd(from), to: rnd(to), error: String(e?.message ?? e) };
      } finally {
        for (const p of project.planes) restoreGraph(project.graphMap.get(p.id), saved.get(p.id));
      }
      trials.push(rec);
    }
  }
}
fs.writeFileSync(outPath, JSON.stringify({ src, maxSweeps, trials }, null, 1));
const nonConv = trials.filter(t => t.convergedAt == null && !t.error).length;
console.log(JSON.stringify({ src, trials: trials.length, nonConverged: nonConv, errors: trials.filter(t => t.error).length }));
