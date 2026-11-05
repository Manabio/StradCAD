/**
 * 展開図（室内）の壁面 1 枚へ、姿図の配置（graph.placedFigures）の正面図・背面図・側面図を足す（部分詳細図 S10 P5）。
 * 向きの約束・view の選び方は finish/placedFigure/placedFigureViews.js（R1・R3・R4）。
 *
 * 出す面（R2）: 配置点を含む部屋（room.cells に配置点のセルが入る部屋）の帯の面のうち、配置点を面へ投影した s 原点（x0）と
 *   図の s 範囲が面の [0, run]（面ローカル x）に掛かるもの。遠近・遮蔽は見ない（重ね描き＝既知の限界）。
 * 位置（R5）: x0＝localXOf(face, 面の走行方向の配置座標)（dirSign を含む世界→面ローカル。これ以外の反転はしない）。
 *   y0＝floorDyAt(x0) − zMm（展開は FL が y=0・上が負。zMm は配置した部屋の床面＝展開の床線からの高さで、建具と同じ floorDyAt 基準）。図の s 正＝面ローカル x 正・t 正＝下。
 * 線の語彙（R6）: 建具の姿図と同じ detailStrokesToElevationPrimitives（型は line／polyline だけ）。
 * s 反転（配置の鏡像・左右の鏡像代用）は fit 済みの座標へ写す段（placeViewStrokes）で行い、プリミティブの反転はしない。
 * 図の fit は図キーごとに 1 回（この呼出し内のキャッシュ。位置・回転・鏡像に依らない）。
 */
import { worldToCell } from '../finish/gridCells.js';
import { localXOf } from './elevationFaces.js';
import { translatePrimitive } from './elevationPrimitives.js';
import { detailStrokesToElevationPrimitives } from '../openings/openingDetailFit.js';
import { detailFigureEntry } from '../openings/openingCatalog.js';
import {
  viewForFace, resolvePlacedView, fitPlacedView, sRangeOf, placeViewStrokes,
} from '../finish/placedFigure/placedFigureViews.js';

/** 配置点を含むセルがこの部屋のものか（room.cells のセルキーは worldToCell の key と同じ形）。 */
function placedInRoom(pf, room, graph) {
  if (!room?.cells) return false;
  const cell = worldToCell(pf.x, pf.y, graph);
  return cell !== null && room.cells.has(cell.key);
}

/**
 * @param {object[]} prims 面ローカルのプリミティブ配列（破壊的に足す）
 * @param {{face:object, room:object, graph:object, figureOf?:(key:string)=>(object|null), floorDyAt:(x:number)=>number}} p
 */
export function appendPlacedFigures(prims, { face, room, graph, figureOf = detailFigureEntry, floorDyAt }) {
  const placed = graph?.placedFigures;
  if (!Array.isArray(placed) || placed.length === 0) return;
  // 見る向き d＝部屋側から壁へ＝−inward を面の垂直軸の単位ベクトルに掛けたもの
  const d = face.isVertical ? [-face.inward, 0] : [0, -face.inward];
  const fitCache = new Map();
  const fitOnce = (key, figV) => {
    if (!fitCache.has(key)) fitCache.set(key, fitPlacedView(figV));
    return fitCache.get(key);
  };
  for (const pf of placed) {
    if (pf === null || typeof pf !== 'object') continue;
    const fig = figureOf(pf.figureKey);
    if (!fig || !placedInRoom(pf, room, graph)) continue;
    const { view, mirrorS } = viewForFace(pf, d);
    const resolved = resolvePlacedView(fig, view, figureOf);
    if (resolved === null) continue;
    const fitted = fitOnce(resolved.key, resolved.fig);
    if (fitted.error) continue;
    const range = sRangeOf(fitted.strokes);
    if (range === null) continue;
    const flip = mirrorS !== resolved.mirrorS;
    const x0 = localXOf(face, face.isVertical ? pf.y : pf.x);
    const lo = x0 + (flip ? -range.max : range.min);
    const hi = x0 + (flip ? -range.min : range.max);
    if (hi <= 0 || lo >= face.run) continue;
    const y0 = floorDyAt(x0) - pf.zMm;
    for (const p of detailStrokesToElevationPrimitives(placeViewStrokes(fitted, flip))) {
      prims.push(translatePrimitive(p, x0, y0));
    }
  }
}
