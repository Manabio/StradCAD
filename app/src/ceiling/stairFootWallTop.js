/**
 * 階段の足元の中の壁の天端（純モジュール。store.js・snap.js・.jsx を静的に引かない）。
 * 平面の立体（plan/planSolids.js）と展開図の両方から使う中立の置き場。planSolids.js から出力不変で移した
 * （S10-8 ステップ1）。供給源は階段の裏面（stairSoffit.js stairUndersideSurface）。
 */
import { RoomKind } from '@core';
import { wallConcealRange } from '../finish/columnWrap.js';
import { stairUndersideSurface } from './stairSoffit.js';
import { stairTreadFootprints } from '../finish/stair/stairTreads.js';
import { riserOf } from '../finish/stair/stairDimensions.js';

/**
 * 階段の足元の中の壁の天端＝階段の裏面（ceiling/stairSoffit.js stairUndersideSurface。構造・壁の種類によらない。dz は木造と同じ）。
 * 裏面で止めないと壁が部屋の天井まで立ち、見下げで踏面（裏面より上）より高くなって「面材が勝つ」規則（planSectionFigure.js
 * hidesAt）で隠れず、上階の床の穴ごしに下階レイヤの線として現れる（moku4-3 2階の踊り場前縁 y=−8247.5 の復路下の壁の線。
 * 13.stq 2階「6」の階段下の部屋「13」の壁。ユーザー指示 2026-10-17「木造階段同様に Z 座標でクリップ」）。固定 mm の閾値は使わない。
 * 階高は呼び出し側の規則（floorHeightOf）。平面は直上の層との差、直上の層が無い最上の層（見下げの自階）は層の蹴上×総段数で戻す
 * （riserOf の逆算。明示の stair.riser はそのまま使われる）。階高・蹴上が決まらない・屋外階段・裏面が組めない型（L_TURN 等）は
 * 面を載せない＝従来どおり天井高。往路の基端の高さは自階の FL（自階の壁に下階の天井は無い）。
 * @param {object} graph 階段のある層の graph
 * @param {{
 *   floorHeightOf: (stair:object)=>number|null,
 *   floorZOf: (stair:object)=>number,
 *   aboveGraph?: object|null,
 *   treadPolysOf?: ((stair:object, riser:number)=>number[][])|null,
 * }} opts floorHeightOf＝階段の階高（決まらなければ null）／floorZOf＝層の FL（floorZMm と zStartMm の両方に使う）／
 *   aboveGraph＝直上の層の graph（復路の到達辺。stairTreadSolids と同じ）／treadPolysOf＝段の占有形の頂点列（呼び出し側のキャッシュを使うとき。
 *   省略時は stairTreadFootprints を直接呼ぶ）
 * @returns {object[]} 裏面の面（footprint.rects＋zAt＋段の境界 stepXs・stepYs）
 */
export function stairFootSurfaces(graph, { floorHeightOf, floorZOf, aboveGraph = null, treadPolysOf = null }) {
  const out = [];
  for (const stair of graph.stairs ?? []) {
    if (graph.roomMap?.get(stair.roomId)?.kind === RoomKind.EXTERIOR) continue; // 屋外階段の下に壁は立たない
    const floorHeight = floorHeightOf(stair);
    if (!Number.isFinite(floorHeight) || floorHeight <= 0) continue;
    const riser = riserOf(stair, floorHeight);
    if (!Number.isFinite(riser)) continue;
    const floorZ = floorZOf(stair);
    const surface = stairUndersideSurface({ stair, graph, riser, floorZMm: floorZ, aboveGraph, zStartMm: floorZ });
    if (!surface?.footprint?.rects?.length) continue;
    // 段の境界（各段の占有形の頂点の座標）。足元の区間をここで割り、傾斜に沿う長い壁が低い端の値へ全長下がらないようにする
    const polys = treadPolysOf
      ? treadPolysOf(stair, riser)
      : stairTreadFootprints(stair, graph, { riser, insetView: 'upper', aboveGraph }).map(t => t.poly);
    const stepCoords = i => [...new Set(polys.flatMap(p => p.filter((_, k) => k % 2 === i)))];
    out.push({ ...surface, stepXs: stepCoords(0), stepYs: stepCoords(1) });
  }
  return out;
}

export const FOOT_EPS_MM = 1e-6;

/**
 * 壁（長さ方向 wLo〜wHi）が階段の足元（裏面の footprint.rects）の中にある区間 {lo, hi, surface}（長さ方向の座標）。
 * 対象は壁の軸（帯の中央）が足元の矩形の厚み方向の範囲の中にある壁だけ（軸が階段の下にある壁が階段下の壁。帯が端で
 * 少し重なるだけの階段室の外周壁などは対象外。QA の反例を受けたリード裁定 2026-10-17・ユーザー未確認）。
 */
export function wallFootIntervals(wall, cr, wLo, wHi, surfaces) {
  const out = [];
  // 壁の軸＝帯（wallConcealRange）の中央。偏芯した仕上げの薄壁は wall.axisValue が帯の端（通り芯）にあるので、
  // 通り芯が足元の縁に乗っていても薄壁が下地の壁と別扱いにならないよう帯の中央で判定する
  const axis = (cr.lo + cr.hi) / 2;
  for (const surface of surfaces) {
    for (const r of surface.footprint.rects) {
      const [bLo, bHi, aLo, aHi] = wall.isVertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
      if (!(axis >= bLo - FOOT_EPS_MM && axis <= bHi + FOOT_EPS_MM)) continue; // 隣り合う足元の矩形の共有辺上の軸はどちらの矩形でも対象
      const lo = Math.max(wLo, aLo), hi = Math.min(wHi, aHi);
      if (hi - lo > FOOT_EPS_MM) out.push({ lo, hi, surface });
    }
  }
  return out;
}

/**
 * 区間 [lo, hi] が足元の中なら、その区間の天端（長さ方向 lo・中央・hi × 厚み方向 帯の両端と中央の 3 点の裏面 zAt の最小）。
 * 足元の外（どの足元区間にも中点が入らない）は Infinity＝天井高のまま。区間は wallFootIntervals の端で割ってあるので、
 * 中点が入れば区間全体が足元の中。
 */
export function wallFootTop(wall, cr, lo, hi, foot) {
  const mid = (lo + hi) / 2;
  let top = Infinity;
  for (const f of foot) {
    if (!(mid > f.lo && mid < f.hi)) continue;
    for (const a of [lo, mid, hi]) top = Math.min(top, thicknessMinZ(wall, cr, f.surface, a));
  }
  return quantizeTop(top);
}

// 長さ方向 a での、厚み方向の評価点 bs（既定は帯の両端と中央の 3 点）の裏面 zAt の最小（量子化前）。足元の天端の評価式の唯一の置き場
function thicknessMinZ(wall, cr, surface, a, bs = [cr.lo, (cr.lo + cr.hi) / 2, cr.hi]) {
  let top = Infinity;
  for (const b of bs) {
    const z = surface.zAt ? (wall.isVertical ? surface.zAt(b, a) : surface.zAt(a, b)) : surface.zLo;
    if (Number.isFinite(z)) top = Math.min(top, z);
  }
  return top;
}

// 1e-6 mm に量子化する（補間の float 誤差で、同じ芯の下地の壁と仕上げの薄壁が別の高さになり mergeTouchingWalls で割れるのを防ぐ）
function quantizeTop(top) {
  return Number.isFinite(top) ? Math.round(top * 1e6) / 1e6 : top;
}

const KNOT_MERGE_MM = 1e-3; // これ未満の節の間隔は同じ節とみなす

/**
 * 足元の区間のうち、壁の帯 [cr.lo, cr.hi] が、その長さ方向の位置で足元の矩形の厚み方向の和に**完全に覆われる**区間だけ残す。
 * wallFootIntervals は帯の中央（軸）が矩形の中にあれば対象にするため、階段の起点・到達点の端（矩形は階段室の外周側を内側へ
 * 縮めない）に立つ外周壁も軸が矩形の端の内側 6mm 程に入って対象になり、起点では裏面が床面（z≈0）なので壁が消える。
 * そのような壁は帯が矩形の外へはみ出す（覆われない）ので除く。帯が 2 つの矩形にまたがる（踊り場と往路の境の復路下の壁など）
 * 場合は和で覆われるので残る。展開図の探査専用（平面の立体 planSolids.js は wallFootIntervals のまま）。
 */
function coveredFootIntervals(wall, cr, foot) {
  const out = [];
  for (const f of foot) {
    const rects = f.surface.footprint.rects.map(r => (wall.isVertical
      ? { b0: r.x1, b1: r.x2, a0: r.y1, a1: r.y2 } : { b0: r.y1, b1: r.y2, a0: r.x1, a1: r.x2 }));
    const cuts = [f.lo, f.hi, ...rects.flatMap(r => [r.a0, r.a1]).filter(a => a > f.lo && a < f.hi)].sort((p, q) => p - q);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const lo = cuts[i], hi = cuts[i + 1];
      if (!(hi - lo > FOOT_EPS_MM)) continue;
      const mid = (lo + hi) / 2;
      const ivs = rects.filter(r => mid > r.a0 && mid < r.a1).map(r => [r.b0, r.b1]).sort((p, q) => p[0] - q[0]);
      let cover = null;
      for (const [b0, b1] of ivs) {
        if (cover && b0 <= cover[1] + 1e-3) cover[1] = Math.max(cover[1], b1);
        else if (!cover || (b0 <= cr.lo + 1e-3 && b1 > cover[1])) cover = [b0, b1];
      }
      if (!cover || !(cover[0] <= cr.lo + 1e-3 && cover[1] >= cr.hi - 1e-3)) continue;
      const prev = out[out.length - 1];
      if (prev && prev.surface === f.surface && Math.abs(prev.hi - lo) < FOOT_EPS_MM) prev.hi = hi;
      else out.push({ lo, hi, surface: f.surface });
    }
  }
  return out;
}

/**
 * 壁の天端プロファイル（展開図の探査用。sectionProbe.js addStairFootTops）。足元の区間ごとに、節の間を直線でつないだ
 * 裏面に沿う折れ線の天端。節＝区間の端・段の境界・足元の矩形の辺・厚み方向の評価線と裏面の折れ目（innerLines）の交点。
 * 節の値は wallFootTop と同じ評価（厚み方向 3 点の最小・1e-6 量子化）。足元の外は +Infinity（天井高のまま）。
 * 足元の区間が無い・帯が無効なら null。
 * @param {object} wall
 * @param {object[]} surfaces stairFootSurfaces の面
 * @param {{acrossMm?:number|null, zOffsetMm?:number}} [opts]
 *   acrossMm … 厚み方向の評価点（世界座標）。省略は帯の 3 点の最小（平面と同じ）。部屋帯の天井線（stairSoffitCeiling.js）は壁の
 *   室内側の面で裏面を評価するので、壁の天端もその面の位置で評価して天井線と食い違いを作らない（3 点の最小は傾斜の分だけ低くなりアキが残る）。
 *   zOffsetMm … 節の値から引く量（裏面は階の datum 基準・探査の z は帯の部屋の実効 FL 基準。makeProbeContext の floorOffsetMm と同じ）
 * @returns {{zAt:(along:number)=>number, crossings:(zLevels:number[])=>number[], spans:number[][], junction:true, footCap:true}|null}
 */
export function wallFootTopProfile(wall, surfaces, { acrossMm = null, zOffsetMm = 0 } = {}) {
  const cr = wallConcealRange(wall);
  if (!cr || !(cr.hi - cr.lo > 0) || !(surfaces?.length > 0)) return null;
  const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
  if (!Number.isFinite(wLo) || !Number.isFinite(wHi)) return null;
  const foot = coveredFootIntervals(wall, cr, wallFootIntervals(wall, cr, wLo, wHi, surfaces));
  if (foot.length === 0) return null;
  const bands = Number.isFinite(acrossMm) ? [acrossMm] : [cr.lo, (cr.lo + cr.hi) / 2, cr.hi];
  const valueAt = (surface, a) => quantizeTop(thicknessMinZ(wall, cr, surface, a, bands) - zOffsetMm);
  const pieces = foot.map(({ lo, hi, surface }) => {
    const cand = [lo, hi, ...(wall.isVertical ? surface.stepYs : surface.stepXs) ?? []];
    for (const r of surface.footprint.rects) cand.push(...(wall.isVertical ? [r.y1, r.y2] : [r.x1, r.x2]));
    for (const ln of surface.innerLines ?? []) {
      const [x1, y1, x2, y2] = ln.points;
      const [d1, r1, d2, r2] = wall.isVertical ? [x1, y1, x2, y2] : [y1, x1, y2, x2];
      if (Math.abs(d2 - d1) < KNOT_MERGE_MM) continue; // 厚み方向線に平行
      for (const b of bands) {
        const t = (b - d1) / (d2 - d1);
        if (t >= 0 && t <= 1) cand.push(r1 + t * (r2 - r1));
      }
    }
    const sorted = cand.filter(c => Number.isFinite(c) && c >= lo && c <= hi).sort((p, q) => p - q);
    const knots = [];
    for (const c of sorted) {
      if (knots.length > 0 && c - knots[knots.length - 1].a < KNOT_MERGE_MM) continue;
      knots.push({ a: c, z: valueAt(surface, c) });
    }
    return { lo, hi, knots };
  }).filter(p => p.knots.length > 0 && p.knots.every(k => Number.isFinite(k.z)));
  if (pieces.length === 0) return null;
  const evalPiece = (p, along) => {
    const ks = p.knots;
    if (ks.length === 1) return ks[0].z;
    for (let i = 0; i + 1 < ks.length; i++) {
      const k0 = ks[i], k1 = ks[i + 1];
      if (along <= k1.a) return k0.z + (k1.z - k0.z) * Math.min(1, Math.max(0, (along - k0.a) / (k1.a - k0.a)));
    }
    return ks[ks.length - 1].z;
  };
  // 足元の区間の中（閉区間）は節の間の線形補間。区間が接する点は低い方
  const zAt = along => {
    let z = Infinity;
    for (const p of pieces) if (along >= p.lo - FOOT_EPS_MM && along <= p.hi + FOOT_EPS_MM) z = Math.min(z, evalPiece(p, along));
    return z;
  };
  const crossings = zLevels => {
    const out = new Set();
    for (const p of pieces) {
      p.knots.forEach(k => out.add(k.a));
      for (let i = 0; i + 1 < p.knots.length; i++) {
        const k0 = p.knots[i], k1 = p.knots[i + 1];
        for (const lv of zLevels ?? []) {
          if (!Number.isFinite(lv) || (lv - k0.z) * (lv - k1.z) >= 0) continue; // 端が z に乗る場合は節で足済み
          out.add(k0.a + (k1.a - k0.a) * (lv - k0.z) / (k1.z - k0.z));
        }
      }
    }
    return [...out].sort((p, q) => p - q);
  };
  return { zAt, crossings, spans: pieces.map(p => [p.lo, p.hi]), junction: true, footCap: true };
}
