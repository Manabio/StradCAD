/**
 * 姿図の配置点が入っている部屋の名前（図面モードのパネルの表示用。保存しない＝配置点から都度引く。部屋の再解釈・移動で配置は動かないため、
 * 保存すると古くなる）。純モジュール（store.js・snap.js・.jsx・react を静的に引かない）。
 * 点→セル（gridCells.worldToCell）→部屋（edgeClassify.buildCellToRoom。展開・立面と同じ逆引き）。
 * 名前が空の部屋は仕上げ表の内部タブと同じ表示名（interiorRoomDisplayName）。
 */
import { RoomFeature } from '@core';
import { buildCellToRoom } from '../edgeClassify.js';
import { worldToCell } from '../gridCells.js';
import { interiorRoomDisplayName } from '../interiorTabRooms.js';

// 器具を置く部屋として数えない部屋: 未定義（削除済み）・階段吹抜け（自動管理で描画・操作の対象外）・屋根（下屋。壁・境界の判定で部屋なしと同じ扱い）。
const NOT_A_ROOM_FEATURES = Object.freeze([RoomFeature.UNDEFINED, RoomFeature.STAIR_VOID, RoomFeature.ROOF]);

/**
 * graph の部屋の逆引きを 1 回だけ作り、(x, y)→部屋の表示名|null を返す。一覧は行の数だけ引くので、行ごとに逆引きを作り直さない
 * （逆引きは全部屋のセルを更新する。行ごとに作ると「行の数 × 部屋の数」に比例して遅くなる）。
 * どの部屋にも入らない（セルが引けない・部屋のセルでない・器具を置く部屋として数えない部屋・座標が不正）は null。graph が不正なら常に null を返す関数。
 * @returns {(x: number, y: number) => (string|null)}
 */
export function placedFigureRoomNameLookup(graph) {
  if (graph === null || typeof graph !== 'object') return () => null;
  const cellToRoom = buildCellToRoom(graph);
  return (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const key = worldToCell(x, y, graph)?.key;
    if (key === undefined) return null;
    const room = cellToRoom.get(key);
    if (room === undefined || NOT_A_ROOM_FEATURES.includes(room.feature)) return null;
    return interiorRoomDisplayName(room);
  };
}

/** 1 点だけ引く口（逆引きを毎回作る。一覧のように何度も引くときは placedFigureRoomNameLookup を 1 回作って使う）。 */
export function placedFigureRoomNameAt(graph, x, y) {
  return placedFigureRoomNameLookup(graph)(x, y);
}
