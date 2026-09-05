/**
 * 吹抜け（feature=VOID）の×描画（壁内4頂点を対角に結ぶ線分）の幾何計算。
 *
 * 描画ルールをここへ集約し、レンダラ（renderer/VoidLayer.jsx）は結果を Konva 要素へ写像
 * するだけにする（finish/stepSection.js・finish/stair/stairGeometry.js と同じパターン）。
 * 対象は feature===VOID のみ——STAIR_VOID（階段吹抜け）は一切描画しない自動管理Room（要件）。
 */
import { RoomFeature } from '@core';
import { refreshCells, roomBounds, getCellsInRect } from './gridCells.js';
import { faceRect } from './wallFaces.js';

/**
 * 「上部吹抜け」（直下階に描く上階吹抜けの×・外形）の破線パターン（スクリーンpx）。
 * **上階に床が無い範囲の外形を表す破線の唯一の供給源**——階段側の見上げ破線
 * （上階スラブ開口の縁。finish/stair/stairLineJoinPrimitives.js の `stairUpperOpeningDashPx`）も
 * これを参照する。同じ性質の線なのに線種が食い違うと、隣り合ったとき混在して見える
 * （ユーザー決定2026-09）。自階の吹抜け（一点鎖線）・見下げの点線は別の線種で、ここには含めない。
 */
export const UPPER_VOID_DASH_PX = [8, 4];

/**
 * グラフ全体から吹抜けの×描画データを列挙する。
 * 矩形（RoomLabelsLayer.jsx の isRectangular 判定と同じ方式。ただし refreshCells 済みで比較）
 * でない部屋・壁内4頂点が解決できない部屋はスキップする。
 * @returns {{id:string, x1:number, y1:number, x2:number, y2:number}[]}
 */
export function computeVoidCrosses(graph) {
  if (!graph) return [];
  const result = [];
  for (const room of graph.rooms) {
    if (room.feature !== RoomFeature.VOID) continue;
    const cells = refreshCells(room.cells, graph);
    if (cells.size === 0) continue;
    const bounds = roomBounds(cells, graph);
    if (bounds.x1 === Infinity) continue;
    const cellsInBounds = getCellsInRect(bounds.x1, bounds.y1, bounds.x2, bounds.y2, graph);
    const isRectangular = cellsInBounds.every(c => cells.has(c.key));
    if (!isRectangular) continue;
    const rect = faceRect(cells, graph);
    if (!rect) continue;
    result.push({ id: room.id, x1: rect.x1, y1: rect.y1, x2: rect.x2, y2: rect.y2 });
  }
  return result;
}
