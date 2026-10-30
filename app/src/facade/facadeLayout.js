/**
 * 立面図（外壁立面4面）の倍率とレイアウト。縦の積み・スクロール・mm→px 変換は展開図（elevation/elevationLayout.js）を
 * そのまま使い（layoutBands の roomId に面の向きを入れる）、横は各面を画面の中央に揃える。
 *
 * 倍率は「どの1面も横にも縦にも見切れない最大の建築標準スケール」で4面同一（sectionGeometry.js chooseScale）。
 */
import { chooseScale } from '../structural/sectionFigure/sectionGeometry.js';
import { layoutBands, bandContentOriginMm } from '../elevation/elevationLayout.js';
import { FACE_LABEL_FONT_PX } from '../elevation/elevationStyle.js';
import { FACADE_GL_EXTEND_SCREEN_MM, FACADE_TITLE_GAP_SCREEN_MM } from './facadeStyle.js';

export {
  screenMmToModelMm, clampScrollY, visibleBandPlacements, makeElevationTransform,
} from '../elevation/elevationLayout.js';

/**
 * 4面同一の倍率（px/mm）。建物の最大幅・最大高さ（facadeExtentsMm）に、注記の分（左右の GL の延長、
 * 上の見出しの離れ＋文字の高さ）を画面 px で差し引いた枠へ収める。
 * @param {{maxWidthMm:number, maxHeightMm:number, viewWidthPx:number, viewHeightPx:number, screenPxPerMm:number}} p
 * @returns {number}
 */
export function chooseFacadeScale({ maxWidthMm, maxHeightMm, viewWidthPx, viewHeightPx, screenPxPerMm }) {
  const pxPerMm = screenPxPerMm > 0 ? screenPxPerMm : 1;
  const annotWidthPx = 2 * FACADE_GL_EXTEND_SCREEN_MM * pxPerMm;
  const annotHeightPx = FACADE_TITLE_GAP_SCREEN_MM * pxPerMm + FACE_LABEL_FONT_PX;
  return chooseScale(maxWidthMm, maxHeightMm, viewWidthPx - annotWidthPx, viewHeightPx - annotHeightPx);
}

/**
 * 面を上から順に縦へ積む（layoutBands。面の間は gapMm＝モデルmm）。各面の originXMm/originYMm は、
 * その面のプリミティブ座標の原点が画面mm（描画エリア左上原点・スクロール前）のどこに来るか。
 * 横は面の bounds の中心を画面の中央に揃える。
 * @param {Array<{direction:string, bounds:{minX:number,minY:number,maxX:number,maxY:number}}>} faces - buildFacadeModel の返り値
 * @param {{scale:number, viewWidthPx:number, gapMm?:number}} opts
 * @returns {{layout:ReturnType<typeof layoutBands>, contentHeightMm:number,
 *   placements:Array<{direction:string, topMm:number, heightMm:number, originXMm:number, originYMm:number}>}}
 */
export function layoutFacadeFaces(faces, { scale, viewWidthPx, gapMm }) {
  const bands = faces.map(f => ({ roomId: f.direction, heightMm: f.bounds.maxY - f.bounds.minY }));
  const layout = layoutBands(bands, gapMm);
  const viewWidthMm = scale > 0 ? viewWidthPx / scale : 0;
  const placements = layout.placements.map((p, i) => {
    const f = faces[i];
    return {
      direction: f.direction,
      topMm: p.topMm,
      heightMm: p.heightMm,
      originXMm: viewWidthMm / 2 - (f.bounds.minX + f.bounds.maxX) / 2,
      originYMm: bandContentOriginMm(p, f),
    };
  });
  return { layout, contentHeightMm: layout.contentHeightMm, placements };
}
