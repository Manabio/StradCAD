// 階段の段（踏面）の占有形と天端高さ（純モジュール）。平面の断面解決（plan/planSolids.js の stairTread 立体）の
// 供給源で、踏面の多角形は描画と同じエミッタ（stairGeometry.js の emitRun・emitTurn）から collectCells で取る
//（型ごとの幾何を複製しない）。描画（StairLayer）は別。ここは遮蔽専用の数値だけを返す。
//
// store.js / snap.js / *.jsx を import しない（node:test から単体 import 可）。
import { buildStairGeometry } from './stairGeometry.js';
import { measureStairSpans } from './stairClassify.js';
import { roomBounds } from '../gridCells.js';

/**
 * 階段1つの段（マス）の占有形と天端高さ。
 *   - view は常に 'upper'（全段）。install では走行部の emitRun が破れ位置で打ち切られる・復路が呼ばれないため。
 *   - laneGap は常に true（遮蔽は LOD に依らない）。insetView は設置枠の逃がし規則（自階の階段 'install'・下階 'upper'）。
 *   - 段 n の天端 = n × riser（設置階 FL 基準。到達番号＝上階の床は含まない）。厚み・段鼻は扱わない。
 * 求まらないとき（riser が null・非有限・0 以下／階段・graph なし／セルが無い・設置枠が不正）は [] （遮蔽しない＝安全側）。
 * @param {import('@core').Stair} stair
 * @param {object} graph 階段のセルを解決する graph（その階段の設置階）
 * @param {{ riser: number|null, insetView?: 'install'|'upper' }} opts
 * @returns {{ number: number, poly: number[], topZ: number }[]}
 */
export function stairTreadFootprints(stair, graph, { riser, insetView = 'upper' } = {}) {
  if (!stair || !graph || !(Number.isFinite(riser) && riser > 0)) return [];
  if (!stair.cells || stair.cells.size === 0) return [];
  const b = roomBounds(stair.cells, graph);
  if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || b.x2 <= b.x1 || b.y2 <= b.y1) return [];
  const geom = buildStairGeometry(stair, b, {
    view: 'upper', insetView, detail: false, riser, spans: measureStairSpans(stair, graph), laneGap: true, graph, collectCells: true,
  });
  return (geom.cells ?? []).map(({ number, poly }) => ({ number, poly, topZ: number * riser }));
}
