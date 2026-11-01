// ================================================================
// 仕上げモードの部屋カード「部分詳細」欄の判断（部分詳細図 S8a）。配線は FinishTable.jsx、判断はここ（純）。
//   - roomDetailRefSelects     select 2 つ（床と壁／壁と天井）の見出し・現在値・選択肢
//   - roomDetailRefsAfterSelect 選択後の detailRefs（空の写像は null。元は変えない）
// 選択肢の絞り込みは S5 と同じ catalogMaintenance.detailFigureOptionsFor（junction・section・subject 一致）。
// 先頭は「なし」（キー無し＝割当てなし）。
// ================================================================

import { ROOM_DETAIL_SLOTS } from '../core/constants.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { composeCatalog } from '../catalog/catalogRegistry.js';
import { detailFigureOptionsFor } from '../catalog/catalogMaintenance.js';
import { withDetailRef } from '../core/detailRefs.js';
import { detailSlotLabel, ROOM_DETAIL_REF_TEXT } from '../error.js';

/** 三層合成後の詳細図エントリ（本体は空＝builtin に [] を渡す。openings/openingCatalog.js detailFigureMap と同じ前提）。 */
function detailFigureEntries() {
  return [...composeCatalog(CatalogKind.DETAIL_FIGURE, []).values()];
}

/**
 * @param {{detailRefs?: object|null}} room
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 * @returns {Array<{slot:string, label:string, value:string, options:Array<{value:string,label:string}>}>}
 */
export function roomDetailRefSelects(room, figureList = detailFigureEntries()) {
  return ROOM_DETAIL_SLOTS.map(slot => {
    const key = room?.detailRefs?.[slot];
    const value = typeof key === 'string' ? key : '';
    return {
      slot,
      label: detailSlotLabel(slot),
      value,
      options: [{ value: '', label: ROOM_DETAIL_REF_TEXT.none }, ...detailFigureOptionsFor(slot, figureList, value)],
    };
  });
}

/**
 * slot を key にした（'' なら外した）次の detailRefs。ROOM_DETAIL_SLOTS 以外の slot は変えない。元は変えない。
 * @returns {Readonly<Record<string,string>>|null}
 */
export function roomDetailRefsAfterSelect(room, slot, key) {
  if (!ROOM_DETAIL_SLOTS.includes(slot)) return room?.detailRefs ?? null;
  return withDetailRef(room?.detailRefs, slot, key);
}
