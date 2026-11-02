// ================================================================
// 天伏パネルの区画欄「天井の段差」（CeilingZone.detailRefs の ceilingStep。部分詳細図 S8b-4a）の判断（純モジュール）。
// 配線は CeilingPanel.jsx（CeilingZoneFields）、判断はここ。
//   ceilingStepSelects         区画の select（見出し・現在値・選択肢）。選択肢は分類（part/section/ceiling）一致の図だけ
//   isCeilingStepEditable      割当てを編集できる区画か（平面だけ。傾斜・円弧・ドームは天井の段差が定義できない＝disabled）
//   zonesAfterCeilingStepSelect slot を key にした（'' なら外した）次の区画配列。他の項目・他の区画は変えない
// ================================================================

import { CeilingZone, CeilingShape } from '@core';
import { CEILING_ZONE_DETAIL_SLOTS } from '../core/constants.js';
import { withDetailRef } from '../core/detailRefs.js';
import { detailRefSelectsFor } from '../finish/roomDetailRefsEdit.js';
import { normalizeZones } from './ceilingZones.js';

/**
 * @param {{detailRefs?: object|null}} zone
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 */
export function ceilingStepSelects(zone, figureList) {
  return detailRefSelectsFor(CEILING_ZONE_DETAIL_SLOTS, zone?.detailRefs, figureList);
}

/** 割当てを編集できる区画か（平面だけ）。 */
export const isCeilingStepEditable = zone => zone?.shape === CeilingShape.FLAT;

/**
 * 区画 zoneId の slot を key にした（'' なら外した）後の、部屋の区画配列。id・セル・形状・高さは保つ。
 * 未知の zoneId・CEILING_ZONE_DETAIL_SLOTS 以外の slot・平面でない区画は、正規化しただけの現在の区画配列（変更なし）。
 * @param {object} graph
 * @param {import('@core').Room|null} room
 * @param {string} zoneId
 * @param {string} slot
 * @param {string|null} key
 * @returns {CeilingZone[]}
 */
export function zonesAfterCeilingStepSelect(graph, room, zoneId, slot, key) {
  if (!room) return [];
  const zones = normalizeZones(graph, room);
  if (!CEILING_ZONE_DETAIL_SLOTS.includes(slot)) return zones;
  return zones.map(z => (z.id === zoneId && isCeilingStepEditable(z)
    ? new CeilingZone({ ...z.toData(), detailRefs: withDetailRef(z.detailRefs, slot, key) })
    : z));
}
