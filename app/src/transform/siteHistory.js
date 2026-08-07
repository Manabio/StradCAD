import { computeApexFromSide } from '../site/siteGeometry.js';

// 線分IDから、その線分の長さを確定したhistoryステップを探す。
// 戻り値: { index, role } | null
//   role: 'base'（最初の1本そのもの） | 'red' | 'blue'（三角形確定時の赤辺/青辺）
export function findLineHistoryStep(site, lineId) {
  const history = site.history;
  if (history.length === 0) return null;
  if (history[0].type === 'base' && history[0].lineId === lineId) {
    return { index: 0, role: 'base' };
  }
  for (let i = 1; i < history.length; i++) {
    const step = history[i];
    if (step.type !== 'triangle') continue;
    if (step.redLineId === lineId)  return { index: i, role: 'red' };
    if (step.blueLineId === lineId) return { index: i, role: 'blue' };
  }
  return null;
}

// startIndex以降の三角形確定ステップについて、各ステップの底辺(baseLine)の
// 現在位置 + 記録済みの redLen/blueLen/side から頂点(apex)位置を再計算し、
// 該当する SitePoint の座標を上書きする。
// 三角形が成立しないステップがあれば false を返す（呼び出し側でロールバックすること）。
export function recomputeSiteFromHistory(site, startIndex) {
  for (let i = startIndex; i < site.history.length; i++) {
    const step = site.history[i];
    if (step.type !== 'triangle') continue;
    const baseLine = site.lineMap.get(step.baseLineId);
    const tri      = site.triangleMap.get(step.triangleId);
    if (!baseLine || !tri) continue;
    const apex = computeApexFromSide(baseLine, step.redLen, step.blueLen, step.side);
    if (!apex) return false;
    tri.apexPoint.x = apex.x;
    tri.apexPoint.y = apex.y;
  }
  return true;
}

// historyの複製（undo/redo用のスナップショット）
export function cloneHistory(history) {
  return history.map(step => ({ ...step }));
}

// 三斜連続入力で「次に底辺として選択すべき線分」のキューを返す。
// history[0]（線分a）を初期キューとし、各triangleステップで baseLineId を除去、
// redLineId → blueLineId の順でキュー末尾に追加する。先頭要素が次の選択候補。
export function computePendingQueue(site) {
  const history = site.history;
  if (history.length === 0 || history[0].type !== 'base') return [];
  const queue = [history[0].lineId];
  for (let i = 1; i < history.length; i++) {
    const step = history[i];
    if (step.type !== 'triangle') continue;
    const idx = queue.indexOf(step.baseLineId);
    if (idx !== -1) queue.splice(idx, 1);
    queue.push(step.redLineId, step.blueLineId);
  }
  return queue;
}
