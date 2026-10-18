/**
 * 下屋の軒裏の910割付線（天伏の見上げ。詳細 LOD のみ・細線・グレー）の純モジュール。
 * plan/planSolids.js roofSolids が、見上げの上階の層だけ innerLines に足す（role 'eaveSoffitJoint'）。
 * 割付線は平面上で910ピッチ・軒（けらば）の辺に直交・屋根範囲（通り芯）の辺の端から数える。出隅の角の正方形
 * （辺の範囲の外）には引かない。出幅 0 の辺（屋内に接する部分）には引かない。切妻のけらば側も同じ規則（傾斜でも平面上910）。
 * store.js・snap.js・.jsx・react-konva を静的に import しない（node:test から単体で import できる）。
 */
import { CL_OVERLAP_TOL_MM } from '../../core/constants.js';

export const SOFFIT_JOINT_PITCH_MM = 910;

/**
 * 下屋1つ（leanToPlanRegions の region）の割付線。辺（region.edges の {isVertical, coord, lo, hi, outward, overhangMm}）ごとに、
 * lo + k·pitch（k=1,2,…。(lo+tol, hi−tol) の開区間のみ＝両端は引かない）の位置に、辺（coord）から outward 向きに出幅ぶんの線を置く。
 * edges が無い・空・非有限の辺は無視して [] を返す。
 * @param {object} region
 * @param {{pitchMm?:number, tolMm?:number}} [opts]
 * @returns {Array<{role:'eaveSoffitJoint', points:number[], closed:false}>}
 */
export function roofSoffitJointLines(region, { pitchMm = SOFFIT_JOINT_PITCH_MM, tolMm = CL_OVERLAP_TOL_MM } = {}) {
  const edges = region?.edges;
  if (!Array.isArray(edges) || !(pitchMm > 0)) return [];
  const out = [];
  for (const e of edges) {
    if (!e || ![e.coord, e.lo, e.hi, e.outward, e.overhangMm].every(Number.isFinite)) continue;
    if (!(e.overhangMm > tolMm) || (e.outward !== 1 && e.outward !== -1)) continue;
    const far = e.coord + e.outward * e.overhangMm;
    for (let k = 1; ; k++) {
      const t = e.lo + k * pitchMm;
      if (t >= e.hi - tolMm) break;
      out.push({ role: 'eaveSoffitJoint', points: e.isVertical ? [e.coord, t, far, t] : [t, e.coord, t, far], closed: false });
    }
  }
  return out;
}
