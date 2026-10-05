/**
 * 下屋の「柱貫通」の判定（純モジュール。store.js / snap.js / .jsx / react-konva を静的 import しない）。
 *
 * 通り芯の交点に柱が立つ構造（S造・RC造・SRC造。rules.columnPlacement が 'wallIntersections' でないもの）で、
 * 柱の交点が「その階で屋根セルにしか接しない位置」かを、点サンプリングではなくセル矩形との接触で判定する。
 *   - 屋内のセル矩形＝ roofInteriorRects(graph)（建物範囲 footprintCellKeys と同じ定義）。
 *   - 屋根のセル矩形＝屋根の部屋（feature===ROOF）ごとの roofRoomBounds。
 * 交点に閉区間（±tol）で触れる屋内セルが1つでもあれば 'none'（建物の壁の線上など。今までどおり wallGate が決める）。
 * 屋内に触れず屋根セルに触れるときだけ屋根のみの交点で、触れる屋根の部屋のどれかが columnThrough:true なら
 * 'roofOnlyThrough'（自階の屋根セルを建物とみなして柱を立てる）、すべて false なら 'roofOnlyBlocked'（柱を作らず、
 * 屋根にする前に立った auto の柱も撤去する）。屋根のセルが無い・屋内が無い階（建物範囲が未定義＝wallGate が null の階）は
 * 常に 'none'（今までと完全に同じ）。
 * x, y は柱の通り芯の交点の座標（芯ずれした柱の実位置ではない）。
 */
import { isRoofFeature } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { roofInteriorRects } from '../finish/roof/roofOrientation.js';
import { roofRoomBounds } from '../finish/roof/roofDefaults.js';

export const ROOF_COLUMN_CLASS = Object.freeze({
  NONE: 'none',
  BLOCKED: 'roofOnlyBlocked',
  THROUGH: 'roofOnlyThrough',
});

const touches = (r, x, y, tol) => x >= r.x1 - tol && x <= r.x2 + tol && y >= r.y1 - tol && y <= r.y2 + tol;
const contains = (r, x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;

const NO_FILTER = Object.freeze({
  empty: true,
  classify: () => ROOF_COLUMN_CLASS.NONE,
  throughCellAt: () => false,
});

/**
 * 階の graph から柱貫通のフィルタを作る。
 * @param {object} graph 屋根セルのある階の graph
 * @param {{tolMm?: number}} [opts] 接触の許容差（既定 CL_OVERLAP_TOL_MM）
 * @returns {{
 *   empty: boolean,
 *   classify: (x:number, y:number) => 'none'|'roofOnlyBlocked'|'roofOnlyThrough',
 *   throughCellAt: (wx:number, wy:number) => boolean,
 * }} throughCellAt は columnThrough:true の屋根セルの中（境界を含む）の点か（wallGate の象限判定が使う）。
 */
export function buildRoofColumnFilter(graph, { tolMm = CL_OVERLAP_TOL_MM } = {}) {
  const roofRooms = (graph?.rooms ?? []).filter(r => isRoofFeature(r.feature) && r.roofSpec);
  if (roofRooms.length === 0) return NO_FILTER;
  const interior = roofInteriorRects(graph);
  if (interior.length === 0) return NO_FILTER;
  const roofs = [];
  for (const room of roofRooms) {
    const through = room.roofSpec.columnThrough === true;
    for (const rect of roofRoomBounds(room, graph)) roofs.push({ rect, through });
  }
  if (roofs.length === 0) return NO_FILTER;
  const throughRects = roofs.filter(r => r.through).map(r => r.rect);
  return {
    empty: false,
    classify(x, y) {
      if (interior.some(r => touches(r, x, y, tolMm))) return ROOF_COLUMN_CLASS.NONE;
      const hit = roofs.filter(r => touches(r.rect, x, y, tolMm));
      if (hit.length === 0) return ROOF_COLUMN_CLASS.NONE;
      return hit.some(r => r.through) ? ROOF_COLUMN_CLASS.THROUGH : ROOF_COLUMN_CLASS.BLOCKED;
    },
    throughCellAt: (wx, wy) => throughRects.some(r => contains(r, wx, wy)),
  };
}
