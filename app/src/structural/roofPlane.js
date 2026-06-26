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

/** 最上階の実体平面の直上に屋根専用平面を同期する。変更があれば新しい屋根平面を、なければ既存のものを返す。 */
export function syncRoofPlane(project) {
  const real = project.planes;
  const top = real[real.length - 1];
  if (!top) return null;

  const existing = project.roofPlane;
  if (existing && existing.roofForPlaneId === top.id) return existing;

  if (existing) project.removePlane(existing.id);

  const { plane, graph } = project.addPlane(
    top.elevation + 1, '', crypto.randomUUID(), top.startFloor, top.stories,
    false, null, 0, /* isRoofPlane */ true, /* roofForPlaneId */ top.id,
  );
  addRoofDimensionLines(graph);
  return plane;
}
