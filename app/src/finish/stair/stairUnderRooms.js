/**
 * 階段の破れ線先セル（beyondCells）に交差する部屋（2a部屋候補）の抽出。
 *
 * FinishModeState.stairUnderRooms（脱出時の壁生成の入力）と、stairUnderClip.js（描画クリップの
 * 対象2a部屋の同定）の双方が同じ判定を必要とするため、部屋抽出部分だけを単一ソース化する。
 * 中間階ガード（下階階段の見下げ位置）・riser・splitCLIds の算出は呼び出し側の責務のまま
 * （stair・graph・beyondCells だけで完結する部分のみここに置く）。
 */

import { RoomFeature } from '@core';
import { refreshCells, cellBoundsFromKey, cellBoundsList } from '../gridCells.js';
import { cellsBeyondBreak, stairPortEdges } from './stairGeometry.js';
import { findUnderStairSplitCLs } from './stairUnderSplit.js';
import { floorHeightAbove } from './stairDimensions.js';

/**
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {Set<string>} beyondCells - cellsBeyondBreak(stair, graph, riser) の結果
 * @returns {import('@core').Room[]} beyondCells に交差する部屋（階段ペアRoom・階段吹抜け・
 *   UNDEFINED・stair自身のペアRoomは除外）
 */
export function stairUnderRoomsOf(stair, graph, beyondCells) {
  const result = [];
  for (const room of graph.rooms) {
    if (room.feature === RoomFeature.STAIR || room.feature === RoomFeature.STAIR_VOID
      || room.feature === RoomFeature.UNDEFINED) continue;
    if (stair.roomId && room.id === stair.roomId) continue;
    let intersects = false;
    for (const key of refreshCells(room.cells, graph)) {
      if (beyondCells.has(key)) { intersects = true; break; }
    }
    if (!intersects) continue;
    result.push(room);
  }
  return result;
}

/**
 * 階段下部屋（破れ線先セルに部屋指定された領域）を検出する（仕上げモード脱出時の
 * 階段下壁生成 finish/wallRegeneration.js の入力）。FinishModeState.stairUnderRooms は
 * これへ委譲する（同じ判定を2系統持たない）。
 *
 * 中間階ガード: beyondセルのいずれかが下階階段の見下げに当たる中間階の階段は対象外
 * （階段下エリアではなく下階階段の吹抜けのため）。
 *
 * @param {object} graph
 * @param {object} [opts]
 * @param {Array<{stair, cellBounds: Array}>} [opts.lowerStairCellBounds] - 直下階の階段
 *   （見下げ判定用）。FinishModeState.lowerStairs（_loadLowerStairs の結果）と同形。
 * @param {number|null} [opts.floorHeight] - 自階の階高(mm)。stair.riser 未指定時の蹴上推定に使う
 *   （floorHeightAbove(project, activePlane) 相当。呼び出し側が解決して渡す）。
 * @returns {Array<{stair, room, riser, beyondCells:Set<string>, splitCLIds:Set<string>}>}
 */
export function resolveStairUnderEntries(graph, { lowerStairCellBounds = [], floorHeight = null } = {}) {
  const lowerStairForPoint = (x, y) => {
    for (const entry of lowerStairCellBounds) {
      if (entry.cellBounds.some(b => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2)) return entry.stair;
    }
    return null;
  };

  const result = [];
  for (const stair of graph.stairs) {
    const riser = stair.riser != null ? stair.riser : (floorHeight != null ? floorHeight / Math.max(1, stair.totalSteps) : null);
    const beyond = cellsBeyondBreak(stair, graph, riser);
    if (beyond.size === 0) continue;

    // beyondセルのいずれかが下階階段の見下げに当たる中間階の階段は対象外
    // （階段下エリアではなく下階階段の吹抜けのため）。
    let hasLowerStair = false;
    for (const key of beyond) {
      const cb = cellBoundsFromKey(key, graph);
      if (!cb) continue;
      const cx = (cb.x1 + cb.x2) / 2, cy = (cb.y1 + cb.y2) / 2;
      if (lowerStairForPoint(cx, cy)) { hasLowerStair = true; break; }
    }
    if (hasLowerStair) continue;

    const splitCLIds = new Set(findUnderStairSplitCLs(stair, graph).map(cl => cl.id));

    for (const room of stairUnderRoomsOf(stair, graph, beyond)) {
      result.push({ stair, room, riser, beyondCells: beyond, splitCLIds });
    }
  }
  return result;
}

/**
 * graph（自階 or 使い捨てグラフ）の stairUnderEntries・extraStairOpenings を、直下階の解決込みで
 * まとめる（regenerateWalls への入力一式）。直下階の取得方法（実IDB peek／FinishModeStateの
 * 下階キャッシュ／graphMapの同期参照）は呼び出し側の事情で異なるため、`peek` として注入する
 * （wallRefresh.js の全階sweep・finish/finishBoundary.js の仕上げ脱出境界・
 * scripts/probe/dumpPlanRegen.mjs の3系統が同じ解決を別々に持たないための単一ソース化）。
 * このファイルは純モジュールのため floorSwapManager 等は静的に import しない（peek引数で受ける）。
 * @param {object} graph
 * @param {object} project
 * @param {(plane:object, structGraph:object) => Promise<object|null>} peek - 直下階のグラフを
 *   解決する関数（存在しない／解決できないときは null を返す）
 * @returns {Promise<{ stairUnderEntries: Array, extraStairOpenings: Array }>}
 */
export async function resolveStairContext(graph, project, peek) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === graph.plane?.id);
  const belowPlane = idx > 0 ? planes[idx - 1] : null;
  const belowGraph = belowPlane ? await peek(belowPlane, project.structGraph) : null;

  const lowerStairCellBounds = belowGraph
    ? belowGraph.stairs.map(s => ({ stair: s, cellBounds: cellBoundsList(s.cells, belowGraph) }))
    : [];
  const floorHeight = floorHeightAbove(project, graph.plane);
  const stairUnderEntries = resolveStairUnderEntries(graph, { lowerStairCellBounds, floorHeight });

  const extraStairOpenings = [];
  if (belowGraph && graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID)) {
    extraStairOpenings.push(...belowGraph.stairs.flatMap(s => stairPortEdges(s, belowGraph, ['arrival'])));
  }
  return { stairUnderEntries, extraStairOpenings };
}
