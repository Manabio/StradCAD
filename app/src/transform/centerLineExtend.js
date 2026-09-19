// 中心線・補助線・梁芯の端点延長・端点短縮。
//
// 「隣のCL」= 自身と直交し、自身の種別から見て直交端部のアンカーになりうる種別で、かつ自身の座標
// (value)まで extent が届いている CL（core/centerLineKindPolicy.js の orthoAnchorCandidates。
// どの種別がどの種別を相手にするかは同ファイルの ORTHO_ANCHOR_OVERRIDE / COEXISTENCE 系の表が
// 唯一の真実源）。中心線・補助線は 通り芯・中心線・補助線 を相手にする（梁芯は相手にしない——
// 梁芯は下階の壁からも自階へ自動生成され平面モードでは非表示のため、これを境界にすると「画面に
// 何も無いのに延長・短縮が途中で止まる」体験になる）。梁芯は 通り芯のみ を相手にする（2026-09-18
// 裁定。中心線・補助線まで相手にすると、追加時に回避したはずの小梁0本事故の経路が延長・短縮側にも
// 残ってしまうため、追加extentと同じ「通り芯のみ」に揃える）。
// 延長は現在の extentLo/Hi の外側、短縮は内側（反対側の境界を越えない範囲）でこれを探す。
// 補助線(aux)の延長は壁も境界候補に含める（AddCLDialog の作成ロジックと同じ非対称性）。
// 短縮は壁を対象にしない（自身の直交CLのみ、1つ内側の交点まで）。
// RADIAL は対象外（isOrthoAnchorCandidateがRADIALを主体・相手どちらでも除外する）。旧実装
// （crossingPerpCLsのperpTypeOf）はRADIAL主体にVERTICALを直交型として走査していたが、UI経路
// （snapGeometry.js findNearestCenterLineEndpoint）がRADIALを候補から弾くため、この関数群に
// RADIALのCLが渡ってくること自体が無く到達不能——挙動としては変わらない。
// 旧データ（labeled:trueなのに種別が通り芯でないCL。通常のAddCLDialog経路では作られない異常値）は
// 移行前後で以下2通りの扱いが変わる（いずれも現行の生成経路は0件で理論上の差分）:
//   ・主体が中心線・補助線、相手が labeled:true の梁芯（本来 discipline:'fuse'）→ 除外へ
//     （orthoAnchorKindsが種別ベースで梁芯を弾くため。旧実装はlabeled:trueを無条件に「届いている」
//       扱いにしていた）。
//   ・主体が梁芯、相手が labeled:true の中心線・補助線 → 除外へ（同上。梁芯の相手は通り芯のみ）。
import { CenterLineType, centerLineKind } from '@core';
import { overhangMm } from '../snapGeometry.js';
import { mergeCenterLineChain } from './centerLineMerge.js';
import {
  hasEndpointRule, allowsWallAnchor, extentAnchorStyle, coversAlongAxis, orthoAnchorCandidates,
  isReferencedByAux,
} from '../core/centerLineKindPolicy.js';

// 端点判定の座標一致許容誤差(mm)。端点は直交CLの value を直接コピーして作られるため
// 実質同値の比較だが、旧データの丸め誤差を吸収する余裕を持たせる。
const ENDPOINT_EPS = 0.5;

/**
 * 中心線の lo/hi 側の端が「端点」かどうかを判定する（端点ルール）。
 *
 * 中心線の端は通常、直交CLとの交差（交点）上に乗る。線分編集（直交CLの短縮・削除）で
 * 交差が失われた端は「端点」となり、延長・短縮の対象から外れ、座標がその場に固定される。
 * 補助線はオーバーハング付きの静的端点が正規状態のため対象外（常に false。hasEndpointRule）。
 *
 * 参照先優先: side側の extentLoRef/HiRef が指す解決済み参照先CL（cl._extentLoCL/_extentHiCL。
 * core/clRefResolve.js が addCenterLine・restoreGraph 時に解決するキャッシュ）が graph.centerLines
 * に生きて存在し（graph.shapeMap ではなく graph.centerLines を見る——通り芯は structGraph 側にあり
 * 自階 shapeMap には無いため。同一オブジェクト参照 or 同 id のどちらかで判定）、かつ自身の座標まで
 * 届いていれば、種別述語走査より先に「端点でない」と判定する。既に非表示の梁芯まで延長済みの
 * データが端点に固定され続けず、次の延長操作で可視の線へ自然に移る自己修復になる
 * （データを正規化はしない——読み込んだだけでは書き換えない）。
 * `{wallId}` 参照（cl._extentLoWall/_extentHiWall）は見ない——wallId参照は aux 専用
 * （WALL_ANCHOR_KINDS）だが、aux は上の hasEndpointRule 判定で既に false を返し関数を抜けているため、
 * ここへは到達しない。
 */
export function isEndpointAt(graph, cl, side) {
  const kind = centerLineKind(cl);
  if (!hasEndpointRule(kind)) return false;
  const coord = side === 'lo' ? cl.extentLo : cl.extentHi;
  if (coord == null) return false;

  const refCL = side === 'lo' ? cl._extentLoCL : cl._extentHiCL;
  if (refCL
    && graph.centerLines.some(c => c === refCL || c.id === refCL.id)
    && coversAlongAxis(refCL, cl.value, ENDPOINT_EPS)) {
    return false;
  }

  return !orthoAnchorCandidates(graph, cl, { tolMm: ENDPOINT_EPS })
    .some(other => Math.abs(other.value - coord) <= ENDPOINT_EPS);
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

// side側の外側で最も近い境界（CLまたは壁）を探す。無ければ null（延長不可）。
export function findExtendBoundary(graph, cl, side) {
  const coord     = side === 'lo' ? cl.extentLo : cl.extentHi;
  const direction = side; // lo側の外側 = coordより小さい値、hi側の外側 = coordより大きい値
  const clCandidate = nearestBeyond(orthoAnchorCandidates(graph, cl), coord, direction, c => c.value);
  let wallCandidate = null;
  if (allowsWallAnchor(centerLineKind(cl))) {
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
  const candidate = nearestBeyond(orthoAnchorCandidates(graph, cl), coord, direction, c => c.value);
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
  } else if (extentAnchorStyle(kind) === 'overhang' && !isReferencedByAux(graph, boundary.item)) {
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

// side側の端点を1つ内側のCLまで短縮する（はね出しあり）。中心線・梁芯は参照先へ厳密に接続する。
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
  } else if (extentAnchorStyle(kind) === 'ref') {
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
