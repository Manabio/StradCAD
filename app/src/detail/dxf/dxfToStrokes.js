// ================================================================
// 線分列（dxfEntities）→ 連結成分 → ペン命令列（ストローク）（純関数）。
//   1. 端点スナップ: 許容 snapTol 以内の端点を同じ節点にする（代表＝最初に現れた点。代表との距離で判定するので連鎖しない）。
//      長さ 0 の線分・同じ節点対の重複線分は捨てる。
//   2. 連結成分: 節点でつながる線分の集まり。順序は「最初の線分の現れ順」。
//   3. 成分を一筆書き（trail）へ分解する。単純な閉じた輪郭・単純な開いた線は 1 本、分岐する成分は複数本になる
//      （始点は奇数次数の節点のうち番号最小、無ければ番号最小。各節点で線分番号最小の未使用辺へ進む＝決定的）。
//   4. 共線の間引き（許容 snapTol）→ 軸平行の区間は U/D/L/R、それ以外は 'V'（dx・dy は正の大きさ、向きは ss・st）。
//   5. 閉じた trail は closed:true で、始点へ戻る手は書かない（S1 の規約）。
// 座標は図の座標（s 右・t 下向き正）。U＝t−・D＝t+・L＝s−・R＝s+。全 LenSpec は fixed。
// 警告: CONTOUR_OPEN（閉じた輪郭 1 周ではない）・SELF_INTERSECT（輪郭が自己交差）。
// ================================================================

import {
  PenDir, DetailLenMode, DxfWarning, DXF_SNAP_TOL_MM, DXF_LEN_ROUND_FACTOR, DXF_SELFINT_MAX_SEGMENTS, DXF_SELFINT_MAX_PAIRS, DXF_SELFINT_MAX_CELL_ENTRIES,
} from '../../core/constants.js';

const SELFINT_NEIGHBOR_CELLS = 9;      // 標本点ごとに登録する周囲のセル数（3×3）
const SELFINT_CELL_MIN_TOL_FACTOR = 4; // 格子のセル寸法の下限（許容の何倍か。標本点の間隔 cell/2 の半分が許容以上になる条件）
const CLOSED_MIN_VERTICES = 3;        // 閉じた輪郭に要る頂点数
const CLOSED_MIN_EDGES = 3;           // trail が始点へ戻ったとき「閉じた」とみなす最少の辺数

const quantize = v => Math.round(v * DXF_LEN_ROUND_FACTOR) / DXF_LEN_ROUND_FACTOR;
const fixed = mm => ({ mm: quantize(mm), mode: DetailLenMode.FIXED });

// ---- 端点スナップ ----
function makeSnapper(tol) {
  const nodes = [];
  const grid = new Map();
  const cell = v => Math.floor(v / tol);
  return {
    nodes,
    idOf(p) {
      const cx = cell(p.s);
      const cy = cell(p.t);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const id of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (Math.hypot(nodes[id].s - p.s, nodes[id].t - p.t) <= tol) return id;
          }
        }
      }
      const id = nodes.length;
      nodes.push({ s: p.s, t: p.t });
      const key = `${cx},${cy}`;
      if (grid.has(key)) grid.get(key).push(id); else grid.set(key, [id]);
      return id;
    },
  };
}

function makeUnionFind() {
  const parent = new Map();
  const find = x => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r);
    let c = x;
    while (c !== r) { const n = parent.get(c) ?? c; parent.set(c, r); c = n; }
    return r;
  };
  return { find, union(a, b) { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); } };
}

// ---- 一筆書きへの分解 ----
// 全体で線形。節点ごとに未使用辺の読み出し位置（ptr）を持ち、始点探しも位置を進めるだけ
// （残り次数の偶奇が奇→偶へしか変わらない＝奇数次数の節点は減る一方なので、走査位置は戻らない）。
// 次数 3 以上の節点の点は pinned に入れる（共線の間引きで消さない＝T 字の接合点を通り抜けの線の頂点として残す）。
function trailsOf(edgeIds, edges, nodes) {
  const adj = new Map();
  const push = (n, e) => { if (adj.has(n)) adj.get(n).push(e); else adj.set(n, [e]); };
  for (const e of edgeIds) { push(edges[e].a, e); push(edges[e].b, e); }
  const remaining = new Map([...adj].map(([n, list]) => [n, list.length]));
  const ptr = new Map([...adj.keys()].map(n => [n, 0]));
  const nodeOrder = [...adj.keys()].sort((x, y) => x - y);
  const used = new Set();
  const trails = [];
  const pinned = new WeakSet();
  let oddAt = 0;
  let anyAt = 0;
  while (used.size < edgeIds.length) {
    while (oddAt < nodeOrder.length && remaining.get(nodeOrder[oddAt]) % 2 === 0) oddAt++;
    let start;
    if (oddAt < nodeOrder.length) start = nodeOrder[oddAt];
    else {
      while (remaining.get(nodeOrder[anyAt]) === 0) anyAt++;
      start = nodeOrder[anyAt];
    }
    const path = [start];
    let cur = start;
    for (;;) {
      const list = adj.get(cur);
      let p = ptr.get(cur);
      while (p < list.length && used.has(list[p])) p++;
      ptr.set(cur, p);
      if (p >= list.length) break;
      const e = list[p];
      used.add(e);
      remaining.set(edges[e].a, remaining.get(edges[e].a) - 1);
      remaining.set(edges[e].b, remaining.get(edges[e].b) - 1);
      cur = edges[e].a === cur ? edges[e].b : edges[e].a;
      path.push(cur);
    }
    const closed = path.length - 1 >= CLOSED_MIN_EDGES && path[0] === path[path.length - 1];
    const ids = closed ? path.slice(0, -1) : path;
    const points = ids.map(id => {
      const pt = { s: nodes[id].s, t: nodes[id].t };
      if (adj.get(id).length > 2) pinned.add(pt);
      return pt;
    });
    trails.push({ points, closed });
  }
  return { trails, pinned };
}

// ---- 共線の間引き ----
function distToLine(p, a, b) {
  const dx = b.s - a.s;
  const dy = b.t - a.t;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.s - a.s, p.t - a.t);
  return Math.abs((p.s - a.s) * dy - (p.t - a.t) * dx) / len;
}
/** p が a→b の途中にあって（折り返しでなく）a-b の線上にあるか。 */
// 次数 3 以上の節点（pinned。T 字・十字の接合点）は消さない。
const isRemovableIn = pinned => (a, p, b, tol) => !pinned.has(p)
  && (p.s - a.s) * (b.s - p.s) + (p.t - a.t) * (b.t - p.t) > 0 && distToLine(p, a, b) <= tol;

function thin(points, closed, tol, pinned) {
  const isRemovable = isRemovableIn(pinned);
  const n = points.length;
  if (n < CLOSED_MIN_VERTICES) return points;
  let pts = points;
  if (closed) {
    // 始点が共線の途中だと端を落とせないので、角になっている頂点を始点にして回す。
    const k = points.findIndex((p, i) => !isRemovable(points[(i + n - 1) % n], p, points[(i + 1) % n], tol));
    if (k < 0) return points;
    pts = [...points.slice(k), ...points.slice(0, k)];
  }
  const kept = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (!isRemovable(kept[kept.length - 1], pts[i], pts[i + 1], tol)) kept.push(pts[i]);
  }
  kept.push(pts[pts.length - 1]);
  if (closed) {
    while (kept.length > CLOSED_MIN_VERTICES && isRemovable(kept[kept.length - 2], kept[kept.length - 1], kept[0], tol)) kept.pop();
  }
  return kept;
}

// ---- 点列 → ペン命令列 ----
/**
 * @param {{s:number,t:number}[]} points 頂点列（closed でも終点を重ねない）
 * @param {{axisTol?: number, closed?: boolean}} [opts]
 * @returns {{closed: boolean, moves: object[]}}
 */
export function contourToStrokes(points, { axisTol = DXF_SNAP_TOL_MM, closed = false } = {}) {
  const moves = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const ds = points[i + 1].s - points[i].s;
    const dt = points[i + 1].t - points[i].t;
    const as = Math.abs(ds);
    const at = Math.abs(dt);
    if (as <= axisTol && at <= axisTol) continue;
    if (at <= axisTol) moves.push({ dir: ds > 0 ? PenDir.RIGHT : PenDir.LEFT, len: fixed(as) });
    else if (as <= axisTol) moves.push({ dir: dt > 0 ? PenDir.DOWN : PenDir.UP, len: fixed(at) });
    else moves.push({ dir: PenDir.VECTOR, dx: fixed(as), dy: fixed(at), ss: ds > 0 ? 1 : -1, st: dt > 0 ? 1 : -1 });
  }
  return { closed, moves };
}

// ---- 自己交差 ----
const cross = (a, b, c) => (b.s - a.s) * (c.t - a.t) - (b.t - a.t) * (c.s - a.s);
function onInterior(a, b, p, tol) {
  const len = Math.hypot(b.s - a.s, b.t - a.t);
  if (len === 0 || distToLine(p, a, b) > tol) return false;
  const along = ((p.s - a.s) * (b.s - a.s) + (p.t - a.t) * (b.t - a.t)) / len;
  return along > tol && along < len - tol;
}
const near = (p, q, tol) => Math.hypot(p.s - q.s, p.t - q.t) <= tol;
function segmentsConflict(x, y, tol) {
  // 端点を共有する対（隣り合う辺）は対象外。
  if (near(x.a, y.a, tol) || near(x.a, y.b, tol) || near(x.b, y.a, tol) || near(x.b, y.b, tol)) return false;
  const o1 = cross(x.a, x.b, y.a);
  const o2 = cross(x.a, x.b, y.b);
  const o3 = cross(y.a, y.b, x.a);
  const o4 = cross(y.a, y.b, x.b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return onInterior(x.a, x.b, y.a, tol) || onInterior(x.a, x.b, y.b, tol) || onInterior(y.a, y.b, x.a, tol) || onInterior(y.a, y.b, x.b, tol);
}
/**
 * 自己交差の判定。一様格子（セル寸法＝線分長の中央値。ただし許容の 4 倍以上）で候補の対を絞る。
 * 線分は長さに沿って cell/2 おきの標本点の周り 3×3 セルに登録する（交点を含むセルは両方の線分が必ず登録する）。
 * 線分数が DXF_SELFINT_MAX_SEGMENTS、または候補の対が DXF_SELFINT_MAX_PAIRS を超えたら判定を省いて null。
 * @returns {boolean|null} 交差あり／なし／判定を省いた
 */
function hasSelfIntersection(trails, tol) {
  const segs = [];
  for (const { points, closed } of trails) {
    const last = closed ? points.length : points.length - 1;
    for (let i = 0; i < last; i++) segs.push({ a: points[i], b: points[(i + 1) % points.length] });
  }
  if (segs.length > DXF_SELFINT_MAX_SEGMENTS) return null;
  if (segs.length < 2) return false;
  const lengths = segs.map(s => Math.hypot(s.b.s - s.a.s, s.b.t - s.a.t)).sort((x, y) => x - y);
  const cell = Math.max(lengths[Math.floor(lengths.length / 2)], SELFINT_CELL_MIN_TOL_FACTOR * tol);
  // 長い線と短い線が混在すると登録数が膨らむ。登録を始める前に数え、上限を超えるなら判定を省く。
  const sampleCount = seg => Math.max(1, Math.ceil(Math.hypot(seg.b.s - seg.a.s, seg.b.t - seg.a.t) / (cell / 2)));
  let entries = 0;
  for (const seg of segs) {
    entries += (sampleCount(seg) + 1) * SELFINT_NEIGHBOR_CELLS;
    if (!(entries <= DXF_SELFINT_MAX_CELL_ENTRIES)) return null;
  }
  const cells = new Map();
  segs.forEach((seg, idx) => {
    const n = sampleCount(seg);
    for (let k = 0; k <= n; k++) {
      const s = seg.a.s + (seg.b.s - seg.a.s) * k / n;
      const t = seg.a.t + (seg.b.t - seg.a.t) * k / n;
      const cx = Math.floor(s / cell);
      const cy = Math.floor(t / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = `${cx + dx},${cy + dy}`;
          const list = cells.get(key);
          if (!list) cells.set(key, [idx]);
          else if (list[list.length - 1] !== idx) list.push(idx);
        }
      }
    }
  });
  const tested = new Set();
  let pairs = 0;
  for (const list of cells.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        pairs += 1;
        if (pairs > DXF_SELFINT_MAX_PAIRS) return null;
        const x = segs[list[i]];
        const y = segs[list[j]];
        // 端点を共有する対（隣り合う辺・放射状の辺）は対象外。Set に積む前に除く。
        if (near(x.a, y.a, tol) || near(x.a, y.b, tol) || near(x.b, y.a, tol) || near(x.b, y.b, tol)) continue;
        const lo = Math.min(list[i], list[j]);
        const hi = Math.max(list[i], list[j]);
        const key = lo * segs.length + hi;
        if (tested.has(key)) continue;
        tested.add(key);
        if (segmentsConflict(x, y, tol)) return true;
      }
    }
  }
  return false;
}

/**
 * @param {{a:{s:number,t:number}, b:{s:number,t:number}}[]} segments dxfEntities の segments
 * @param {{snapTol?: number, axisTol?: number}} [opts]
 * @returns {{ components: {index:number, segmentCount:number, vertexCount:number, closed:boolean,
 *             trails:{points:object[], closed:boolean}[], strokes:{closed:boolean, moves:object[]}[],
 *             warnings:{code:string}[]}[] }}
 */
export function dxfToComponents(segments, { snapTol = DXF_SNAP_TOL_MM, axisTol = snapTol } = {}) {
  const snapper = makeSnapper(snapTol);
  const edges = [];
  const seen = new Set();
  for (const seg of segments) {
    const a = snapper.idOf(seg.a);
    const b = snapper.idOf(seg.b);
    if (a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a, b });
  }
  const uf = makeUnionFind();
  edges.forEach(e => uf.union(e.a, e.b));
  const groups = new Map();
  edges.forEach((e, i) => {
    const root = uf.find(e.a);
    if (groups.has(root)) groups.get(root).push(i); else groups.set(root, [i]);
  });

  const components = [];
  for (const edgeIds of groups.values()) {
    const { trails: rawTrails, pinned } = trailsOf(edgeIds, edges, snapper.nodes);
    const trails = rawTrails.map(tr => {
      const points = thin(tr.points, tr.closed, snapTol, pinned);
      return points.length < CLOSED_MIN_VERTICES && tr.closed ? { points, closed: false } : { points, closed: tr.closed };
    });
    const strokes = trails.map(tr => contourToStrokes(tr.points, { axisTol, closed: tr.closed })).filter(s => s.moves.length > 0);
    const warnings = [];
    const closed = trails.length === 1 && trails[0].closed;
    if (!closed) warnings.push({ code: DxfWarning.CONTOUR_OPEN });
    // 自己交差は間引き前の節点で見る（T 字の接合点が間引きで消えて「辺の途中に触れる」と誤検出しないように）。
    const crossing = hasSelfIntersection(rawTrails, snapTol);
    if (crossing === null) warnings.push({ code: DxfWarning.SELF_INTERSECT_UNCHECKED });
    else if (crossing) warnings.push({ code: DxfWarning.SELF_INTERSECT });
    components.push({
      index: components.length, segmentCount: edgeIds.length,
      vertexCount: trails.reduce((n, tr) => n + tr.points.length, 0),
      closed, trails, strokes, warnings,
    });
  }
  return { components };
}
