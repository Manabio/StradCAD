/**
 * 吹抜け（feature=VOID）・昇降路（isShaftFeature。昇降機）の×描画
 * （壁内4頂点を対角に結ぶ線分）の幾何計算。
 *
 * 描画ルールをここへ集約し、レンダラ（renderer/VoidLayer.jsx）は結果を Konva 要素へ写像
 * するだけにする（finish/stepSection.js・finish/stair/stairGeometry.js と同じパターン）。
 * 対象は feature===VOID または isShaftFeature(feature) のみ——STAIR_VOID（階段吹抜け）は
 * 一切描画しない自動管理Room（要件）。上部吹抜けラベル（「上部吹抜け」文言）は VOID のみに
 * 付ける（`showsUpperVoidLabel`）——昇降路は同じシャフトが続くだけなので破線のみ（裁定Q8）。
 *
 * 昇降路（isShaftFeature）は器具行を1件以上持つRoomなら「器具単位」で×を出す
 * （id は器具行の id。統合でL字になったRoomでも器具ごとに矩形が出る）。器具行の無い
 * 昇降路Room（旧データ）はRoom単位のまま（挙動不変）。同じRoom内の器具どうしの境界には
 * 壁が無いため、faceRectはその境界をCLのeffectiveValueへフォールバックし、隣の器具へ
 * はみ出さず・重ならない矩形になる。
 */
import { RoomFeature, isShaftFeature } from '@core';
import { refreshCells, isRectangularCellSet } from './gridCells.js';
import { faceRect } from './wallFaces.js';

// crossを1件組み立てる（矩形でない・壁内頂点が解決できない場合はnull）
function buildCross(id, feature, cells, graph) {
  if (!isRectangularCellSet(cells, graph)) return null;
  const rect = faceRect(cells, graph);
  if (!rect) return null;
  return { id, feature, x1: rect.x1, y1: rect.y1, x2: rect.x2, y2: rect.y2 };
}

/**
 * 「上部吹抜け」（直下階に描く上階吹抜けの×・外形）の破線パターン（スクリーンpx）。
 * **上階に床が無い範囲の外形を表す破線の唯一の供給源**——階段側の見上げ破線
 * （上階スラブ開口の縁。finish/stair/stairLineJoinPrimitives.js の `stairUpperOpeningDashPx`）も
 * これを参照する。同じ性質の線なのに線種が食い違うと、隣り合ったとき混在して見える
 * （ユーザー決定2026-09）。自階の吹抜け（一点鎖線）・見下げの点線は別の線種で、ここには含めない。
 */
export const UPPER_VOID_DASH_PX = [8, 4];

/**
 * グラフ全体から吹抜け・昇降路（昇降機）の×描画データを列挙する。
 * 矩形（RoomLabelsLayer.jsx の isRectangular 判定と同じ方式。ただし refreshCells 済みで比較）
 * でない部屋・壁内4頂点が解決できない部屋はスキップする。
 * @returns {{id:string, feature:string, x1:number, y1:number, x2:number, y2:number}[]}
 */
export function computeVoidCrosses(graph) {
  if (!graph) return [];
  const result = [];
  const registeredShaftRoomIds = new Set(
    (graph.equipmentRows ?? []).map(r => r.roomId).filter(Boolean),
  );
  for (const room of graph.rooms) {
    if (room.feature !== RoomFeature.VOID && !isShaftFeature(room.feature)) continue;
    // 器具行を1件以上持つ昇降路Roomは器具単位（下のループ）へ委譲する。
    if (isShaftFeature(room.feature) && registeredShaftRoomIds.has(room.id)) continue;
    const cross = buildCross(room.id, room.feature, refreshCells(room.cells, graph), graph);
    if (cross) result.push(cross);
  }
  for (const row of graph.equipmentRows ?? []) {
    const cells = refreshCells(row.cellKeys, graph);
    if (cells.size === 0) continue; // セルが解決できない（CL無し等）行はスキップ
    const cross = buildCross(row.id, RoomFeature.ELEVATOR_EQUIPMENT, cells, graph);
    if (cross) result.push(cross);
  }
  return result;
}

/**
 * 直下階から見た「上部吹抜け」ラベル（固定文言）を付けるかどうか。
 * VOID のみ true——昇降路（昇降機）は同じシャフトが階をまたいで続くだけなので、上部吹抜け
 * ラベルは付けず破線の×のみで表す（裁定Q8）。
 * @param {{feature:string}} cross computeVoidCrosses の返り値の要素
 * @returns {boolean}
 */
export function showsUpperVoidLabel(cross) {
  return cross?.feature === RoomFeature.VOID;
}
