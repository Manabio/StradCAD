/**
 * 天伏（見上げ）の天井の見切り線のうち、「同じ高さで隣り合う部屋の境目」だけに印を付ける（純モジュール。react・store.js・
 * snap.js・.jsx を静的に引かない）。ユーザー裁定 2026-10-10: 壁の無い境界で、同じ高さの天井どうしの見切り線は消さず細線グレーで描く。
 * 段差の見切り線（高さが違う境界）・天井の外形（壁の無い外周）は無印のまま。
 *
 * 天井は部屋ごとに別の立体なので、同じ高さの隣接部屋の境界には両立体から1本ずつ（計2本）線が出る。解決器（planSectionFigure）は
 * 触らず、出力のうち source.kind === 'ceiling' の線分で、境界の上にある部分だけを `style: 'ceilingBoundary'` にして重複を1本に畳む。
 * 描画側（renderer/PlanSolidsLayer.jsx）が style を見て色を変える。
 */

/** 長さ・座標・高さの一致判定の許容（mm）。解決器の EPS（0.5）と同じ。 */
const EPS = 0.5;

/** 印の値（prim.style）。 */
export const CEILING_BOUNDARY_STYLE = 'ceilingBoundary';

/**
 * 同じ高さ（|Δz| ≦ EPS）の別々の天井面が矩形の辺を共有する区間（軸平行）を列挙する。同一面の内側の辺は対象外。
 * @param {Array<{rects: Array<{x1:number,y1:number,x2:number,y2:number}>, zMm: number}>} surfaces
 * @returns {Array<{horizontal: boolean, c: number, lo: number, hi: number}>}  horizontal: y=c 上の x 区間／false: x=c 上の y 区間
 */
export function sameHeightBoundarySegments(surfaces) {
  const out = [];
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      if (!(Math.abs(surfaces[i].zMm - surfaces[j].zMm) <= EPS)) continue;
      for (const a of surfaces[i].rects) {
        for (const b of surfaces[j].rects) {
          const yLo = Math.max(a.y1, b.y1), yHi = Math.min(a.y2, b.y2);
          if (yHi - yLo > EPS) {
            if (Math.abs(a.x2 - b.x1) <= EPS) out.push({ horizontal: false, c: a.x2, lo: yLo, hi: yHi });
            if (Math.abs(a.x1 - b.x2) <= EPS) out.push({ horizontal: false, c: a.x1, lo: yLo, hi: yHi });
          }
          const xLo = Math.max(a.x1, b.x1), xHi = Math.min(a.x2, b.x2);
          if (xHi - xLo > EPS) {
            if (Math.abs(a.y2 - b.y1) <= EPS) out.push({ horizontal: true, c: a.y2, lo: xLo, hi: xHi });
            if (Math.abs(a.y1 - b.y2) <= EPS) out.push({ horizontal: true, c: a.y1, lo: xLo, hi: xHi });
          }
        }
      }
    }
  }
  return out;
}

/** 線分 [lo,hi] のうち境界の上にある区間（マージ済み・昇順・長さ > EPS）。 */
function coveredIntervals(segs, horizontal, c, lo, hi) {
  const cl = segs
    .filter(s => s.horizontal === horizontal && Math.abs(s.c - c) <= EPS)
    .map(s => [Math.max(s.lo, lo), Math.min(s.hi, hi)])
    .filter(([a, b]) => b - a > EPS)
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of cl) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] <= EPS) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** [a,b] から出力済みの区間 ivs を差し引いた残り（昇順・長さ > EPS）。 */
function subtractIntervals(ivs, a, b) {
  const rest = [];
  let cursor = a;
  for (const [s, e] of [...ivs].sort((p, q) => p[0] - q[0])) {
    if (e <= cursor) continue;
    if (s >= b) break;
    if (s - cursor > EPS) rest.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (b - cursor > EPS) rest.push([cursor, b]);
  return rest;
}

/**
 * 見上げの出力に、同じ高さの天井の境界の印を付ける。入力の配列・prim は変更しない（印を付けた prim は新しいオブジェクト）。
 *  - surfaces が空（または配列でない）・prims が配列でないときは入力をそのまま返す。
 *  - 対象は kind:'line' かつ source.kind === 'ceiling' で、軸平行の線分だけ。他の種別・斜めの線には触らない。
 *  - 境界に一部だけ乗る線分は分割する（境界の部分だけ style:'ceilingBoundary'、残りは無印）。分割した片の key は `元のkey:p番号`。
 *  - 印の付いた片は (向き, c) ごとに出力済みの区間を差し引いた残りだけを出す（eps 内で同じ線。両立体から1本ずつ出る重複・T 字の境界の重なりを畳む）。無印の ceiling 線も座標が完全一致するものは1本に畳む
 *    （段差の境界。向きは問わない）。ceiling 以外の種別は畳まない。
 * @param {import('../plan/planSectionFigure.js').Primitive[]} prims  planSolidsLayerPrimitivesUp の絞り込み後の出力
 * @param {Array<{rects: Array<{x1:number,y1:number,x2:number,y2:number}>, zMm: number}>} surfaces  ceilingSurfacesOf(graph)
 * @returns {import('../plan/planSectionFigure.js').Primitive[]}
 */
export function markSameHeightCeilingBoundaries(prims, surfaces) {
  if (!Array.isArray(prims) || !Array.isArray(surfaces) || surfaces.length === 0) return prims;
  const segs = sameHeightBoundarySegments(surfaces);
  const seen = new Set();
  const emitted = []; // 印付きで出力済みの区間: { horizontal, c, ivs: [[lo,hi],...] }
  const out = [];
  // 無印の ceiling 線: 座標が完全一致（向きは問わない）する重複は1本に畳む（段差の境界は両立体から同座標の2本が出る）
  const pushPlain = q => {
    const [a, b, c, d] = q.points;
    const id = `u:${a < c || (a === c && b <= d) ? [a, b, c, d] : [c, d, a, b]}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(q);
  };
  for (const p of prims) {
    if (p?.kind !== 'line' || p.source?.kind !== 'ceiling' || !Array.isArray(p.points) || p.points.length !== 4) { out.push(p); continue; }
    const [x1, y1, x2, y2] = p.points;
    const horizontal = Math.abs(y1 - y2) <= EPS && Math.abs(x1 - x2) > EPS;
    const vertical = Math.abs(x1 - x2) <= EPS && Math.abs(y1 - y2) > EPS;
    if (!horizontal && !vertical) { pushPlain(p); continue; }
    const c = horizontal ? (y1 + y2) / 2 : (x1 + x2) / 2;
    const lo = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
    const hi = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
    const covered = coveredIntervals(segs, horizontal, c, lo, hi);
    if (covered.length === 0) { pushPlain(p); continue; }
    // [区間, 印あり?] の列に分ける
    const parts = [];
    let cursor = lo;
    for (const [a, b] of covered) {
      if (a - cursor > EPS) parts.push([cursor, a, false]);
      parts.push([a, b, true]);
      cursor = b;
    }
    if (hi - cursor > EPS) parts.push([cursor, hi, false]);
    const single = parts.length === 1;
    parts.forEach(([a, b, marked], i) => {
      const baseKey = single ? p.key : `${p.key}:p${i}`;
      if (!marked) {
        pushPlain({ ...p, key: baseKey, points: horizontal ? [a, c, b, c] : [c, a, c, b] });
        return;
      }
      // 印付きは (向き, c) ごとに出力済みの区間を差し引いた残りだけを出す（重なる線・T 字の境界の二重描きを避ける。c は eps 内で同じ線）
      const group = emitted.find(g => g.horizontal === horizontal && Math.abs(g.c - c) <= EPS)
        ?? (emitted.push({ horizontal, c, ivs: [] }), emitted[emitted.length - 1]);
      const rest = subtractIntervals(group.ivs, a, b);
      rest.forEach(([ra, rb], j) => {
        group.ivs.push([ra, rb]);
        const whole = single && rest.length === 1 && ra === a && rb === b;
        out.push({
          ...p,
          key: rest.length > 1 ? `${baseKey}:r${j}` : baseKey,
          points: whole ? p.points : (horizontal ? [ra, c, rb, c] : [c, ra, c, rb]),
          style: CEILING_BOUNDARY_STYLE,
        });
      });
    });
  }
  return out;
}
