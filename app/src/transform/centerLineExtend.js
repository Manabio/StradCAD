// 中心線・補助線（labeled:false）の端点延長・端点短縮。
//
// 「隣のCL」= 自身に直交し、自身の座標(value)を範囲内に含むCL（ラベルCLは無条件）。
// 延長は現在の extentLo/Hi の外側、短縮は内側（反対側の境界を越えない範囲）でこれを探す。
// 補助線(aux)の延長は壁も境界候補に含める（AddCLDialog の作成ロジックと同じ非対称性）。
// 短縮は壁を対象にしない（自身の直交CLのみ、1つ内側の交点まで）。
import { CenterLineType, centerLineKind } from '@core';
import { overhangMm } from '../snapGeometry.js';
import { mergeCenterLineChain } from './centerLineMerge.js';

function perpTypeOf(cl) {
  return cl.centerLineType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
}

// 端点判定の座標一致許容誤差(mm)。端点は直交CLの value を直接コピーして作られるため
// 実質同値の比較だが、旧データの丸め誤差を吸収する余裕を持たせる。
const ENDPOINT_EPS = 0.5;

/**
 * 中心線の lo/hi 側の端が「端点」かどうかを判定する（端点ルール）。
 *
 * 中心線の端は通常、直交CLとの交差（交点）上に乗る。線分編集（直交CLの短縮・削除）で
 * 交差が失われた端は「端点」となり、延長・短縮の対象から外れ、座標がその場に固定される。
 * 補助線はオーバーハング付きの静的端点が正規状態のため対象外（常に false）。
 */
export function isEndpointAt(graph, cl, side) {
  const kind = centerLineKind(cl);
  if (kind !== 'center' && kind !== 'beam') return false;
  const coord = side === 'lo' ? cl.extentLo : cl.extentHi;
  if (coord == null) return false;
  const perpType = perpTypeOf(cl);
  const wc = cl.value;
  return !graph.centerLines.some(other => {
    if (other.id === cl.id || other.centerLineType !== perpType) return false;
    if (Math.abs(other.value - coord) > ENDPOINT_EPS) return false;
    // その直交CLが自身の位置まで届いている（交差している）こと
    if (other.labeled || other.extentLo == null || other.extentHi == null) return true;
    return other.extentLo - ENDPOINT_EPS <= wc && wc <= other.extentHi + ENDPOINT_EPS;
  });
}

// coord より 'lo' 側(小さい)/'hi' 側(大きい)で最も近い候補を返す（getValue で値を取り出す）
function nearestBeyond(items, coord, direction, getValue) {
  let best = null, bestVal = null;
  for (const item of items) {
    const v = getValue(item);
    if (direction === 'lo' ? v < coord : v > coord) {
      if (best == null || (direction === 'lo' ? v > bestVal : v < bestVal)) { best = item; bestVal = v; }
    }
  }
  return best;
}

// 自身(cl)の座標を範囲内に含む直交CLを列挙する
function crossingPerpCLs(graph, cl) {
  const perpType = perpTypeOf(cl);
  const wc = cl.value;
  return graph.centerLines.filter(other => {
    if (other.id === cl.id || other.centerLineType !== perpType) return false;
    if (!other.labeled && other.extentLo != null && other.extentHi != null) {
      if (wc < other.extentLo || wc > other.extentHi) return false;
    }
    return true;
  });
}

// 自身(cl)の座標を範囲内に含む直交壁を列挙する（aux延長のみで使用）
function crossingPerpWalls(graph, cl) {
  const isV = cl.centerLineType === CenterLineType.VERTICAL;
  const wc  = cl.value;
  return graph.walls.filter(w => {
    if (w.isVertical === isV) return false;
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    return c1 <= wc && wc <= c2;
  });
}

// 他の補助線が target を extentLoRef/HiRef で既に参照しているか（AddCLDialog と同じ判定）
function anyAuxRefsCL(graph, target) {
  return graph.centerLines.some(ex =>
    ex.lineType === 'dashed' && !ex.labeled &&
    (ex.extentLoRef?.clId === target.id || ex.extentHiRef?.clId === target.id)
  );
}

// side側の外側で最も近い境界（CLまたは壁）を探す。無ければ null（延長不可）。
export function findExtendBoundary(graph, cl, side) {
  const coord     = side === 'lo' ? cl.extentLo : cl.extentHi;
  const direction = side; // lo側の外側 = coordより小さい値、hi側の外側 = coordより大きい値
  const clCandidate = nearestBeyond(crossingPerpCLs(graph, cl), coord, direction, c => c.value);
  let wallCandidate = null;
  if (centerLineKind(cl) === 'aux') {
    wallCandidate = nearestBeyond(crossingPerpWalls(graph, cl), coord, direction, w => w.axisValue);
  }
  if (clCandidate && wallCandidate) {
    const clDist = Math.abs(clCandidate.value - coord);
    const wallDist = Math.abs(wallCandidate.axisValue - coord);
    return wallDist <= clDist ? { type: 'wall', item: wallCandidate } : { type: 'cl', item: clCandidate };
  }
  if (wallCandidate) return { type: 'wall', item: wallCandidate };
  if (clCandidate)   return { type: 'cl',   item: clCandidate };
  return null;
}

// side側の内側（反対側の境界を越えない範囲）で最も近い直交CLを探す。
// 見つからない場合、まだ1点線分（extentLo===extentHi）でなければ反対側の端点まで
// 縮めて1点線分にする（最小短縮単位）。既に1点線分なら null（短縮不可＝削除）。
export function findShortenBoundary(graph, cl, side) {
  const currentLo = cl.extentLo, currentHi = cl.extentHi;
  if (currentLo === currentHi) return null;
  const coord     = side === 'lo' ? currentLo : currentHi;
  const direction = side === 'lo' ? 'hi' : 'lo'; // lo側は内側=coordより大きい値、hi側は内側=coordより小さい値
  const candidate = nearestBeyond(crossingPerpCLs(graph, cl), coord, direction, c => c.value);
  const withinRange = candidate && (side === 'lo' ? candidate.value < currentHi : candidate.value > currentLo);
  if (withinRange) return { type: 'cl', item: candidate };
  return { type: 'point' };
}

// 端点（交点を失った端）は延長・短縮の対象にならない（端点ルール）
export function canExtendCenterLine(graph, cl, side)  { return !isEndpointAt(graph, cl, side) && !!findExtendBoundary(graph, cl, side); }
export function canShortenCenterLine(graph, cl, side) { return !isEndpointAt(graph, cl, side) && !!findShortenBoundary(graph, cl, side); }

// side側の端点を隣のCL（または壁）まで延長する。延長後、同種同軸のCLと端点が一致すれば結合する。
export function extendCenterLine(graph, cl, side, viewport) {
  if (isEndpointAt(graph, cl, side)) return { extended: false };
  const boundary = findExtendBoundary(graph, cl, side);
  if (!boundary) return { extended: false };

  const kind          = centerLineKind(cl);
  const beforeRef     = side === 'lo' ? cl.extentLoRef : cl.extentHiRef;
  const beforeStatic  = side === 'lo' ? cl._extentLo    : cl._extentHi;
  let ref = null, staticValue = null;

  if (boundary.type === 'wall') {
    ref = { wallId: boundary.item.id };
  } else if (kind === 'aux' && !anyAuxRefsCL(graph, boundary.item)) {
    const overhang = overhangMm(viewport, cl.trim);
    staticValue = boundary.item.value + (side === 'lo' ? -overhang : overhang);
  } else {
    ref = { clId: boundary.item.id, offset: 0 };
  }

  graph.setCenterLineExtentRef(cl, side, ref, staticValue);
  const chainResult = mergeCenterLineChain(graph, cl, { kind });

  return {
    extended: true,
    baseUndo: () => graph.setCenterLineExtentRef(cl, side, beforeRef, beforeStatic),
    baseRedo: () => graph.setCenterLineExtentRef(cl, side, ref, staticValue),
    chainResult,
  };
}

// side側の端点を1つ内側のCLまで短縮する（はね出しあり）。中心線は参照先へ厳密に接続する。
// 内側にCLが無ければ、反対側の端点と全く同じ参照/値をコピーして1点線分（最小短縮単位）にする
// ——反対側が参照先を持つ場合は同じ参照を共有させ、後で参照先が動いても常に1点であり続ける。
export function shortenCenterLine(graph, cl, side, viewport) {
  if (isEndpointAt(graph, cl, side)) return { shortened: false };
  const boundary = findShortenBoundary(graph, cl, side);
  if (!boundary) return { shortened: false };

  const kind          = centerLineKind(cl);
  const beforeRef     = side === 'lo' ? cl.extentLoRef : cl.extentHiRef;
  const beforeStatic  = side === 'lo' ? cl._extentLo    : cl._extentHi;
  let ref = null, staticValue = null;

  if (boundary.type === 'point') {
    const opposite = side === 'lo' ? 'hi' : 'lo';
    ref         = opposite === 'lo' ? cl.extentLoRef : cl.extentHiRef;
    staticValue = opposite === 'lo' ? cl._extentLo    : cl._extentHi;
  } else if (kind === 'center' || kind === 'beam') {
    ref = { clId: boundary.item.id, offset: 0 };
  } else {
    const overhang = overhangMm(viewport, cl.trim);
    staticValue = boundary.item.value + (side === 'lo' ? -overhang : overhang);
  }

  graph.setCenterLineExtentRef(cl, side, ref, staticValue);

  return {
    shortened: true,
    baseUndo: () => graph.setCenterLineExtentRef(cl, side, beforeRef, beforeStatic),
    baseRedo: () => graph.setCenterLineExtentRef(cl, side, ref, staticValue),
  };
}
