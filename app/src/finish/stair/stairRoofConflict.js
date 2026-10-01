/**
 * 階段の指定の事前チェック: 階段が上の階へ展開される位置に屋根（RoomFeature.ROOF）があるか
 * （純関数。graph を読む・一時グラフへ CL を足す。I/O なし。store.js / snap.js / .jsx を静的 import しない）。
 * ステップ B1b。昇降機の上階事前チェック（finish/equipment/equipmentFloorPlan.js
 * findShaftInstallConflicts・judgeElevatorInstall）と同じ形——確定前に衝突を見つけたら呼び出し側が
 * 階段の指定を確定せずメッセージを出す。
 *
 * 展開の規則は finish/stair/stairFloorSync.js syncUpperFloors と揃える: 設置階の階段 footprint を
 * 上の各採用階へ type:value 照合で写し、さらに上に階がある階（中間階）には階段が、最上階には
 * 屋内階段のときだけ階段吹抜けが作られる。屋外階段は最上階では何も作られないので対象外。
 * 衝突の相手は屋根（ROOF）だけ——通常の部屋・屋外部屋との重なりは従来どおり（今回変えない）。
 */
import { isRoofFeature } from '@core';
import { refreshCells } from '../gridCells.js';
import { collectNeededCLs, addMissingCLs, translateCellSet } from '../floorCLMap.js';

/**
 * 階段の上階展開と屋根セルの衝突を階の順に列挙する。上の階のグラフ（floors[activeIndex+1…].graph）へ
 * 不足CLを足す副作用がある——一時グラフ（peek した複製）専用。呼び出し側が捨てる。
 *
 * @param {object} params
 * @param {object} params.structGraph - project.structGraph
 * @param {Array<{plane:object, graph:object}>} params.floors - 全採用フロア（elevation昇順）。
 *   activeIndex の位置には設置階の生きているグラフを入れる
 * @param {number} params.activeIndex - floors 内の設置階のインデックス
 * @param {Set<string>} params.cells - 設置階の階段の変換元セル（raw。applyNaming が Stair に渡す room.cells）
 * @param {boolean} params.indoor - 屋内階段か（屋外階段は最上階に階段吹抜けを作らない）
 * @returns {Array<{planeId:string, floorLabel:string, expands:'stair'|'stairVoid', roomId:string}>}
 */
export function findStairUpperRoofConflicts({ structGraph, floors, activeIndex, cells, indoor }) {
  const conflicts = [];
  const sourceGraph = floors[activeIndex].graph;
  const needed = collectNeededCLs(cells, sourceGraph);

  for (let i = activeIndex + 1; i < floors.length; i++) {
    const { plane, graph: upperGraph } = floors[i];
    const hasFloorAbove = i + 1 < floors.length;
    if (!hasFloorAbove && !indoor) continue; // 最上階の屋外階段: 何も展開されない

    addMissingCLs(needed, sourceGraph, structGraph, upperGraph);
    const translated = translateCellSet(cells, sourceGraph, structGraph, upperGraph);
    if (!translated) continue; // CL変換不能: syncUpperFloors もこの階段の展開をスキップする
    const footprint = refreshCells(translated, upperGraph);

    for (const room of upperGraph.rooms) {
      if (!isRoofFeature(room.feature)) continue;
      const roofCells = refreshCells(room.cells, upperGraph);
      if ([...footprint].some(k => roofCells.has(k))) {
        conflicts.push({
          planeId: plane.id, floorLabel: plane.name,
          expands: hasFloorAbove ? 'stair' : 'stairVoid', roomId: room.id,
        });
        break; // 1階につき1件（階名の一覧が欲しいだけ）
      }
    }
  }
  return conflicts;
}
