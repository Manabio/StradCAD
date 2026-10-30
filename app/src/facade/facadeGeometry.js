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
 *
 * 屋根（S2。inputs.roofs＝facadeRoof.js の屋根。リード裁定）:
 * - 屋根の線（平面の 3D 線）を投影し、壁と同じ隠れ判定で見える部分だけ描く。投影して重なる斜めの線は1本にまとめる
 *   （切妻の奥のけらばは手前のけらばと同じ線になる）。
 * - 屋根による隠れ: 点 (u, z, depth) より手前の屋根の部分（外形線の内側で視線が通るところ）の屋根面の z の
 *   最小〜最大を調べ、[最小 − FACADE_ROOF_OCCLUSION_DEPTH_MM, 最大 − ε] の z は隠れる。
 * - 屋根が載る階の頭打ち: zHi が屋根の軒の高さと一致する階は、屋根の外形線の内側にある u の壁の上端を屋根面の高さにし
 *   （妻は屋根面まで続き、軒側は軒の下に隠れる）、その u の上端の横線は描かない。階の遮蔽の上端も同じ高さ。
 *   頭打ちで立ち上がった壁と面一の別の階の角の縦線は描かない（continuedFace）。
 * - 下屋の取り合い: zLo が下屋の軒の高さと一致する階（下屋が付く階）は、下屋の外形線の内側にある u の下端の横線の代わりに、
 *   壁の面の屋根面の高さの線（屋根が壁に取りつく線）を屋根の線として描く。その階の角の縦線は、下屋の屋根面が zLo より低い u
 *   （軒の出の帯）では屋根面まで下ろす（wallBottomAt）。
 */
import { FacadeDirection, FACADE_DIRECTION_ORDER } from '../core/constants.js';
import { ElevationLineRole, COORD_EPS_MM, SAMPLE_OFFSET_MM } from '../elevation/elevationStyle.js';
import { mergeIntervals } from '../elevation/elevationPrimitives.js';
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import {
  FACADE_VIS_SAMPLE_MM, FACADE_VIS_BISECT_MM, FACADE_ROOF_OCCLUSION_DEPTH_MM, FACADE_ROOF_LINE_KIND,
} from './facadeStyle.js';
import { roofIntervalsAlong, roofCoversPoint, roofZRangeAlong, sampledRoofEdge } from './facadeRoof.js';

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

/** projectToView の逆（normal は単位ベクトル）。面の (u, depth) の平面の点。 */
export function planPointOf(normal, u, depth) {
  return { x: normal.y * u - normal.x * depth, y: -normal.x * u - normal.y * depth };
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
 * 面ごとの階のプロファイル（GL より上に何かある階だけ）。capRoofs＝軒の高さが zHi と一致する屋根（頭打ちの対象）、
 * footRoofs＝軒の高さが zLo と一致する屋根（その階の壁の足元に取りつく下屋。取り合いの線の対象）。無ければ []。
 * @returns {Array<{planeId:string, zLoMm:number, zHiMm:number, pieces:Array<{lo,hi,d}>, capRoofs:Array<object>,
 *   footRoofs:Array<object>}>}
 */
export function facadeFloorProfiles(inputs, normal) {
  const glZ = inputs.glZMm;
  const roofs = inputs.roofs ?? [];
  const out = [];
  for (const f of inputs.floors ?? []) {
    if (!(f.zHiMm > glZ + COORD_EPS_MM)) continue; // GL より下だけの階は描かない
    const pieces = depthProfile(f.segments ?? [], normal);
    if (pieces.length === 0) continue;
    const capRoofs = roofs.filter(r => Math.abs(r.eaveZMm - f.zHiMm) <= COORD_EPS_MM);
    const footRoofs = roofs.filter(r => Math.abs(r.eaveZMm - f.zLoMm) <= COORD_EPS_MM);
    out.push({ planeId: f.planeId, zLoMm: Math.max(f.zLoMm, glZ), zHiMm: f.zHiMm, pieces, capRoofs, footRoofs });
  }
  return out;
}

/**
 * 階 f の u（深さ d の壁。省略時は包絡の深さ）の壁の上端。屋根の外形線の内側なら屋根面の高さ（複数なら最大）、そうでなければ zHi。
 */
export function wallTopAt(f, normal, u, d = profileDepthAt(f.pieces, u)) {
  return roofZAtWall(f.capRoofs, normal, u, d) ?? f.zHiMm;
}

/**
 * 階 f の u（深さ d の壁）の壁の下端。足元の下屋（footRoofs）の外形線の内側で屋根面が zLo より低ければ屋根面の高さ、そうでなければ zLo。
 * 下屋の軒の出の帯（水下の辺の外）では屋根面が FL より下がるので、その上に立つ上の階の壁の角の縦線を屋根面まで下ろす
 * （roof-test2 西面 u=−7057.5: 2階の角の線が 3000 から始まり、けらばの線 2982.75 との間に 17mm の切れ目が出ていた）。
 */
export function wallBottomAt(f, normal, u, d = profileDepthAt(f.pieces, u)) {
  const z = roofZAtWall(f.footRoofs, normal, u, d);
  return z != null && z < f.zLoMm ? z : f.zLoMm;
}

// 深さ d の壁の u の点を外形線の内側に含む屋根の屋根面の高さ（複数なら最大）。無ければ null。
function roofZAtWall(roofs, normal, u, d) {
  if (!(roofs?.length > 0) || !Number.isFinite(d)) return null;
  const p = planPointOf(normal, u, d);
  let top = null;
  for (const r of roofs) {
    if (!roofCoversPoint(r, p.x, p.y)) continue;
    const z = r.zAt(p.x, p.y);
    if (top == null || z > top) top = z;
  }
  return top;
}

/** 深さ d・u 区間 [lo,hi] の壁のうち、屋根 roofs の外形線の内側にある u 区間。 */
function roofSpansOnWall(roofs, normal, d, lo, hi) {
  if (!(roofs?.length > 0)) return [];
  const origin = planPointOf(normal, 0, d);
  const dir = { x: normal.y, y: -normal.x }; // u が 1 増える向き
  const spans = roofs.flatMap(r => roofIntervalsAlong(r, origin, dir))
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b - a > COORD_EPS_MM);
  return mergeIntervals(spans);
}

/**
 * 点 (u, z, depth) が、それより手前の屋根の部分に隠れるか（屋根面の z の [最小 − 遮蔽の厚み, 最大 − ε]）。
 * 視線を u の両側へ SAMPLE_OFFSET_MM ずらした2本で調べ、両方で隠れるときだけ隠れる（外形線の辺に沿う視線＝屋根の輪郭の上の点は
 * 外側の1本が屋根を通らないので見える。片流れの水上側から見たけらばの縦の線など）。
 */
function hiddenByRoofs(roofs, normal, u, z, depth) {
  if (roofs.length === 0) return false;
  const dir = { x: -normal.x, y: -normal.y }; // depth が 1 増える向き
  const hiddenOnLine = uu => {
    const origin = planPointOf(normal, uu, 0);
    for (const r of roofs) {
      const range = roofZRangeAlong(r, origin, dir, depth - SAMPLE_OFFSET_MM);
      if (!range) continue;
      if (z >= range.min - FACADE_ROOF_OCCLUSION_DEPTH_MM - COORD_EPS_MM && z <= range.max - COORD_EPS_MM) return true;
    }
    return false;
  };
  return hiddenOnLine(u - SAMPLE_OFFSET_MM) && hiddenOnLine(u + SAMPLE_OFFSET_MM);
}

/**
 * 点 (u, z) の深さ depth の線が、いずれかの階の手前の面か手前の屋根に隠れるか。
 * 階の遮蔽の上端は頭打ち（wallTopAt）。roofs・normal を省くと屋根を見ない（S1 と同じ）。
 */
export function isHidden(profiles, u, z, depth, roofs = [], normal = null) {
  for (const f of profiles) {
    if (z < f.zLoMm - COORD_EPS_MM) continue;
    const d = profileDepthAt(f.pieces, u);
    if (!(d < depth - SAMPLE_OFFSET_MM)) continue;
    const top = normal ? wallTopAt(f, normal, u, d) : f.zHiMm;
    if (z <= top + COORD_EPS_MM) return true;
  }
  return normal ? hiddenByRoofs(roofs, normal, u, z, depth) : false;
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

// 候補線を集める。縦: { kind:'v', u, zLo, zHi, d, floor }。横: { kind:'h', z, uLo, uHi, d }。
// 下屋の取り合い: { kind:'foot', uLo, uHi, d, roofs }（壁の足元が下屋の屋根面に載る u 区間。下端の横線の代わりに屋根面の高さの線）。
function candidateLines(profiles, glZ, normal) {
  const out = [];
  for (const f of profiles) {
    // 縦線: 包絡の端（隣が建物なし）と深さが変わる点。深さは両側の手前の方（凸の角）。上端は頭打ち（wallTopAt）、
    // 下端は足元の下屋の屋根面（wallBottomAt。GL に乗る階は glZ より下がらない）。
    const bounds = new Map(); // u（丸めキー）→ { u, d }
    const addBound = (u, d) => {
      for (const b of bounds.values()) if (Math.abs(b.u - u) <= COORD_EPS_MM) { b.d = Math.min(b.d, d); return; }
      bounds.set(bounds.size, { u, d });
    };
    for (const p of f.pieces) { addBound(p.lo, p.d); addBound(p.hi, p.d); }
    for (const b of bounds.values()) {
      const zLo = Math.max(wallBottomAt(f, normal, b.u, b.d), glZ);
      out.push({ kind: 'v', u: b.u, zLo, zHi: wallTopAt(f, normal, b.u, b.d), d: b.d, floor: f });
    }

    // 横線: 上端・下端。上下の階と面一の区間・屋根が載る（頭打ちの）区間の上端は描かない。GL に乗る下端は ▽GL の線が兼ねる。
    const bottomOnGl = Math.abs(f.zLoMm - glZ) <= COORD_EPS_MM;
    for (const p of f.pieces) {
      const topCovers = [
        ...flushCovers(profiles, f, p.d, g => Math.abs(g.zLoMm - f.zHiMm) <= COORD_EPS_MM),
        ...roofSpansOnWall(f.capRoofs, normal, p.d, p.lo, p.hi),
      ];
      for (const [a, b] of subtractCovers(p.lo, p.hi, topCovers)) out.push({ kind: 'h', z: f.zHiMm, uLo: a, uHi: b, d: p.d });
      if (bottomOnGl) continue;
      const footSpans = roofSpansOnWall(f.footRoofs, normal, p.d, p.lo, p.hi);
      const bottomCovers = [...flushCovers(profiles, f, p.d, g => Math.abs(g.zHiMm - f.zLoMm) <= COORD_EPS_MM), ...footSpans];
      for (const [a, b] of subtractCovers(p.lo, p.hi, bottomCovers)) out.push({ kind: 'h', z: f.zLoMm, uLo: a, uHi: b, d: p.d });
      for (const [a, b] of footSpans) out.push({ kind: 'foot', uLo: a, uHi: b, d: p.d, roofs: f.footRoofs });
    }
  }
  return out;
}

// 斜めの線（屋根）: 同じ直線上（向きが一致し、直線どうしの距離が COORD_EPS_MM 以内）で接する／重なる線を1本につなぐ。
function mergeCollinearSloped(lines) {
  const groups = [];
  for (const l of lines) {
    const len = Math.hypot(l.x2 - l.x1, l.z2 - l.z1);
    let dx = (l.x2 - l.x1) / len, dz = (l.z2 - l.z1) / len;
    if (dx < 0 || (dx === 0 && dz < 0)) { dx = -dx; dz = -dz; }
    const offset = dx * l.z1 - dz * l.x1; // 直線の符号付き距離（原点から）
    const along = [dx * l.x1 + dz * l.z1, dx * l.x2 + dz * l.z2].sort((a, b) => a - b);
    let g = groups.find(x => x.kind === l.kind && Math.abs(x.dx - dx) <= COORD_EPS_MM
      && Math.abs(x.dz - dz) <= COORD_EPS_MM && Math.abs(x.offset - offset) <= COORD_EPS_MM);
    if (!g) { g = { kind: l.kind, dx, dz, offset, spansByRole: new Map() }; groups.push(g); }
    if (!g.spansByRole.has(l.role)) g.spansByRole.set(l.role, []);
    g.spansByRole.get(l.role).push(along);
  }
  const out = [];
  for (const g of groups) {
    // 直線上の点＝ offset·(−dz, dx) + t·(dx, dz)
    const at = t => [-g.offset * g.dz + t * g.dx, g.offset * g.dx + t * g.dz];
    // 外形線（SILHOUETTE）と重なる細線（隅木・谷木が奥のけらばと同じ線に投影されるなど）は外形線に譲る
    const silhouette = mergeIntervals(g.spansByRole.get(ElevationLineRole.SILHOUETTE) ?? []);
    for (const [role, spans] of g.spansByRole) {
      const merged = mergeIntervals(spans);
      const kept = role === ElevationLineRole.SILHOUETTE ? merged
        : merged.flatMap(([a, b]) => subtractCovers(a, b, silhouette)).filter(([a, b]) => b - a > FACADE_VIS_BISECT_MM);
      for (const [a, b] of kept) {
        const [x1, z1] = at(a), [x2, z2] = at(b);
        out.push(withKind({ x1, z1, x2, z2, role }, g.kind));
      }
    }
  }
  return out;
}

const withKind = (line, kind) => (kind ? { ...line, kind } : line);

// 同じ向き・同じ座標（COORD_EPS_MM 以内）で接する／重なる線を1本につなぐ。水平・鉛直でない線は mergeCollinearSloped。
function mergeCollinear(allLines) {
  const isSloped = l => Math.abs(l.x1 - l.x2) > COORD_EPS_MM && Math.abs(l.z1 - l.z2) > COORD_EPS_MM;
  const lines = allLines.filter(l => !isSloped(l)).map(l => (Math.abs(l.x1 - l.x2) <= COORD_EPS_MM
    ? { ...l, x2: l.x1 } : { ...l, z2: l.z1 }));
  const groups = [];
  for (const l of lines) {
    const vertical = l.x1 === l.x2;
    const coord = vertical ? l.x1 : l.z1;
    const lo = vertical ? Math.min(l.z1, l.z2) : Math.min(l.x1, l.x2);
    const hi = vertical ? Math.max(l.z1, l.z2) : Math.max(l.x1, l.x2);
    let g = groups.find(x => x.vertical === vertical && x.role === l.role && x.kind === l.kind && Math.abs(x.coord - coord) <= COORD_EPS_MM);
    if (!g) { g = { vertical, coord, role: l.role, kind: l.kind, spans: [] }; groups.push(g); }
    g.spans.push([lo, hi]);
  }
  const out = [];
  for (const g of groups) {
    for (const [a, b] of mergeIntervals(g.spans)) {
      out.push(withKind(g.vertical
        ? { x1: g.coord, z1: a, x2: g.coord, z2: b, role: g.role }
        : { x1: a, z1: g.coord, x2: b, z2: g.coord, role: g.role }, g.kind));
    }
  }
  return [...out, ...mergeCollinearSloped(allLines.filter(isSloped))];
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
  const normal = view.normal;
  const roofs = inputs.roofs ?? [];
  const hidden = (u, z, d) => isHidden(profiles, u, z, d, roofs, normal);
  // 二分探索の精度以下の切れ端は描かない（屋根の線と同じ高さで終わる壁の上端など、見え方の境目に残る点に近い区間）
  const drawnSpans = (...args) => visibleSpans(...args).filter(([a, b]) => b - a > FACADE_VIS_BISECT_MM);
  const lines = [];
  const roofSegments = projectedRoofSegments(roofs, normal);
  // GL での切り詰めは facadeFloorProfiles だけが行う（zLoMm≥GL・zHiMm>GL の階だけ返す）ので、ここでは重ねない。
  for (const c of candidateLines(profiles, glZ, normal)) {
    if (c.kind === 'v') {
      if (!(c.zHi - c.zLo > COORD_EPS_MM)) continue;
      const visible = z => !hidden(c.u, z, c.d) && !continuedFace(profiles, c.floor, normal, c.u, z, c.d);
      for (const [a, b] of drawnSpans(c.zLo, c.zHi, zBreaks, visible)) {
        lines.push({ x1: c.u, z1: a, x2: c.u, z2: b, role });
      }
    } else if (c.kind === 'foot') {
      roofSegments.push(...footSegments(c, normal));
    } else {
      for (const [a, b] of drawnSpans(c.uLo, c.uHi, uBreaks, u => !hidden(u, c.z, c.d))) {
        lines.push({ x1: a, z1: c.z, x2: b, z2: c.z, role });
      }
    }
  }
  // 屋根の線（下屋の取り合いの線を含む）: 投影した線分の長さ s で見え隠れを調べる。GL より下は描かない。
  for (const { u1, z1, d1, u2, z2, d2, role: roofRole } of roofSegments) {
    const len = Math.hypot(u2 - u1, z2 - z1);
    const at = s => [u1 + ((u2 - u1) * s) / len, z1 + ((z2 - z1) * s) / len, d1 + ((d2 - d1) * s) / len];
    for (const [a, b] of drawnSpans(0, len, [], s => { const [u, z, d] = at(s); return z >= glZ && !hidden(u, z, d); })) {
      const [ua, za] = at(a), [ub, zb] = at(b);
      lines.push({ x1: ua, z1: za, x2: ub, z2: zb, role: roofRole, kind: FACADE_ROOF_LINE_KIND });
    }
  }
  return mergeCollinear(lines);
}

/**
 * 階の角の縦線の点 (u, z) が、別の階の面一（深さ ≤ d）の壁の内側にあるか（u の両側 FACADE_VIS_BISECT_MM で壁が続き、z がその壁の
 * 下端〜上端の内側）。下屋の妻の壁（頭打ちで屋根面まで立ち上がる下の階の壁）と面一の上の階の角の線を描かない。
 * 階の z 範囲が接するだけの S1（屋根なし）では起きない。
 */
function continuedFace(profiles, self, normal, u, z, d) {
  for (const g of profiles) {
    if (g === self || z <= g.zLoMm + COORD_EPS_MM) continue;
    const sides = [u - FACADE_VIS_BISECT_MM, u + FACADE_VIS_BISECT_MM].map(uu => [uu, profileDepthAt(g.pieces, uu)]);
    if (!sides.every(([, dd]) => dd <= d + COORD_EPS_MM)) continue;
    if (sides.every(([uu, dd]) => z < wallTopAt(g, normal, uu, dd) - COORD_EPS_MM)) return true;
  }
  return false;
}

/** 下屋の取り合いの線（壁の足元＝屋根面の高さの線）の 3D の線分を投影したもの（projectedRoofSegments と同じ形・role は外形線）。 */
function footSegments(c, normal) {
  const zAt = (x, y) => {
    let z = null;
    for (const r of c.roofs) if (roofCoversPoint(r, x, y)) { const v = r.zAt(x, y); if (z == null || v > z) z = v; }
    return z ?? Math.max(...c.roofs.map(r => r.zAt(x, y)));
  };
  const a = planPointOf(normal, c.uLo, c.d), b = planPointOf(normal, c.uHi, c.d);
  const breaksX = c.roofs.flatMap(r => r.breaksX), breaksY = c.roofs.flatMap(r => r.breaksY);
  const creases = c.roofs.flatMap(r => r.creases);
  return sampledRoofEdge(a.x, a.y, b.x, b.y, zAt, breaksX, breaksY, creases).map(s => {
    const p = projectToView(normal, s.x1, s.y1), q = projectToView(normal, s.x2, s.y2);
    return { u1: p.u, z1: s.z1, d1: p.depth, u2: q.u, z2: s.z2, d2: q.depth, role: ElevationLineRole.SILHOUETTE };
  });
}

/**
 * 屋根の 3D の線分を面へ投影する（u・z・depth）。投影して長さが COORD_EPS_MM 以下（視線方向の線）は落とす。
 * @returns {Array<{u1:number, z1:number, d1:number, u2:number, z2:number, d2:number, role:string}>}
 */
export function projectedRoofSegments(roofs, normal) {
  const out = [];
  for (const r of roofs ?? []) {
    for (const s of r.segments) {
      const p = projectToView(normal, s.x1, s.y1), q = projectToView(normal, s.x2, s.y2);
      if (!(Math.hypot(q.u - p.u, s.z2 - s.z1) > COORD_EPS_MM)) continue;
      out.push({ u1: p.u, z1: s.z1, d1: p.depth, u2: q.u, z2: s.z2, d2: q.depth, role: s.role });
    }
  }
  return out;
}
