// 昇降路 壁仕上げ材の select 選択肢を組み立てる純関数。@core 以外を import しない。
//
// graph.shaftWallMaterial は SHAFT_WALL_MATERIAL_CODES の3択で設定される想定だが、
// カタログ照合（codeNormalization.BACKING_FIELDS 経由）で3択外の値に付け替わりうる。
// 現在値が3択に無いまま options へ含めないと、<select> が先頭の別材を選択中に見せてしまい
// 表示と実値が食い違う——現在値を options の先頭へ補って必ず表示できるようにする。
import { SHAFT_WALL_MATERIAL_CODES } from '@core';

/**
 * @param {string|null|undefined} currentCode graph.shaftWallMaterial の現在値
 * @param {Array<{code:string,name:string}>} panelMaterials mode.getMaterialsByCategory('panel') の結果（未ロードなら []）
 * @returns {Array<{value:string,label:string}>}
 */
export function shaftWallMaterialOptions(currentCode, panelMaterials) {
  const nameOf = code => panelMaterials?.find(m => m.code === code)?.name ?? code;
  const options = SHAFT_WALL_MATERIAL_CODES.map(code => ({ value: code, label: nameOf(code) }));
  if (currentCode && !SHAFT_WALL_MATERIAL_CODES.includes(currentCode)) {
    return [{ value: currentCode, label: nameOf(currentCode) }, ...options];
  }
  return options;
}
