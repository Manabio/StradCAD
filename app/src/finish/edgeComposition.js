// ================================================================
// 境界エッジの層構成 → 寸法解決（仕上げモードで動的ロード）
//
// 「Wall の総厚は Σ層厚で導出」を担う層。現状の単線 Wall は
// 軸CLから室内側仕上げ面までの offset 1値で位置を持つ（offset = wallBase/2 + wallFinish）。
// この offset を、決め打ち 57.5mm ではなく per-floor 設定（下地）＋部屋の内装マスター
// （壁材・壁仕上げ）の実材厚から構成する。
//
// 規約（要レビュー）:
//   - CL は下地（構造材）の中心にあるとみなす → wallBase/2。
//   - 面材・仕上げ材は材の thickness（スカラ）を用いる。
//   - 下地（backing）は断面 x,y のうち大きい方を「壁を横断する深さ」とする
//     （□-90×45 間柱 → 90）。通気胴縁など薄物では過大評価となるため、
//     部材ごとの設置向きメタデータ導入時に精緻化する余地がある。
//   既定（外壁下地=□-90×45, 壁材=せっこうボード12.5, 室側仕上げ=クロス0）では
//   offset = 90/2 + 12.5 + 0 = 57.5mm となり、従来ジオメトリを再現する。
// ================================================================

import { MATERIAL_CATEGORY } from './materials/materialData.js';
import { DEFAULT_WALL_MATERIAL } from '@core';

/** 材の「壁を横断する方向」の厚(mm)。面材/仕上げは厚、下地は断面の大きい寸法。
 *  ただしRC壁下地（x:0,y:0,thickness:150/180/200）は部材断面ではなく壁厚そのものを
 *  thicknessで表しているため、thicknessが入っていればそちらを優先する
 *  （既存の木・鋼下地54件は全てthickness:nullのため従来どおりx/yの大きい方が使われ、挙動不変）。 */
export function materialThickness(mat) {
  if (!mat) return 0;
  if (mat.category === MATERIAL_CATEGORY.BACKING) return mat.thickness ?? Math.max(mat.x ?? 0, mat.y ?? 0);
  return mat.thickness ?? 0;
}

/**
 * 部屋の内装マスター＋指定の下地材コードから wallBase/wallFinish を導出する共通ヘルパー。
 * roomWallDims（外壁下地）・interiorWallDims（内壁下地）は下地材コードの解決規約だけが違う
 * 薄いラッパ（挙動不変）。
 * @returns {{ wallBase:number, wallFinish:number } | null} 解決不可なら null
 */
function wallDimsWith(graph, room, materialMap, backingCode) {
  if (!materialMap) return null;
  const backing = materialMap.get(backingCode);
  const finishInfo = room?.getFinishInfo?.() ?? {};
  const panel   = materialMap.get(finishInfo.wallMaterial ?? DEFAULT_WALL_MATERIAL);
  if (!backing || !panel) return null;

  const finishMat = finishInfo.wallFinish ? materialMap.get(finishInfo.wallFinish) : null;

  return {
    wallBase:   materialThickness(backing),
    wallFinish: materialThickness(panel) + materialThickness(finishMat),
  };
}

/**
 * 部屋の外周壁の寸法を per-floor 設定＋部屋の内装マスターから導出する。
 *   wallBase   = 外壁下地（exteriorWallBacking）の断面深さ
 *   wallFinish = 部屋の壁材（wallMaterial）厚 ＋ 室側仕上げ（部屋の wallFinish）厚
 * generateRoomWallsFromOutline はこれを offset = wallBase/2 + wallFinish に使う。
 * @returns {{ wallBase:number, wallFinish:number } | null} 解決不可なら null（既定値へフォールバック）
 */
export function roomWallDims(graph, room, materialMap) {
  return wallDimsWith(graph, room, materialMap, graph.exteriorWallBacking);
}

/**
 * 内壁の寸法。下地は interiorWallBacking（backingCode 指定時はそちら）、仕上げは部屋の内装マスター。
 * CL偏芯（finish/clEccentricity.js）の「仕上げ面合わせ」計算で使う。
 * @returns {{ wallBase:number, wallFinish:number } | null} 解決不可なら null
 */
export function interiorWallDims(graph, room, materialMap, backingCode = '') {
  return wallDimsWith(graph, room, materialMap, backingCode || graph.interiorWallBacking);
}

/** 外壁ループの寸法（特定部屋に紐づかないため、壁材は既定・室側仕上げは含めない）。 */
export function exteriorWallDims(graph, materialMap) {
  if (!materialMap) return null;
  const backing = materialMap.get(graph.exteriorWallBacking);
  const panel   = materialMap.get(DEFAULT_WALL_MATERIAL);
  if (!backing || !panel) return null;

  return {
    wallBase:   materialThickness(backing),
    wallFinish: materialThickness(panel),
  };
}
