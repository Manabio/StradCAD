/**
 * 階設定表を開くときに全採用階から集める事実（階段の要約・下屋のある階）。アクティブ階はライブのグラフ、
 * 他階は peek（IDB 読込み）。peek は I/O なので呼び出し側（App.jsx openFloorSettings）が関門（runBusy）の中で呼ぶ。
 * 読むだけでグラフ・IDB は書かない。
 *
 * floorSwapManager は floorOrderChange.js と同じく静的 import（node:test から import できる）。
 */
import { isRoofFeature } from './core/constants.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { buildStairChains } from './finish/stair/stairChains.js';
import { stairChainTitle } from './finish/stair/stairFloorLabel.js';
import { stairItemsOfGraph, stairRiserKey } from './finish/stair/stairRiserFollow.js';

/** 階に下屋（屋根の部屋。roofSpec を持つ feature='roof' の部屋）があるか。 */
export function graphHasLeanTo(graph) {
  return (graph?.rooms ?? []).some(r => isRoofFeature(r.feature) && !!r.roofSpec);
}

/**
 * @param {object} project
 * @param {object} [io]
 * @param {(plane:object, structGraph:object)=>Promise<object|null>} [io.peekFn] - 差し替え用（テスト注入）。
 *   省略時は本番の floorSwapManager.peek
 * @returns {Promise<{stairItems:Array<{planeId,stairId,label,totalSteps,explicitRiser}>, leanToPlaneIds:string[]}>}
 *   stairItems＝全採用階の階段（label は仕上げの階段タブと同じ「階段N（出発->到達階）」。N は連鎖の番号）。
 *   leanToPlaneIds＝下屋のある採用階の id。
 * @throws 他階の peek が失敗した（例外・null）とき。階段・下屋を確かめられないまま確定させない。
 */
export async function collectFloorSettingsFacts(project, { peekFn } = {}) {
  const planes = project.planes;
  const peek = peekFn ?? ((p, sg) => floorSwapManager.peek(p, sg));
  const floors = await Promise.all(planes.map(async plane => {
    if (plane.id === project.activePlaneId && project.activeGraph) return { plane, graph: project.activeGraph };
    const graph = await peek(plane, project.structGraph);
    if (!graph) throw new Error(`階の読込みに失敗しました: ${plane.id}`);
    return { plane, graph };
  }));

  const labelOf = new Map();
  buildStairChains(floors, project.structGraph).forEach((chain, ci) => {
    for (const m of chain.members) {
      const idx = planes.findIndex(p => p.id === m.planeId);
      labelOf.set(stairRiserKey(m.planeId, m.stairId), stairChainTitle(ci, planes[idx], planes[idx + 1]));
    }
  });
  const stairItems = floors.flatMap(f => stairItemsOfGraph(f.plane.id, f.graph)
    .map(it => ({ ...it, label: labelOf.get(stairRiserKey(it.planeId, it.stairId)) ?? '階段' })));
  const leanToPlaneIds = floors.filter(f => graphHasLeanTo(f.graph)).map(f => f.plane.id);
  return { stairItems, leanToPlaneIds };
}
