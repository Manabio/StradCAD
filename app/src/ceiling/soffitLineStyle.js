/**
 * 天伏（見上げ）で見える直上階の下屋の軒先・けらばの外形線を中線にする（純モジュール。react・store.js・snap.js・.jsx・
 * graphDerived を静的に引かない）。見上げでは直上階の下屋の軒裏が見え、その外形線は軒先線として中線で描く（ユーザー指示 2026-10-18）。
 * 解決器（planSectionFigure）は触らず、出力の prim に weight を付け替える（markSameHeightCeilingBoundaries・markOpeningEdges と同じ後処理）。
 * 対象は source.kind === 'roof' かつ source.role === 'outline' で、上階の層（layerFloorZ > 0）の線だけ。
 * 自階の層の下屋・hip/ridge/valley・見下げは対象外。
 * 軒裏の910割付線（role 'eaveSoffitJoint'）は detailOnly:true・style:'eaveSoffitJoint'（weight は細線のまま）にする。
 */

/** 軒先線の線の太さ（穴の縁 plan/planOpeningEdges.js OPENING_EDGE_WEIGHT と同じ中線。意味が違うので別の定数に持つ）。 */
export const EAVE_OUTLINE_WEIGHT = 'medium';

/** 軒裏の910割付線の role（finish/roof/roofSoffitJoints.js が付ける）と、印付け後の prim.style（renderer がグレーにする）。 */
export const SOFFIT_JOINT_ROLE = 'eaveSoffitJoint';
export const SOFFIT_JOINT_STYLE = 'eaveSoffitJoint';

/**
 * 見上げの出力のうち、上階の層の下屋の外形線だけ weight を中線にする。入力の配列・prim は変更しない（変えた prim は新しいオブジェクト）。
 * prims が配列でなければそのまま返す。source の無い prim は触らない。
 * @param {import('../plan/planSectionFigure.js').Primitive[]} prims
 * @returns {import('../plan/planSectionFigure.js').Primitive[]}
 */
export function markEaveOutlineLines(prims) {
  if (!Array.isArray(prims)) return prims;
  return prims.map(p => {
    if (p?.kind !== 'line' || p.source?.kind !== 'roof') return p;
    if (p.source.role === 'outline' && (p.source.layerFloorZ ?? 0) > 0) return { ...p, weight: EAVE_OUTLINE_WEIGHT };
    // 910割付線（roofSolids が見上げの上階の層だけに作る）。詳細 LOD のみ・細線のまま・グレー（style で renderer が色を決める）
    if (p.source.role === SOFFIT_JOINT_ROLE) return { ...p, detailOnly: true, style: SOFFIT_JOINT_STYLE };
    return p;
  });
}
