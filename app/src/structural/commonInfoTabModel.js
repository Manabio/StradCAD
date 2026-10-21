// 共通タブ（CommonInfoTab.jsx）の「構造」行の表示の分岐を決める純モジュール（S5d）。
// .jsx は node:test から import できないため、判断（どの行を出すか）をここに置いてテストで固定する。
// import は structureRules.js だけ（store.js / snap.js / .jsx を静的に引かない）。
import {
  MAIN_STRUCTURE_OPTIONS, BASEMENT_STRUCTURE_OPTIONS, normalizeBasementStructure, isBasementPlane,
} from './structureRules.js';

/** 旧データ（地階構造が null）の地階で選択肢の先頭に出す表示。選んでも何も書かない（未設定へ戻す手段は作らない）。 */
export const BASEMENT_UNSET_LABEL = '未設定（主構造に従う）';

export const STRUCTURE_ROW = Object.freeze({ MAIN: 'main', BASEMENT: 'basement', BASEMENT_OVERRIDE: 'basementOverride' });

/**
 * 表示中の階（plane）・その階の上書き（structureOverride）・建物全体の構造情報（info）から、共通タブの構造行を決める。
 * - 地階でない（屋根専用平面・plane 無しを含む）: 主構造（上書きがあればその値）。「この階のみ別構造にする」を出す。
 * - 地階・上書きなし: 地階構造。「この階のみ別構造にする」は出さない（地階に新しく上書きを入れる手段は作らない）。
 * - 地階・上書きあり（旧データ）: 「この階の構造」として上書き値を主構造の選択肢で出し、チェック（入り）で解除できるようにする。
 * 地階構造は normalizeBasementStructure で読む（選択肢外・空文字は未設定の行）。
 * @returns {{ kind: string, label: string, value: string, options: readonly string[],
 *             showOverrideToggle: boolean, overrideChecked: boolean, focusOnMount: boolean }}
 */
export function commonTabStructureRow(plane, structureOverride, info) {
  const hasOverride = structureOverride != null;
  if (!isBasementPlane(plane)) {
    const value = hasOverride ? structureOverride : info.mainStructure;
    return {
      kind: STRUCTURE_ROW.MAIN, label: '主構造', value, options: MAIN_STRUCTURE_OPTIONS,
      showOverrideToggle: true, overrideChecked: hasOverride, focusOnMount: value === MAIN_STRUCTURE_OPTIONS[0],
    };
  }
  if (hasOverride) {
    return {
      kind: STRUCTURE_ROW.BASEMENT_OVERRIDE, label: 'この階の構造', value: structureOverride, options: MAIN_STRUCTURE_OPTIONS,
      showOverrideToggle: true, overrideChecked: true, focusOnMount: false,
    };
  }
  const basement = normalizeBasementStructure(info.basementStructure);
  return {
    kind: STRUCTURE_ROW.BASEMENT, label: '地階構造',
    value: basement ?? BASEMENT_UNSET_LABEL,
    options: basement ? BASEMENT_STRUCTURE_OPTIONS : [BASEMENT_UNSET_LABEL, ...BASEMENT_STRUCTURE_OPTIONS],
    showOverrideToggle: false, overrideChecked: false, focusOnMount: false,
  };
}
