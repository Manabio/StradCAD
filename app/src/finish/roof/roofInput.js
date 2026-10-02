/**
 * 屋根の項目の入力検証と選択肢の組立（純関数。store.js / snap.js / .jsx を静的 import しない）。ステップ B2。
 * RoofGroup.jsx（描画だけ）と FinishModeState.setRoofField（確定時の最終検証）が共有する。
 */
import { RoofShape, ROOF_SHAPE_LABELS, RoofHighSide, ROOF_HIGH_SIDE_LABELS } from '@core';

const NUMBER_TEXT = /^\d+(\.\d+)?$/;

/**
 * 勾配（N/10 の N）の入力テキストを解釈する。0.5 刻みの正の数だけ有効（2.5・3 は可。0・負・文字・2.3 は不可）。
 * @param {string} text
 * @returns {number|null} 有効なら数値、無効なら null
 */
export function parseRoofSlopeInput(text) {
  const t = String(text ?? '').trim();
  if (!NUMBER_TEXT.test(t)) return null;
  const n = Number(t);
  return isValidRoofSlope(n) ? n : null;
}

/**
 * 出幅（mm）の入力テキストを解釈する。0 以上の数だけ有効（0 は正当）。
 * @param {string} text
 * @returns {number|null} 有効なら数値、無効なら null
 */
export function parseRoofOverhangInput(text) {
  const t = String(text ?? '').trim();
  if (!NUMBER_TEXT.test(t)) return null;
  const n = Number(t);
  return isValidRoofOverhang(n) ? n : null;
}

export function isValidRoofSlope(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n * 2);
}

export function isValidRoofOverhang(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * 項目ごとの確定値の検証（RoofSpec.setField へ渡してよい値か）。
 * shape・highSide は RoofShape・RoofHighSide の値のみ（null＝「自動」へ戻す入口は無い）。材料コードは空でない文字列。
 * 自由入力（屋根仕上げ・軒裏・備考）は文字列なら何でも可。
 * @param {string} field RoofSpec の項目名
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRoofFieldValue(field, value) {
  switch (field) {
    case 'shape': return Object.values(RoofShape).includes(value);
    case 'highSide': return Object.values(RoofHighSide).includes(value);
    case 'slope': return isValidRoofSlope(value);
    case 'eaveOverhangMm':
    case 'gableOverhangMm': return isValidRoofOverhang(value);
    case 'sheathingMaterial':
    case 'underlaymentMaterial': return typeof value === 'string' && value !== '';
    case 'roofFinish':
    case 'soffit':
    case 'note': return typeof value === 'string';
    default: return false;
  }
}

/** 形状の選択肢（「自動」は出さない）。 */
export function roofShapeOptions() {
  return Object.values(RoofShape).map(value => ({ value, label: ROOF_SHAPE_LABELS[value] }));
}

/** 片流れの高い側の選択肢（上・下・左・右。「自動」は出さない）。 */
export function roofHighSideOptions() {
  return Object.values(RoofHighSide).map(value => ({ value, label: ROOF_HIGH_SIDE_LABELS[value] }));
}

/**
 * 材料の選択肢（野地板・防水シート共通）。候補コード表から作り、保存されているコードが候補に無い
 * （カタログ照合で付け替わった・材データで解決できない）ときは、先頭へ補って値を失わず表示する
 * （shaftWallMaterialOptions.js と同じ扱い）。
 * @param {readonly string[]} codes 候補のコード（表示順）
 * @param {string|null|undefined} currentCode 保存されている現在値
 * @param {(code: string) => string|null|undefined} nameOf 材料名の引き当て（解決できなければコードを表示）
 * @returns {Array<{value:string,label:string}>}
 */
export function roofMaterialOptions(codes, currentCode, nameOf) {
  const labelOf = code => nameOf?.(code) || code;
  const options = codes.map(code => ({ value: code, label: labelOf(code) }));
  if (currentCode && !codes.includes(currentCode)) {
    return [{ value: currentCode, label: labelOf(currentCode) }, ...options];
  }
  return options;
}
