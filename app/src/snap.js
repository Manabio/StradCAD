// スナップ計算はすべてスクリーン空間距離 (px) で判定する。
// threshold は px 単位で渡し、ワールド差分に scaleX/Y を掛けてスクリーン距離に換算する。
import { spatialIndex } from './store.js';
import { findHostWall, nearestWallHit } from './openings/openingGeometry.js';
import { CenterLineType } from './core.js';
import { inGutter as isInGutter } from './layout.js';
import { hitTestKinds } from './core/centerLineKindPolicy.js';
// CENTER寸法「足」上の端点ヒットは、描画（renderer/GutterLayer.jsx CenterDimensions）と単一の
// 真実源を共有する必要がある（幅・高さ依存の areaBounds/lineCoord クランプを含むため snapGeometry.js
// の純モジュール規約=静的importは./core.jsのみ、には置けない）。renderer/gutterLabelHits.js
// （react-konva非依存の純関数レイヤ）から直接 import する。
import { findCenterDimensionLegEndpoint } from './renderer/gutterLabelHits.js';
// overhangMm・findBracketingCLs・nonLabeledClExtent・findNearestCenterLine・findNearbyCenterLines・
// findNearestCenterLineEndpoint・findCLMoveSnap・findBeamAxisMoveSnap は spatialIndex/store に
// 依存しない純関数のため snapGeometry.js へ分離済み（node:test から store非依存で import したい
// モジュール向け。findNearestCenterLine・findNearbyCenterLines はステップ6・2026-09-20移行——
// hitTestKinds(appMode) との4種別×6モード突き合わせテスト・実データprobeのため）。ここでは同名を
// 再エクスポートし、既存の import 元（App.jsx・interaction/usePointerInteraction.js 等）を壊さない。
import {
  overhangMm, findBracketingCLs, nonLabeledClExtent, findNearestCenterLine, findNearbyCenterLines,
  findNearestCenterLineEndpoint, findCLMoveSnap, findBeamAxisMoveSnap,
} from './snapGeometry.js';
export {
  overhangMm, findBracketingCLs, nonLabeledClExtent, findNearestCenterLine, findNearbyCenterLines,
  findNearestCenterLineEndpoint, findCLMoveSnap, findBeamAxisMoveSnap,
};

// ポインタ位置スナップ判定のスクリーン距離しきい値 (px)
export const SNAP_THRESHOLD_PX = 20;
export const CL_THRESHOLD_PX   = 8;
export const WALL_THRESHOLD_PX = 8;
// 壁ラジアルのヒット域のうち、面線から材側（軸CL方向）への許容(px)。壁線には描画上の太さが
// あるため、面線から見て部屋側の判定（差>=0）だけだと線をわずかに内側へ外しただけで通り芯
// メニューに落ちてしまう。WALL_THRESHOLD_PXより小さい値にし、かつ isWallRadialHit 側で
// 面線〜軸CLの距離とのmin(）を取ることで壁の真ん中（軸CL）には決して届かないようにする。
export const WALL_LINE_INWARD_PX = 2;

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
 * カーソルに最も近い壁を返す（開口配置の長押し検出用。腰壁・垂れ壁メニュー・カーソル pointer
 * 表示も同じ結果を使う——単一のヒット判定なので用途によって挙動を分けない）。
 * 自動生成壁（isRoomWall）のみを対象とする — 現行UIには壁の手描きツールが
 * 存在しないため、レガシーインポートデータ由来の isRoomWall:false 壁を
 * 開口のホスト候補から確実に除外する。
 * ヒット域は「壁線とその近傍」——壁線そのものを含むため、部屋側は WALL_THRESHOLD_PX まで、
 * 材側（軸CL方向）は WALL_LINE_INWARD_PX までのわずかな許容を持つが、壁の真ん中（軸CL位置）
 * には決して届かない（isWallRadialHit がクランプする）。軸CL位置は通り芯のメニューに譲る。
 * 詳細は .claude/opening-model.md 参照。本体は nearestWallHit（node:test 単体テスト対応の
 * ため純関数として openingGeometry.js に置く）。
 *
 * findOpeningAt（開口の当たり判定）は非対称——WALL_THRESHOLD_PXのみで材側許容を持たない
 * （開口自体には「材の中」という概念がない）。そのため材側許容域では、開口の上ならOPENINGメニュー
 * が出るが、隣の無地の壁面では出ない、という差が生じるが仕様として許容する。
 */
export function findNearestWall(graph, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  return nearestWallHit(graph.walls, wx, wy, thresholdPx, scaleX, scaleY, WALL_LINE_INWARD_PX);
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

// CL端点候補の垂直距離（isV:X距離／isH:Y距離）。findNearestCenterLineEndpoint（突端円・はね出し
// 線分）と findCenterDimensionLegEndpoint（CENTER寸法の足）、由来の異なる2つの端点候補を
// 「垂直距離が小さい方」で比較するための共通の物差し（cl.value基準、両関数の内部判定式と同じ）。
function clEndpointPerpDist(cl, wx, wy, scaleX, scaleY) {
  const isV = cl.centerLineType === CenterLineType.VERTICAL;
  return isV ? Math.abs(cl.value - wx) * scaleX : Math.abs(cl.value - wy) * scaleY;
}

/**
 * ポインタ位置（クライアント座標）から交点スナップ・近傍CL/CL端点/壁/開口の候補を解決する
 * （interaction/usePointerInteraction.js updateSnap の「候補解決」部分。setState への反映は呼び出し側の責務）。
 * ガター帯（描画エリア外周）内は全候補 null・world null を返す。
 * CL/CL端点の対象種別は core/centerLineKindPolicy.js hitTestKinds(appMode) に一本化——
 * appMode==='structure' なら梁芯のみ、floorplan/finish/opening なら通り芯・中心線・補助線
 * （梁芯は除外）。site/elevation は hitTestKinds が空集合になる（可視モード表＝VISIBLE_KINDS_BY_MODE
 * が空のため）——唯一の呼び出し元 interaction/usePointerInteraction.js updateSnap は、site は
 * ホイールズーム経由でのみ本関数へ到達し、その結果（nearCL 等）を参照するカーソル・メニューは
 * site では別分岐に倒れて未使用、elevation は本関数へ到達する経路自体が無い（専用画面の早期
 * return。pointerDown/Move が appMode==='elevation' で updateSnap を一切呼ばない）——ため、可視
 * モード表に揃えても実際の挙動（カーソル・メニュー）は変わらない。呼び出し元は appMode に常に
 * 既知の値（APP_MODES のいずれか）を渡す（App.jsx の useState 初期値・モード切替経路のいずれも
 * 未知値を作らない）ため、hitTestKinds の未知 appMode throw は本経路では発生しない。
 * 交点スナップ中は CL/開口/壁の検出をスキップし、CL端点も返さない（候補計算自体は走るが結果は捨てる）。
 * CL・開口・壁は画面距離が最も近い候補のみを残す排他選択（同距離は cl > opening > wall）。
 * CL端点は「突端円・はね出し線分」（findNearestCenterLineEndpoint）と「CENTER寸法の足」
 * （findCenterDimensionLegEndpoint。columnAxisMode中は常にnull＝柱芯行に専有され足が存在しない）の
 * 2種のヒット候補を持ち、両方ヒットした場合は垂直距離が小さい方を採用する。
 * @returns {{ snap, nearCL, nearCLEndpoint, nearWall, nearOpening, world }}
 */
export function resolvePointerTargets(graph, viewport, clientX, clientY, opts = {}) {
  const { width, height, appMode, columnAxisMode } = opts;
  if (isInGutter(clientX, clientY, width, height)) {
    return { snap: null, nearCL: null, nearCLEndpoint: null, nearWall: null, nearOpening: null, world: null };
  }
  const world = viewport.screenToWorld(clientX, clientY);
  const snap  = findNearestIntersection(graph, world.x, world.y, SNAP_THRESHOLD_PX, viewport.scaleX, viewport.scaleY);
  // hitTestKinds(appMode) は走査前に1回だけ呼ぶ（CLごとに新しい配列を作らない。未知appModeのthrowも
  // 走査前に出る）。
  const hitKinds = hitTestKinds(appMode);
  const clKindFilter = k => hitKinds.includes(k);
  const clEndpointTip = findNearestCenterLineEndpoint(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, clKindFilter);
  const clEndpointLeg = findCenterDimensionLegEndpoint(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, width, height, appMode, columnAxisMode);
  let clEndpointCand = clEndpointTip;
  if (clEndpointLeg && (!clEndpointTip
    || clEndpointPerpDist(clEndpointLeg.cl, world.x, world.y, viewport.scaleX, viewport.scaleY)
     < clEndpointPerpDist(clEndpointTip.cl, world.x, world.y, viewport.scaleX, viewport.scaleY))) {
    clEndpointCand = clEndpointLeg;
  }
  let cl = null, opening = null, wall = null;
  if (!snap) {
    const clCand      = findNearestCenterLine(graph, world.x, world.y, CL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY, viewport, clKindFilter);
    // 構造モードは壁・建具を一切描画しない（renderer/SceneLayers.jsx）ため、候補解決の段階で
    // 平面要素（壁・開口）を丸ごと対象外にする——部材ごとにメニュー項目を間引く方式では、
    // 柱の上の長押しで建具ラジアルが出る等の取りこぼしが残り、カーソルの pointer 表示（App.jsx）も
    // 見えない壁に反応してしまう。モード単位の一箇所で塞ぐのがこの規律の単一の真実源。
    const planTargets = appMode !== 'structure';
    const openingCand = planTargets ? findOpeningAt(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY) : null;
    const wallCand    = planTargets ? findNearestWall(graph, world.x, world.y, WALL_THRESHOLD_PX, viewport.scaleX, viewport.scaleY) : null;
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
