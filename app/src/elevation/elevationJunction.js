// ================================================================
// 部屋の取り合い（Room.detailRefs の floorWall・wallCeiling）の断面図から展開の面へ派生する水平線の仕様（部分詳細図 S8a-2）。
// elevation/ から detail/ を引く唯一のファイル（引き先は detailPlacement.js だけ。importGraph.test.js で固定）。
//   junctionPlanForFace   面 F の部屋の割当てを F 自身の壁の厚みで fit し、包絡線（段差の t 列）を求める
//   junctionLineSpecs     包絡線の段差を面の水平線の仕様へ（途切れる区間・天井の段差への追従）。描画は elevationFigure.js
// 断面図の包絡線の各段差 t: floorWall は FL から上へ −t の高さ、wallCeiling は天井面から下へ t の位置。
// 自動（auto）の段差は細線 DETAIL・ヘルパーの印（air）は中線 SILHOUETTE（同じ t は包絡線が中線 1 本に畳んでいる）。
// 失敗（参照切れ・壁厚に合わない図）は線を出さない（通知は展開 init が集める＝collectRoomJunctionFailures）。
// 純関数: 例外にしない。割当ての無い部屋は null（出力不変）。
// ================================================================

import {
  ROOM_DETAIL_SLOTS, DetailSlot, DETAIL_FIT_EPS_MM, DETAIL_SECTION_SWAP_MIN_DIFF_MM, DETAIL_PRIM_SOURCE,
} from '../core/constants.js';
import { computeEnvelope, EnvelopeWeight } from '../detail/detailPlacement.js';
import { resolveRoomDetailFigure, fitRoomJunction, wallAssemblyThicknessMm } from '../finish/roomDetailJunction.js';
import { sameAxisLine, kneeDropRecordsOnAxis, kneeDropRecordFor } from '../finish/kneeDropWall.js';
import { graphList } from '../graphReadScope.js';
import { effectiveHeight, effectiveSillHeight } from '../openings/openingNumbering.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';
import { wallLessEndAt, cornerOpeningZRanges, faceBoundaryLocalX, localXOf } from './elevationFaces.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { polyline, subtractCollinearSpans } from './elevationPrimitives.js';

const roleOf = weight => (weight === EnvelopeWeight.AIR ? ElevationLineRole.SILHOUETTE : ElevationLineRole.DETAIL);

/**
 * 面 F の軸上で F の区間に最も長く重なる壁（F 自身の壁）。無ければ null。
 * @param {object} face
 * @param {object} graph
 */
export function faceWallOf(face, graph) {
  let best = null;
  let bestOverlap = 0;
  for (const w of graphList(graph, 'walls') ?? []) {
    if (w.isVertical !== face.isVertical || !sameAxisLine(w.axisCL, face.axisCL)) continue;
    const overlap = Math.min(Math.max(w.coord1, w.coord2), face.hi) - Math.max(Math.min(w.coord1, w.coord2), face.lo);
    if (overlap > bestOverlap) { best = w; bestOverlap = overlap; }
  }
  return best;
}

/**
 * 面 F の部屋の取り合い（floorWall・wallCeiling）を F 自身の壁厚で fit して包絡線にする。
 * fit が成った slot だけを含む（参照切れ・壁厚に合わない・壁が引けないものは含めない＝従来の描き方）。
 * 割当ての無い部屋・段差見付け面・吹抜けの面は null。
 * @param {object} face
 * @param {{graph:object, room:object|null, materialMap?:object|null}} ctx
 * @returns {null | {[slot:string]: {steps:{t:number, weight:string}[], outline:number[][], maxDeviationMm:number}}}
 */
export function junctionPlanForFace(face, { graph, room, materialMap = null }) {
  if (!room?.detailRefs || face.kind === 'step' || face.voidAbove) return null;
  const plan = {};
  let wall;
  for (const slot of ROOM_DETAIL_SLOTS) {
    const r = resolveRoomDetailFigure({ room, slot });
    if (!r?.entry) continue;
    if (wall === undefined) wall = faceWallOf(face, graph);
    const thickness = wall ? wallAssemblyThicknessMm(graph, wall) : null;
    if (thickness === null) continue;
    const fitted = fitRoomJunction({ figureKey: r.key, slot, wallThicknessMm: thickness, materialMap });
    if (fitted.error) continue;
    plan[slot] = computeEnvelope(fitted.strokes, slot);
  }
  return Object.keys(plan).length > 0 ? plan : null;
}

/**
 * 部屋の各面の壁（faceWallOf）の列。描画が壁厚を取る壁と同じものを通知（collectRoomJunctionFailures の faceWallsOf）へ渡す。
 * 段差見付け面・吹抜けの面は junctionPlanForFace が使わないので除く。
 * @param {object} room
 * @param {object} graph
 * @returns {object[]}
 */
export function junctionFaceWallsOf(room, graph) {
  const walls = [];
  for (const face of composeRoomFaces(room, graph)) {
    if (face.kind === 'step' || face.voidAbove) continue;
    const w = faceWallOf(face, graph);
    if (w) walls.push(w);
  }
  return walls;
}

// base 区間 [lo,hi] から holes を引いた残り（昇順。holes は [lo,hi] の配列で ±Infinity 可）。
function subtractRanges(base, holes) {
  let out = [base];
  for (const [hLo, hHi] of holes) {
    const next = [];
    for (const [lo, hi] of out) {
      if (hHi <= lo + DETAIL_FIT_EPS_MM || hLo >= hi - DETAIL_FIT_EPS_MM) { next.push([lo, hi]); continue; }
      if (hLo > lo + DETAIL_FIT_EPS_MM) next.push([lo, hLo]);
      if (hHi < hi - DETAIL_FIT_EPS_MM) next.push([hHi, hi]);
    }
    out = next;
  }
  return out.filter(([lo, hi]) => hi > lo + DETAIL_FIT_EPS_MM);
}

// 線の高さ（その区間の床から上へ。x の関数）が、開口・腰壁・垂れ壁・壁の無い区間で途切れる x 範囲。
function blockedRanges(heightAt, { face, graph, openings, wallLessRuns }) {
  const eps = DETAIL_FIT_EPS_MM;
  const localX = world => localXOf(face, world);
  const out = (wallLessRuns ?? []).map(r => [r.lo, r.hi]);
  for (const o of openings ?? []) {
    const cx = localX(o.centerCoord);
    const sill = effectiveSillHeight(o);
    const h = heightAt(cx);
    if (h >= sill - eps && h <= sill + effectiveHeight(o) + eps) out.push([cx - o.width / 2, cx + o.width / 2]);
  }
  if (graph?.kneeDropWalls) {
    for (const { rec, lo, hi } of kneeDropRecordsOnAxis(graph, face.axisCL, face.lo, face.hi)) {
      if (!rec.knee && !rec.drop) continue;
      const a = localX(lo);
      const b = localX(hi);
      const h = heightAt((a + b) / 2);
      const covered = (rec.knee != null && h <= rec.knee.topHeight + eps) || (rec.drop != null && h >= rec.drop.bottomHeight - eps);
      if (!covered) out.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  return out;
}

/**
 * 包絡線の段差を面の水平線の仕様にする。
 *   floorWall:   [{ heightMm, role, gaps }]       床から heightMm 上の、床の段差に沿う平行線（途切れる区間 gaps=[lo,hi][]）
 *   wallCeiling: [{ role, pieces:[{x0,y0,x1,y1}] }] 天井面から t 下の、区間ごとの天井高に追従する線（図の座標）
 * 床〜天井の外の高さ・円弧／傾斜プロファイルの天井の面の wallCeiling は出さない。
 * @param {object} plan junctionPlanForFace の結果
 * @param {{face:object, graph:object, run:number, segs:object[], openings:object[], wallLessRuns:object[],
 *   ceilRiserXAt:(i:number)=>number, segCeilAbsAt:(s:object,x:number)=>number, hasCeilingProfile?:boolean}} geo
 * @returns {{floorWall:object[], wallCeiling:object[]}}
 */
export function junctionLineSpecs(plan, geo) {
  const eps = DETAIL_FIT_EPS_MM;
  const { segs, run, ceilRiserXAt, segCeilAbsAt } = geo;
  const floorWall = [];
  const wallCeiling = [];

  const fw = plan?.[DetailSlot.FLOOR_WALL];
  if (fw) {
    // 区間の天井（床から）の最小。それ以上の高さの線は天井の外
    const ceilRel = Math.min(...segs.map(s => segCeilAbsAt(s, (s.loX + s.hiX) / 2) - (s.floorDeltaMm ?? 0)));
    for (const { t, weight } of fw.steps) {
      const heightMm = -t;
      if (!(heightMm > eps) || heightMm >= ceilRel - eps) continue;
      const gaps = blockedRanges(() => heightMm, geo).sort((a, b) => a[0] - b[0]);
      floorWall.push({ heightMm, role: roleOf(weight), gaps });
    }
  }

  const wc = plan?.[DetailSlot.WALL_CEILING];
  if (wc && !geo.hasCeilingProfile) {
    for (const { t, weight } of wc.steps) {
      if (!(t > eps)) continue;
      const pieces = [];
      segs.forEach((s, i) => {
        // 円弧・上階の天井（多層書き）の区間は引かない
        if (s.ceilArc || (s.ceilFloorZMm ?? 0) !== 0) return;
        const lo = Math.max(0, i === 0 ? 0 : ceilRiserXAt(i - 1));
        const hi = Math.min(run, i === segs.length - 1 ? run : ceilRiserXAt(i));
        if (!(hi > lo + eps)) return;
        const floorDelta = s.floorDeltaMm ?? 0;
        const heightAt = x => segCeilAbsAt(s, x) - floorDelta - t;
        if (heightAt(lo) <= eps && heightAt(hi) <= eps) return; // 床より下
        for (const [x0, x1] of subtractRanges([lo, hi], blockedRanges(heightAt, geo))) {
          pieces.push({ x0, y0: -segCeilAbsAt(s, x0) + t, x1, y1: -segCeilAbsAt(s, x1) + t });
        }
      });
      if (pieces.length > 0) wallCeiling.push({ role: roleOf(weight), pieces });
    }
  }
  return { floorWall, wallCeiling };
}

// 隣の面 P の、F との隅（P の cornerEnd 側の壁中心線）に立つ壁が腰壁・垂れ壁か（全高でない）。
function cornerWallPartial(P, cornerEnd, graph) {
  if (!graph?.kneeDropWalls) return false;
  const b = faceBoundaryLocalX(P, graph);
  const world = P.originWorld + (cornerEnd === 'hi' ? b.hi : b.lo) * P.dirSign;
  return (graphList(graph, 'walls') ?? []).some(w =>
    w.isVertical === P.isVertical && sameAxisLine(w.axisCL, P.axisCL)
    && Math.min(w.coord1, w.coord2) - DETAIL_FIT_EPS_MM <= world && world <= Math.max(w.coord1, w.coord2) + DETAIL_FIT_EPS_MM
    && kneeDropRecordFor(w, graph) !== null);
}

/**
 * 帯の切断面（左右端の壁・床・天井の単純断面）を、取り合いの断面図の包絡線の輪郭（CUT・source=detail）へ差し替える（S8a-2・後段処理）。
 * 面 F の端の断面は隣の面 P の壁の断面なので、fit は P 自身の壁厚で行い、右端は鏡像（sx=−1）。
 * 差し替えるのは形状差 D（包絡線の最大の出っ張り）が DETAIL_SECTION_SWAP_MIN_DIFF_MM を超える slot だけ。
 * 端の条件: 壁のある端（壁の無い端・開放スパンで延長された端は除く）・隅に開口が達しない・P の隅の壁が全高。
 * 差し引く線: その端の CUT の縦線（天井／床との取り合いの出っ張りの高さ）と、床／天井の CUT 線の [端, 端±E0]（図側・断面エンジン側の両方）。
 * primitives を直接書き換える（帯の座標系。finalizeBand の前）。
 * @param {object[]} primitives
 * @param {{faceRuns:{face:object, xCursor:number, floorSegments?:object[]}[]}} layout
 * @param {{graph:object, room:object, materialMap?:object|null, segCeilAbsAt:(s:object,x:number)=>number,
 *   neighborOf:(i:number, dir:1|-1)=>object|null, includeFace?:(face:object)=>boolean}} opts
 */
export function applyJunctionSectionSwap(primitives, layout, { graph, room, materialMap = null, segCeilAbsAt, neighborOf, includeFace = () => true }) {
  if (!room?.detailRefs) return;
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const planCache = new Map();
  const planOf = P => {
    if (!planCache.has(P)) planCache.set(P, junctionPlanForFace(P, { graph, room, materialMap }));
    return planCache.get(P);
  };
  layout.faceRuns.forEach(({ face, xCursor, floorSegments }, i) => {
    if (face.kind === 'step' || !includeFace(face) || !floorSegments?.length) return;
    for (const end of ['lo', 'hi']) {
      const atRun = end === 'hi';
      const P = neighborOf(i, atRun ? 1 : -1);
      if (!P) continue;
      const hasWall = (atRun ? face.hasWallAtLocalRun : face.hasWallAtLocal0) ?? true;
      if (!hasWall || wallLessEndAt(face, atRun ? 'Run' : '0') || (atRun ? face.extendedAtLocalRun : face.extendedAtLocal0)) continue;
      if (cornerOpeningZRanges(face, P, end, graph).length > 0) continue;
      if (cornerWallPartial(P, atRun ? 'lo' : 'hi', graph)) continue;
      const plan = planOf(P);
      if (!plan) continue;
      const seg = atRun ? floorSegments[floorSegments.length - 1] : floorSegments[0];
      const localX = atRun ? face.run : 0;
      const x = xCursor + localX;
      const sx = atRun ? -1 : 1;
      for (const slot of ROOM_DETAIL_SLOTS) {
        const env = plan[slot];
        if (!env || !(env.maxDeviationMm > DETAIL_SECTION_SWAP_MIN_DIFF_MM) || env.outline.length < 2) continue;
        const floor = slot === DetailSlot.FLOOR_WALL;
        // 勾配・円弧・上階天井の端の天井は水平な CUT 線ではない（差し引けず二重になる）ので差し替えない（派生線側と同じ扱い）
        if (!floor && (seg.ceilArc || seg.chHiMm != null || (seg.ceilFloorZMm ?? 0) !== 0)) continue;
        const y = floor ? -(seg.floorDeltaMm ?? 0) : -segCeilAbsAt(seg, localX);
        const first = env.outline[0];
        const last = env.outline[env.outline.length - 1];
        // 床側は輪郭が上端（s=0）から FL（s=E0）へ、天井側は天井面（s=E0）から下端（s=0）へ
        const reach = floor ? first[1] : last[1];  // 縦線を差し引く t（床: 上端の負値・天井: 下端の正値）
        const e0 = floor ? last[0] : first[0];     // 床／天井線を差し引く幅
        let prims = subtractCollinearSpans(primitives, { axis: 'x', at: x, lo: y + Math.min(0, reach), hi: y + Math.max(0, reach), weight: cutWeight });
        prims = subtractCollinearSpans(prims, { axis: 'y', at: y, lo: x, hi: x + sx * e0, weight: cutWeight });
        prims.push(polyline(env.outline.map(([s, t]) => [x + s * sx, y + t]), { weight: cutWeight, source: DETAIL_PRIM_SOURCE }));
        primitives.length = 0;
        for (const p of prims) primitives.push(p);
      }
    }
  });
}
