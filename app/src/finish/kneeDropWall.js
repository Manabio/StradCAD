/**
 * 腰壁・垂れ壁（交点から交点の1区間単位の指定）の解決・検証（仕上げモードで動的ロード）。
 *
 * PlanGraph.kneeDropWalls（key=edgeKey(axisCLId,startCLId,endCLId) → レコード）は「何を
 * 指定したか」だけを保持する。壁側（Wall.axisOffset 等の厚みジオメトリ）へは一切書き込まない
 * ——腰壁・垂れ壁は「天板」の追加描画（ShapesLayer.jsx）と、平面切断高さ以下の腰壁のみ
 * 通常の壁帯描画を天板輪郭に差し替える表示上の分岐であり、壁自体の材構成は変えない。
 *
 * 天板: 厚CAP_THICKNESS・壁仕上げ面から外側へCAP_OVERHANGだけ出た板。
 * 腰壁＝床から天板上端までの寸法（topHeight）。垂れ壁＝天井から天板下端までの寸法（bottomHeight）。
 */

import { edgeKey, DEFAULT_ROOM_CEILING_HEIGHT } from '@core';
import { worldToCell } from './gridCells.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { cellsBeyondBreak } from './stair/stairGeometry.js';
import { stairUnderRoomsOf } from './stair/stairUnderRooms.js';

export const CAP_THICKNESS   = 20;   // mm — 天板厚
export const CAP_OVERHANG    = 10;   // mm — 天板の壁仕上げ面からの出幅
export const PLAN_CUT_HEIGHT = 1500; // mm — 平面切断高さ

// 天井高さが解決できない（区間の両側とも部屋がない）ときのエラーメッセージ。
// validateKneeDropWall と KneeDropWallDialog（フィールド未入力でも先出しする上部固定ブロック）の
// 双方で使う唯一の情報源。
export const ERR_CEILING_HEIGHT_UNRESOLVED = '天井高さを解決できません（両側とも部屋がありません）';

const MIN_HEIGHT  = 20; // mm — 腰H・垂れHの下限（天井高さ上限側のマージンも同値）
const BOTH_MARGIN = 20; // mm — 両方指定時の上限式 (腰H+垂れH <= 天井高さ - 2*BOTH_MARGIN) に使う

// 壁スパンと区間の重なりを「有意」とみなす下限(mm)。stairUnderWalls.js の SKIP_OVERLAP_EPS・
// clEccentricity.js の SPAN_OVERLAP_EPS と同水準。
const SPAN_OVERLAP_EPS = 5; // mm

// 押下位置から部屋側セルを解決する際のオフセット(mm)。edgeClassify.js の ADJACENT_SAMPLE_EPS と同水準。
const PRESS_SIDE_EPS = 10; // mm

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（edgeClassify.js と同型）。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * 壁の押下位置（ワールド座標）から、腰壁・垂れ壁の対象区間キー（edgeKey）を解決する。
 * 壁の部屋側（axisOffsetの符号側）へ微小オフセットしてセルを解決し、壁の長さ方向のセル境界
 * CLペアをedgeKeyへ正規化する（computeNamedBoundaryEdges と同じ正規化規則）。
 * @param {import('@core').Wall} wall
 * @param {{x:number,y:number}} worldPos
 * @param {object} graph
 * @returns {string|null} 解決不能（グリッド外・格子未成立）なら null
 */
export function resolveWallSpanKey(wall, worldPos, graph) {
  const axisCL = wall.axisCL;
  const axisV  = axisCL.effectiveValue;
  const along  = wall.isVertical ? worldPos.y : worldPos.x;
  const dir    = Math.sign(wall.axisOffset) || 1;
  const probe  = axisV + dir * PRESS_SIDE_EPS;

  const cell = wall.isVertical
    ? worldToCell(probe, along, graph)
    : worldToCell(along, probe, graph);
  if (!cell) return null;

  const [leftId, topId, rightId, bottomId] = cell.key.split(':');
  const [sId, eId] = wall.isVertical ? [topId, bottomId] : [leftId, rightId];
  const sCL = getShape(graph, sId), eCL = getShape(graph, eId);
  if (!sCL || !eCL) return null;
  const [s2, e2] = sCL.value <= eCL.value ? [sId, eId] : [eId, sId];
  return edgeKey(axisCL.id, s2, e2);
}

/**
 * 区間キーの幾何と、そこに重なる全Wallの実面範囲（materialRange のmin/max合算）を解決する。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom buildCellToRoom(graph) の結果
 * @returns {{axisCL, isVertical:boolean, lo:number, hi:number, faceLo:number, faceHi:number,
 *   walls:import('@core').Wall[], roomNeg, roomPos} | null}
 *   faceLo/faceHi = 区間に重なる壁群の仕上げ全幅（材が存在する範囲の外包絡）。
 *   壁が1本も無ければ null（孤児区間）。
 */
export function kneeDropWallGeometry(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const { axisCL, isVertical, lo, hi, roomNeg, roomPos } = geo;

  let faceLo = Infinity, faceHi = -Infinity;
  const walls = [];
  for (const w of graph.walls) {
    if (w.axisCL.id !== axisCL.id || w.isVertical !== isVertical) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (Math.min(wHi, hi) - Math.max(wLo, lo) <= SPAN_OVERLAP_EPS) continue;
    const mr = w.materialRange;
    faceLo = Math.min(faceLo, mr.lo);
    faceHi = Math.max(faceHi, mr.hi);
    walls.push(w);
  }
  if (walls.length === 0) return null;

  return { axisCL, isVertical, lo, hi, faceLo, faceHi, walls, roomNeg, roomPos };
}

/**
 * 壁が腰壁・垂れ壁指定の対象として適格か（外壁と、2a壁＝階段下部屋の偏芯壁は対象外）。
 * 2a壁は generateStairUnderWalls 固有の偏芯式で生成される別管理の壁で、通常の壁帯描画の
 * 前提（materialRange の単純合算）がそのまま成立しないため対象から除く（.claude/data-model.md
 * 「内周壁は仕上げ脱出境界で全削除・導出再生成する」2a節参照）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @returns {boolean}
 */
export function isEligibleWallSpan(wall, graph) {
  if (wall.isExteriorWall) return false;
  for (const stair of graph.stairs) {
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size === 0) continue;
    for (const room of stairUnderRoomsOf(stair, graph, beyond)) {
      if (room.generatedWallIds.has(wall.id)) return false;
    }
  }
  return true;
}

/**
 * 区間の両側の部屋の天井高さのうち低い方を返す（片側が部屋なしならその側は無視）。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom
 * @returns {number|null} 両側とも部屋なし（区間の幾何が解決できない）なら null
 */
export function effectiveCeilingHeight(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const heights = [];
  for (const room of [geo.roomNeg, geo.roomPos]) {
    if (!room) continue;
    heights.push(room.getFinishInfo().ceilingHeight ?? graph.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT);
  }
  if (heights.length === 0) return null;
  return Math.min(...heights);
}

/**
 * 腰壁高さ・垂れ壁高さの入力値を検証する。
 * @param {number|null} kneeTop 腰壁の上端寸法(mm)。null=腰壁指定なし
 * @param {number|null} dropBottom 垂れ壁の下端寸法(mm)。null=垂れ壁指定なし
 * @param {number|null} ceilingHeight effectiveCeilingHeight の結果
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateKneeDropWall(kneeTop, dropBottom, ceilingHeight) {
  if (kneeTop == null && dropBottom == null) return { valid: true, error: null }; // 両方未指定＝解除
  if (ceilingHeight == null) return { valid: false, error: ERR_CEILING_HEIGHT_UNRESOLVED };

  const max = ceilingHeight - MIN_HEIGHT;
  if (kneeTop != null && !(kneeTop >= MIN_HEIGHT && kneeTop <= max)) {
    return { valid: false, error: `腰壁高さは${MIN_HEIGHT}〜${max}mmで指定してください` };
  }
  if (dropBottom != null && !(dropBottom >= MIN_HEIGHT && dropBottom <= max)) {
    return { valid: false, error: `垂れ壁高さは${MIN_HEIGHT}〜${max}mmで指定してください` };
  }
  if (kneeTop != null && dropBottom != null) {
    const limit = ceilingHeight - 2 * BOTH_MARGIN;
    if (kneeTop + dropBottom > limit) {
      return { valid: false, error: `腰壁高さ＋垂れ壁高さは${limit}mm以下にしてください` };
    }
  }
  return { valid: true, error: null };
}

/**
 * 描画用: 腰壁・垂れ壁が指定された区間に重なる全WallのID → 描画オーバーレイ情報のMapを返す
 * （wallJunctionResolve.js の resolveWallTJunctions と同様、毎レンダー解決）。
 *
 * 優先順位（同一区間に腰壁・垂れ壁が同居する場合）: 腰壁が平面切断高さを貫く
 * （topHeight > PLAN_CUT_HEIGHT）ときは常に通常の壁帯描画を優先し、垂れ壁のオーバーレイも
 * 出さない（要件の明示規則）。腰壁が貫かない（<=PLAN_CUT_HEIGHT）ときは腰壁の天板輪郭が
 * 常に優先される（腰壁天板より低い切断面には他に描くものが無いため）。腰壁指定が無い区間
 * でのみ垂れ壁の判定（切断面が壁本体を貫くか）を行う。
 * @param {object} graph
 * @returns {Map<string, {mode:'knee'|'drop', capLo:number, capHi:number}>}
 */
export function resolveKneeDropOverlays(graph) {
  const result = new Map();
  if (graph.kneeDropWalls.size === 0) return result;
  const cellToRoom = buildCellToRoom(graph);

  for (const [key, rec] of graph.kneeDropWalls) {
    if (!rec.knee && !rec.drop) continue;
    const geo = kneeDropWallGeometry(graph, key, cellToRoom);
    if (!geo) continue;
    const capLo = geo.faceLo - CAP_OVERHANG, capHi = geo.faceHi + CAP_OVERHANG;

    let overlay = null;
    if (rec.knee) {
      if (rec.knee.topHeight <= PLAN_CUT_HEIGHT) overlay = { mode: 'knee', capLo, capHi };
    } else if (rec.drop) {
      const ceilingHeight = effectiveCeilingHeight(graph, key, cellToRoom);
      // 垂れ壁の下端（床からの高さ = ceilingHeight - bottomHeight）が平面切断高さより上にあれば、
      // 切断面は壁本体を貫かない（notCutByPlane）——このときだけ天板輪郭の破線オーバーレイを出す。
      // 下端が切断面以下（=切断面が壁本体を貫く）なら通常の壁帯描画のまま。
      const notCutByPlane = ceilingHeight != null && (ceilingHeight - rec.drop.bottomHeight) > PLAN_CUT_HEIGHT;
      if (notCutByPlane) overlay = { mode: 'drop', capLo, capHi };
    }
    if (!overlay) continue;

    for (const w of geo.walls) {
      if (!result.has(w.id)) result.set(w.id, overlay);
    }
  }
  return result;
}
