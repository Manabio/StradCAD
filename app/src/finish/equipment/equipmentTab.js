/**
 * 機械器具タブ（EquipmentTab.jsx）の行データの組み立て（純関数）。
 */
import { isShaftFeature } from '@core';
import { refreshCells } from '../gridCells.js';

const UNREGISTERED_SYMBOL = '昇降路（未登録）';

/**
 * 機械器具タブに出す行データを組み立てる。登録済み（器具行）を no 昇順、その後ろに
 * 未登録（行を持たない旧データの昇降路Room。roomOrder順＝rooms が既に roomOrder 順であること
 * が前提。graph.rooms getter と同じ規約）を並べる。
 * @param {{ rows: object[], rooms: object[], symbols: Map<string,string>, spanLabel: string }} args
 *   rows=graph.equipmentRows・rooms=graph.rooms（roomOrder順）・symbols=equipmentSymbols(catalog)の結果・
 *   spanLabel=設置階〜最上階の表示文字列（ステップ3は現在の階名1つ）。
 * @returns {Array<{ id, kind:'row'|'unregistered', symbol, category, usage, spanLabel, roomId }>}
 */
export function buildEquipmentTabEntries({ rows, rooms, symbols, spanLabel }) {
  const registered = [...(rows ?? [])]
    .sort((a, b) => (a.no - b.no) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(r => ({
      id: r.id, kind: 'row', symbol: symbols?.get(r.id) ?? '', category: r.category, usage: r.usage,
      spanLabel, roomId: r.roomId,
    }));

  const registeredRoomIds = new Set((rows ?? []).map(r => r.roomId).filter(Boolean));
  const unregistered = (rooms ?? [])
    .filter(r => isShaftFeature(r.feature) && !registeredRoomIds.has(r.id))
    .map(r => ({
      id: r.id, kind: 'unregistered', symbol: UNREGISTERED_SYMBOL, category: null, usage: null,
      spanLabel, roomId: r.id,
    }));

  return [...registered, ...unregistered];
}

/**
 * 選択中の昇降機器具（selectedEquipmentId）の平面ハイライト用セルキー集合。
 * 器具行のidなら refreshCells(row.cellKeys)、未登録Roomのidなら refreshCells(room.cells)。
 * どちらでもなければ空集合（選択なし・削除済み等）。
 * @param {object} graph
 * @param {string|null} selectedId
 * @returns {Set<string>}
 */
export function equipmentHighlightKeys(graph, selectedId) {
  if (!selectedId) return new Set();
  const row = graph.equipmentRows.find(r => r.id === selectedId);
  if (row) return refreshCells(row.cellKeys, graph);
  const room = graph.roomMap.get(selectedId);
  if (room && isShaftFeature(room.feature)) return refreshCells(room.cells, graph);
  return new Set();
}
