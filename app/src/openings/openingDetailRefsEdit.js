// ================================================================
// 建具エディタ（OpeningEditor.jsx）の「部分詳細図の上書き」欄の判断（S6a）。配線は .jsx、判断はここ（純）。
//   - openingDetailRefSelects  select 2 つ（方立／上枠）の見出し・現在値・選択肢
//   - detailRefsAfterSelect    選択後の detailRefs（空の写像は null。元は変えない）
//   - detailDimensionsToCopy   R16「図の寸法を建具へ」で写す値（無ければ null＝ボタンは無効）
// 解決順は resolveDetailFigure（建具個別の detailRefs ＞ 記号の detailFigures）と同じ。
// 6a の select は jamb・head だけ（sill 等はデータとして受けるが UI を出さない。R20）。
// ================================================================

import { DetailSlot, DetailParam } from '../core/constants.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { composeCatalog } from '../catalog/catalogRegistry.js';
import {
  detailFigureOptionsFor, FIXTURE_SYMBOL_DETAIL_SLOT_TEXT, OPENING_DETAIL_REF_TEXT,
} from '../catalog/catalogMaintenance.js';
import { withDetailRef } from '../core/detailRefs.js';
import { paramMmOf } from '../detail/detailPlacement.js';
import { resolveDetailFigure } from './openingDetailFit.js';
import { detailFigureRefsFor, subTypeDetailFigureRefsFor } from './openingCatalog.js';
import { fixtureSymbolOf } from './openingNumbering.js';

/** 三方枠（FRAME_ONLY）だけに出す slot（方立・上枠）。 */
export const FRAME_ONLY_DETAIL_REF_SLOTS = Object.freeze([DetailSlot.JAMB, DetailSlot.HEAD]);

/** select を出す slot（表示順）。姿図（S6b）は全機構の建具に出し、方立・上枠は三方枠だけ。 */
export const OPENING_DETAIL_REF_SLOTS = Object.freeze([...FRAME_ONLY_DETAIL_REF_SLOTS, DetailSlot.FIGURE]);

/** R16: 図の param → 写し先の Opening の項目。 */
const PARAM_TO_OPENING_FIELD = Object.freeze({
  [DetailParam.FRAME_FACE_WIDTH]: 'frameFaceWidth',
  [DetailParam.FRAME_PROJECTION]: 'frameProjection',
});

/** 三層合成後の詳細図エントリ（本体は空＝builtin に [] を渡す。openingCatalog.js detailFigureMap と同じ前提）。 */
function detailFigureEntries() {
  return [...composeCatalog(CatalogKind.DETAIL_FIGURE, []).values()];
}

/**
 * @param {{detailRefs?: object|null}} opening
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 * @param {{frameOnly?: boolean}} [opts] frameOnly＝三方枠か（既定 true。false なら方立・上枠の select を出さず姿図だけ）
 * @returns {Array<{slot:string, label:string, value:string, options:Array<{value:string,label:string}>}>}
 *   value＝建具個別の上書きのキー（未上書きは ''）。options の先頭は未上書き（記号〔姿図は建具種別〕の設定を使う）。
 */
export function openingDetailRefSelects(opening, figureList = detailFigureEntries(), { frameOnly = true } = {}) {
  return OPENING_DETAIL_REF_SLOTS.filter(slot => frameOnly || !FRAME_ONLY_DETAIL_REF_SLOTS.includes(slot)).map(slot => {
    const key = opening?.detailRefs?.[slot];
    const value = typeof key === 'string' ? key : '';
    const useBase = slot === DetailSlot.FIGURE ? OPENING_DETAIL_REF_TEXT.useSubType : OPENING_DETAIL_REF_TEXT.useSymbol;
    return {
      slot,
      label: FIXTURE_SYMBOL_DETAIL_SLOT_TEXT[slot].label,
      value,
      options: [{ value: '', label: useBase }, ...detailFigureOptionsFor(slot, figureList, value)],
    };
  });
}

/**
 * slot の選択（value '' ＝未上書き）を反映した次の detailRefs（凍結した正規形か null）。
 * 選んだキーが記号の割当て（detailFigures）の同じ slot のキーと一致するときは上書きとして持たず外す
 * （既定へ畳むのはキーが一致するときだけ。射影した値では比べない）。
 */
export function detailRefsAfterSelect(opening, slot, value) {
  // 畳む先の既定の参照: 方立・上枠は建具記号の割当て、姿図は建具種別の割当て
  const baseRefs = slot === DetailSlot.FIGURE
    ? subTypeDetailFigureRefsFor(opening?.category, opening?.subType)
    : detailFigureRefsFor(fixtureSymbolOf(opening));
  const baseKey = baseRefs?.[slot];
  const folded = typeof value === 'string' && value !== '' && value === baseKey ? '' : value;
  return withDetailRef(opening?.detailRefs ?? null, slot, folded);
}

/**
 * R16: 解決後の方立の図（建具個別の上書き ＞ 記号の割当て）の param 束縛（見付・出幅）が持つ mm を、
 * Opening の項目名で返す。図が無い／実在しない／param 束縛が無いときは null。
 * @returns {{frameFaceWidth?: number, frameProjection?: number}|null}
 */
export function detailDimensionsToCopy(opening) {
  const resolved = resolveDetailFigure({
    symbolKey: fixtureSymbolOf(opening), detailRefs: opening?.detailRefs ?? null, slot: DetailSlot.JAMB,
  });
  const mm = paramMmOf(resolved?.drawn?.entry);
  const out = {};
  for (const [param, field] of Object.entries(PARAM_TO_OPENING_FIELD)) {
    if (Object.hasOwn(mm, param)) out[field] = mm[param];
  }
  return Object.keys(out).length > 0 ? out : null;
}
