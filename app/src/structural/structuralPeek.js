// 構造系の peek 呼び出しの単一の入口（構造再計算高速化・ステップB）。
// 解決コンテキスト（structuralResolveContext.js）とは別ファイルに置く——コンテキスト本体は
// wallGate.js・wallBeamAxes.js の cache ファクトリを import し、その両者は本関数を import する
// ため、同じファイルに置くと循環 import になる（本ファイルは FloorSwapManager だけに依存する）。
import { floorSwapManager } from '../storage/FloorSwapManager.js';

/**
 * ctx指定時はコンテキスト経由（1回の境界処理の間だけ保持を使い回す）、省略時（null/undefined）は
 * 現行の floorSwapManager.peek 直呼び（従来どおり・挙動不変）。
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>|null|undefined} ctx
 * @param {object} plane
 * @param {object} structGraph
 * @returns {Promise<object|null>}
 */
export function peekVia(ctx, plane, structGraph) {
  return ctx ? ctx.graphFor(plane, structGraph) : floorSwapManager.peek(plane, structGraph);
}
