// 課題(k) k1c の調査用: 指定の移動を通した後、指定階の開口の源（openingBeamSourcesFor）と開口由来梁芯（extent・参照先）を並べて出す。
// 引数: <入力.stq> <階名> <H|V> <値> <移動量> [--structure=...]   使い方（app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/kSourcesDump.mjs D:/tatsuya/Download/opening-test.stq 2階 H 6500 3000
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';
import { planeLabel, roofMainStructure } from './sweepOrder.mjs';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { openingBeamSourcesFor } from '../../src/structural/openingBeamAxes.js';
import { belowPlaneOf } from '../../src/structural/wallBeamAxes.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { BeamAxisOrigin, centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { commitCLMoveOp } from '../../src/transform/centerLineOps.js';

const [src, planeName, dir, valueArg, deltaArg] = process.argv.slice(2);
const { project } = loadDocument(src);
await convergeProject(project);
const plane = project.planes.find(p => planeLabel(p) === planeName);
const graph = project.graphMap.get(plane.id);
const type = dir === 'V' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
const cl = graph.centerLines.find(c => c.centerLineType === type && Math.abs(c.effectiveValue - Number(valueArg)) < 0.5 && centerLineKind(c) !== 'beam');
runInAction(() => { cl.pendingDelta = Number(deltaArg); });
commitCLMoveOp(graph, project, cl, Number(valueArg));
const short = (id) => (id ? id.slice(0, 4) : '-');
const dump = (tag) => {
  const belowPlane = belowPlaneOf(plane, project);
  const belowGraph = belowPlane ? (project.graphMap.get(belowPlane.id) ?? null) : null;
  const srcs = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
  console.log(`--- ${tag}`);
  for (const s of srcs) console.log(`  源 ${s.isVertical ? 'V' : 'H'}${rnd(s.coord)} [${rnd(s.lo)},${rnd(s.hi)}] order=${s.order} through=${s.through} lo=${s.spanRefs.lo.kind}:${rnd(s.spanRefs.lo.coord)}:${short(s.spanRefs.lo.clId)} hi=${s.spanRefs.hi.kind}:${rnd(s.spanRefs.hi.coord)}:${short(s.spanRefs.hi.clId)}`);
  for (const c of graph.centerLines.filter(c => centerLineKind(c) === 'beam' && c.beamAxisOrigin === BeamAxisOrigin.OPENING)) {
    console.log(`  梁芯 ${short(c.id)} ${c.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H'}${rnd(c.effectiveValue)} [${rnd(c.extentLo)},${rnd(c.extentHi)}] loRef=${short(c.extentLoRef?.clId)} hiRef=${short(c.extentHiRef?.clId)}`);
  }
};
dump('移動直後');
for (let i = 1; i <= 3; i++) {
  for (const p of [...project.planes].reverse()) {
    const g = project.graphMap.get(p.id);
    await recomputeStructuralForGraph(g, project, g.structureOverride ?? project.structuralInfo.mainStructure);
  }
  dump(`sweep${i}`);
}
void roofMainStructure;
