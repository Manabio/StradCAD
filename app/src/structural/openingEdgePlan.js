// 床開口（吹抜け等）の矩形1成分の4辺に小梁を架ける計画器（純関数）。
// 「梁のない辺」だけを対象に、支え間のスパンが短い辺から順に架ける（架けた梁は後続の辺の支えになる）。
// グラフ・ストア・描画に依存しない（node:test から単体 import 可能に保つ）。
// 設計意図は .claude/structural-model.md 規則O 参照。
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';

// スパンが同値とみなす差(mm)。
const SPAN_TIE_MM = 0.5;
// 座標比較の浮動小数点誤差の逃げ。
const FLOAT_EPS = 1e-9;

// 支えの種類の優先（同座標の支えが複数あるときの決定的な選び方）。
const KIND_RANK = { grid: 0, wall: 1, beam: 2, user: 3, opening: 4 };
const kindRank = kind => (kind in KIND_RANK ? KIND_RANK[kind] : 9);

/** 支え同士の決定的な順序（kind 優先 → clId）。 */
function compareHostIdentity(a, b) {
  return kindRank(a.kind) - kindRank(b.kind) || String(a.clId ?? '').localeCompare(String(b.clId ?? ''));
}

/** 辺 e を覆う支え（平行・座標が coord/target のどちらかから coverTol 以内・区間が重なる）を返す。無ければ null。 */
function findCoveringHost(e, hosts, coverTol) {
  let best = null;
  let bestDist = Infinity;
  for (const h of hosts) {
    if (h.isVertical !== e.isVertical) continue;
    const dist = Math.min(Math.abs(h.coord - e.coord), Math.abs(h.coord - e.target));
    if (dist > coverTol + FLOAT_EPS) continue;
    const overlap = Math.min(h.hi, e.hi) - Math.max(h.lo, e.lo);
    if (!(overlap > CL_OVERLAP_TOL_MM)) continue;
    if (dist < bestDist - FLOAT_EPS || (Math.abs(dist - bestDist) <= FLOAT_EPS && compareHostIdentity(h, best) < 0)) {
      best = h;
      bestDist = dist;
    }
  }
  return best;
}

const toRef = h => (h.clId === undefined ? { kind: h.kind, coord: h.coord } : { kind: h.kind, coord: h.coord, clId: h.clId });

/**
 * 辺 e を架けたときの支え間スパン。直交する支えのうち e.target を区間に含むものから、
 * lo 側＝coord ≤ e.lo+eps の最大、hi 側＝coord ≥ e.hi−eps の最小。片側でも無ければ span=Infinity。
 */
function spanOf(e, hosts, bracketEps) {
  let lo = null;
  let hi = null;
  for (const h of hosts) {
    if (h.isVertical === e.isVertical) continue;
    if (e.target < h.lo - bracketEps || e.target > h.hi + bracketEps) continue;
    if (h.coord <= e.lo + bracketEps && (lo === null || h.coord > lo.coord + FLOAT_EPS
      || (Math.abs(h.coord - lo.coord) <= FLOAT_EPS && compareHostIdentity(h, lo) < 0))) lo = h;
    if (h.coord >= e.hi - bracketEps && (hi === null || h.coord < hi.coord - FLOAT_EPS
      || (Math.abs(h.coord - hi.coord) <= FLOAT_EPS && compareHostIdentity(h, hi) < 0))) hi = h;
  }
  if (!lo || !hi) return { span: Infinity, loRef: lo ? toRef(lo) : null, hiRef: hi ? toRef(hi) : null };
  return { span: hi.coord - lo.coord, loRef: toRef(lo), hiRef: toRef(hi) };
}

/** 同スパンのときの決定的な順序（長辺 → X方向 → coord → lo → target → hi）。 */
function compareTie(a, b) {
  const la = a.edge.hi - a.edge.lo;
  const lb = b.edge.hi - b.edge.lo;
  if (Math.abs(la - lb) > FLOAT_EPS) return lb - la;
  if (a.edge.isVertical !== b.edge.isVertical) return a.edge.isVertical ? 1 : -1;
  return (a.edge.coord - b.edge.coord) || (a.edge.lo - b.edge.lo) || (a.edge.target - b.edge.target) || (a.edge.hi - b.edge.hi);
}

/**
 * 矩形1成分の4辺について、梁あり判定→最短スパン優先の配置を計画する。
 * 置く順位は「配置前の hosts だけで求めた初回スパン」で一度だけ決める（スパン昇順→辺の長さ降順→
 * 横線優先→coord→lo）。平行な対辺は初回スパンが等しいので組として連続し、最短スパンの対辺の組が
 * 先に通り、残りの組がその間に掛かる。置くたびに順位を再計算すると、同値のタイブレークで直交辺が
 * 選ばれて後の梁が前の梁に順に架かる風車状になるため、再計算しない。
 * 各辺の bracket（loRef/hiRef/span）は置く時点の hosts（先に置いた kind:'opening' の梁を含む）で求め、
 * その時点で片側でも無ければ unsupported。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outwardSign?:number, target:number}>} edges
 *   辺（target＝逃げ後の梁芯座標。壁なしなら coord と同じ）。余分なフィールドは出力へそのまま渡す。
 *   coord/lo/hi/target は有限の数であること（満たさなければ throw）。同一の辺の重複は呼び出し側が避ける。
 *   前提（呼び出し側が保証）: 逃げは常に外側（outwardSign 方向）なので、lo 側の直交辺の target は
 *   edge.lo 以下、hi 側は edge.hi 以上になり、「coord ≤ lo+eps／≥ hi−eps」で支えを拾える。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, kind:string, clId?:string, manual?:boolean}>} hosts
 *   既存の支え線（kind: 'grid'|'wall'|'beam'|'user'|'opening'。lo/hi は ±Infinity 可）。
 *   梁あり（covered）になる辺の覆い host も、直交辺の支えとして呼び出し側が必ず含める。
 * @param {{coverTol:number, bracketEps?:number, canPlace?:(edge:object)=>boolean}} opts
 * @returns {{
 *   placed: Array<{edge:object, target:number, order:number, span:number, loRef:object, hiRef:object, through:boolean}>,
 *   covered: Array<{edge:object, host:object}>,
 *   excluded: Array<{edge:object}>,
 *   unsupported: Array<{edge:object}>,
 * }}
 */
export function planOpeningEdgeBeams(edges, hosts, opts) {
  const { coverTol, bracketEps = CL_OVERLAP_TOL_MM, canPlace = () => true } = opts ?? {};
  // 入力検証: 不正値は黙って誤判定（NaN 比較が常に false になる等）になるため、呼び出し元のバグとして投げる。
  if (!Number.isFinite(coverTol) || coverTol < 0) throw new Error(`開口辺の計画: coverTol が不正です: ${coverTol}`);
  if (!Number.isFinite(bracketEps) || bracketEps < 0) throw new Error(`開口辺の計画: bracketEps が不正です: ${bracketEps}`);
  for (const e of edges) {
    for (const key of ['coord', 'lo', 'hi', 'target']) {
      if (!Number.isFinite(e[key])) throw new Error(`開口辺の計画: 辺の ${key} が有限の数ではありません: ${e[key]}`);
    }
  }
  const placed = [];
  const covered = [];
  const excluded = [];
  const unsupported = [];

  // 梁あり判定（被覆辺は host 一覧に既にあるため、直交辺の支えとしても残る）。
  const pending = [];
  for (const edge of edges) {
    const host = findCoveringHost(edge, hosts, coverTol);
    if (host) covered.push({ edge, host });
    else if (!canPlace(edge)) excluded.push({ edge });
    else pending.push(edge);
  }
  // 出力順も入力順に依存させない。
  covered.sort(compareTie);
  excluded.sort(compareTie);

  // 置く順位は配置前の hosts だけで求めた初回スパンで一度だけ決める（支え不足＝Infinity は最後尾）。
  // 同値判定（SPAN_TIE_MM）は推移的でないため比較関数に入れず、スパン昇順に並べたうえで
  // 「グループ先頭との差が SPAN_TIE_MM 以内」でグループ番号を振り、グループ番号→compareTie で並べ直す。
  const withSpan = pending
    .map(edge => ({ edge, span0: spanOf(edge, hosts, bracketEps).span }))
    .sort((a, b) => (a.span0 === b.span0 ? 0 : a.span0 < b.span0 ? -1 : 1));
  let groupHead = null;
  let group = -1;
  for (const c of withSpan) {
    // Infinity（支え不足）同士は差が NaN になるため === で同群にする。
    if (groupHead === null || !(c.span0 === groupHead || c.span0 - groupHead <= SPAN_TIE_MM)) {
      group += 1;
      groupHead = c.span0;
    }
    c.group = group;
  }
  const ranked = withSpan.sort((a, b) => a.group - b.group || compareTie(a, b));

  // 順に1本ずつ置く。bracket は置く時点の hosts（先に置いた梁を含む）で求める。
  const allHosts = hosts.slice();
  for (const { edge } of ranked) {
    const cur = spanOf(edge, allHosts, bracketEps);
    if (!Number.isFinite(cur.span)) {
      unsupported.push({ edge });
      continue;
    }
    placed.push({
      edge,
      target: edge.target,
      order: placed.length,
      span: cur.span,
      loRef: cur.loRef,
      hiRef: cur.hiRef,
      through: cur.loRef.kind !== 'opening' && cur.hiRef.kind !== 'opening',
    });
    allHosts.push({
      isVertical: edge.isVertical,
      coord: edge.target,
      lo: cur.loRef.coord,
      hi: cur.hiRef.coord,
      kind: 'opening',
    });
  }

  return { placed, covered, excluded, unsupported };
}
