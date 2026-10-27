// 課題(k) (3)(4) S0: k4TrialProbe の拡張版（計測だけ。製品コードは変えない）。
// 既存の出力項目（convergedAt・idsLost・idsNew・partial・uncovered・final・overlaps・dupAxes ほか）はそのまま残し、
// k4TrialCompare.mjs で比べられる形を保つ。足す項目:
//   (a) reach        : 実アプリの可動範囲（全階のグラフで組んだ bundle の collectFollowerOffsets＋computeMoveRange）に目標が届くか。
//                      'in'=範囲の内側／'edge'=範囲の端ちょうど（障害物の座標そのもの）／'out'=範囲外（probe だけが届く）。
//                      moverShared=true（通り芯）なら全階、そうでなければ自階のグラフだけで組む（gatherScanGraphs と同じ）。
//   (b) landKinds    : 移動前に目標座標（0.5mm 以内）にあった同向き・別の線の種別（struct／beam:origin／center／aux／ceiling）。
//       landStructAfter : 移動後、着地座標の 0.5mm 以内にある同向きの通り芯の本数（動かした線自身を除く）。
//       sameCoordStruct : 動かした線が struct かつ landStructAfter>=1（(3) の「通り芯どうしの同座標」）。
//   (c) byRole       : role 別の重なり（legacy overlaps() と同じ判定＝同 role・同向き・同じ軸位置（0.1mm丸め一致）・1mm超の重なり）、
//       zeroBeams    : 長さ0（|a−b|<0.5）の梁の数（role 別）、dupColumns/dupFootings: 同位置（0.5mm 以内）の柱・独立フーチングの余り数。
//   (d) dupPairs     : 同座標（0.5mm 以内）・同向きで範囲が 1mm 超重なる梁芯の組ごとの内訳（由来・refId・保護の理由・参照している CL・
//                      出現時点 appearedAt='baseline'|'follow'|'recompute'・transient=追従直後だけ存在して再計算後に消えたか・route）。
//       secOverlap/secSameSpan : 同座標（0.5mm 以内）・同向きで範囲が 1mm 超重なる role secondary の梁の組数／その内、支えの組（min/max）が 0.5mm 以内で一致する組数。
// 経路の分類 route（優先順）: iii=reach が 'out'（probe だけが届く）／ii=refId を持つ梁芯が動かした線または随伴線を参照／iv=OPENING×SLAB_BEAM／
//   i=どちらかが保護された梁芯／other。baseline（収束後の初期状態）に既にある組は route='preexisting'。
// 引数（app/ で実行）:
//   試行: node --import ./scripts/testSetup.mjs scripts/probe/k34TrialProbe.mjs trial <入力.stq> <出力名.json> [src|all] [maxSweeps=6] [maxT=4]
//   静的: node --import ./scripts/testSetup.mjs scripts/probe/k34TrialProbe.mjs static <出力名.json> <入力.stq...>
// 出力は OUT_DIR 配下（無ければ mkdir。出力名は basename だけ使う）。既存ファイルは上書きしない。
// 簡略化（実アプリとの差）: k4TrialProbe と同じ（結合・IDB 書込みなし、他階 peek は生きたグラフ）。
import fs from 'node:fs';
import path from 'node:path';
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
import { CenterLineType, ShapeType } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';
import { collectFollowerOffsets, computeMoveRange, isSharedCL } from '../../src/transform/followerGraph.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../../src/graphSnapshot.js';

// 出力先は環境変数 K34_OUT_DIR で差し替えられる（問題3 S1 の前後比較で s3 へ出すため）。
const OUT_DIR = process.env.K34_OUT_DIR
  ?? 'D:/tatsuya/AppData/claude/temp/d--tatsuya-dev-strad/4b8f6dc1-faa2-417b-bb63-2614a90a9873/scratchpad/s0/k34';
const TOL = 0.5;      // 同座標・同位置の許容 (mm)
const OVL = 1;        // 範囲の重なりとみなす下限 (mm)
const EDGE = 1e-6;    // 可動範囲の端ちょうど判定 (mm)
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');
const sh = (id) => id.slice(0, 8);

const [cmd, ...rest] = process.argv.slice(2);
function outFile(name) {
  if (!name) { console.error('出力名がありません'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, path.basename(name));
  if (fs.existsSync(p)) { console.error(`既存ファイルを上書きしません: ${p}`); process.exit(1); }
  return p;
}
if (cmd !== 'trial' && cmd !== 'static') {
  console.error('usage: k34TrialProbe.mjs trial <in.stq> <out.json> [src|all] [maxSweeps] [maxT] | static <out.json> <in.stq...>');
  process.exit(1);
}

// ---------------------------------------------------------------- 計測部品
const beamCLs = (g) => g.centerLines.filter(c => centerLineKind(c) === 'beam');
const lo = (v) => (v == null ? -Infinity : v);
const hi = (v) => (v == null ? Infinity : v);
const overlapLen = (a, b) => Math.min(hi(a.extentHi), hi(b.extentHi)) - Math.max(lo(a.extentLo), lo(b.extentLo));

/** isProtectedWallBeamAxis（wallBeamAxes.js）の判定を理由ごとに分けて返す（ignoreRefsFrom なし。コピーなので本体の変更に追従しない）。 */
function protectReasons(g, cl) {
  const r = [];
  if (cl.beamAxisOrigin === 'user') r.push('user');
  if (cl.refId != null) r.push('refId');
  if (g.columns.some(c => (c.verticalCL.id === cl.id || c.horizontalCL.id === cl.id) && c.dimensionStatus !== 'auto')) r.push('column');
  if (g.beams.some(b => (b.axisCL.id === cl.id || b.clStart.id === cl.id || b.clEnd.id === cl.id) && b.dimensionStatus !== 'auto')) r.push('beam');
  if (g.footings.some(f => (f.verticalCL.id === cl.id || f.horizontalCL.id === cl.id) && f.dimensionStatus !== 'auto')) r.push('footing');
  if (g.structuralWalls.some(w => w.axisCL.id === cl.id || w.clStart.id === cl.id || w.clEnd.id === cl.id)) r.push('structuralWall');
  if (g.sleeves.some(s => s.hostType === 'beam' && (s.hostAxisCL?.id === cl.id || s.hostClStart?.id === cl.id || s.hostClEnd?.id === cl.id))) r.push('sleeve');
  if (g.columnAxisOffsets.has(cl.id)) r.push('columnAxisOffset');
  if (g.clEccentricities.has(cl.id)) r.push('clEccentricity');
  if (g.isReferencedByOtherCL(cl.id)) r.push('referenced');
  return r;
}
const kindTag = (c) => (centerLineKind(c) === 'beam' ? `beam:${c.beamAxisOrigin ?? '-'}` : centerLineKind(c));
function axisInfo(g, cl) {
  return {
    id: sh(cl.id), value: rnd(cl.effectiveValue), lo: rnd(cl.extentLo), hi: rnd(cl.extentHi),
    origin: cl.beamAxisOrigin ?? null, hasRefId: cl.refId != null, refTarget: cl.refId ? (cl._referencedCL ? `${kindTag(cl._referencedCL)}:${sh(cl._referencedCL.id)}` : 'unresolved') : null,
    protect: protectReasons(g, cl),
    referencedBy: g.referencingCenterLines(cl.id).map(o => `${kindTag(o)}:${sh(o.id)}${o.refId === cl.id ? '(refId)' : ''}`),
  };
}

/** 平面 g の梁芯の重複組（同向き・0.5mm 以内・範囲が 1mm 超重なる）。a,b は CenterLine。 */
function dupAxisPairs(g) {
  const axes = beamCLs(g).filter(c => c.effectiveValue != null);
  const out = [];
  for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) {
    const a = axes[i], b = axes[j];
    if (a.centerLineType !== b.centerLineType) continue;
    if (Math.abs(a.effectiveValue - b.effectiveValue) >= TOL) continue;
    if (overlapLen(a, b) <= OVL) continue;
    out.push([a, b]);
  }
  return out;
}
const pairKey = (a, b) => [a.id, b.id].sort().join('|');

/** 平面 g の計測（梁の重なり byRole・長さ0・同位置の柱/フーチング・secondary 重複・梁芯重複組数）。 */
function measureGraph(g) {
  const beams = g.beams.map(b => {
    const s = b.clStart.effectiveValue, e = b.clEnd.effectiveValue;
    return { b, role: b.role, d: b.isVertical ? 'V' : 'H', v: rnd(b.axisValue), av: b.axisValue, lo: Math.min(s, e), hi: Math.max(s, e) };
  });
  const byRole = {}, zeroBeams = {};
  for (let i = 0; i < beams.length; i++) {
    const a = beams[i];
    if (a.hi - a.lo < TOL) zeroBeams[a.role] = (zeroBeams[a.role] || 0) + 1;
    for (let j = i + 1; j < beams.length; j++) {
      const c = beams[j];
      // legacy overlaps() と同じ判定（snapshot は 0.1mm 丸め後の値で比べる）
      if (a.d === c.d && a.v === c.v && a.role === c.role && Math.min(rnd(a.hi), rnd(c.hi)) - Math.max(rnd(a.lo), rnd(c.lo)) > 1) byRole[a.role] = (byRole[a.role] || 0) + 1;
    }
  }
  // secondary: 同向き・軸 0.5mm 以内・範囲 1mm 超の重なり
  const sec = beams.filter(x => x.role === 'secondary');
  let secOverlap = 0, secSameSpan = 0, secDiffAxisCL = 0;
  for (let i = 0; i < sec.length; i++) for (let j = i + 1; j < sec.length; j++) {
    const a = sec[i], c = sec[j];
    if (a.d !== c.d || Math.abs(a.av - c.av) >= TOL) continue;
    if (Math.min(a.hi, c.hi) - Math.max(a.lo, c.lo) <= OVL) continue;
    secOverlap++;
    if (Math.abs(a.lo - c.lo) < TOL && Math.abs(a.hi - c.hi) < TOL) secSameSpan++;
    if (a.b.axisCL.id !== c.b.axisCL.id) secDiffAxisCL++;
  }
  const samePos = (pts) => { let n = 0; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (Math.abs(pts[i][0] - pts[j][0]) < TOL && Math.abs(pts[i][1] - pts[j][1]) < TOL) n++; return n; };
  const dupColumns = samePos(g.columns.map(c => [c.axisX, c.axisY]));
  const dupFootings = samePos(g.footings.map(f => [f.verticalCL.effectiveValue, f.horizontalCL.effectiveValue]));
  const pairs = dupAxisPairs(g);
  return { byRole, zeroBeams, secOverlap, secSameSpan, secDiffAxisCL, dupColumns, dupFootings, axisPairs: pairs.length, pairs };
}
const sumObj = (o) => Object.values(o).reduce((s, v) => s + v, 0);
function planesOf(project, withRoof) {
  const ps = [...project.planes];
  if (withRoof && project.roofPlane && !ps.includes(project.roofPlane)) ps.push(project.roofPlane);
  return ps;
}
function measureAll(project, withRoof = false) {
  const res = {};
  for (const p of planesOf(project, withRoof)) {
    const g = project.graphMap.get(p.id);
    if (g) res[planeLabel(p)] = measureGraph(g);
  }
  return res;
}
/** measureAll の結果を件数だけの形へ（JSON 出力用。pairs は除く）。 */
function totals(m) {
  const t = { byRole: {}, zeroBeams: {}, secOverlap: 0, secSameSpan: 0, secDiffAxisCL: 0, dupColumns: 0, dupFootings: 0, axisPairs: 0 };
  for (const x of Object.values(m)) {
    for (const [k, v] of Object.entries(x.byRole)) t.byRole[k] = (t.byRole[k] || 0) + v;
    for (const [k, v] of Object.entries(x.zeroBeams)) t.zeroBeams[k] = (t.zeroBeams[k] || 0) + v;
    for (const k of ['secOverlap', 'secSameSpan', 'secDiffAxisCL', 'dupColumns', 'dupFootings', 'axisPairs']) t[k] += x[k];
  }
  return t;
}
function pairKeys(m) {
  const s = new Map();
  for (const [pl, x] of Object.entries(m)) for (const [a, b] of x.pairs) s.set(`${pl}|${pairKey(a, b)}`, { pl, a, b });
  return s;
}

// ---------------------------------------------------------------- 試行
async function runTrial([src, outName, mode = 'src', maxArg, maxTArg]) {
  if (!src || !outName) { console.error('usage: trial <in.stq> <out.json> [src|all] [maxSweeps] [maxT]'); process.exit(1); }
  const outPath = outFile(outName);
  const maxSweeps = Number(maxArg ?? 6);
  const maxT = Number(maxTArg ?? 4);
  const { project } = await loadDocument(src);
  await convergeProject(project);
  const savedStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const saved = new Map(project.planes.map(p => [p.id, serializeGraph(project.graphMap.get(p.id))]));
  const baseline = measureAll(project);
  const baseKeys = pairKeys(baseline);

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

  // followerGraph.js の gatherShapes（非 export）と同じ集め方
  function gatherShapes(graphs) {
    const seen = new Set(); const centerLines = []; const walls = []; const diagonals = [];
    for (const g of graphs) {
      for (const cl of g.centerLines) { if (!seen.has(cl)) { seen.add(cl); centerLines.push(cl); } }
      for (const s of g.shapes) {
        if (seen.has(s)) continue;
        if (s.type === ShapeType.WALL) { seen.add(s); walls.push(s); }
        else if (s.type === ShapeType.DIAGONAL) { seen.add(s); diagonals.push(s); }
      }
    }
    return { centerLines, walls, diagonals };
  }
  const allGraphs = () => planesOf(project, true).map(p => project.graphMap.get(p.id)).filter(Boolean);
  function reachOf(graph, cl, to) {
    const graphs = isSharedCL(cl) ? allGraphs() : [graph];
    const bundle = gatherShapes(graphs);
    const { offsetOf, exceeded } = collectFollowerOffsets(bundle, cl);
    const { min, max } = computeMoveRange(bundle, cl, offsetOf);
    let reach = 'in';
    if (to < min - EDGE || to > max + EDGE) reach = 'out';
    else if (Math.abs(to - min) < EDGE || Math.abs(to - max) < EDGE) reach = 'edge';
    const followers = new Set([...offsetOf.keys()].filter(s => s.id).map(s => s.id));
    return { reach, range: [Number.isFinite(min) ? rnd(min) : null, Number.isFinite(max) ? rnd(max) : null], exceeded: !!exceeded, followers, bundle };
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
        const rec = { plane: planeLabel(plane), dir: dirChar(cl), from: rnd(from), to: rnd(to), moverKind: centerLineKind(cl), moverId: sh(id) };
        try {
          // (a)(b) 移動前に届くか・着地先の種別
          const rr = reachOf(graph, cl, to);
          rec.reach = rr.reach; rec.range = rr.range; rec.exceeded = rr.exceeded; rec.moverShared = isSharedCL(cl);
          rec.landKinds = rr.bundle.centerLines.filter(o => o !== cl && o.centerLineType === cl.centerLineType && o.effectiveValue != null && Math.abs(o.effectiveValue - to) < TOL).map(kindTag).sort();

          const before = axisIds();
          runInAction(() => { cl.pendingDelta = to - from; });
          // 通り芯どうしの重複ガード（問題3・3A）で拒否されると toast が返り、値は from のまま（試行は何も変えない）
          rec.rejected = !!commitCLMoveOp(graph, project, cl, from).toast;
          const after = axisIds();
          const absorbed = [], moved = [];
          for (const [k, v] of before) {
            if (!after.has(k)) absorbed.push(v);
            else if (after.get(k) !== v) moved.push(`${v}=>${after.get(k).split('|')[1]}`);
          }
          rec.followAbsorbed = absorbed.sort(); rec.followMoved = moved.sort();
          rec.landStructAfter = allGraphs().flatMap(g => g.centerLines).filter((o, i, arr) => arr.indexOf(o) === i)
            .filter(o => o !== cl && o.centerLineType === cl.centerLineType && centerLineKind(o) === 'struct' && o.effectiveValue != null && Math.abs(o.effectiveValue - cl.effectiveValue) < TOL).length;
          rec.sameCoordStruct = rec.moverKind === 'struct' && rec.landStructAfter >= 1;
          const mFollow = measureAll(project);
          rec.convergedAt = await sweeps();
          const fin = axisIds();
          rec.idsLost = [...before.keys()].filter(k => !fin.has(k)).length;
          rec.idsNew = [...fin.keys()].filter(k => !before.has(k)).length;
          const c = cover();
          rec.partial = c.partial; rec.uncovered = c.uncovered;
          rec.final = snapshot();
          rec.overlaps = overlaps(rec.final); rec.dupAxes = dupAxes(rec.final);
          // (c)(d)
          const mFin = measureAll(project);
          const t = totals(mFin);
          rec.byRole = t.byRole; rec.zeroBeams = t.zeroBeams; rec.dupColumns = t.dupColumns; rec.dupFootings = t.dupFootings;
          rec.secOverlap = t.secOverlap; rec.secSameSpan = t.secSameSpan; rec.secDiffAxisCL = t.secDiffAxisCL;
          rec.dupAxisPairs = t.axisPairs;
          const followKeys = pairKeys(mFollow), finKeys = pairKeys(mFin);
          rec.dupPairs = [];
          for (const k of new Set([...followKeys.keys(), ...finKeys.keys()])) {
            const inBase = baseKeys.has(k), inFollow = followKeys.has(k), inFin = finKeys.has(k);
            if (inBase && !inFollow && !inFin) continue;
            const ent = finKeys.get(k) ?? followKeys.get(k);
            const g = project.graphMap.get(project.planes.find(p => planeLabel(p) === ent.pl).id);
            // 再計算後に消えたグラフ側の CL は g 上の探索で見つからないことがあるので、取れる範囲で情報を取る
            const ia = axisInfo(g, ent.a), ib = axisInfo(g, ent.b);
            const members = [ia, ib];
            const refToMover = [ent.a, ent.b].some(c => c.refId != null && (c.refId === cl.id || rr.followers.has(c.refId)));
            const origins = members.map(m => m.origin);
            let route;
            if (inBase) route = 'preexisting';
            else if (rec.reach === 'out') route = 'iii';
            else if (refToMover) route = 'ii';
            else if (origins.includes('opening') && origins.includes('slabBeam')) route = 'iv';
            else if (members.some(m => m.protect.length > 0)) route = 'i';
            else route = 'other';
            rec.dupPairs.push({
              plane: ent.pl, dir: dirChar(ent.a), a: ia, b: ib,
              appearedAt: inBase ? 'baseline' : (inFollow ? 'follow' : 'recompute'),
              presentAfterFollow: inFollow, presentFinal: inFin, transient: inFollow && !inFin, route,
            });
          }
        } catch (e) { rec.error = String(e?.message ?? e); } finally {
          restoreStructCLs(project.structGraph, project.structuralInfo, savedStruct, project.memberGroupLedger);
          for (const p of project.planes) restoreGraph(project.graphMap.get(p.id), saved.get(p.id));
        }
        trials.push(rec);
      }
    }
  }
  fs.writeFileSync(outPath, JSON.stringify({ src, mode, baseline: totals(baseline), trials }, null, 1));

  // ---- 要約
  const ok = trials.filter(t => !t.error);
  const cnt = (arr, f) => arr.reduce((m, t) => { const k = f(t); m[k] = (m[k] || 0) + 1; return m; }, {});
  const sumRole = (arr, key) => arr.reduce((m, t) => { for (const [r, v] of Object.entries(t[key] ?? {})) m[r] = (m[r] || 0) + v; return m; }, {});
  const scs = ok.filter(t => t.sameCoordStruct);
  const withPairs = ok.filter(t => (t.dupPairs ?? []).some(p => p.route !== 'preexisting'));
  const allPairs = ok.flatMap(t => (t.dupPairs ?? []).map(p => ({ ...p, reach: t.reach })));
  console.log(JSON.stringify({
    src, mode, out: outPath, trials: trials.length, errors: trials.filter(t => t.error).length,
    nonConv: ok.filter(t => t.convergedAt == null).length,
    baseline: totals(baseline),
    reach: cnt(ok, t => t.reach),
    moverKind: cnt(ok, t => t.moverKind),
    landOnAnyStruct: ok.filter(t => (t.landKinds ?? []).includes('struct')).length,
    sameCoordStruct: { trials: scs.length, reach: cnt(scs, t => t.reach), overlapsSum: scs.reduce((s, t) => s + t.overlaps, 0), byRole: sumRole(scs, 'byRole'), zeroBeams: sumRole(scs, 'zeroBeams'),
      dupColumns: scs.reduce((s, t) => s + t.dupColumns, 0), dupFootings: scs.reduce((s, t) => s + t.dupFootings, 0) },
    all: { overlapsSum: ok.reduce((s, t) => s + t.overlaps, 0), byRole: sumRole(ok, 'byRole'), zeroBeams: sumRole(ok, 'zeroBeams'),
      dupColumns: ok.reduce((s, t) => s + t.dupColumns, 0), dupFootings: ok.reduce((s, t) => s + t.dupFootings, 0) },
    dupAxesTrials: ok.filter(t => t.dupAxes > 0).length,
    dupAxisPairsTrials: ok.filter(t => t.dupAxisPairs > 0).length,
    newDupPairTrials: withPairs.length,
    pairRoutes: cnt(allPairs.filter(p => p.route !== 'preexisting'), p => p.route),
    pairAppearedAt: cnt(allPairs.filter(p => p.route !== 'preexisting'), p => p.appearedAt),
    pairTransient: allPairs.filter(p => p.transient).length,
    pairReachOfNew: cnt(allPairs.filter(p => p.route !== 'preexisting'), p => p.reach),
    secOverlapTrials: ok.filter(t => t.secOverlap > 0).length, secOverlapPairs: ok.reduce((s, t) => s + t.secOverlap, 0), secSameSpanPairs: ok.reduce((s, t) => s + t.secSameSpan, 0),
  }, null, 1));
}

// ---------------------------------------------------------------- 静的
async function runStatic([outName, ...files]) {
  if (!outName || files.length === 0) { console.error('usage: static <out.json> <in.stq...>'); process.exit(1); }
  const outPath = outFile(outName);
  const res = [];
  for (const f of files) {
    const rec = { file: f.split('/').pop().split('\\').pop() };
    try {
      const { project } = await loadDocument(f);
      rec.sweeps = await convergeProject(project);
      const planes = planesOf(project, true);
      const m = measureAll(project, true);
      // 通り芯（struct）の同座標組: 全階共有を想定して id の和集合で数える
      const structs = new Map();
      for (const p of planes) { const g = project.graphMap.get(p.id); if (g) for (const c of g.centerLines) if (centerLineKind(c) === 'struct' && c.effectiveValue != null) structs.set(c.id, c); }
      const sl = [...structs.values()];
      let structDup = 0; const structDupList = [];
      for (let i = 0; i < sl.length; i++) for (let j = i + 1; j < sl.length; j++) {
        if (sl[i].centerLineType === sl[j].centerLineType && Math.abs(sl[i].effectiveValue - sl[j].effectiveValue) < TOL) { structDup++; structDupList.push(`${dirChar(sl[i])}:${rnd(sl[i].effectiveValue)}/${rnd(sl[j].effectiveValue)}`); }
      }
      rec.structDup = structDup; rec.structDupList = structDupList;
      rec.structDupPlanes = planes.filter(p => {
        const g = project.graphMap.get(p.id); if (!g) return false;
        const l = g.centerLines.filter(c => centerLineKind(c) === 'struct' && c.effectiveValue != null);
        return l.some((a, i) => l.slice(i + 1).some(b => a.centerLineType === b.centerLineType && Math.abs(a.effectiveValue - b.effectiveValue) < TOL));
      }).length;
      rec.planes = Object.entries(m).map(([pl, x]) => ({
        plane: pl, byRole: x.byRole, zeroBeams: x.zeroBeams, secOverlap: x.secOverlap, secSameSpan: x.secSameSpan, secDiffAxisCL: x.secDiffAxisCL,
        dupColumns: x.dupColumns, dupFootings: x.dupFootings, axisPairs: x.axisPairs,
        pairs: x.pairs.map(([a, b]) => ({ dir: dirChar(a), a: axisInfo(project.graphMap.get(planes.find(p => planeLabel(p) === pl).id), a), b: axisInfo(project.graphMap.get(planes.find(p => planeLabel(p) === pl).id), b) })),
      }));
      rec.totals = totals(m);
    } catch (e) { rec.error = String(e?.message ?? e).slice(0, 300); }
    res.push(rec);
    console.log(rec.file, rec.error ?? `sweeps=${rec.sweeps} structDup=${rec.structDup} axisPairs=${rec.totals.axisPairs} secOverlap=${rec.totals.secOverlap} role=${JSON.stringify(rec.totals.byRole)} zero=${JSON.stringify(rec.totals.zeroBeams)} dupCol=${rec.totals.dupColumns} dupFtg=${rec.totals.dupFootings}`);
  }
  fs.writeFileSync(outPath, JSON.stringify(res));
  const ok = res.filter(r => !r.error);
  const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
  console.log(JSON.stringify({
    out: outPath, files: res.length, errors: res.filter(r => r.error).map(r => `${r.file}: ${r.error}`),
    filesWithStructDup: ok.filter(r => r.structDup > 0).map(r => `${r.file}(${r.structDup}組,${r.structDupPlanes}階)`),
    structDupPairs: sum(r => r.structDup), structDupFilePlanes: sum(r => r.structDupPlanes),
    axisPairs: sum(r => r.totals.axisPairs), filesWithAxisPairs: ok.filter(r => r.totals.axisPairs > 0).map(r => r.file),
    secOverlap: sum(r => r.totals.secOverlap), secSameSpan: sum(r => r.totals.secSameSpan), filesWithSecOverlap: ok.filter(r => r.totals.secOverlap > 0).map(r => r.file),
    overlapsByRole: ok.reduce((m, r) => { for (const [k, v] of Object.entries(r.totals.byRole)) m[k] = (m[k] || 0) + v; return m; }, {}),
    filesWithOverlap: ok.filter(r => sumObj(r.totals.byRole) > 0).map(r => r.file),
    zeroBeams: ok.reduce((m, r) => { for (const [k, v] of Object.entries(r.totals.zeroBeams)) m[k] = (m[k] || 0) + v; return m; }, {}),
    filesWithZero: ok.filter(r => sumObj(r.totals.zeroBeams) > 0).map(r => r.file),
    dupColumns: sum(r => r.totals.dupColumns), dupFootings: sum(r => r.totals.dupFootings),
    filesWithDupColFtg: ok.filter(r => r.totals.dupColumns + r.totals.dupFootings > 0).map(r => r.file),
  }, null, 1));
}

if (cmd === 'trial') await runTrial(rest); else await runStatic(rest);
