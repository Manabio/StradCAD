/**
 * 階段帯の天井＝階段の裏面（E5。純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * N 階の階段帯（階段室の展開図）で、N+1 の続き階段（木造）を裏から見た傾斜天井（ceiling/stairSoffit.js stairSoffitSolids）を
 * 切断線の深さで切った天井断面にする。供給源 zoneCeiling.js（天伏の区画）と同じ契約: 値は**部屋 FL 基準の天井高 ch**
 * （立体の絶対 z − 床段差。床段差はエンジンの floorZFor／体裁の floorDelta が足すので、ここで足すと二重になる）。
 *
 * 式の唯一の供給源は stairSoffit.js のまま——ここは立体の公開フィールド（footprint.rects・innerLines・zAt）を読むだけで、
 * 見上げ（planSolids の stairSoffit 立体）と同じ述語（matchingStairBelow）・同じ引数で同じ立体を引く。
 * 節の間は厳密に直線（1 区間 1 線分。列ごとのサンプリングはしない）: 節は (1) 切断線の深さを含む矩形の走り方向の辺
 * (2) innerLines（前縁・対角線・x=pv の境）と切断線の交点 (3) 足元が途切れる区間の端。
 * 範囲外（足元の外）は返さない——呼び出し側が既存の値（N の CH・上階天井）でつなぐ。
 */
import { matchingStairBelow } from '../../structural/openingBeamAxes.js';
import { stairSoffitSolids } from '../../ceiling/stairSoffit.js';
import { GAP_EPS_MM as GAP_EPS, FLOAT_EPS } from '../elevationStyle.js';
import { roomFloorStepMm } from '../../finish/roomMetrics.js';

const PROBE_DELTA_MM = 0.01; // 節の両側の値を取る距離（直線なので外挿して節の値を厳密に出す）
const NODE_MERGE_MM = 1e-3;  // これ未満の節の間隔は同じ節とみなす（矩形の接合の数値誤差）
const IN_RECT_EPS_MM = 1e-3; // 切断線の深さが矩形の辺にある場合の許容

/**
 * N の階段 stair の足元の上に、続きの木造階段が上階にあれば、その裏面の立体を返す。無ければ null。
 * @param {{stair:object, graph:object, upperGraph:object|null, floorHeightMm:number, riserOf:(s:object)=>number|null}} args
 *   riserOf … 上階の階段の蹴上（PlanSolidsLayer の aboveRiserOf と同じ式を呼び元が渡す）
 * @returns {{solid:object, upperStairId:string, upperRoomId:string|null, floorStepMm:number}|null}
 */
export function stairSoffitAbove({ stair, graph, upperGraph, floorHeightMm, riserOf }) {
  if (!stair || !graph || !upperGraph || !Number.isFinite(floorHeightMm) || typeof riserOf !== 'function') return null;
  for (const t of upperGraph.stairs ?? []) {
    if (matchingStairBelow(t, upperGraph, graph) !== stair) continue;
    // aboveGraph は渡さない（N+2 は層スタックに無いため到達辺は Q3 に戻る＝既知の限界）
    const [solid] = stairSoffitSolids({
      stair: t, graph: upperGraph, belowStair: stair, belowGraph: graph, riser: riserOf(t), floorZMm: floorHeightMm,
    });
    if (!solid) continue;
    const room = stair.roomId != null ? (graph.rooms ?? []).find(r => r.id === stair.roomId) : null;
    const floorStepMm = room ? roomFloorStepMm(graph, room) : 0;
    return { solid, upperStairId: String(t.id), upperRoomId: t.roomId ?? null, floorStepMm };
  }
  return null;
}

// 垂直の段とみなす高さの差（mm）。外挿の数値誤差（<1e-6）より十分大きく、実データの段（回転部の Δ＝蹴上の倍数）より十分小さい。
const STEP_MIN_MM = Math.max(GAP_EPS, 1e-3);

/** 節 r から符号つき距離 d の側の直線を、d と 2d の 2 点から r まで外挿した値（区間内が厳密に直線であることを使う）。 */
const extrapolate = (valueAt, r, d) => 2 * valueAt(r + d) - valueAt(r + 2 * d);

const zAtOf = solid => (solid.zAt ? (x, y) => solid.zAt(x, y) : () => solid.zLo);

/** 切断線の深さ・走りの座標 → 世界の (x, y)。isVertical（縦の切断線）なら深さが x・走りが y。 */
const worldPt = (isVertical, depth, run) => (isVertical ? [depth, run] : [run, depth]);

/** 矩形の [深さ範囲, 走り範囲]。 */
function rectRanges(rc, isVertical) {
  return isVertical
    ? { d0: rc.x1, d1: rc.x2, r0: rc.y1, r1: rc.y2 }
    : { d0: rc.y1, d1: rc.y2, r0: rc.x1, r1: rc.x2 };
}

/** 切断線の深さを含む矩形の走り範囲を [lo, hi] で切って、重なり合う（接する）ものを併合した区間の列（昇順）。 */
function coveredIntervals(solid, isVertical, depthCoord, lo, hi) {
  const spans = [];
  for (const rc of solid.footprint?.rects ?? []) {
    const { d0, d1, r0, r1 } = rectRanges(rc, isVertical);
    if (depthCoord < Math.min(d0, d1) - IN_RECT_EPS_MM || depthCoord > Math.max(d0, d1) + IN_RECT_EPS_MM) continue;
    const a = Math.max(Math.min(r0, r1), lo), b = Math.min(Math.max(r0, r1), hi);
    if (b - a > NODE_MERGE_MM) spans.push([a, b]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + NODE_MERGE_MM) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** innerLines（面の折れ目）と切断線の交点の走り座標。切断線に重なる（平行）線は矩形の辺と同じなので数えない。 */
function foldCrossings(solid, isVertical, depthCoord) {
  const out = [];
  for (const ln of solid.innerLines ?? []) {
    const [x1, y1, x2, y2] = ln.points;
    const [d1, r1, d2, r2] = isVertical ? [x1, y1, x2, y2] : [y1, x1, y2, x2];
    if (Math.abs(d2 - d1) < NODE_MERGE_MM) continue; // 切断線に平行
    const t = (depthCoord - d1) / (d2 - d1);
    if (t < -FLOAT_EPS || t > 1 + FLOAT_EPS) continue;
    out.push(r1 + t * (r2 - r1));
  }
  return out;
}

/**
 * 切断線（深さ depthCoord・走り方向 [lo, hi]）上の裏面の天井高さの折れ線（部屋 FL 基準の ch）。
 * 返す節は走りの世界座標の昇順。高さが食い違う節（垂直の段）は同じ run に 2 つ（段の手前→奥の順）。
 * 足元が途切れる区間があれば、途切れの後の最初の節に gapBefore:true を付ける（その手前の節との間は裏面なし）。
 * depthCoord が足元の外・引数が非有限・裏面なしなら null。
 * @param {{solid:object, floorStepMm?:number}|null} soffit stairSoffitAbove の戻り値
 * @param {{isVertical:boolean, depthCoord:number, lo:number, hi:number}} q
 * @returns {Array<{run:number, ch:number, gapBefore?:true}>|null}
 */
export function stairSoffitChAlong(soffit, { isVertical, depthCoord, lo, hi }) {
  const solid = soffit?.solid;
  if (!solid || ![depthCoord, lo, hi].every(Number.isFinite) || !(hi > lo)) return null;
  const step = soffit.floorStepMm ?? 0;
  const zAt = zAtOf(solid);
  const chAtRun = run => { const [x, y] = worldPt(isVertical, depthCoord, run); return zAt(x, y) - step; };
  const intervals = coveredIntervals(solid, isVertical, depthCoord, lo, hi);
  if (intervals.length === 0) return null;
  const crossings = foldCrossings(solid, isVertical, depthCoord);
  const edges = [];
  for (const rc of solid.footprint.rects) {
    const { d0, d1, r0, r1 } = rectRanges(rc, isVertical);
    if (depthCoord < Math.min(d0, d1) - IN_RECT_EPS_MM || depthCoord > Math.max(d0, d1) + IN_RECT_EPS_MM) continue;
    edges.push(r0, r1);
  }
  const out = [];
  intervals.forEach(([a, b], k) => {
    const nodes = [a, b];
    for (const r of [...edges, ...crossings]) if (r > a + NODE_MERGE_MM && r < b - NODE_MERGE_MM) nodes.push(r);
    nodes.sort((p, q) => p - q);
    const uniq = [];
    for (const r of nodes) if (uniq.length === 0 || r - uniq[uniq.length - 1] > NODE_MERGE_MM) uniq.push(r);
    // 節ごとに両側の値（隣の節までの区間は直線なので、区間内の 2 点から外挿して節の値を厳密に出す）
    uniq.forEach((r, i) => {
      const prev = i > 0 ? uniq[i - 1] : null, next = i + 1 < uniq.length ? uniq[i + 1] : null;
      const left = prev == null ? null : extrapolate(chAtRun, r, -Math.min(PROBE_DELTA_MM, (r - prev) / 4));
      const right = next == null ? null : extrapolate(chAtRun, r, Math.min(PROBE_DELTA_MM, (next - r) / 4));
      const vals = left != null && right != null
        ? (Math.abs(left - right) > STEP_MIN_MM ? [left, right] : [(left + right) / 2])
        : [left ?? right];
      vals.forEach((ch, j) => {
        const e = { run: r, ch };
        if (k > 0 && i === 0 && j === 0) e.gapBefore = true;
        out.push(e);
      });
    });
  });
  return out;
}

/**
 * 列の幅 [lo, hi]（走りの世界座標）での裏面の天井高さ（ch）の最大。cellAt の span 用（E3b-4 の規約: 列の幅の最大）。
 * 切断線の深さで足元の外・範囲が足元に掛からないなら null。
 * @returns {number|null}
 */
export function stairSoffitChMaxOver(soffit, { isVertical, depthCoord, lo, hi }) {
  if (![lo, hi].every(Number.isFinite)) return null;
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  // 幅 0（点）は掛かるかどうかだけ見て点の値にする
  const nodes = stairSoffitChAlong(soffit, { isVertical, depthCoord, lo: a, hi: b > a ? b : a + NODE_MERGE_MM * 2 });
  if (!nodes || nodes.length === 0) return null;
  return Math.max(...nodes.map(n => n.ch));
}

/** 世界の点 (x, y) の裏面の ch。足元の外は null。 */
export function stairSoffitChAt(soffit, x, y) {
  const solid = soffit?.solid;
  if (!solid || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const inside = (solid.footprint?.rects ?? []).some(rc =>
    x >= rc.x1 - IN_RECT_EPS_MM && x <= rc.x2 + IN_RECT_EPS_MM && y >= rc.y1 - IN_RECT_EPS_MM && y <= rc.y2 + IN_RECT_EPS_MM);
  if (!inside) return null;
  return zAtOf(solid)(x, y) - (soffit.floorStepMm ?? 0);
}

// ---------------------------------------------------------------- 自階の階段の裏面で部屋帯の天井線を頭打ちにする（S8-4）

const CEIL_EPS_MM = 1e-6; // 天井の高さの比較の許容（裏面が「下」とみなす差・同値の判定）

/** 区間 s の局所 x での元の天井高（chMm→chHiMm の直線。chMm 未指定は defaultCh）。 */
function segChAt(s, x, defaultCh) {
  const c0 = s.chMm ?? s.chHiMm ?? defaultCh; // chHiMm だけの区間は水平（c0 を c1 に寄せる）
  const c1 = s.chHiMm ?? c0;
  const w = s.hiX - s.loX;
  if (c1 === c0 || !(w > 0)) return c0; // Infinity 同士で NaN を作らない
  return c0 + (c1 - c0) * (x - s.loX) / w;
}

/** 区間 seg（局所 x [loX, hiX]）に裏面 soffit を掛けた区間の列。裏面が天井を下回る所が無い・掛からない・不正なら null。 */
function splitSegBySoffit(seg, face, soffit, { floorZFor, ownerRoomIdOf, defaultCh }) {
  if (seg.ceilArc || !(seg.hiX > seg.loX) || !soffit?.surface) return null;
  const sign = face.dirSign === -1 ? -1 : 1;
  const w0 = face.originWorld + seg.loX * sign, w1 = face.originWorld + seg.hiX * sign;
  const wLo = Math.min(w0, w1), wHi = Math.max(w0, w1);
  const mid = (wLo + wHi) / 2;
  if (ownerRoomIdOf && soffit.stairRoomId != null && ownerRoomIdOf(seg, mid) === soffit.stairRoomId) return null; // 階段の対の部屋は対象外
  const flz = floorZFor(seg, mid);
  if (!Number.isFinite(flz)) return null;
  const nodes = stairSoffitChAlong({ solid: soffit.surface, floorStepMm: 0 },
    { isVertical: !!face.isVertical, depthCoord: face.faceValue, lo: wLo, hi: wHi });
  if (!nodes || nodes.length < 2 || !nodes.every(n => Number.isFinite(n.run) && Number.isFinite(n.ch))) return null;
  const toX = r => (r - face.originWorld) * sign;
  // 裏面が掛かる直線の区間（局所 x の昇順）
  const covered = [];
  for (let j = 0; j + 1 < nodes.length; j++) {
    const a = nodes[j], b = nodes[j + 1];
    if (b.gapBefore || !(b.run - a.run > NODE_MERGE_MM)) continue;
    let [xa, ca, xb, cb] = [toX(a.run), a.ch - flz, toX(b.run), b.ch - flz];
    if (xa > xb) [xa, ca, xb, cb] = [xb, cb, xa, ca];
    covered.push({ xa, ca, xb, cb });
  }
  covered.sort((p, q) => p.xa - q.xa);
  // 元の天井との min で割った部品（soff＝裏面が下の部品）。裏面の外は soff:false の部品
  const parts = [];
  const pushOrig = (x0, x1) => { if (x1 - x0 > 1e-9) parts.push({ x0, x1, c0: segChAt(seg, x0, defaultCh), c1: segChAt(seg, x1, defaultCh), soff: false }); };
  let cursor = seg.loX;
  for (const cv of covered) {
    const xa = Math.max(cv.xa, seg.loX), xb = Math.min(cv.xb, seg.hiX);
    if (!(xb - xa > 1e-9)) continue;
    pushOrig(cursor, xa);
    const lerp = x => cv.ca + (cv.cb - cv.ca) * (x - cv.xa) / (cv.xb - cv.xa);
    const f0 = segChAt(seg, xa, defaultCh), f1 = segChAt(seg, xb, defaultCh);
    const g0 = lerp(xa), g1 = lerp(xb);
    const d0 = f0 - g0, d1 = f1 - g1; // 正＝裏面が下
    const fAt = x => segChAt(seg, x, defaultCh);
    const emit = (x0, x1, soff) => parts.push({ x0, x1, c0: (soff ? lerp : fAt)(x0), c1: (soff ? lerp : fAt)(x1), soff });
    if ((d0 > CEIL_EPS_MM && d1 < -CEIL_EPS_MM) || (d0 < -CEIL_EPS_MM && d1 > CEIL_EPS_MM)) {
      const xc = xa + (xb - xa) * d0 / (d0 - d1);
      emit(xa, xc, d0 > 0);
      emit(xc, xb, d1 > 0);
    } else {
      emit(xa, xb, d0 > CEIL_EPS_MM || d1 > CEIL_EPS_MM);
    }
    cursor = xb;
  }
  pushOrig(cursor, seg.hiX);
  if (!parts.some(p => p.soff)) return null; // 裏面が天井より上（または掛からない）＝不変
  // 隣り合う元のまま部品は 1 つへ戻す
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && !last.soff && !p.soff) { last.x1 = p.x1; last.c1 = p.c1; } else merged.push({ ...p });
  }
  return merged.map((p, i) => {
    const first = i === 0, lastP = i === merged.length - 1;
    const out = { ...seg, loX: p.x0, hiX: p.x1 };
    if (!first && 'loCLId' in seg) out.loCLId = null; // 内側の割れ目は段差 CL ではない（寸法の分割点にしない）
    if (!lastP && 'hiCLId' in seg) out.hiCLId = null;
    // 内側の割れ目は壁の無い境目（天伏の区画の境界と同じ）＝図は段差・天井の小口として半壁厚ずらさない（drawnRiserX・drawnCeilingRiserX が読む印）。
    // 最後の部品は元の区間の hiX の印をそのまま保つ
    if (!lastP) out.zoneCeilEdgeHi = true;
    if (p.soff || seg.chMm != null) {
      out.chMm = p.c0;
      if (Math.abs(p.c1 - p.c0) > CEIL_EPS_MM) out.chHiMm = p.c1; else delete out.chHiMm;
    } else delete out.chHiMm;
    return out;
  });
}

/**
 * 部屋帯の区間列 segs の天井線を、自階の階段の裏面（stairFootSurfaces の面）で頭打ちにした区間列にする。
 * 規則: 階段の足元の中にあり、所有部屋が階段の対の部屋（stairRoomId）ではない区間の天井＝min(元の天井, 裏面)。
 * 傾斜は 1 区間 1 線分（chMm＝loX 側・chHiMm＝hiX 側。ceilProfileFromSegments が読む形）。区間は裏面の節（矩形の辺・
 * innerLines との交点・足元の端）と、元の天井と裏面の交点で割る。割れ目では loCLId/hiCLId を null にする（段差 CL ではない）。
 * 評価の奥行きは面の位置 face.faceValue（stairSoffitChAlong の切断線の深さ）。
 * soffits が空・面が足元に掛からない・裏面が天井より上・不正（NaN 等）なら元の区間（または元の配列そのもの）を返す。例外は投げない。
 * @param {Array<object>} segs 部屋帯の区間列（loX・hiX は面ローカル x。他の項目は保つ）
 * @param {{faceValue:number, isVertical:boolean, dirSign:1|-1, originWorld:number}} face 面（局所 x＝(世界の走り座標−originWorld)×dirSign）
 * @param {Array<{stairId:string, stairRoomId:?string, surface:object}>} soffits stairFootSurfaces の面
 * @param {{
 *   floorZFor:(seg:object, runWorld:number)=>number,
 *   ownerRoomIdOf?:(seg:object, runWorld:number)=>?string,
 *   defaultCh?:number,
 * }} opts floorZFor＝区間の所有者の部屋の FL（絶対 z。裏面の ch＝zAbs−これ）／ownerRoomIdOf＝所有部屋の id（対の部屋の除外判定）／
 *   defaultCh＝chMm 未指定の区間の天井高（既定 Infinity＝裏面が勝つ。帯の CH を渡すと ceilProfileFromSegments と同じ）
 * @returns {Array<object>}
 */
export function minCeilingSegmentsWithSoffits(segs, face, soffits, { floorZFor, ownerRoomIdOf, defaultCh = Infinity } = {}) {
  if (!Array.isArray(segs) || segs.length === 0 || !Array.isArray(soffits) || soffits.length === 0 || typeof floorZFor !== 'function') return segs;
  if (!face || !Number.isFinite(face.faceValue) || !Number.isFinite(face.originWorld)) return segs;
  let cur = segs, changed = false;
  for (const soffit of soffits) {
    const next = [];
    let any = false;
    for (const seg of cur) {
      const split = splitSegBySoffit(seg, face, soffit, { floorZFor, ownerRoomIdOf, defaultCh });
      if (split) { next.push(...split); any = true; } else next.push(seg);
    }
    if (any) { cur = next; changed = true; }
  }
  return changed ? cur : segs;
}

/**
 * 帯の天井線（minCeilingSegmentsWithSoffits）が、面の位置 face.faceValue・走りの世界座標 runWorld で取る裏面の高さ（帯の z 基準。
 * 裏面の絶対 z−floorOffsetMm）。足元の外・soffits が空・値が非有限なら Infinity（天井を下げない）。複数の裏面があれば最小。
 * 柱型の縦線（天井断面線より上へ出ない）の上端に使う——天井線と同じ点・同じ式で評価するので、縦線は天井線の上で終わる。
 * @param {Array<{stairId:string, stairRoomId:?string, surface:object}>} soffits
 * @param {{faceValue:number, isVertical:boolean}} face
 * @param {number} runWorld
 * @param {number} floorOffsetMm 帯の部屋の実効 FL（datum 基準。bandFloorOffsetMm）
 * @returns {number}
 */
export function underStairSoffitTopAt(soffits, face, runWorld, floorOffsetMm) {
  if (!Array.isArray(soffits) || soffits.length === 0 || !Number.isFinite(face?.faceValue) || !Number.isFinite(runWorld)) return Infinity;
  const [x, y] = worldPt(!!face.isVertical, face.faceValue, runWorld);
  let top = Infinity;
  for (const s of soffits) {
    const z = stairSoffitChAt({ solid: s.surface, floorStepMm: 0 }, x, y);
    if (Number.isFinite(z) && Number.isFinite(floorOffsetMm)) top = Math.min(top, z - floorOffsetMm);
  }
  return top;
}
