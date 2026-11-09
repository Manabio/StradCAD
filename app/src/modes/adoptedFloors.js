import { floorSwapManager } from '../storage/FloorSwapManager.js';

/**
 * 採用階を昇順に集める（自階は live、他階は peek を並行）。peek の失敗は階ごとに握って graph null にする。
 * 自階が検討案（planes に無い）なら、同じ高さの採用階は peek で読む（立面・敷地の配置図は採用階の建物を描く）。
 * 立面モード（FacadeModeState）・敷地の配置図（SiteModeState）が共有する。graph は変更しない。
 * @param {object} project
 * @param {string} logTag 警告の接頭辞（例: '[facade]'）
 * @returns {Promise<{floors: Array<{plane:object, graph:object|null}>, readFailed:boolean}>}
 */
export async function collectAdoptedFloors(project, logTag) {
  const planes = project?.planes ?? [];
  let readFailed = false;
  const floors = await Promise.all(planes.map(async plane => {
    if (plane.id === project.activePlaneId) return { plane, graph: project.activeGraph ?? null };
    try {
      return { plane, graph: (await floorSwapManager.peek(plane, project.structGraph)) ?? null };
    } catch (err) {
      console.warn(`${logTag} 階「${plane.name ?? plane.id}」の読み込みに失敗（その階は描かない）:`, err);
      readFailed = true;
      return { plane, graph: null };
    }
  }));
  return { floors, readFailed };
}
