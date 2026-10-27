// 課題(k) k1c: 構造の再計算（収束まで）で開口梁芯・梁が増え続けないか（冪等性）の実測。
// 目的: 「同じ線上に並ぶ 2 つの開口の辺を通り芯が区切る」配置で、再計算のたびに同座標・同 extent の開口梁芯と小梁が増える不良
//   （k1 の回帰）を、本番の commitCLMoveOp ＋ 本番と同じ並びの全階再計算（sweep）で再現・確認する。
// 引数: <入力.stq> <出力.json> [--move=階名:H|V:値:移動量 ...] [--structure=S造|RC造(ラーメン)|SRC造|undecided] [--sweeps=8] [--rebuild]
//   --move: 指定階の中心線（種別 center／struct／aux のいずれか）を commitCLMoveOp で動かす（複数指定可）。
//   --structure: 全階の structureOverride を上書きする（RC に上書き等）。
//   --rebuild: 収束後、全階の開口由来梁芯を消して（除外記録なし）もう一度 sweep する（作り直しの冪等性）。
// 出力: { src, steps:[{label, sweeps:[{i, changed:[...], perPlane:{階:{openingAxes,beams,axes:[位置キー],beamKeys:[...]}}}], convergedAt}] }
//   位置キーは id を含まない。既存出力は上書きしない。
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/kIdempotentProbe.mjs D:/tatsuya/Download/opening-test.stq out.json --move=2階:H:7500:-8500
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel, roofMainStructure } from './sweepOrder.mjs';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { BeamAxisOrigin, centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';

const [src, outPath, ...rest] = process.argv.slice(2);
if (!src || !outPath) { console.error('usage: kIdempotentProbe.mjs <in.stq> <out.json> [--move=...] [--structure=...] [--sweeps=N] [--rebuild]'); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }
const moves = rest.filter(a => a.startsWith('--move=')).map(a => a.slice(7).split(':')).map(([plane, dir, value, delta]) => ({ plane, dir, value: Number(value), delta: Number(delta) }));
const structure = rest.find(a => a.startsWith('--structure='))?.slice(12) ?? null;
const maxSweeps = Number(rest.find(a => a.startsWith('--sweeps='))?.slice(9) ?? 8);
const rebuild = rest.includes('--rebuild');
const dirChar = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H');

const { project } = loadDocument(src);
if (structure) {
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    g.structureOverride = structure === 'undecided' ? null : structure;
  }
  if (structure === 'undecided') project.structuralInfo.mainStructure = null;
  else project.structuralInfo.mainStructure = structure;
}
const conv0 = await convergeProject(project);

function snapshot() {
  const perPlane = {};
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    const axes = g.centerLines.filter(c => centerLineKind(c) === 'beam')
      .map(c => `${dirChar(c)}:${rnd(c.effectiveValue)}:${c.beamAxisOrigin ?? '-'}:${rnd(c.extentLo)}:${rnd(c.extentHi)}`).sort();
    const beamKeys = g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${rnd(b.axisValue)}:${rnd(b.clStart.effectiveValue)}:${rnd(b.clEnd.effectiveValue)}`).sort();
    const columns = g.columns.map(c => `${rnd(c.axisX)}:${rnd(c.axisY)}:${c.role ?? '-'}`).sort();
    perPlane[planeLabel(p)] = {
      openingAxes: g.centerLines.filter(c => c.beamAxisOrigin === BeamAxisOrigin.OPENING).length,
      beams: g.beams.length, axes, beamKeys, columns,
    };
  }
  return perPlane;
}

async function sweepRecord(label) {
  const roofPlane = project.roofPlane;
  const includeRoof = !!roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure);
  const real = [...project.planes].reverse();
  const planes = includeRoof ? [roofPlane, ...real] : real;
  const sweeps = [];
  let convergedAt = null;
  for (let i = 1; i <= maxSweeps; i++) {
    const changed = [];
    for (const p of planes) {
      const g = project.graphMap.get(p.id);
      const ms = p.isRoofPlane ? roofMainStructure(project) : (g.structureOverride ?? project.structuralInfo.mainStructure);
      const { changed: c } = await recomputeStructuralForGraph(g, project, ms);
      if (c) changed.push(planeLabel(p));
    }
    const snap = snapshot();
    sweeps.push({ i, changed, counts: Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, `open=${v.openingAxes} beams=${v.beams}`])), perPlane: snap });
    if (changed.length === 0) { convergedAt = i; break; }
  }
  return { label, convergedAt, sweeps };
}

const steps = [];
steps.push({ label: `initial(converged=${conv0})`, convergedAt: conv0, sweeps: [{ i: 0, changed: [], counts: {}, perPlane: snapshot() }] });

for (const m of moves) {
  const plane = project.planes.find(p => planeLabel(p) === m.plane);
  if (!plane) throw new Error(`階が無い: ${m.plane}`);
  const graph = project.graphMap.get(plane.id);
  const type = m.dir === 'V' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const cl = graph.centerLines.find(c => c.centerLineType === type && Math.abs(c.effectiveValue - m.value) < 0.5 && centerLineKind(c) !== 'beam');
  if (!cl) throw new Error(`中心線が無い: ${m.plane} ${m.dir}${m.value}`);
  runInAction(() => { cl.pendingDelta = m.delta; });
  commitCLMoveOp(graph, project, cl, m.value);
  console.error(`move ${m.plane} ${m.dir}${m.value} ${m.delta} kind=${centerLineKind(cl)}`);
}
if (moves.length > 0) steps.push(await sweepRecord('after-move'));
else steps.push(await sweepRecord('no-move'));

if (rebuild) {
  for (const p of project.planes) {
    const g = project.graphMap.get(p.id);
    runInAction(() => {
      for (const c of [...g.centerLines]) if (c.beamAxisOrigin === BeamAxisOrigin.OPENING) g.removeCenterLine(c.id);
    });
  }
  steps.push(await sweepRecord('rebuild'));
}

fs.writeFileSync(outPath, JSON.stringify({ src, structure, moves, steps }, null, 1));
for (const s of steps) {
  console.log(`## ${s.label} convergedAt=${s.convergedAt}`);
  for (const sw of s.sweeps) console.log(`  sweep${sw.i}: changed=[${sw.changed.join(',')}] ${JSON.stringify(sw.counts)}`);
}
