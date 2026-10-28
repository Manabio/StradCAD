// 課題(k) 問題1/問題2 の S0: 開口の辺（規則O の源の辺）のうち「梁が辺を覆わない辺」を型で分類する計測 probe（製品コードは変えない）。
// 型（問題2.md「現状」節・問題1.md）:
//   P  ＝probe 側の偽陽性（旧 measurePlane＝status を (向き,target) だけで引き、梁を target±1mm でしか探さない では未被覆、
//        新判定＝status は辺の識別（同一オブジェクト）で引き、被覆は coord・target の両方で coverTol 以内を見る では被覆）
//   G* ＝通り芯の代理（host kind 'grid'＝範囲 ±∞）で covered になったが、その通り芯の区間に大梁が無い
//        G1self＝自階の wallGate.spanInBuilding が偽／G1below＝自階は真だが直下階との AND で偽（失敗した階名を sub に残す）
//        G2＝最外の直交通り芯より外（computeGridSpans に区間が無い）／G3＝excludedBeamSlots／G4＝固定梁と重なる／
//        G5＝LG に置換（LG も梁なので被覆に数える＝覆われない辺には現れない。検出不能の旨を要約に出す）／G6＝主構造未定（梁を作らない）
//        優先順 G6>G2>G3>G4>G1self>G1below（1辺に複数の区間があるときの代表。全理由は reasons に残す）
//   U  ＝梁芯の extent は辺を覆っているが上に小梁が無い（host 無し・除外スロット等。host が USER／OPENING 由来の梁芯のどちらも含む）
//        sub＝noHost／excludedSlot／other。noHost のとき、host の無い直交通り芯の理由（G*）も sub に添える
//   W  ＝RC下地壁の源 host が辺の全長を覆うのに梁が無い（問題の型定義に無い補助型）
//   K  ＝一部だけ重なる host（USER 梁芯・手動梁・RC下地壁）で covered、または status placed でも既存の他由来の梁芯を流用して残部に梁が無い（K3）
//   O  ＝直交辺の端のつなぎ先が「一致しない OPENING 梁芯（照合の余り）」を指している（問題5.md）
//   E  ＝status excluded（excludedWallBeamAxes による除外＝設計どおり梁なし。補助型）
//   S  ＝status unsupported（支えが片側に無い＝設計どおり梁なし。補助型）
//   X  ＝どれにも当たらない（内訳を detail に残す）
// 総数 ＝ 旧判定で未被覆 ∪ 新判定で未被覆 の辺（規則O 対象の 'slabOpenings' の階のみ。在来木造 'slabOpeningsDirect' は計測のみで分類しない）。
// 自己点検: (1) 型ごとの件数の合計＝総数 (2) 旧判定の総数を measurePlane の全辺から独立に数えた値と一致 (3) 階ごとに、
//   本 probe が openingHostsFor を写して組んだ計画の covered／excluded／unsupported／placed の件数と辺ごとの status が
//   openingBeamSourcesDiagnostics の diag（coveredCount 等・edges 表）・openingBeamSourcesFor の件数と一致 (4) 旧で被覆・新で未被覆の辺が無い
// openingHostsFor・planForRect・matchedOpeningCandidates は openingBeamAxes.js が export しないため、本 probe に写した
//   （HEAD 2e57852 時点。(3) の自己点検が写しのずれを検出する）。
// 引数: <入力> <出力.json> [mode=static|move]
//   入力＝.stq ファイル／ディレクトリ（直下の *.stq 全件）／カンマ区切りの .stq 列。
//   static＝収束後の静止状態を分類（既定）。move＝入力は 1 本の .stq。開口の源が乗る軸 CL（非梁芯）を同じ向きの他の線の座標へ
//   commitCLMoveOp で動かし、本番と同じ並びの全階再計算（収束まで最大 6 回）後に分類する試行（k4TrialProbe の mode=src と同じ試行列）。
// 使い方（app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/kCoverClassifyProbe.mjs D:/tatsuya/Download/opening-test.stq out.json move
//   node --import ./scripts/testSetup.mjs scripts/probe/kCoverClassifyProbe.mjs D:/tatsuya/Download out.json static
// 出力: { mode, inputs:[{file, converged, planes:[...], records:[...], tally, error?}], trials?:[...], summary }。既存出力は上書きしない。
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel, roofMainStructure } from './sweepOrder.mjs';
import { measurePlane } from './kOpeningBeamProbe.mjs';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure, effectiveStructure, rulesFor, UNSPECIFIED_STRUCTURE } from '../../src/structural/structureRules.js';
import {
  openingEdgeComponents, openingBeamSourcesDiagnostics, openingBeamSourcesFor, edgeTarget, defaultBeamWidthMm,
} from '../../src/structural/openingBeamAxes.js';
import { planOpeningEdgeBeams } from '../../src/structural/openingEdgePlan.js';
import {
  belowPlaneOf, findWallBeamAnchorCL, findOpeningBeamAnchorCL, wallBeamAxisExcludeKey, wallBeamSourcesFor,
} from '../../src/structural/wallBeamAxes.js';
import { computeGridSpans, secondaryBeamSpansFor } from '../../src/structural/structuralAutoFill.js';
import { buildStructuralWallGate, buildSelfFootprintGate } from '../../src/structural/wallGate.js';
import { fixedBeamSpans, overlapsAnySpan, beamAxisSpan } from '../../src/structural/fixedBeamOverlap.js';
import { isFoundationPlane } from '../../src/structural/drawingDesignation.js';
import { structureHasMemberKind, MEMBER_KIND } from '../../src/structural/structuralClassification.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { BeamAxisOrigin, centerLineKind } from '../../src/core/centerLine.js';
import { beamAxisCenterLines } from '../../src/core/centerLineKindPolicy.js';
import { spanKey, openingHostRefCLs } from '../../src/core/structuralEntities.js';
import { CenterLineType, CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../../src/graphSnapshot.js';

const TYPES = ['P', 'G1self', 'G1below', 'G2', 'G3', 'G4', 'G5', 'G6', 'U', 'W', 'K', 'O', 'E', 'S', 'X'];
const G_PRIORITY = ['G6', 'G2', 'G3', 'G4', 'G1self', 'G1below'];
const GAP_TOL = 1; // coveredLen < edgeLen - 1 を未被覆とする（kMoveCoverProbe と同じ）
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');

// ---------- 区間の補助 ----------
function unionGaps(intervals, a, b) {
  const xs = intervals.map(([lo, hi]) => [Math.max(lo, a), Math.min(hi, b)]).filter(([lo, hi]) => hi > lo).sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [lo, hi] of xs) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi); else merged.push([lo, hi]);
  }
  const covered = merged.reduce((s, [lo, hi]) => s + (hi - lo), 0);
  const gaps = [];
  let cur = a;
  for (const [lo, hi] of merged) { if (lo > cur) gaps.push([cur, lo]); cur = Math.max(cur, hi); }
  if (cur < b) gaps.push([cur, b]);
  return { covered, gaps: gaps.filter(([lo, hi]) => hi - lo > GAP_TOL) };
}

// ---------- openingBeamAxes.js からの写し ----------
/** openingHostsFor の写し（openingBeamAxes.js。K3 の Q5 込み＝2026-10-28 版）。 */
function openingHostsFor(graph, rules, rcWallAxisSources) {
  const hosts = [];
  if (rules.beamPlacement !== 'wallRuns') {
    for (const cl of graph.gridXs) hosts.push({ isVertical: true, coord: cl.value, lo: -Infinity, hi: Infinity, kind: 'grid', clId: cl.id });
    for (const cl of graph.gridYs) hosts.push({ isVertical: false, coord: cl.value, lo: -Infinity, hi: Infinity, kind: 'grid', clId: cl.id });
  }
  for (const s of rcWallAxisSources) {
    const type = s.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const cl = findWallBeamAnchorCL(graph, type, s.coord, { lo: s.lo, hi: s.hi });
    hosts.push({ isVertical: s.isVertical, coord: s.coord, lo: s.lo, hi: s.hi, kind: 'wall', ...(cl ? { clId: cl.id } : {}) });
  }
  for (const beam of graph.beams) {
    if (beam.dimensionStatus === 'auto' || (beam.role !== 'primary' && beam.role !== 'secondary')) continue;
    if (beam.axisCL.beamAxisOrigin === BeamAxisOrigin.OPENING) continue;
    const a = beam.clStart.effectiveValue, b = beam.clEnd.effectiveValue;
    hosts.push({
      isVertical: beam.isVertical, coord: beam.axisCL.effectiveValue, lo: Math.min(a, b), hi: Math.max(a, b),
      kind: 'beam', clId: beam.axisCL.id,
    });
  }
  // (k) K3 Q5: OPENING・SLAB_BEAM 以外の梁芯を host に（USER は 'user'、それ以外は 'axis'）。
  for (const cl of beamAxisCenterLines(graph)) {
    if (cl.beamAxisOrigin === BeamAxisOrigin.OPENING || cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM) continue;
    if (cl.centerLineType !== CenterLineType.VERTICAL && cl.centerLineType !== CenterLineType.HORIZONTAL) continue;
    hosts.push({
      isVertical: cl.centerLineType === CenterLineType.VERTICAL, coord: cl.effectiveValue,
      lo: cl.extentLo ?? -Infinity, hi: cl.extentHi ?? Infinity,
      kind: cl.beamAxisOrigin === BeamAxisOrigin.USER ? 'user' : 'axis', clId: cl.id,
    });
  }
  return hosts;
}

/** planForRect の写し（辺に target を付けて計画器へ通す）。mapped＝計画器に渡した辺オブジェクト（status の引き当てに使う）。 */
function planForRect(graph, rules, edges4, hosts) {
  const edges = edges4.map(edge => {
    const t = edgeTarget(graph, edge, rules);
    return { ...edge, target: t.coord, beamWidthUnresolved: t.beamWidthUnresolved };
  });
  const coverTol = Math.max(CL_OVERLAP_TOL_MM, (defaultBeamWidthMm(rules) ?? 0) / 2);
  const result = planOpeningEdgeBeams(edges, hosts, {
    coverTol,
    partialCover: 'split',
    canPlace: edge => !graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(edge.isVertical, edge.target)),
  });
  return { mapped: edges, result, coverTol };
}

/** matchedOpeningCandidates の写し（openingBeamAxes.js :485〜519。梁芯と源の 1 対 1 照合）。 */
function matchedOpeningCandidates(graph, openingSources) {
  const candidates = beamAxisCenterLines(graph).filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING);
  const isVerticalOf = (cl) => cl.centerLineType === CenterLineType.VERTICAL;
  const pairs = [];
  candidates.forEach((cl, ci) => {
    openingSources.forEach((src, si) => {
      if (src.isVertical !== isVerticalOf(cl) || Math.abs(src.coord - cl.effectiveValue) >= CL_OVERLAP_TOL_MM) return;
      const overlap = Math.min(cl.extentHi ?? Infinity, src.hi) - Math.max(cl.extentLo ?? -Infinity, src.lo);
      pairs.push({ cl, src, ci, si, overlap });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.ci - b.ci || a.si - b.si);
  const usedCL = new Set();
  const usedSrc = new Set();
  const out = [];
  for (const p of pairs) {
    if (usedCL.has(p.ci) || usedSrc.has(p.si)) continue;
    usedCL.add(p.ci);
    usedSrc.add(p.si);
    out.push(p);
  }
  return out;
}

// ---------- G（大梁の欠け）の理由 ----------
function makeGateCtx(plane, project, graph) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === plane.id);
  const lower = idx > 0 ? planes.slice(0, idx) : [];
  let fullP = null;
  const selfGates = new Map();
  const selfGateOf = (p) => {
    if (!selfGates.has(p.id)) selfGates.set(p.id, buildSelfFootprintGate(p.id === plane.id ? graph : project.graphMap.get(p.id)));
    return selfGates.get(p.id);
  };
  return {
    plane, project, graph, lower,
    fullGate: () => (fullP ??= buildStructuralWallGate(plane, project, graph)),
    selfGate: () => selfGateOf(plane),
    lowerGate: selfGateOf,
  };
}

/** 通り芯の区間 span（computeGridSpans の 1 件）に大梁が無い理由を autoFillBeams の判定順で返す。 */
async function gridSpanReason(gctx, span, role) {
  const { graph } = gctx;
  const exist = graph.beams.find(b => b.axisCL === span.axisCL && b.clStart === span.clStart && b.clEnd === span.clEnd);
  if (exist) return { reason: `exists:${exist.role}` };
  if (graph.excludedBeamSlots.has(span.key)) return { reason: 'G3' };
  const gate = await gctx.fullGate();
  if (gate && !gate.spanInBuilding(span.axisCL, span.isVertical, span.clStart, span.clEnd)) {
    const g = gctx.selfGate();
    const a = span.clStart.value, b = span.clEnd.value;
    let anyInside = false;
    for (let i = 1; i <= 9; i++) if (gate.spanPointInBuilding(span.axisCL, span.isVertical, a + ((b - a) * i) / 10)) { anyInside = true; break; }
    if (g && !g.spanInBuilding(span.axisCL, span.isVertical, span.clStart, span.clEnd)) return { reason: 'G1self', anyInside };
    for (const lp of [...gctx.lower].reverse()) {
      const lg = gctx.lowerGate(lp);
      if (lg && !lg.spanInBuilding(span.axisCL, span.isVertical, span.clStart, span.clEnd)) return { reason: 'G1below', sub: lp.name, anyInside };
    }
    return { reason: 'G1?', anyInside };
  }
  const fixed = fixedBeamSpans(graph.beams, role);
  if (fixed.length > 0 && overlapsAnySpan(beamAxisSpan(span), fixed)) return { reason: 'G4' };
  return { reason: 'G?' };
}

/** 通り芯 hostCL（axis の CL）上で、[gaps] に対応する欠けの理由を集める。 */
async function gridGapReasons(gctx, hostCLId, isVertical, gaps, role) {
  const { graph } = gctx;
  const crossGrid = isVertical ? graph.gridYs : graph.gridXs;
  const cv = crossGrid.map(c => c.value);
  const gmin = Math.min(...cv), gmax = Math.max(...cv);
  const spans = computeGridSpans(graph).filter(s => s.axisCL.id === hostCLId);
  const reasons = [];
  for (const [lo, hi] of gaps) {
    if (!(cv.length > 0) || lo < gmin - GAP_TOL || hi > gmax + GAP_TOL) reasons.push({ reason: 'G2', gap: [rnd(lo), rnd(hi)], gridRange: cv.length ? [rnd(gmin), rnd(gmax)] : null });
    for (const s of spans) {
      const a = Math.min(s.clStart.value, s.clEnd.value), b = Math.max(s.clStart.value, s.clEnd.value);
      if (Math.min(b, hi) - Math.max(a, lo) <= GAP_TOL) continue;
      reasons.push({ ...(await gridSpanReason(gctx, s, role)), span: [rnd(a), rnd(b)] });
    }
  }
  return reasons;
}

/** 梁芯 cl の上に小梁が出ない理由（secondaryBeamSpansFor の host 連続ペア）。noHost のときは host の無い直交通り芯の理由も添える。 */
async function secondaryCause(gctx, cl, role, edge = null) {
  const { graph } = gctx;
  const hosts = secondaryBeamSpansFor(graph, cl);
  let excludedPairs = 0;
  for (let i = 0; i < hosts.length - 1; i++) if (graph.excludedBeamSlots.has(spanKey(cl, hosts[i], hosts[i + 1]))) excludedPairs++;
  const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
  const cause = hosts.length < 2 ? 'noHost' : excludedPairs > 0 ? 'excludedSlot' : 'other';
  const info = {
    cause, hostCount: hosts.length, hostCoords: hosts.map(h => rnd(h.value)), excludedPairs,
    secondaryBeamsOnAxis: graph.beams.filter(b => b.axisCL.id === cl.id && b.role === 'secondary').length,
  };
  if (cause === 'noHost') {
    const lo = cl.extentLo ?? -Infinity, hi = cl.extentHi ?? Infinity;
    const cross = (isVertical ? graph.gridYs : graph.gridXs).filter(p => p.value >= lo - GAP_TOL && p.value <= hi + GAP_TOL && !hosts.includes(p));
    info.missingHost = [];
    // 辺の両端の座標に host（直交の大梁・梁芯上の小梁）が無い端（K3 の帰結＝直交辺が覆われず端に梁が無い、など）
    if (edge) for (const v of [edge.lo, edge.hi]) if (!hosts.some(h => Math.abs(h.value - v) <= GAP_TOL)) info.missingHost.push({ cross: rnd(v), reason: 'endNoHost' });
    // 開口由来の梁芯が extent で明示参照する直交の梁芯（openingHostRefCLs）が host を持たない理由: 参照先の梁芯が cl の座標まで届かない
    // （K3＝他由来の梁芯を流用して短いまま、または照合の余り）。
    const orthoType = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    for (const r of openingHostRefCLs(cl)) {
      if (r.centerLineType !== orthoType || hosts.includes(r)) continue;
      const c = cl.effectiveValue;
      const reaches = (r.extentLo ?? -Infinity) <= c + GAP_TOL && (r.extentHi ?? Infinity) >= c - GAP_TOL;
      info.missingHost.push({
        cross: rnd(r.effectiveValue), reason: reaches ? 'refAxisNoBeam' : `refAxisShort:${r.beamAxisOrigin ?? '-'}`,
        refExt: [rnd(r.extentLo), rnd(r.extentHi)],
      });
    }
    for (const p of cross) {
      // p 上（向きは cl と直交）で cl の座標 c を含む区間に大梁が無い理由
      const c = cl.effectiveValue;
      const spans = computeGridSpans(graph).filter(s => s.axisCL.id === p.id && Math.min(s.clStart.value, s.clEnd.value) - GAP_TOL <= c && Math.max(s.clStart.value, s.clEnd.value) + GAP_TOL >= c);
      if (gctx.g6) { info.missingHost.push({ cross: rnd(p.value), reason: 'G6' }); continue; }
      if (spans.length === 0) info.missingHost.push({ cross: rnd(p.value), reason: 'G2' });
      for (const s of spans) info.missingHost.push({ cross: rnd(p.value), ...(await gridSpanReason(gctx, s, role)) });
    }
  }
  return info;
}

// ---------- 1 階の分類 ----------
async function classifyPlane(plane, project, label) {
  const graph = project.graphMap.get(plane.id);
  const structure = effectiveStructure(graph, project);
  const rules = rulesFor(structure);
  const rule = rules.openingBeamAxes ?? null;
  const out = { plane: plane.name, structure, openingRule: rule, edgeCount: 0, oldUncovered: 0, newUncovered: 0, newSpecUncovered: 0, records: [], selfCheck: [], woodSkipped: null };
  if (rule !== 'slabOpenings' && rule !== 'slabOpeningsDirect') return out;
  const belowPlane = belowPlaneOf(plane, project);
  const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
  const riserOf = (s) => stairRiserOf(s, project, plane);
  const m = measurePlane(plane, project); // 旧判定
  const comps = openingEdgeComponents(graph, { riserOf, belowGraph });
  const flat = comps.flat();
  out.edgeCount = flat.length;
  // measurePlane は主構造未定（G6）の階で、梁芯が何も覆わず源も出ない辺を除く（counts.g6Skipped）。辺は位置キーで引く。
  const g6Skipped = m.counts?.g6Skipped ?? 0;
  if (m.edges.length !== flat.length - g6Skipped) out.selfCheck.push(`measurePlane の辺数 ${m.edges.length} ≠ openingEdgeComponents ${flat.length} − g6Skipped ${g6Skipped}`);
  const measuredByKey = new Map(m.edges.map(e => [e.key, e]));
  const keyOf = (e) => `${plane.name}|${e.isVertical ? 'V' : 'H'}|${rnd(e.coord)}|${rnd(e.lo)}-${rnd(e.hi)}`;
  const oldIndependent = m.edges.filter(e => e.coveredLen < e.edgeLen - GAP_TOL).length;
  out.oldUncovered = oldIndependent;

  if (rule === 'slabOpeningsDirect') {
    // 在来木造: 実梁で判定する設計（計画器を通らない）。計測のみ。
    let newUnc = 0;
    const wcTol = Math.max(CL_OVERLAP_TOL_MM, (defaultBeamWidthMm(rules) ?? 0) / 2);
    flat.forEach((e) => {
      const t = edgeTarget(graph, e, rules);
      const bs = beamsOnEdge(graph, e, t.coord, wcTol, true);
      if (unionGaps(bs.map(b => [b.lo, b.hi]), e.lo, e.hi).gaps.length > 0) newUnc++;
    });
    out.newUncovered = newUnc;
    out.woodSkipped = { edges: flat.length, oldUncovered: oldIndependent, newUncovered: newUnc };
    return out;
  }

  // 計画（openingHostsFor／planForRect の写し）と自己点検用の diag
  const diag = openingBeamSourcesDiagnostics(graph, project, { riserOf, belowGraph });
  const sources = openingBeamSourcesFor(graph, project, { riserOf, belowGraph });
  const rcWallAxisSources = rules.wallBeamAxes === 'rcBacking' ? wallBeamSourcesFor(graph, project, null) : [];
  const hosts = openingHostsFor(graph, rules, rcWallAxisSources);
  const plans = comps.map(c => planForRect(graph, rules, c, hosts));
  const statusOfMapped = new Map();
  const cnt = { placed: 0, covered: 0, excluded: 0, unsupported: 0, split: 0 };
  const statusRows = [];
  for (const p of plans) {
    for (const x of p.result.placed) { statusOfMapped.set(x.edge, { status: 'placed', placed: x }); cnt.placed++; }
    for (const x of p.result.covered) { statusOfMapped.set(x.edge, { status: 'covered', host: x.host }); cnt.covered++; }
    for (const x of p.result.excluded) { statusOfMapped.set(x.edge, { status: 'excluded' }); cnt.excluded++; }
    for (const x of p.result.unsupported) { statusOfMapped.set(x.edge, { status: 'unsupported' }); cnt.unsupported++; }
    // 一部だけ host が覆う辺（partialCover:'split'）。子の辺は placed／excluded／unsupported の行に出る。
    for (const x of p.result.split) { statusOfMapped.set(x.edge, { status: 'split', host: x.host, children: x.children }); cnt.split++; }
  }
  // 子の辺は mapped に無いが、diag の行（lo/hi つき）と突き合わせるため、行は全 status の辺オブジェクトから採る。
  for (const [e, v] of statusOfMapped) statusRows.push(`${e.isVertical}|${rnd(e.coord)}|${rnd(e.target)}|${rnd(e.lo)}|${rnd(e.hi)}|${v.status}`);
  const diagRows = (diag.edges ?? []).map(e => `${e.isVertical}|${rnd(e.coord)}|${rnd(e.target)}|${rnd(e.lo)}|${rnd(e.hi)}|${e.status}`);
  if (cnt.split !== (diag.splitCount ?? 0)) out.selfCheck.push(`split: 写し ${cnt.split} ≠ diag.splitCount ${diag.splitCount}`);
  if (cnt.covered !== (diag.coveredCount ?? 0)) out.selfCheck.push(`covered: 写し ${cnt.covered} ≠ diag.coveredCount ${diag.coveredCount}`);
  if (cnt.excluded !== (diag.excludedCount ?? 0)) out.selfCheck.push(`excluded: 写し ${cnt.excluded} ≠ diag ${diag.excludedCount}`);
  if (cnt.unsupported !== (diag.unsupportedCount ?? 0)) out.selfCheck.push(`unsupported: 写し ${cnt.unsupported} ≠ diag ${diag.unsupportedCount}`);
  if (cnt.placed !== sources.length) out.selfCheck.push(`placed: 写し ${cnt.placed} ≠ openingBeamSourcesFor ${sources.length}`);
  if (JSON.stringify([...statusRows].sort()) !== JSON.stringify([...diagRows].sort())) out.selfCheck.push('辺ごとの status の表が diag.edges と一致しない');

  const matched = matchedOpeningCandidates(graph, sources);
  const matchedIds = new Set(matched.map(p => p.cl.id));
  const foundation = isFoundationPlane(plane, project);
  const role = foundation ? 'foundation' : 'primary';
  const beamKind = foundation ? MEMBER_KIND.FOUNDATION_BEAM : MEMBER_KIND.BEAM;
  const g6 = structure === UNSPECIFIED_STRUCTURE || !structureHasMemberKind(beamKind, structure);
  const gctx = makeGateCtx(plane, project, graph);
  gctx.g6 = g6;

  let flatIdx = 0;
  for (let ci = 0; ci < comps.length; ci++) {
    for (let ei = 0; ei < comps[ci].length; ei++, flatIdx++) {
      const mapped = plans[ci].mapped[ei];
      const coverTol = plans[ci].coverTol;
      const old = measuredByKey.get(keyOf(mapped));
      if (!old) continue; // G6 で measurePlane が除いた辺（梁芯が何も覆わず源も出ない＝測る対象が無い）
      const oldUnc = old.coveredLen < old.edgeLen - GAP_TOL;
      // 新判定: 梁の軸座標（偏芯込み axisValue）に加え、梁の軸 CL の座標（axisCL.effectiveValue。計画器が手動梁 host に使う座標）も
      // coord・target と coverTol 以内で比べる。spec（axisValue のみ）の結果も newSpec として残す（偏芯した梁は axisValue が coverTol を超えて離れる）。
      // 主構造未定（G6）の階は measurePlane と同じく梁芯の extent でも測る（梁が出ない階）。
      const axisSpans = g6
        ? beamAxisCenterLines(graph, { centerLineType: mapped.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL })
          .filter(c => Math.abs(c.effectiveValue - mapped.coord) <= coverTol + 1e-9 || Math.abs(c.effectiveValue - mapped.target) <= coverTol + 1e-9)
          .map(c => [c.extentLo ?? -Infinity, c.extentHi ?? Infinity])
        : [];
      const bsSpec = beamsOnEdge(graph, mapped, mapped.target, coverTol, false);
      const ugSpec = unionGaps([...bsSpec.map(b => [b.lo, b.hi]), ...axisSpans], mapped.lo, mapped.hi);
      const bs = beamsOnEdge(graph, mapped, mapped.target, coverTol, true);
      const ug = unionGaps([...bs.map(b => [b.lo, b.hi]), ...axisSpans], mapped.lo, mapped.hi);
      const newUnc = ug.gaps.length > 0;
      if (newUnc) out.newUncovered++;
      if (ugSpec.gaps.length > 0) out.newSpecUncovered++;
      // measurePlane は S1 で軸CL座標も見るようになった（旧判定＝新判定）。axisValue だけでは覆われない辺（P）も記録に残す。
      if (!oldUnc && !newUnc && !(ugSpec.gaps.length > 0)) continue;
      const st = statusOfMapped.get(mapped);
      const rec = {
        file: label, plane: plane.name, structure, key: old.key, status: st.status, oldStatus: old.status, statusMismatch: st.status !== old.status,
        edgeLen: rnd(mapped.hi - mapped.lo), oldCoveredLen: old.coveredLen, newCoveredLen: rnd(ug.covered), oldUncovered: oldUnc, newUncovered: newUnc, newSpecUncovered: ugSpec.gaps.length > 0,
        source: mapped.source, coverTol, gaps: ug.gaps.map(([a, b]) => [rnd(a), rnd(b)]),
        beams: bs.map(b => ({ role: b.role, lo: rnd(b.lo), hi: rnd(b.hi), axisValue: rnd(b.axisValue) })),
      };
      if (st.host) rec.host = { kind: st.host.kind, coord: rnd(st.host.coord), lo: Number.isFinite(st.host.lo) ? rnd(st.host.lo) : null, hi: Number.isFinite(st.host.hi) ? rnd(st.host.hi) : null, clId: st.host.clId?.slice(0, 8) ?? null };
      if (!oldUnc && newUnc) rec.type = 'Q'; // 旧で被覆・新で未被覆（起こらない想定。自己点検 (4)）
      else if (!newUnc) { rec.type = 'P'; rec.sub = ugSpec.gaps.length > 0 ? 'axisCLのみで被覆' : 'axisValueで被覆'; }
      else await classifyUncovered(rec, { mapped, st, graph, gctx, role, g6, sources, matched, matchedIds });
      out.records.push(rec);
    }
  }
  const qCount = out.records.filter(r => r.type === 'Q').length;
  if (qCount > 0) out.selfCheck.push(`旧で被覆・新で未被覆の辺が ${qCount} 件`);
  return out;
}

function beamsOnEdge(graph, e, target, coverTol, withAxisCL) {
  const near = (v) => Math.abs(v - e.coord) <= coverTol + 1e-9 || Math.abs(v - target) <= coverTol + 1e-9;
  return graph.beams
    .filter(b => b.isVertical === e.isVertical && (near(b.axisValue) || (withAxisCL && near(b.axisCL.effectiveValue))))
    .map(b => {
      const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
      return { role: b.role ?? null, lo: Math.min(a, c), hi: Math.max(a, c), axisValue: b.axisValue };
    });
}

const spansFull = (lo, hi, e) => (lo ?? -Infinity) <= e.lo + GAP_TOL && (hi ?? Infinity) >= e.hi - GAP_TOL;

/** 新判定でも未被覆の辺に型を付ける。 */
async function classifyUncovered(rec, { mapped: e, st, graph, gctx, role, g6, sources, matchedIds }) {
  const detail = (d) => { rec.detail = d; };
  // 主構造未定（または梁を持たない構造）の階は梁をまったく作らない＝どの status でも G6（Q7: 計測から除く既定）
  if (g6) { rec.type = 'G6'; rec.sub = st.status; rec.reasons = [{ reason: 'G6' }]; return; }
  if (st.status === 'excluded') { rec.type = 'E'; return; }
  if (st.status === 'unsupported') { rec.type = 'S'; return; }
  // 一部だけ host が覆う辺: 残部の子が excluded／unsupported（割った点に支えが無い等）で梁が架からない＝設計どおり。
  if (st.status === 'split') { rec.type = 'S'; rec.sub = 'split'; detail({ children: st.children.map(c => [rnd(c.lo), rnd(c.hi)]) }); return; }
  if (st.status === 'covered') {
    const h = st.host;
    if (h.kind === 'grid') {
      if (g6) { rec.type = 'G6'; rec.reasons = [{ reason: 'G6' }]; return; }
      const reasons = await gridGapReasons(gctx, h.clId, e.isVertical, rec.gaps.map(([a, b]) => [a, b]), role);
      rec.reasons = reasons;
      const hit = G_PRIORITY.find(t => reasons.some(r => r.reason === t));
      if (hit) { rec.type = hit; return; }
      rec.type = 'X'; detail({ why: 'grid host だが理由が特定できない', reasons });
      return;
    }
    const full = spansFull(h.lo, h.hi, e);
    if (!full) { rec.type = 'K'; detail({ hostKind: h.kind, hostRange: [h.lo, h.hi], note: '一部だけ重なる host で covered' }); return; }
    if (h.kind === 'user') {
      const cl = graph.shapeMap.get(h.clId);
      if (!cl) { rec.type = 'X'; detail({ why: 'user host の CL が見つからない' }); return; }
      const sec = await secondaryCause(gctx, cl, role, e);
      rec.type = 'U'; rec.sub = sec.cause; detail({ hostKind: 'user', ...sec });
      return;
    }
    if (h.kind === 'wall') {
      const cl = h.clId ? graph.shapeMap.get(h.clId) : null;
      rec.type = 'W';
      detail(cl ? { hostKind: 'wall', ...(await secondaryCause(gctx, cl, role, e)) } : { hostKind: 'wall', note: '壁由来梁芯が無い' });
      return;
    }
    rec.type = 'X'; detail({ why: `host kind ${h.kind} が辺の全長を覆うのに梁が覆っていない` });
    return;
  }
  // placed: 源は出ている。梁芯・小梁がどうなっているか。
  const src = sources.find(s => s.isVertical === e.isVertical && Math.abs(s.coord - e.target) < 1e-6 && Math.abs(s.lo - e.lo) < 1e-6 && Math.abs(s.hi - e.hi) < 1e-6);
  const axes = beamAxisCenterLines(graph).filter(cl => (cl.centerLineType === CenterLineType.VERTICAL) === e.isVertical && Math.abs(cl.effectiveValue - e.target) < CL_OVERLAP_TOL_MM);
  rec.axes = axes.map(cl => ({ id: cl.id.slice(0, 8), origin: cl.beamAxisOrigin ?? null, ext: [rnd(cl.extentLo), rnd(cl.extentHi)], matched: matchedIds.has(cl.id) }));
  if (!src) { rec.type = 'X'; detail({ why: 'placed の源が openingBeamSourcesFor に見つからない' }); return; }
  if (axes.length === 0) { rec.type = 'X'; detail({ why: 'placed だが目標座標に梁芯が無い', spanRefs: src.spanRefs }); return; }
  const overlap = (cl) => Math.min(cl.extentHi ?? Infinity, e.hi) - Math.max(cl.extentLo ?? -Infinity, e.lo);
  const cl = [...axes].sort((a, b) => overlap(b) - overlap(a))[0];
  if (!spansFull(cl.extentLo, cl.extentHi, e)) {
    if (cl.beamAxisOrigin !== BeamAxisOrigin.OPENING) {
      rec.type = 'K'; detail({ hostKind: 'reusedAxis', origin: cl.beamAxisOrigin ?? null, ext: [rnd(cl.extentLo), rnd(cl.extentHi)], note: 'placed だが他由来の梁芯を流用し extent が辺を覆わない' });
      return;
    }
    // OPENING 由来で extent が足りない: 直交の端のつなぎ先が照合の余りか
    const orthoType = e.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const ends = {};
    for (const side of ['lo', 'hi']) {
      const ref = src.spanRefs[side];
      const byId = ref.clId != null ? graph.shapeMap.get(ref.clId) : null;
      const anchor = byId ?? findOpeningBeamAnchorCL(graph, orthoType, ref.coord, { lo: src.coord, hi: src.coord, touchCounts: true });
      ends[side] = {
        refKind: ref.kind, anchor: anchor ? { id: anchor.id.slice(0, 8), origin: anchor.beamAxisOrigin ?? null, matched: matchedIds.has(anchor.id) } : null,
        orphan: !!anchor && anchor.beamAxisOrigin === BeamAxisOrigin.OPENING && !matchedIds.has(anchor.id),
      };
    }
    if (ends.lo.orphan || ends.hi.orphan) { rec.type = 'O'; detail({ ends, ext: [rnd(cl.extentLo), rnd(cl.extentHi)] }); return; }
    rec.type = 'X'; detail({ why: 'OPENING 梁芯の extent が辺を覆わない（端のつなぎ先は孤児でない）', ends, ext: [rnd(cl.extentLo), rnd(cl.extentHi)] });
    return;
  }
  const sec = await secondaryCause(gctx, cl, role, e);
  rec.type = 'U'; rec.sub = sec.cause; detail({ hostKind: 'placedAxis', origin: cl.beamAxisOrigin ?? null, ...sec });
}

// ---------- 全階 ----------
async function classifyProject(project, label) {
  const planes = [];
  const records = [];
  const problems = [];
  let wood = { edges: 0, oldUncovered: 0, newUncovered: 0 };
  for (const plane of project.planes) {
    const r = await classifyPlane(plane, project, label);
    planes.push({ plane: r.plane, structure: r.structure, openingRule: r.openingRule, edgeCount: r.edgeCount, oldUncovered: r.oldUncovered, newUncovered: r.newUncovered, newSpecUncovered: r.newSpecUncovered, selfCheck: r.selfCheck });
    for (const s of r.selfCheck) problems.push(`${label}|${r.plane}: ${s}`);
    if (r.woodSkipped) { wood.edges += r.woodSkipped.edges; wood.oldUncovered += r.woodSkipped.oldUncovered; wood.newUncovered += r.woodSkipped.newUncovered; }
    records.push(...r.records);
  }
  return { planes, records, problems, wood };
}

function tallyOf(records) {
  const t = Object.fromEntries([...TYPES, 'Q'].map(k => [k, 0]));
  for (const r of records) t[r.type] = (t[r.type] ?? 0) + 1;
  return t;
}

/** 型ごとの件数・総数・自己点検（total 独立計算との一致）をまとめる。 */
function summarize(chunks) {
  const records = chunks.flatMap(c => c.records);
  const tally = tallyOf(records);
  const total = records.length;
  const sum = Object.values(tally).reduce((s, v) => s + v, 0);
  const oldIndep = chunks.reduce((s, c) => s + c.planes.reduce((a, p) => a + (p.openingRule === 'slabOpenings' ? p.oldUncovered : 0), 0), 0);
  const newIndep = chunks.reduce((s, c) => s + c.planes.reduce((a, p) => a + (p.openingRule === 'slabOpenings' ? p.newUncovered : 0), 0), 0);
  const oldRec = records.filter(r => r.oldUncovered).length;
  const newRec = records.filter(r => r.newUncovered).length;
  const newSpecRec = records.filter(r => r.newSpecUncovered).length;
  const newSpecIndep = chunks.reduce((s, c) => s + c.planes.reduce((a, p) => a + (p.openingRule === 'slabOpenings' ? p.newSpecUncovered : 0), 0), 0);
  const problems = chunks.flatMap(c => c.problems);
  const checks = {
    sumEqualsTotal: sum === total,
    oldTotalMatchesIndependent: oldRec === oldIndep,
    newTotalMatchesIndependent: newRec === newIndep && newSpecRec === newSpecIndep,
    unknownType: records.filter(r => !r.type).length,
  };
  const ok = checks.sumEqualsTotal && checks.oldTotalMatchesIndependent && checks.newTotalMatchesIndependent && checks.unknownType === 0 && problems.length === 0;
  const subs = {};
  for (const r of records) {
    if (r.type === 'P') subs[`P/${r.sub}`] = (subs[`P/${r.sub}`] ?? 0) + 1;
    if (r.type === 'U') { const k = `U/${r.sub}${r.detail?.missingHost ? '→' + [...new Set(r.detail.missingHost.map(x => x.reason))].sort().join('+') : ''}`; subs[k] = (subs[k] ?? 0) + 1; }
    if (r.type?.startsWith('G') && r.reasons) {
      const any = r.reasons.some(x => x.anyInside);
      if (any) subs[`${r.type}/一部は建物内(中点判定の偽陰性候補)`] = (subs[`${r.type}/一部は建物内(中点判定の偽陰性候補)`] ?? 0) + 1;
    }
  }
  return {
    uncoveredTotal: total, oldUncovered: oldRec, newUncovered: newRec, newSpecUncovered: newSpecRec, oldIndependent: oldIndep, newIndependent: newIndep,
    tally, subs, statusMismatchEdges: records.filter(r => r.statusMismatch).length, checks, selfCheckProblems: problems, selfCheckOk: ok,
    wood: chunks.reduce((a, c) => ({ edges: a.edges + c.wood.edges, oldUncovered: a.oldUncovered + c.wood.oldUncovered, newUncovered: a.newUncovered + c.wood.newUncovered }), { edges: 0, oldUncovered: 0, newUncovered: 0 }),
  };
}

function printSummary(title, s) {
  const row = TYPES.concat(['Q']).filter(k => s.tally[k] > 0 || k === 'P').map(k => `${k}=${s.tally[k]}`).join(' ');
  console.log(`[${title}] 覆われない辺(旧∪新)=${s.uncoveredTotal} 旧=${s.oldUncovered} 新(axisValueのみ)=${s.newSpecUncovered} 新(+軸CL座標)=${s.newUncovered} | ${row} | 自己点検=${s.selfCheckOk ? 'OK' : 'NG'}${s.statusMismatchEdges ? ` statusMismatch=${s.statusMismatchEdges}` : ''}`);
  if (!s.selfCheckOk) console.log(`  ! checks=${JSON.stringify(s.checks)} problems=${s.selfCheckProblems.slice(0, 5).join(' / ')}`);
}

// ---------- 入口 ----------
function resolveInputs(arg) {
  const parts = arg.split(',').map(s => s.trim()).filter(Boolean);
  const files = [];
  for (const p of parts) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (f.toLowerCase().endsWith('.stq')) files.push(path.join(p, f).replace(/\\/g, '/'));
    } else files.push(p);
  }
  return files;
}

const [inArg, outPath, mode = 'static'] = process.argv.slice(2);
if (!inArg || !outPath || !['static', 'move'].includes(mode)) {
  console.error('usage: kCoverClassifyProbe.mjs <in.stq|dir|a.stq,b.stq> <out.json> [static|move]');
  process.exit(1);
}
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const files = resolveInputs(inArg);

if (mode === 'static') {
  const inputs = [];
  for (const f of files) {
    const name = f.split('/').pop();
    const rec = { file: name };
    try {
      const { project } = loadDocument(f);
      rec.converged = await convergeProject(project);
      const c = await classifyProject(project, name);
      Object.assign(rec, c, { tally: tallyOf(c.records) });
    } catch (e) { rec.error = String(e?.stack ?? e).slice(0, 400); rec.records = []; rec.planes = []; rec.problems = []; rec.wood = { edges: 0, oldUncovered: 0, newUncovered: 0 }; }
    inputs.push(rec);
    const s = summarize([rec]);
    if (rec.error) console.log(`[${name}] 読めない/落ちた: ${rec.error.split('\n')[0]}`);
    else if (s.uncoveredTotal > 0 || !s.selfCheckOk || files.length <= 8) printSummary(name, s);
  }
  const okInputs = inputs.filter(i => !i.error);
  const summary = summarize(okInputs);
  summary.files = { total: inputs.length, ok: okInputs.length, failed: inputs.filter(i => i.error).map(i => ({ file: i.file, error: i.error.split('\n')[0] })) };
  summary.perFile = okInputs.filter(i => i.records.length > 0).map(i => ({ file: i.file, ...summarize([i]).tally }));
  fs.writeFileSync(outPath, JSON.stringify({ mode, inputs, summary }, null, 1));
  printSummary(`静止状態 合計 ${okInputs.length}/${inputs.length} 本`, summary);
  console.log(`G5(LG に置換)は LG も梁として被覆に数えるため覆われない辺には現れない(検出不能)。subs=${JSON.stringify(summary.subs)}`);
  console.log(`在来木造(計測のみ・分類対象外): ${JSON.stringify(summary.wood)}`);
  console.log(`読めない/落ちたファイル: ${JSON.stringify(summary.files.failed)}`);
} else {
  if (files.length !== 1) { console.error('move モードの入力は .stq 1 本'); process.exit(1); }
  const f = files[0];
  const name = f.split('/').pop();
  const { project } = loadDocument(f);
  const converged = await convergeProject(project);
  const maxSweeps = 6;
  const savedStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const saved = new Map(project.planes.map(p => [p.id, serializeGraph(project.graphMap.get(p.id))]));
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
  const baseC = await classifyProject(project, `${name}|base`);
  const base = { records: baseC.records, planes: baseC.planes, problems: baseC.problems, wood: baseC.wood };
  const trials = [];
  for (const plane of project.planes) {
    const graph = project.graphMap.get(plane.id);
    const rules = rulesFor(effectiveStructure(graph, project));
    if (rules.openingBeamAxes !== 'slabOpenings') continue;
    const belowPlane = belowPlaneOf(plane, project);
    const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
    const srcs = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
    const ids = [...new Set(srcs.map(s => s.axisCLId).filter(Boolean))];
    const axes = ids.map(id => graph.shapeMap.get(id)).filter(cl => cl && cl.value != null && centerLineKind(cl) !== 'beam');
    const plan = axes.map(cl => ({
      id: cl.id, from: cl.value,
      targets: [...new Set(graph.centerLines
        .filter(o => o !== cl && o.centerLineType === cl.centerLineType && centerLineKind(o) !== 'beam' && o.value != null && Math.abs(o.value - cl.value) > 0.5)
        .map(o => o.value))],
    }));
    for (const { id, from, targets } of plan) {
      for (const to of targets) {
        const rec = { plane: planeLabel(plane), from: rnd(from), to: rnd(to) };
        try {
          const cl = graph.shapeMap.get(id);
          rec.dir = dirChar(cl);
          runInAction(() => { cl.pendingDelta = to - from; });
          commitCLMoveOp(graph, project, cl, from);
          rec.convergedAt = await sweeps();
          const c = await classifyProject(project, `${name}|${rec.plane}|${dirChar(cl)}${rnd(from)}→${rnd(to)}`);
          rec.records = c.records; rec.problems = c.problems; rec.planes = c.planes; rec.wood = c.wood;
        } catch (e) { rec.error = String(e?.stack ?? e).slice(0, 400); rec.records = []; rec.problems = []; rec.planes = []; rec.wood = { edges: 0, oldUncovered: 0, newUncovered: 0 }; }
        finally {
          restoreStructCLs(project.structGraph, project.structuralInfo, savedStruct, project.memberGroupLedger);
          for (const p of project.planes) restoreGraph(project.graphMap.get(p.id), saved.get(p.id));
        }
        trials.push(rec);
      }
    }
  }
  const okTrials = trials.filter(t => !t.error);
  const summary = summarize(okTrials);
  summary.trialCount = trials.length;
  summary.trialErrors = trials.filter(t => t.error).map(t => ({ plane: t.plane, from: t.from, to: t.to, error: t.error.split('\n')[0] }));
  summary.nonConverged = okTrials.filter(t => t.convergedAt == null).length;
  summary.trialsWithUncovered = okTrials.filter(t => t.records.length > 0).length;
  summary.base = { converged, ...summarize([base]) };
  // 試行をまたいだ重複: 辺のキー（ファイル|階|位置|範囲）が同じものは同一の辺
  const distinct = new Map();
  for (const t of okTrials) for (const r of t.records) { const k = `${r.plane}|${r.key}|${r.type}`; distinct.set(k, (distinct.get(k) ?? 0) + 1); }
  summary.distinctEdgeTypes = distinct.size;
  fs.writeFileSync(outPath, JSON.stringify({ mode, input: f, converged, base, trials, summary }, null, 1));
  console.log(`試行数=${trials.length} 未収束=${summary.nonConverged} エラー=${trials.filter(t => t.error).length} 覆われない辺ありの試行=${summary.trialsWithUncovered} 異なる(辺,型)=${summary.distinctEdgeTypes}`);
  printSummary('基準(試行前)', summary.base);
  printSummary('移動試行 合計', summary);
  console.log(`subs=${JSON.stringify(summary.subs)}`);
  console.log(`在来木造(計測のみ): ${JSON.stringify(summary.wood)}`);
}
