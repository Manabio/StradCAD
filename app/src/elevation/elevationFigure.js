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
import { findCatalogEntry } from '../openings/openingCatalog.js';
import { buildOpeningElevation } from '../openings/openingElevationFigure.js';
import { translatePrimitive } from './elevationPrimitives.js';
import {
  ElevationLineRole, weightForRole,
  WALL_LABEL_GAP_MM, WALL_LABEL_LINE_GAP_MM,
  OPENING_TAG_RADIUS_PX, GRID_TAG_RADIUS_PX, GRID_TAG_FONT_PX,
  FACE_LABEL_FONT_PX, GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
  DEFAULT_OPENING_TAG_ROW_MM, DEFAULT_DIM_ROW_GAP_MM, DEFAULT_GRID_ROW_GAP_MM,
} from './elevationStyle.js';

// ROW1=壁芯間寸法（面ごとに1本）、ROW2=通り芯間寸法、GRID_CIRCLE_ROW=通り芯丸番号＋面ラベル、
// OPENING_TAG_ROW=建具記号丸。ユーザー仕様の段構成「③水平寸法線・寸法値 → ④通り芯丸」どおり、
// 通り芯丸は寸法行(ROW2)とは別の3段目に分離する（QA G4）。調整項目2: 通り芯丸(旧③)と
// 面ラベル(旧④)は同じ段に統合する（水平位置はそれぞれ従来通り。縦位置だけ揃える）。
// QA C1→D1/D2: これらの行位置は全てbuildFaceFigure内でctx（2パス換算済みのopeningTagRowModelMm/
// dimRowGapModelMm/gridRowGapModelMm）から都度計算する——建具記号丸・通り芯丸・面ラベルは
// いずれもスクリーン固定サイズを持つため、行位置をモデルmm定数のまま固定すると縮尺によって
// 床線・上下の寸法行に重なる（詳細はelevationStyle.jsの該当コメント参照）。モジュール読み込み時に
// 決め打ちできないため、以前あった同名のモジュールレベル定数は廃止した。

// 項目3: 直交壁の建具断面（枠2断面＋扉1枚）の帯幅構成。openingElevationFigure.jsのINSET_MMと
// 桁を揃えた見付幅にする（他に基準となる値が無いため、既存の建具姿図の枠見付と統一する判断）。
const SECTION_FRAME_W  = 40;  // 枠1本ぶんの見付幅(mm)
const SECTION_LEAF_TH  = 40;  // 閉めた扉（断面）の厚み(mm)
const SECTION_STRIP_MM = SECTION_FRAME_W * 2 + SECTION_LEAF_TH; // 断面帯の全幅(mm)

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
 * 面ラベル(A/B/C/D等)のx（既定=壁芯間中心）を、通り芯丸との重なりを避けて返す（QA A1→B1改訂）。
 * 項目2で面ラベルと通り芯丸番号を同じ段(y)に統合したため、通り芯が面の壁芯間中心付近にある
 * （偶数モジュールスパン等でよくある）と面ラベルと通り芯丸が同座標で重なり両方判読不能になる。
 *
 * QA B1: 旧実装（衝突時に閾値の2倍ぶん一段だけシフト）は退避先を再チェックしないため、
 * 910mm等間隔グリッド（住宅の標準モジュール）のように通り芯が密な面では、シフト後の位置が
 * 「別の」通り芯丸に重なり直すことがあった（例: CLs=[0,910,1820,2730,3640]・run=3640で
 * 面中心2620がX4=2730から110mmしか離れない）。
 * 「最広ギャップの中点」方式に変更する: boundary.lo/hiで両端を挟んだ「通り芯＋両端」の並びを
 * 昇順に見て、隣接2点間の間隔が最も広い区間の中点にラベルを置く——1回の走査で決まり
 * （反復不要）、通り芯が0〜1本でも自然に劣化する（gridPointsが空なら候補区間は[lo,hi]の1つに
 * なるだけ）。ただし面中心がそもそもどの通り芯とも衝突していなければ（衝突判定にのみ
 * thresholdMmを使う）、動かさず面中心のままにする。
 * @param {number} x - 面ラベルの既定x（ローカル座標。通常は壁芯間中心）
 * @param {Array<{x:number}>} gridPoints - 通り芯（ローカルx）一覧
 * @param {{lo:number, hi:number}} boundary - 面の壁中心線区間（最広ギャップ探索の両端）
 * @param {number} [thresholdMm]
 * @returns {number}
 */
export function avoidGridCollisionX(x, gridPoints, boundary, thresholdMm = DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM) {
  const collides = gridPoints.some(g => Math.abs(g.x - x) <= thresholdMm);
  if (!collides) return x;

  const marks = [boundary.lo, ...gridPoints.map(g => g.x), boundary.hi].sort((a, b) => a - b);
  let bestMid = x;
  let bestGap = -Infinity;
  for (let i = 0; i + 1 < marks.length; i++) {
    const gap = marks[i + 1] - marks[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (marks[i] + marks[i + 1]) / 2;
    }
  }
  return bestMid;
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
 * perpFace（面Fに隣接する直交壁）上の開口のうち、Fとの共有隅（corner='end'ならperpFace自身の
 * 終端=run、corner='start'なら始端=0）にスパンが届いている（面一、またはそれを超えて隅に
 * かかっている）ものを返す（項目3）。
 *
 * 採った解釈: buildRoomFacesの隣接面は必ず隅（世界座標）を共有する不変条件（elevationFaces.js
 * ヘッダ参照）を使い、「Fの面端の縦線」＝perpFace自身のその隅（0またはrun）と捉える。
 * 「開口スパンが交差する」を、perpFaceの仕上げ面ベースの開口スパンがこの隅（0またはrun）まで
 * 届いている（>= run 側 / <= 0 側）と定義した——壁センターライン側（faceBoundaryLocalXの
 * boundary）まで届く条件だと、開口はセンターラインより内側（仕上げ面側）にしか置けないため
 * 実質的に絶対発生しない条件になってしまい採用しなかった。
 * @param {object} perpFace - Fに隣接する直交壁面（buildRoomFacesの1件）
 * @param {object} graph
 * @param {'start'|'end'} corner - Fと共有する隅がperpFaceの始端(0)か終端(run)か
 * @returns {import('@core').Opening[]}
 */
export function openingsReachingCorner(perpFace, graph, corner) {
  return openingsOnFace(perpFace, graph).filter(o => {
    const localX = localXOf(perpFace, o.centerCoord);
    const lo = localX - o.width / 2, hi = localX + o.width / 2;
    return corner === 'end' ? hi >= perpFace.run : lo <= 0;
  });
}

/**
 * 直交壁の建具の断面（枠2断面＋閉めた状態の扉1枚）プリミティブ（項目3）。
 * Fの面端（x0=0 or run）から dir 方向（+1=右へ・-1=左へ）へ SECTION_STRIP_MM ぶん帯を作り、
 * [枠][扉][枠] の3つのrectを開口高さ範囲(top..sillTop)いっぱいに並べる。
 * 線種は切断面の慣習どおり枠=CUT(太)・扉=SILHOUETTE（ユーザー仕様「建築慣習に沿って決めてよい」）。
 * @param {import('@core').Opening} o - 対象開口（openingsReachingCornerの結果1件）
 * @param {number} x0 - 帯の起点（F上のローカルx。0またはrun）
 * @param {1|-1} dir - 帯が伸びる向き
 * @param {string} cutWeight
 * @param {string} silhouetteWeight
 * @returns {object[]}
 */
export function openingSectionPrimitives(o, x0, dir, cutWeight, silhouetteWeight) {
  const h = effectiveHeight(o);
  const sill = o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0;
  const top = -(sill + h), sillTop = -sill;
  const a = x0;
  const b = x0 + dir * SECTION_FRAME_W;
  const c = x0 + dir * (SECTION_FRAME_W + SECTION_LEAF_TH);
  const d = x0 + dir * SECTION_STRIP_MM;
  const band = (lo, hi, weight) =>
    ({ type: 'rect', x: Math.min(lo, hi), y: top, w: Math.abs(hi - lo), h: sillTop - top, weight });
  return [
    band(a, b, cutWeight),
    band(b, c, silhouetteWeight),
    band(c, d, cutWeight),
  ];
}

/**
 * 壁面1枚 → プリミティブ配列。
 * @param {object} face - buildRoomFaces の1件
 * @param {{graph:object, project:object, room:import('@core').Room, ceilingHeight:number,
 *   materialMap:Map|null, gridCLs:object[], faceLabelAvoidThresholdModelMm?:number,
 *   prevFace?:object|null, nextFace?:object|null, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number}} ctx
 *   faceLabelAvoidThresholdModelMm省略時はDEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM（QA B3。
 *   ElevationModeState.initが2パス目でscreenMmToModelMm換算した値を渡す）。
 *   prevFace/nextFace省略時（項目3非対応呼び出し・単体テスト等）は建具断面を描かない。
 *   openingTagRowModelMm/dimRowGapModelMm/gridRowGapModelMm省略時はDEFAULT_OPENING_TAG_ROW_MM/
 *   DEFAULT_DIM_ROW_GAP_MM/DEFAULT_GRID_ROW_GAP_MM（QA C1→D1/D2。ElevationModeState.initが
 *   2パス目でscreenMmToModelMm換算した値を渡す。3つとも独立したスクリーンmm予算から換算する
 *   ——QA D2: 「ROW1をタグ行の2倍として式で導出する」設計は値を機械的に押し上げ、ユーザーが
 *   調整済みの見た目を大きく踏み外したため撤回した）。
 * @returns {object[]}
 */
export function buildFaceFigure(face, ctx) {
  const {
    graph, project, room, ceilingHeight: CH, materialMap, gridCLs, faceLabelAvoidThresholdModelMm,
    prevFace, nextFace, openingTagRowModelMm, dimRowGapModelMm, gridRowGapModelMm,
  } = ctx;
  const run = face.run;
  const prims = [];

  // QA C1→D1/D2: 建具記号丸(タグ)行・ROW1（壁芯間寸法行）の床線からの距離、ROW1→ROW2・
  // ROW2→通り芯丸行の行間。ctx未指定時（単体テスト等）はモジュール読み込み時に決め打ちできる
  // 仮既定値へフォールバックする。
  const openingTagRowY = openingTagRowModelMm ?? DEFAULT_OPENING_TAG_ROW_MM;
  const dimRow1Y       = dimRowGapModelMm ?? DEFAULT_DIM_ROW_GAP_MM;
  const gridRowGapMm   = gridRowGapModelMm ?? DEFAULT_GRID_ROW_GAP_MM;
  const dimRow2Y       = dimRow1Y + gridRowGapMm;
  const gridCircleRowY = dimRow2Y + gridRowGapMm;
  const faceLabelRowY  = gridCircleRowY;

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

  // 開口（建具の姿＋記号丸。項目1・2）。姿図は openings/openingElevationFigure.js の
  // buildOpeningElevation を編集用寸法・動作線・FL基準線を抑制したうえで再利用する
  // （枠・吊元表示・レバーハンドル・機構表現は残す）。座標系は両モジュールともFL=y0・
  // 上方向が負で共通のため、(x, 0)の平行移動だけで面のローカル座標へそのまま乗る。
  const openings = openingsOnFace(face, graph);
  for (const o of openings) {
    const localX = localXOf(face, o.centerCoord);
    const x = localX - o.width / 2;
    const entry = findCatalogEntry(o.category, o.subType);
    const figurePrims = buildOpeningElevation(o, {
      entry, includeDims: false, includeMotionArrows: false, includeLevelLine: false,
    });
    for (const p of figurePrims) prims.push(translatePrimitive(p, x, 0));

    // 建具記号丸（項目2）: 建具の中心ではなく、姿が見える図の下（注記帯側。寸法行より図寄りの
    // 専用段=openingTagRowY）へ置く。背景透明の仕様は不変（fill指定なし）。
    const { symbol, number } = openingTagPartsOf(o, project);
    prims.push({
      type: 'tag', cx: localX, cy: openingTagRowY, rPx: OPENING_TAG_RADIUS_PX,
      top: symbol, bottom: number ?? '',
    });
  }

  // 直交壁の建具が切断位置にかかる場合、その断面（枠2断面＋扉1枚）を面の両端に描く（項目3）。
  if (prevFace) {
    for (const o of openingsReachingCorner(prevFace, graph, 'end')) {
      prims.push(...openingSectionPrimitives(o, 0, 1, cutWeight, silhouetteWeight));
    }
  }
  if (nextFace) {
    for (const o of openingsReachingCorner(nextFace, graph, 'start')) {
      prims.push(...openingSectionPrimitives(o, run, -1, cutWeight, silhouetteWeight));
    }
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
  // 項目4: 通り芯線（GRID_LINE_ABOVE_CH_MM）と同様、壁中心線も天井線より上まで突き出す
  // （y1=0ではなく-CH-GRID_LINE_ABOVE_CH_MMから始める。壁中心線も本来、床から天井を貫通して
  // 続く線のため。同じGRID_LINE_ABOVE_CH_MMを流用する）。
  const boundary = faceBoundaryLocalX(face, graph);
  const centerLineTopY = -CH - GRID_LINE_ABOVE_CH_MM;
  prims.push({ type: 'line', x1: boundary.lo, y1: centerLineTopY, x2: boundary.lo, y2: dimRow1Y, dash: 'center', weight: detailWeight });
  prims.push({ type: 'line', x1: boundary.hi, y1: centerLineTopY, x2: boundary.hi, y2: dimRow1Y, dash: 'center', weight: detailWeight });
  prims.push({
    type: 'dim', dir: 'h', at: dimRow1Y, from: boundary.lo, to: boundary.hi, dot: true,
    label: Math.round(boundary.hi - boundary.lo),
  });

  // 通り芯間寸法（面を貫く通り芯同士。ROW2）。項目2・6: こちらも足は出さない。通り芯自体の
  // 一点鎖線（下のgridCircleRowYまで伸びる縦線）が寸法線位置(dimRow2Y)を通過するため、
  // その交点に塗り丸(dim.dot)を置くだけでよい。
  const gridPoints = gridCLsOnFace(face, gridCLs ?? [])
    .map(cl => ({ x: localXOf(face, cl.effectiveValue), label: cl.label }))
    .sort((a, b) => a.x - b.x);

  for (let i = 0; i + 1 < gridPoints.length; i++) {
    prims.push({
      type: 'dim', dir: 'h', at: dimRow2Y, from: gridPoints[i].x, to: gridPoints[i + 1].x, dot: true,
      label: Math.round(gridPoints[i + 1].x - gridPoints[i].x),
    });
  }
  // 通り芯縦一点鎖線＋丸番号（ROW2のさらに下＝gridCircleRowY。QA G4: 寸法行とは別の段）。
  // 調整項目3: 下端(gridCircleRowY)だけでなく天井線(-CH)より上へも少し突き出す
  // （y1=-CH-GRID_LINE_ABOVE_CH_MM。通り芯は本来、床から天井を貫通して続く線のため）。
  for (const g of gridPoints) {
    prims.push({
      type: 'line', x1: g.x, y1: -CH - GRID_LINE_ABOVE_CH_MM, x2: g.x, y2: gridCircleRowY,
      dash: 'center', weight: detailWeight,
    });
    // 調整項目5: 丸は背景色で塗りつぶし、通り芯線より後（=手前）に描いて線を隠す
    // （配列内で線→丸の順に積む。Konvaは配列順=手前優先で描画するため、この順序自体は
    // 従来から保たれている。丸が塗りなし=透明だったため線が透けて見えていた点を修正）。
    prims.push({ type: 'circle', cx: g.x, cy: gridCircleRowY, rPx: GRID_TAG_RADIUS_PX, fill: CANVAS_BG_COLOR });
    prims.push({
      type: 'text', x: g.x, y: gridCircleRowY, text: g.label,
      anchor: 'middle', baseline: 'middle', size: GRID_TAG_FONT_PX,
    });
  }

  // 面ラベル（A/B/C/D。L字はB1等）を面の幅中心・通り芯丸と同じ段に描く（項目7・調整項目2）。
  // QA F3: run/2（仕上げ面基準の中心）ではなく、壁芯間寸法（項目2・9）と同じ壁中心線で挟んだ
  // 幅の中心(boundary.lo/hiの中点)を使う——面ラベルの中心が壁芯間寸法の中心とズレないように。
  // QA A1: 通り芯丸と同じ段のため、通り芯が中心付近にあると重なる。avoidGridCollisionXで退避する
  // （QA B1: 最広ギャップ中点方式。QA B3: 閾値はctx経由の換算済みモデルmm、未指定時は仮既定値）。
  const faceLabelX = avoidGridCollisionX(
    (boundary.lo + boundary.hi) / 2, gridPoints, boundary, faceLabelAvoidThresholdModelMm,
  );
  prims.push({
    type: 'text', x: faceLabelX, y: faceLabelRowY, text: face.label,
    anchor: 'middle', baseline: 'middle', size: FACE_LABEL_FONT_PX,
  });

  return prims;
}
