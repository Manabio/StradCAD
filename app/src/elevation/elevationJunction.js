// ================================================================
// 部屋の取り合い（Room.detailRefs の floorWall・wallCeiling）の断面図から展開の面へ派生する水平線の仕様（部分詳細図 S8a-2）。
// elevation/ から detail/ を引く唯一のファイル（引き先は detailPlacement.js だけ。importGraph.test.js で固定）。
//   junctionPlanForFace   面 F の部屋の割当てを F 自身の壁の厚みで fit し、包絡線（段差の t 列）を求める
//   junctionLineSpecs     包絡線の段差を面の水平線の仕様へ（途切れる区間・天井の段差への追従）。描画は elevationFigure.js
//   floorStepLineSpecs / applyFloorStepSectionSwap  床の段差（Room.detailRefs の floorStep。S8b-3）の派生線（段差見付け面）と riser の差し替え
// 断面図の包絡線の各段差 t: floorWall は FL から上へ −t の高さ、wallCeiling は天井面から下へ t の位置。
// 自動（auto）の段差は細線 DETAIL・ヘルパーの印（air）は中線 SILHOUETTE（同じ t は包絡線が中線 1 本に畳んでいる）。
// 失敗（参照切れ・壁厚に合わない図）は線を出さない（通知は展開 init が集める＝collectRoomJunctionFailures）。
// 純関数: 例外にしない。割当ての無い部屋は null（出力不変）。
// ================================================================

import {
  ROOM_DETAIL_SLOTS, KNEE_DROP_DETAIL_SLOTS, KneeDropFrontSide, DetailSlot, DETAIL_FIT_EPS_MM, DETAIL_SECTION_SWAP_MIN_DIFF_MM,
  DETAIL_PRIM_SOURCE,
} from '../core/constants.js';
import { computeEnvelope, EnvelopeWeight } from '../detail/detailPlacement.js';
import { resolveRoomDetailFigure, fitRoomJunction, wallAssemblyThicknessMm, baseboardOf } from '../finish/roomDetailJunction.js';
import { kneeDropPartEnvelope, floorStepEnvelope, ceilingStepEnvelope, resolveKneeDropDetailFigure } from '../finish/partDetail.js';
import { sameAxisLine, kneeDropRecordsForWallPoint, kneeDropWallGeometry } from '../finish/kneeDropWall.js';
import { graphList } from '../graphReadScope.js';
import { effectiveHeight, effectiveSillHeight } from '../openings/openingNumbering.js';
import { ElevationLineRole, weightForRole, minDrawnMm, PROBE_EPS_MM, GAP_EPS_MM } from './elevationStyle.js';
import { drawnRiserX, drawnCeilingRiserX, halfWallThicknessMm, roomOwnerByCell } from './elevationFloorProfile.js';
import { zoneCeilingFieldOf } from './space/zoneCeiling.js';
import { worldToCell } from '../finish/gridCells.js';
import { wallLessEndAt, cornerOpeningZRanges, faceBoundaryLocalX, localXOf } from './elevationFaces.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { line, polyline, subtractCollinearSpans } from './elevationPrimitives.js';
import { buildEnclosureCellToRoom } from '../finish/edgeClassify.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';

const roleOf = weight => (weight === EnvelopeWeight.AIR ? ElevationLineRole.SILHOUETTE : ElevationLineRole.DETAIL);

/**
 * 包絡線の段差 [{t, weight}] を最小描画幅へ調整する（2026-11-02 裁定。elevationStyle.js minDrawnMm）。
 * datum（FL・天井面・天端・下端）からの距離 |t| が minMm 未満なら minMm に置く（符号は保つ・t=0 は触らない）。
 * 調整後に同じ t（DETAIL_FIT_EPS_MM 以内）へ畳まれた段差は 1 本にし、auto と air が重なれば air。入力は書き換えない。
 * @param {{t:number, weight:string}[]} steps
 * @param {number} minMm 最小描画幅（mm）
 * @returns {{t:number, weight:string}[]}
 */
export function stepsAtMinDrawn(steps, minMm) {
  const out = [];
  for (const s of steps ?? []) {
    const t = Math.abs(s.t) <= DETAIL_FIT_EPS_MM || Math.abs(s.t) >= minMm ? s.t : Math.sign(s.t) * minMm;
    const same = out.find(o => Math.abs(o.t - t) <= DETAIL_FIT_EPS_MM);
    if (!same) out.push({ ...s, t });
    else if (s.weight === EnvelopeWeight.AIR) same.weight = EnvelopeWeight.AIR;
  }
  return out;
}

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
 * floorWall は割当てが無くても部屋に巾木高さがあれば組込みの巾木で fit する（暗黙の既定。S8c。resolveRoomDetailFigure）。
 * 部屋が無い・段差見付け面・吹抜けの面・割当ても既定も無い部屋は null。
 * @param {object} face
 * @param {{graph:object, room:object|null, materialMap?:object|null}} ctx
 * @returns {null | {[slot:string]: {steps:{t:number, weight:string}[], outline:number[][], maxDeviationMm:number}}}
 */
export function junctionPlanForFace(face, { graph, room, materialMap = null }) {
  if (!room || face.kind === 'step' || face.voidAbove) return null;
  const plan = {};
  let wall;
  for (const slot of ROOM_DETAIL_SLOTS) {
    const r = resolveRoomDetailFigure({ room, slot });
    if (!r?.entry) continue;
    if (wall === undefined) wall = faceWallOf(face, graph);
    const thickness = wall ? wallAssemblyThicknessMm(graph, wall) : null;
    if (thickness === null) continue;
    const fitted = fitRoomJunction({ figureKey: r.key, slot, wallThicknessMm: thickness, baseboardHeightMm: baseboardOf(room, slot), materialMap });
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

/**
 * 断面エンジンの emitCtx.kneeDropPartStepsOf（腰壁の天端・垂れ壁の下端の部分詳細図。S8b-1）。帯 band・列 col・切断 cut から
 * 「その列の壁に掛かる記録」を引き、見る側（cut.viewSign の手前の部屋の側）から見た包絡線の段差 {kneeTop?, dropBottom?}: [{t, weight}] を返す。
 * 表の側（rec.frontSide）と見る側が違えば壁の中心で鏡像。参照切れ・fit 失敗・自階（'self' の層）以外の壁は null（従来の描き方）。
 * kneeTop は割当てが無くても腰壁があれば組込みの天板が既定（S8c）。fit が成った slot は段差が 0 本でも含める（空配列＝図が担う）。
 * 腰壁・垂れ壁の記録が 1 つも無ければ null（エンジンへ関数自体を渡さない）。
 * 段差の t は最小描画幅（scaleDenom の縮尺。未指定＝100）へ調整する（stepsAtMinDrawn）。
 * @param {{graph:object, materialMap?:object|null, scaleDenom?:number}} p
 * @returns {null | ((band:object, col:object, cut:object) => ({kneeTop?:object[], dropBottom?:object[]}|null))}
 */
export function kneeDropPartStepsOf({ graph, materialMap = null, scaleDenom }) {
  if (![...(graph?.kneeDropWalls?.values() ?? [])].some(rec => rec?.knee || rec?.drop)) return null;
  const minMm = minDrawnMm(scaleDenom);
  const byWall = new WeakMap(); // wall → Map<鍵, 包絡線の steps|null>
  return (band, col, cut) => {
    if (band.layerRole !== 'self' || !band.wall) return null;
    const hit = kneeDropRecordsForWallPoint(graph, band.wall, (col.worldLo + col.worldHi) / 2)
      .find(({ rec }) => rec.knee || rec.drop);
    if (!hit) return null;
    // 視線は +viewSign 側へ向く。壁を見る人は壁の手前（−viewSign 側）に立つので、viewSign>0 なら軸の負側の部屋から見る
    const viewedSide = cut.viewSign > 0 ? KneeDropFrontSide.ROOM_NEG : KneeDropFrontSide.ROOM_POS;
    if (!byWall.has(band.wall)) byWall.set(band.wall, new Map());
    const cache = byWall.get(band.wall);
    const out = {};
    for (const slot of KNEE_DROP_DETAIL_SLOTS) {
      if (!resolveKneeDropDetailFigure({ rec: hit.rec, slot })) continue; // 割当ても暗黙の既定（腰壁の天板）も無い
      const memoKey = `${hit.key}|${slot}|${viewedSide}`;
      if (!cache.has(memoKey)) {
        const env = kneeDropPartEnvelope({ graph, wall: band.wall, rec: hit.rec, slot, viewedSide, materialMap });
        cache.set(memoKey, env?.steps ? stepsAtMinDrawn(env.steps, minMm) : null);
      }
      const steps = cache.get(memoKey);
      // fit が成れば段差が 0 本でも解決済み（空の配列）: 図が担うので従来の天端下の細線へ戻らない（S8c）
      if (steps) out[slot] = steps;
    }
    return Object.keys(out).length > 0 ? out : null;
  };
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

// 線の高さ（その区間の床から上へ。x の関数）が、壁体の無い区間と線の高さを含む建具の開口で途切れる x 範囲。
// 派生線（巾木・廻り縁）を切ってよい理由はこの 2 つだけ。腰壁・垂れ壁の記録は同じ壁体の上端・下端の修飾で壁体の有無を変えない
// （finish/kneeDropWall.js）ので、その下の巾木・上の廻り縁も通す（従来の appendBaseboard も同じ述語だけを見る。S8c 裁定）。開放部の描き方は断面エンジンの担当。
function blockedRanges(heightAt, { face, openings, wallLessRuns }) {
  const eps = DETAIL_FIT_EPS_MM;
  const localX = world => localXOf(face, world);
  const out = (wallLessRuns ?? []).map(r => [r.lo, r.hi]);
  for (const o of openings ?? []) {
    const cx = localX(o.centerCoord);
    const sill = effectiveSillHeight(o);
    const h = heightAt(cx);
    if (h >= sill - eps && h <= sill + effectiveHeight(o) + eps) out.push([cx - o.width / 2, cx + o.width / 2]);
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
 *   ceilRiserXAt:(i:number)=>number, segCeilAbsAt:(s:object,x:number)=>number, hasCeilingProfile?:boolean,
 *   scaleDenom?:number}} geo  scaleDenom＝縮尺の分母（最小描画幅。未指定＝100）
 * @returns {{floorWall:object[], wallCeiling:object[]}}
 */
export function junctionLineSpecs(plan, geo) {
  const eps = DETAIL_FIT_EPS_MM;
  const { segs, run, ceilRiserXAt, segCeilAbsAt } = geo;
  const minMm = minDrawnMm(geo.scaleDenom); // 段差 t は最小描画幅へ調整（stepsAtMinDrawn）
  const floorWall = [];
  const wallCeiling = [];

  const fw = plan?.[DetailSlot.FLOOR_WALL];
  if (fw) {
    // 区間の天井（床から）の最小。それ以上の高さの線は天井の外
    const ceilRel = Math.min(...segs.map(s => segCeilAbsAt(s, (s.loX + s.hiX) / 2) - (s.floorDeltaMm ?? 0)));
    for (const { t, weight } of stepsAtMinDrawn(fw.steps, minMm)) {
      const heightMm = -t;
      if (!(heightMm > eps) || heightMm >= ceilRel - eps) continue;
      const gaps = blockedRanges(() => heightMm, geo).sort((a, b) => a[0] - b[0]);
      floorWall.push({ heightMm, role: roleOf(weight), gaps });
    }
  }

  const wc = plan?.[DetailSlot.WALL_CEILING];
  if (wc && !geo.hasCeilingProfile) {
    for (const { t, weight } of stepsAtMinDrawn(wc.steps, minMm)) {
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

// P の軸上で、長さ方向の位置 world を含む壁。
function wallsOnAxisAt(P, world, graph) {
  return (graphList(graph, 'walls') ?? []).filter(w =>
    w.isVertical === P.isVertical && sameAxisLine(w.axisCL, P.axisCL)
    && Math.min(w.coord1, w.coord2) - DETAIL_FIT_EPS_MM <= world && world <= Math.max(w.coord1, w.coord2) + DETAIL_FIT_EPS_MM);
}

// 隣の面 P の、F との隅（P の cornerEnd 側の壁中心線の位置 world）と、そこに立つ壁。
function cornerWallsOf(P, cornerEnd, graph) {
  const b = faceBoundaryLocalX(P, graph);
  const world = P.originWorld + (cornerEnd === 'hi' ? b.hi : b.lo) * P.dirSign;
  return { world, walls: wallsOnAxisAt(P, world, graph) };
}

// 隅の記録を探す点（P の軸上の位置）を F の仕上げ面から F の部屋の側へずらす量(mm)。
// 値の根拠: 記録の区間端は CL 位置（例 1500）にあり、F の仕上げ面（例 1442.5）は CL の半壁厚手前。CL や仕上げ面ちょうどだと
// 区間の境目や T 字の継ぎ目に乗って別の記録・構成外の一片を拾うので、部屋の側へ寄せる。点クエリ幅
// （kneeDropWall.js POINT_QUERY_EPS_MM＝±0.5）より大きく、壁厚（数十 mm）より十分小さい 2 とする。
const CORNER_PROBE_INTO_ROOM_MM = 2;

// F の部屋の側の探索点とそこに立つ壁（P の軸上。F の仕上げ面から部屋の側へ CORNER_PROBE_INTO_ROOM_MM）。
function cornerProbeWallsOf(face, P, graph) {
  const point = face.faceValue + face.inward * CORNER_PROBE_INTO_ROOM_MM;
  return { point, walls: wallsOnAxisAt(P, point, graph) };
}

// 隣の面 P の、F との隅に立つ壁が腰壁・垂れ壁か（全高でない）。隅の CL の位置と F の部屋の側の探索点の両方で見る。
function cornerWallPartial(face, P, cornerEnd, graph) {
  if (!graph?.kneeDropWalls) return false;
  // 位置の判定（同じ壁の離れた区間に腰壁があっても、点が記録の区間に無ければ全高）
  const corner = cornerWallsOf(P, cornerEnd, graph);
  const probe = cornerProbeWallsOf(face, P, graph);
  return [{ point: corner.world, walls: corner.walls }, probe]
    .some(({ point, walls }) => walls.some(w => kneeDropRecordsForWallPoint(graph, w, point).length > 0));
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
  forEachSwapEnd(layout, { graph, neighborOf, includeFace }, ({ face, P, atRun, seg, localX, x, sx }) => {
    if (cornerWallPartial(face, P, atRun ? 'lo' : 'hi', graph)) return;
    const plan = planOf(P);
    if (!plan) return;
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
      replacePrimitives(primitives, prims);
    }
  });
}

// 差し替えの対象になる面の端（壁のある端・開放スパンで延長された端でない・隅に開口が達しない・隣の面がある）を順に fn へ渡す。
// fn には隣の面 P・端の向き・端の床区間 seg・端の面ローカル x・帯の座標 x と、輪郭を室内側へ伸ばす向き sx（左端 +1・右端 −1）を渡す。
function forEachSwapEnd(layout, { graph, neighborOf, includeFace }, fn) {
  layout.faceRuns.forEach(({ face, xCursor, floorSegments }, i) => {
    if (face.kind === 'step' || !includeFace(face) || !floorSegments?.length) return;
    for (const end of ['lo', 'hi']) {
      const atRun = end === 'hi';
      const P = neighborOf(i, atRun ? 1 : -1);
      if (!P) continue;
      const hasWall = (atRun ? face.hasWallAtLocalRun : face.hasWallAtLocal0) ?? true;
      if (!hasWall || wallLessEndAt(face, atRun ? 'Run' : '0') || (atRun ? face.extendedAtLocalRun : face.extendedAtLocal0)) continue;
      if (cornerOpeningZRanges(face, P, end, graph).length > 0) continue;
      const localX = atRun ? face.run : 0;
      fn({
        face, P, atRun, localX, x: xCursor + localX, sx: atRun ? -1 : 1,
        seg: atRun ? floorSegments[floorSegments.length - 1] : floorSegments[0],
      });
    }
  });
}

// primitives（帯の座標の配列）を prims の内容で置き換える（呼び出し元の配列を保つ）。
function replacePrimitives(primitives, prims) {
  primitives.length = 0;
  for (const p of prims) primitives.push(p);
}

// 隣の面 P の隅に立つ、部分詳細図（kneeTop／dropBottom）の割当てのある腰壁・垂れ壁の記録とその壁。無ければ null。
// 探す位置は F の部屋の側 2 mm の探索点（cornerProbeWallsOf。junction の飛ばしも同じ点で判定）を先に、次に隅の CL。T 字の継ぎ目（CL に乗り、両側の壁が別の記録を持つ）でも、
// 記録の境目が F の通り芯にある形（隅の一片がどの記録の構成壁でもない）でも、F の部屋の側の壁の記録を拾える。
function cornerKneeDropHit(face, P, cornerEnd, graph) {
  if (!graph?.kneeDropWalls) return null;
  const probe = cornerProbeWallsOf(face, P, graph);
  const { world, walls: cornerWalls } = cornerWallsOf(P, cornerEnd, graph);
  for (const { point, walls } of [probe, { point: world, walls: cornerWalls }]) {
    for (const w of walls) {
      const hit = kneeDropRecordsForWallPoint(graph, w, point).find(({ rec }) => rec.detailRefs && (rec.knee || rec.drop));
      if (hit) return { wall: w, rec: hit.rec, key: hit.key };
    }
  }
  return null;
}

// 帯の座標の縦線を端の天端（垂れ壁は下端）側の区間だけ差し引く線種。断面エンジンの端の全高の中線（recess の SILHOUETTE）も同じ位置に立つ。
const SWAP_VERTICAL_WEIGHTS = [ElevationLineRole.CUT, ElevationLineRole.SILHOUETTE].map(weightForRole);

// 向こう側の部屋（壁 P の F の部屋でない側）の、F の部屋の床を 0 とした床の高さと天井面の高さ。部屋が引けなければ null。
function defaultFarExtentOf(graph, room) {
  let cellToRoom = null;
  return (recKey, backSide) => {
    if (!room || !graph.rooms) return null;
    cellToRoom ??= buildEnclosureCellToRoom(graph);
    const geo = kneeDropWallGeometry(graph, recKey, cellToRoom);
    const far = backSide === KneeDropFrontSide.ROOM_NEG ? geo?.roomNeg : geo?.roomPos;
    if (!far) return null;
    const floorDeltaMm = graph.effectiveFloorLevel(far) - graph.effectiveFloorLevel(room);
    return { floorDeltaMm, ceilAbsMm: floorDeltaMm + roomCeilingHeight(graph, far).mm };
  };
}

/**
 * 腰壁（kneeTop）・垂れ壁（dropBottom）の部位の包絡線の輪郭を、壁の両側から連ねた 1 本の折れ線にする（S8b-2）。
 * front＝F の部屋の側から見た輪郭（s は部屋側の仕上げ面から部屋側が正）・back＝反対側から見た輪郭（s は反対側の仕上げ面から反対側が正。
 * −壁厚−s で壁の向こうへ写す）。腰壁は天端（t=0）、垂れ壁は下端（t=0）で折り返す。壁の面に戻る端は reach（腰壁: 最大の t・垂れ壁: 最小の t）まで
 * 壁の面に沿って延ばす（差し引く縦線の区間と揃える）。閉じない。
 * @param {number[][]} front
 * @param {number[][]} back
 * @param {number} wallThicknessMm
 * @param {boolean} knee 腰壁（t が正）か。垂れ壁は t が負
 * @returns {number[][]}
 */
export function joinPartOutlines(front, back, wallThicknessMm, knee) {
  const mapped = back.map(([s, t]) => [-wallThicknessMm - s, t]);
  const pts = knee ? [...front].reverse().concat(mapped) : [...front].concat([...mapped].reverse());
  const ts = pts.map(p => p[1]);
  const reach = knee ? Math.max(...ts) : Math.min(...ts);
  if (Math.abs(pts[0][1] - reach) > DETAIL_FIT_EPS_MM) pts.unshift([pts[0][0], reach]);
  const end = pts[pts.length - 1];
  if (Math.abs(end[1] - reach) > DETAIL_FIT_EPS_MM) pts.push([end[0], reach]);
  return pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > DETAIL_FIT_EPS_MM || Math.abs(p[1] - pts[i - 1][1]) > DETAIL_FIT_EPS_MM);
}

/**
 * 帯の端で隣の面 P が腰壁・垂れ壁のとき、その切断面を部位図（kneeTop／dropBottom）の輪郭（CUT・source=detail）へ差し替える（S8b-2・後段処理）。
 * applyJunctionSectionSwap が cornerWallPartial で飛ばしている端が対象（P の隅＝F の面の線に立つ記録に detailRefs がある）。
 * 輪郭: 部屋側の包絡線（kneeDropPartEnvelope。表の側と見る側が違えば鏡像済み）と反対側の包絡線を −壁厚 側へ連ねた 1 本（joinPartOutlines）。
 * どちらか一方でも fit できなければ差し替えない。形状差は両側の大きい方で DETAIL_SECTION_SWAP_MIN_DIFF_MM と比べる（超える slot だけ）。
 * 差し引く線: その端の天端（垂れ壁は下端）の水平線 [端, 壁の向こう側の面]（壁厚ぶん・帯の外側。CUT だけ）と、両側の縦線の天端側
 * [天端−厚, 天端]（垂れ壁は下端側。CUT と、同じ位置の全高の中線 SILHOUETTE）。
 * 向こう側（隣の部屋）の出は帯の外へはねだして描く。さらに壁の向こうの面を、天板の下（垂れ壁は下端の上）から向こう側の部屋の床（垂れ壁は天井）まで
 * CUT の縦線で連ねる（向こう側の部屋が引けなければ F の床・天井）。隣の面・寸法線との交差は受容。
 * 天端の下の細線（kneeCapUnderline）は DETAIL なので触らない。frame は 8a と同じ（左端 sx=+1・右端 sx=−1）で、腰壁は y=−天端（床段差込み）・垂れ壁は y=−下端。
 * 袖壁の分割端（partitionCutAtLocal0/Run）は対象外（8b-2b）。
 * @param {object[]} primitives
 * @param {{faceRuns:{face:object, xCursor:number, floorSegments?:object[]}[]}} layout
 * @param {{graph:object, room?:object|null, materialMap?:object|null, segCeilAbsAt:(s:object,x:number)=>number,
 *   neighborOf:(i:number, dir:1|-1)=>object|null, includeFace?:(face:object)=>boolean,
 *   farExtentOf?:(recKey:string, backSide:string)=>({floorDeltaMm:number, ceilAbsMm:number}|null)}} opts
 *   room＝帯の部屋（向こう側の部屋の床の差の基準）。farExtentOf＝向こう側の部屋の床・天井面（帯の部屋の床からの高さ。既定は graph から導く）
 */
export function applyKneeDropSectionSwap(primitives, layout, {
  graph, room = null, materialMap = null, segCeilAbsAt, neighborOf, includeFace = () => true, farExtentOf = defaultFarExtentOf(graph, room),
}) {
  if (!graph?.kneeDropWalls || graph.kneeDropWalls.size === 0) return;
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  forEachSwapEnd(layout, { graph, neighborOf, includeFace }, ({ face, P, atRun, seg, localX, x, sx }) => {
    // junction を飛ばす端（cornerWallPartial）だけが対象＝junction との二重化なし
    const cornerEnd = atRun ? 'lo' : 'hi';
    if (!cornerWallPartial(face, P, cornerEnd, graph)) return;
    const hit = cornerKneeDropHit(face, P, cornerEnd, graph);
    if (!hit) return;
    const { wall, rec } = hit;
    const thickness = wallAssemblyThicknessMm(graph, wall);
    if (thickness === null) return;
    // F の部屋は、端の内側（atRun なら local の小さい側）にある。世界座標の向きが正なら P の正側の部屋
    const interiorUp = (atRun ? -face.dirSign : face.dirSign) > 0;
    const frontSide = interiorUp ? KneeDropFrontSide.ROOM_POS : KneeDropFrontSide.ROOM_NEG;
    const backSide = interiorUp ? KneeDropFrontSide.ROOM_NEG : KneeDropFrontSide.ROOM_POS;
    const ceilAbs = segCeilAbsAt(seg, localX);
    const horizontalCeil = !(seg.ceilArc || seg.chHiMm != null || (seg.ceilFloorZMm ?? 0) !== 0);
    for (const slot of KNEE_DROP_DETAIL_SLOTS) {
      if (!rec.detailRefs[slot]) continue;
      const knee = slot === DetailSlot.KNEE_TOP;
      // 天端（腰壁）・下端（垂れ壁）の帯の座標 y。腰壁は床段差込み、垂れ壁は水平天井の端だけ（勾配・円弧・上階天井は CUT 線が水平でない）
      let y;
      if (knee) {
        if (rec.knee == null) continue;
        y = -(rec.knee.topHeight + (seg.floorDeltaMm ?? 0));
      } else {
        if (rec.drop == null || !horizontalCeil) continue;
        y = -(ceilAbs - rec.drop.bottomHeight);
      }
      const front = kneeDropPartEnvelope({ graph, wall, rec, slot, viewedSide: frontSide, materialMap });
      const back = kneeDropPartEnvelope({ graph, wall, rec, slot, viewedSide: backSide, materialMap });
      if (!front || !back || front.outline.length < 2 || back.outline.length < 2) continue;
      if (!(Math.max(front.maxDeviationMm, back.maxDeviationMm) > DETAIL_SECTION_SWAP_MIN_DIFF_MM)) continue;
      const outline = joinPartOutlines(front.outline, back.outline, thickness, knee);
      const reach = knee ? Math.max(...outline.map(p => p[1])) : Math.min(...outline.map(p => p[1]));
      const farX = x - sx * thickness; // 壁の向こう側の面（帯の外側。左端なら x より小さい側）
      const lo = y + Math.min(0, reach);
      const hi = y + Math.max(0, reach);
      let prims = primitives;
      for (const weight of SWAP_VERTICAL_WEIGHTS) {
        prims = subtractCollinearSpans(prims, { axis: 'x', at: x, lo, hi, weight });
        prims = subtractCollinearSpans(prims, { axis: 'x', at: farX, lo, hi, weight });
      }
      prims = subtractCollinearSpans(prims, { axis: 'y', at: y, lo: x, hi: farX, weight: cutWeight });
      // 向こう側の面: 天板の下（垂れ壁は下端の上）から向こう側の部屋の床（垂れ壁は天井面）まで 1 本の CUT 縦線にする
      const far = farExtentOf(hit.key, backSide);
      const tip = knee ? hi : lo;
      const end = 0 - (knee ? (far?.floorDeltaMm ?? seg.floorDeltaMm ?? 0) : (far?.ceilAbsMm ?? ceilAbs)); // 0 − で −0 を作らない
      if (knee ? end > tip : end < tip) {
        prims = subtractCollinearSpans(prims, { axis: 'x', at: farX, lo: Math.min(tip, end), hi: Math.max(tip, end), weight: cutWeight });
        prims.push(line(farX, Math.min(tip, end), farX, Math.max(tip, end), { weight: cutWeight, source: DETAIL_PRIM_SOURCE }));
      }
      prims.push(polyline(outline.map(([s, t]) => [x + s * sx, y + t]), { weight: cutWeight, source: DETAIL_PRIM_SOURCE }));
      replacePrimitives(primitives, prims);
    }
  });
}

// ---- 床の段差（Room.detailRefs の floorStep。S8b-3）----

/**
 * 段差見付け面（kind 'step'）に引く水平線の仕様（高い側の床から t の高さ）。高い側の部屋の floorStep を段差高で fit した包絡線の段差 t を
 * 最小描画幅へ調整（stepsAtMinDrawn）し、高い側の床（t≈0）と低い側の床（t≈段差高）に一致するものは引かない。
 * 割当て無し・参照切れ・fit 失敗は空（従来の描き方＝出力不変）。
 * @param {object} face 段差見付け面（highOwnerRoom・stepHeightMm を持つ）
 * @param {{materialMap?:object|null, scaleDenom?:number}} [opts]
 * @returns {{t:number, role:string}[]} t＝高い側の床から下向き
 */
export function floorStepLineSpecs(face, { materialMap = null, scaleDenom } = {}) {
  const room = face?.highOwnerRoom;
  if (face?.kind !== 'step' || !room?.detailRefs) return [];
  const env = floorStepEnvelope({ room, stepHeightMm: face.stepHeightMm, materialMap });
  if (!env) return [];
  const eps = DETAIL_FIT_EPS_MM;
  return stepsAtMinDrawn(env.steps, minDrawnMm(scaleDenom))
    .filter(({ t }) => t > eps && t < face.stepHeightMm - eps)
    .map(({ t, weight }) => ({ t, role: roleOf(weight) }));
}

// 面 F の面ローカル x の位置の探査点（世界座標。wallAdjacentFloorSegments の probeGapOwners と同じ奥行き）。
function probePointAtLocalX(face, localX) {
  const run = face.originWorld + localX * face.dirSign;
  const depth = face.axisCL.value + face.inward * PROBE_EPS_MM;
  return face.isVertical ? [depth, run] : [run, depth];
}

// 面 F の面ローカル x の位置の床の所有者。引けなければ null。
function floorOwnerAtLocalX(face, room, graph, localX) {
  const [px, py] = probePointAtLocalX(face, localX);
  const cell = worldToCell(px, py, graph);
  return cell ? (roomOwnerByCell(room, graph).get(cell.key) ?? null) : null;
}

/**
 * 壁面上の床の段差の縦線（appendFloorLines の riser の CUT）を、高い側の部屋の floorStep（床の段差の部位図）の輪郭（CUT・source=detail）へ差し替える
 * （S8b-3・後段処理）。帯の部屋 room の床区間（floorSegments）の隣り合う 2 区間で床高が違う境（riser）ごとに、高い側の区間の所有者
 * （floorOwnerAtLocalX）の割当てを段差高で fit した包絡線を引く。形状差 maxDeviationMm が DETAIL_SECTION_SWAP_MIN_DIFF_MM を超えるものだけ。
 * frame: 原点＝riser の描画 x（drawnRiserX）・高い側の床 y、s＝低い側へ（低い区間が右なら sx=+1・左なら −1）、t＝下向き。
 * 差し引く線: riser の縦線（CUT）の [高い側の床, 高い側の床＋輪郭の下端（段差高まで）]。輪郭の頂部が riser 面に付かない（出がある）ときは
 * 高い側の床面を鼻の先まで延ばす（riser 上端から始める）。段差見付け面自身（kind 'step'）の端の縦線は対象外。
 * primitives を直接書き換える（帯の座標系。finalizeBand の前）。
 * @param {object[]} primitives
 * @param {{faceRuns:{face:object, xCursor:number, floorSegments?:object[]}[]}} layout
 * @param {{graph:object, room:object, materialMap?:object|null, includeFace?:(face:object)=>boolean}} opts
 */
export function applyFloorStepSectionSwap(primitives, layout, { graph, room, materialMap = null, includeFace = () => true }) {
  if (!room || !(graph?.rooms ?? []).some(r => r.detailRefs?.[DetailSlot.FLOOR_STEP])) return;
  const envCache = new Map();
  layout.faceRuns.forEach(({ face, xCursor, floorSegments: segs }) => {
    if (face.kind === 'step' || !includeFace(face) || !(segs?.length > 1)) return;
    const half = halfWallThicknessMm(face);
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i];
      const b = segs[i + 1];
      const da = a.floorDeltaMm ?? 0;
      const db = b.floorDeltaMm ?? 0;
      if (da === db || a.flatLineSpanX || b.flatLineSpanX) continue; // 床が同じ高さの境・階段帯のレーン区間は riser を引かない
      const aHigh = da > db;
      const high = aHigh ? a : b;
      const stepHeightMm = Math.abs(da - db);
      // 探査点は riser から高い側の区間へ少し入った点（区間の中点だと、床高が同じで所有者が違う区間が連結された区間で riser に接しない部屋を拾う）
      const inset = Math.min(CORNER_PROBE_INTO_ROOM_MM, (high.hiX - high.loX) / 2);
      const owner = floorOwnerAtLocalX(face, room, graph, aHigh ? high.hiX - inset : high.loX + inset);
      if (!owner?.detailRefs?.[DetailSlot.FLOOR_STEP]) continue;
      const cacheKey = `${owner.id}|${stepHeightMm}`;
      if (!envCache.has(cacheKey)) envCache.set(cacheKey, floorStepEnvelope({ room: owner, stepHeightMm, materialMap }));
      const env = envCache.get(cacheKey);
      if (!env || !(env.maxDeviationMm > DETAIL_SECTION_SWAP_MIN_DIFF_MM) || env.outline.length < 2) continue;
      const x = xCursor + drawnRiserX(segs, i, half);
      const y = 0 - Math.max(da, db); // 0 − で −0 を作らない
      const sx = aHigh ? 1 : -1;
      const reach = Math.min(env.outline[env.outline.length - 1][1], stepHeightMm);
      // 出（鼻）の天端は高い側の床面の続き＝輪郭の先頭の前に riser 上端を補う
      placeStepOutline(primitives, { outline: env.outline, x, y, sx, lo: y, hi: y + reach, closeAt: 'first' });
    }
  });
}

// ---- 天井の段差（CeilingZone／Room.detailRefs の ceilingStep。S8b-4a）----

// 区間 seg が水平な自階の天井か（傾斜・円弧・上階の天井〔多層書き〕でない）。傾いた CUT 線は縦線の差し引きに合わない（G1）。
const isLevelOwnStoreyCeiling = seg => seg.chMm != null && seg.chHiMm == null && !seg.ceilArc && (seg.ceilFloorZMm ?? 0) === 0;

// 境界の CL の上、面の壁の仕上げ面から部屋の側へ CORNER_PROBE_INTO_ROOM_MM 入った奥行きに壁が立つか
// （G2。立てば天井の段差は壁〔垂れ壁含む〕の管轄で、部位図の対象でない。仕切り壁は外壁の仕上げ面から始まるので、通り芯の少し内側では外れる）。
function wallStandsOnBoundary(face, segLo, segHi, graph) {
  const clId = segLo.hiCLId ?? segHi.loCLId;
  if (clId == null) return false;
  const depth = (Number.isFinite(face.faceValue) ? face.faceValue : face.axisCL.value) + face.inward * CORNER_PROBE_INTO_ROOM_MM;
  return (graphList(graph, 'walls') ?? []).some(w => {
    if (w.axisCL?.id !== clId
      || !(Math.min(w.coord1, w.coord2) - DETAIL_FIT_EPS_MM <= depth && depth <= Math.max(w.coord1, w.coord2) + DETAIL_FIT_EPS_MM)) return false;
    // 腰壁だけの壁（垂れ壁なし）は天井まで届かない＝天井段差の管轄なので壁とみなさない
    const recs = kneeDropRecordsForWallPoint(graph, w, depth);
    return !(recs.length > 0 && recs.every(({ rec }) => rec.knee && !rec.drop));
  });
}

// 低い側の区間の位置（面ローカル x）の天井面の持ち主。区画の面なら区画（zone）・それ以外は部屋 owner（zone は null）。
// 区画の面でも、区画の割当てが無ければ部屋の割当てには継承しない。面が平面でない・持ち主が引けなければ null。
// ch＝持ち主の天井高（G3 の比較値。区画の面は区画の基準の CH・他は部屋の CH）。
function ceilingOwnerAtLocalX(face, room, graph, localX, field) {
  const [px, py] = probePointAtLocalX(face, localX);
  const cell = worldToCell(px, py, graph);
  const owner = cell ? (roomOwnerByCell(room, graph).get(cell.key) ?? null) : null;
  if (!owner) return null;
  const surface = field?.surfaceAt(px, py) ?? null;
  const own = surface && surface.roomId === owner.id ? surface : null;
  if (own && own.shape !== 'flat') return null;
  const zone = own && own.zoneId != null ? (owner.ceilingZones ?? []).find(z => z.id === own.zoneId) ?? null : null;
  if (own && own.zoneId != null && !zone) return null;
  return { owner, zone, ch: own ? own.chMm : roomCeilingHeight(graph, owner).mm };
}

/**
 * 壁面上の天井の段差の縦線（appendCeilingLines の段差の縦線）を、低い側の天井面の持ち主（区画 CeilingZone.detailRefs か部屋 Room.detailRefs）の
 * ceilingStep（天井の段差の部位図）の輪郭（CUT・source=detail）へ差し替える（S8b-4a・後段処理）。帯の部屋 room の床区間（floorSegments）の隣り合う 2 区間で
 * 天井の絶対高さ（floorDeltaMm＋chMm）が GAP_EPS 超で違う境ごとに、低い側の区間の持ち主の割当てを段差高で fit した包絡線を引く。形状差 maxDeviationMm が
 * DETAIL_SECTION_SWAP_MIN_DIFF_MM を超えるものだけ。区画から部屋への継承はしない（区画の割当てが無ければ描き方は従来のまま）。
 * 差し替えない境（ガード）: G1 両側が水平な自階の天井でない（傾斜・円弧・上階の天井）／G2 区画の境界でない縦線で、境界の CL の上に壁が立つ（垂れ壁の管轄）／
 * G3 低い側の chMm が持ち主の天井高と違う（階段の裏面で割った合成区間）／持ち主の面が平面でない。
 * frame: 原点＝縦線の描画 x（drawnCeilingRiserX）・低い側の天井の y、s＝高い側へ（高い側が右なら sx=+1）、t＝下向き（上が負）。
 * 差し引く線: 縦線（CUT）の [低い側の天井＋輪郭の上端, 低い側の天井]。輪郭の末尾が縦線の面に付かない（出がある）ときは低い側の天井面を出の先まで延ばす（末尾に原点を補う）。
 * 持ち主の探査点は低い側の区間の縦線側の端から CORNER_PROBE_INTO_ROOM_MM 入った点（区間幅の半分を上限。区間の中点だと同じ高さの隣の面が連結された区間で誤る）。
 * primitives を直接書き換える（帯の座標系。finalizeBand の前）。
 * @param {object[]} primitives
 * @param {{faceRuns:{face:object, xCursor:number, floorSegments?:object[]}[]}} layout
 * @param {{graph:object, room:object, materialMap?:object|null, segCeilAbsAt:(s:object,x:number)=>number, includeFace?:(face:object)=>boolean}} opts
 */
export function applyCeilingStepSectionSwap(primitives, layout, { graph, room, materialMap = null, segCeilAbsAt, includeFace = () => true }) {
  const assigned = (graph?.rooms ?? []).some(r => r.detailRefs?.[DetailSlot.CEILING_STEP]
    || (r.ceilingZones ?? []).some(z => z.detailRefs?.[DetailSlot.CEILING_STEP]));
  if (!room || !assigned) return;
  const field = zoneCeilingFieldOf(graph);
  const envCache = new Map();
  layout.faceRuns.forEach(({ face, xCursor, floorSegments: segs }) => {
    if (face.kind === 'step' || !includeFace(face) || !(segs?.length > 1)) return;
    const half = halfWallThicknessMm(face);
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i];
      const b = segs[i + 1];
      if (!isLevelOwnStoreyCeiling(a) || !isLevelOwnStoreyCeiling(b)) continue; // G1
      const ceilA = segCeilAbsAt(a, a.hiX);
      const ceilB = segCeilAbsAt(b, b.loX);
      const stepHeightMm = Math.abs(ceilA - ceilB);
      if (!(stepHeightMm > GAP_EPS_MM)) continue;
      if (wallStandsOnBoundary(face, a, b, graph)) continue; // G2
      const aLow = ceilA < ceilB;
      const low = aLow ? a : b;
      // 探査点は縦線に接する低い側の端から少し入った点
      const inset = Math.min(CORNER_PROBE_INTO_ROOM_MM, (low.hiX - low.loX) / 2);
      const hit = ceilingOwnerAtLocalX(face, room, graph, aLow ? low.hiX - inset : low.loX + inset, field);
      if (!hit || Math.abs(low.chMm - hit.ch) > GAP_EPS_MM) continue; // G3
      const holder = hit.zone ?? hit.owner;
      if (!holder.detailRefs?.[DetailSlot.CEILING_STEP]) continue;
      const cacheKey = `${holder.id}|${stepHeightMm}`;
      if (!envCache.has(cacheKey)) envCache.set(cacheKey, ceilingStepEnvelope({ room: hit.owner, zone: hit.zone, stepHeightMm, materialMap }));
      const env = envCache.get(cacheKey);
      if (!env || !(env.maxDeviationMm > DETAIL_SECTION_SWAP_MIN_DIFF_MM) || env.outline.length < 2) continue;
      const x = xCursor + drawnCeilingRiserX(segs, i, half);
      const y = 0 - Math.min(ceilA, ceilB); // 0 − で −0 を作らない
      const sx = aLow ? 1 : -1; // 高い側が右（a が低い・b が高い）なら +1
      const top = Math.max(env.outline[0][1], -stepHeightMm);
      placeStepOutline(primitives, { outline: env.outline, x, y, sx, lo: y + top, hi: y, closeAt: 'last' });
    }
  });
}

/**
 * 段差の部位図（床の段差・天井の段差）の輪郭を壁面に置く共通部（8b-3 から切り出し）。riser の縦線 [lo, hi] を差し引き、
 * 輪郭（CUT・source=detail）を原点 (x, y)・s 方向 sx・t 下向きで置く。輪郭の closeAt の端が riser 面（s≈0）に付かないとき（出・鼻がある）は
 * その端に原点 (x, y)（面の続き）を補う。primitives を直接書き換える。
 * @param {object[]} primitives
 * @param {{outline:number[][], x:number, y:number, sx:1|-1, lo:number, hi:number, closeAt:'first'|'last'}} p
 */
function placeStepOutline(primitives, { outline, x, y, sx, lo, hi, closeAt }) {
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const prims = subtractCollinearSpans(primitives, { axis: 'x', at: x, lo, hi, weight: cutWeight });
  const pts = outline.map(([s, t]) => [x + s * sx, y + t]);
  if (closeAt === 'first' && Math.abs(outline[0][0]) > DETAIL_FIT_EPS_MM) pts.unshift([x, y]);
  if (closeAt === 'last' && Math.abs(outline[outline.length - 1][0]) > DETAIL_FIT_EPS_MM) pts.push([x, y]);
  prims.push(polyline(pts, { weight: cutWeight, source: DETAIL_PRIM_SOURCE }));
  replacePrimitives(primitives, prims);
}
