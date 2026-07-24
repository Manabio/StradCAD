// ================================================================
// floorplanモードでのCL追加・削除・延長・短縮・移動を経てfinishモードへ
// 再突入した際、各Room.cells（＝前回脱出時点の状態）を現在のCLトポロジーと
// 突き合わせて再解釈する。
//
// 判定は旧セルの内部代表点が属する現在の「連結領域」（regionCellsAt。
// 短縮でL字化していれば構成セル群）単位で行う:
//   0辺喪失               : 何もしない（既存 refreshCells の細分化追従に任せる）
//   関与する部屋が1つのみ   : 部屋の同一性は変えず、セルを現在の分割に置き換えるだけ
//                            （内部間仕切りの消失・無名領域への拡張はこちらに含まれる）
//   2部屋にまたがり1辺喪失 : セル数が少ない方の部屋が多い方の部屋の部分指定になる
//                            （両方の cells に新セルを追加し、少ない方の referenceRoomIds に追加）
//   2部屋にまたがり2辺以上喪失: セル数が少ない方から旧部屋名を削除し、多い方へ完全吸収する
//                            （少ない方の cells が空になれば部屋自体を削除）
// ================================================================

import { Room, RoomFeature } from '@core';
import { lostSides, cellInteriorPoint, regionCellsAt, refreshCells } from './gridCells.js';

function isEarlierInOrder(graph, idA, idB) {
  const order = graph.roomOrder;
  return order.indexOf(idA) < order.indexOf(idB);
}

/**
 * @param {import('@core').FloorGraph} graph
 */
export function reinterpretRoomsOnEntry(graph) {
  const rooms = graph.rooms;
  if (rooms.length === 0) return;

  // 1. 影響を受けるセルを収集し、現在の分割上での連結領域（正準ID）でグルーピングする
  const groups = new Map(); // regionId -> { cells, entries: [{ room, oldKey, lostCount }] }
  for (const room of rooms) {
    // 階段Room（feature===STAIR）は再解釈しない。フットプリントは階段設置時に確定済みで、
    // 吸収/削除されると Stair.roomId が孤児化するため（フェーズ2以前は階段はRoomでなく対象外だった＝従来挙動を維持）。
    // 階段吹抜け（STAIR_VOID）も同様に対象外（自動管理 Room。同期側が footprint を管理する）。
    // 未定義の部屋（UNDEFINED）も対象外（外壁線維持のための残置セル。命名/削除でのみ変化する）。
    if (room.feature === RoomFeature.STAIR || room.feature === RoomFeature.STAIR_VOID
      || room.feature === RoomFeature.UNDEFINED) continue;
    for (const oldKey of room.cells) {
      const lost = lostSides(oldKey, graph);
      if (lost.length === 0) continue;

      const pt = cellInteriorPoint(oldKey, graph);
      if (!pt) continue; // 退化ケース（対辺2本同時消失）→ 復元不能なので今回は現状維持

      const region = regionCellsAt(pt.x, pt.y, graph);
      if (region.length === 0) continue;

      const regionId = region.map(c => c.key).sort().join('|');
      if (!groups.has(regionId)) groups.set(regionId, { cells: region, entries: [] });
      groups.get(regionId).entries.push({ room, oldKey, lostCount: lost.length });
    }
  }

  // 2. グループごとに解決
  for (const { cells, entries } of groups.values()) {
    const roomIds = new Set(entries.map(e => e.room.id));

    if (roomIds.size <= 1) {
      const room = entries[0].room;
      for (const e of entries) room.removeCell(e.oldKey);
      for (const c of cells) room.addCell(c.key);
      continue;
    }

    // セル数最多の部屋を親（dominant）とする。同数なら仕上げ表の並び順が先の方。
    let dominant = entries[0].room;
    for (const e of entries) {
      const r = e.room;
      if (r.id === dominant.id) continue;
      if (r.cells.size > dominant.cells.size ||
          (r.cells.size === dominant.cells.size && isEarlierInOrder(graph, r.id, dominant.id))) {
        dominant = r;
      }
    }

    for (const c of cells) dominant.addCell(c.key);
    for (const e of entries) {
      e.room.removeCell(e.oldKey);
      if (e.room.id === dominant.id) continue;

      if (e.lostCount === 1) {
        // 1辺喪失 → 部分指定化（子の同一性・仕上げ情報は維持したまま親の内訳になる）
        for (const c of cells) e.room.addCell(c.key);
        e.room.referenceRoomIds.add(dominant.id);
      } else if (e.room.cells.size === 0) {
        // 2辺以上喪失 → 旧部屋名を削除し、親へ完全吸収
        graph.removeRoom(e.room.id);
      }
    }
  }
}

function cellSetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * ペア Room を持たない Stair（旧データ・上階自動設置分）へ feature=STAIR の Room を補完し、
 * 相互リンク（Stair.roomId）を回復する（不変条件は `.claude/data-model.md`。Room が無いと
 * 外壁生成・境界分類が階段エリアを「無名屋外」とみなし、隣接部屋の周囲に誤った外壁ができる）。
 * footprint が一致する階段吹抜け（STAIR_VOID。旧最上階の自動指定分）があれば、新規作成せず
 * その Room をペア Room へ転用する（階追加による中間階への移行。セル集合と Room 同一性を保つ）。
 * フットプリントが既存 Room のセルと重なる場合は補完しない（その領域は既に「屋内」で
 * 症状が出ず、セルの二重割当を避けるため）。
 * @param {import('@core').FloorGraph} graph
 * @returns {{stair, room, prevRoomId}[]} 補完した組（undo 用。呼び出し側で roomId を戻す。
 *   room.feature の巻き戻しは rooms スナップショット側が担う）
 */
export function ensureStairRooms(graph) {
  const changes = [];
  const orphans = graph.stairs.filter(s => !s.roomId || !graph.roomMap.has(s.roomId));
  if (orphans.length === 0) return changes;

  const assigned = new Set();
  for (const room of graph.rooms) {
    for (const key of refreshCells(room.cells, graph)) assigned.add(key);
  }
  for (const stair of orphans) {
    const cells = refreshCells(stair.cells, graph);
    if (cells.size === 0) continue;

    // 旧最上階の階段吹抜けが footprint と一致すればペア Room へ転用
    const voidRoom = graph.rooms.find(r =>
      r.feature === RoomFeature.STAIR_VOID && cellSetsEqual(refreshCells(r.cells, graph), cells));
    if (voidRoom) {
      voidRoom.setFeature(RoomFeature.STAIR);
      const prevRoomId = stair.roomId;
      stair.setField('roomId', voidRoom.id);
      changes.push({ stair, room: voidRoom, prevRoomId });
      continue;
    }

    if ([...cells].some(key => assigned.has(key))) continue;

    const room = graph.addRoom(cells);
    room.setFeature(RoomFeature.STAIR);
    const prevRoomId = stair.roomId;
    stair.setField('roomId', room.id);
    for (const key of cells) assigned.add(key);
    changes.push({ stair, room, prevRoomId });
  }
  return changes;
}

// ----------------------------------------------------------------
// undo/redo 用スナップショット（reinterpretRoomsOnEntry は部屋の削除も
// 行うため、単なる cells/referenceRoomIds の差分ではなく Room 一覧全体を
// 対象にする。plain object での往復に留め、FlatBuffers化はしない
// —— snapshotWall/snapshotEdges と同じ「単発操作の巻き戻し」用途のため）
// ----------------------------------------------------------------

export const FINISH_FIELDS = [
  'floorMaterial', 'baseboardMaterial', 'baseboardHeight', 'dadoMaterial',
  'dadoHeight', 'ceilingMaterial', 'cornice', 'note',
];

/** graph.rooms の全フィールドをスナップショットする。 */
export function snapshotRoomsState(graph) {
  return {
    roomOrder: [...graph.roomOrder],
    rooms: graph.roomOrder.filter(id => graph.roomMap.has(id)).map(id => {
      const r = graph.roomMap.get(id);
      return {
        id: r.id, name: r.name, cells: [...r.cells], referenceRoomIds: [...r.referenceRoomIds],
        kind: r.kind, feature: r.feature, templateKey: r.templateKey, floorLevel: r.floorLevel,
        namePosition: r.namePosition ? { x: r.namePosition.x, y: r.namePosition.y } : null,
        generatedWallIds: [...r.generatedWallIds],
        customOverrides: [...r.customOverrides],
        finish: Object.fromEntries(FINISH_FIELDS.map(f => [f, r.finish[f]])),
      };
    }),
  };
}

/** snapshotRoomsState の結果から graph.rooms を復元する（undo/redo 用）。 */
export function restoreRoomsState(graph, snap) {
  graph.roomMap.clear();
  graph.roomOrder.clear();
  for (const d of snap.rooms) {
    const room = new Room(d.id, d.name, new Set(d.cells), new Set(d.referenceRoomIds), d.kind, d.templateKey, d.feature ?? null);
    room.generatedWallIds = new Set(d.generatedWallIds);
    if (d.floorLevel != null) room.setFloorLevel(d.floorLevel);
    if (d.namePosition) room.setNamePosition(d.namePosition.x, d.namePosition.y);
    for (const [k, v] of d.customOverrides) room.customOverrides.set(k, v);
    for (const [k, v] of Object.entries(d.finish)) if (v) room.finish.setField(k, v);
    graph.roomMap.set(room.id, room);
  }
  graph.roomOrder.replace(snap.roomOrder.filter(id => graph.roomMap.has(id)));
}
