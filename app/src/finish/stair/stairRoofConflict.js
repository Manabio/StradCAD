/**
 * 階段の指定の事前チェック: 階段が上の階へ展開される位置に屋根（RoomFeature.ROOF）があるか
 * （純関数。graph を読む・一時グラフへ CL を足す。I/O なし。store.js / snap.js / .jsx を静的 import しない）。
 * ステップ B1b。昇降機の上階事前チェック（finish/equipment/equipmentFloorPlan.js
 * findShaftInstallConflicts・judgeElevatorInstall）と同じ形——確定前に衝突を見つけたら呼び出し側が
 * 階段の指定を確定せずメッセージを出す。
 *
 * 展開の規則は finish/stair/stairFloorSync.js syncUpperFloors と揃える: 設置階の階段 footprint を
 * 直上の採用階（1階だけ）へ type:value 照合で写し、屋内階段のときだけそこへ階段吹抜けが作られる。
 * 屋外階段は何も作られないので対象外。それより上の階は見ない。
 * 衝突の相手は屋根（ROOF）だけ——通常の部屋とは衝突しない（吹抜けが足元を引き抜いて置かれる。stairVoidReconcile.js addStairVoidRoom）。屋外部屋との重なりは置かないだけで拒否はしない。
 */
import { isRoofFeature } from '@core';
import { refreshCells } from '../gridCells.js';
import { collectNeededCLs, addMissingCLs, extendDividerExtents, translateCellSet } from '../floorCLMap.js';

/**
 * 階段の上階展開と屋根セルの衝突を列挙する。対象は直上の1階（floors[activeIndex+1]）だけ。
 * その階のグラフへ不足CLを足す副作用がある——一時グラフ（peek した複製）専用。呼び出し側が捨てる。
 *
 * @param {object} params
 * @param {object} params.structGraph - project.structGraph
 * @param {Array<{plane:object, graph:object}>} params.floors - 設置階とその上の採用フロア（elevation昇順）。
 *   activeIndex の位置には設置階の生きているグラフを入れる。直上階より上は見ない（無くてよい）
 * @param {number} params.activeIndex - floors 内の設置階のインデックス
 * @param {Set<string>} params.cells - 設置階の階段の変換元セル（raw。applyNaming が Stair に渡す room.cells）
 * @param {boolean} params.indoor - 屋内階段か（屋外階段は上階に何も置かない）
 * @returns {Array<{planeId:string, floorLabel:string, expands:'stairVoid', roomId:string}>}
 */
export function findStairUpperRoofConflicts({ structGraph, floors, activeIndex, cells, indoor }) {
  const next = floors[activeIndex + 1];
  if (!next || !indoor) return []; // 直上階が無い／屋外階段: 何も展開されない
  const sourceGraph = floors[activeIndex].graph;
  const { plane, graph: upperGraph } = next;

  addMissingCLs(collectNeededCLs(cells, sourceGraph), sourceGraph, structGraph, upperGraph);
  extendDividerExtents(cells, sourceGraph, structGraph, upperGraph); // reconcileStairVoids と同じ格子にそろえる
  const translated = translateCellSet(cells, sourceGraph, structGraph, upperGraph);
  if (!translated) return []; // CL変換不能: reconcileStairVoids もこの階段をスキップする
  const footprint = refreshCells(translated, upperGraph);

  for (const room of upperGraph.rooms) {
    if (!isRoofFeature(room.feature)) continue;
    const roofCells = refreshCells(room.cells, upperGraph);
    if ([...footprint].some(k => roofCells.has(k))) {
      return [{ planeId: plane.id, floorLabel: plane.name, expands: 'stairVoid', roomId: room.id }];
    }
  }
  return [];
}
