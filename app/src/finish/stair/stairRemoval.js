/**
 * 階段の削除（単階の本体と、上の階への連動の計画）。純モジュール——I/O・モード状態・undo を持たない。
 * 静的 import は @core・gridCells・floorCLMap・roomUndefined・stairUnderSplit に限る
 * （store.js・snap.js・.jsx を引かない。node:test から単体 import できる状態を保つ）。
 *
 * 単階の本体（removeStairOnFloor）は modes/FinishModeState.js の `_deleteStairNoUndo` から選択状態の
 * クリアを除いたもの。上の階への連動（planStairRemovalCascade → applyStairRemovalToFloor）は、
 * syncUpperFloors（finish/stair/stairFloorSync.js）が指定時に直上1階へ置いた階段吹抜け（STAIR_VOID）を、
 * 設置階の削除に合わせて未定義化するための計画と適用（直上階のユーザー指定の階段は消さない）。
 */
import { RoomFeature, RoomKind } from '@core';
import { refreshCells } from '../gridCells.js';
import { translateCellSet } from '../floorCLMap.js';
import { makeRoomUndefined } from '../roomUndefined.js';
import { removeUnderStairSplit } from './stairUnderSplit.js';

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * 1つの階から階段を取り除く（undo 記録・選択のクリアなし）。
 * 階段下の分割CLを指定ごと戻す→ペアRoom（stair.roomId）が屋外なら removeRoom／屋内なら未定義化
 * （外壁線を維持）→連動する外部仕上げ行を削除→階段を削除。順序と条件は FinishModeState の従来実装と同じ。
 * @returns {{roomId: string|null}} 階段が持っていたペアRoomのid
 */
export function removeStairOnFloor(graph, stair) {
  removeUnderStairSplit(stair, graph); // 階段下の分割CLを指定ごと元に戻す
  if (stair.roomId && graph.roomMap.has(stair.roomId)) {
    const room = graph.roomMap.get(stair.roomId);
    if (room.kind === RoomKind.EXTERIOR) {
      graph.removeRoom(stair.roomId);
    } else {
      makeRoomUndefined(room);
    }
  }
  if (stair.roomId) graph.removeExteriorRowsByRoomId(stair.roomId); // 連動する外部仕上げ行も削除
  graph.removeStair(stair.id);
  return { roomId: stair.roomId ?? null };
}

// srcStair の footprint を dstGraph の現行グリッドのセル集合へ写す。写せない・空なら null。
// translateCellSet は src 側の shapeMap（無ければ structGraph）でCL idを引き、dst 側では type:value で
// 対応CLを探すため、下階→上階にも上階→下階にも使える（対応CLが dst に在る限り）。
export function mapFootprint(srcStair, srcGraph, structGraph, dstGraph) {
  const translated = translateCellSet(srcStair.cells, srcGraph, structGraph, dstGraph);
  if (!translated) return null;
  const cells = refreshCells(translated, dstGraph);
  return cells.size === 0 ? null : cells;
}

/**
 * 設置階の階段 stair の削除に連動して、直上1階で未定義化する階段吹抜けを決める。
 * 対象は uppers の先頭1階だけ（それより上は触らない）。同 footprint（refreshCells で原子セルへ展開して比較）の
 * STAIR_VOID を全部拾う。直上階にユーザー指定の階段があっても消さない（階段は自階のもの）。
 * 写せない・該当なしなら空配列。
 * @param {{structGraph: object, activeGraph: object, stair: object, uppers: Array<{plane: object, graph: object}>}} p
 *   uppers は elevation 昇順の上の採用階（設置階の直上から。先頭だけ使う）
 * @returns {Array<{plane: object, graph: object, voidRooms: object[]}>} 0件か1件
 */
export function planStairRemovalCascade({ structGraph, activeGraph, stair, uppers }) {
  const next = uppers[0];
  if (!next) return [];
  const { plane, graph } = next;
  const cells = mapFootprint(stair, activeGraph, structGraph, graph);
  if (!cells) return [];
  const voidRooms = graph.rooms.filter(r =>
    r.feature === RoomFeature.STAIR_VOID && setsEqual(refreshCells(r.cells, graph), cells));
  return voidRooms.length > 0 ? [{ plane, graph, voidRooms }] : [];
}

/**
 * 計画の1階分を適用する（同 footprint の階段吹抜けを全部未定義化）。
 * @returns {boolean} 何かを変更したか
 */
export function applyStairRemovalToFloor(graph, target) {
  for (const room of target.voidRooms) makeRoomUndefined(room);
  return target.voidRooms.length > 0;
}
