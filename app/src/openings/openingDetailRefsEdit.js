// ================================================================
// 建具エディタ（OpeningEditor.jsx）の「部分詳細図の上書き」欄の判断（S6a）。配線は .jsx、判断はここ（純）。
//   - openingDetailRefSelects  select（方立／上枠／下枠／姿図）の見出し・現在値・選択肢
//   - detailRefsAfterSelect    選択後の detailRefs（空の写像は null。元は変えない）
//   - detailDimensionsToCopy   R16「図の寸法を建具へ」で写す値（無ければ null＝ボタンは無効）
// 解決順は resolveDetailFigure（建具個別の detailRefs ＞ 記号の detailFigures）と同じ。
// select は jamb・head・sill（下枠は窓だけ。S8f-3c）と姿図。他の slot はデータとして受けるが UI を出さない（R20）。
// ================================================================

import { DetailSlot, DetailParam } from '../core/constants.js';
import {
  detailFigureOptionsFor, FIXTURE_SYMBOL_DETAIL_SLOT_TEXT, OPENING_DETAIL_REF_TEXT,
} from '../catalog/catalogMaintenance.js';
import { withDetailRef } from '../core/detailRefs.js';
import { paramMmOf } from '../detail/detailPlacement.js';
import { resolveDetailFigure, frameDefaultKey, fittingKeyOf, fittingDefaultKey } from './openingDetailFit.js';
import { detailFigureRefsFor, subTypeDetailFigureRefsFor, detailFigureCatalog } from './openingCatalog.js';
import { fixtureSymbolOf } from './openingNumbering.js';

/** 枠の slot（方立・上枠・下枠。どれを出すかは建具ごと＝frameDetailSlotsFor）。 */
export const FRAME_DETAIL_REF_SLOTS = Object.freeze([DetailSlot.JAMB, DetailSlot.HEAD, DetailSlot.SILL]);

/** 三方枠に出す slot（方立・上枠。下枠は窓だけ）。 */
const FRAME_ONLY_DETAIL_REF_SLOTS = Object.freeze([DetailSlot.JAMB, DetailSlot.HEAD]);

/** select を出す slot（表示順）。姿図（S6b）は全機構の建具に出し、枠の slot は frameDetailSlotsFor が建具ごとに絞る。 */
export const OPENING_DETAIL_REF_SLOTS = Object.freeze([...FRAME_DETAIL_REF_SLOTS, DetailSlot.FIGURE, DetailSlot.FIGURE_BACK, DetailSlot.FITTING]);

/** 建具種別の割当てを基準にする slot（姿図の手前・向こう側・建具一式）。方立・上枠・下枠の基準は建具記号の割当て。 */
const isSubTypeSlot = slot => slot === DetailSlot.FIGURE || slot === DetailSlot.FIGURE_BACK || slot === DetailSlot.FITTING;

/**
 * 方立・上枠・下枠の select を出す slot（建具エディタの絞りの唯一の判断）。三方枠＝方立と上枠、
 * それ以外は暗黙の既定の図を持つ slot だけ（frameDefaultKey が定義される＝片開き戸は方立・上枠、
 * 窓は方立・上枠・下枠〔引き違い窓は方立なし・掃き出し窓は下枠なし〕、機構不明・他の建具は無し）。
 * @param {string} [mechanism] OpeningMechanism（窓の判定に使う。未指定・実装外の機構の窓は描画に枠が出ないので対象外）
 * @returns {string[]} DetailSlot の配列
 */
export function frameDetailSlotsFor(opening, isFrameOnly, mechanism) {
  if (isFrameOnly === true) return [...FRAME_ONLY_DETAIL_REF_SLOTS];
  return FRAME_DETAIL_REF_SLOTS.filter(slot => frameDefaultKey(opening, slot, mechanism) !== undefined);
}

/** R16: 図の param → 写し先の Opening の項目。 */
const PARAM_TO_OPENING_FIELD = Object.freeze({
  [DetailParam.FRAME_FACE_WIDTH]: 'frameFaceWidth',
  [DetailParam.FRAME_PROJECTION]: 'frameProjection',
});

/** 三層合成後の詳細図エントリ（組込み＋ライブラリ＋同梱。openingCatalog.js detailFigureCatalog）。 */
function detailFigureEntries() {
  return [...detailFigureCatalog().values()];
}

/**
 * @param {{detailRefs?: object|null}} opening
 * @param {object[]} [figureList] 詳細図エントリ（省略時は三層合成後）
 * @param {{frameSlots?: string[]}} [opts] frameSlots＝方立・上枠・下枠のうち select を出す slot（既定は全部。frameDetailSlotsFor の戻り値。
 *   空なら姿図だけ）
 * @returns {Array<{slot:string, label:string, value:string, options:Array<{value:string,label:string}>}>}
 *   value＝建具個別の上書きのキー（未上書きは ''）。options の先頭は未上書き（記号〔姿図は建具種別〕の設定を使う）。
 */
export function openingDetailRefSelects(opening, figureList = detailFigureEntries(), { frameSlots = FRAME_DETAIL_REF_SLOTS } = {}) {
  return OPENING_DETAIL_REF_SLOTS.filter(slot => isSubTypeSlot(slot) || frameSlots.includes(slot)).map(slot => {
    const key = opening?.detailRefs?.[slot];
    const value = typeof key === 'string' ? key : '';
    const useBase = isSubTypeSlot(slot) ? OPENING_DETAIL_REF_TEXT.useSubType : OPENING_DETAIL_REF_TEXT.useSymbol;
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
 * mechanism＝建具の機構（窓の方立の既定キーが機構で決まる。frameDefaultKey）。
 */
export function detailRefsAfterSelect(opening, slot, value, mechanism) {
  // 畳む先の既定の参照: 方立・上枠は建具記号の割当て、姿図・建具一式は建具種別の割当て
  const baseRefs = isSubTypeSlot(slot)
    ? subTypeDetailFigureRefsFor(opening?.category, opening?.subType)
    : detailFigureRefsFor(fixtureSymbolOf(opening));
  // 片開き戸・窓の方立は記号に割当てが無いとき組込みの既定が基準（同キーの選択は既定扱い＝上書きとして持たない。S8d・S8f-2）
  // 建具一式は建具種別の割当て、無ければ組込みの一式（外付け引き戸。fittingDefaultKey）が基準
  const baseKey = baseRefs?.[slot] ?? (slot === DetailSlot.FITTING ? fittingDefaultKey(opening) : frameDefaultKey(opening, slot, mechanism));
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
    symbolKey: fixtureSymbolOf(opening), detailRefs: opening?.detailRefs ?? null, fittingKey: fittingKeyOf(opening), slot: DetailSlot.JAMB,
  });
  const mm = paramMmOf(resolved?.drawn?.entry);
  const out = {};
  for (const [param, field] of Object.entries(PARAM_TO_OPENING_FIELD)) {
    if (Object.hasOwn(mm, param)) out[field] = mm[param];
  }
  return Object.keys(out).length > 0 ? out : null;
}
