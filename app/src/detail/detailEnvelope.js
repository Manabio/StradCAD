// ================================================================
// 取り合いの断面図（junction）の「室内側の包絡線」（純関数。部分詳細図 S8a）。
// 入力は fit 済みの局所点列（detailFit.js の strokes。s＝壁の仕上げ面から室内側が正・t＝下向き正）と slot。
//   - 辺: 全ストロークの辺（closed は閉じ辺も）。破線ストロークは除く。辺の印（edgeMarks）は手の番号に対応。
//   - 定義域: floorWall・dropBottom・ceilingStep は t<−ε（FL・垂れ壁の下端より上）・wallCeiling・kneeTop・floorStep は t>ε（天井面・腰壁の天端・高い側の床より下）。辺は定義域へ切り詰める。
//   - E(t): 端点・辺どうしの交点・辺が s=0 を跨ぐ点の t を昇順に並べ（DETAIL_FIT_EPS_MM 以内は併合）、各区間で最大の s の辺。s は 0 以上に頭打ち
//     （壁の中側の下地は見えない）。跨ぐ辺が無い・図の外は E=0。
//   - 区切りで左右の差 > DETAIL_ENVELOPE_STEP_MIN_MM なら段差、差が無く辺の向きの差 > DETAIL_ENVELOPE_KINK_MIN_DEG
//     なら折れ（面取りの稜線）。どちらも steps に t を積む（weight 'auto'）。
//   - 印（edge='air'）の辺は、その辺の端点の t（定義域の中）に weight 'air' を積む。同じ t（ε 以内）の auto は air に置き換える。
//   - FL・天井面（t≈0）の線は積まない。
//   - outline: E の階段折れ線 [[s,t],…]（t の昇順）。図の外側の端（floorWall は上端・wallCeiling は下端）で s=0 に戻る。
//     FL・天井面の側は閉じない（E の値で終わる）。
//   - maxDeviationMm: 定義域での max E（単純断面との形状差の上限）。
// import は constants だけ（detail/ の葉。detailPlacement.js から再輸出される）。
// ================================================================

import {
  DetailSlot, DetailEdgeMark, DetailDash, DETAIL_FIT_EPS_MM, DETAIL_ENVELOPE_STEP_MIN_MM, DETAIL_ENVELOPE_KINK_MIN_DEG,
} from '../core/constants.js';

/** steps の weight。 */
export const EnvelopeWeight = Object.freeze({ AUTO: 'auto', AIR: 'air' });

const ABOVE_ORIGIN_SLOTS = new Set([DetailSlot.FLOOR_WALL, DetailSlot.DROP_BOTTOM, DetailSlot.CEILING_STEP]);
const BELOW_ORIGIN_SLOTS = new Set([DetailSlot.WALL_CEILING, DetailSlot.KNEE_TOP, DetailSlot.FLOOR_STEP]);
const RAD_TO_DEG = 180 / Math.PI;
const EMPTY = Object.freeze({ steps: Object.freeze([]), outline: Object.freeze([]), maxDeviationMm: 0 });

// 辺の列 [{a:{s,t}, b:{s,t}, air}]。破線ストロークを除く。
function collectEdges(strokes) {
  const edges = [];
  for (const stroke of Array.isArray(strokes) ? strokes : []) {
    if (stroke?.line?.dashRole === DetailDash.DASHED) continue;
    const pts = Array.isArray(stroke?.points) ? stroke.points : [];
    for (let i = 0; i + 1 < pts.length; i++) {
      edges.push({ a: pts[i], b: pts[i + 1], air: stroke.edgeMarks?.[i] === DetailEdgeMark.AIR });
    }
    if (stroke?.closed === true && pts.length >= 3) edges.push({ a: pts[pts.length - 1], b: pts[0], air: false });
  }
  return edges;
}

// 辺を定義域 [lo, hi] の t へ切り詰める。全く入らなければ null。水平の辺（t の差が ε 以内）はそのまま（入るなら）。
function clipEdge(edge, lo, hi) {
  const { a, b } = edge;
  const t1 = Math.min(a.t, b.t);
  const t2 = Math.max(a.t, b.t);
  if (t2 < lo || t1 > hi) return null;
  if (t2 - t1 <= DETAIL_FIT_EPS_MM) return { ...edge, a: { s: a.s, t: Math.min(Math.max(a.t, lo), hi) }, b: { s: b.s, t: Math.min(Math.max(b.t, lo), hi) } };
  const at = t => ({ s: a.s + (b.s - a.s) * (t - a.t) / (b.t - a.t), t });
  const clamp = p => (p.t < lo ? at(lo) : p.t > hi ? at(hi) : p);
  return { ...edge, a: clamp(a), b: clamp(b) };
}

const sAt = (edge, t) => edge.a.s + (edge.b.s - edge.a.s) * (t - edge.a.t) / (edge.b.t - edge.a.t);
// 辺の向き（垂直からの角度。度）。垂直 0。
const angleOf = edge => Math.atan((edge.b.s - edge.a.s) / (edge.b.t - edge.a.t)) * RAD_TO_DEG;

/**
 * @param {{points:{s:number,t:number}[], closed?:boolean, line?:{dashRole?:string}, edgeMarks?:(string|null)[]}[]} strokes fit 済みのストローク列
 * @param {string} slot DetailSlot.FLOOR_WALL | WALL_CEILING | DROP_BOTTOM（floorWall と同じ定義域）| KNEE_TOP・FLOOR_STEP（wallCeiling と同じ定義域。
 *   floorStep は高い側の床より下 t>ε・立ち上がり面から低い側が s>0）
 *   ceilingStep は floorWall と同じ定義域（低い側の天井面より上 t<−ε・立ち上がり面から高い側が s>0）
 * @param {{tMaxMm?:number, tMinMm?:number}} [opts] tMaxMm＝t>ε 側の slot（wallCeiling・kneeTop・floorStep）の定義域の上限（辺をここへ切り詰める。
 *   floorStep では低い側の床＝段差高。未指定・有限でない値は上限なし）。t<−ε 側の slot では無視。
 *   tMinMm＝t<−ε 側の slot（ceilingStep）の定義域の下限（負。ceilingStep では高い側の天井面＝−段差高。未指定・有限でない・非負は下限なし）。t>ε 側の slot では無視
 * @returns {{steps:{t:number, weight:'auto'|'air'}[], outline:number[][], maxDeviationMm:number}}
 */
export function computeEnvelope(strokes, slot, { tMaxMm, tMinMm } = {}) {
  const eps = DETAIL_FIT_EPS_MM;
  // 定義域: 基準面（t=0）より上＝t<−ε の slot（床と壁・垂れ壁の下端・天井の段差）／下＝t>ε の slot（壁と天井・腰壁の天端・床の段差）
  const floorWall = ABOVE_ORIGIN_SLOTS.has(slot);
  if (!floorWall && !BELOW_ORIGIN_SLOTS.has(slot)) return EMPTY;
  // 定義域（切り詰め先）。境界 0 は FL・天井面。
  const lo = floorWall ? (Number.isFinite(tMinMm) && tMinMm < 0 ? tMinMm : -Infinity) : 0;
  const hi = floorWall ? 0 : (Number.isFinite(tMaxMm) && tMaxMm > 0 ? tMaxMm : Infinity);

  const edges = collectEdges(strokes)
    .map(e => clipEdge(e, lo, hi))
    .filter(e => e !== null && [e.a.s, e.a.t, e.b.s, e.b.t].every(Number.isFinite));
  if (edges.length === 0) return EMPTY;

  const sloped = edges.filter(e => Math.abs(e.b.t - e.a.t) > eps);

  // 区切りの t（昇順・ε 以内は併合）。定義域の境界 0・端点・非水平辺どうしの交点・非水平辺が s=0 を跨ぐ点。
  // 区間の内側では最大の辺も s の符号も変わらないので、中点での選択がそのまま区間全体で正しい
  const inRange = (e, t) => t >= Math.min(e.a.t, e.b.t) && t <= Math.max(e.a.t, e.b.t);
  const slopeOf = e => (e.b.s - e.a.s) / (e.b.t - e.a.t);
  const extra = [];
  for (let i = 0; i < sloped.length; i++) {
    const e = sloped[i];
    const ke = slopeOf(e);
    if (ke !== 0) { const t = e.a.t - e.a.s / ke; if (inRange(e, t)) extra.push(t); }
    for (let j = i + 1; j < sloped.length; j++) {
      const f = sloped[j];
      const dk = ke - slopeOf(f);
      if (dk === 0) continue;
      // sAt(e,t) = sAt(f,t) の解
      const t = (f.a.s - e.a.s + ke * e.a.t - slopeOf(f) * f.a.t) / dk;
      if (inRange(e, t) && inRange(f, t)) extra.push(t);
    }
  }
  const raw = [0, ...edges.flatMap(e => [e.a.t, e.b.t]), ...extra.filter(Number.isFinite)].sort((x, y) => x - y);
  const breaks = [];
  for (const t of raw) if (breaks.length === 0 || t - breaks[breaks.length - 1] > eps) breaks.push(t);
  if (breaks.length < 2) return EMPTY;

  // 区間ごとの E（最大 s の辺）。値は区間の両端 t での s（0 以上に頭打ち）と向き

  const intervals = [];
  for (let k = 0; k + 1 < breaks.length; k++) {
    const t0 = breaks[k];
    const t1 = breaks[k + 1];
    const mid = (t0 + t1) / 2;
    let best = null;
    let bestS = 0; // s が 0 以下の辺は壁の中で見えない（区切りに s=0 を跨ぐ点を含むので、区間内の符号は一定）
    for (const e of sloped) {
      if (Math.min(e.a.t, e.b.t) > mid || Math.max(e.a.t, e.b.t) < mid) continue;
      const s = sAt(e, mid);
      if (s > bestS) { best = e; bestS = s; }
    }
    intervals.push(best === null
      ? { t0, t1, s0: 0, s1: 0, angle: 0 }
      : { t0, t1, s0: sAt(best, t0), s1: sAt(best, t1), angle: angleOf(best) });
  }

  // 段差・折れ（auto）。定義域の境界（t≈0）と、図の外側の端での「外」との比較を含む
  const outside = { s1: 0, s0: 0, angle: 0 };
  const steps = [];
  for (let k = 0; k < breaks.length; k++) {
    const t = breaks[k];
    if (Math.abs(t) <= eps) continue;
    // floorWall は上（t 小）側が外、wallCeiling は下（t 大）側が外。区間は t の昇順
    const left = k > 0 ? intervals[k - 1] : outside;
    const right = k < intervals.length ? intervals[k] : outside;
    const stepMm = Math.abs(left.s1 - right.s0);
    const kinkDeg = Math.abs(left.angle - right.angle);
    if (stepMm > DETAIL_ENVELOPE_STEP_MIN_MM || kinkDeg > DETAIL_ENVELOPE_KINK_MIN_DEG) {
      steps.push({ t, weight: EnvelopeWeight.AUTO });
    }
  }

  // 印の辺（air）。端点の t（定義域の内側で t≈0 でないもの）。同じ t の auto は air に置き換える
  const placeAir = t => {
    if (Math.abs(t) <= eps) return;
    const i = steps.findIndex(st => Math.abs(st.t - t) <= eps);
    if (i >= 0) steps[i] = { t: steps[i].t, weight: EnvelopeWeight.AIR };
    else steps.push({ t, weight: EnvelopeWeight.AIR });
  };
  for (const e of edges) if (e.air) { placeAir(e.a.t); if (Math.abs(e.a.t - e.b.t) > eps) placeAir(e.b.t); }
  steps.sort((x, y) => x.t - y.t);

  // 輪郭（t 昇順）。floorWall は上端、wallCeiling は下端で s=0 に戻る
  const outline = [];
  const add = (s, t) => {
    const last = outline[outline.length - 1];
    if (last && Math.abs(last[0] - s) <= eps && Math.abs(last[1] - t) <= eps) return;
    outline.push([s, t]);
  };
  if (floorWall) add(0, breaks[0]);
  for (const iv of intervals) { add(iv.s0, iv.t0); add(iv.s1, iv.t1); }
  if (!floorWall) add(0, breaks[breaks.length - 1]);

  const maxDeviationMm = intervals.reduce((m, iv) => Math.max(m, iv.s0, iv.s1), 0);
  return { steps, outline, maxDeviationMm };
}
