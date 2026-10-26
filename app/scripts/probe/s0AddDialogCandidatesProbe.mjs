// S0: 構造モードの長押しメニュー（App.jsx handleMenuSelect の cl-v/cl-h）が追加ダイアログの参照候補にする
// CL の種別を、全階・全 CL の座標で出す。
// App.jsx は import できないため、絞り込み式を probe 側で再現する:
//   式A（9aa3213 以前）: findNearbyCenterLines(...).filter(cl => isRenderTarget(cl, 'structure'))
//   式B（facded7）     : 式A || isAddDialogSnapOnlyRef(cl, 'structure')   ※ export が無い版では null
// findNearbyCenterLines は通り芯（spansEntireAxis）を先に除く。位置は「そのCLの座標ちょうど」（距離<1mm・
// 倍率1・しきい値1）で、沿線位置は直交する通り芯の中点ごと＋0（はね出し除外が沿線位置で効くため）。
// 出力: {header, snapOnlyAvailable, records:[{plane,structure,type,coord,kindsAt,A,B,added}], summary}
//   A/B は全沿線位置の和集合（種別の昇順配列）、added=B−A（式Bで新たに候補へ入る種別）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/s0AddDialogCandidatesProbe.mjs <入力.stq> [出力.json]
import { openDoc, planeHeader, writeOut, coordGroups, perpPositions } from './s0Common.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { findNearbyCenterLines } from '../../src/snapGeometry.js';
import * as policy from '../../src/core/centerLineKindPolicy.js';

const MODE = 'structure';
const snapOnly = typeof policy.isAddDialogSnapOnlyRef === 'function' ? policy.isAddDialogSnapOnlyRef : null;

const project = openDoc(process.argv[2]);
const header = planeHeader(project);
const records = [];
const summary = {};

for (const [i, plane] of project.planes.entries()) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  const structure = header[i].effectiveStructure;
  for (const g of coordGroups(graph)) {
    const clType = g.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const A = new Set(), B = new Set();
    for (const perp of perpPositions(graph, g.type)) {
      const x = g.type === 'vertical' ? g.value : perp;
      const y = g.type === 'vertical' ? perp : g.value;
      const nearby = findNearbyCenterLines(graph, x, y, 1, 1, 1, clType);
      for (const cl of nearby.filter(c => policy.isRenderTarget(c, MODE))) A.add(centerLineKind(cl));
      if (snapOnly) {
        for (const cl of nearby.filter(c => policy.isRenderTarget(c, MODE) || snapOnly(c, MODE))) B.add(centerLineKind(cl));
      }
    }
    const a = [...A].sort();
    const b = snapOnly ? [...B].sort() : null;
    const added = b ? b.filter(k => !A.has(k)) : null;
    records.push({
      plane: plane.name, structure, type: g.type, coord: g.coord,
      kindsAt: [...new Set(g.cls.map(centerLineKind))].sort(), A: a, B: b, added,
    });
    if (added && added.length) {
      const key = `${structure}:+${added.join(',')}`;
      summary[key] = (summary[key] ?? 0) + 1;
    }
  }
}
writeOut(process.argv[3] ?? null, { header, snapOnlyAvailable: !!snapOnly, summary, records });
