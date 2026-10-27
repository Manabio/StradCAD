// 課題(k) 別課題 (5)(6) S0（計測だけ。問題5.md・問題6.md）。製品コードは変えない。
// (5) k1c の照合で組めなかった OPENING 梁芯（孤児）が、一致した開口梁芯からの extent 参照だけを理由に保護されて残る件数。
//     保護判定を 2 通りで比べる: A＝本番（unprotectedAmong。ignoreRefsFrom＝孤児の id 集合）／B＝案B（ignoreRefsFrom＝全 OPENING 梁芯の id 集合から始め、
//     生き残りが決まった孤児は外す）。A で保護・B で非保護のものが (5) の対象。
//     照合は openingBeamAxes.js matchedOpeningCandidates（非 export）を同じ規則で写した matchedOf。
// (6) 開口梁芯の extent 参照（openingHostRefCLs）の有向グラフの強連結成分（2 本以上、または自己参照）。
// 状態: 静的＝収束後／試行＝線の移動の「追従の直後（follow）」と「再計算の収束後（final）」。試行は収束後を主、追従直後は参考。
// 自己点検（dry）: reconcileOpeningBeamAxes(graph, sources, []) を serializeGraph→呼ぶ→restoreGraph で副作用を戻して呼び、
//     removed が probe 側の予測（unprotectedAmong(孤児)）と一致するか見る。wallSources は [] で渡す（壁源への再ラベルは見ない）。
//     試行の final では常に、follow では dry=follow を付けたときだけ（restoreGraph が graph.centerLines の並びを変えうるため既定は off）。
// 使い方（app/ で実行。出力は固定ディレクトリ配下、既存ファイルは上書きしない）:
//   静的: node --import ./scripts/testSetup.mjs scripts/probe/kOrphanRefProbe.mjs static <out名.json> D:/tatsuya/Download/*.stq
//   試行: node --import ./scripts/testSetup.mjs scripts/probe/kOrphanRefProbe.mjs trial <out名.json> <in.stq> [mode=src|all] [maxT=4] [maxSweeps=6] [dry=follow]
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel, sweepUntilConverged } from './sweepOrder.mjs';
import { measurePlane } from './kOpeningBeamProbe.mjs';
import { effectiveStructure, rulesFor } from '../../src/structural/structureRules.js';
import { openingBeamSourcesFor, reconcileOpeningBeamAxes } from '../../src/structural/openingBeamAxes.js';
import { belowPlaneOf, unprotectedAmong, isProtectedWallBeamAxis } from '../../src/structural/wallBeamAxes.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { centerLineKind, BeamAxisOrigin } from '../../src/core/centerLine.js';
import { beamAxisCenterLines } from '../../src/core/centerLineKindPolicy.js';
import { openingHostRefCLs } from '../../src/core/structuralEntities.js';
import { CenterLineType, CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../../src/graphSnapshot.js';

const OUT_DIR = 'D:/tatsuya/AppData/claude/temp/d--tatsuya-dev-strad/4b8f6dc1-faa2-417b-bb63-2614a90a9873/scratchpad/s0/orphan';
const sh = (id) => (id ? id.slice(0, 8) : null);
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');
const isVert = (cl) => cl.centerLineType === CenterLineType.VERTICAL;

function prepareOut(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  if (fs.existsSync(p)) { console.error(`既存ファイルを上書きしません: ${p}`); process.exit(1); }
  return p;
}

// ---- 照合（openingBeamAxes.js matchedOpeningCandidates と同じ規則の写し）----
function matchedOf(graph, sources) {
  const candidates = beamAxisCenterLines(graph).filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING);
  const pairs = [];
  candidates.forEach((cl, ci) => {
    sources.forEach((src, si) => {
      if (src.isVertical !== isVert(cl) || Math.abs(src.coord - cl.effectiveValue) >= CL_OVERLAP_TOL_MM) return;
      const overlap = Math.min(cl.extentHi ?? Infinity, src.hi) - Math.max(cl.extentLo ?? -Infinity, src.lo);
      pairs.push({ cl, src, ci, si, overlap });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.ci - b.ci || a.si - b.si);
  const usedCL = new Set(), usedSrc = new Set(), out = [];
  for (const p of pairs) {
    if (usedCL.has(p.ci) || usedSrc.has(p.si)) continue;
    usedCL.add(p.ci); usedSrc.add(p.si); out.push(p);
  }
  return { candidates, matched: out.sort((a, b) => a.ci - b.ci).map(({ cl, src }) => ({ cl, src })) };
}

// ---- 案B の保護判定（unprotectedAmong と同じ固定点反復。初期の ignore を全 OPENING 梁芯にする）----
function unprotectedAmongB(graph, candidates, allOpeningIds) {
  const ignoreRefsFrom = new Set(allOpeningIds);
  const survived = new Set();
  let stable = false;
  while (!stable) {
    stable = true;
    for (const cl of candidates) {
      if (survived.has(cl.id)) continue;
      if (isProtectedWallBeamAxis(graph, cl, { ignoreRefsFrom })) { survived.add(cl.id); ignoreRefsFrom.delete(cl.id); stable = false; }
    }
  }
  return candidates.filter(cl => !survived.has(cl.id));
}

// ---- 強連結成分（Tarjan）----
function sccsOf(graph) {
  const nodes = beamAxisCenterLines(graph).filter(cl => centerLineKind(cl) === 'beam');
  const adj = new Map(nodes.map(cl => [cl, openingHostRefCLs(cl)]));
  let idx = 0; const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
    for (const w of (adj.get(v) ?? openingHostRefCLs(v))) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      const selfRef = comp.length === 1 && (adj.get(v) ?? []).includes(v);
      if (comp.length >= 2 || selfRef) out.push({ comp, selfRef });
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return out;
}

function secondaryOn(graph, cl) { return graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === cl.id); }
const beamRange = (b) => [Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)];
function sameCoordOverlaps(graph, cl) {
  const bs = graph.beams.filter(b => b.role === 'secondary' && b.isVertical === isVert(cl) && Math.abs(b.axisValue - cl.effectiveValue) < 1);
  let n = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    if (bs[i].axisCL.id !== cl.id && bs[j].axisCL.id !== cl.id) continue;
    const [al, ah] = beamRange(bs[i]), [bl, bh] = beamRange(bs[j]);
    if (Math.min(ah, bh) - Math.max(al, bl) > 1) n++;
  }
  return n;
}
const axisDesc = (cl) => `${dirChar(cl)}:${rnd(cl.effectiveValue)}:${cl.beamAxisOrigin ?? '-'}:${rnd(cl.extentLo)}:${rnd(cl.extentHi)}`;

// 平面 1 枚の分析。dry は呼び出し側で最後にやる（restoreGraph で CL オブジェクトが入れ替わるため）。
function analyzePlane(plane, project, { full }) {
  const graph = project.graphMap.get(plane.id);
  const structure = effectiveStructure(graph, project);
  const rules = rulesFor(structure);
  const slab = rules.openingBeamAxes === 'slabOpenings';
  const rec = { plane: planeLabel(plane), structure, slab, sources: 0, openingAxes: 0, orphans: 0, orphansProtectedA: 0, targets: [], sccs: [], uncoveredEdges: null };
  let sources = [];
  if (slab && !plane.isRoofPlane) {
    const belowPlane = belowPlaneOf(plane, project);
    const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
    sources = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
  }
  rec.sources = sources.length;
  const { candidates, matched } = matchedOf(graph, sources);
  rec.openingAxes = candidates.length;
  const matchedIds = new Set(matched.map(m => m.cl.id));
  const orphans = candidates.filter(cl => !matchedIds.has(cl.id));
  rec.orphans = orphans.length;
  const unprotA = new Set(unprotectedAmong(graph, orphans).map(c => c.id));
  const unprotB = new Set(unprotectedAmongB(graph, orphans, candidates.map(c => c.id)).map(c => c.id));
  rec.orphansProtectedA = orphans.filter(c => !unprotA.has(c.id)).length;
  rec.predictedRemovedA = [...unprotA].map(sh).sort();
  Object.defineProperty(rec, '_orphanIds', { value: new Set(orphans.map(c => c.id)), enumerable: false });
  Object.defineProperty(rec, '_matchedIds', { value: matchedIds, enumerable: false });
  const targets = orphans.filter(c => !unprotA.has(c.id) && unprotB.has(c.id));
  let m = null;
  const needMeasure = slab && !plane.isRoofPlane && (full || targets.length > 0);
  if (needMeasure) m = measurePlane(plane, project);
  if (m) rec.uncoveredEdges = m.edges.filter(e => e.coveredLen < e.edgeLen - 1).map(e => `${e.key}|${e.coveredLen}/${e.edgeLen}`);
  for (const t of targets) {
    const referrers = graph.referencingCenterLines(t.id, { includeRefId: false })
      .map(o => ({ id: sh(o.id), axis: axisDesc(o), end: [o.extentLoRef?.clId === t.id ? 'lo' : null, o.extentHiRef?.clId === t.id ? 'hi' : null].filter(Boolean).join('+'),
        matched: matchedIds.has(o.id), orphan: o.beamAxisOrigin === BeamAxisOrigin.OPENING && !matchedIds.has(o.id), origin: o.beamAxisOrigin ?? null, _cl: o }));
    const edgeInfo = (cl) => (m ? m.edges.filter(e => e.isVertical === isVert(cl) && Math.abs(e.target - cl.effectiveValue) < 1)
      .map(e => ({ key: e.key, covered: e.coveredLen, len: e.edgeLen, uncovered: e.coveredLen < e.edgeLen - 1 })) : null);
    const refEdges = referrers.map(r => ({ referrer: r.id, edges: edgeInfo(r._cl) }));
    rec.targets.push({
      id: sh(t.id), axis: axisDesc(t), secondaryOnTarget: secondaryOn(graph, t).length, sameCoordSecondaryOverlaps: sameCoordOverlaps(graph, t),
      referrers: referrers.map(r => ({ id: r.id, axis: r.axis, end: r.end, matched: r.matched, orphan: r.orphan, origin: r.origin })), referrerEdges: refEdges, ownCoordEdges: edgeInfo(t),
      referrerEdgeUncovered: refEdges.some(x => x.edges?.some(e => e.uncovered)), ownCoordEdgeUncovered: !!edgeInfo(t)?.some(e => e.uncovered),
    });
  }
  for (const { comp, selfRef } of sccsOf(graph)) {
    rec.sccs.push({
      size: comp.length, selfRef,
      members: comp.map(cl => ({ id: sh(cl.id), axis: axisDesc(cl), orphan: cl.beamAxisOrigin === BeamAxisOrigin.OPENING && !matchedIds.has(cl.id), secondary: secondaryOn(graph, cl).length })),
    });
  }
  return rec;
}

// dry 自己点検: 本番の reconcile を副作用を戻して呼び、removed が予測（unprotectedAmong(孤児)）と一致するか。
function dryCheck(plane, project, rec) {
  const graph = project.graphMap.get(plane.id);
  const belowPlane = belowPlaneOf(plane, project);
  const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
  const sources = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
  const bytes = serializeGraph(graph);
  let removed;
  const realTargets = [];
  try {
    runInAction(() => { removed = reconcileOpeningBeamAxes(graph, sources, []).removed.map(c => sh(c.id)).sort(); });
    // 本番の reconcile（張り直し込み）を通った後も残った孤児＝実際に保護された孤児。そのうち案B で非保護になるものが (5) の実対象。
    const survivors = graph.centerLines.filter(c => rec._orphanIds.has(c.id));
    const allOpening = beamAxisCenterLines(graph).filter(c => c.beamAxisOrigin === BeamAxisOrigin.OPENING).map(c => c.id);
    rec.survivorsAfterReconcile = survivors.length;
    for (const t of unprotectedAmongB(graph, survivors, allOpening)) {
      realTargets.push({
        id: sh(t.id), axis: axisDesc(t), secondaryOnTarget: secondaryOn(graph, t).length, sameCoordSecondaryOverlaps: sameCoordOverlaps(graph, t),
        referrers: graph.referencingCenterLines(t.id, { includeRefId: false }).map(o => ({ id: sh(o.id), axis: axisDesc(o), matched: rec._matchedIds.has(o.id) })),
      });
    }
  } finally { restoreGraph(graph, bytes); }
  const pred = rec.predictedRemovedA;
  rec.dry = { removed, predicted: pred, match: JSON.stringify(removed) === JSON.stringify(pred), realTargets };
}

function tally(recs) {
  const t = { planes: recs.length, slabPlanes: 0, openingAxes: 0, orphans: 0, orphansProtectedA: 0, targets5: 0, targets5ReferrerEdgeUncovered: 0, targets5OwnEdgeUncovered: 0,
    targets5WithOverlap: 0, scc: 0, sccSelfRef: 0, sccWithSecondary: 0, sccWithOrphan: 0, uncoveredEdges: 0, dryChecked: 0, dryMismatch: 0, realTargets5: 0, survivorsAfterReconcile: 0 };
  for (const r of recs) {
    if (r.slab) t.slabPlanes++;
    t.openingAxes += r.openingAxes; t.orphans += r.orphans; t.orphansProtectedA += r.orphansProtectedA;
    t.targets5 += r.targets.length;
    t.targets5ReferrerEdgeUncovered += r.targets.filter(x => x.referrerEdgeUncovered).length;
    t.targets5OwnEdgeUncovered += r.targets.filter(x => x.ownCoordEdgeUncovered).length;
    t.targets5WithOverlap += r.targets.filter(x => x.sameCoordSecondaryOverlaps > 0).length;
    t.scc += r.sccs.length; t.sccSelfRef += r.sccs.filter(s => s.selfRef).length;
    t.sccWithSecondary += r.sccs.filter(s => s.members.some(x => x.secondary > 0)).length;
    t.sccWithOrphan += r.sccs.filter(s => s.members.some(x => x.orphan)).length;
    t.uncoveredEdges += r.uncoveredEdges?.length ?? 0;
    if (r.dry) { t.dryChecked++; if (!r.dry.match) t.dryMismatch++; t.realTargets5 += r.dry.realTargets?.length ?? 0; t.survivorsAfterReconcile += r.survivorsAfterReconcile ?? 0; }
  }
  return t;
}
const slim = (recs) => recs.filter(r => r.orphans > 0 || r.targets.length > 0 || r.sccs.length > 0 || (r.dry && (!r.dry.match || r.dry.realTargets.length > 0)));

function analyzeState(project, { full, dry }) {
  const recs = [];
  for (const p of project.planes) recs.push(analyzePlane(p, project, { full }));
  if (dry) {
    project.planes.forEach((p, i) => {
      const r = recs[i];
      if (!r.slab || (r.openingAxes === 0 && r.sources === 0)) return;
      try { dryCheck(p, project, r); } catch (e) { r.dry = { error: String(e?.message ?? e), match: false }; }
    });
  }
  return recs;
}

const [kind, outName, ...rest] = process.argv.slice(2);

if (kind === 'static') {
  if (!outName || rest.length === 0) { console.error('usage: kOrphanRefProbe.mjs static <out名.json> <in.stq...>'); process.exit(1); }
  const outPath = prepareOut(outName);
  const res = [];
  const total = tally([]);
  for (const f of rest) {
    const rec = { file: f.split('/').pop() };
    try {
      const { project } = loadDocument(f);
      rec.sweeps = await convergeProject(project);
      const recs = analyzeState(project, { full: true, dry: true });
      rec.tally = tally(recs);
      rec.planes = slim(recs);
      for (const k of Object.keys(rec.tally)) total[k] += rec.tally[k];
    } catch (e) { rec.error = String(e?.message ?? e).slice(0, 300); }
    res.push(rec);
    const t = rec.tally;
    console.log(rec.file, rec.error ? `ERROR ${rec.error}` : `sweeps=${rec.sweeps} slab=${t.slabPlanes} orphans=${t.orphans} protA=${t.orphansProtectedA} target5=${t.targets5} scc=${t.scc} unc=${t.uncoveredEdges} dry=${t.dryChecked}/mis${t.dryMismatch}`);
  }
  fs.writeFileSync(outPath, JSON.stringify({ total, files: res }, null, 1));
  console.log('TOTAL', JSON.stringify(total), 'files', res.length, 'errors', res.filter(r => r.error).length);
} else if (kind === 'trial') {
  const [src, mode = 'src', maxTArg = '4', maxArg = '6', dryArg = ''] = rest;
  if (!outName || !src) { console.error('usage: kOrphanRefProbe.mjs trial <out名.json> <in.stq> [src|all] [maxT] [maxSweeps] [dry=follow]'); process.exit(1); }
  const outPath = prepareOut(outName);
  const maxT = Number(maxTArg), maxSweeps = Number(maxArg), dryFollow = dryArg === 'dry=follow';
  const { project } = loadDocument(src);
  await convergeProject(project);
  const savedStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const saved = new Map(project.planes.map(p => [p.id, serializeGraph(project.graphMap.get(p.id))]));
  const baseline = analyzeState(project, { full: true, dry: false });
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
          runInAction(() => { cl.pendingDelta = to - from; });
          commitCLMoveOp(graph, project, cl, from);
          const followRecs = analyzeState(project, { full: false, dry: dryFollow });
          rec.follow = { tally: tally(followRecs), planes: slim(followRecs) };
          rec.convergedAt = await sweepUntilConverged(project, 'desc', maxSweeps);
          const finalRecs = analyzeState(project, { full: true, dry: true });
          rec.final = { tally: tally(finalRecs), planes: slim(finalRecs) };
        } catch (e) { rec.error = String(e?.message ?? e); } finally {
          restoreStructCLs(project.structGraph, project.structuralInfo, savedStruct, project.memberGroupLedger);
          for (const p of project.planes) restoreGraph(project.graphMap.get(p.id), saved.get(p.id));
        }
        trials.push(rec);
      }
    }
  }
  const ok = trials.filter(t => !t.error);
  const cnt = (state, key, pred = (v) => v > 0) => ok.filter(t => pred(t[state].tally[key])).length;
  const sum = (state, key) => ok.reduce((a, t) => a + t[state].tally[key], 0);
  const summary = { src, mode, trials: trials.length, errors: trials.length - ok.length, nonConverged: ok.filter(t => t.convergedAt == null).length,
    convergedAtHist: ok.reduce((h, t) => { h[t.convergedAt] = (h[t.convergedAt] || 0) + 1; return h; }, {}), baseline: tally(baseline) };
  for (const state of ['follow', 'final']) {
    summary[state] = {};
    for (const key of ['orphans', 'orphansProtectedA', 'targets5', 'scc', 'sccSelfRef', 'sccWithSecondary', 'sccWithOrphan', 'dryChecked', 'dryMismatch', 'survivorsAfterReconcile', 'realTargets5']) {
      summary[state][key] = { trialsWith: cnt(state, key), sum: sum(state, key) };
    }
  }
  fs.writeFileSync(outPath, JSON.stringify({ summary, baseline: slim(baseline), trials }, null, 1));
  console.log(JSON.stringify(summary));
} else {
  console.error('usage: kOrphanRefProbe.mjs static|trial <out名.json> ...');
  process.exit(1);
}
