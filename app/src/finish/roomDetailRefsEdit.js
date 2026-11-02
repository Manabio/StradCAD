// ================================================================
// 部分詳細図の割当て欄（select）の判断（部分詳細図 S8a・S8b-1）。配線は FinishTable.jsx（部屋カード）と
// ui/KneeDropWallDialog.jsx（腰壁・垂れ壁）、判断はここ（純）。
//   - detailRefSelectsFor       slot の並びの select（見出し・現在値・選択肢）。slot と refs は呼び出し側が決める
//   - detailRefsAfterSelectFor  slot を key にした（'' なら外した）次の detailRefs。slots 以外の slot は変えない
//   - roomDetailRefSelects / roomDetailRefsAfterSelect  部屋カード（床と壁／壁と天井）用のラッパ
// 選択肢の絞り込みは S5 と同じ catalogMaintenance.detailFigureOptionsFor（分類・view・subject 一致）。
// 先頭は「なし」（キー無し＝割当てなし）。
// ================================================================

import { ROOM_DETAIL_SLOTS } from '../core/constants.js';
import { detailFigureCatalog } from '../openings/openingCatalog.js';
import { detailFigureOptionsFor } from '../catalog/catalogMaintenance.js';
import { withDetailRef } from '../core/detailRefs.js';
import { detailSlotLabel, ROOM_DETAIL_REF_TEXT } from '../error.js';

/** 三層合成後の詳細図エントリ（組込み＋ライブラリ＋同梱。openings/openingCatalog.js detailFigureCatalog）。 */
function detailFigureEntries() {
  return [...detailFigureCatalog().values()];
}

/**
 * @param {string[]} slots select を出す slot の並び
 * @param {object|null|undefined} refs 現在の detailRefs（{[slot]: 図のキー}）
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 * @param {{labelOf?: (slot:string)=>string}} [opts] 見出しの取り方（省略時は slot の既定ラベル）
 * @returns {Array<{slot:string, label:string, value:string, options:Array<{value:string,label:string}>}>}
 */
export function detailRefSelectsFor(slots, refs, figureList = detailFigureEntries(), { labelOf = detailSlotLabel } = {}) {
  return slots.map(slot => {
    const key = refs?.[slot];
    const value = typeof key === 'string' ? key : '';
    return {
      slot,
      label: labelOf(slot),
      value,
      options: [{ value: '', label: ROOM_DETAIL_REF_TEXT.none }, ...detailFigureOptionsFor(slot, figureList, value)],
    };
  });
}

/**
 * slot を key にした（'' なら外した）次の detailRefs。slots に無い slot は変えない。元は変えない。
 * @returns {Readonly<Record<string,string>>|null}
 */
export function detailRefsAfterSelectFor(slots, refs, slot, key) {
  if (!slots.includes(slot)) return refs ?? null;
  return withDetailRef(refs, slot, key);
}

/**
 * @param {{detailRefs?: object|null}} room
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 */
export function roomDetailRefSelects(room, figureList = detailFigureEntries()) {
  return detailRefSelectsFor(ROOM_DETAIL_SLOTS, room?.detailRefs, figureList);
}

/**
 * slot を key にした（'' なら外した）次の detailRefs。ROOM_DETAIL_SLOTS 以外の slot は変えない。元は変えない。
 * @returns {Readonly<Record<string,string>>|null}
 */
export function roomDetailRefsAfterSelect(room, slot, key) {
  return detailRefsAfterSelectFor(ROOM_DETAIL_SLOTS, room?.detailRefs, slot, key);
}
