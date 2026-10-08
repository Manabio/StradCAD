/**
 * 平面の立体モデル（planSolids.js）と、その解決器（S3 の planSectionFigure）が共有する純幾何。
 * footprint の2形（`{rects, holes?}` ／ `{poly}`）の正規化・内側判定・輪郭線分。
 * store.js / snap.js / *.jsx を import しない（node:test から単体 import 可）。
 */
import { outlineSegments } from '../finish/gridCells.js';

/**
 * @typedef {{x1:number, y1:number, x2:number, y2:number}} Rect
 * @typedef {{rects: Rect[], holes?: Rect[]} | {poly: number[]}} Footprint
 *   rects＝矩形の和（holes があれば和から穴の矩形の内側を除く）／poly＝単純多角形 [x0,y0,x1,y1,…]（閉路。末尾に始点を繰り返さない）。
 */

const EDGE_EPS = 1e-6;

/** x1<x2・y1<y2 に並べ替えた新しい矩形（値の検証はしない）。 */
export function normalizeRect(r) {
  return {
    x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2),
  };
}

/** 4値とも有限で幅・高さが正（正規化後）の矩形か。 */
export function isValidRect(r) {
  if (!r || ![r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) return false;
  return r.x1 !== r.x2 && r.y1 !== r.y2;
}

function strictlyInsideRect(r, x, y) {
  return x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2;
}

// 点 (x,y) が線分 (ax,ay)-(bx,by) の上にあるか。
function onSegment(ax, ay, bx, by, x, y) {
  const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  if (Math.abs(cross) > EDGE_EPS * Math.max(1, Math.hypot(bx - ax, by - ay))) return false;
  return x >= Math.min(ax, bx) - EDGE_EPS && x <= Math.max(ax, bx) + EDGE_EPS
    && y >= Math.min(ay, by) - EDGE_EPS && y <= Math.max(ay, by) + EDGE_EPS;
}

/** 多角形の**厳密な内側**（辺の上は外）。偶奇規則（レイキャスト）。 */
function strictlyInsidePoly(poly, x, y) {
  const n = poly.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[2 * j], ay = poly[2 * j + 1], bx = poly[2 * i], by = poly[2 * i + 1];
    if (onSegment(ax, ay, bx, by, x, y)) return false;
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/**
 * 点が footprint の**厳密な内側**か（輪郭の上は外）。rects＝どれかの矩形の内側 かつ どの穴の内側でもない。
 * poly＝偶奇規則。不正な footprint（null・形が違う）は false。
 * @param {Footprint|null|undefined} footprint
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isInsideFootprint(footprint, x, y) {
  if (!footprint) return false;
  if (Array.isArray(footprint.poly)) return strictlyInsidePoly(footprint.poly, x, y);
  if (!Array.isArray(footprint.rects)) return false;
  if (!footprint.rects.some(r => strictlyInsideRect(r, x, y))) return false;
  return !(footprint.holes ?? []).some(h => strictlyInsideRect(h, x, y));
}

/**
 * 矩形群（重なりなし・接する辺は同一値）の外周線分。集合内で共有される辺は打ち消される
 * （finish/gridCells.js outlineSegments と同じ。S3 が穴の縁・床の外形を引くのに使う）。
 * @param {Rect[]} rects
 * @returns {Array<{isVertical:boolean, value:number, lo:number, hi:number}>}
 */
export function rectsOutlineSegments(rects) {
  return outlineSegments((rects ?? []).map(normalizeRect));
}

/**
 * footprint の外接矩形。空・不正は null。
 * @param {Footprint|null|undefined} footprint
 * @returns {Rect|null}
 */
export function footprintBounds(footprint) {
  const xs = [], ys = [];
  if (footprint && Array.isArray(footprint.poly)) {
    for (let i = 0; i + 1 < footprint.poly.length; i += 2) { xs.push(footprint.poly[i]); ys.push(footprint.poly[i + 1]); }
  } else if (footprint && Array.isArray(footprint.rects)) {
    for (const r of footprint.rects) {
      xs.push(r.x1, r.x2);
      ys.push(r.y1, r.y2);
    }
  }
  if (xs.length === 0) return null;
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}
