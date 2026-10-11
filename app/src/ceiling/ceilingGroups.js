/**
 * 天伏の天井セルの「群」（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 選択の単位（S12b。ユーザー指示 2026-10-11「親部屋天井セルはユーザー指定セルの排他セル」「部屋内クリックで関連セルが一緒に選択」）。
 * 所有されているセル（所属索引 ceilingOwners.js）は、ちょうど1つの群に属する:
 *   - 区画の群 'zone'  … 部屋 P の天井区画 Z のセル。所属索引で owner.rowId === P.id のセルのうち、P.ceilingZones を順に
 *                         ceilingRefreshCells で展開し先勝ちで採る（ceilingSurfaces.js の区画の面と同じ採り方）。
 *   - 部屋の残り 'room' … owner.kind==='room' && owner.id===R.id のセルから、R の区画のセルを除いたもの（親・部分指定の子とも）。
 *   - 階段の残り 'stair' … owner.kind==='stair' && owner.id===S.id のセルから、対の部屋の区画のセルを除いたもの。
 * 不変条件: ceilingSurfacesOf の各面のキー集合は対応する群のセルと一致（区画の面⇔zone 群、残りの面⇔room 群）。
 * ただし STAIR_VOID の面（索引外。ceilingSurfaces.js stairVoidFace）は群を持たないので除く。
 * 読み取りスコープで包まない（MobX の追跡下からも呼べるように。必要なら呼び側が withGraphReadScope で包む）。
 */
import { ceilingRefreshCells } from './ceilingGrid.js';

/** 群 id（S12c のパネルのノード id と共用）。 */
export const roomGroupId = roomId => `room:${roomId}`;
export const zoneGroupId = (roomId, zoneId) => `zone:${roomId}#${zoneId}`;
export const stairGroupId = stairId => `stair:${stairId}`;

/**
 * @typedef {{kind: 'room'|'zone'|'stair', roomId: string|null, zoneId?: string, stairId?: string,
 *            owner: {kind: 'room'|'stair', id: string, rowId: string}, cells: Set<string>}} CeilingGroup
 */

/**
 * 所属索引から群を作る。graph が null・owners が空なら空の結果。
 * @param {object} graph
 * @param {Map<string, {kind: 'room'|'stair', id: string, rowId: string}>} owners  ceilingCellOwnersOf／buildCeilingCellOwners の結果
 * @returns {{groupOfCell: Map<string, string>, groups: Map<string, CeilingGroup>}}
 */
export function ceilingGroupsOf(graph, owners) {
  const groupOfCell = new Map();
  const groups = new Map();
  if (!graph || !owners || owners.size === 0) return { groupOfCell, groups };

  // 区画の群（部屋ごとに区画の配列順・先勝ち）
  for (const room of graph.rooms) {
    if (room.ceilingZones.length === 0) continue;
    const taken = new Set();
    for (const zone of room.ceilingZones) {
      const cells = new Set();
      let firstOwner = null;
      for (const key of ceilingRefreshCells(new Set(zone.cells), graph)) {
        const owner = owners.get(key);
        if (taken.has(key) || !owner || owner.rowId !== room.id) continue;
        taken.add(key);
        cells.add(key);
        firstOwner ??= owner;
      }
      if (cells.size === 0) continue;
      const id = zoneGroupId(room.id, zone.id);
      groups.set(id, { kind: 'zone', roomId: room.id, zoneId: zone.id, owner: firstOwner, cells });
      for (const key of cells) groupOfCell.set(key, id);
    }
  }

  // 残り（区画に入らなかった所有セル）。部屋所属→部屋の残り、階段所属→階段の残り
  for (const [key, owner] of owners) {
    if (groupOfCell.has(key)) continue;
    let id;
    if (owner.kind === 'room') {
      id = roomGroupId(owner.id);
      if (!groups.has(id)) groups.set(id, { kind: 'room', roomId: owner.id, owner, cells: new Set() });
    } else {
      id = stairGroupId(owner.id);
      if (!groups.has(id)) {
        const stair = graph.stairMap?.get(owner.id);
        groups.set(id, { kind: 'stair', roomId: stair?.roomId ?? null, stairId: owner.id, owner, cells: new Set() });
      }
    }
    groups.get(id).cells.add(key);
    groupOfCell.set(key, id);
  }
  return { groupOfCell, groups };
}
