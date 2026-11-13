// ================================================================
// 姿図の配置のヒット判定（図面モードのタップ選択用）。純モジュール。
// 判定の元は placedFigureDrawPlan（direction='down'）の boxes・marks＝描けているものだけが当たる（回転・鏡像は織り込み済み）。
//   box: 点が外接を tolMm だけ広げた範囲内。mark（×）: 配置点から半幅 PLACED_FIGURE_MISSING_MARK_PX × mmPerPx ＋ tolMm の正方形内。
// 複数当たったら外接の面積が小さい方（×は自分の正方形）。同じなら placedFigures の並びで後ろ（後から置いた方）。
// 依存は constants・placedFigureDrawPlan だけ（store.js・snap.js・.jsx・react・konva・mobx を引かない）。
// ================================================================

import { PLACED_FIGURE_MISSING_MARK_PX } from '../core/constants.js';
import { placedFigureDrawPlan } from './placedFigureDrawPlan.js';

const nonNegativeOrZero = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);

/**
 * タップの許容（placedFigureHitAt の tolMm・mmPerPx）。scaleX は画面 px/mm、thresholdPx は当たり幅（画面 px）。
 * 呼び出し側が viewport.scaleX と CL_THRESHOLD_PX を渡す（snap.js を引かないため引数で受ける）。
 * scaleX が有限の正でない、または thresholdPx が有限の 0 以上でないときは両方 0（許容なし）。
 * @returns {{tolMm:number, mmPerPx:number}}
 */
export function placedFigureTapOptions(scaleX, thresholdPx) {
  if (!isFiniteNumber(scaleX) || scaleX <= 0 || !isFiniteNumber(thresholdPx) || thresholdPx < 0) return { tolMm: 0, mmPerPx: 0 };
  return { tolMm: thresholdPx / scaleX, mmPerPx: 1 / scaleX };
}

/**
 * @param {ReadonlyArray<object>} placedFigures graph.placedFigures
 * @param {(key:string) => (object|null)} figureOf 詳細図キー → エントリ
 * @param {{x:number, y:number, tolMm?:number, mmPerPx?:number, subjects?:(ReadonlyArray<string>|null)}} opts
 * @returns {string|null} 当たった配置の id。当たらない・入力が不正なら null（例外は投げない）。
 */
export function placedFigureHitAt(placedFigures, figureOf, { x, y, tolMm, mmPerPx, subjects = null } = {}) {
  if (!Array.isArray(placedFigures) || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  const tol = nonNegativeOrZero(tolMm);
  const half = PLACED_FIGURE_MISSING_MARK_PX * nonNegativeOrZero(mmPerPx);
  const { marks, boxes } = placedFigureDrawPlan(placedFigures, figureOf, { direction: 'down', subjects });
  const order = new Map(placedFigures.map((p, i) => [p?.id, i]));
  let best = null; // { id, area, order }
  const consider = (id, area) => {
    const cand = { id, area, order: order.get(id) };
    if (best === null || cand.area < best.area || (cand.area === best.area && cand.order > best.order)) best = cand;
  };
  for (const b of boxes) {
    if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
    consider(b.figureId, (b.maxX - b.minX) * (b.maxY - b.minY));
  }
  for (const m of marks) {
    const reach = half + tol;
    if (Math.abs(x - m.x) > reach || Math.abs(y - m.y) > reach) continue;
    const side = half + half;
    consider(m.figureId, side * side);
  }
  return best === null ? null : best.id;
}
