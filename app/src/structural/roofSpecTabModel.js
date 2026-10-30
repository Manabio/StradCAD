// 構造パネルの外部タブ（structural/RoofSpecTab.jsx）に出す屋根の群の判断。react／store.js／.jsx を静的に import しない
// 純モジュール（node:test から直接 import できる。finish/exteriorGroups.js と同じ方針）。
// 仕上げモードの外部タブ（FinishTable.jsx GroupedExteriorTable）のうち屋根の群（主屋根＝type:'mainRoof'・下屋＝type:'roof'）
// だけを出す——屋外部屋の群・手入力の部位群は削除・改名が仕上げモードの機構（deleteRoom・applyNaming）に依存するため出さない。
// 群の並びは exteriorGroups.js buildExteriorGroups を唯一の供給源にし、ここでは種別で絞るだけ。
import { isTopFloorPlane } from '@core';
import { buildExteriorGroups } from '../finish/exteriorGroups.js';

const ROOF_GROUP_TYPES = new Set(['mainRoof', 'roof']);

/**
 * 外部タブが編集対象にする graph と、出す群の並び。
 *  - 実体階（自階）: 自階の下屋の群＋（最上階とその検討案なら）主屋根の群。編集対象は自階。
 *  - 屋根専用平面（小屋伏図。graph.plane.isRoofPlane）: 1つ下の実体階＝最上階（belowGraph。composition の 'columnMap'）の
 *    主屋根の群だけ。編集対象は belowGraph（recomputeStructuralComposition は mutate が belowGraph を書くことを前提に
 *    before を採っている）。belowGraph が無い（未解決）・最上階でないときは空。
 * @param {{ graph: object|null|undefined, belowGraph: object|null|undefined, project: object|null|undefined }} args
 * @returns {{ target: object|null, groups: Array<{ key: string, type: 'mainRoof'|'roof', roomId: string|null, part: string }> }}
 */
export function roofSpecTabGroups({ graph, belowGraph, project }) {
  if (!graph) return { target: null, groups: [] };
  if (graph.plane?.isRoofPlane) {
    if (!belowGraph || !isTopFloorPlane(project, belowGraph.plane)) return { target: null, groups: [] };
    return { target: belowGraph, groups: groupsOf(belowGraph, project, { leanTo: false }) };
  }
  return { target: graph, groups: groupsOf(graph, project, { leanTo: true }) };
}

function groupsOf(graph, project, { leanTo }) {
  const groups = buildExteriorGroups({
    rows: [], rooms: leanTo ? graph.rooms : [], roomOrder: leanTo ? graph.roomOrder : [],
    includeMainRoof: isTopFloorPlane(project, graph.plane),
  });
  return groups.filter(g => ROOF_GROUP_TYPES.has(g.type)).map(({ key, type, roomId, part }) => ({ key, type, roomId, part }));
}

/** 群が1つも無いときの文言（小屋伏図で最上階が未解決／最上階でも下屋のある階でもない階）。 */
export const ROOF_SPEC_TAB_EMPTY = '屋根はありません（主屋根は最上階、下屋は仕上げモードで屋根セルを指定した階に出ます）';
