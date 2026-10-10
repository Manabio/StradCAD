// CL 移動の準備（移動範囲の解決とエラー文言の組み立て）。平面モード（FloorplanModeState）と天伏モード
// （CeilingModeState）が共有する唯一の実装——片方だけ直すと移動不可の理由文言が食い違うため集約した。
// 関門（runBusy）と moveState の書込みは呼び出し側（各 ModeState）の責務。ここは純粋に「範囲 or エラー」を返す。
import { ERR_CL_MOVE_TOO_DEEP, ERR_CL_MOVE_TOO_MANY, ERR_CL_MOVE_LOAD_FAILED } from '../error.js';
import { resolveMoveRange } from '../transform/followerGraph.js';

/**
 * cl の移動を始める準備。ガター／長押し中の先読み（pending = { clId, promise }）が同じ cl のものなら
 * それを使い、無ければ範囲を解決する。
 * @param {object} project
 * @param {object} graph
 * @param {object} cl
 * @param {{ clId: string, promise: Promise }|null} pending
 * @returns {Promise<{ moveState: { cl, originalValue, range }, error: null } | { moveState: null, error: string }>}
 */
export async function prepareCenterLineMove(project, graph, cl, pending) {
  const promise = (pending?.clId === cl.id) ? pending.promise : resolveMoveRange(project, graph, cl);
  let result;
  try {
    result = await promise;
  } catch (e) {
    console.error(e);
    return { moveState: null, error: ERR_CL_MOVE_LOAD_FAILED };
  }

  if (result.exceeded) {
    const msgs = [];
    const { depth, count } = result.exceeded;
    if (depth) msgs.push(ERR_CL_MOVE_TOO_DEEP(depth.actual - depth.max, depth.max));
    if (count) msgs.push(ERR_CL_MOVE_TOO_MANY(count.actual - count.max, count.max));
    return { moveState: null, error: msgs.join(' ') };
  }

  return { moveState: { cl, originalValue: cl.value, range: result.range }, error: null };
}
