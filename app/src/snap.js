// スナップ計算はすべてスクリーン空間距離 (px) で判定する。
// threshold は px 単位で渡し、ワールド差分に scaleX/Y を掛けてスクリーン距離に換算する。
import { spatialIndex } from './store.js';
import { findHostWall } from './openings/openingGeometry.js';

// 中心線の端のはね出し量 (mm)。区分線形:
//   denom <  BASE_DENOM         : (LOW_DENOM, LOW_MM) → (BASE_DENOM, BASE_MM) の直線
//   BASE_DENOM ≤ denom ≤ ZERO_DENOM: (BASE_DENOM, BASE_MM) → (ZERO_DENOM, 0) の直線
//   denom >  ZERO_DENOM         : 0
const OVERHANG_LOW_DENOM  = 50;
const OVERHANG_LOW_MM     = 200;
const OVERHANG_BASE_DENOM = 100;
const OVERHANG_BASE_MM    = 300;
const OVERHANG_ZERO_DENOM = 500;
export function overhangMm(viewport, trim) {
  if (trim) return 0;
  const denom = viewport.scaleDenominator;
  if (denom >= OVERHANG_ZERO_DENOM) return 0;
  if (denom >= OVERHANG_BASE_DENOM) {
    const t = (denom - OVERHANG_BASE_DENOM) / (OVERHANG_ZERO_DENOM - OVERHANG_BASE_DENOM);
    return OVERHANG_BASE_MM * (1 - t);
  }
  const t = (denom - OVERHANG_LOW_DENOM) / (OVERHANG_BASE_DENOM - OVERHANG_LOW_DENOM);
  return Math.max(0, OVERHANG_LOW_MM + (OVERHANG_BASE_MM - OVERHANG_LOW_MM) * t);
}

export function findNearestIntersection(graph, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  // R-Tree でワールド半径の候補を絞り込む（O(log n)）
  const worldRadius = thresholdPx / Math.min(scaleX, scaleY);
  const { intersections: candidates } = spatialIndex.query(wx, wy, worldRadius);
  if (candidates.length === 0) return null;
  // スクリーン距離で最終判定（n.x/y は effectiveValue = 描画位置）
  let nearest = null, minDist = Infinity;
  for (const e of candidates) {
    const n = spatialIndex.getNode(e.id);
    if (!n) continue;
    const dist = Math.hypot((n.x - wx) * scaleX, (n.y - wy) * scaleY);
    if (dist < thresholdPx && dist < minDist) { minDist = dist; nearest = n; }
  }
  return nearest;
}

/**
 * カーソルに最も近い中心線を返す。
 * VERTICAL  → X 方向スクリーン距離
 * HORIZONTAL → Y 方向スクリーン距離
 * viewport を渡すと、ラベルなしCLの描画範囲（オーバーハング込み）外を除外する。
 */
export function findNearestCenterLine(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport = null) {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    const isV  = cl.centerLineType === 'X';
    const isH  = cl.centerLineType === 'Y';
    const dist = isV ? Math.abs(cl.value - wx) * scaleX
               : isH ? Math.abs(cl.value - wy) * scaleY
               : Infinity;
    if (dist >= thresholdPx || dist >= minDist) continue;
    // ラベルなしCL: extentLo/Hi が設定されていれば描画範囲（オーバーハング込み）外を除外
    if (!cl.labeled && cl.extentLo != null && cl.extentHi != null) {
      const along    = isV ? wy : wx;
      const overhang = viewport ? overhangMm(viewport, cl.trim) : 0;
      if (along < cl.extentLo - overhang || along > cl.extentHi + overhang) continue;
    }
    minDist = dist;
    nearest = cl;
  }
  return nearest;
}

/**
 * カーソルに最も近い、非ラベルCL（中心・補助線）の端点を返す（延長/短縮メニュー用）。
 * 端点は描画上の突端（extentLo-overhang / extentHi+overhang）で判定する。
 * 通り芯（labeled:true）・RADIAL・extentLo/Hi未確定のCLは対象外。
 * @returns {{cl, side:'lo'|'hi'}|null}
 */
export function findNearestCenterLineEndpoint(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport) {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (cl.labeled) continue;
    const isV = cl.centerLineType === 'X';
    const isH = cl.centerLineType === 'Y';
    if (!isV && !isH) continue;
    if (cl.extentLo == null || cl.extentHi == null) continue;
    const overhang = overhangMm(viewport, cl.trim);
    const tips = [
      { side: 'lo', along: cl.extentLo - overhang },
      { side: 'hi', along: cl.extentHi + overhang },
    ];
    for (const { side, along } of tips) {
      const tx = isV ? cl.value : along;
      const ty = isV ? along    : cl.value;
      const dist = Math.hypot((tx - wx) * scaleX, (ty - wy) * scaleY);
      if (dist < thresholdPx && dist < minDist) { minDist = dist; nearest = { cl, side }; }
    }
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
  return [lo, hi];
}

/**
 * カーソルに最も近い壁を返す（開口配置の長押し検出用）。
 * 自動生成壁（isRoomWall）のみを対象とする — 現行UIには壁の手描きツールが
 * 存在しないため、レガシーインポートデータ由来の isRoomWall:false 壁を
 * 開口のホスト候補から確実に除外する。
 */
export function findNearestWall(graph, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const w of graph.walls) {
    if (!w.isRoomWall) continue;
    const perp = w.isVertical ? Math.abs(w.axisValue - wx) * scaleX : Math.abs(w.axisValue - wy) * scaleY;
    if (perp >= thresholdPx || perp >= minDist) continue;
    const along = w.isVertical ? wy : wx;
    const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
    if (along < lo || along > hi) continue;
    minDist = perp; nearest = w;
  }
  return nearest;
}

/** カーソルに最も近い既存開口を返す（編集・削除メニュー用）。 */
export function findOpeningAt(graph, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  for (const o of graph.openings) {
    const host = findHostWall(o, graph);
    if (!host) continue;
    const perp = o.isVertical ? Math.abs(host.axisValue - wx) * scaleX : Math.abs(host.axisValue - wy) * scaleY;
    if (perp >= thresholdPx) continue;
    const along = o.isVertical ? wy : wx;
    if (along < o.coord1 || along > o.coord2) continue;
    return o;
  }
  return null;
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
