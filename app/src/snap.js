// スナップ計算はすべてスクリーン空間距離 (px) で判定する。
// threshold は px 単位で渡し、ワールド差分に scaleX/Y を掛けてスクリーン距離に換算する。

export function findNearestIntersection(graph, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const n of graph.intersections) {
    const dist = Math.hypot((n.x - wx) * scaleX, (n.y - wy) * scaleY);
    if (dist < thresholdPx && dist < minDist) { minDist = dist; nearest = n; }
  }
  return nearest;
}

/**
 * カーソルに最も近い中心線を返す。
 * VERTICAL  → X 方向スクリーン距離
 * HORIZONTAL → Y 方向スクリーン距離
 */
export function findNearestCenterLine(graph, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    const dist = cl.centerLineType === 'X' ? Math.abs(cl.value - wx) * scaleX
               : cl.centerLineType === 'Y' ? Math.abs(cl.value - wy) * scaleY
               : Infinity;
    if (dist < thresholdPx && dist < minDist) { minDist = dist; nearest = cl; }
  }
  return nearest;
}

/**
 * 中心線移動中、同種の他中心線へのスナップ値を返す。
 */
export function findCLMoveSnap(graph, movingCL, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  const isV   = movingCL.centerLineType === 'X';
  const scale = isV ? scaleX : scaleY;
  const coord = isV ? wx : wy;
  let best = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (cl.id === movingCL.id || cl.centerLineType !== movingCL.centerLineType) continue;
    const dist = Math.abs(cl.value - coord) * scale;
    if (dist < thresholdPx && dist < minDist) { minDist = dist; best = cl.value; }
  }
  return best;
}

/**
 * 長押し位置に近接する中心線（ラベルなし）を参照元候補として返す。
 * - clType を渡すと同種CLのみ（線分追加）。null なら垂直/水平両方（壁追加）。
 * - はね出し（オーバーハング）部分は除外: 沿線座標が実範囲 [extentLo, extentHi] 内のCLのみ。
 * - スクリーン距離が近い順にソート。
 */
export function findNearbyCenterLines(graph, wx, wy, thresholdPx, scaleX, scaleY, clType = null) {
  if (!graph) return [];
  const hits = [];
  for (const cl of graph.centerLines) {
    if (cl.labeled) continue;
    const isV = cl.centerLineType === 'X';
    const isH = cl.centerLineType === 'Y';
    if (!isV && !isH) continue;
    if (clType && cl.centerLineType !== clType) continue;
    const scale = isV ? scaleX : scaleY;
    const perp  = isV ? wx : wy;  // 線に垂直な座標
    const along = isV ? wy : wx;  // 線に沿った座標
    const dist  = Math.abs(cl.value - perp) * scale;
    if (dist >= thresholdPx) continue;
    // はね出し除外: 沿線座標が実範囲外なら候補から外す
    if (cl.extentLo != null && cl.extentHi != null &&
        (along < cl.extentLo || along > cl.extentHi)) continue;
    hits.push({ cl, dist });
  }
  return hits.sort((a, b) => a.dist - b.dist).map(h => h.cl);
}

/**
 * coord を挟む CL ペアを返す。
 */
export function findBracketingCLs(cls, coord) {
  let lo = null, hi = null;
  let loDist = Infinity, hiDist = Infinity;
  for (const cl of cls) {
    const d = cl.value - coord;
    if (d <= 0 && -d < loDist) { loDist = -d; lo = cl; }
    if (d > 0  && d  < hiDist) { hiDist = d;  hi = cl; }
  }
  if (lo && hi) return [lo, hi];
  const sorted = [...cls].sort((a, b) => Math.abs(a.value - coord) - Math.abs(b.value - coord));
  return [sorted[0] ?? null, sorted[1] ?? null];
}

export function snapAngle(dx, dy) {
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { dx: 0, dy: 0, type: 'diagonal' };
  const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
  const absAngle = Math.abs(angleDeg);
  if (absAngle <= 30 || absAngle >= 150) return { dx: dx >= 0 ? dist : -dist, dy: 0, type: 'horizontal' };
  if (Math.abs(absAngle - 90) <= 30)    return { dx: 0, dy: dy >= 0 ? dist : -dist, type: 'vertical' };
  return { dx, dy, type: 'diagonal' };
}
