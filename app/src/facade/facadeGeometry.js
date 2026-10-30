/**
 * 立面図（外壁立面4面）の純幾何。入力は facadeInputs.js buildFacadeInputs の返り値（graph を引かない）。
 *
 * - 面の向き: 法線 n は建物から見る人へ向く単位ベクトル（平面は y 下向き正）。方位未指定は 東=(1,0)・南=(0,1)・
 *   西=(−1,0)・北=(0,−1)（3時・6時・9時・12時）。真北の角度 θ（画面の上から時計回りの度）があれば、
 *   90°単位に丸めた回数だけ時計回りにずらす。
 * - 投影: u = ny·x − nx·y（図の右向きが正）、depth = −(nx·x + ny·y)（小さいほど手前）。
 * - 階ごとの奥行きプロファイル d_f(u): 手前を向く外壁の線分の深さの下側包絡（視線が最初に当たる面）。
 *   壁は各階の zLo〜zHi を全高で占めるとみなす（S1 は屋根・開口なし）。
 * - 候補線: 縦＝包絡の端と深さが変わる u。横＝各階の上端・下端（包絡の区間ごと）。
 *   上下の階が面一（|Δd|≤COORD_EPS_MM）の区間の境と、GL に乗る下端（▽GL の線が兼ねる）は描かない。
 * - 隠れ: ある階 f が zLo_f−ε ≤ z ≤ zHi_f+ε かつ d_f(u) < d − SAMPLE_OFFSET_MM なら、その点は隠れる。
 *   FACADE_VIS_SAMPLE_MM ごとに調べ、見え方が変わる区間を FACADE_VIS_BISECT_MM まで二分探索で詰める
 *   （包絡の折れ点・階の境が近ければそこへ寄せる）。続く可視区間は1本につなぐ。z<glZMm は描かない。
 */
import { FacadeDirection, FACADE_DIRECTION_ORDER } from '../core/constants.js';
import { ElevationLineRole, COORD_EPS_MM, SAMPLE_OFFSET_MM } from '../elevation/elevationStyle.js';
import { mergeIntervals } from '../elevation/elevationPrimitives.js';
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { FACADE_VIS_SAMPLE_MM, FACADE_VIS_BISECT_MM } from './facadeStyle.js';

// 方位の回転の刻み（度）と1回転の刻み数。方位は 90°単位に丸めて軸の割り当てをずらす（リード裁定 R1）。
const QUARTER_TURN_DEG = 90;
const QUARTER_TURNS_PER_REV = 4;

// 方位未指定のときの各面の法線（3時・6時・9時・12時）。
const BASE_NORMALS = Object.freeze({
  [FacadeDirection.EAST]:  Object.freeze({ x: 1,  y: 0 }),
  [FacadeDirection.SOUTH]: Object.freeze({ x: 0,  y: 1 }),
  [FacadeDirection.WEST]:  Object.freeze({ x: -1, y: 0 }),
  [FacadeDirection.NORTH]: Object.freeze({ x: 0,  y: -1 }),
});

// -0 を 0 にそろえる（deepEqual・表示で -0 を出さない）。
const noNegZero = v => (v === 0 ? 0 : v);

/**
 * 4面の向き（東・南・西・北の順）。northAngleDeg が有限なら k=round(θ/90) mod 4 回、時計回りに法線を回す
 * （y 下向きの画面で時計回りの 90°回転は (x,y)→(−y,x)）。
 * @param {number|null} [northAngleDeg]
 * @returns {Array<{direction:string, normal:{x:number,y:number}}>}
 */
export function facadeViews(northAngleDeg = null) {
  const k = Number.isFinite(northAngleDeg)
    ? ((Math.round(northAngleDeg / QUARTER_TURN_DEG) % QUARTER_TURNS_PER_REV) + QUARTER_TURNS_PER_REV) % QUARTER_TURNS_PER_REV
    : 0;
  return FACADE_DIRECTION_ORDER.map(direction => {
    let { x, y } = BASE_NORMALS[direction];
    for (let i = 0; i < k; i++) [x, y] = [-y, x];
    return { direction, normal: { x: noNegZero(x), y: noNegZero(y) } };
  });
}

/** 平面の点 (x,y) を面 normal へ投影する。u＝図の右向きが正、depth＝小さいほど手前。 */
export function projectToView(normal, x, y) {
  return {
    u: noNegZero(normal.y * x - normal.x * y),
    depth: noNegZero(-(normal.x * x + normal.y * y)),
  };
}

/**
 * 外壁の線分がその面（normal）の手前を向くか。縦線（x=value）は外向きが nx と一致、横線（y=value）は ny と一致。
 * @param {{isVertical:boolean, outwardSign:number}} seg
 * @param {{x:number,y:number}} normal
 */
export function isFacingSegment(seg, normal) {
  return seg.isVertical
    ? normal.y === 0 && seg.outwardSign === normal.x
    : normal.x === 0 && seg.outwardSign === normal.y;
}

// 手前を向く線分を u 区間と深さへ（縦線は (value, lo..hi)、横線は (lo..hi, value) の2端を投影）。
function segmentSpan(seg, normal) {
  const p = seg.isVertical ? projectToView(normal, seg.value, seg.lo) : projectToView(normal, seg.lo, seg.value);
  const q = seg.isVertical ? projectToView(normal, seg.value, seg.hi) : projectToView(normal, seg.hi, seg.value);
  return { lo: Math.min(p.u, q.u), hi: Math.max(p.u, q.u), d: p.depth };
}

// 昇順に並べて COORD_EPS_MM 以内を1つにまとめる。
function uniqueSorted(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1] > COORD_EPS_MM) out.push(v);
  return out;
}

/**
 * 1階分の奥行きプロファイル（手前を向く線分の深さの下側包絡）。区間は昇順・互いに素で、
 * 隣り合う同じ深さ（|Δd|≤COORD_EPS_MM）は1つにまとめる。建物の無い u は区間に含まれない（深さ＝∞）。
 * @param {Array<{isVertical:boolean, value:number, lo:number, hi:number, outwardSign:number}>} segments
 * @param {{x:number,y:number}} normal
 * @returns {Array<{lo:number, hi:number, d:number}>}
 */
export function depthProfile(segments, normal) {
  const spans = segments
    .filter(s => isFacingSegment(s, normal))
    .map(s => segmentSpan(s, normal))
    .filter(s => s.hi - s.lo > COORD_EPS_MM);
  const breaks = uniqueSorted(spans.flatMap(s => [s.lo, s.hi]));
  const pieces = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const lo = breaks[i], hi = breaks[i + 1];
    const mid = (lo + hi) / 2;
    let d = Infinity;
    for (const s of spans) if (s.lo <= mid && mid <= s.hi && s.d < d) d = s.d;
    if (!Number.isFinite(d)) continue;
    const prev = pieces[pieces.length - 1];
    if (prev && Math.abs(prev.hi - lo) <= COORD_EPS_MM && Math.abs(prev.d - d) <= COORD_EPS_MM) prev.hi = hi;
    else pieces.push({ lo, hi, d });
  }
  return pieces;
}

/** プロファイルの u における深さ（その点を含む区間の最小。端点は両側の小さい方。建物が無ければ ∞）。 */
export function profileDepthAt(pieces, u) {
  let d = Infinity;
  for (const p of pieces) {
    if (p.lo - COORD_EPS_MM <= u && u <= p.hi + COORD_EPS_MM && p.d < d) d = p.d;
  }
  return d;
}

/**
 * 面ごとの階のプロファイル（GL より上に何かある階だけ）。
 * @returns {Array<{planeId:string, zLoMm:number, zHiMm:number, pieces:Array<{lo,hi,d}>}>}
 */
export function facadeFloorProfiles(inputs, normal) {
  const glZ = inputs.glZMm;
  const out = [];
  for (const f of inputs.floors ?? []) {
    if (!(f.zHiMm > glZ + COORD_EPS_MM)) continue; // GL より下だけの階は描かない
    const pieces = depthProfile(f.segments ?? [], normal);
    if (pieces.length === 0) continue;
    out.push({ planeId: f.planeId, zLoMm: Math.max(f.zLoMm, glZ), zHiMm: f.zHiMm, pieces });
  }
  return out;
}

/** 点 (u, z) の深さ depth の線が、いずれかの階の手前の面に隠れるか。 */
export function isHidden(profiles, u, z, depth) {
  for (const f of profiles) {
    if (z < f.zLoMm - COORD_EPS_MM || z > f.zHiMm + COORD_EPS_MM) continue;
    if (profileDepthAt(f.pieces, u) < depth - SAMPLE_OFFSET_MM) return true;
  }
  return false;
}

// [lo,hi] の可視区間。FACADE_VIS_SAMPLE_MM ごと＋breaks（折れ点）で標本を取り、見え方が変わる区間を
// FACADE_VIS_BISECT_MM まで二分探索で詰める。詰めた位置の近くに折れ点があればそこへ寄せる。続く可視区間は1本につなぐ。
function visibleSpans(lo, hi, breaks, isVisibleAt) {
  const steps = Math.max(1, Math.ceil((hi - lo) / FACADE_VIS_SAMPLE_MM));
  const grid = [];
  for (let i = 0; i <= steps; i++) grid.push(i === steps ? hi : lo + ((hi - lo) * i) / steps);
  const inner = breaks.filter(b => b > lo && b < hi);
  const samples = uniqueSorted([...grid, ...inner]);
  const snap = t => {
    for (const b of breaks) if (Math.abs(b - t) <= FACADE_VIS_BISECT_MM) return b;
    return t;
  };
  const vis = samples.map(isVisibleAt);
  const spans = [];
  let start = vis[0] ? samples[0] : null;
  for (let i = 0; i + 1 < samples.length; i++) {
    if (vis[i] === vis[i + 1]) continue;
    let a = samples[i], b = samples[i + 1];
    while (b - a > FACADE_VIS_BISECT_MM) {
      const m = (a + b) / 2;
      if (isVisibleAt(m) === vis[i]) a = m; else b = m;
    }
    const t = snap((a + b) / 2);
    if (vis[i]) { spans.push([start, t]); start = null; } else start = t;
  }
  if (start != null) spans.push([start, samples[samples.length - 1]]);
  // 0 長の隠れ（折れ点ちょうどの1点）で切れた区間をつなぐ。0 長の可視区間は捨てる。
  const merged = [];
  for (const [a, b] of spans) {
    if (!(b - a > COORD_EPS_MM)) continue;
    const prev = merged[merged.length - 1];
    if (prev && a - prev[1] <= COORD_EPS_MM) prev[1] = b;
    else merged.push([a, b]);
  }
  return merged;
}

// [lo,hi] から covers を差し引いた残り（COORD_EPS_MM 以下の切れ端は捨てる）。
function subtractCovers(lo, hi, covers) {
  return subtractIntervals(lo, hi, covers).filter(([a, b]) => b - a > COORD_EPS_MM);
}

// 階 f の深さ d の区間のうち、z が接する別の階 g（touch(g)）の包絡が面一（|Δd|≤COORD_EPS_MM）の u 区間。
function flushCovers(profiles, self, d, touch) {
  const covers = [];
  for (const g of profiles) {
    if (g === self || !touch(g)) continue;
    for (const p of g.pieces) if (Math.abs(p.d - d) <= COORD_EPS_MM) covers.push([p.lo, p.hi]);
  }
  return covers;
}

// 候補線を集める。縦: { kind:'v', u, zLo, zHi, d }。横: { kind:'h', z, uLo, uHi, d }。
function candidateLines(profiles, glZ) {
  const out = [];
  for (const f of profiles) {
    // 縦線: 包絡の端（隣が建物なし）と深さが変わる点。深さは両側の手前の方（凸の角）。
    const bounds = new Map(); // u（丸めキー）→ { u, d }
    const addBound = (u, d) => {
      for (const b of bounds.values()) if (Math.abs(b.u - u) <= COORD_EPS_MM) { b.d = Math.min(b.d, d); return; }
      bounds.set(bounds.size, { u, d });
    };
    for (const p of f.pieces) { addBound(p.lo, p.d); addBound(p.hi, p.d); }
    for (const b of bounds.values()) out.push({ kind: 'v', u: b.u, zLo: f.zLoMm, zHi: f.zHiMm, d: b.d });

    // 横線: 上端・下端。上下の階と面一の区間は描かない。GL に乗る下端は ▽GL の線が兼ねる。
    const bottomOnGl = Math.abs(f.zLoMm - glZ) <= COORD_EPS_MM;
    for (const p of f.pieces) {
      const topCovers = flushCovers(profiles, f, p.d, g => Math.abs(g.zLoMm - f.zHiMm) <= COORD_EPS_MM);
      for (const [a, b] of subtractCovers(p.lo, p.hi, topCovers)) out.push({ kind: 'h', z: f.zHiMm, uLo: a, uHi: b, d: p.d });
      if (bottomOnGl) continue;
      const bottomCovers = flushCovers(profiles, f, p.d, g => Math.abs(g.zHiMm - f.zLoMm) <= COORD_EPS_MM);
      for (const [a, b] of subtractCovers(p.lo, p.hi, bottomCovers)) out.push({ kind: 'h', z: f.zLoMm, uLo: a, uHi: b, d: p.d });
    }
  }
  return out;
}

// 同じ向き・同じ座標（COORD_EPS_MM 以内）で接する／重なる線を1本につなぐ。
function mergeCollinear(lines) {
  const groups = [];
  for (const l of lines) {
    const vertical = l.x1 === l.x2;
    const coord = vertical ? l.x1 : l.z1;
    const lo = vertical ? Math.min(l.z1, l.z2) : Math.min(l.x1, l.x2);
    const hi = vertical ? Math.max(l.z1, l.z2) : Math.max(l.x1, l.x2);
    let g = groups.find(x => x.vertical === vertical && x.role === l.role && Math.abs(x.coord - coord) <= COORD_EPS_MM);
    if (!g) { g = { vertical, coord, role: l.role, spans: [] }; groups.push(g); }
    g.spans.push([lo, hi]);
  }
  const out = [];
  for (const g of groups) {
    for (const [a, b] of mergeIntervals(g.spans)) {
      out.push(g.vertical
        ? { x1: g.coord, z1: a, x2: g.coord, z2: b, role: g.role }
        : { x1: a, z1: g.coord, x2: b, z2: g.coord, role: g.role });
    }
  }
  return out;
}

/**
 * 1面分の外形線（u 座標・世界 z）。GL より下は描かない。
 * @param {{glZMm:number, floors:Array}} inputs - buildFacadeInputs の返り値
 * @param {{direction:string, normal:{x:number,y:number}}} view - facadeViews の1件
 * @returns {Array<{x1:number, z1:number, x2:number, z2:number, role:string}>}
 */
export function buildFacadeLines(inputs, view) {
  const glZ = inputs.glZMm;
  const profiles = facadeFloorProfiles(inputs, view.normal);
  const uBreaks = uniqueSorted(profiles.flatMap(f => f.pieces.flatMap(p => [p.lo, p.hi])));
  const zBreaks = uniqueSorted(profiles.flatMap(f => [f.zLoMm, f.zHiMm]));
  const role = ElevationLineRole.SILHOUETTE;
  const lines = [];
  // GL での切り詰めは facadeFloorProfiles だけが行う（zLoMm≥GL・zHiMm>GL の階だけ返す）ので、ここでは重ねない。
  for (const c of candidateLines(profiles, glZ)) {
    if (c.kind === 'v') {
      for (const [a, b] of visibleSpans(c.zLo, c.zHi, zBreaks, z => !isHidden(profiles, c.u, z, c.d))) {
        lines.push({ x1: c.u, z1: a, x2: c.u, z2: b, role });
      }
    } else {
      for (const [a, b] of visibleSpans(c.uLo, c.uHi, uBreaks, u => !isHidden(profiles, u, c.z, c.d))) {
        lines.push({ x1: a, z1: c.z, x2: b, z2: c.z, role });
      }
    }
  }
  return mergeCollinear(lines);
}
