// 敷地モード（長方形入力）の純幾何。長方形は軸平行（x, y=左上角 mm・y 下向き正、w, h mm）。
// 境界線は長方形群の外周として導出する（SiteLine は作らない）。
// 純モジュール: store.js / snap.js / .jsx / react-konva を静的に引かない（node:test から単体 import 可能）。

import { pickRedPointId } from './siteGeometry.js';

// 座標の同一判定の許容 mm（siteGeometry.js の退化判定 d < 1e-6 と同じ）
export const COORD_EPS_MM = 1e-6;

export const RectSide = Object.freeze({ N: 'n', E: 'e', S: 's', W: 'w' });

// 辺 side の外向き単位法線（y 下向き正）
const OUTWARD = {
  [RectSide.N]: { x: 0,  y: -1 },
  [RectSide.E]: { x: 1,  y: 0 },
  [RectSide.S]: { x: 0,  y: 1 },
  [RectSide.W]: { x: -1, y: 0 },
};

// 辺。a は座標の小さい側の端点（N: NW→NE / S: SW→SE / W: NW→SW / E: NE→SE）
export function rectEdge(rect, side) {
  const l = rect.x, r = rect.x + rect.w, t = rect.y, b = rect.y + rect.h;
  switch (side) {
    case RectSide.N: return { rectId: rect.id, side, a: { x: l, y: t }, b: { x: r, y: t } };
    case RectSide.S: return { rectId: rect.id, side, a: { x: l, y: b }, b: { x: r, y: b } };
    case RectSide.W: return { rectId: rect.id, side, a: { x: l, y: t }, b: { x: l, y: b } };
    case RectSide.E: return { rectId: rect.id, side, a: { x: r, y: t }, b: { x: r, y: b } };
    default: throw new Error(`未知の辺: ${side}`);
  }
}

export function rectEdges(rect) {
  return [RectSide.N, RectSide.E, RectSide.S, RectSide.W].map(s => rectEdge(rect, s));
}

/**
 * 共有辺（baseRect の side）の外側に付ける長方形。
 * 共有辺に沿う辺は anchor（基点）から他端へ向かって alongLen だけ伸び、奥行は外側へ depthLen。
 * 長さが有限でない／0 以下なら null。
 * @param {'a'|'b'} anchor 基点（rectEdge の端点 a / b）
 */
export function computeAttachedRect(baseRect, side, anchor, alongLen, depthLen) {
  if (!Number.isFinite(alongLen) || !Number.isFinite(depthLen)) return null;
  if (alongLen <= 0 || depthLen <= 0) return null;
  const edge = rectEdge(baseRect, side);
  const p = anchor === 'b' ? edge.b : edge.a;
  const q = anchor === 'b' ? edge.a : edge.b;
  const dir = { x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) };
  const n = OUTWARD[side];
  const ex = p.x + dir.x * alongLen + n.x * depthLen;
  const ey = p.y + dir.y * alongLen + n.y * depthLen;
  return {
    x: Math.min(p.x, ex),
    y: Math.min(p.y, ey),
    w: Math.abs(ex - p.x),
    h: Math.abs(ey - p.y),
  };
}

// 昇順ソートして COORD_EPS_MM 以内を同一視した座標列
function uniqueSorted(values) {
  const sorted = [...values].sort((u, v) => u - v);
  const out = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > COORD_EPS_MM) out.push(v);
  }
  return out;
}

// 全長方形の x/y でグリッド分割し、各セルの被覆（いずれかの長方形に含まれるか）を返す。
// covered(i, j): i=列（xs[i]..xs[i+1]）, j=行（ys[j]..ys[j+1]）。範囲外は false。
function buildGrid(rects) {
  const xs = uniqueSorted(rects.flatMap(r => [r.x, r.x + r.w]));
  const ys = uniqueSorted(rects.flatMap(r => [r.y, r.y + r.h]));
  const nx = Math.max(xs.length - 1, 0);
  const ny = Math.max(ys.length - 1, 0);
  const cov = Array.from({ length: nx }, () => new Array(ny).fill(false));
  for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ny; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      cov[i][j] = rects.some(r => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h);
    }
  }
  const covered = (i, j) => i >= 0 && i < nx && j >= 0 && j < ny && cov[i][j];
  return { xs, ys, nx, ny, covered };
}

/**
 * 長方形群の和集合の外周。「一方だけ被覆されたセル辺」を集め、同一直線上の隣接片を結合する。
 * 穴があれば穴の縁も出る。空なら []。
 * @returns {{a:{x,y}, b:{x,y}}[]} a は座標の小さい側
 */
export function computeOutlineSegments(rects) {
  if (!rects || rects.length === 0) return [];
  const { xs, ys, nx, ny, covered } = buildGrid(rects);
  const segs = [];

  // 水平辺（y = ys[j]、j=0..ny）: 上セル(i,j-1)と下セル(i,j)の被覆が一方だけ → 辺
  for (let j = 0; j <= ny; j++) {
    let start = -1;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && covered(i, j - 1) !== covered(i, j);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        segs.push({ a: { x: xs[start], y: ys[j] }, b: { x: xs[i], y: ys[j] } });
        start = -1;
      }
    }
  }
  // 垂直辺（x = xs[i]、i=0..nx）: 左セル(i-1,j)と右セル(i,j)の被覆が一方だけ → 辺
  for (let i = 0; i <= nx; i++) {
    let start = -1;
    for (let j = 0; j <= ny; j++) {
      const on = j < ny && covered(i - 1, j) !== covered(i, j);
      if (on && start < 0) start = j;
      if (!on && start >= 0) {
        segs.push({ a: { x: xs[i], y: ys[start] }, b: { x: xs[i], y: ys[j] } });
        start = -1;
      }
    }
  }
  return segs;
}

// 軸平行な線分 s と t が同一直線上で正の長さ重なるか
function overlapsCollinear(s, t) {
  const horiz = Math.abs(s.a.y - s.b.y) <= COORD_EPS_MM;
  if (horiz) {
    if (Math.abs(t.a.y - t.b.y) > COORD_EPS_MM || Math.abs(s.a.y - t.a.y) > COORD_EPS_MM) return false;
    return Math.min(s.b.x, t.b.x) - Math.max(s.a.x, t.a.x) > COORD_EPS_MM;
  }
  if (Math.abs(t.a.x - t.b.x) > COORD_EPS_MM || Math.abs(s.a.x - t.a.x) > COORD_EPS_MM) return false;
  return Math.min(s.b.y, t.b.y) - Math.max(s.a.y, t.a.y) > COORD_EPS_MM;
}

/**
 * 共有辺に選べるか＝その辺の少なくとも一部が外周上にある。完全に内側の辺は偽。
 * 辺の片側は当該長方形自身が被覆しているため、同一直線上に外周片が重なれば反対側は未被覆。
 */
export function isEdgeAttachable(rects, rectId, side) {
  const rect = rects.find(r => r.id === rectId);
  if (!rect) return false;
  const edge = rectEdge(rect, side);
  return computeOutlineSegments(rects).some(seg => overlapsCollinear(edge, seg));
}

// 和集合の面積 ㎡（重なりは数えない）
export function computeUnionAreaM2(rects) {
  if (!rects || rects.length === 0) return 0;
  const { xs, ys, nx, ny, covered } = buildGrid(rects);
  let mm2 = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (covered(i, j)) mm2 += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  return mm2 / 1_000_000;
}

// 共有辺の基点の初期値（pickRedPointId と同じ規則: 画面左上原点に近い端点＝赤＝基点）
export function pickRectEdgeAnchor(edge, viewport) {
  return pickRedPointId({ id: 'a', ...edge.a }, { id: 'b', ...edge.b }, viewport);
}
