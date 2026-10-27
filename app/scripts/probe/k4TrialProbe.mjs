// 課題(k) k4: 線の移動試行の比較用。線を動かす→追従の直後→本番と同じ並びの全階再計算を収束まで→最後の配置、を試行ごとに出す。
// 試行ごとに全階を restoreGraph で元へ戻す。修正前（worktree）と修正後で同じスクリプトを走らせ、k4TrialCompare.mjs で比べる。
// 出すもの（試行ごと）: 収束回数・梁芯 id の消えた数/新しい数・覆われない辺・同じ梁芯上の小梁などの重なり対の数・同範囲の重複梁芯の数・最後の配置。
// 目標値は「同じ向きの他の線の座標」（mode=src は開口の源が乗る軸 CL の全座標、mode=all は全階の全ての非梁芯 CL で近い順に maxT 個）。
// 引数: <入力.stq> <出力.json> [mode=src|all] [maxSweeps=6] [maxT=4]
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/k4TrialProbe.mjs D:/tatsuya/Download/opening-test.stq out.json all
// 簡略化（実アプリとの差）: 結合（mergeCenterLineChain）・IDB への書込みは通さない。他階 peek は project.graphMap の生きたグラフ。
// 出力: { src, mode, trials:[{plane,dir,from,to,followAbsorbed,followMoved,convergedAt,idsLost,idsNew,partial,uncovered,final,overlaps,dupAxes}] }。既存出力は上書きしない。
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
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../../src/graphSnapshot.js';

const [src, outPath, mode = 'src', maxArg, maxTArg] = process.argv.slice(2);
if (!src || !outPath) { console.error('usage: k4TrialProbe.mjs <in.stq> <out.json> [src|all] [maxSweeps] [maxT]'); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
const maxSweeps = Number(maxArg ?? 6);
const maxT = Number(maxTArg ?? 4);
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');
const sh = (id) => id.slice(0, 8);

const { project } = await loadDocument(src);
await convergeProject(project);
const savedStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const saved = new Map(project.planes.map(p => [p.id, serializeGraph(project.graphMap.get(p.id))]));

function beamCLs(g) { return g.centerLines.filter(c => centerLineKind(c) === 'beam'); }
function snapshot() {
  const out = {};
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    const axes = beamCLs(g).map(c => `${dirChar(c)}:${rnd(c.effectiveValue)}:${c.beamAxisOrigin ?? '-'}:${rnd(c.extentLo)}:${rnd(c.extentHi)}`).sort();
    const beams = g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${rnd(b.axisValue)}:${rnd(b.clStart.effectiveValue)}:${rnd(b.clEnd.effectiveValue)}`).sort();
    const columns = g.columns.map(c => `${rnd(c.axisX)}:${rnd(c.axisY)}:${c.role ?? '-'}`).sort();
    out[planeLabel(p)] = { axes, beams, columns };
  }
  return out;
}
function axisIds() {
  const m = new Map();
  for (const p of project.planes) for (const c of beamCLs(project.graphMap.get(p.id))) m.set(c.id, `${planeLabel(p)}|${dirChar(c)}:${rnd(c.effectiveValue)}:${c.beamAxisOrigin ?? '-'}:${rnd(c.extentLo)}:${rnd(c.extentHi)}`);
  return m;
}
function cover() {
  let partial = 0; const uncovered = [];
  for (const p of project.planes) {
    const m = measurePlane(p, project);
    for (const e of m.edges) if (e.coveredLen < e.edgeLen - 1) { partial++; uncovered.push(`${p.name}|${e.key}|${e.coveredLen}/${e.edgeLen}`); }
  }
  return { partial, uncovered };
}
// 同じ role・向き・軸位置の梁で、範囲が 1mm を超えて重なる対の数
function overlaps(final) {
  let n = 0;
  for (const pl of Object.keys(final)) {
    const bs = final[pl].beams.map(s => { const q = s.split(':'); return { r: q[0], d: q[1], v: q[2], lo: Math.min(+q[3], +q[4]), hi: Math.max(+q[3], +q[4]) }; });
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j];
      if (a.d === b.d && a.v === b.v && a.r === b.r && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 1) n++;
    }
  }
  return n;
}
// 向き・範囲が同じ梁芯の重複数（座標違いは別扱い。座標は梁芯キーの 2 番目）
function dupAxes(final) {
  let n = 0;
  for (const pl of Object.keys(final)) {
    const m = {};
    for (const ax of final[pl].axes) { const q = ax.split(':'); const k = [q[0], q[1], q[3], q[4]].join(':'); m[k] = (m[k] || 0) + 1; }
    for (const c of Object.values(m)) if (c > 1) n += c - 1;
  }
  return n;
}
async function sweeps() {
  const roofPlane = project.roofPlane;
  const includeRoof = !!roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure);
  const real = [...project.planes].reverse();
  const planes = includeRoof ? [roofPlane, ...real] : real;
  for (let i = 1; i <= maxSweeps; i++) {
    let any = false;
    for (const p of planes) {
      const g = project.graphMap.get(p.id);
      const ms = p.isRoofPlane ? roofMainStructure(project) : (g.structureOverride ?? project.structuralInfo.mainStructure);
      const { changed } = await recomputeStructuralForGraph(g, project, ms);
      if (changed) any = true;
    }
    if (!any) return i;
  }
  return null;
}

const trials = [];
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  const rules = rulesFor(effectiveStructure(graph, project));
  let axes;
  if (mode === 'src') {
    if (rules.openingBeamAxes !== 'slabOpenings') continue;
    const belowPlane = belowPlaneOf(plane, project);
    const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
    const sources = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
    const ids = [...new Set(sources.map(s => s.axisCLId).filter(Boolean))];
    axes = ids.map(id => graph.shapeMap.get(id)).filter(cl => cl && cl.value != null && centerLineKind(cl) !== 'beam');
  } else {
    axes = graph.centerLines.filter(cl => cl.value != null && centerLineKind(cl) !== 'beam');
  }
  const plan = axes.map(cl => {
    const vals = [...new Set(graph.centerLines
      .filter(o => o !== cl && o.centerLineType === cl.centerLineType && o.effectiveValue != null && Math.abs(o.effectiveValue - cl.value) > 0.5)
      .map(o => o.effectiveValue))].sort((a, b) => Math.abs(a - cl.value) - Math.abs(b - cl.value));
    return { id: cl.id, from: cl.value, targets: mode === 'all' ? vals.slice(0, maxT) : vals };
  });
  for (const { id, from, targets } of plan) {
    for (const to of targets) {
      const cl = graph.centerLines.find(c => c.id === id);
      if (!cl) { trials.push({ plane: planeLabel(plane), id: sh(id), from: rnd(from), to: rnd(to), error: 'cl missing after restore' }); continue; }
      const rec = { plane: planeLabel(plane), dir: dirChar(cl), from: rnd(from), to: rnd(to) };
      try {
        const before = axisIds();
        runInAction(() => { cl.pendingDelta = to - from; });
        commitCLMoveOp(graph, project, cl, from);
        const after = axisIds();
        // 追従の直後: 元から居た梁芯の id が消えた＝吸収、値が変わった＝移動
        const absorbed = [], moved = [];
        for (const [k, v] of before) {
          if (!after.has(k)) absorbed.push(v);
          else if (after.get(k) !== v) moved.push(`${v}=>${after.get(k).split('|')[1]}`);
        }
        rec.followAbsorbed = absorbed.sort(); rec.followMoved = moved.sort();
        rec.convergedAt = await sweeps();
        const fin = axisIds();
        rec.idsLost = [...before.keys()].filter(k => !fin.has(k)).length;
        rec.idsNew = [...fin.keys()].filter(k => !before.has(k)).length;
        const c = cover();
        rec.partial = c.partial; rec.uncovered = c.uncovered;
        rec.final = snapshot();
        rec.overlaps = overlaps(rec.final); rec.dupAxes = dupAxes(rec.final);
      } catch (e) { rec.error = String(e?.message ?? e); } finally {
        restoreStructCLs(project.structGraph, project.structuralInfo, savedStruct, project.memberGroupLedger);
        for (const p of project.planes) restoreGraph(project.graphMap.get(p.id), saved.get(p.id));
      }
      trials.push(rec);
    }
  }
}
fs.writeFileSync(outPath, JSON.stringify({ src, mode, trials }, null, 1));
console.log(JSON.stringify({ src, mode, trials: trials.length, errors: trials.filter(t => t.error).length, nonConv: trials.filter(t => t.convergedAt == null && !t.error).length,
  followDiffAbsorbOrMove: trials.filter(t => t.followAbsorbed?.length || t.followMoved?.length).length }));
