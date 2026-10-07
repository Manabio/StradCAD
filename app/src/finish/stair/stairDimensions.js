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

/**
 * stair の蹴上(mm)——明示指定（stair.riser）があればそれを優先し、無ければ設置階〜上階の階高
 * （floorHeightAbove）から総段数で割って求める（App.jsx・structural/structuralRecompute.js が
 * 共有する式に一本化したもの）。totalSteps<=0でも`Math.max(1, ...)`で0除算にならない。
 * 階高が未解決（最上階等）はnull。
 * `stairEntries.js`等の同型の式（`s.riser ?? (fh != null ? fh / Math.max(1, s.totalSteps) : null)`）は
 * 個別に残っており、このヘルパーへの移行は別件（未着手）。
 * @param {import('@core').Stair} stair
 * @param {object} project
 * @param {object} plane - stair の設置階のPlane
 * @returns {number|null}
 */
export function stairRiserOf(stair, project, plane) {
  return riserOf(stair, floorHeightAbove(project, plane));
}

/**
 * 蹴上(mm)の式の唯一の供給源: 明示指定（stair.riser）優先・無ければ階高/総段数。階高が未解決（null）で
 * 明示指定も無ければ null。stairRiserOf・stairLanding.js の landingZ・stairPartition.js が共有する。
 * @param {import('@core').Stair} stair
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {number|null}
 */
export function riserOf(stair, floorHeight) {
  return stair.riser ?? (floorHeight != null ? floorHeight / Math.max(1, stair.totalSteps) : null);
}

// 基準法上の寸法制限
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
