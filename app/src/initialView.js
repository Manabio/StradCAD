// 読込み後の初期表示: 1階の通り芯の範囲を画面の中心に、全体が入るキリの良い倍率で描く。
// App.jsx が restoreReady（階の復元完了。bootReady の壁 sweep より前）後に 1 回だけ呼び、呼び終わるまで図面を描かない。純モジュール（store.js・DOM を引かない。node:test から単体 import 可）。
import { INITIAL_FIT_SCALE_DENOMS, INITIAL_FIT_MARGIN_PX } from './core/constants.js';
import { drawingAreaRect } from './layout.js';

/**
 * 初期表示の基準にする階の平面。1階（startFloor === 1）、無ければ最下階。採用階が無ければ null。
 * @param {{ planes: Array<{ id: string, startFloor: number }> }} project
 */
export function initialViewPlane(project) {
  const planes = project.planes;
  return planes.find(p => p.startFloor === 1) ?? planes[0] ?? null;
}

/**
 * 通り芯（gridXs/gridYs。全階共通の通り芯＋その階の labeled CL）の値の範囲（mm）。
 * 軒・バルコニー等の外側に置いた通り芯もそのまま含まれる。X・Y いずれかに通り芯が無ければ null。
 * @param {{ gridXs: Array<{ value: number }>, gridYs: Array<{ value: number }> }} graph
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
 */
export function gridBoundsMm(graph) {
  const xs = graph.gridXs.map(cl => cl.value);
  const ys = graph.gridYs.map(cl => cl.value);
  if (xs.length === 0 || ys.length === 0) return null;
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * viewport を 1階の通り芯の範囲へ合わせる（倍率＝候補のうち収まる最小の分母・位置＝描画エリアの中心）。
 * 通り芯が無い（空の文書）ときは何もせず false。
 * @param {import('./viewport.js').Viewport} viewport
 * @param {{ planes: Array, graphMap: Map, activeGraph?: object }} project
 * @param {{ width: number, height: number }} size 画面サイズ（px）
 * @returns {boolean} 合わせたら true
 */
export function fitViewportToInitialView(viewport, project, size) {
  const plane = initialViewPlane(project);
  const graph = (plane && project.graphMap.get(plane.id)) ?? project.activeGraph;
  if (!graph) return false;
  const bounds = gridBoundsMm(graph);
  if (!bounds) return false;
  viewport.fitToBounds(bounds, drawingAreaRect(size), INITIAL_FIT_SCALE_DENOMS, INITIAL_FIT_MARGIN_PX);
  return true;
}
