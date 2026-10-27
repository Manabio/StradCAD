// 【S0 専用】case1/case2 は k1 前のコミット d0d8fa8 のコードにだけ当たる（k1 で置換対象が消えたため、以後は K_MODE=current のみ動く）。
// 課題(k)（cl-conversion-limits.md 限界16 (k)）S0: 開口の辺ごとの「流用された梁芯／新しく作られた開口梁芯／辺に乗る梁」の実測。
// 目的: RC・SRC・未定の階で、開口（吹抜け・昇降路・階段吹抜け・階段の破れ先）の辺と同じ座標に範囲の離れた梁芯があると
//   開口梁芯が作られず、辺の梁が欠けるか（開口梁芯の重複ガードに範囲判定が無い S造以外の既知の限界）を、現状／案1／案2 で比べる。
// 切替: K_MODE 環境変数＋ kModeSetup.mjs（ロードフック。製品コードは不変。kModeHooks.mjs 冒頭参照）。
//   current＝製品どおり／case1＝全主構造 rangeAware（端で接するのは別線）／case2＝非S造は rangeAware＋端で接するのも重なり。
// 前処理: hAnchorCoverageProbe.mjs convergeProject（structAnchorProbe.mjs と同じ。conform→壁再生成→梁芯追従→sweepUntilConverged 'desc'）。
//   他階 peek は project.graphMap の生きたグラフ（structAnchorProbe.mjs と同じ限界）。IDB へは書かない。
// 引数: <入力.stq> [出力.json]
// 使い方（ローダー必須。app/ で実行）:
//   K_MODE=case1 node --import ./scripts/testSetup.mjs --import ./scripts/probe/kModeSetup.mjs scripts/probe/kOpeningBeamProbe.mjs D:/tatsuya/Download/k-rc.stq out.json
// 出力: { src, mode, converged, planes:[{plane,structure,openingRule,edges:[...],digest:{...},counts:{...}}] }
//   edges[].key＝plane|V/H|coord|lo-hi（id を含まない位置キー。モード間の比較キー）。
//   edges[].axes＝辺の目標座標にある梁芯・通り芯（kind・由来・extent。由来 opening＝新しく作られた／流用の判定は origin で読む）。
//   edges[].beams＝その座標を軸にする梁（role・長さ）。coveredLen＝辺の範囲 [lo,hi] を梁が覆う長さ（和集合）。
//   digest＝モード間の差の件数を数える全体ダンプ（開口梁芯・梁・柱。位置キー）。
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { effectiveStructure, rulesFor } from '../../src/structural/structureRules.js';
import { openingEdgeComponents, openingBeamSourcesDiagnostics, openingBeamSourcesFor, edgeTarget } from '../../src/structural/openingBeamAxes.js';
import { belowPlaneOf } from '../../src/structural/wallBeamAxes.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('kOpeningBeamProbe.mjs');
const short = (id) => (id ? id.slice(0, 8) : null);
const TOL = 1;

/** [lo,hi] 区間群を [a,b] に切って和集合の長さを返す。 */
function coveredLength(intervals, a, b) {
  const xs = intervals.map(([lo, hi]) => [Math.max(lo, a), Math.min(hi, b)]).filter(([lo, hi]) => hi > lo).sort((p, q) => p[0] - q[0]);
  let total = 0, curLo = null, curHi = null;
  for (const [lo, hi] of xs) {
    if (curHi == null || lo > curHi) { if (curHi != null) total += curHi - curLo; curLo = lo; curHi = hi; } else curHi = Math.max(curHi, hi);
  }
  if (curHi != null) total += curHi - curLo;
  return total;
}

export function measurePlane(plane, project) {
  const graph = project.graphMap.get(plane.id);
  const structure = effectiveStructure(graph, project);
  const rules = rulesFor(structure);
  const belowPlane = belowPlaneOf(plane, project);
  const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
  const riserOf = (s) => stairRiserOf(s, project, plane);
  const out = { plane: plane.name, structure, openingRule: rules.openingBeamAxes ?? null, rangeAwareNow: rules.manualBeamAxisOnArchLines === true, edges: [] };
  const sources = openingBeamSourcesFor(graph, project, { riserOf, belowGraph });
  const diag = openingBeamSourcesDiagnostics(graph, project, { riserOf, belowGraph });
  out.counts = {
    sources: sources.length, skipped: diag.skipped ?? null, components: diag.componentCount ?? 0, edgeCount: diag.edgeCount ?? 0,
    covered: diag.coveredCount ?? 0, excluded: diag.excludedCount ?? 0, unsupported: diag.unsupportedCount ?? 0,
  };
  const statusOf = (isVertical, target) => diag.edges?.find(e => e.isVertical === isVertical && Math.abs(e.target - target) < TOL)?.status ?? null;
  if (rules.openingBeamAxes === 'slabOpenings' || rules.openingBeamAxes === 'slabOpeningsDirect') {
    for (const comp of openingEdgeComponents(graph, { riserOf, belowGraph })) {
      for (const edge of comp) {
        const t = edgeTarget(graph, edge, rules);
        const type = edge.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
        const axes = graph.centerLines
          .filter(c => c.centerLineType === type && Math.abs(c.effectiveValue - t.coord) < TOL && ['beam', 'struct'].includes(centerLineKind(c)))
          .map(c => ({ id: short(c.id), kind: centerLineKind(c), origin: c.beamAxisOrigin ?? null, ext: [rnd(c.extentLo), rnd(c.extentHi)] }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const beams = graph.beams.filter(b => b.isVertical === edge.isVertical && Math.abs(b.axisValue - t.coord) < TOL)
          .map(b => {
            const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
            return { role: b.role ?? null, lo: rnd(Math.min(a, c)), hi: rnd(Math.max(a, c)), len: rnd(Math.abs(c - a)), status: b.dimensionStatus ?? null };
          }).sort((a, b) => a.lo - b.lo || a.hi - b.hi);
        out.edges.push({
          key: `${plane.name}|${edge.isVertical ? 'V' : 'H'}|${rnd(edge.coord)}|${rnd(edge.lo)}-${rnd(edge.hi)}`,
          isVertical: edge.isVertical, coord: rnd(edge.coord), target: rnd(t.coord), lo: rnd(edge.lo), hi: rnd(edge.hi), edgeLen: rnd(edge.hi - edge.lo),
          source: edge.source, status: statusOf(edge.isVertical, t.coord), axes, beams,
          coveredLen: rnd(coveredLength(beams.map(b => [b.lo, b.hi]), edge.lo, edge.hi)),
          secondaryCount: beams.filter(b => b.role === 'secondary').length, primaryCount: beams.filter(b => b.role === 'primary').length,
        });
      }
    }
  }
  const beamAxes = graph.centerLines.filter(c => centerLineKind(c) === 'beam')
    .map(c => `${c.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H'}:${rnd(c.effectiveValue)}:${c.beamAxisOrigin ?? '-'}:${rnd(c.extentLo)}:${rnd(c.extentHi)}`).sort();
  out.digest = {
    beamAxes,
    beams: graph.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${rnd(b.axisValue)}:${rnd(b.clStart.effectiveValue)}:${rnd(b.clEnd.effectiveValue)}`).sort(),
    columns: graph.columns.map(c => `${rnd(c.axisX)}:${rnd(c.axisY)}:${c.role ?? '-'}`).sort(),
  };
  return out;
}

if (isMain) {
  const src = process.argv[2];
  const outPath = process.argv[3] ?? null;
  if (!src) { console.error('usage: kOpeningBeamProbe.mjs <in.stq> [out.json]'); process.exit(1); }
  if (outPath && fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
  const { project } = loadDocument(src);
  const converged = await convergeProject(project);
  if (converged == null) console.error(`警告: 構造再計算が収束しなかった: ${src}`);
  const planes = project.planes.map(p => measurePlane(p, project));
  const out = { src, mode: process.env.K_MODE ?? 'current', converged, planes };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({
    src, mode: out.mode, converged,
    planes: planes.map(p => `${p.plane}:${p.structure}:${p.openingRule}:src=${p.counts.sources}:edges=${p.edges.length}`),
  }));
}
