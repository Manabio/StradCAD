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
  // 蹴上 = 階高 / 段数（明示指定があればそれを優先）
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

  // 踊り場の長さ ≥ 1200mm（段構成を持つタイプ）
  if (stair.segments) {
    const landingLen = (stair.segments.landing ?? 0) * tread;
    if (landingLen > 0 && landingLen < 1200) warnings.push(`踊り場長 ${Math.round(landingLen)}mm < 1200mm`);
  }

  return {
    riser,
    tread,
    totalSteps,
    runLengthNeeded: tread * totalSteps, // 平面上の走行長(概算)。実描画段数はフェーズ5で確定
    warnings,
  };
}
