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

import { RoomKind } from '@core';
import { MATERIAL_CATEGORY } from './materials/materialData.js';
import { BOUNDARY_MASTERS, BOUNDARY_MASTER_KIND, LAYER_SOURCE } from './materials/boundaryMasters.js';
import { edgeGeometry } from './edgeClassify.js';

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

// ----------------------------------------------------------------
// 詳細断面（LOD 詳細描画用）
// ----------------------------------------------------------------

const isExteriorish = (room) => !room || room.kind === RoomKind.EXTERIOR;

/** レイヤーの材コードを解決（edge override → src → 固定 code）。 */
function resolveLayerCode(layer, graph, sideRoom, edge) {
  const ov = (edge && typeof edge !== 'string') ? edge.overrides?.get?.(layer.role) : null;
  if (ov) return ov;
  if (layer.src === LAYER_SOURCE.FLOOR_EXTERIOR_BACKING) return graph.exteriorWallBacking;
  if (layer.src === LAYER_SOURCE.FLOOR_INTERIOR_PANEL)   return graph.interiorWallPanel;
  if (layer.src === LAYER_SOURCE.FLOOR_INTERIOR_BACKING) return graph.interiorWallBacking;
  if (layer.src === LAYER_SOURCE.ROOM_FINISH) {
    const info = sideRoom?.getFinishInfo?.() ?? {};
    return info.wallFinish ?? null;
  }
  return layer.code ?? null;
}

/**
 * エッジの masterType（層構成）を世界座標の帯（バンド）配列に解決する。
 * 規約: CL は下地（'下地' を含む役割）の中心。外側（master index 小）の層は
 * 屋外側（無名/有名屋外）へ、内側はその逆へ積む。
 * @returns {{ x,y,width,height, role, code, category }[] | null} 非 LAYERED / 未解決は null
 */
export function resolveEdgeSection(edge, graph, materialMap, cellToRoom) {
  if (!materialMap) return null;
  const masterType = (edge && typeof edge !== 'string') ? edge.masterType : null;
  const master = masterType ? BOUNDARY_MASTERS[masterType] : null;
  if (!master || master.kind !== BOUNDARY_MASTER_KIND.LAYERED) return null;

  const geo = edgeGeometry(edge, graph, cellToRoom);
  if (!geo) return null;
  const { isVertical, axisVal, lo, hi, roomNeg, roomPos } = geo;

  const layers = master.layers;
  let backingIdx = layers.findIndex(l => l.role && l.role.includes('下地'));
  if (backingIdx < 0) backingIdx = Math.floor(layers.length / 2);

  // 外側（index < backing）が向かう世界方向の符号
  let extSign = -1;
  if (isExteriorish(roomPos) && !isExteriorish(roomNeg)) extSign = +1;

  const extRoom = extSign < 0 ? roomNeg : roomPos;
  const intRoom = extSign < 0 ? roomPos : roomNeg;
  const sideRoom = (i) => (i === backingIdx ? null : (i < backingIdx ? extRoom : intRoom));

  const codes = layers.map((l, i) => resolveLayerCode(l, graph, sideRoom(i), edge));
  const thick = codes.map(code => materialThickness(code ? materialMap.get(code) : null));
  const back  = thick[backingIdx];

  const bands = [];
  const pushBand = (offLo, offHi, i) => {
    const a = axisVal + offLo, b = axisVal + offHi;
    const near = Math.min(a, b), far = Math.max(a, b);
    if (far - near <= 0) return; // 厚0はスキップ
    const rect = isVertical
      ? { x: near, y: lo, width: far - near, height: hi - lo }
      : { x: lo, y: near, width: hi - lo, height: far - near };
    bands.push({
      ...rect,
      role:     layers[i].role,
      code:     codes[i],
      category: codes[i] ? (materialMap.get(codes[i])?.category ?? null) : null,
    });
  };

  pushBand(-back / 2, +back / 2, backingIdx);                 // 下地（中心）
  let cum = back / 2;                                          // 外側へ
  for (let i = backingIdx - 1; i >= 0; i--) {
    pushBand(extSign * cum, extSign * (cum + thick[i]), i);
    cum += thick[i];
  }
  cum = back / 2;                                              // 内側へ
  for (let i = backingIdx + 1; i < layers.length; i++) {
    pushBand(-extSign * cum, -extSign * (cum + thick[i]), i);
    cum += thick[i];
  }
  return bands;
}
