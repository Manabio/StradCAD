/**
 * 段差断面レイヤ（renderer/StepSectionLayer.jsx）が描く断面線3線分（finish/stepSection.js
 * `computeStepSections`の`section.profileSegs`＝上段床→蹴上げ→下段床のZ字）の2つの角に、
 * renderer/figureLineJoin.js（L字の角の外角を閉じる。案2・第1弾）と同じ規則を適用する
 * 純関数（第6弾。react-konva/store.js/appViewport非依存）。設計意図は
 * .claude/elevation-model.md「L字の角の外角を閉じる」節を参照。
 *
 * 断面線3本は`strokeWidth={profileStroke}`の1本の太さ（`weights.thick / viewport.scaleX`）で
 * 描かれ、StepSectionLayer.jsxの<Line>は`strokeScaleEnabled`未指定（既定true。Konvaの親Group
 * のscaleX/scaleYを継承）——渡すstrokeWidthは世界mm相当値であり実スクリーンpxではない。
 * その往復（実px化→join解決→世界mm相当へ戻す）はrenderer/planLineJoin.jsの
 * `resolvePlanLinePointsMmScaledStroke`（第6弾で新設）へ委譲する。
 *
 * L字結合はセクション単位で解決する（finish/stair/stairLineJoinPrimitives.jsのエントリ単位・
 * structural/columnWrapLineJoin.jsの柱単位解決と同じ考え方）——複数の段差断面セクションが
 * あっても、他セクションの端点とは一切マージしない（呼び出し側が1セクションずつ本関数を呼ぶ）。
 *
 * 段差線（s.stepLine）・ハッチ・寸法・引出線は本関数の対象外（呼び出し側が別途そのまま描く）。
 */
import { resolvePlanLinePointsMmScaledStroke } from '../renderer/planLineJoin.js';

/** 断面線1本ぶんのLine key（section.id + セグメントindex）。 */
export function stepSectionProfileKey(sectionId, i) {
  return `${sectionId}:profile:${i}`;
}

/**
 * 段差断面1セクションぶんの断面線3本の最終描画props（points・strokeWidth）を解決する。
 * StepSectionLayer.jsxは本関数の返り値を`.map(p => <Line key={p.key}
 * points={p.points} strokeWidth={p.strokeWidth} .../>)`へそのまま渡すだけにする——
 * 太さの判断（`weights.thick / viewport.scaleX`）・L字結合の両方をこちらへ寄せ、
 * .jsx側に配線の余地を残さない。
 *
 * @param {{id:string, profileSegs:{x1:number,y1:number,x2:number,y2:number}[]}} section
 *   - finish/stepSection.js `computeStepSections`が返す1件（idと`profileSegs`のみ参照）
 * @param {{worldToScreen, screenToWorld, scaleX:number}} viewportLike
 * @param {{thick?:number}} [lineWeightsPx] - viewport.lineWeightsPx相当。省略・thick欠落時は
 *   既定1pxにフォールバックする（renderer/figureLineJoin.jsのweightPx既定と同じ規約）。
 * @returns {{key:string, points:[number,number,number,number], strokeWidth:number}[]}
 *   strokeWidthは世界mm相当値（`profileStroke`と同じ規約。Konva親Groupのscale継承前提）
 */
export function stepSectionProfileRenderProps(section, viewportLike, lineWeightsPx) {
  const segs = section?.profileSegs ?? [];
  if (segs.length === 0) return [];

  const thickPx = lineWeightsPx?.thick ?? 1;
  const strokeWidth = thickPx / viewportLike.scaleX; // 世界mm相当（Group拡縮継承前提）

  const prims = segs.map((seg, i) => ({
    key: stepSectionProfileKey(section.id, i),
    x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
    width: strokeWidth,
  }));
  const joined = resolvePlanLinePointsMmScaledStroke(prims, viewportLike);

  return prims.map(p => {
    const j = joined.get(p.key);
    return { key: p.key, points: j.points, strokeWidth: j.width };
  });
}
