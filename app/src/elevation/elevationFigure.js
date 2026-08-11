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
import { openingsOnFace, faceBoundaryLocalX } from './elevationFaces.js';
import { effectiveHeight, openingTagPartsOf } from '../openings/openingNumbering.js';
import {
  ElevationLineRole, weightForRole,
  WALL_LABEL_GAP_MM, WALL_LABEL_LINE_GAP_MM,
  OPENING_TAG_RADIUS_PX, DIM_ROW_GAP_MM, GRID_ROW_GAP_MM, GRID_TAG_RADIUS_PX, GRID_TAG_FONT_PX,
  FACE_LABEL_GAP_MM, FACE_LABEL_FONT_PX,
} from './elevationStyle.js';

// 通り芯丸番号・寸法行・面ラベルのy（床線y=0からの下方向オフセット）。ユーザー仕様の段構成
// 「③水平寸法線・寸法値 → ④通り芯丸」どおり、通り芯丸は寸法行(ROW2)とは別の3段目に分離する
// （QA G4: 以前はROW2に同居させていたが仕様は別段を明記している）。面ラベル(A/B/C/D)はさらに
// その下の4段目（項目7。部屋名引出線より上のバランスの良い段、という指示にもとづく判断）。
// ROW1=壁芯間寸法（面ごとに1本）、ROW2=通り芯間寸法、GRID_CIRCLE_ROW=通り芯丸番号、
// FACE_LABEL_ROW=面ラベル。
const DIM_ROW1_Y = DIM_ROW_GAP_MM;
const DIM_ROW2_Y = DIM_ROW_GAP_MM + GRID_ROW_GAP_MM;
const GRID_CIRCLE_ROW_Y = DIM_ROW2_Y + GRID_ROW_GAP_MM;
const FACE_LABEL_ROW_Y = GRID_CIRCLE_ROW_Y + FACE_LABEL_GAP_MM;

/**
 * 巾木文字列（自由入力。RoomFinish.baseboardHeight）から高さ(mm)を解釈する。
 * "h=60"/"H=60mm" 等の "h=<数値>" 表記のみを対象とする——巾木は自由入力文字列のままで構わず
 * （既存構造は変えない）、展開側は解釈できた場合だけ巾木線を足す（解釈不能なら非描画。ユーザー仕様）。
 * @param {string} str
 * @returns {number|null}
 */
export function parseBaseboardHeightMm(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/h\s*=\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

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
  const openings = openingsOnFace(face, graph);
  for (const o of openings) {
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

  // 巾木（h=<mm>と解釈できた場合のみ。床まで達する開口の区間は途切れさせる）
  const baseboardH = parseBaseboardHeightMm(room.finish?.baseboardHeight);
  if (baseboardH != null && baseboardH < CH) {
    const floorGaps = openings
      .filter(o => (o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0) === 0)
      .map(o => {
        const localX = localXOf(face, o.centerCoord);
        return [Math.max(0, localX - o.width / 2), Math.min(run, localX + o.width / 2)];
      })
      .sort((a, b) => a[0] - b[0]);
    const y = -baseboardH;
    let cursor = 0;
    for (const [gLo, gHi] of floorGaps) {
      if (gLo > cursor) prims.push({ type: 'line', x1: cursor, y1: y, x2: gLo, y2: y, weight: detailWeight });
      cursor = Math.max(cursor, gHi);
    }
    if (cursor < run) prims.push({ type: 'line', x1: cursor, y1: y, x2: run, y2: y, weight: detailWeight });
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

  // 壁芯間寸法（面の両端＝壁中心線。ROW1）。項目2・6: 寸法線足(dim.foot)は廃止し、代わりに
  // 壁中心線自体（一点鎖線）を寸法線の位置まで下ろし、交点に塗り丸(dim.dot)を置く。
  const boundary = faceBoundaryLocalX(face, graph);
  prims.push({ type: 'line', x1: boundary.lo, y1: 0, x2: boundary.lo, y2: DIM_ROW1_Y, dash: 'center', weight: detailWeight });
  prims.push({ type: 'line', x1: boundary.hi, y1: 0, x2: boundary.hi, y2: DIM_ROW1_Y, dash: 'center', weight: detailWeight });
  prims.push({
    type: 'dim', dir: 'h', at: DIM_ROW1_Y, from: boundary.lo, to: boundary.hi, dot: true,
    label: Math.round(boundary.hi - boundary.lo),
  });

  // 通り芯間寸法（面を貫く通り芯同士。ROW2）。項目2・6: こちらも足は出さない。通り芯自体の
  // 一点鎖線（下のGRID_CIRCLE_ROW_Yまで伸びる縦線）が寸法線位置(DIM_ROW2_Y)を通過するため、
  // その交点に塗り丸(dim.dot)を置くだけでよい。
  const gridPoints = gridCLsOnFace(face, gridCLs ?? [])
    .map(cl => ({ x: localXOf(face, cl.effectiveValue), label: cl.label }))
    .sort((a, b) => a.x - b.x);

  for (let i = 0; i + 1 < gridPoints.length; i++) {
    prims.push({
      type: 'dim', dir: 'h', at: DIM_ROW2_Y, from: gridPoints[i].x, to: gridPoints[i + 1].x, dot: true,
      label: Math.round(gridPoints[i + 1].x - gridPoints[i].x),
    });
  }
  // 通り芯縦一点鎖線＋丸番号（ROW2のさらに下＝GRID_CIRCLE_ROW_Y。QA G4: 寸法行とは別の段）
  for (const g of gridPoints) {
    prims.push({ type: 'line', x1: g.x, y1: 0, x2: g.x, y2: GRID_CIRCLE_ROW_Y, dash: 'center', weight: detailWeight });
    prims.push({ type: 'circle', cx: g.x, cy: GRID_CIRCLE_ROW_Y, rPx: GRID_TAG_RADIUS_PX });
    prims.push({
      type: 'text', x: g.x, y: GRID_CIRCLE_ROW_Y, text: g.label,
      anchor: 'middle', baseline: 'middle', size: GRID_TAG_FONT_PX,
    });
  }

  // 面ラベル（A/B/C/D。L字はB1等）を面の幅中心・通り芯丸のさらに下の段に描く（項目7）。
  // QA F3: run/2（仕上げ面基準の中心）ではなく、壁芯間寸法（項目2・9）と同じ壁中心線で挟んだ
  // 幅の中心(boundary.lo/hiの中点)を使う——面ラベルの中心が壁芯間寸法の中心とズレないように。
  prims.push({
    type: 'text', x: (boundary.lo + boundary.hi) / 2, y: FACE_LABEL_ROW_Y, text: face.label,
    anchor: 'middle', baseline: 'middle', size: FACE_LABEL_FONT_PX,
  });

  return prims;
}
