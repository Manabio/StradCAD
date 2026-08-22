/**
 * 2.5D断面エンジン: faceFromCut（SectionCut → 既存face記述子と同型のオブジェクト。WP-E2）。
 * 設計意図はarchitect承認済みの実装指示書§3.5参照。WP-E5bの階段帯統合ではswitchbackCuts.js
 * がclassifyFaces由来のface記述子をそのまま使う設計を採ったため（同ファイル冒頭コメント参照）、
 * faceFromCut自体は現時点で未使用のまま（sectionEngine.jsのbuildSectionFigureからのみ呼ばれる。
 * 通常部屋帯・吹抜け帯からは未使用）。
 *
 * buildFaceFigure（elevationFigure.js）へそのまま渡せる形（letter/dirSign/isVertical/axisCL/
 * inward/faceValue/hasRealWall/lo/hi/run/originWorld/startCLId/endCLId/
 * hasWallAtLocal0・hasWallAtLocalRun・edgeAtLocal0・edgeAtLocalRun）にする——役割分担（§3.4）
 * どおり、床線・天井線・端縦線・注記帯等はbuildFaceFigure側の責務のまま。
 */
import { perpFaceAt, perpWallCrossesFacePlane } from '../elevationFaces.js';

/**
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {object[]} wallFaces - 主対象壁の解決・両端の隅スナップに使う既存face配列
 *   （composeRoomFaces等の結果。§3.5「facesはこちらの用途に引き続き使用」）
 * @param {import('@core').Wall|null} primaryWall - レイキャストで最も広く見えた壁（呼び出し側で
 *   既に解決済みのものを渡す。無ければnull=切断線位置に最も近いCLへフォールバック）
 * @returns {{letter:string|null, dirSign:1|-1, isVertical:boolean, axisCL:object,
 *   inward:1|-1, faceValue:number, hasRealWall:boolean, lo:number, hi:number, run:number,
 *   originWorld:number, startCLId:string|null, endCLId:string|null,
 *   hasWallAtLocal0:boolean, hasWallAtLocalRun:boolean, edgeAtLocal0:boolean,
 *   edgeAtLocalRun:boolean, kind:'section'}}
 */
export function faceFromCut(cut, wallFaces, primaryWall) {
  const { line, dirSign } = cut;
  const isVertical = line.isVertical;
  const inward = cut.viewSign;

  let axisCL, faceValue, hasRealWall;
  if (primaryWall) {
    axisCL = primaryWall.axisCL;
    faceValue = primaryWall.axisValue ?? (primaryWall.axisCL.effectiveValue + primaryWall.axisOffset);
    hasRealWall = true;
  } else {
    // 主対象壁なし: 切断線と同じ向き(isVertical一致)のwallFacesのうち、axisCL.valueが
    // line.axisValueに最も近いものへフォールバック（findRunCLAt相当。§3.5）。
    // wallFacesが空・該当なしの場合はCL芯（line.axisValueそのもの）へさらにフォールバックする
    // （innerWallFaceAtのnullフォールバックと同じ規約。ASSUMED: graphを持たないためgraph直接
    // 問い合わせ版のfindRunCLAtは使えず、渡されたwallFaces集合の中から探す）。
    let best = null, bestDist = Infinity;
    for (const f of wallFaces ?? []) {
      if (f.kind === 'step') continue;
      if (f.isVertical !== isVertical) continue;
      const v = f.axisCL?.effectiveValue;
      if (v == null) continue;
      const dist = Math.abs(v - line.axisValue);
      if (dist < bestDist) { bestDist = dist; best = f; }
    }
    axisCL = best?.axisCL ?? { id: null, effectiveValue: line.axisValue };
    faceValue = line.axisValue;
    hasRealWall = false;
  }

  // 両端の直交壁面（perpFaceAt）へスナップ。line.lo側・line.hi側それぞれ独立に探す。
  const loFace = perpFaceAt(wallFaces ?? [], isVertical, line.axisValue, line.lo);
  const hiFace = perpFaceAt(wallFaces ?? [], isVertical, line.axisValue, line.hi);
  const rawLo = loFace ? loFace.faceValue : line.lo;
  const rawHi = hiFace ? hiFace.faceValue : line.hi;
  // 修正済み仕様と同じレシピ（elevation-model.md「修正済み」節）: loWorld/hiWorldの大小関係に
  // 関わらずMath.min/maxで正規化し、対応するCLIdも入れ替える（travelSign<0でrun>0になるバグ修正込み）。
  const swapped = rawLo > rawHi;
  const lo = Math.min(rawLo, rawHi), hi = Math.max(rawLo, rawHi);
  const startCLId = (swapped ? hiFace : loFace)?.axisCL?.id ?? null;
  const endCLId   = (swapped ? loFace : hiFace)?.axisCL?.id ?? null;

  const run = hi - lo;
  const originWorld = dirSign > 0 ? lo : hi;

  const faceSoFar = { faceValue, inward };
  const startFace = swapped ? hiFace : loFace;
  const endFace   = swapped ? loFace : hiFace;
  const realAtLo = !!startFace && (startFace.hasRealWall ?? true);
  const realAtHi = !!endFace   && (endFace.hasRealWall   ?? true);
  const hasWallAtLo = realAtLo && perpWallCrossesFacePlane(startFace, faceSoFar);
  const hasWallAtHi = realAtHi && perpWallCrossesFacePlane(endFace, faceSoFar);
  const edgeAtLo = realAtLo && !hasWallAtLo;
  const edgeAtHi = realAtHi && !hasWallAtHi;

  return {
    letter: primaryWall?.letter ?? null, dirSign, isVertical, axisCL, inward, faceValue, hasRealWall,
    lo, hi, run, originWorld, startCLId, endCLId,
    hasWallAtLocal0:   dirSign > 0 ? hasWallAtLo : hasWallAtHi,
    hasWallAtLocalRun: dirSign > 0 ? hasWallAtHi : hasWallAtLo,
    edgeAtLocal0:      dirSign > 0 ? edgeAtLo : edgeAtHi,
    edgeAtLocalRun:    dirSign > 0 ? edgeAtHi : edgeAtLo,
    kind: 'section',
  };
}
