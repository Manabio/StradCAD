import { HDimensionLine, VDimensionLine, DimensionKind, DimensionSide } from '../core.js';

// 屋根専用平面（小屋伏／R階伏）の同期。構造モード突入時に呼ぶ。
// 最上階の実体平面が変わった場合は古い屋根平面を削除し、新しい最上階の上に作り直す
// （屋根データは建物形状が変わった時点でやり直し前提。store.js の addFloor と同じ寸法線セットを追加する）。

function addRoofDimensionLines(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT });
}

/**
 * 最上階の実体平面のidが同じまま、途中挿入・並替・階変更で高さ・階番号・階数だけ動いたとき、
 * 既存の屋根平面をそれに追従させる（作り直さない＝idを保つ）。最上階が無い／屋根平面が無い／
 * 屋根平面が今の最上階を指していない（idが違う＝最上階そのものが入れ替わった）ときは何もせず
 * falseを返す——その場合の作り直しは呼び出し元の責任にしない。作り直しは次の構造モード突入の
 * syncRoofPlaneに任せる（QA指摘・2026-10-01再裁定）。理由: 階操作（追加・削除・並替）の時点で
 * 屋根平面を削除→作り直すと、屋根平面はPlaneメタのundo記録（collectPlaneMetas）・バイト列の
 * undo記録（collectFloorBytes）のいずれも対象外（project.planesのみを見る）のため、undoで旧
 * 屋根平面が戻らず、新しい屋根平面が削除済みの階を指したまま残ってしまう。
 * @returns {boolean} 書き換えたらtrue
 */
export function followRoofPlaneToTop(project) {
  const real = project.planes;
  const top = real[real.length - 1];
  if (!top) return false;

  const existing = project.roofPlane;
  if (!existing || existing.roofForPlaneId !== top.id) return false;

  if (existing.elevation === top.elevation + 1
    && existing.startFloor === top.startFloor
    && existing.stories === top.stories) return false;

  existing.elevation = top.elevation + 1;
  existing.startFloor = top.startFloor;
  existing.stories = top.stories;
  return true;
}

/** 最上階の実体平面の直上に屋根専用平面を同期する。変更があれば新しい屋根平面を、なければ既存のものを返す。 */
export function syncRoofPlane(project) {
  const real = project.planes;
  const top = real[real.length - 1];
  if (!top) return null;

  const existing = project.roofPlane;
  if (existing && existing.roofForPlaneId === top.id) {
    followRoofPlaneToTop(project);
    return existing;
  }

  if (existing) project.removePlane(existing.id);

  const { plane, graph } = project.addPlane(
    top.elevation + 1, '', crypto.randomUUID(), top.startFloor, top.stories,
    false, null, 0, /* isRoofPlane */ true, /* roofForPlaneId */ top.id,
  );
  addRoofDimensionLines(graph);
  return plane;
}
