// 課題(k) k1b（cl-conversion-limits.md 限界16 (k)）: 開口由来梁芯の追従（followWallBeamAxes の openingMoves 経路）の実測。
// 目的: hFollowProbe.mjs は壁由来梁芯の合成 moves と壁の帯の moves だけで、開口由来の moves（openingMoves）を流さない。
//   ここでは全階を収束まで再計算した後、次の2通りで followWallBeamAxes の結果（moved／absorbed／skipped）を出す。
//   A（synthetic:true）: 由来 OPENING の梁芯ごとに、同方向の梁芯・通り芯の座標 ＋ ±30 ＋ ±300 を行き先とする合成 move を直接渡す。
//   B（synthetic:false）: 開口の源（openingBeamSourcesFor）が乗る軸 CL を ±30・±300・同方向の梁芯／通り芯の座標へ bake し、
//      commitCLMoveOp と同じ手順（bake 前後の壁帯・開口源 → mapBackingCenterMoves／mapOpeningSourceMoves →
//      followWallBeamAxes(repointRefsFrom:true)）の結果を出す。openingBeamAxes が 'slabOpenings' でない階は B を行わない。
//   試行ごとに restoreGraph で元へ戻す。HEAD の worktree と作業ツリーで同じスクリプトを走らせて差分を取る。
// 簡略化（実アプリとの差）: 結合（mergeCenterLineChain）・belowGraph（階段由来の開口源）・構造同期は通さない。
// 引数: <入力.stq> [出力.json]
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/hFollowOpeningProbe.mjs D:/tatsuya/Download/moku4.stq out.json
// 出力: { src, planes:[{plane,structure,openingMovesEnabled,trials:[...]}], tally }。比較キーは (plane,cl,dir,from,delta,synthetic)。
// lint 対象外（.mjs）。未使用 import・未定義参照は目視で確認すること。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import {
  wallBackingCenters, mapBackingCenterMoves, findWallBeamAxisCL,
} from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { openingBeamSourcesFor, mapOpeningSourceMoves } from '../../src/structural/openingBeamAxes.js';
import { effectiveStructure, rulesFor } from '../../src/structural/structureRules.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { BeamAxisOrigin, centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { bakeCLValue } from '../../src/transform/centerLineOps.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('hFollowOpeningProbe.mjs');
const short = (id) => (id ? id.slice(0, 8) : null);
const dirOf = (m) => (m.isVertical ? 'V' : 'H');

function digest(graph) {
  return JSON.stringify(graph.centerLines.map(cl => [cl.id, cl.centerLineType, rnd(cl.effectiveValue), rnd(cl.extentLo), rnd(cl.extentHi)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function candidatesAt(graph, centerLineType, to) {
  return graph.centerLines
    .filter(o => o.centerLineType === centerLineType && Math.abs(o.effectiveValue - to) < 0.5 && ['beam', 'struct'].includes(centerLineKind(o)))
    .map(o => `${short(o.id)}:${centerLineKind(o)}:${o.beamAxisOrigin ?? '-'}:[${rnd(o.extentLo)},${rnd(o.extentHi)}]`).sort();
}

function summarize(r) {
  return {
    moved: r.moved.map(m => `${short(m.clId)} ${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
    absorbed: r.absorbed.map(m => `${short(m.clId)} ${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
    skipped: r.skipped.map(m => `${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)} ${m.reason}`).sort(),
  };
}

function targetsFor(graph, cl, from) {
  const t = new Set([from + 30, from - 30, from + 300, from - 300]);
  for (const o of graph.centerLines) {
    if (o.centerLineType !== cl.centerLineType || o.id === cl.id) continue;
    const k = centerLineKind(o);
    if (k !== 'beam' && k !== 'struct') continue;
    if (Math.abs(o.effectiveValue - from) > 0.5) t.add(o.effectiveValue);
  }
  return [...t].sort((a, b) => a - b);
}

export function measureFollowOpening(plane, project) {
  const graph = project.graphMap.get(plane.id);
  const structure = effectiveStructure(graph, project);
  const enabled = rulesFor(structure).openingBeamAxes === 'slabOpenings';
  const trials = [];
  const bytes = serializeGraph(graph);
  const baseDigest = digest(graph);
  const sourcesOpts = { riserOf: (s) => stairRiserOf(s, project, graph.plane), belowGraph: null };

  // A: 由来 OPENING の梁芯からの合成 moves
  const seen = new Set();
  for (const cl of graph.centerLines) {
    if (cl.beamAxisOrigin !== BeamAxisOrigin.OPENING) continue;
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const from = cl.effectiveValue;
    const key = `${isVertical}:${rnd(from)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const actual = findWallBeamAxisCL(graph, isVertical, from);
    for (const to of targetsFor(graph, cl, from)) {
      let result = null;
      const at = candidatesAt(graph, cl.centerLineType, to);
      try {
        runInAction(() => {
          result = summarize(followWallBeamAxes(graph, [{ axisCLId: 'synthetic', isVertical, from, to }], { repointRefsFrom: true }));
        });
      } finally { restoreGraph(graph, bytes); }
      trials.push({ cl: short(cl.id), actualOrigin: actual?.beamAxisOrigin ?? null, dir: isVertical ? 'V' : 'H', from: rnd(from), delta: rnd(to - from),
        synthetic: true, extentLo: rnd(actual?.extentLo), extentHi: rnd(actual?.extentHi), toCandidates: at, ...result, restored: digest(graph) === baseDigest });
    }
  }

  // B: 開口源の軸 CL を bake して commitCLMoveOp と同じ手順で追従
  if (enabled) {
    const axisIds = new Set(openingBeamSourcesFor(graph, project, sourcesOpts).map(s => s.axisCLId).filter(Boolean));
    for (const id of axisIds) {
      const cl = graph.shapeMap.get(id);
      if (!cl || cl.value == null) continue;
      const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
      const from = cl.value;
      for (const to of targetsFor(graph, cl, from)) {
        let result = null;
        const at = candidatesAt(graph, cl.centerLineType, to);
        try {
          runInAction(() => {
            const backingBefore = wallBackingCenters(graph);
            const openingBefore = openingBeamSourcesFor(graph, project, sourcesOpts);
            bakeCLValue(cl, to);
            const moves = [
              ...mapBackingCenterMoves(backingBefore, wallBackingCenters(graph)),
              ...mapOpeningSourceMoves(openingBefore, openingBeamSourcesFor(graph, project, sourcesOpts)),
            ];
            result = { moves: moves.map(m => `${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(), ...summarize(followWallBeamAxes(graph, moves, { repointRefsFrom: true })) };
          });
        } finally { restoreGraph(graph, bytes); }
        trials.push({ cl: short(cl.id), dir: isVertical ? 'V' : 'H', from: rnd(from), delta: rnd(to - from), synthetic: false, toCandidates: at, ...result, restored: digest(graph) === baseDigest });
      }
    }
  }
  return { plane: plane.name, structure, openingMovesEnabled: enabled, trials };
}

if (isMain) {
  const src = process.argv[2];
  const outPath = process.argv[3] ?? null;
  if (!src) { console.error('usage: hFollowOpeningProbe.mjs <in.stq> [out.json]'); process.exit(1); }
  const { project } = loadDocument(src);
  const conv = await convergeProject(project);
  const planes = project.planes.map(p => measureFollowOpening(p, project));
  const tally = { trials: 0, synthetic: 0, real: 0, withMoves: 0, moved: 0, absorbed: 0, skipped: 0, notRestored: 0 };
  for (const pl of planes) {
    for (const t of pl.trials) {
      tally.trials++;
      if (t.synthetic) tally.synthetic++; else tally.real++;
      if (!t.synthetic && t.moves.length) tally.withMoves++;
      tally.moved += t.moved.length; tally.absorbed += t.absorbed.length; tally.skipped += t.skipped.length;
      if (!t.restored) tally.notRestored++;
    }
  }
  const out = { src, convergedSweeps: conv, planes, tally };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ src, convergedSweeps: conv, structures: planes.map(p => `${p.plane}:${p.structure}:${p.trials.length}`), tally }));
}
