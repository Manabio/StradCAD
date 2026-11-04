/**
 * 天伏（見上げ）の天井の段差の見切りの線（純モジュール。react・store.js・snap.js・.jsx を静的に引かない。部分詳細図 8b-4c）。
 * 低い側の天井面の持ち主（区画＞部屋。継承なし）に天井の段差の部位図（ceilingStep）が割り当てられているとき、その断面を下から見た包絡線
 * （detail/detailEnvelope.js computeUnderside。finish/partDetail.js ceilingStepUnderside 経由。detail/ は直接引かない）の跳び・折れの s に
 * 見切りの縁の線を出す。立ち上がり面（s=0＝通り芯 CL）の線は、縁の下面が低い側の天井と面一なら詳細 LOD では隠す。
 *
 * 対象＝平らな面どうしの段差（ceilingStepEdges）で、両側が同じ家族の部屋（sameRoomFamily）、辺の上に全高の壁が無い区間
 * （腰壁だけは壁とみなさない。ceilingOwners.js fullHeightWallSpansOnEdge）。
 * 線は高い側の天井面の innerLines に入れる（plan/planSolids.js ceilingSolids が ceilingStepDetailInnerLines を呼ぶ。遮蔽は解決器）。
 * 座標は平面のまま（highSign がそのまま平面座標の向き。xy は反転しない）。
 */
import { DetailSlot } from '../core/constants.js';
import { overlayGeneration } from '../catalog/catalogRegistry.js';
import { ceilingStepUnderside } from '../finish/partDetail.js';
import { SPAN_OVERLAP_EPS } from '../finish/kneeDropWall.js';
import { rectsOutlineSegments, subtractRects } from '../plan/planGeometry.js';
import { ceilingStepEdges, ceilingFaceId, sameRoomFamily } from './ceilingSurfaces.js';
import { fullHeightWallSpansOnEdge } from './ceilingOwners.js';
import { CEILING_BOUNDARY_EPS_MM, coveredIntervals, subtractIntervals, splitByCovered } from './ceilingBoundaryStyle.js';

/** 見切りの線の role（innerLine.role → prim.source.role）。 */
export const CEILING_STEP_DETAIL_ROLE = 'ceilingStepDetail';

const EPS = CEILING_BOUNDARY_EPS_MM;

const hasRef = holder => {
  const key = holder?.detailRefs?.[DetailSlot.CEILING_STEP];
  return typeof key === 'string' && key !== '';
};

/** どれかの部屋・区画に天井の段差の割当てがあるか（無ければ以降の計算を全部省く）。 */
function hasCeilingStepAssignment(graph) {
  return (graph?.rooms ?? []).some(room => hasRef(room) || (room.ceilingZones ?? []).some(hasRef));
}

// 辺 [lo,hi] から全高の壁の区間を引いた残り。壁が辺の両端を半壁厚ぶん残す隅のすき間（SPAN_OVERLAP_EPS 以下の片）は
// 壁で隔てられた辺とみなして落とす（ceilingOwners.js の共有辺の判定と同じ許容）。壁が無い辺はそのまま全体。
// 壁が 1 つでもあれば、残りは必ず片方の端で壁に接する（壁の区間は辺の内側に切り詰め済み）ので、接するかの判定は要らない。
function wallFreePieces(graph, e) {
  const full = fullHeightWallSpansOnEdge(graph, e.isVertical, e.value, e.lo, e.hi);
  if (full.length === 0) return [[e.lo, e.hi]];
  return subtractIntervals(full, e.lo, e.hi).filter(([a, b]) => b - a > SPAN_OVERLAP_EPS);
}

// 見える線の s（s≈0 を除く）を最小描画幅へ引き上げ、EPS 以内を併合した昇順の深さ。
function offsetsOf(lines, minDrawnMm) {
  const out = [];
  for (const { s } of lines) {
    if (s <= EPS) continue;
    const d = Math.max(s, minDrawnMm);
    if (out.length === 0 || d - out[out.length - 1] > EPS) out.push(d);
  }
  return out;
}

/**
 * 段差の見切りの線を作る材料。割当てが無ければ空を即返す（天井面は ceilingStepEdges 以降を計算しない）。
 * 群＝(低い側の面, 高い側の面) ごと。offsets＝高い側へ引く線の深さ（mm。minDrawnMm 未満は minDrawnMm へ引き上げて併合。s≈0 は含めない）、
 * clVisible＝s≈0 に線がある（立ち上がり面の CL の線を残す）。hiddenDatum＝clVisible でない群の辺（CL の線を詳細 LOD で隠す区間）。
 * 部位図が解決・fit できない・線が引けない群は出さない（従来どおり CL の線だけ）。
 * @param {object} graph
 * @param {Array<{roomId:string, zoneId:string|null, rects:object[], zMm:number, shape?:string}>} surfaces ceilingSurfacesOf(graph)
 * @param {{materialMap?:object|null, entryOf?:(key:string)=>object|null, minDrawnMm?:number}} [opts] minDrawnMm＝MIN_DRAWN_PAPER_MM×LOD_DETAIL_DENOM（呼び出し側が掛ける）
 * @returns {{groups: Array<{lowFaceId:string, highFaceId:string, lowRects:object[], highRects:object[], edges:Array<{isVertical:boolean, value:number, lo:number, hi:number, highSign:1|-1}>, offsets:number[], clVisible:boolean}>,
 *   hiddenDatum: Array<{isVertical:boolean, value:number, lo:number, hi:number}>}}
 */
export function ceilingStepDetailSpecs(graph, surfaces, { materialMap = null, entryOf, minDrawnMm = 0 } = {}) {
  if (!graph || !Array.isArray(surfaces) || !hasCeilingStepAssignment(graph)) return { groups: [], hiddenDatum: [] };
  const minMm = Number.isFinite(minDrawnMm) && minDrawnMm > 0 ? minDrawnMm : 0;
  const byKey = new Map(); // 群の鍵 → 群（null＝対象外）
  const groupFor = e => {
    const lowFaceId = ceilingFaceId(e.low);
    const highFaceId = ceilingFaceId(e.high);
    const key = `${lowFaceId}>${highFaceId}`;
    if (byKey.has(key)) return byKey.get(key);
    let group = null;
    const room = graph.roomMap?.get(e.low.roomId);
    const zone = e.low.zoneId ? (room?.ceilingZones ?? []).find(z => z.id === e.low.zoneId) ?? null : null;
    if (room && (!e.low.zoneId || zone) && sameRoomFamily(graph, e.low.roomId, e.high.roomId)) {
      const underside = ceilingStepUnderside({ room, zone, stepHeightMm: e.high.zMm - e.low.zMm, materialMap, entryOf });
      if (underside) {
        group = {
          lowFaceId, highFaceId, lowRects: e.low.rects, highRects: e.high.rects, edges: [],
          offsets: offsetsOf(underside.lines, minMm), clVisible: underside.lines.some(l => l.s <= EPS),
        };
      }
    }
    byKey.set(key, group);
    return group;
  };
  for (const e of ceilingStepEdges(surfaces)) {
    const group = groupFor(e);
    if (!group) continue;
    for (const [lo, hi] of wallFreePieces(graph, e)) group.edges.push({ isVertical: e.isVertical, value: e.value, lo, hi, highSign: e.highSign });
  }
  const groups = [...byKey.values()].filter(g => g && g.edges.length > 0 && g.offsets.length > 0);
  const hiddenDatum = groups.filter(g => !g.clVisible).flatMap(g => g.edges.map(({ isVertical, value, lo, hi }) => ({ isVertical, value, lo, hi })));
  return { groups, hiddenDatum };
}

const strictlyIn = (r, x, y) => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2;

// 辺の帯（高い側へ深さ d）。辺の端の先の対角の点（低い側へ EPS・端の先へ EPS）が、低い面の内側でなく高い面の内側にある端だけ
// d 延長する＝高い面が低い面の出隅を回り込む本当の出隅（四角に回す）。低い面が続く端（入隅・壁で止まる端）や、
// 低い面の角の片側が壁で高い面だけが先へ続く角（壁の面を越えて食み出す）は延長しない。
function bandRect(edge, d, lowRects, highRects = []) {
  const { isVertical, value, lo, hi, highSign } = edge;
  const lowSide = value - highSign * EPS;
  const within = (rects, along) => rects.some(r => (isVertical ? strictlyIn(r, lowSide, along) : strictlyIn(r, along, lowSide)));
  const wraps = along => !within(lowRects, along) && within(highRects, along);
  const a0 = wraps(lo - EPS) ? lo - d : lo;
  const a1 = wraps(hi + EPS) ? hi + d : hi;
  const c0 = highSign > 0 ? value : value - d;
  const c1 = highSign > 0 ? value + d : value;
  return isVertical ? { x1: c0, x2: c1, y1: a0, y2: a1 } : { x1: a0, x2: a1, y1: c0, y2: c1 };
}

const intersect = (a, b) => ({ x1: Math.max(a.x1, b.x1), x2: Math.min(a.x2, b.x2), y1: Math.max(a.y1, b.y1), y2: Math.min(a.y2, b.y2) });
const hasArea = r => r.x2 - r.x1 > EPS && r.y2 - r.y1 > EPS;

// 重なる矩形群を重ならない矩形群にする（先の矩形を優先し、後の矩形からその分を引く）
function disjointRects(rects) {
  const out = [];
  for (const r of rects) out.push(...subtractRects([r], out));
  return out;
}

/**
 * 高い側の面 highFaceId の innerLines（role: CEILING_STEP_DETAIL_ROLE）。群ごと・深さごとに、辺の帯の和を高い側の面の削り後の矩形と交わらせ、
 * その外周から高い側の面自身の外周（CL・壁の面）に乗る部分を除いた残りを線にする。結果、出隅は四角に回り、入隅は短くなり、
 * 壁で止まる端には見切りの木口の短い線が出て、高い側の面が出より狭ければ外側の線は削られる（高い側の外周に乗るため）。
 * 同じ向き・位置の線は重なりを結合する。群が無い・該当しない面は空配列。
 * @param {ReturnType<typeof ceilingStepDetailSpecs>['groups']} groups
 * @param {string} highFaceId ceilingFaceId で作った高い側の面の id
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} trimmedRects 高い側の面の削り後の矩形
 * @returns {Array<{points:number[], role:string}>}
 */
export function ceilingStepDetailInnerLines(groups, highFaceId, trimmedRects) {
  if (!Array.isArray(groups) || !Array.isArray(trimmedRects) || trimmedRects.length === 0) return [];
  const own = groups.filter(g => g.highFaceId === highFaceId);
  if (own.length === 0) return [];
  const faceOutline = rectsOutlineSegments(trimmedRects).map(s => ({ horizontal: !s.isVertical, c: s.value, lo: s.lo, hi: s.hi }));
  const pieces = []; // {isVertical, value, lo, hi}
  for (const g of own) {
    for (const d of g.offsets) {
      const bands = g.edges.map(e => bandRect(e, d, g.lowRects, g.highRects));
      const clipped = bands.flatMap(b => trimmedRects.map(r => intersect(b, r))).filter(hasArea);
      for (const seg of rectsOutlineSegments(disjointRects(clipped))) {
        const onFace = coveredIntervals(faceOutline, !seg.isVertical, seg.value, seg.lo, seg.hi);
        for (const [lo, hi] of subtractIntervals(onFace, seg.lo, seg.hi)) pieces.push({ isVertical: seg.isVertical, value: seg.value, lo, hi });
      }
    }
  }
  // 同じ向き・位置（EPS 以内）の線を結合して決定的な順に並べる
  const lines = [];
  for (const isVertical of [false, true]) {
    const groupsAt = [];
    for (const p of pieces.filter(q => q.isVertical === isVertical).sort((a, b) => a.value - b.value)) {
      const at = groupsAt.find(x => Math.abs(x.value - p.value) <= EPS) ?? (groupsAt.push({ value: p.value, ivs: [] }), groupsAt[groupsAt.length - 1]);
      at.ivs.push([p.lo, p.hi]);
    }
    for (const { value, ivs } of groupsAt) {
      const merged = [];
      for (const [lo, hi] of ivs.sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && lo - last[1] <= EPS) last[1] = Math.max(last[1], hi);
        else merged.push([lo, hi]);
      }
      for (const [lo, hi] of merged) lines.push({ points: isVertical ? [value, lo, value, hi] : [lo, value, hi, value], role: CEILING_STEP_DETAIL_ROLE });
    }
  }
  return lines;
}

/**
 * 見上げの出力の後処理。(1) role 線（CEILING_STEP_DETAIL_ROLE）に detailOnly:true を付ける（詳細 LOD だけで描く）。
 * (2) ceiling の無印の線（自階・ceilingBoundary 等の印なし・role なし・軸平行）のうち hiddenDatum の上にある部分を分割し、
 * その部分に hiddenAtDetail:true を付ける（詳細 LOD では描かない。他の LOD は従来どおり描く）。
 * 全体が覆われる線は分割せず印だけ付ける。分割した片の key は `元のkey:h番号`。入力の配列・prim は変更しない（変更が無ければ同じ配列を返す）。
 * @param {import('../plan/planSectionFigure.js').Primitive[]} prims
 * @param {Array<{isVertical:boolean, value:number, lo:number, hi:number}>} hiddenDatum
 * @returns {import('../plan/planSectionFigure.js').Primitive[]}
 */
export function hideCeilingStepDatumLines(prims, hiddenDatum) {
  if (!Array.isArray(prims)) return prims;
  const segs = (Array.isArray(hiddenDatum) ? hiddenDatum : []).map(h => ({ horizontal: !h.isVertical, c: h.value, lo: h.lo, hi: h.hi }));
  let changed = false;
  const out = [];
  for (const p of prims) {
    if (p?.source?.role === CEILING_STEP_DETAIL_ROLE) {
      if (p.detailOnly === true) out.push(p);
      else { changed = true; out.push({ ...p, detailOnly: true }); }
      continue;
    }
    const plain = segs.length > 0 && p?.kind === 'line' && p.source?.kind === 'ceiling' && p.source.role == null && p.style == null
      && (p.source.layerFloorZ ?? 0) === 0 && Array.isArray(p.points) && p.points.length === 4;
    if (!plain) { out.push(p); continue; }
    const [x1, y1, x2, y2] = p.points;
    const horizontal = Math.abs(y1 - y2) <= EPS && Math.abs(x1 - x2) > EPS;
    const vertical = Math.abs(x1 - x2) <= EPS && Math.abs(y1 - y2) > EPS;
    if (!horizontal && !vertical) { out.push(p); continue; }
    const c = horizontal ? (y1 + y2) / 2 : (x1 + x2) / 2;
    const lo = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
    const hi = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
    const covered = coveredIntervals(segs, horizontal, c, lo, hi);
    if (covered.length === 0) { out.push(p); continue; }
    changed = true;
    const parts = splitByCovered(lo, hi, covered); // [a, b, 隠す?]
    parts.forEach(([a, b, hidden], i) => {
      const next = {
        ...p,
        key: parts.length === 1 ? p.key : `${p.key}:h${i}`,
        points: a === lo && b === hi ? p.points : (horizontal ? [a, c, b, c] : [c, a, c, b]),
      };
      if (hidden) next.hiddenAtDetail = true;
      out.push(next);
    });
  }
  return changed ? out : prims;
}

/**
 * 見上げの memo の鍵に連結する印。割当てが無ければ ''（鍵は従来と同じ）。あれば `:cs<overlay の世代>.<材マスタの有無 0|1>`。
 * overlay（同梱・組込みの部分詳細図）は MobX の observable ではなく、材マスタはロード後に載るため、鍵に入れて再計算させる。
 */
export function ceilingStepDetailCacheTag(graph, materialMap) {
  return hasCeilingStepAssignment(graph) ? `:cs${overlayGeneration()}.${materialMap ? 1 : 0}` : '';
}
