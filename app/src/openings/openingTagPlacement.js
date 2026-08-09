// ================================================================
// 建具記号丸（円に直径横線＋上段記号・下段番号）の配置計算（純関数）。
//
// 表示可否・アンカー位置（窓＝室内側オフセット／開き戸＝動作扇形の重心）・
// ドア円弧同士の反転・格子探索による重なり回避までをここで完結させ、
// renderer/OpeningTagLayer.jsx は viewport 由来の px→mm 換算と Konva 描画のみを担う
// （node:test から viewport/react-konva 抜きで単体テストできるようにするため）。
//
// 純モジュール: viewport・store・.jsx を静的 import しない（半径・余白・格子ピッチは
// mm の数値で受け取る）。設計意図は .claude/opening-model.md 参照。
// ================================================================

import { findHostWall, wallFaceRange, wallWorldRect, wallFaceDir } from './openingGeometry.js';
import { findCatalogEntry, OpeningMechanism } from './openingCatalog.js';
// viewport.js は mobx と @core しか import しない純モジュールのため、node:test 単体import制約
// （store.js/snap.js/.jsx を静的に引かない）に抵触しない（前例: finish/stair/stairEntries.js:6）。
import { LodLevel } from '../viewport.js';

/** floorplanモードはDETAILのみ、openingモードはSTANDARD・DETAILのみ表示する。 */
export function shouldShowOpeningTags(appMode, lodLevel) {
  if (appMode === 'floorplan') return lodLevel === LodLevel.DETAIL;
  if (appMode === 'opening')   return lodLevel === LodLevel.STANDARD || lodLevel === LodLevel.DETAIL;
  return false;
}

// 長さ方向(along)・直交方向(perp)のワールド座標 → {x, y}（OpeningsLayer.jsx の toWorld と同じ変換）。
function toWorld(isVertical, along, perp) {
  return isVertical ? { x: perp, y: along } : { x: along, y: perp };
}

/**
 * 部屋内側の向き（±1）。
 * CL偏芯壁では axisOffset の符号がそのまま「面がどちら向きか」の代理にならないため
 * （wall.js:82-84 materialRange と同じ理由）、finishSide 明示指定を優先し、無ければ
 * axisValue と axisCL.effectiveValue の差の符号（faceDir）から仕上げ面の向きを求め、
 * 外壁はその逆（室内は常に軸CLへ向かう側）とする。
 */
export function roomSideDir(opening, host) {
  const faceDir = wallFaceDir(host, opening.wallSide || 1);
  return host.isExteriorWall ? -faceDir : faceDir;
}

/**
 * 開き戸（SWING）の物理的な蝶番位置・二等分角方向。反転（記号丸の表示位置のみを動かす操作）
 * とは独立——扉自体の実位置・動作範囲は反転しても変わらないため、openingTagAnchor（初期配置）・
 * reflectDoorArcs（円弧AABB衝突判定）・swingArcObstacles（他開口の記号丸の回避対象）の
 * 3箇所が同じ計算をここへ集約する。
 * @returns {{hinge:{x:number,y:number}, ux:number, uy:number, R:number}}
 */
function swingGeometry(opening, host) {
  const { hingeSide, swingSide, width, isVertical } = opening;
  const hingeAlong = hingeSide < 0 ? opening.coord1 : opening.coord2;
  const hinge = toWorld(isVertical, hingeAlong, host.axisValue);
  // 蝶番から見た「閉じ位置」の方向角（OpeningsLayer.jsx swingSymbol と同じ式で一致させる）
  const towardFar = hingeSide < 0 ? 1 : -1;
  const closedAngle = isVertical
    ? (towardFar > 0 ? 90 : -90)
    : (towardFar > 0 ? 0 : 180);
  const bisector = closedAngle + swingSide * 45;
  const rad = (bisector * Math.PI) / 180;
  return { hinge, ux: Math.cos(rad), uy: Math.sin(rad), R: width };
}

/**
 * 建具記号丸の配置基準アンカー（衝突回避前の初期位置）。
 *   kind:'offset' — 窓・引違い等（SWING以外）。壁の面から室内側へ radius+gap 離す。
 *   kind:'sector' — 開き戸（SWING）。開いた扉と動作円弧のセクター重心近傍。
 * u/v はどちらも単位ベクトル（u=長さ方向・二等分角方向、v=室内向き・直交方向）で、
 * layoutOpeningTags の格子探索がこの座標系でオフセット候補を生成するために使う。
 * @returns {{x:number, y:number, ux:number, uy:number, vx:number, vy:number, kind:'offset'|'sector'}}
 */
export function openingTagAnchor(opening, host, graph, { radiusMm, gapMm }) {
  const entry = findCatalogEntry(opening.category, opening.subType);
  const { isVertical } = opening;

  if (entry?.mechanism === OpeningMechanism.SWING) {
    const { hinge, ux, uy, R } = swingGeometry(opening, host);
    const vx = -uy, vy = ux;
    return {
      x: hinge.x + 0.6 * R * ux,
      y: hinge.y + 0.6 * R * uy,
      ux, uy, vx, vy,
      kind: 'sector',
    };
  }

  const [faceLo, faceHi] = wallFaceRange(host, graph);
  const dir = roomSideDir(opening, host);
  const along = opening.centerCoord;
  const perp = (dir > 0 ? faceHi : faceLo) + dir * (radiusMm + gapMm);
  const { x, y } = toWorld(isVertical, along, perp);
  const u = isVertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const v = isVertical ? { x: dir, y: 0 } : { x: 0, y: dir };
  return { x, y, ux: u.x, uy: u.y, vx: v.x, vy: v.y, kind: 'offset' };
}

/** 各壁の materialRange × coord1..coord2 の軸平行矩形バンド（記号丸が壁に乗らないための障害物）。 */
export function wallObstacleRects(graph) {
  return graph.walls.map(wallWorldRect);
}

// 円と軸平行矩形が交差する（重なる）か。接するだけ（距離===半径）は非交差扱い。
function circleIntersectsRect(cx, cy, r, rect) {
  const clampedX = Math.min(Math.max(cx, rect.x1), rect.x2);
  const clampedY = Math.min(Math.max(cy, rect.y1), rect.y2);
  const dx = cx - clampedX, dy = cy - clampedY;
  return dx * dx + dy * dy < r * r;
}

// 開き戸の動作扇形（90度・軸平行1象限に収まる）の厳密なAABB。
// bisector（u）が指す象限へ hinge から R だけ伸ばした正方形。
function swingArcAabb(hinge, ux, uy, R) {
  const sx = Math.sign(ux) || 1, sy = Math.sign(uy) || 1;
  return {
    x1: Math.min(hinge.x, hinge.x + sx * R), x2: Math.max(hinge.x, hinge.x + sx * R),
    y1: Math.min(hinge.y, hinge.y + sy * R), y2: Math.max(hinge.y, hinge.y + sy * R),
  };
}

function aabbIntersects(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/**
 * 開き戸の動作扇形AABBを openingId 付きで返す（他開口の記号丸の障害物用。自分自身の
 * 配置判定からは呼び出し側で除外する——アンカー自体が自分の扇形内にあるのは設計どおりのため）。
 */
function swingArcObstacles(items) {
  return items
    .filter((it) => it.anchor.kind === 'sector')
    .map((it) => {
      const { hinge, ux, uy, R } = swingGeometry(it.opening, it.host);
      return { openingId: it.opening.id, rect: swingArcAabb(hinge, ux, uy, R) };
    });
}

// 開き戸同士の動作円弧が重なる場合、後（ソート順で後）の開口の記号丸を壁軸で鏡映する。
// 1開口につき反転1回まで（連鎖反転しない＝判定はすべて反転前のAABBで行う）。
function reflectDoorArcs(items) {
  const swingIdx = items.map((it, i) => (it.anchor.kind === 'sector' ? i : -1)).filter(i => i >= 0);
  const aabbs = swingIdx.map((i) => {
    const it = items[i];
    const { hinge, ux, uy, R } = swingGeometry(it.opening, it.host);
    return swingArcAabb(hinge, ux, uy, R);
  });
  const flipped = new Set();

  for (let a = 0; a < swingIdx.length; a += 1) {
    for (let b = a + 1; b < swingIdx.length; b += 1) {
      const j = swingIdx[b];
      if (flipped.has(j)) continue;
      if (!aabbIntersects(aabbs[a], aabbs[b])) continue;
      const host = items[j].host;
      const { isVertical } = items[j].opening;
      const anchor = items[j].anchor;
      // 位置だけでなく u/v 基底ベクトルも鏡映する——鏡映せずに残すと、後段の格子探索が
      // 元の（壁・扉側へ向かう）方向へ退避してしまい、反転の意味が失われる。
      const mirrored = isVertical
        ? { ...anchor, x: 2 * host.axisValue - anchor.x, ux: -anchor.ux, vx: -anchor.vx }
        : { ...anchor, y: 2 * host.axisValue - anchor.y, uy: -anchor.uy, vy: -anchor.vy };
      items[j] = { ...items[j], anchor: mirrored, flipped: true };
      flipped.add(j);
    }
  }
  return items;
}

// 格子探索の候補順（u,v係数）。stepMm 単位のオフセット。
const GRID_CANDIDATES = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [2, 0], [-2, 0], [0, 2], [0, -2],
];

/**
 * graph.openings のうちホスト壁が解決できる開口すべてに対し、記号丸の最終位置を決める。
 * @param {object} graph
 * @param {{radiusMm:number, gapMm:number, stepMm:number}} opts stepMm は格子探索のピッチ
 *   （呼び出し側＝OpeningTagLayer.jsx が 2*radiusMm+gapMm を算出して渡す）。
 * @returns {Array<{openingId:string, opening:object, x:number, y:number, flipped:boolean, placed:boolean}>}
 */
export function layoutOpeningTags(graph, { radiusMm, gapMm, stepMm }) {
  const withHost = graph.openings
    .map((opening) => ({ opening, host: findHostWall(opening, graph) }))
    .filter((it) => it.host);

  withHost.sort((a, b) => {
    if (a.opening.isVertical !== b.opening.isVertical) return a.opening.isVertical ? 1 : -1;
    if (a.host.axisValue !== b.host.axisValue) return a.host.axisValue - b.host.axisValue;
    if (a.opening.centerCoord !== b.opening.centerCoord) return a.opening.centerCoord - b.opening.centerCoord;
    return a.opening.id < b.opening.id ? -1 : (a.opening.id > b.opening.id ? 1 : 0);
  });

  let items = withHost.map((it) => ({
    ...it,
    anchor: openingTagAnchor(it.opening, it.host, graph, { radiusMm, gapMm }),
    flipped: false,
  }));

  items = reflectDoorArcs(items);

  const obstacles = wallObstacleRects(graph);
  // 開き戸の動作扇形も障害物にする（部屋名・寸法・構造部材は対象外。.claude/opening-model.md）。
  const arcObstacles = swingArcObstacles(items);
  const minCenterDist = 2 * radiusMm + gapMm;
  const placedCenters = [];
  const results = [];

  for (const it of items) {
    const { anchor } = it;
    const u = { x: anchor.ux, y: anchor.uy };
    const v = { x: anchor.vx, y: anchor.vy };
    // 自分自身の扇形は除外する（開き戸のアンカーは自分の扇形内にあるのが設計どおりのため）。
    const otherArcRects = arcObstacles.filter((o) => o.openingId !== it.opening.id).map((o) => o.rect);
    let chosen = null;

    for (const [cu, cv] of GRID_CANDIDATES) {
      const cx = anchor.x + cu * stepMm * u.x + cv * stepMm * v.x;
      const cy = anchor.y + cu * stepMm * u.y + cv * stepMm * v.y;

      const collidesCircle = placedCenters.some(({ x, y }) => {
        const dx = cx - x, dy = cy - y;
        return Math.sqrt(dx * dx + dy * dy) < minCenterDist;
      });
      if (collidesCircle) continue;

      const collidesWall = obstacles.some((rect) => circleIntersectsRect(cx, cy, radiusMm, rect));
      if (collidesWall) continue;

      const collidesArc = otherArcRects.some((rect) => circleIntersectsRect(cx, cy, radiusMm, rect));
      if (collidesArc) continue;

      chosen = { x: cx, y: cy, placed: true };
      break;
    }

    if (!chosen) chosen = { x: anchor.x, y: anchor.y, placed: false };

    placedCenters.push({ x: chosen.x, y: chosen.y });
    results.push({
      openingId: it.opening.id,
      opening: it.opening,
      x: chosen.x,
      y: chosen.y,
      flipped: it.flipped,
      placed: chosen.placed,
    });
  }

  return results;
}
