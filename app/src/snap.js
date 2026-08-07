// スナップ計算はすべてスクリーン空間距離 (px) で判定する。
// threshold は px 単位で渡し、ワールド差分に scaleX/Y を掛けてスクリーン距離に換算する。
import { spatialIndex } from './store.js';
import { findHostWall } from './openings/openingGeometry.js';
import { centerLineKind, CenterLineType } from './core.js';
import { inGutter as isInGutter } from './layout.js';
// overhangMm・findBracketingCLs は spatialIndex/store に依存しない純関数のため snapGeometry.js へ
// 分離済み（node:test から store非依存で import したいモジュール向け）。ここでは同名を再エクスポートし、
// 既存の import 元（App.jsx 等）を壊さない。
import { overhangMm, findBracketingCLs } from './snapGeometry.js';
export { overhangMm, findBracketingCLs };

// ポインタ位置スナップ判定のスクリーン距離しきい値 (px)
export const SNAP_THRESHOLD_PX = 20;
export const CL_THRESHOLD_PX   = 8;
export const WALL_THRESHOLD_PX = 8;

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
 * kindFilter(centerLineKind(cl)) が true の種別だけを対象にする（既定は梁芯を除外＝非構造モード用。
 * 構造モードの呼び出し元は `k => k === 'beam'` を渡し、梁芯だけをヒットテスト対象にする——
 * 「通り芯上でマウスが反応しない」既存仕様は維持しつつ、梁芯だけは選択・削除・延長/短縮できるようにする
 * ため appMode で無条件 null にせず kindFilter で絞る（App.jsx updateSnap 参照）。
 */
export function findNearestCenterLine(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport = null, kindFilter = k => k !== 'beam') {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (!kindFilter(centerLineKind(cl))) continue;
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
 * カーソルに最も近い、非ラベルCL（中心・補助線・梁芯）の端点を返す（延長/短縮メニュー用）。
 * 端点は描画上の突端（extentLo-overhang / extentHi+overhang）で判定する。
 * 通り芯（labeled:true）・RADIAL・extentLo/Hi未確定のCLは対象外。kindFilterは findNearestCenterLine
 * と同じ規約（既定は梁芯を除外、構造モードは `k => k === 'beam'` で梁芯だけに絞る）。
 * @returns {{cl, side:'lo'|'hi'}|null}
 */
export function findNearestCenterLineEndpoint(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport, kindFilter = k => k !== 'beam') {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (cl.labeled || !kindFilter(centerLineKind(cl))) continue;
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
 * 中心線移動中、同種の他中心線へのスナップ値を返す（平面モードの通り芯・中心線・補助線が対象）。
 * 梁芯（centerLineKind==='beam'）は対象から無条件除外する——通り芯・他の梁芯の値は梁芯の移動範囲
 * （structural/beamAxisMove.js beamAxisMoveRange）にとって到達不能な禁止位置（他種別CLと同位置に
 * 共存不可という追加時ガードに抵触するため）で、吸着先として意味的に間違っている。梁芯の移動は
 * 専用の findBeamAxisMoveSnap を使う（呼び出し元 App.jsx が centerLineKind(cl)==='beam' で呼び分ける）。
 */
export function findCLMoveSnap(graph, movingCL, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  const isV   = movingCL.centerLineType === 'X';
  const scale = isV ? scaleX : scaleY;
  const coord = isV ? wx : wy;
  let best = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (cl.id === movingCL.id || cl.centerLineType !== movingCL.centerLineType) continue;
    if (centerLineKind(cl) === 'beam') continue;
    const dist = Math.abs(cl.value - coord) * scale;
    if (dist < thresholdPx && dist < minDist) { minDist = dist; best = cl.value; }
  }
  return best;
}

/**
 * 梁芯CL（centerLineKind==='beam'）移動中のスナップ値を返す。findCLMoveSnap と違い通り芯・他の梁芯の
 * 値そのものへは吸着しない（beamAxisMoveRange が到達不能にしている禁止位置のため）。吸着先は「両隣の
 * 障害物（通り芯・他の梁芯）に挟まれた区間」の中点・3等分点（1/3, 2/3）——「大梁間の中央に小梁1本」
 * 「小梁2本を等間隔」という実務上よくある配置。障害物の定義は beamAxisMoveRange と同じ（同じ
 * centerLineType・自分以外・labeled または他の梁芯）だが、レイヤ分離（snap.js は structural/ に依存
 * しない）のため実装は独立に持つ。中心線・補助線（labeled:falseの通常CL）とは同位置に到達し得るが、
 * 小梁の生成はhost（大梁の有無）だけで決まるため実害はない（beamAxisMoveRange参照）。
 * 等ピッチスナップ（3本以上）・複数梁芯の一括移動は次フェーズ（.claude/structural-model.md参照）。
 */
export function findBeamAxisMoveSnap(graph, movingCL, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  const isV   = movingCL.centerLineType === 'X';
  const scale = isV ? scaleX : scaleY;
  const coord = isV ? wx : wy;
  let lo = -Infinity, hi = Infinity;
  for (const other of graph.centerLines) {
    if (other.id === movingCL.id || other.centerLineType !== movingCL.centerLineType) continue;
    if (!(other.labeled || centerLineKind(other) === 'beam')) continue;
    const v = other.effectiveValue;
    if (v < movingCL.value) { if (v > lo) lo = v; }
    else if (v > movingCL.value) { if (v < hi) hi = v; }
  }
  if (lo === -Infinity || hi === Infinity) return null; // 片側に障害物が無ければ中点・3等分点は定義できない
  const candidates = [(lo + hi) / 2, lo + (hi - lo) / 3, lo + (hi - lo) * 2 / 3];
  let best = null, minDist = Infinity;
  for (const v of candidates) {
    const dist = Math.abs(v - coord) * scale;
    if (dist < thresholdPx && dist < minDist) { minDist = dist; best = v; }
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

/**
 * ポインタ位置（クライアント座標）から交点スナップ・近傍CL/CL端点/壁/開口の候補を解決する
 * （App.jsx updateSnap の「候補解決」部分。setState への反映は呼び出し側の責務）。
 * ガター帯（描画エリア外周）内は全候補 null・world null を返す。
 * appMode==='structure' のときは梁芯のみ、それ以外は梁芯以外を CL/CL端点の対象にする
 * （findNearestCenterLine 等の kindFilter 既定値と同じ規約）。
 * 交点スナップ中は CL/開口/壁の検出をスキップし、CL端点も返さない（候補計算自体は走るが結果は捨てる）。
 * CL・開口・壁は画面距離が最も近い候補のみを残す排他選択（同距離は cl > opening > wall）。
 * @returns {{ snap, nearCL, nearCLEndpoint, nearWall, nearOpening, world }}
 */
export function resolvePointerTargets(graph, viewport, clientX, clientY, opts = {}) {
  const { width, height, appMode } = opts;
  if (isInGutter(clientX, clientY, width, height)) {
    return { snap: null, nearCL: null, nearCLEndpoint: null, nearWall: null, nearOpening: null, world: null };
  }
  const world = viewport.screenToWorld(clientX, clientY);
  const snap  = findNearestIntersection(graph, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
  const clKindFilter = appMode === 'structure' ? (k => k === 'beam') : (k => k !== 'beam');
  const clEndpointCand = findNearestCenterLineEndpoint(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, clKindFilter);
  let cl = null, opening = null, wall = null;
  if (!snap) {
    const clCand      = findNearestCenterLine(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, clKindFilter);
    const openingCand = findOpeningAt(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
    const wallCand    = findNearestWall(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
    const candidates = [];
    if (clCand) {
      const isV = clCand.centerLineType === CenterLineType.VERTICAL;
      const dist = isV ? Math.abs(clCand.value - world.x) * viewport.scaleX : Math.abs(clCand.value - world.y) * viewport.scaleY;
      candidates.push({ type: 'cl', value: clCand, dist });
    }
    if (openingCand) {
      const host = findHostWall(openingCand, graph);
      if (host) {
        const dist = host.isVertical ? Math.abs(host.axisValue - world.x) * viewport.scaleX : Math.abs(host.axisValue - world.y) * viewport.scaleY;
        candidates.push({ type: 'opening', value: openingCand, dist });
      }
    }
    if (wallCand) {
      const dist = wallCand.isVertical ? Math.abs(wallCand.axisValue - world.x) * viewport.scaleX : Math.abs(wallCand.axisValue - world.y) * viewport.scaleY;
      candidates.push({ type: 'wall', value: wallCand, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const nearest = candidates[0] ?? null;
    if (nearest?.type === 'cl')      cl = nearest.value;
    if (nearest?.type === 'opening') opening = nearest.value;
    if (nearest?.type === 'wall')    wall = nearest.value;
  }
  return {
    snap: snap ?? null,
    nearCL: cl ?? null,
    nearCLEndpoint: !snap ? (clEndpointCand ?? null) : null,
    nearWall: wall ?? null,
    nearOpening: opening ?? null,
    world,
  };
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
