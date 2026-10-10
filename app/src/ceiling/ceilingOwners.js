/**
 * 天井セルの所属（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏の所属の唯一の索引。選択（ceilingSelection.js）と描画の天井面（ceilingSurfaces.js）の両方がこれを使う
 * （S9・裁定 2026-10-10。親と部分指定の優先は並び順に依存しない。部分指定どうしが同じセルを持つときだけ部屋順の先勝ち）。
 *
 * セルキーは天井セル（仕上げのセルを天井芯でさらに割った格子。ceilingGrid.js）。
 * Owner = { kind: 'room'|'stair', id, rowId }。rowId は天伏パネルの行 id（部屋は room.id、階段は stair.roomId ?? stair.id）。
 * 優先は「天井を持つ部屋 → 階段 → なし」。
 *   - 部屋: 天井を持たない部屋（roomHasCeiling が偽）は所有に加えない（仕上げの commitDrag が STAIR・STAIR_VOID・
 *     UNDEFINED・昇降路・屋根を先に除くのと同じ形）。そのうえで部分指定の子〔referenceRoomIds 非空〕を先に、
 *     親・単一部屋を後に、同順位は graph.rooms の順の先勝ち。ただし天井を持たない部分指定の子（VOID 等）のセルは
 *     親の所属にしない（裁定: 描画の後勝ち＝天井なしと一致させる）。これにより階段下部屋（2a）は、先に並んだ
 *     STAIR ペア部屋・VOID に取られず、階段のセルに重なっても部屋が勝つ。
 *   - 階段: 天井を持つ部屋が無いセルだけ（stairHasCeiling）。
 * 吹抜け・階段吹抜け・屋外・未定義・屋根・昇降路・屋外階段・下階の階段は索引に載らない（選べない・天井面にならない）。
 */
import { RoomKind } from '@core';
import { ceilingRefreshCells } from './ceilingGrid.js';
import { withGraphReadScope } from '../graphReadScope.js';

/** 部屋が天井を持つか（唯一の述語）。屋内（kind === INTERIOR）かつ feature なし。 */
export function roomHasCeiling(room) {
  return room?.kind === RoomKind.INTERIOR && room.feature == null;
}

/** 階段が天井を持つか（唯一の述語）。変換元の部屋があれば屋内のときだけ、無ければ true。 */
export function stairHasCeiling(graph, stair) {
  const room = stair?.roomId ? graph.roomMap.get(stair.roomId) : null;
  return room ? room.kind === RoomKind.INTERIOR : true;
}

/**
 * 現在の階の「セルキー → 所属」の索引。選べないセルは載せない。
 * @returns {Map<string, {kind:'room'|'stair', id:string, rowId:string}>}
 */
export function buildCeilingCellOwners(graph) {
  if (!graph) return new Map();
  return withGraphReadScope(graph, () => ceilingCellOwnersOf(graph));
}

/**
 * buildCeilingCellOwners の本体（読み取りスコープで包まない版）。MobX の追跡下から呼ぶ描画（ceilingSurfacesOf）用——
 * スコープは内側の Reaction で依存を取るため、外側の observer が部屋・CL の変更に反応しなくなる。
 */
export function ceilingCellOwnersOf(graph) {
  const owners = new Map();
  if (!graph) return owners;
  // 天井を持たない部分指定の子（VOID 等）のセルは親に渡さない（天井なし）
  const excluded = new Set();
  for (const room of graph.rooms) {
    if (room.referenceRoomIds.size > 0 && !roomHasCeiling(room)) {
      for (const key of ceilingRefreshCells(room.cells, graph)) excluded.add(key);
    }
  }
  const rooms = graph.rooms.filter(roomHasCeiling);
  for (const partial of [true, false]) {
    for (const room of rooms) {
      if ((room.referenceRoomIds.size > 0) !== partial) continue;
      for (const key of ceilingRefreshCells(room.cells, graph)) {
        if (!partial && excluded.has(key)) continue;
        if (!owners.has(key)) owners.set(key, { kind: 'room', id: room.id, rowId: room.id });
      }
    }
  }
  // 階段: 天井を持つ部屋が無いセルだけ。同じセルを持つ階段は graph.stairs の順の先勝ち
  for (const stair of graph.stairs) {
    if (!stairHasCeiling(graph, stair)) continue;
    const rowId = stair.roomId ?? stair.id;
    for (const key of ceilingRefreshCells(stair.cells, graph)) {
      if (!owners.has(key)) owners.set(key, { kind: 'stair', id: stair.id, rowId });
    }
  }
  return owners;
}
