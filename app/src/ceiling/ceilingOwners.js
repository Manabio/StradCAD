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
 * 吹抜け（VOID・屋内）は、全高の壁（腰壁だけの壁は除く）で隔てられていない隣接部屋のうち面積最大の部屋の所属になる
 * （裁定 2026-10-17: 腰壁は天井を隔てない。assignVoidCellsToNeighbor）。候補が無い吹抜けは索引に載らない。
 * 屋外は feature なしで天井を外していない部屋だけ載る（屋外 S1）。未定義・屋根・昇降路・屋外階段・下階の階段は索引に載らない（選べない・天井面にならない）。
 * 階段吹抜け（STAIR_VOID）も索引には載らない（選べない）が、索引外の平らな天井面になる（ceilingSurfaces.js stairVoidFace）。
 */
import { RoomKind, RoomFeature } from '@core';
import { ceilingRefreshCells } from './ceilingGrid.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { kneeDropRecordsOnAxis, SPAN_OVERLAP_EPS } from '../finish/kneeDropWall.js';
import { withGraphReadScope } from '../graphReadScope.js';
import { exteriorCeilingEnabled } from './exteriorCeiling.js';

/** 部屋が天井を持つか（唯一の述語）。屋内（kind === INTERIOR）かつ feature なし、または天井を外していない屋外部屋（feature なし。exteriorCeiling.js）。 */
export function roomHasCeiling(room) {
  return (room?.kind === RoomKind.INTERIOR && room.feature == null) || exteriorCeilingEnabled(room);
}

/** 階段が天井を持つか（唯一の述語）。変換元の部屋があれば屋内のときだけ、無ければ true。 */
export function stairHasCeiling(graph, stair) {
  const room = stair?.roomId ? graph.roomMap.get(stair.roomId) : null;
  return room ? room.kind === RoomKind.INTERIOR : true;
}

// 共有辺・壁位置の一致許容(mm)。セル境界も壁の軸も CL 値なので丸め誤差だけを吸収する。
const EDGE_EPS_MM = 1;

/** 吹抜け（VOID）の屋内部屋か。天井を持たない（roomHasCeiling が偽）部屋のうち、隣の部屋の天井へ溶け込む対象。 */
function isCeilingVoidRoom(room) {
  return room?.kind === RoomKind.INTERIOR && room.feature === RoomFeature.VOID;
}

/**
 * 壁 1 本の、区間 [lo,hi]（省略＝壁の全長）と重なる範囲のうち全高の区間（腰壁だけの区間を除く）。[[s,e],…] を along 昇順で返す。
 * 腰壁（knee あり・drop なし）の区間は天井を隔てない。垂れ壁（drop）・指定なしの区間は全高。重なりが無い・座標が非有限なら []。
 * 共有辺の判定（edgeSeparatedByFullWall）と、平面の天井面の縁を止める壁の帯（plan/planSolids.js wallBandsOf）が共用する。
 */
export function wallFullHeightSpans(graph, w, lo = -Infinity, hi = Infinity) {
  if (![w.coord1, w.coord2].every(Number.isFinite)) return [];
  const a = Math.max(lo, Math.min(w.coord1, w.coord2)), b = Math.min(hi, Math.max(w.coord1, w.coord2));
  if (!(b - a > 1e-6)) return [];
  const out = [];
  const knees = kneeDropRecordsOnAxis(graph, w.axisCL, a, b)
    .filter(r => r.rec?.knee && !r.rec.drop)
    .map(r => [Math.max(a, r.lo), Math.min(b, r.hi)])
    .sort((p, q) => p[0] - q[0]);
  let cur = a;
  for (const [kLo, kHi] of knees) {
    if (kLo > cur) out.push([cur, kLo]);
    cur = Math.max(cur, kHi);
  }
  if (b > cur) out.push([cur, b]);
  return out;
}

/**
 * 共有辺（軸 isVertical・位置 coord・区間 [lo,hi]）を全高の壁（腰壁だけの壁は除く）が隔てているか。
 * 辺上の壁を、辺と重なる区間ごとに腰壁・垂れ壁のレコードで解決する（kneeDropRecordsOnAxis。1 本の壁が複数区間に分かれて
 * 指定が違ってもよい）。腰壁（knee あり・drop なし）の区間は天井を隔てない。垂れ壁（drop）・指定なしの区間は全高。
 * 全高の区間の和で辺を被覆し、壁の無いすき間がどれも SPAN_OVERLAP_EPS（隅の取り合いの許容差。壁は辺の両端を半壁厚ぶん残す）
 * 以下なら隔てる。全高の壁が 1 つも無ければ隔てない。
 */
function edgeSeparatedByFullWall(graph, isVertical, coord, lo, hi) {
  const full = [];
  for (const w of graph.walls) {
    if (w.isVertical !== isVertical || !w.axisCL) continue;
    if (Math.abs(w.axisCL.effectiveValue - coord) > EDGE_EPS_MM) continue;
    full.push(...wallFullHeightSpans(graph, w, lo, hi));
  }
  if (full.length === 0) return false;
  full.sort((p, q) => p[0] - q[0]);
  let reach = lo;
  for (const [s, e] of full) {
    if (s - reach > SPAN_OVERLAP_EPS) return false;
    reach = Math.max(reach, e);
  }
  return hi - reach <= SPAN_OVERLAP_EPS;
}

/**
 * 吹抜け（VOID・屋内）のセルを、全高の壁で隔てられていない隣接部屋のうち面積最大の部屋の所属にする（裁定 2026-10-17）。
 * 腰壁で囲まれた吹抜けは天井を隔てない。VOID 部屋は 1 単位（複数セルでも同じ部屋へ）。候補が無ければ索引外のまま。
 * 面積＝pass1 の所属セルの矩形面積の和。同面積は graph.rooms の順の先勝ち。owners を直接更新する。
 */
function assignVoidCellsToNeighbor(graph, owners) {
  const voidRooms = graph.rooms.filter(isCeilingVoidRoom);
  if (voidRooms.length === 0) return;
  const owned = []; // [{owner, b}]（pass1 の部屋所属のセルだけ）
  const areaByRoom = new Map();
  for (const [key, owner] of owners) {
    if (owner.kind !== 'room') continue;
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    const nb = { x1: Math.min(b.x1, b.x2), x2: Math.max(b.x1, b.x2), y1: Math.min(b.y1, b.y2), y2: Math.max(b.y1, b.y2) };
    owned.push({ owner, b: nb });
    areaByRoom.set(owner.id, (areaByRoom.get(owner.id) ?? 0) + (nb.x2 - nb.x1) * (nb.y2 - nb.y1));
  }
  for (const voidRoom of voidRooms) {
    const keys = [...ceilingRefreshCells(voidRoom.cells, graph)].filter(k => !owners.has(k));
    const candidates = new Set();
    for (const key of keys) {
      const vb0 = cellBoundsFromKey(key, graph);
      if (!vb0) continue;
      const vb = { x1: Math.min(vb0.x1, vb0.x2), x2: Math.max(vb0.x1, vb0.x2), y1: Math.min(vb0.y1, vb0.y2), y2: Math.max(vb0.y1, vb0.y2) };
      for (const { owner, b } of owned) {
        if (candidates.has(owner.id)) continue;
        const oy = Math.min(vb.y2, b.y2) - Math.max(vb.y1, b.y1);
        const ox = Math.min(vb.x2, b.x2) - Math.max(vb.x1, b.x1);
        let sep = null; // 共有辺があれば全高の壁で隔てられているか
        if (oy > EDGE_EPS_MM) {
          const lo = Math.max(vb.y1, b.y1), hi = Math.min(vb.y2, b.y2);
          for (const x of [vb.x1, vb.x2]) {
            if (Math.abs(x - b.x1) <= EDGE_EPS_MM || Math.abs(x - b.x2) <= EDGE_EPS_MM) {
              sep = edgeSeparatedByFullWall(graph, true, x, lo, hi);
              break;
            }
          }
        }
        if (sep == null && ox > EDGE_EPS_MM) {
          const lo = Math.max(vb.x1, b.x1), hi = Math.min(vb.x2, b.x2);
          for (const y of [vb.y1, vb.y2]) {
            if (Math.abs(y - b.y1) <= EDGE_EPS_MM || Math.abs(y - b.y2) <= EDGE_EPS_MM) {
              sep = edgeSeparatedByFullWall(graph, false, y, lo, hi);
              break;
            }
          }
        }
        if (sep === false) candidates.add(owner.id);
      }
    }
    let best = null, bestArea = 0;
    for (const room of graph.rooms) { // 同面積は graph.rooms の順の先勝ち
      if (!candidates.has(room.id)) continue;
      const area = areaByRoom.get(room.id) ?? 0;
      if (area > bestArea) { best = room; bestArea = area; }
    }
    if (!best) continue;
    for (const key of keys) owners.set(key, { kind: 'room', id: best.id, rowId: best.id });
  }
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
  assignVoidCellsToNeighbor(graph, owners);
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
