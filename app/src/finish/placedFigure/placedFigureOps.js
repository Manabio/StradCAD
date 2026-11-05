// ================================================================
// 姿図の配置（PlacedFigure）の一覧に対する純関数の操作（graph.placedFigures の凍結配列を受け取り、凍結配列を返す）。
// 入力の配列・要素は変えない。呼び出し側（モード状態）が withFinishUndo の中で graph.setPlacedFigures に渡す。
// finish/roof/roofZones.js の createRoofZone／removeRoofZone と同じ流儀。
// ================================================================
import { PlacedFigure } from '../../core/placedFigure.js';

/**
 * 配置を末尾に足した凍結配列。同じ id が既にあれば RangeError（id はグラフの中で一意）。
 * @param {ReadonlyArray<import('../../core/placedFigure.js').PlacedFigure>} list
 * @param {import('../../core/placedFigure.js').PlacedFigure} placed
 */
export function addPlacedFigure(list, placed) {
  if (!(placed instanceof PlacedFigure)) throw new RangeError('PlacedFigure: PlacedFigure のインスタンスではありません');
  if (list.some(p => p.id === placed.id)) throw new RangeError(`PlacedFigure: id が重複しています: ${placed.id}`);
  return Object.freeze([...list, placed]);
}

/**
 * id の配置の項目を差し替えた凍結配列。無い id は null。不正な値は PlacedFigure.with の RangeError。
 * @returns {ReadonlyArray<import('../../core/placedFigure.js').PlacedFigure>|null}
 */
export function updatePlacedFigure(list, id, changes) {
  const index = list.findIndex(p => p.id === id);
  if (index < 0) return null;
  const next = [...list];
  next[index] = list[index].with(changes);
  return Object.freeze(next);
}

/**
 * id の配置を除いた凍結配列。無い id は null。
 * @returns {ReadonlyArray<import('../../core/placedFigure.js').PlacedFigure>|null}
 */
export function removePlacedFigure(list, id) {
  if (!list.some(p => p.id === id)) return null;
  return Object.freeze(list.filter(p => p.id !== id));
}
