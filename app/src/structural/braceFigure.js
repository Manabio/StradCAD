// ================================================================
// 水平ブレースの×（構造モードの伏図の描画幾何）。
//
// ブレース指定の S造スラブのベイを、子梁（小梁）の梁芯で小区画に分け、各小区画の2本の対角線を返す
// （メモ「矩型頂点をバツ…で水平面を支える」）。保存せず描画時に導く（小屋組 C3a と同じ。新しい実体は持たない）。
// 子梁の座標は slabSecondaryBeamAxes.js bayChildAxisCoords（S7 の割付けが書いた梁芯）が唯一の供給源。
// 開口のベイは assignSteelSlabBays が指定を拒否する（steelSlabBays.js）ので、描画側は openingRects 無しで良い。
// 先送り: 「/（片方のみ）」・図面出力（structuralFigure.js）・断面。
// 純モジュール: store.js / snap.js / .jsx を静的に引かない。
// ================================================================
import { SlabBayFillSkip } from '../core/constants.js';
import { braceBayMap } from './steelSlabBayIndex.js';
import { canAssignSteelSlab } from './steelSlabBays.js';
import { listSlabBays, bayChildAxisCoords } from './slabSecondaryBeamAxes.js';

/**
 * ブレース指定のベイの×の線分（ワールド座標 mm）。S造でない階・ブレースのベイが無い階は空（ベイの計算をしない）。
 * @param {object} graph
 * @param {object} project
 * @param {{openingRects?: Array<object>}} [opts]
 * @returns {Array<{x1:number, y1:number, x2:number, y2:number}>}
 */
export function braceCrossSegments(graph, project, { openingRects = [] } = {}) {
  if (!graph || !canAssignSteelSlab(graph, project)) return [];
  const braceKeys = braceBayMap(graph, project);
  if (braceKeys.size === 0) return [];
  const childAxes = bayChildAxisCoords(graph, project, openingRects);
  const segments = [];
  for (const bay of listSlabBays(graph, project, openingRects)) {
    if (!bay.ids || bay.key == null || !braceKeys.has(bay.key) || bay.skip === SlabBayFillSkip.OPENING) continue;
    const { x1, y1, x2, y2 } = bay.cell;
    const axes = childAxes.get(bay.key);
    const coords = axes?.coords ?? [];
    const cuts = axes?.isVertical
      ? [x1, ...coords, x2]
      : [y1, ...coords, y2];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      const [sx1, sx2, sy1, sy2] = axes?.isVertical ? [a, b, y1, y2] : [x1, x2, a, b];
      segments.push({ x1: sx1, y1: sy1, x2: sx2, y2: sy2 });
      segments.push({ x1: sx1, y1: sy2, x2: sx2, y2: sy1 });
    }
  }
  return segments;
}
