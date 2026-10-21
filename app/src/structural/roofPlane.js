import { HDimensionLine, VDimensionLine, DimensionKind, DimensionSide } from '../core.js';

// 屋根専用平面（小屋伏／R階伏）の同期。構造モード突入時に呼ぶ。
// 屋根平面は常にその時点の最上階に付く。最上階が入れ替わっても作り直さず followRoofPlaneToTop が
// 付け替える（id と中身を保つ）。無いときだけ新しい最上階の上に作る（store.js の addFloor と同じ寸法線セットを追加する）。

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
 * 屋根平面を「今の最上階（project.planes の末尾）」に付ける唯一の規則。紐づけ（roofForPlaneId）が
 * 違えば付け替え、続けて高さ・階番号・階数を合わせる。屋根平面は作り直さない（id と中身を保つ）。
 * 最上階が入れ替わる全経路（最上階の上への追加・並替・階変更・最上階の削除・検討案の採用、
 * それぞれの undo／redo と失敗時の巻き戻し）がこの関数を通る。付け替え先は階の並びだけで決まるので、
 * 状態を戻した後の最後にこれを呼べば紐づけは記録なしで戻る（作り直すと屋根平面が undo 記録の外に
 * あるため旧屋根平面が戻らない——付け替えなら id が変わらないので両立する）。
 * 最上階が無い／屋根平面が無いときは何もせず false を返す（新設は syncRoofPlane の責任）。
 * @returns {boolean} 紐づけ・高さ・階番号・階数のどれか1つでも書き換えたらtrue
 */
export function followRoofPlaneToTop(project) {
  const real = project.planes;
  const top = real[real.length - 1];
  if (!top) return false;

  const existing = project.roofPlane;
  if (!existing) return false;

  let changed = false;
  if (existing.roofForPlaneId !== top.id) { existing.roofForPlaneId = top.id; changed = true; }
  if (existing.elevation !== top.elevation + 1) { existing.elevation = top.elevation + 1; changed = true; }
  if (existing.startFloor !== top.startFloor) { existing.startFloor = top.startFloor; changed = true; }
  if (existing.stories !== top.stories) { existing.stories = top.stories; changed = true; }
  return changed;
}

/**
 * 最上階の実体平面の直上に屋根専用平面を同期する。屋根平面があれば（紐づけが古くても）作り直さず
 * followRoofPlaneToTop で付け替えて既存を返し、無いときだけ新しく作って返す。
 */
export function syncRoofPlane(project) {
  const real = project.planes;
  const top = real[real.length - 1];
  if (!top) return null;

  const existing = project.roofPlane;
  if (existing) {
    followRoofPlaneToTop(project);
    return existing;
  }

  const { plane, graph } = project.addPlane(
    top.elevation + 1, '', crypto.randomUUID(), top.startFloor, top.stories,
    false, null, 0, /* isRoofPlane */ true, /* roofForPlaneId */ top.id,
  );
  addRoofDimensionLines(graph);
  return plane;
}
