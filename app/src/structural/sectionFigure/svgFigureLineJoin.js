/**
 * AutoScaledFigure.jsx（構造断面図・建具姿図・階段模式図等のSVGレンダラ）向け、
 * L字の角の外角を閉じる（renderer/figureLineJoin.js。案2）のprimitives⇄px座標の配線を
 * 一本化する純関数（react非依存。node:testから単体import可）。
 *
 * resolveJoinedLinePoints（差分Map）とlinePointsPx（フォールバック判断）はrenderer/
 * figureLineJoin.jsが唯一の情報源のまま——本モジュールは「primitives配列全体に対して
 * 1回だけ解決し、primitivesと同じ長さ・同じ並びの配列として返す」という、.jsx側が
 * 本来下すべきでない配線判断（どの配列を渡すか・indexをどう引くか）だけを引き受ける。
 * AutoScaledFigure.jsxはこの戻り値を`linePts[i]`で読むだけにする。
 *
 * SVG側はweight語彙を解釈せず常にp.width??1を幅とする（sectionGeometry.jsヘッダ規約）ため、
 * resolveJoinedLinePointsはlineWeightsPx無しで呼ぶ——weightPxのフォールバックと自然に一致する。
 */
import { resolveJoinedLinePoints, linePointsPx } from '../../renderer/figureLineJoin.js';

/**
 * @param {object[]} primitives - AutoScaledFigure.jsxのプリミティブ配列（sectionGeometry.js語彙）
 * @param {{tx:Function, ty:Function}} t - mm→px 変換器
 * @returns {(null|[number,number,number,number])[]} primitivesと同じ長さ・同じ並びの配列。
 *   type!=='line'はnull、type==='line'は[x1,y1,x2,y2](px)。
 */
export function resolveSvgFigureLinePoints(primitives, t) {
  const joined = resolveJoinedLinePoints(primitives, t);
  return primitives.map((p, i) => (p.type === 'line' ? linePointsPx(p, i, t, joined) : null));
}
