// 構造系の peek/save 呼び出しの単一の入口（構造再計算高速化・ステップB）。
// 解決コンテキスト（structuralResolveContext.js）とは別ファイルに置く——コンテキスト本体は
// wallGate.js・wallBeamAxes.js の cache ファクトリを import し、その両者は本関数を import する
// ため、同じファイルに置くと循環 import になる（本ファイルは FloorSwapManager・storage/db.js だけに
// 依存する。storage/db.js は structural/ を import しないため循環にならない）。
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { saveFloor } from '../storage/db.js';

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

/**
 * ctx指定時はコンテキスト経由（saveAndNote。保持が新鮮なままなら直後の graphFor が読み直さない）、
 * 省略時（null/undefined）は現行の saveFloor 直呼び（従来どおり・挙動不変）。
 * @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>|null|undefined} ctx
 * @param {string} planeId
 * @param {Uint8Array} bytes
 * @param {object} graph - bytes をシリアライズした元の graph（ctx.saveAndNote の契約参照）
 * @returns {Promise<void>}
 */
export function saveVia(ctx, planeId, bytes, graph) {
  return ctx ? ctx.saveAndNote(planeId, bytes, graph) : saveFloor(planeId, bytes);
}
