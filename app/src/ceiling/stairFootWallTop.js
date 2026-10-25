/**
 * 階段の足元の中の壁の天端（純モジュール。store.js・snap.js・.jsx を静的に引かない）。
 * 平面の立体（plan/planSolids.js）と展開図の両方から使う中立の置き場。planSolids.js から出力不変で移した
 * （S10-8 ステップ1）。供給源は階段の裏面（stairSoffit.js stairUndersideSurface）。
 */
import { RoomKind } from '@core';
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
    const { surface } = f;
    for (const a of [lo, mid, hi]) {
      for (const b of [cr.lo, (cr.lo + cr.hi) / 2, cr.hi]) {
        const z = surface.zAt ? (wall.isVertical ? surface.zAt(b, a) : surface.zAt(a, b)) : surface.zLo;
        if (Number.isFinite(z)) top = Math.min(top, z);
      }
    }
  }
  // 1e-6 mm に量子化する（補間の float 誤差で、同じ芯の下地の壁と仕上げの薄壁が別の高さになり mergeTouchingWalls で割れるのを防ぐ）
  return Number.isFinite(top) ? Math.round(top * 1e6) / 1e6 : top;
}
