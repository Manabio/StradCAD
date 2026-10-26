// S0（S造限定への戻し作業の基準採取）probe 共通部。調査用・製品コードからは参照しない。
// 3版（ee352a1/9aa3213/facded7）のどれでも動くよう、版で増減する export は import しない。
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { effectiveStructure } from '../../src/structural/structureRules.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';

/** 文書を開き、他階の peek を project.graphMap から返す形に差し替える。 */
export function openDoc(src) {
  const { project } = loadDocument(src);
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  return project;
}

/** 階ごとの実効主構造と階別上書きの有無（主構造の思い込みを避けるため全 probe の頭に出す）。 */
export function planeHeader(project) {
  return project.planes.map(p => {
    const graph = project.graphMap.get(p.id);
    return {
      plane: p.name,
      effectiveStructure: graph ? effectiveStructure(graph, project) : null,
      structureOverride: graph ? (graph.structureOverride ?? null) : null,
    };
  });
}

export function writeOut(outPath, obj) {
  const text = JSON.stringify(obj, null, 1);
  if (outPath) fs.writeFileSync(outPath, text);
  else console.log(text);
}

export const typeName = (cl) => (cl.centerLineType === CenterLineType.VERTICAL ? 'vertical'
  : cl.centerLineType === CenterLineType.HORIZONTAL ? 'horizontal' : null);

/** 階の V/H の CL を (type, round(value)) でまとめる。 */
export function coordGroups(graph) {
  const m = new Map();
  for (const cl of graph.centerLines) {
    const type = typeName(cl);
    if (!type) continue;
    const key = `${type}:${Math.round(cl.value)}`;
    if (!m.has(key)) m.set(key, { type, coord: Math.round(cl.value), value: cl.value, cls: [] });
    m.get(key).cls.push(cl);
  }
  return [...m.values()];
}

/** 直交方向の追加位置: 直交する通り芯の隣り合う中点ごと＋両外側＋0。 */
export function perpPositions(graph, type) {
  const orthoType = type === 'vertical' ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const vals = [...new Set(graph.centerLines
    .filter(cl => cl.centerLineType === orthoType && centerLineKind(cl) === 'struct')
    .map(cl => Math.round(cl.value)))].sort((a, b) => a - b);
  const out = new Set([0]);
  for (let i = 0; i + 1 < vals.length; i++) out.add(Math.round((vals[i] + vals[i + 1]) / 2));
  if (vals.length) { out.add(vals[0] - 500); out.add(vals[vals.length - 1] + 500); }
  return [...out].sort((a, b) => a - b);
}
