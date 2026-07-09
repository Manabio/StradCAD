// ================================================================
// 境界エッジの層構成 → 寸法解決（仕上げモードで動的ロード）
//
// 「Wall の総厚は Σ層厚で導出」を担う層。現状の単線 Wall は
// 軸CLから室内側仕上げ面までの offset 1値で位置を持つ（offset = wallBase/2 + wallFinish）。
// この offset を、決め打ち 57.5mm ではなく per-floor 設定＋部屋の内装マスターの
// 実材厚から構成する。
//
// 規約（要レビュー）:
//   - CL は下地（構造材）の中心にあるとみなす → wallBase/2。
//   - 面材・仕上げ材は材の thickness（スカラ）を用いる。
//   - 下地（backing）は断面 x,y のうち大きい方を「壁を横断する深さ」とする
//     （□-90×45 間柱 → 90）。通気胴縁など薄物では過大評価となるため、
//     部材ごとの設置向きメタデータ導入時に精緻化する余地がある。
//   既定（外壁下地=□-90×45, 内壁面材=せっこうボード12.5, 室側仕上げ=クロス0）では
//   offset = 90/2 + 12.5 + 0 = 57.5mm となり、従来ジオメトリを再現する。
// ================================================================

import { MATERIAL_CATEGORY } from './materials/materialData.js';

/** 材の「壁を横断する方向」の厚(mm)。面材/仕上げは厚、下地は断面の大きい寸法。 */
export function materialThickness(mat) {
  if (!mat) return 0;
  if (mat.category === MATERIAL_CATEGORY.BACKING) return Math.max(mat.x ?? 0, mat.y ?? 0);
  return mat.thickness ?? 0;
}

/**
 * 部屋の外周壁の寸法を per-floor 設定＋部屋の内装マスターから導出する。
 *   wallBase   = 外壁下地（exteriorWallBacking）の断面深さ
 *   wallFinish = 内壁面材（interiorWallPanel）厚 ＋ 室側仕上げ（部屋の wallFinish）厚
 * generateRoomWallsFromOutline はこれを offset = wallBase/2 + wallFinish に使う。
 * @returns {{ wallBase:number, wallFinish:number } | null} 解決不可なら null（既定値へフォールバック）
 */
export function roomWallDims(graph, room, materialMap) {
  if (!materialMap) return null;
  const backing = materialMap.get(graph.exteriorWallBacking);
  const panel   = materialMap.get(graph.interiorWallPanel);
  if (!backing || !panel) return null;

  const finishInfo = room?.getFinishInfo?.() ?? {};
  const finishMat  = finishInfo.wallFinish ? materialMap.get(finishInfo.wallFinish) : null;

  return {
    wallBase:   materialThickness(backing),
    wallFinish: materialThickness(panel) + materialThickness(finishMat),
  };
}

/** 外壁ループの寸法（室側仕上げは特定部屋に紐づかないため面材厚のみ）。 */
export function exteriorWallDims(graph, materialMap) {
  if (!materialMap) return null;
  const backing = materialMap.get(graph.exteriorWallBacking);
  const panel   = materialMap.get(graph.interiorWallPanel);
  if (!backing || !panel) return null;

  return {
    wallBase:   materialThickness(backing),
    wallFinish: materialThickness(panel),
  };
}
