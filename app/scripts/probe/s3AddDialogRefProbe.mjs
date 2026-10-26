// S3（S造限定）: 構造モードの追加ダイアログの参照候補を、今回の式 isAddDialogRefCandidate で出す。
// s0AddDialogCandidatesProbe.mjs と同じ候補列（findNearbyCenterLines の結果）に、App.jsx と同じ式
//   isAddDialogRefCandidate(cl, 'structure', rulesFor(effectiveStructure(graph, project)))
// を当てる。出力: {records:[{plane,structure,type,coord,C}]}（C は全沿線位置の和集合・種別の昇順配列）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/s3AddDialogRefProbe.mjs <入力.stq> [出力.json]
import { openDoc, planeHeader, writeOut, coordGroups, perpPositions } from './s0Common.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { findNearbyCenterLines } from '../../src/snapGeometry.js';
import { isAddDialogRefCandidate } from '../../src/ui/addCLDialogRefs.js';
import { rulesFor, effectiveStructure } from '../../src/structural/structureRules.js';

const MODE = 'structure';
const project = openDoc(process.argv[2]);
const header = planeHeader(project);
const records = [];

for (const [i, plane] of project.planes.entries()) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  const rules = rulesFor(effectiveStructure(graph, project));
  for (const g of coordGroups(graph)) {
    const clType = g.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const C = new Set();
    for (const perp of perpPositions(graph, g.type)) {
      const x = g.type === 'vertical' ? g.value : perp;
      const y = g.type === 'vertical' ? perp : g.value;
      const nearby = findNearbyCenterLines(graph, x, y, 1, 1, 1, clType);
      for (const cl of nearby.filter(c => isAddDialogRefCandidate(c, MODE, rules))) C.add(centerLineKind(cl));
    }
    records.push({ plane: plane.name, structure: header[i].effectiveStructure, type: g.type, coord: g.coord, C: [...C].sort() });
  }
}
writeOut(process.argv[3] ?? null, { header, records });
