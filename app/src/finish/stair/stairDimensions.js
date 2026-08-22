/**
 * graph.plane の直上の採用フロアとの階高(mm)を返す。上階がなければ null。
 * @param {object} project
 * @param {object} plane - 基準となる設置階の Plane
 */
export function floorHeightAbove(project, plane) {
  if (!project || !plane) return null;
  const planes = project.planes; // elevation 昇順
  const idx = planes.findIndex(p => p.id === plane.id);
  if (idx < 0 || idx + 1 >= planes.length) return null;
  return planes[idx + 1].elevation - plane.elevation;
}

/**
 * graph.plane の直下の採用フロアとの階高(mm)を返す（floorHeightAboveの鏡像）。下階が無ければ null。
 * @param {object} project
 * @param {object} plane - 基準となる設置階の Plane
 */
export function floorHeightBelow(project, plane) {
  if (!project || !plane) return null;
  const planes = project.planes; // elevation 昇順
  const idx = planes.findIndex(p => p.id === plane.id);
  if (idx <= 0) return null;
  return plane.elevation - planes[idx - 1].elevation;
}

// 基準法上の寸法制限（問題.md より）
export const STAIR_LIMITS = {
  residential:    { minWidth: 750, maxRiser: 230, minTread: 150 }, // 住宅
  nonResidential: { ratioMin: 600, ratioMax: 640 },                // 住宅以外: 2R+T
};

/**
 * 階段の寸法を確定し、基準法チェック結果を返す。
 * @param {import('@core').Stair} stair
 * @param {{ floorHeight:number|null, isResidential?:boolean }} ctx
 *   floorHeight … 設置階〜上階の階高(mm)。null なら蹴上は未確定(null)。
 * @returns {{ riser:number|null, tread:number, totalSteps:number, runLengthNeeded:number, warnings:string[] }}
 */
export function computeStairDimensions(stair, { floorHeight, isResidential = true }) {
  const totalSteps = Math.max(1, stair.totalSteps);
  // 蹴上 = 階高 / 総段数（totalSteps = 総蹴上数。上階到達の1段も蹴上を持つ。明示指定があればそれを優先）
  const riser = stair.riser ?? (floorHeight != null ? floorHeight / totalSteps : null);
  const tread = stair.tread;

  const warnings = [];
  if (isResidential) {
    const L = STAIR_LIMITS.residential;
    if (stair.width < L.minWidth)            warnings.push(`階段幅 ${stair.width}mm < ${L.minWidth}mm`);
    if (riser != null && riser > L.maxRiser) warnings.push(`蹴上 ${Math.round(riser)}mm > ${L.maxRiser}mm`);
    if (tread < L.minTread)                  warnings.push(`踏面 ${tread}mm < ${L.minTread}mm`);
  } else {
    const L = STAIR_LIMITS.nonResidential;
    if (riser != null) {
      const v = 2 * riser + tread;
      if (v < L.ratioMin || v > L.ratioMax)  warnings.push(`2×蹴上+踏面 ${Math.round(v)}mm が ${L.ratioMin}〜${L.ratioMax}mm の範囲外`);
    }
  }

  // 踊り場の長さは stairGeometry.js の固定式（4踏面 or 1200mm の大きい方）で常に基準法（≥1200mm）を満たす。

  return {
    riser,
    tread,
    totalSteps,
    runLengthNeeded: tread * Math.max(1, totalSteps - 1), // 平面上の走行長(概算)＝踏面寸×総マス数。実描画はフェーズ5で確定
    warnings,
  };
}
