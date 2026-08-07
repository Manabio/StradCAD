// ================================================================
// 建具の「取付箇所」（隣接する部屋名）導出（純関数）。
//
// 永続化しない導出値——呼び出し時点の graph トポロジーから毎回計算する
// （部屋名・間取りが変わればその都度追随する。Opening 自体には保存しない）。
//
// 部屋⇔壁の隣接判定は finish/edgeClassify.js の edgeGeometry と同じサンプリング方式
// （軸線の直交方向へ ADJACENT_SAMPLE_EPS だけ離れた点を worldToCell→cellToRoom で
// 部屋へ解決する）を踏襲する——重複実装を避けるため、cellToRoom の構築（buildCellToRoom）・
// セル解決（worldToCell）・サンプリング距離（ADJACENT_SAMPLE_EPS）はそのまま import して共有し、
// この関数はサンプリング座標の組み立てだけを行う。
// ================================================================

import { RoomKind, RoomFeature } from '../core.js';
import { buildCellToRoom, ADJACENT_SAMPLE_EPS } from '../finish/edgeClassify.js';
import { worldToCell } from '../finish/gridCells.js';
import { findHostWall } from './openingGeometry.js';

// 軸直交座標 perp・軸方向座標 along の点が属するセルの部屋を返す。
// 名前なし・未定義部屋（feature=UNDEFINED）は「特定できない」として null 扱いにする。
function roomAt(perp, along, isVertical, graph, cellToRoom) {
  const cell = isVertical ? worldToCell(perp, along, graph) : worldToCell(along, perp, graph);
  if (!cell) return null;
  const room = cellToRoom.get(cell.key) ?? null;
  if (!room || !room.name || room.feature === RoomFeature.UNDEFINED) return null;
  return room;
}

/**
 * 開口の「取付箇所」表示文字列を導出する。
 *   - 内壁の開口: 両側の部屋名を「・」区切り（片側のみ特定できれば片側の名前のみ）
 *   - 外壁の開口: 室内側（kind !== EXTERIOR）の部屋名のみ
 *   - ホスト壁が見つからない／部屋が特定できない／未定義部屋: 空文字
 * @param {object} opening core.js の Opening
 * @param {object} graph
 * @param {Map<string, import('@core').Room>} [cellToRoom] 省略時は都度 buildCellToRoom する
 * @returns {string}
 */
export function openingMountLocation(opening, graph, cellToRoom = buildCellToRoom(graph)) {
  const host = findHostWall(opening, graph);
  if (!host) return '';

  const perp = host.axisValue;
  const along = opening.centerCoord;
  const roomNeg = roomAt(perp - ADJACENT_SAMPLE_EPS, along, opening.isVertical, graph, cellToRoom);
  const roomPos = roomAt(perp + ADJACENT_SAMPLE_EPS, along, opening.isVertical, graph, cellToRoom);

  if (host.isExteriorWall) {
    const interior = [roomNeg, roomPos].find(r => r && r.kind !== RoomKind.EXTERIOR);
    return interior ? interior.name : '';
  }

  const names = [roomNeg, roomPos].filter(Boolean).map(r => r.name);
  return [...new Set(names)].join('・');
}
