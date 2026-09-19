// 全階スイープをする wood probe が共有する「反映パスと同じ並び」のヘルパ（小屋伏図にも梁・柱ルールを
// 適用する計画のステップ7・コーディネーター指示「probeを本番と同じ順序・屋根込みに統一」）。
// 本番の反映パス（structuralOrchestration.js reflectStructuralToOtherFloors）は降順（小屋伏図→
// 最上階→…→最下階）——ユーザー定義「最上階から順＝起点は小屋伏図」の並びをここでも単一実装にする。
// 既存挙動は変更しない（読み取り専用の診断ツール）。
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { structuralPlaneBelow } from '../../src/structural/drawingDesignation.js';

/** 屋根専用平面の mainStructure は「1つ下の実体階（＝最上階）」の実効主構造（drawingDesignation.js
 *  structuralPlaneBelow）——屋根自身の実効値ではない。reflectRoofPlane（structuralOrchestration.js）
 *  と同じ規約。屋根が無ければnull。 */
/** plane表示名（診断ログ用）。屋根専用平面はplane.nameが空文字のことがある実データがあるため
 *  '屋根'へフォールバックする（sweepUntilConverged の changedPlanes ラベル・呼び出し側probeの
 *  レポート表示が共有する単一実装）。 */
export function planeLabel(plane) {
  return plane.isRoofPlane ? (plane.name || '屋根') : plane.name;
}

export function roofMainStructure(project) {
  const roofPlane = project.roofPlane;
  if (!roofPlane) return null;
  const topPlane = structuralPlaneBelow(roofPlane, project);
  const topGraph = topPlane ? project.graphMap.get(topPlane.id) : null;
  return topGraph ? (topGraph.structureOverride ?? project.structuralInfo.mainStructure) : project.structuralInfo.mainStructure;
}

/**
 * 本番の反映パス（reflectStructuralToOtherFloors。降順＝小屋伏図→最上階→…→最下階）と同じ並びで
 * 対象planeを列挙する。屋根が無い・非在来（roofBeamPlacementが'gridEaves'）の建物は屋根を含めない
 * （反映パス側のreflectRoofPlaneが非在来では自階再計算をしないのと同じ理由）。
 * @param {object} project
 * @returns {Array<object>} plane配列（降順・条件を満たせば屋根が先頭）
 */
export function productionSweepPlanes(project) {
  const roofPlane = project.roofPlane;
  const includeRoof = !!roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure);
  const descPlanes = [...project.planes].reverse();
  return includeRoof ? [roofPlane, ...descPlanes] : descPlanes;
}

/**
 * 全階（＋屋根、在来のときだけ）を指定順（'desc'=本番と同じ降順・屋根先頭 / 'asc'=昇順・屋根末尾。
 * 'asc'はwoodSupportSpanProbe.mjsの順序不変チェック専用の比較走行で、convergeLimitの上限判定対象では
 * ない）でmaxSweepsまで再計算し、収束したsweep数（changed=[]になった回）を返す。収束しなければnull。
 * document を独立に読み直してから回すこと（呼び出し側の責務）。
 * @param {object} project
 * @param {'asc'|'desc'} order
 * @param {number} [maxSweeps]
 * @param {(sweepIndex: number, changedPlaneNames: string[]) => void} [onSweep] - 各sweep終了時に
 *   呼ぶ診断用コールバック（省略可。既存probeの「sweep${i}: changed=[...]」ログ互換のため）。
 * @returns {Promise<number|null>}
 */
export async function sweepUntilConverged(project, order, maxSweeps = 8, onSweep = null) {
  const roofPlane = project.roofPlane;
  const includeRoof = !!roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure);
  const realPlanes = order === 'desc' ? [...project.planes].reverse() : project.planes;
  const planes = includeRoof
    ? (order === 'desc' ? [roofPlane, ...realPlanes] : [...realPlanes, roofPlane])
    : realPlanes;
  for (let i = 1; i <= maxSweeps; i++) {
    const changedPlanes = [];
    for (const p of planes) {
      const g = project.graphMap.get(p.id);
      const mainStructure = p.isRoofPlane ? roofMainStructure(project) : (g.structureOverride ?? project.structuralInfo.mainStructure);
      const { changed } = await recomputeStructuralForGraph(g, project, mainStructure);
      if (changed) changedPlanes.push(planeLabel(p));
    }
    onSweep?.(i, changedPlanes);
    if (changedPlanes.length === 0) return i;
  }
  return null;
}
