/**
 * 階段の削除（単階の本体と、上の階への連動の計画）。純モジュール——I/O・モード状態・undo を持たない。
 * 静的 import は @core・gridCells・floorCLMap・roomUndefined・stairUnderSplit に限る
 * （store.js・snap.js・.jsx を引かない。node:test から単体 import できる状態を保つ）。
 *
 * 単階の本体（removeStairOnFloor）は modes/FinishModeState.js の `_deleteStairNoUndo` から選択状態の
 * クリアを除いたもの。上の階への連動（planStairRemovalCascade → applyStairRemovalToFloor）は、
 * syncUpperFloors（finish/stair/stairFloorSync.js）が指定時に上の階へ自動設置した階段と最上階の
 * 階段吹抜け（STAIR_VOID）を、設置階の削除に合わせて消すための計画と適用。
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
function mapFootprint(srcStair, srcGraph, structGraph, dstGraph) {
  const translated = translateCellSet(srcStair.cells, srcGraph, structGraph, dstGraph);
  if (!translated) return null;
  const cells = refreshCells(translated, dstGraph);
  return cells.size === 0 ? null : cells;
}

/**
 * srcStair と同じ footprint の階段を dstGraph から探す。照合は syncUpperStairInteriors と同じ
 * 「現行グリッドへ展開したセル集合の一致」。写せない・無ければ null。
 */
export function findSameFootprintStair(srcStair, srcGraph, structGraph, dstGraph) {
  const cells = mapFootprint(srcStair, srcGraph, structGraph, dstGraph);
  if (!cells) return null;
  return dstGraph.stairs.find(s => setsEqual(refreshCells(s.cells, dstGraph), cells)) ?? null;
}

/**
 * stair（graph 上）が「下の階から続く階段」（直下階に同 footprint の階段がある）か。
 * belowGraph が無ければ偽。stair の graph を起点に直下階へ写して照合する。
 */
export function isContinuationStair(stair, graph, belowGraph, structGraph) {
  if (!belowGraph) return false;
  return findSameFootprintStair(stair, graph, structGraph, belowGraph) !== null;
}

/**
 * 設置階の階段 stair の削除に連動して、上の階で消す対象を下から順に決める。
 * 各階で同 footprint の階段と同 footprint の STAIR_VOID 部屋を探す。階段が見つかれば次の階の基準にして
 * 続け、見つからない／写せない階で打ち切る（その階の STAIR_VOID は拾ってから打ち切る）。
 * 階段も吹抜けも無い階は結果に入れない。
 * @param {{structGraph: object, activeGraph: object, stair: object, uppers: Array<{plane: object, graph: object}>}} p
 *   uppers は elevation 昇順の上の採用階（設置階の直上から）
 * @returns {Array<{plane: object, graph: object, stair: object|null, voidRoom: object|null}>}
 */
export function planStairRemovalCascade({ structGraph, activeGraph, stair, uppers }) {
  const targets = [];
  let baseStair = stair;
  let baseGraph = activeGraph;
  for (const { plane, graph } of uppers) {
    const cells = mapFootprint(baseStair, baseGraph, structGraph, graph);
    if (!cells) break;
    const found = graph.stairs.find(s => setsEqual(refreshCells(s.cells, graph), cells)) ?? null;
    const voidRoom = graph.rooms.find(r =>
      r.feature === RoomFeature.STAIR_VOID && setsEqual(refreshCells(r.cells, graph), cells)) ?? null;
    if (found || voidRoom) targets.push({ plane, graph, stair: found, voidRoom });
    if (!found) break;
    baseStair = found;
    baseGraph = graph;
  }
  return targets;
}

/**
 * 計画の1階分を適用する（階段があれば removeStairOnFloor、階段吹抜けがあれば未定義化）。
 * @returns {boolean} 何かを変更したか
 */
export function applyStairRemovalToFloor(graph, target) {
  let changed = false;
  if (target.stair) { removeStairOnFloor(graph, target.stair); changed = true; }
  if (target.voidRoom) { makeRoomUndefined(target.voidRoom); changed = true; }
  return changed;
}
