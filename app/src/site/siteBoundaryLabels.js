/**
 * 敷地モードの配置図の境界線ラベル「隣地境界線(<mm>)」「道路境界線(<mm>)」を組む純モジュール。
 * 敷地の外周を片に割り（三斜＝外周の線1本、長方形＝computeOutlinePieces の片）、同一直線・同種の隣接片を1本に結合し、
 * 配置図の座標で字の位置・向きを決める。renderer/SitePlacementLayer.jsx がこの結果を写すだけで描く。
 * store.js・snap.js・.jsx・structural/ を静的に import しない（node:test から単体で import できる）。
 */
import {
  SiteLineKind, SITE_BOUNDARY_LABEL_NEIGHBOR, SITE_BOUNDARY_LABEL_ROAD, SITE_PLACEMENT_VERTEX_EPS_MM,
  HALF_TURN_DEG, DEG_TO_RAD, SITE_BOUNDARY_LABEL_VERTICAL_EPS_DEG,
} from '../core/constants.js';
import { computeOuterLineIds } from './lineClassification.js';
import { computeOutlinePieces, rectSideOutward } from './siteRectGeometry.js';
import { applySiteTransform } from './siteTransform.js';
import { NUM_FONT_PX, TEXT_GAP_PX } from '../renderer/dimensionStyle.js';

// 片の key の組み立て部品。種別ごとの id 空間の衝突を避けるためだけに付け、比較には使わない。
const PIECE_KEY_PREFIX = Object.freeze({ LINE: 'bl', RECT: 'br' });
const MERGED_KEY_SEPARATOR = '+';

const RAD_TO_DEG = HALF_TURN_DEG / Math.PI;

/** 三斜の外周の線1本の外向き単位法線。属する三角形の第3頂点の反対側。三角形が無い・退化なら null。 */
function sanshaOutward(line, triangle) {
  if (!triangle) return null;
  const { startPoint: s, endPoint: e } = line;
  const third = [triangle.baseLine.startPoint, triangle.baseLine.endPoint, triangle.apexPoint]
    .find(p => p.id !== s.id && p.id !== e.id);
  if (!third) return null;
  const dx = e.x - s.x, dy = e.y - s.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  let n = { x: -dy / len, y: dx / len };
  if (n.x * (third.x - (s.x + e.x) / 2) + n.y * (third.y - (s.y + e.y) / 2) > 0) n = { x: -n.x, y: -n.y };
  return n;
}

/**
 * 敷地の外周の片（敷地座標）。
 * @returns {Array<{key:string, a:{x:number,y:number}, b:{x:number,y:number}, road:boolean, outward:{x:number,y:number}|null}>}
 */
export function boundaryPieces(site) {
  const outerIds = computeOuterLineIds(site);
  const triangles = [...site.triangleMap.values()];
  // 線を含む三角形＝3 点の id が線の両端を両方含む三角形（外周の線は属する三角形が 1 個以下なので最初の 1 個）
  const triangleOf = l => triangles.find(t => {
    const ids = [t.baseLine.startPoint.id, t.baseLine.endPoint.id, t.apexPoint.id];
    return ids.includes(l.startPoint.id) && ids.includes(l.endPoint.id);
  });
  const sansha = site.lines.filter(l => outerIds.has(l.id)).map(l => ({
    key: `${PIECE_KEY_PREFIX.LINE}/${l.id}`,
    a: { x: l.startPoint.x, y: l.startPoint.y },
    b: { x: l.endPoint.x, y: l.endPoint.y },
    road: l.lineKind === SiteLineKind.ROAD,
    outward: sanshaOutward(l, triangleOf(l)),
  }));
  const rect = computeOutlinePieces(site.rects).map((p, i) => ({
    key: `${PIECE_KEY_PREFIX.RECT}/${p.rectId}/${p.side}/${i}`,
    a: { ...p.a },
    b: { ...p.b },
    road: p.owners.some(o => site.rectMap.get(o.rectId)?.roadSides.has(o.side)),
    outward: { ...rectSideOutward(p.side) },
  }));
  return [...sansha, ...rect];
}

const samePoint = (p, q) => Math.abs(p.x - q.x) <= SITE_PLACEMENT_VERTEX_EPS_MM && Math.abs(p.y - q.y) <= SITE_PLACEMENT_VERTEX_EPS_MM;

/** p と q が端点を共有し、同一直線上で反対向きに延びていれば結合した片、なければ null。 */
function tryMerge(p, q) {
  if (p.road !== q.road) return null;
  const pEnds = [p.a, p.b], qEnds = [q.a, q.b];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      if (!samePoint(pEnds[i], qEnds[j])) continue;
      const shared = pEnds[i];
      const pFar = pEnds[1 - i], qFar = qEnds[1 - j];
      const pv = { x: pFar.x - shared.x, y: pFar.y - shared.y };
      const qv = { x: qFar.x - shared.x, y: qFar.y - shared.y };
      const norm = Math.hypot(pv.x, pv.y) * Math.hypot(qv.x, qv.y);
      if (norm === 0) return null; // 長さ 0 の片は結合しない
      const cross = (pv.x * qv.y - pv.y * qv.x) / norm; // 無次元（sin θ）
      const dot = pv.x * qv.x + pv.y * qv.y;
      if (Math.abs(cross) > SITE_PLACEMENT_VERTEX_EPS_MM || dot >= 0) return null; // 折れる・同じ向きに重なる片は結合しない
      return {
        key: `${p.key}${MERGED_KEY_SEPARATOR}${q.key}`,
        a: { ...pFar }, b: { ...qFar }, road: p.road, outward: p.outward ?? q.outward,
      };
    }
  }
  return null;
}

/**
 * 同一直線上で端点を共有し road が同じ隣接片を1本に結合する（outward は先頭の片、key は '+' でつなぐ）。
 * 判定幅は SITE_PLACEMENT_VERTEX_EPS_MM（端点一致・方向ベクトルの外積）。離れた片・種別違い・折れる片は結合しない。
 */
export function mergeCollinearPieces(pieces) {
  const out = pieces.map(p => ({ ...p }));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const m = tryMerge(out[i], out[j]);
        if (!m) continue;
        out[i] = m;
        out.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return out;
}

/** 境界線ラベルの文言。括弧の書式はここ1か所。 */
export function formatBoundaryLabel(road, lengthMm) {
  return `${road ? SITE_BOUNDARY_LABEL_ROAD : SITE_BOUNDARY_LABEL_NEIGHBOR}(${Math.round(lengthMm)})`;
}

/** 字の向き（度）を [−90, 90) へ。90 は −90 にする（上か左向きの字にそろえる。sitePlacementSolve の normalizeLineAngle90 は (−90, 90] で別物）。 */
export function normalizeLabelAngle(deg) {
  const half = HALF_TURN_DEG / 2;
  return ((((deg + half) % HALF_TURN_DEG) + HALF_TURN_DEG) % HALF_TURN_DEG) - half;
}

/**
 * 配置図の座標での字の位置・向き。anchor（x,y）は字のベースラインの中心、rotation は Konva の度。
 * outward が null の片は fallbackCenter から離れる側を外とする（fallbackCenter も null ならその片は描かない）。
 * @param {Array} pieces boundaryPieces の結果（結合済み・敷地座標）
 * @param {{rotationDeg:number, tx:number, ty:number}} transform
 * @param {number} scale 画面 px → 世界 mm の倍率の逆数側（viewport.scaleX）
 * @param {{x:number,y:number}|null} fallbackCenter 配置図座標
 * @returns {Array<{key:string, text:string, x:number, y:number, rotation:number}>}
 */
export function layoutBoundaryLabels(pieces, transform, scale, fallbackCenter) {
  const gap = TEXT_GAP_PX / scale;
  const fontH = NUM_FONT_PX / scale;
  const turnOnly = { rotationDeg: transform.rotationDeg, tx: 0, ty: 0 };
  const out = [];
  for (const p of pieces) {
    const length = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    const A = applySiteTransform(p.a, transform);
    const B = applySiteTransform(p.b, transform);
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    let outward;
    if (p.outward) {
      outward = applySiteTransform(p.outward, turnOnly);
    } else {
      if (!fallbackCenter) continue;
      outward = { x: -dy / len, y: dx / len };
      if (outward.x * (mid.x - fallbackCenter.x) + outward.y * (mid.y - fallbackCenter.y) < 0) outward = { x: -outward.x, y: -outward.y };
    }
    const normalized = normalizeLabelAngle(Math.atan2(dy, dx) * RAD_TO_DEG);
    const rotation = HALF_TURN_DEG / 2 - Math.abs(normalized) <= SITE_BOUNDARY_LABEL_VERTICAL_EPS_DEG ? -HALF_TURN_DEG / 2 : normalized;
    const rad = rotation * DEG_TO_RAD;
    const up = { x: Math.sin(rad), y: -Math.cos(rad) }; // 字の上（θ を −90° 回した単位ベクトル）
    const dist = up.x * outward.x + up.y * outward.y > 0 ? gap : gap + fontH;
    out.push({
      key: p.key,
      text: formatBoundaryLabel(p.road, length),
      x: mid.x + outward.x * dist,
      y: mid.y + outward.y * dist,
      rotation,
    });
  }
  return out;
}

/** 結合 → 配置。 */
export function composeSiteBoundaryLabels({ site, transform, scale, fallbackCenter }) {
  return layoutBoundaryLabels(mergeCollinearPieces(boundaryPieces(site)), transform, scale, fallbackCenter);
}
