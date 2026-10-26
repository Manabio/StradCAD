// S0: 件数の採取。
//  (a) 同じ階・同じ座標に「通り芯」と梁芯が並ぶ（階,座標）／「中心線・補助線」と梁芯が並む（階,座標）。
//      並んでいるとき、新しい梁芯を梁芯の範囲外へ足すと existing が同種別の梁芯になり、通り芯の判定を
//      素通りしうる（S3-2 が直した抜け道）。beamsCoverAll=梁芯1本で直交する通り芯の全範囲を覆う
//      （＝範囲外へ足す余地が無い）かの近似。
//  (b) 開口由来梁芯の源ごとに、旧 findBeamAnchorCL と新 findOpeningBeamAnchorCL(lo/hi つき) の戻りが食い違う数。
//      新が無い版（ee352a1）では skipped。phase=loaded（保存時点）／converged（全階を再計算で収束させた後）。
//  (c) 階ごとの由来 SLAB_BEAM の梁芯の本数（木造階は 0 のはず）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/s0CountsProbe.mjs <入力.stq> [出力.json]
import { openDoc, planeHeader, writeOut, coordGroups } from './s0Common.mjs';
import { centerLineKind, BeamAxisOrigin } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { openingBeamSourcesFor } from '../../src/structural/openingBeamAxes.js';
import * as wba from '../../src/structural/wallBeamAxes.js';
import { rulesFor } from '../../src/structural/structureRules.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { structuralPlaneBelow } from '../../src/structural/drawingDesignation.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const project = openDoc(process.argv[2]);
const header = planeHeader(project);
const TOL = 1;

function perpRange(graph, type) {
  const ortho = type === 'vertical' ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const v = graph.centerLines.filter(c => c.centerLineType === ortho && centerLineKind(c) === 'struct').map(c => c.value);
  return v.length ? [Math.min(...v), Math.max(...v)] : null;
}

// (a)
const a = { structBeam: [], centerAuxBeam: [] };
for (const [i, plane] of project.planes.entries()) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  const structure = header[i].effectiveStructure;
  for (const g of coordGroups(graph)) {
    const kinds = new Set(g.cls.map(centerLineKind));
    const beams = g.cls.filter(c => centerLineKind(c) === 'beam');
    if (!beams.length) continue;
    const range = perpRange(graph, g.type);
    const covers = range && beams.some(b => (b.extentLo ?? -Infinity) <= range[0] + TOL && (b.extentHi ?? Infinity) >= range[1] - TOL);
    const rec = {
      plane: plane.name, structure, type: g.type, coord: g.coord, kinds: [...kinds].sort(), beams: beams.length,
      beamsCoverAll: !!covers, beamOrigins: beams.map(b => b.beamAxisOrigin ?? null).sort(),
    };
    if (kinds.has('struct')) a.structBeam.push(rec);
    if (kinds.has('center') || kinds.has('aux')) a.centerAuxBeam.push(rec);
  }
}

// (c)
const c = header.map((h, i) => {
  const graph = project.graphMap.get(project.planes[i].id);
  const slab = graph.centerLines.filter(cl => centerLineKind(cl) === 'beam' && cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM).length;
  return { plane: h.plane, structure: h.effectiveStructure, slabBeamCount: slab };
});

// (b)
const hasNew = typeof wba.findOpeningBeamAnchorCL === 'function';
function collectB(phase) {
  if (!hasNew) return { skipped: 'findOpeningBeamAnchorCL なし', total: 0, mismatch: 0, records: [] };
  const records = [];
  let total = 0;
  const byStructure = {};
  for (const plane of project.planes) {
    const graph = project.graphMap.get(plane.id);
    if (!graph) continue;
    const structure = effStructure(graph);
    if (rulesFor(structure).openingBeamAxes !== 'slabOpenings') continue;
    const below = structuralPlaneBelow(plane, project);
    const belowGraph = below ? project.graphMap.get(below.id) : null;
    const srcs = openingBeamSourcesFor(graph, project, { riserOf: (s) => stairRiserOf(s, project, plane), belowGraph });
    for (const s of srcs) {
      const type = s.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
      const oldCL = wba.findBeamAnchorCL(graph, type, s.coord);
      const newCL = wba.findOpeningBeamAnchorCL(graph, type, s.coord, { lo: s.lo, hi: s.hi });
      total++;
      byStructure[structure] = (byStructure[structure] ?? 0) + 1;
      const describe = (cl) => (cl ? { kind: centerLineKind(cl), origin: cl.beamAxisOrigin ?? null, lo: cl.extentLo ?? null, hi: cl.extentHi ?? null } : null);
      if ((oldCL?.id ?? null) !== (newCL?.id ?? null)) {
        records.push({ phase, plane: plane.name, structure, isVertical: s.isVertical, coord: Math.round(s.coord), lo: Math.round(s.lo), hi: Math.round(s.hi), old: describe(oldCL), new: describe(newCL) });
      }
    }
  }
  return { total, byStructure, mismatch: records.length, records };
}
import { effectiveStructure } from '../../src/structural/structureRules.js';
function effStructure(graph) { return effectiveStructure(graph, project); }

const bLoaded = collectB('loaded');
await sweepUntilConverged(project, 'desc');
const bConverged = collectB('converged');
// 収束後の SLAB_BEAM 本数も参考に（loaded 時点は (c) 本体）
const cConverged = project.planes.map((p) => {
  const graph = project.graphMap.get(p.id);
  return { plane: p.name, structure: effStructure(graph), slabBeamCount: graph.centerLines.filter(cl => centerLineKind(cl) === 'beam' && cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM).length };
});

writeOut(process.argv[3] ?? null, {
  header,
  a: { structBeamCount: a.structBeam.length, centerAuxBeamCount: a.centerAuxBeam.length, ...a },
  b: { loaded: bLoaded, converged: bConverged },
  c: { loaded: c, converged: cConverged },
});
