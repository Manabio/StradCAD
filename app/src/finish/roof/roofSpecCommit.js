// 屋根の仕様（RoofSpec）の項目を1つ確定する純関数（仕上げモード FinishModeState と天伏モード CeilingModeState が共有）。
// 検証（isValidRoofFieldValue）・無変更判定・undo 1エントリ（withFinishUndo）の本体をここに置く。dirty 印は呼び出し側。
// 構造モードの外部タブ（structural/RoofSpecTab.jsx）は undo を構造再計算（onStructureChanged）に任せるため、
// 検証・無変更判定だけ roofSpecFieldChanges で共用し、書込みは自分の閉包で行う。
import { withFinishUndo } from '../finishUndo.js';
import { isValidRoofFieldValue } from './roofInput.js';

/**
 * spec の field を value に書く必要があるか（検証・無変更判定の本体）。spec なし・不正な値・無変更は false。
 * @param {import('@core').RoofSpec|null|undefined} spec
 * @param {string} field
 * @param {*} value
 * @returns {boolean}
 */
export function roofSpecFieldChanges(spec, field, value) {
  if (!spec) return false;
  if (!isValidRoofFieldValue(field, value)) return false;
  return spec[field] !== value;
}

/**
 * spec の field を value に確定する。spec なし・不正な値・無変更は何も変更せず（undo を積まず）false。
 * それ以外は withFinishUndo(graph, …) で1エントリとして書いて true。
 * @param {object} graph
 * @param {import('@core').RoofSpec|null|undefined} spec
 * @param {string} field
 * @param {*} value
 * @returns {boolean} 変更を確定したら true
 */
export function commitRoofSpecField(graph, spec, field, value) {
  if (!roofSpecFieldChanges(spec, field, value)) return false;
  withFinishUndo(graph, () => spec.setField(field, value));
  return true;
}
