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
import { lostSides, cellInteriorPoint, regionCellsAt, refreshCells, cellBoundsFromKey } from './gridCells.js';

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

/**
 * 部分指定の面積が親の残余面積（親セル − 全部分指定セル）を上回ったら親子を入れ替える。
 * 部屋の主従は「支配的な方（面積の大きい方）が親」であるべきで、部分指定が残余を
 * 上回ったまま放置すると、外周壁の帰属・天井高の継承・展開図の帯（いずれも親基準）が
 * 小さい方の部屋にぶら下がり続けてしまう。
 * なお部屋名ラベルの重なり防止そのものは配置ルール側が担う（roomLabel.js の
 * roomNameAnchor: 親の自動配置は部分指定に奪われていないセルから選ぶ）。
 *
 * 入れ替えの内容（面積最大の部分指定が残余より大きい場合のみ。同値は現状維持）:
 *   勝った子: 親の全セルを引き継いで参照元（referenceRoomIds 空）になる
 *   旧親    : 残余セルだけの部分指定へ降格し、勝った子を参照する
 *   他の子  : 参照先を旧親から勝った子へ付け替える
 *   生成壁  : 外周壁は親が担う（glossary「部分指定」）ため帰属を入れ替える
 *   表示順  : roomOrder 上の位置も入れ替える（部分指定は親の後に並ぶ挿入規則を保つ）
 * 各セルの実効床レベルは「そのセルを持つ部分指定 ＞ 親」の優先で解決されるため、
 * セル集合と参照方向を同時に入れ替えれば見た目・段差の意味は変わらない。
 * @param {import('@core').FloorGraph} graph
 */
export function normalizePartialDominance(graph) {
  const rooms = graph.rooms;
  const parents = rooms.filter(r => r.referenceRoomIds.size === 0 && r.feature === null);
  for (const parent of parents) {
    const children = rooms.filter(r => r.referenceRoomIds.has(parent.id));
    if (children.length === 0) continue;

    const areaOf = (cells) => {
      let area = 0;
      for (const key of cells) {
        const b = cellBoundsFromKey(key, graph);
        if (b) area += (b.x2 - b.x1) * (b.y2 - b.y1);
      }
      return area;
    };

    const fullCells = refreshCells(parent.cells, graph);
    const childCells = new Map(children.map(c => [c.id, refreshCells(c.cells, graph)]));
    const remaining = new Set(fullCells);
    for (const cells of childCells.values()) for (const key of cells) remaining.delete(key);
    if (remaining.size === 0) continue; // 退化ケース（部分指定が親全域を覆う）は現状維持

    // 入れ替え候補は通常の部分指定（feature なし・参照先が親のみ）に限る。
    // 面積同値なら先勝ち（roomOrder 順）＝現親優先で入れ替えない。
    let winner = null, winnerArea = areaOf(remaining);
    for (const c of children) {
      if (c.feature !== null || c.referenceRoomIds.size !== 1) continue;
      const a = areaOf(childCells.get(c.id));
      if (a > winnerArea) { winner = c; winnerArea = a; }
    }
    if (!winner) continue;

    // 勝った子は親の全セルを引き継ぐ。自前の生キーも保持する——refreshCells 由来の
    // 集合だけに置き換えると、親に含まれないセル（reinterpretRoomsOnEntry の
    // 1辺喪失経路では 親⊉子 がありうる）や解決不能キーを黙って失う。
    // 粒度の違う重複キーは使用側の refreshCells が正規化する。
    winner.setCells(new Set([...winner.cells, ...fullCells]));
    winner.referenceRoomIds.delete(parent.id);
    // 旧親は残余セルの部分指定へ降格。解決不能な生キー（CL削除の退化ケース）は
    // reinterpretRoomsOnEntry の現状維持方針に合わせて捨てずに残す。
    const unresolved = [...parent.cells].filter(key => !cellBoundsFromKey(key, graph));
    parent.setCells(new Set([...remaining, ...unresolved]));
    parent.referenceRoomIds.add(winner.id);
    for (const c of children) {
      if (c.id === winner.id) continue;
      c.referenceRoomIds.delete(parent.id);
      c.referenceRoomIds.add(winner.id);
    }

    const demotedWalls = new Set(winner.generatedWallIds);
    winner.generatedWallIds = new Set(parent.generatedWallIds);
    parent.generatedWallIds = demotedWalls;

    const order = [...graph.roomOrder];
    const pi = order.indexOf(parent.id), wi = order.indexOf(winner.id);
    if (pi >= 0 && wi >= 0) {
      order[pi] = winner.id;
      order[wi] = parent.id;
      graph.reorderRooms(order);
    }

    // 明示ラベル位置が新しいセル集合の外に出た場合は自動配置へ戻す
    for (const room of [parent, winner]) {
      const p = room.namePosition;
      if (!p) continue;
      const inside = [...room.cells].some(key => {
        const b = cellBoundsFromKey(key, graph);
        return b && p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2;
      });
      if (!inside) room.namePosition = null;
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
