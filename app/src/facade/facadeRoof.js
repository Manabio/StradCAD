/**
 * 立面図の屋根（下屋・主屋根・屋根区画）の純幾何。region（structural/roofFramingRegions.js leanToPlanRegions・topRoofPlanRegions の要素。
 * 呼び出し側＝modes/FacadeModeState.js が解決して facadeInputs.js へ渡す）から、平面座標の 3D の線・屋根面の高さ関数・遮蔽用の区間を作る。
 * graph を引かない。roofFramingRegions.js は storage を推移的に引くので、ここからは import しない（facade/importGraph.test.js）。
 *
 * 屋根面の高さ（リード裁定 S2）: z(p) = eaveZ + k·T(q) − k·max(dx, dy) + k·max(ux, uy)。k＝勾配/10、T＝drainArrivalTime の到達時刻
 * （水下で 0）、q＝p に最も近い屋根範囲（rect/rects）内の点、dx・dy＝p−q の成分のうち**水下（軒）の辺**を越える分、ux・uy＝
 * 矩形の片流れ（MONO・rect）の**水上の辺**（水下の対辺）を越える分（リード裁定 2026-10-30: 水上の軒の出は屋根面の延長として上がる）。
 * けらばを越える分は 0（けらばは水平に出ても高さが変わらない）。軒先は出幅ぶん下がり、妻は三角になる。
 * 平面の plan/planSolids.js roofZAtOf は見下げ用に「軒の出＝FL（平ら）」と割り切る。立面は屋根面を平面として延長する
 * （リード裁定 2026-10-30）。
 * 外形線だけの region（outlineOnly）・勾配が無い・水下が無い・到達時刻が作れない（valid=false）屋根は平ら（z＝eaveZ）で、
 * 線は外形線だけ。後の3つは flatFallback:true（呼び出し側が skipped に載せる。描くのは軒の高さの水平線）。
 */
import { CL_OVERLAP_TOL_MM, FacadeSkipReason, RoofShape } from '../core/constants.js';
import { drainArrivalTime } from '../structural/roofFramingGeometry.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { ElevationLineRole, COORD_EPS_MM } from '../elevation/elevationStyle.js';
import { FACADE_VIS_SAMPLE_MM } from './facadeStyle.js';

/** 平面の線の role（roofPlanRegionFigure）→ 立面の線種。軒先・けらば・棟＝外形線、隅木・谷木＝細線。 */
const LINE_ROLE_BY_FIGURE_ROLE = Object.freeze({
  outline: ElevationLineRole.SILHOUETTE,
  ridge:   ElevationLineRole.SILHOUETTE,
  hip:     ElevationLineRole.DETAIL,
  valley:  ElevationLineRole.DETAIL,
});

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 屋根範囲の矩形（有限・lo≤hi のもの）。 */
function rectsOf(region) {
  const list = region?.rect ? [region.rect] : Array.isArray(region?.rects) ? region.rects : [];
  return list.filter(r => r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite) && r.x2 > r.x1 && r.y2 > r.y1);
}

/** 外形線の閉路（平らな点列 [x,y,…]。3点以上）。 */
function loopsOf(region) {
  return (region?.outline ?? [])
    .map(l => l?.points)
    .filter(p => Array.isArray(p) && p.length >= 6 && p.every(Number.isFinite));
}

/**
 * 屋根面の高さ関数。平ら（傾斜を作れない）なら { zAt: ()=>eaveZ, flat:true, fallback }。
 * fallback＝outlineOnly でないのに平らにしたとき true（勾配なし・水下なし・到達時刻が作れない）。
 */
function heightFunctionOf(region, rects, eaveZ) {
  const flat = fallback => ({ zAt: () => eaveZ, flat: true, fallback });
  if (region.outlineOnly) return flat(false);
  const slope = region.slope;
  const drains = region.planDrains ?? [];
  if (!(slope > 0) || drains.length === 0) return flat(true);
  const tolMm = CL_OVERLAP_TOL_MM;
  const arrival = drainArrivalTime({ rects, drains, tolMm });
  if (!arrival.valid) return flat(true);
  const k = slope / 10;
  // q の辺（isVertical・座標・辺に沿う座標・外向き）が水下の辺に乗るか
  const onEdge = edges => (isVertical, coord, along, outward) => edges.some(d => d.isVertical === isVertical && d.outward === outward
    && Math.abs(d.coord - coord) <= tolMm && along >= d.lo - tolMm && along <= d.hi + tolMm);
  const onDrain = onEdge(drains);
  const onHigh = onEdge(highEdgesOf(region, drains));
  const zAt = (x, y) => {
    let qx = x, qy = y, best = Infinity;
    for (const r of rects) {
      const cx = clamp(x, r.x1, r.x2), cy = clamp(y, r.y1, r.y2);
      const d = Math.hypot(x - cx, y - cy);
      if (d < best) { best = d; qx = cx; qy = cy; }
    }
    const t = arrival.T(qx, qy);
    const tq = Number.isFinite(t) && t > 0 ? t : 0;
    const ex = x - qx, ey = y - qy;
    const dx = Math.abs(ex) > COORD_EPS_MM && onDrain(true, qx, qy, Math.sign(ex)) ? Math.abs(ex) : 0;
    const dy = Math.abs(ey) > COORD_EPS_MM && onDrain(false, qy, qx, Math.sign(ey)) ? Math.abs(ey) : 0;
    const ux = Math.abs(ex) > COORD_EPS_MM && onHigh(true, qx, qy, Math.sign(ex)) ? Math.abs(ex) : 0;
    const uy = Math.abs(ey) > COORD_EPS_MM && onHigh(false, qy, qx, Math.sign(ey)) ? Math.abs(ey) : 0;
    return eaveZ + k * tq - k * Math.max(dx, dy) + k * Math.max(ux, uy);
  };
  return { zAt, flat: false, fallback: false };
}

/**
 * 矩形の片流れ（MONO・rect）の水上の辺（水下の辺の対辺。{isVertical, coord, lo, hi, outward}）。それ以外は []
 * （切妻・寄棟に水上の辺は無い。水下の場の片流れ〔rect なし〕は対辺が1つに決まらないので従来どおり水平）。
 */
function highEdgesOf(region, drains) {
  const r = region.rect;
  if (region.shape !== RoofShape.MONO || !r) return [];
  return drains.map(d => (d.isVertical
    ? { isVertical: true, coord: d.outward > 0 ? r.x1 : r.x2, lo: r.y1, hi: r.y2, outward: -d.outward }
    : { isVertical: false, coord: d.outward > 0 ? r.y1 : r.y2, lo: r.x1, hi: r.x2, outward: -d.outward }));
}

// 3点 (s,z) の中間が両端を結ぶ線上か（ずれが COORD_EPS_MM 以下）。
function isCollinear(a, b, c) {
  const ds = c.s - a.s;
  if (!(ds > 0)) return true;
  const zOnChord = a.z + ((c.z - a.z) * (b.s - a.s)) / ds;
  return Math.abs(zOnChord - b.z) <= COORD_EPS_MM;
}

/**
 * 平面の辺 (x1,y1)→(x2,y2) を FACADE_VIS_SAMPLE_MM 刻み＋折れ点（breaksX・breaksY の座標を横切る位置）で標本化して z を付け、
 * 共線の中間点を落とした 3D の線分の列にする（妻の外形が棟の端で折れる・寄棟の隅で折れるのを交点計算なしで拾う。端点は必ず辺の両端）。
 * creases（棟・隅木・谷木の線分 [x1,y1,x2,y2]）を渡すと、辺がそれと交わる位置も折れ点にする（下屋が壁に取りつく線は棟・隅木の
 * 途中を横切るので端点の座標だけでは足りない）。屋根の外形線と、下屋が壁に取りつく線（facadeGeometry.js）が共用する。
 * @returns {Array<{x1:number, y1:number, z1:number, x2:number, y2:number, z2:number}>}
 */
export function sampledRoofEdge(x1, y1, x2, y2, zAt, breaksX = [], breaksY = [], creases = []) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > COORD_EPS_MM)) return [];
  const steps = Math.max(1, Math.ceil(len / FACADE_VIS_SAMPLE_MM));
  const ts = new Set();
  for (let i = 0; i <= steps; i++) ts.add(i / steps);
  const cross = (a1, a2, vals) => {
    if (Math.abs(a2 - a1) <= COORD_EPS_MM) return;
    for (const v of vals) {
      const t = (v - a1) / (a2 - a1);
      if (t > 0 && t < 1) ts.add(t);
    }
  };
  cross(x1, x2, breaksX);
  cross(y1, y2, breaksY);
  const dir = { x: (x2 - x1) / len, y: (y2 - y1) / len };
  for (const t of creaseCrossings(creases, { x: x1, y: y1 }, dir)) if (t > 0 && t < len) ts.add(t / len);
  const pts = [...ts].sort((a, b) => a - b).map(t => {
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    return { s: t * len, x, y, z: zAt(x, y) };
  });
  const kept = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (!isCollinear(kept[kept.length - 1], pts[i], pts[i + 1])) kept.push(pts[i]);
  }
  kept.push(pts[pts.length - 1]);
  const out = [];
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i], b = kept[i + 1];
    out.push({ x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z });
  }
  return out;
}

/**
 * region 1つの立面用の屋根。失敗（範囲が空・外形線なし・例外）は { roof:null, reason, message? }。
 * @param {object} region leanToPlanRegions・topRoofPlanRegions の要素
 * @param {number} eaveZMm 軒の高さ（世界 z）
 * @returns {{roof: null|{key:string, eaveZMm:number, flat:boolean, flatFallback:boolean, loops:number[][],
 *   zAt:(x:number,y:number)=>number, segments:Array<{x1,y1,z1,x2,y2,z2,role:string}>, creases:number[][],
 *   breaksX:number[], breaksY:number[]},
 *   reason?:string, message?:string}}
 */
export function facadeRoofOf(region, eaveZMm) {
  try {
    const rects = rectsOf(region);
    const loops = loopsOf(region);
    if (rects.length === 0 || loops.length === 0 || !Number.isFinite(eaveZMm)) {
      return { roof: null, reason: FacadeSkipReason.ROOF_NO_OUTLINE };
    }
    const { zAt, flat, fallback } = heightFunctionOf(region, rects, eaveZMm);
    const figure = roofPlanRegionFigure(region);
    // 平らなら外形線だけ（棟・隅木・谷木は高さを持たない）
    const lines = figure.lines.filter(l => !flat || l.role === 'outline');
    const creases = lines.filter(l => l.role !== 'outline').map(l => l.points);
    const breaksX = [...rects.flatMap(r => [r.x1, r.x2]), ...creases.flatMap(p => [p[0], p[2]])];
    const breaksY = [...rects.flatMap(r => [r.y1, r.y2]), ...creases.flatMap(p => [p[1], p[3]])];
    const segments = [];
    for (const l of lines) {
      const role = LINE_ROLE_BY_FIGURE_ROLE[l.role] ?? ElevationLineRole.DETAIL;
      const p = l.points;
      if (l.role === 'outline') {
        const n = p.length / 2;
        const edgeCount = l.closed ? n : n - 1;
        for (let i = 0; i < edgeCount; i++) {
          const j = (i + 1) % n;
          for (const s of sampledRoofEdge(p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1], zAt, breaksX, breaksY, creases)) segments.push({ ...s, role });
        }
      } else {
        // 棟・隅木・谷木は面どうしの交線（直線）なので両端の z だけ
        segments.push({ x1: p[0], y1: p[1], z1: zAt(p[0], p[1]), x2: p[2], y2: p[3], z2: zAt(p[2], p[3]), role });
      }
    }
    return {
      roof: { key: region.key, eaveZMm, flat, flatFallback: fallback, loops, zAt, segments, creases, breaksX, breaksY },
    };
  } catch (err) {
    return { roof: null, reason: FacadeSkipReason.ERROR, message: String(err?.message ?? err) };
  }
}

/**
 * 平面の直線 origin + t·dir（dir は単位ベクトル）が外形線の閉路の内側にある t の区間（偶奇則。昇順・互いに素）。
 * @returns {Array<[number, number]>}
 */
export function roofIntervalsAlong(roof, origin, dir) {
  const out = [];
  for (const pts of roof.loops) {
    const ts = [];
    const n = pts.length / 2;
    // 直線からの符号付き距離（dir を左へ 90° 回した向きが正）
    const side = (x, y) => (x - origin.x) * -dir.y + (y - origin.y) * dir.x;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
      const sa = side(ax, ay), sb = side(bx, by);
      if ((sa > 0) === (sb > 0)) continue;
      const f = sa / (sa - sb);
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      ts.push((x - origin.x) * dir.x + (y - origin.y) * dir.y);
    }
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > COORD_EPS_MM) out.push([ts[i], ts[i + 1]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 点 (x,y) が外形線の閉路の内側（境界を含む）か。 */
export function roofCoversPoint(roof, x, y) {
  // x 方向の直線で区間を取り、x がどれかに入るか（境界は COORD_EPS_MM まで含める）
  const spans = roofIntervalsAlong(roof, { x: 0, y }, { x: 1, y: 0 });
  return spans.some(([a, b]) => x >= a - COORD_EPS_MM && x <= b + COORD_EPS_MM);
}

/** 直線 origin + t·dir（dir は単位ベクトル）が線分 creases（[x1,y1,x2,y2]）と交わる t（平行は無し）。 */
function creaseCrossings(creases, origin, dir) {
  return creases.flatMap(p => {
    const ex = p[2] - p[0], ey = p[3] - p[1];
    const den = ex * dir.y - ey * dir.x;
    if (Math.abs(den) <= COORD_EPS_MM * COORD_EPS_MM) return [];
    const ox = p[0] - origin.x, oy = p[1] - origin.y;
    const s = (ox * dir.y - oy * dir.x) / -den; // 線分の媒介変数
    if (s < 0 || s > 1) return [];
    return [(ox + ex * s) * dir.x + (oy + ey * s) * dir.y];
  });
}

/**
 * 直線 origin + t·dir の t ≤ tMax の部分が屋根の内側を通るところの屋根面の z の最小・最大。通らなければ null。
 * 区間の端・FACADE_VIS_SAMPLE_MM ごと・棟／隅木／谷木（creases）と交わる位置で調べる（面は平面なので極値は端か折れ目）。
 * @returns {{min:number, max:number}|null}
 */
export function roofZRangeAlong(roof, origin, dir, tMax) {
  let min = Infinity, max = -Infinity;
  const creaseTs = creaseCrossings(roof.creases, origin, dir);
  for (const [a, b0] of roofIntervalsAlong(roof, origin, dir)) {
    const b = Math.min(b0, tMax);
    if (!(b >= a)) continue;
    const steps = Math.max(1, Math.ceil((b - a) / FACADE_VIS_SAMPLE_MM));
    const ts = [];
    for (let i = 0; i <= steps; i++) ts.push(i === steps ? b : a + ((b - a) * i) / steps);
    for (const t of creaseTs) if (t > a && t < b) ts.push(t);
    for (const t of ts) {
      const z = roof.zAt(origin.x + dir.x * t, origin.y + dir.y * t);
      if (z < min) min = z;
      if (z > max) max = z;
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}
