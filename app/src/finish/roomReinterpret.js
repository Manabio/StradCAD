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
import { lostSides, cellInteriorPoint, regionCellsAt } from './gridCells.js';

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
    if (room.feature === RoomFeature.STAIR) continue;
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

// ----------------------------------------------------------------
// undo/redo 用スナップショット（reinterpretRoomsOnEntry は部屋の削除も
// 行うため、単なる cells/referenceRoomIds の差分ではなく Room 一覧全体を
// 対象にする。plain object での往復に留め、FlatBuffers化はしない
// —— snapshotWall/snapshotEdges と同じ「単発操作の巻き戻し」用途のため）
// ----------------------------------------------------------------

const FINISH_FIELDS = [
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
