// 敷地・三斜の三角形の削除対象の自動選定（純モジュール。store.js/.jsx を引かない）。
// 削除の単位は三角形、対象は「端の三角形」＝赤辺・青辺のどちらも他の三角形の底辺になっていないもの。
// （後の三角形の底辺になっている三角形を消すと、連鎖して形が崩れるため）
import { findLineHistoryStep } from '../transform/siteHistory.js';

function triangleSteps(site) {
  return site.history.filter(s => s.type === 'triangle');
}

// 端の三角形の id 集合
export function computeDeletableTriangleIds(site) {
  const steps = triangleSteps(site);
  const baseIds = new Set(steps.map(s => s.baseLineId));
  const ids = new Set();
  for (const s of steps) {
    if (!baseIds.has(s.redLineId) && !baseIds.has(s.blueLineId)) ids.add(s.triangleId);
  }
  return ids;
}

// 三角番号（computeLineTriNums と同じ採番＝底辺の lineMap 順）。無ければ null
export function triangleNumber(site, triangleId) {
  const triByLine = new Map([...site.triangleMap.values()].map(t => [t.baseLine.id, t]));
  let n = 0;
  for (const line of site.lines) {
    const tri = triByLine.get(line.id);
    if (!tri) continue;
    n++;
    if (tri.id === triangleId) return n;
  }
  return null;
}

// 三斜表の行（線分）に出す削除操作。
//   { type:'triangle', triangleId, historyIndex } : 赤辺・青辺の行（端の三角形のとき）
//   { type:'base' }                                : 三角形が無いときの最初の1本
//   null                                           : 削除不可（ゴミ箱を出さない）
export function rowDeleteAction(site, lineId) {
  const found = findLineHistoryStep(site, lineId);
  if (!found) return null;
  if (found.role === 'base') {
    return site.history.length === 1 ? { type: 'base' } : null;
  }
  const step = site.history[found.index];
  if (!computeDeletableTriangleIds(site).has(step.triangleId)) return null;
  return { type: 'triangle', triangleId: step.triangleId, historyIndex: found.index };
}
