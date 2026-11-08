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

/**
 * 外周片＝外周線分を、同一直線上の全長方形の辺の端点で区間に割ったもの（幾何的に一意。片の合計＝外周長）。
 * 片の owners ＝その区間を含む辺すべて（長方形の順→北東南西順）。rectId/side は owners[0]。
 * 別長方形の同一直線の片は端点で区切られたまま結合しない。
 * @returns {{rectId:string, side:string, a:{x,y}, b:{x,y}, owners:{rectId:string, side:string}[]}[]}
 */
export function computeOutlinePieces(rects) {
  if (!rects || rects.length === 0) return [];
  const edges = rects.flatMap(rectEdges);
  const isHoriz = e => e.side === RectSide.N || e.side === RectSide.S;
  const pieces = [];
  for (const seg of computeOutlineSegments(rects)) {
    const horiz = Math.abs(seg.a.y - seg.b.y) <= COORD_EPS_MM;
    const axis = horiz ? 'x' : 'y';
    const cross = horiz ? 'y' : 'x';
    const lines = edges.filter(e =>
      isHoriz(e) === horiz
      && Math.abs(e.a[cross] - seg.a[cross]) <= COORD_EPS_MM
      && Math.min(e.b[axis], seg.b[axis]) - Math.max(e.a[axis], seg.a[axis]) > COORD_EPS_MM);
    const cuts = uniqueSorted([
      seg.a[axis], seg.b[axis],
      ...lines.flatMap(e => [e.a[axis], e.b[axis]]).filter(v => v > seg.a[axis] && v < seg.b[axis]),
    ]);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const lo = cuts[k], hi = cuts[k + 1];
      const owners = lines
        .filter(e => e.a[axis] <= lo + COORD_EPS_MM && e.b[axis] >= hi - COORD_EPS_MM)
        .map(e => ({ rectId: e.rectId, side: e.side }));
      if (owners.length === 0) continue;
      const a = horiz ? { x: lo, y: seg.a.y } : { x: seg.a.x, y: lo };
      const b = horiz ? { x: hi, y: seg.a.y } : { x: seg.a.x, y: hi };
      pieces.push({ rectId: owners[0].rectId, side: owners[0].side, a, b, owners });
    }
  }
  return pieces;
}

/**
 * 内側の辺の区間＝各長方形の辺から、その辺に属する外周片を引いた残り（辺ごと）。
 * 完全に内側の辺は辺全体、一部が外周の辺は外周でない部分だけ。
 * @returns {{rectId:string, side:string, a:{x,y}, b:{x,y}}[]}
 */
export function computeInnerEdgeSpans(rects, pieces) {
  const out = [];
  for (const rect of rects) {
    for (const edge of rectEdges(rect)) {
      const horiz = edge.side === RectSide.N || edge.side === RectSide.S;
      const axis = horiz ? 'x' : 'y';
      const mine = pieces
        .filter(p => p.owners.some(o => o.rectId === rect.id && o.side === edge.side))
        .map(p => [p.a[axis], p.b[axis]])
        .sort((p, q) => p[0] - q[0]);
      let cur = edge.a[axis];
      const end = edge.b[axis];
      const push = (lo, hi) => {
        if (hi - lo <= COORD_EPS_MM) return;
        out.push({
          rectId: rect.id, side: edge.side,
          a: horiz ? { x: lo, y: edge.a.y } : { x: edge.a.x, y: lo },
          b: horiz ? { x: hi, y: edge.a.y } : { x: edge.a.x, y: hi },
        });
      };
      for (const [lo, hi] of mine) {
        push(cur, lo);
        cur = Math.max(cur, hi);
      }
      push(cur, end);
    }
  }
  return out;
}

/**
 * 外周の角＝水平片と垂直片が端点を共有する点（同一直線の継ぎ目は水平どうし・垂直どうしなので除く）。
 * @returns {{x:number, y:number}[]} 重複なし
 */
export function computeOutlineCorners(pieces) {
  const isH = p => Math.abs(p.a.y - p.b.y) <= COORD_EPS_MM;
  const hs = pieces.filter(isH);
  const vs = pieces.filter(p => !isH(p));
  const same = (p, q) => Math.abs(p.x - q.x) <= COORD_EPS_MM && Math.abs(p.y - q.y) <= COORD_EPS_MM;
  const out = [];
  for (const h of hs) {
    for (const hp of [h.a, h.b]) {
      if (out.some(o => same(o, hp))) continue;
      if (vs.some(v => same(v.a, hp) || same(v.b, hp))) out.push({ x: hp.x, y: hp.y });
    }
  }
  return out;
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

// ---- 隣接・連結・修正/削除の自動選定（端の長方形だけが対象。設計意図は .claude/data-model.md） ----

// 2 つの長方形が隣接＝閉区間の重なりが両軸で非負、かつ少なくとも一方が正（辺の正の長さの共有か面積の重なり。角だけの接触は隣接でない）
function areRectsAdjacent(p, q) {
  const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
  const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
  return ox >= -COORD_EPS_MM && oy >= -COORD_EPS_MM && (ox > COORD_EPS_MM || oy > COORD_EPS_MM);
}

/** rectId の長方形に隣接する長方形の配列（rects の順）。 */
export function rectNeighbors(rects, rectId) {
  const rect = rects.find(r => r.id === rectId);
  if (!rect) return [];
  return rects.filter(r => r.id !== rectId && areRectsAdjacent(rect, r));
}

/** 隣接関係で全長方形がつながっているか（BFS。0・1 個は true）。 */
export function isRectsConnected(rects) {
  if (rects.length <= 1) return true;
  const seen = new Set([rects[0].id]);
  const queue = [rects[0]];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const r of rects) {
      if (!seen.has(r.id) && areRectsAdjacent(cur, r)) {
        seen.add(r.id);
        queue.push(r);
      }
    }
  }
  return seen.size === rects.length;
}

/** 削除可＝その長方形を除いた残りが連結。存在しなければ false。 */
export function canDeleteRect(rects, rectId) {
  if (!rects.some(r => r.id === rectId)) return false;
  return isRectsConnected(rects.filter(r => r.id !== rectId));
}

// 対象が基の辺 side の外側に付いているときの、対象側の対面の辺（e→w, w→e, s→n, n→s）
const FACING_SIDE = {
  [RectSide.E]: RectSide.W,
  [RectSide.W]: RectSide.E,
  [RectSide.S]: RectSide.N,
  [RectSide.N]: RectSide.S,
};

/**
 * 隣接 1 の長方形から付加入力（基の辺・基点・辺長・奥行）を復元する。
 * 付加入力は常に基の辺の端点から伸ばすので、保存せず幾何から復元できる。
 * 隣接が 1 でない／面積が重なる（どの辺にも当たらない）／基点が復元できない → null。
 * @returns {{ baseRectId:string, side:string, along:number, depth:number, anchors:('a'|'b')[] } | null}
 */
export function deriveRectAttachment(rects, rectId) {
  const target = rects.find(r => r.id === rectId);
  if (!target) return null;
  const neighbors = rectNeighbors(rects, rectId);
  if (neighbors.length !== 1) return null;
  const base = neighbors[0];
  const near = (u, v) => Math.abs(u - v) <= COORD_EPS_MM;
  let side;
  if (near(target.x, base.x + base.w)) side = RectSide.E;
  else if (near(target.x + target.w, base.x)) side = RectSide.W;
  else if (near(target.y, base.y + base.h)) side = RectSide.S;
  else if (near(target.y + target.h, base.y)) side = RectSide.N;
  else return null;
  const horizontal = side === RectSide.N || side === RectSide.S;
  const edge = rectEdge(base, side);
  const facing = rectEdge(target, FACING_SIDE[side]);
  const samePoint = (p, q) => near(p.x, q.x) && near(p.y, q.y);
  const anchors = [];
  if (samePoint(edge.a, facing.a)) anchors.push('a');
  if (samePoint(edge.b, facing.b)) anchors.push('b');
  if (anchors.length === 0) return null;
  return {
    baseRectId: base.id,
    side,
    along: horizontal ? target.w : target.h,
    depth: horizontal ? target.h : target.w,
    anchors,
  };
}

/** 修正可＝隣接 0（最初の入力形式）または付加入力を復元できる（隣接 1）。隣接 2 以上は不可。 */
export function canEditRect(rects, rectId) {
  if (!rects.some(r => r.id === rectId)) return false;
  return rectNeighbors(rects, rectId).length === 0 || deriveRectAttachment(rects, rectId) !== null;
}
