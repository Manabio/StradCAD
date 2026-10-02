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
import { rectOfBounds, roofHighSideView, roofRidgeDirectionView } from './roofGeometry.js';

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
