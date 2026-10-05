/**
 * 片流れの「高い側」の導出のうち graph を読む部分（葉モジュール。store.js / snap.js / .jsx を静的 import しない）。
 * ステップ C1b。幾何の純関数（resolveRoofHighSide・roofHighSideView）は roofGeometry.js。ここは
 * 「屋根範囲の各辺の外側が同じ階の屋内に接する長さ」と、下屋の表示判断（roofHighSideView への入力の組立）を持つ。
 * 主屋根の表示判断は mainRoof.js mainRoofHighSideView（範囲＝建物範囲・形状＝主構造のルールを引くため）。
 *
 * 「屋内」の定義は建物範囲と同じ（structural/wallGate.js footprintCellKeys）: kind が INTERIOR の部屋のセル
 * （階段・吹抜け・未定義部屋も屋内。ただし階段・階段吹抜けしか無い階は建物範囲が未定義＝空）。
 * 屋根セル（kind が EXTERIOR）・屋外部屋・部屋の無いセルは屋内に数えない。
 */
import { RoofShape } from '../../core/constants.js';
import { footprintCellKeys } from '../../structural/wallGate.js';
import { cellBoundsList } from '../gridCells.js';
import { resolveRoofShape, roofRoomBounds } from './roofDefaults.js';
import { rulesFor, effectiveStructure, UNSPECIFIED_STRUCTURE } from '../../structural/structureRules.js';
import { structureHasMemberKind, MEMBER_KIND } from '../../structural/structuralClassification.js';
import { rectOfBounds, roofHighSideView, roofRidgeDirectionView, roofColumnThroughView } from './roofGeometry.js';

const EPS = 1e-6;

/** 区間 [a1,a2] と [b1,b2] の重なりの長さ（重ならなければ 0）。 */
function overlapLength(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/**
 * 屋根範囲（矩形 rect）の各辺について、その外側が同じ階の屋内に接する長さ (mm) を返す。
 * top＝y が小さい辺（外側は y<rect.y1）、bottom＝y2、left＝x1、right＝x2（y 軸は下向き正）。
 * 辺の一部だけが接する場合はその長さ。複数の屋内セルが接すれば合計する。
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} rect
 * @param {object} graph 屋根のある階の graph
 * @returns {{top:number,bottom:number,left:number,right:number}}
 */
export function roofEdgeInteriorAdjacency(rect, graph) {
  const out = { top: 0, bottom: 0, left: 0, right: 0 };
  if (!rect) return out;
  for (const b of cellBoundsList(footprintCellKeys(graph), graph)) {
    const alongX = overlapLength(b.x1, b.x2, rect.x1, rect.x2);
    const alongY = overlapLength(b.y1, b.y2, rect.y1, rect.y2);
    if (Math.abs(b.y2 - rect.y1) <= EPS) out.top += alongX;
    if (Math.abs(b.y1 - rect.y2) <= EPS) out.bottom += alongX;
    if (Math.abs(b.x2 - rect.x1) <= EPS) out.left += alongY;
    if (Math.abs(b.x1 - rect.x2) <= EPS) out.right += alongY;
  }
  return out;
}

/**
 * 同じ階の屋内（建物範囲。定義は上の注記）のセル矩形。外形線が建物の出隅を回り込む判定
 * （roofFramingGeometry.js roofOutline の interiorRects）がセルの矩形との重なりで使う。屋内が無ければ空。
 * @param {object} graph 屋根のある階の graph
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
export function roofInteriorRects(graph) {
  return cellBoundsList(footprintCellKeys(graph), graph);
}

/**
 * 屋根範囲（矩形 rect）の各辺のうち、外側が同じ階の屋内に接する区間（roofEdgeInteriorAdjacency と同じ判定を、長さでなく
 * 区間で返す）。屋根の外形線（軒の出）が壁に当たって出幅 0 になる部分に使う。複数の屋内セルが接すれば区間も複数。
 * 辺の向き・外側は roofFramingGeometry.js の線と同じ（isVertical＝x=coord 一定、outward＝外側が coord の +方向か -方向か）。
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} rect
 * @param {object} graph 屋根のある階の graph
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1}>}
 */
export function roofEdgeInteriorContacts(rect, graph, interiorRects = null) {
  const out = [];
  if (!rect) return out;
  for (const b of interiorRects ?? roofInteriorRects(graph)) {
    const lo = Math.max(b.x1, rect.x1);
    const hi = Math.min(b.x2, rect.x2);
    const loY = Math.max(b.y1, rect.y1);
    const hiY = Math.min(b.y2, rect.y2);
    if (hi > lo && Math.abs(b.y2 - rect.y1) <= EPS) out.push({ isVertical: false, coord: rect.y1, lo, hi, outward: -1 });
    if (hi > lo && Math.abs(b.y1 - rect.y2) <= EPS) out.push({ isVertical: false, coord: rect.y2, lo, hi, outward: 1 });
    if (hiY > loY && Math.abs(b.x2 - rect.x1) <= EPS) out.push({ isVertical: true, coord: rect.x1, lo: loY, hi: hiY, outward: -1 });
    if (hiY > loY && Math.abs(b.x1 - rect.x2) <= EPS) out.push({ isVertical: true, coord: rect.x2, lo: loY, hi: hiY, outward: 1 });
  }
  return out;
}

/**
 * 屋根範囲の外周の辺（edges。矩形でない範囲も含む）の外側が同じ階の屋内に接する区間（roofEdgeInteriorContacts の一般化。
 * 矩形の4辺を渡せば同じ集合になる）。L字の下屋の翼（roofFramingGeometry.js leanToWingsOf）の壁の区間に使う。
 * 辺は orthogonalBoundaryLoops の辺（{isVertical, coord, lo, hi, outward}。outward＝外側が coord の +方向か -方向か）。
 * 外側が -方向の横の辺は、屋内セルの y2 が coord に接する。外側が +方向なら y1 が接する（縦の辺は x2・x1）。辺に沿う重なりが
 * 正のものだけ。複数の屋内セルが接すれば区間も複数。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1}>} edges
 * @param {object} graph 屋根のある階の graph
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>|null} [interiorRects] 屋内のセル矩形（roofInteriorRects の結果。
 *   呼び出し側が同じ階で何度も使うときに渡して再計算を避ける。省略・null なら graph から求める）
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1}>}
 * @throws {RangeError} edges が配列でない
 */
export function roofBoundaryInteriorContacts(edges, graph, interiorRects = null) {
  if (!Array.isArray(edges)) throw new RangeError('edges は配列でなければなりません');
  const out = [];
  if (edges.length === 0) return out;
  for (const b of interiorRects ?? roofInteriorRects(graph)) {
    for (const e of edges) {
      const [near, from, to] = e.isVertical
        ? [e.outward < 0 ? b.x2 : b.x1, b.y1, b.y2]
        : [e.outward < 0 ? b.y2 : b.y1, b.x1, b.x2];
      const lo = Math.max(from, e.lo);
      const hi = Math.min(to, e.hi);
      if (hi > lo && Math.abs(near - e.coord) <= EPS) out.push({ isVertical: e.isVertical, coord: e.coord, lo, hi, outward: e.outward });
    }
  }
  return out;
}

/**
 * 下屋（屋根の Room）の「高い側」の選択欄の表示判断。形状の実効値（resolveRoofShape）が片流れで屋根範囲が
 * 矩形のときだけ visible。値は resolveRoofHighSide（明示値→屋内に接する最長の辺→長手に平行な小さい側）。
 * @param {{ roofSpec: { shape: string|null, highSide: string|null }, cells: Set<string> }} room
 * @param {object} graph 屋根のある階の graph
 * @returns {{ visible: boolean, value: string|null }}
 */
export function roofHighSideViewOfRoom(room, graph) {
  const spec = room.roofSpec;
  const boundsList = roofRoomBounds(room, graph);
  const shape = resolveRoofShape(spec, { boundsList });
  const rect = rectOfBounds(boundsList);
  const adjacency = rect && shape === RoofShape.MONO ? roofEdgeInteriorAdjacency(rect, graph) : null; // 片流れ以外は使わない
  return roofHighSideView({ shape, highSide: spec?.highSide ?? null, rect, adjacency });
}

/**
 * 下屋（屋根の Room）の「柱貫通」チェックの表示判断（roofColumnThroughView に、その階の実効主構造の柱の配置源を渡す）。
 * 柱が通り芯の交点に立つ構造（S造・RC造（ラーメン）・SRC造）のときだけ visible。柱を持たない構造（RC造（壁式）・木造（2"×4"））と
 * 主構造が未定の階は出さない（柱を生成しないため。生成側 autoFillStructuralGrid の `structureHasMemberKind(COLUMN)` と同じ述語）。
 * @param {{ roofSpec: { columnThrough: boolean }|null }} room
 * @param {object} graph 屋根のある階の graph
 * @param {object|null} project 実効主構造の解決に使う（graph の上書きがあれば不要）
 * @returns {{ visible: boolean, value: boolean }}
 */
export function roofColumnThroughViewOfRoom(room, graph, project) {
  const structure = effectiveStructure(graph, project);
  return roofColumnThroughView({
    isLeanTo: true,
    columnPlacement: rulesFor(structure).columnPlacement,
    hasColumns: structure !== UNSPECIFIED_STRUCTURE && structureHasMemberKind(MEMBER_KIND.COLUMN, structure),
    columnThrough: room.roofSpec?.columnThrough ?? false,
  });
}

/**
 * 下屋（屋根の Room）の「棟木の向き」の選択欄の表示判断。形状の実効値（resolveRoofShape）が切妻で屋根範囲が
 * 矩形のときだけ visible。値は明示値（自動＝null）。
 * @param {{ roofSpec: { shape: string|null, ridgeDirection: string|null }, cells: Set<string> }} room
 * @param {object} graph 屋根のある階の graph
 * @returns {{ visible: boolean, value: string|null }}
 */
export function roofRidgeDirectionViewOfRoom(room, graph) {
  const spec = room.roofSpec;
  const boundsList = roofRoomBounds(room, graph);
  const shape = resolveRoofShape(spec, { boundsList });
  return roofRidgeDirectionView({ shape, ridgeDirection: spec?.ridgeDirection ?? null, rect: rectOfBounds(boundsList) });
}
