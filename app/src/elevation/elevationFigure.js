/**
 * 展開図: 壁面1枚（buildRoomFaces の1件）→ 描画プリミティブ配列。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * ローカル座標: x∈[0, face.run]（面の左端=0）、y は上向き負（床=0、天井=-天井高さ）。
 *
 * プリミティブ語彙は既存の「図」語彙（structural/sectionFigure/sectionGeometry.js ヘッダ参照。
 * line/rect/text等）をそのまま使う。唯一の追加として、建具記号丸（円＋直径横線＋上下2段
 * テキスト。renderer/OpeningTagLayer.jsx と同じスクリーン固定pxサイズの合成記号）だけは
 * 個別プリミティブへ分解せず `tag` という1つの合成プリミティブにまとめている
 * （設計からの意図的な逸脱。line/textをmm座標のまま分解すると、展開図ごとに異なる縮尺の
 * もとで記号の見た目サイズが一定にならない——rPx指定はスクリーン固定pxのためmm換算した
 * 直径線・行間を別プリミティブとして正しく追従させられない。figurePrimitivesKonva.jsx が
 * OpeningTagLayer.jsx と同じ構成でGroup描画する）。
 */
import { CenterLineType, OpeningCategory } from '@core';
import { openingsOnFace } from './elevationFaces.js';
import { effectiveHeight, openingTagPartsOf } from '../openings/openingNumbering.js';
import {
  ElevationLineRole, weightForRole,
  WALL_LABEL_GAP_MM, WALL_LABEL_LINE_GAP_MM,
  OPENING_TAG_RADIUS_PX, GRID_TAG_DROP_MM, GRID_TAG_RADIUS_PX, GRID_TAG_FONT_PX,
} from './elevationStyle.js';

function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/** face のローカルx座標（世界座標→面基準の変換。openingsOnFace等の結果に対して使う）。 */
export function localXOf(face, worldCoord) {
  return (worldCoord - face.originWorld) * face.dirSign;
}

/**
 * face 上のアキ（腰壁＋垂れ壁の同時指定でできる四角い穴）の矩形一覧（ローカル座標）。
 * graph.kneeDropWalls（finish/kneeDropWall.js）を面のaxisCLで絞り込み、区間をface.lo..hiへ
 * クランプしてローカル矩形へ変換する。
 * @returns {Array<{x:number, y:number, w:number, h:number}>}
 */
export function kneeDropGapsOnFace(face, graph, ceilingHeightMm) {
  const out = [];
  for (const [key, rec] of graph.kneeDropWalls) {
    if (!rec.knee || !rec.drop) continue; // アキ＝腰壁・垂れ壁の同時指定のみ
    const [axisCLId, startCLId, endCLId] = key.split(':');
    if (axisCLId !== face.axisCL.id) continue;
    const startCL = getShape(graph, startCLId);
    const endCL   = getShape(graph, endCLId);
    if (!startCL || !endCL) continue;

    const lo = Math.min(startCL.value, endCL.value);
    const hi = Math.max(startCL.value, endCL.value);
    if (hi <= face.lo || lo >= face.hi) continue; // faceと重ならない
    const clampedLo = Math.max(lo, face.lo);
    const clampedHi = Math.min(hi, face.hi);

    const localA = localXOf(face, clampedLo);
    const localB = localXOf(face, clampedHi);
    const x = Math.min(localA, localB);
    const w = Math.abs(localB - localA);
    const y = -(ceilingHeightMm - rec.drop.bottomHeight);
    const h = (ceilingHeightMm - rec.drop.bottomHeight) - rec.knee.topHeight;
    if (w <= 0 || h <= 0) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

/**
 * face に直交するグリッド通り芯（labeled struct CL）を face.lo..hi の範囲で返す。
 * gridCLs は通常 elevation/elevationPrimitives.js の collectGridCLs が RADIAL を除外して
 * 渡すが、ここでも明示的に除外する（RADIALのcenterLineType='R'は'X'(VERTICAL)とも
 * 'Y'(HORIZONTAL)とも一致しないため、除外しないと `(cl.centerLineType===VERTICAL)===wantVertical`
 * の真偽値比較がisVertical=trueの面(B/D。wantVertical=false)側でtrueになり、
 * 放射CLのeffectiveValue（角度deg）がたまたまface.lo..hiに収まると偽の通り芯として
 * 描かれてしまう。QA F6対応）。
 */
function gridCLsOnFace(face, gridCLs) {
  // isVertical=falseの面(A/C)は面軸に直交する垂直CL、isVertical=trueの面(B/D)は水平CLを表示する。
  const wantVertical = !face.isVertical;
  return gridCLs.filter(cl =>
    cl.centerLineType !== CenterLineType.RADIAL &&
    (cl.centerLineType === CenterLineType.VERTICAL) === wantVertical &&
    cl.effectiveValue >= face.lo && cl.effectiveValue <= face.hi);
}

/**
 * 壁面1枚 → プリミティブ配列。
 * @param {object} face - buildRoomFaces の1件
 * @param {{graph:object, project:object, room:import('@core').Room, ceilingHeight:number,
 *   materialMap:Map|null, gridCLs:object[]}} ctx
 * @returns {object[]}
 */
export function buildFaceFigure(face, ctx) {
  const { graph, project, room, ceilingHeight: CH, materialMap, gridCLs } = ctx;
  const run = face.run;
  const prims = [];

  // 床線・天井線・両端縦線（切断面＝太）
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  prims.push({ type: 'line', x1: 0,   y1: 0,   x2: run, y2: 0,   weight: cutWeight });
  prims.push({ type: 'line', x1: 0,   y1: -CH, x2: run, y2: -CH, weight: cutWeight });
  prims.push({ type: 'line', x1: 0,   y1: -CH, x2: 0,   y2: 0,   weight: cutWeight });
  prims.push({ type: 'line', x1: run, y1: -CH, x2: run, y2: 0,   weight: cutWeight });

  // アキ（腰壁＋垂れ壁の同時指定でできる四角い穴）
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const detailWeight     = weightForRole(ElevationLineRole.DETAIL);
  for (const gap of kneeDropGapsOnFace(face, graph, CH)) {
    prims.push({ type: 'rect', x: gap.x, y: gap.y, w: gap.w, h: gap.h, weight: silhouetteWeight });
    prims.push({ type: 'line', x1: gap.x,         y1: gap.y,         x2: gap.x + gap.w, y2: gap.y + gap.h, dash: 'center', weight: detailWeight });
    prims.push({ type: 'line', x1: gap.x + gap.w, y1: gap.y,         x2: gap.x,         y2: gap.y + gap.h, dash: 'center', weight: detailWeight });
    prims.push({ type: 'text', x: gap.x + gap.w / 2, y: gap.y + gap.h / 2, text: 'ア キ', anchor: 'middle', baseline: 'middle' });
  }

  // 開口（内法矩形＋記号丸）
  for (const o of openingsOnFace(face, graph)) {
    const localX = localXOf(face, o.centerCoord);
    const h = effectiveHeight(o);
    const sill = o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0;
    const x = localX - o.width / 2;
    const y = -(sill + h);
    prims.push({ type: 'rect', x, y, w: o.width, h, weight: silhouetteWeight });

    const { symbol, number } = openingTagPartsOf(o, project);
    prims.push({
      type: 'tag', cx: localX, cy: y + h / 2, rPx: OPENING_TAG_RADIUS_PX,
      top: symbol, bottom: number ?? '',
    });
  }

  // 「壁：<壁材>」「<壁仕上げ材>」2段書き（材が引けない行は描かない）
  const info = room.getFinishInfo();
  const wallMaterialName = materialMap?.get(info.wallMaterial)?.name ?? null;
  const wallFinishName   = materialMap?.get(info.wallFinish)?.name ?? null;
  let labelY = -CH - WALL_LABEL_GAP_MM;
  if (wallMaterialName) {
    prims.push({ type: 'text', x: 0, y: labelY, text: `壁：${wallMaterialName}`, anchor: 'start' });
    labelY -= WALL_LABEL_LINE_GAP_MM;
  }
  if (wallFinishName) {
    prims.push({ type: 'text', x: 0, y: labelY, text: wallFinishName, anchor: 'start' });
  }

  // 通り芯縦一点鎖線＋丸番号（図の下側）
  for (const cl of gridCLsOnFace(face, gridCLs ?? [])) {
    const localX = localXOf(face, cl.effectiveValue);
    prims.push({ type: 'line', x1: localX, y1: 0, x2: localX, y2: GRID_TAG_DROP_MM, dash: 'center', weight: detailWeight });
    prims.push({ type: 'circle', cx: localX, cy: GRID_TAG_DROP_MM, rPx: GRID_TAG_RADIUS_PX });
    prims.push({
      type: 'text', x: localX, y: GRID_TAG_DROP_MM, text: cl.label,
      anchor: 'middle', baseline: 'middle', size: GRID_TAG_FONT_PX,
    });
  }

  return prims;
}
