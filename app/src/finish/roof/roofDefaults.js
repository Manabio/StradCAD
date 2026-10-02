/**
 * 屋根の初期値の純関数（store.js / snap.js / .jsx を静的 import しない）。ステップ B2。
 *
 * 形状だけ「未設定（null）＝自動」で持ち、表示時に resolveRoofShape が導く。それ以外の項目は
 * 屋根を付けた時点で createRoofSpec が既定値を確定して保存する（材料コードは保存されていないと
 * 使用コードの収集・照合に乗らないため）。
 */
import { RoofSpec, RoofShape, RoomFeature, DEFAULT_ROOF_NOTE, ROOF_MONO_MAX_SHORT_SPAN_MM } from '@core';
import { cellBoundsList, refreshCells } from '../gridCells.js';
import { roofShortSpanMm } from './roofGeometry.js';

/**
 * 既定値の RoofSpec を作る。
 * @param {{ note?: string }} [opts] 備考の初期値（下屋＝セルに付けた屋根は DEFAULT_ROOF_NOTE '下野'）
 * @returns {RoofSpec}
 */
export function createRoofSpec({ note = '' } = {}) {
  return new RoofSpec({ note });
}

/** 下屋（セルに付けた屋根）の既定の RoofSpec（備考＝'下野'）。付与・復元の補完が共通で使う。 */
export function createLeanToRoofSpec() {
  return createRoofSpec({ note: DEFAULT_ROOF_NOTE });
}

/**
 * 復元（graphSnapshot.restoreGraph・roomReinterpret.restoreRoomsState）で Room の roofSpec を整える。
 * 不変条件 I1（feature===ROOF ⇔ roofSpec≠null）を復元側で保証する唯一の入口:
 *  - ROOF でない部屋: 何もしない（plain に roofSpec が付いていても捨てる。Room.roofSpec は null のまま）
 *  - ROOF の部屋: plain があれば RoofSpec.fromData（壊れた値は正規化）、欠けていれば既定値で補う
 *    （備考 '下野'。屋根の仕様を持たない旧い屋根の部屋の補完）
 * @param {import('@core').Room} room 生成直後の Room（feature 設定済み）
 * @param {object|null|undefined} plain RoofSpec.toData() 形式の plain object
 */
export function restoreRoofSpecInto(room, plain) {
  if (room.feature !== RoomFeature.ROOF) return;
  room.setRoofSpec(plain ? RoofSpec.fromData(plain) : createLeanToRoofSpec());
}

/**
 * 形状の実効値。明示値（spec.shape≠null）はそのまま。null（自動）なら、
 * rules.mainRoofDefaultShape が非 null（主屋根のときだけ渡す＝B3）ならそれ、
 * それ以外は短手が閾値以下なら片流れ・超えれば切妻。
 * @param {{ shape: string|null }|null|undefined} spec
 * @param {{ boundsList?: Array<{x1:number,y1:number,x2:number,y2:number}>, rules?: { mainRoofDefaultShape?: string|null } }} [ctx]
 * @returns {string} RoofShape の値
 */
export function resolveRoofShape(spec, { boundsList = [], rules = null } = {}) {
  if (spec?.shape) return spec.shape;
  if (rules?.mainRoofDefaultShape) return rules.mainRoofDefaultShape;
  return roofShortSpanMm(boundsList) <= ROOF_MONO_MAX_SHORT_SPAN_MM ? RoofShape.MONO : RoofShape.GABLE;
}

/**
 * 下屋（屋根の Room）のセル矩形群（現在の格子で解決。消失キーは除く）。
 * @param {{ cells: Set<string> }} room
 * @param {object} graph
 */
export function roofRoomBounds(room, graph) {
  return cellBoundsList(refreshCells(room.cells, graph), graph);
}
