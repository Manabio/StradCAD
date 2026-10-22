/**
 * 天伏（見上げ）の下がり梁（天井より低い梁。ceilingCutHeight.js の droppedBeams）の外形を中線にする後処理（純モジュール。解決器は触らない）。
 * ユーザー裁定 2026-10-22: 天井より低い梁の外形だけを中線で描く（見え掛かりのエッジ扱い）。天井の縁など他の見え掛かりの線は今の太さのまま。
 * 対象は自階の層（layerFloorZ が 0・省略）の梁の見え掛かり（cls 'below'）の線。cut の線・他の立体・上階の層の梁には付けない。
 * 前例: plan/planOpeningEdges.js markOpeningEdges（穴の縁の中線）。
 */

/** 下がり梁の外形の線の重み（viewport.lineWeightsPx のキー。穴の縁と同じ重み）。 */
export const DROPPED_BEAM_WEIGHT = 'medium';

/**
 * @param {import('../plan/planSectionFigure.js').Primitive[]} prims
 * @param {Iterable<string>} beamIds 下がり梁の id（ceilingCutResolverOf の droppedBeams[].beamId）
 * @returns {import('../plan/planSectionFigure.js').Primitive[]} 対象の線だけ weight を DROPPED_BEAM_WEIGHT にし droppedBeam:true を付けた新しい配列（入力は変更しない）。対象が無ければ入力のまま
 */
export function markDroppedBeamLines(prims, beamIds) {
  const ids = new Set(beamIds ?? []);
  if (!Array.isArray(prims) || ids.size === 0) return prims;
  return prims.map(p => (p?.kind === 'line' && p.cls === 'below' && p.source?.kind === 'beam' && ids.has(p.source.id) && (p.source.layerFloorZ ?? 0) === 0
    ? { ...p, weight: DROPPED_BEAM_WEIGHT, droppedBeam: true }
    : p));
}
