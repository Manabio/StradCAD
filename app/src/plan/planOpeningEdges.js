/**
 * 天伏（見上げ）の穴の縁を中線にする後処理（純モジュール。store.js・snap.js・.jsx を引かない）。
 * ユーザー裁定 2026-10-18: 穴（上階スラブの吹抜け・昇降路・階段吹抜け）の縁は、壁の張り出し面も壁の無いスラブ小口も中線（medium）。
 * 縁の線は天井の縁・床の縁・壁の面で 3 本重なるので、同じ直線上で重なる区間は最初の線だけが持つ。解決器（planSectionFigure）は触らない。
 * 渡す穴は「見える穴」（上階の床の穴から自階の天井面を引いたもの）。両側が天井の境（例: 穴の切欠きの側面）は外形にならない。
 *
 * 裁定の記録（2026-10-18・受容）: 穴に突き出す壁（縁から穴へ出る壁端・穴の中の隔て板）は、その輪郭が見える穴の縁＝中線になる
 * （自階の切断壁の太線と重なる）。角の取り合いの欠けが穴に残す 12.5×12.5 の小穴は線にならない（既知）。
 * 既知の限界: S3 で延ばした天井の帯と隣の同じ高さの天井の境（13 1階 x=−1550 の 57.5mm）は、markSameHeightCeilingBoundaries が
 * セル矩形で判定するためグレーにならず細線。自階の切断壁の太線の下なので受容（リード裁定 2026-10-18）。
 */
import { rectsOutlineSegments, isValidRect, normalizeRect } from './planGeometry.js';
import { disjointRects } from './planSectionFigure.js';
import { CEILING_BOUNDARY_STYLE } from '../ceiling/ceilingBoundaryStyle.js';

/** 穴の縁の線の重み（viewport.lineWeightsPx のキー。見下げの下階階段の「床の端」と同じ重み）。 */
export const OPENING_EDGE_WEIGHT = 'medium';

const TOL = 1e-3; // 外形線分の上にあるとみなす許容・座標の同一判定（丸め）
const round = v => Math.round(v / TOL);

/** 同じ直線上で接する・重なる外形線分を 1 本にまとめる（矩形の割り方に依らず、縁の線が 1 本の線分の上に乗るかを見るため）。 */
function mergeCollinearSegments(segs) {
  const groups = new Map();
  for (const s of segs) {
    const key = `${s.isVertical}:${round(s.value)}`;
    if (!groups.has(key)) groups.set(key, { isVertical: s.isVertical, value: s.value, ivs: [] });
    groups.get(key).ivs.push([Math.min(s.lo, s.hi), Math.max(s.lo, s.hi)]);
  }
  const out = [];
  for (const g of groups.values()) {
    let cur = null;
    for (const iv of g.ivs.sort((p, q) => p[0] - q[0])) {
      if (cur && iv[0] <= cur[1] + TOL) cur[1] = Math.max(cur[1], iv[1]);
      else { if (cur) out.push({ isVertical: g.isVertical, value: g.value, lo: cur[0], hi: cur[1] }); cur = [...iv]; }
    }
    if (cur) out.push({ isVertical: g.isVertical, value: g.value, lo: cur[0], hi: cur[1] });
  }
  return out;
}

/** [lo,hi] から出力済みの区間 ivs を差し引いた残り（昇順・長さ > TOL）。 */
function subtractCovered(ivs, lo, hi) {
  const rest = [];
  let cursor = lo;
  for (const [s, e] of [...ivs].sort((a, b) => a[0] - b[0])) {
    if (e <= cursor + TOL) continue;
    if (s >= hi - TOL) break;
    if (s - cursor > TOL) rest.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (hi - cursor > TOL) rest.push([cursor, hi]);
  return rest;
}

/**
 * 出力のうち、穴の和の外形線分の上に乗る線（kind 'line'・軸平行）の、外形の上の区間の weight を OPENING_EDGE_WEIGHT にする。
 * 一部だけ外形に乗る線は外形の上の区間と外の区間に分割する（外の区間は元の weight。分割した片の key は `元のkey:p番号`）。
 * 同じ直線上で重なる区間は最初の線だけが持つ（後の線は出力済みの区間を差し引いた残りだけ。全部重なれば落とす。座標は TOL で丸めて比べる）。
 * 同高さ天井の境のグレー（style が CEILING_BOUNDARY_STYLE）と切断の太線（cls 'cut'）は対象外（そのまま通す）。他の prim も不変。
 * 入力の配列・prim は変更しない（変えた prim は新しいオブジェクト）。
 * 穴が無い・空・不正（有限でない矩形）のときは入力をそのまま返す。不正な線（points が 4 つの有限数でない）は触らずそのまま通す。
 * @param {import('./planSectionFigure.js').Primitive[]} prims
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} openingRects 見える穴（上階の床の穴 − 自階の天井面）
 * @returns {import('./planSectionFigure.js').Primitive[]}
 */
export function markOpeningEdges(prims, openingRects) {
  if (!Array.isArray(prims) || !Array.isArray(openingRects)) return prims;
  const rects = openingRects.filter(isValidRect).map(normalizeRect);
  if (rects.length === 0 || prims.length === 0) return prims;
  const segs = mergeCollinearSegments(rectsOutlineSegments(disjointRects(rects)));
  const covered = new Map(); // 向き:座標 → 出力済みの区間 [[lo,hi],…]
  const out = [];
  for (const p of prims) {
    if (p?.kind !== 'line' || p.cls === 'cut' || p.style === CEILING_BOUNDARY_STYLE
      || !Array.isArray(p.points) || p.points.length !== 4 || !p.points.every(Number.isFinite)) { out.push(p); continue; }
    const [x1, y1, x2, y2] = p.points;
    const vertical = Math.abs(x1 - x2) <= TOL;
    if ((vertical && Math.abs(y1 - y2) <= TOL) || (!vertical && Math.abs(y1 - y2) > TOL)) { out.push(p); continue; }
    const c = vertical ? (x1 + x2) / 2 : (y1 + y2) / 2;
    const lo = vertical ? Math.min(y1, y2) : Math.min(x1, x2), hi = vertical ? Math.max(y1, y2) : Math.max(x1, x2);
    // 線のうち外形線分の上にある区間（昇順・結合済み）
    const on = segs.filter(s => s.isVertical === vertical && Math.abs(s.value - c) <= TOL)
      .map(s => [Math.max(lo, s.lo), Math.min(hi, s.hi)]).filter(([a, b]) => b - a > TOL).sort((a, b) => a[0] - b[0]);
    if (on.length === 0) { out.push(p); continue; }
    const gk = `${vertical}:${round(c)}`;
    if (!covered.has(gk)) covered.set(gk, []);
    const ivs = covered.get(gk);
    const parts = []; // [a, b, 中線か]
    let cursor = lo;
    for (const [a, b] of on) {
      if (a - cursor > TOL) parts.push([cursor, a, false]);
      for (const [ra, rb] of subtractCovered(ivs, a, b)) { ivs.push([ra, rb]); parts.push([ra, rb, true]); }
      cursor = Math.max(cursor, b);
    }
    if (hi - cursor > TOL) parts.push([cursor, hi, false]);
    const whole = parts.length === 1 && parts[0][0] === lo && parts[0][1] === hi;
    parts.forEach(([a, b, marked], k) => {
      out.push({
        ...p,
        key: whole ? p.key : `${p.key}:p${k}`,
        points: whole ? p.points : (vertical ? [c, a, c, b] : [a, c, b, c]),
        ...(marked ? { weight: OPENING_EDGE_WEIGHT } : {}),
      });
    });
  }
  return out;
}
