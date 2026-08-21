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
import { translatePrimitive, mirrorPrimitiveX } from './elevationPrimitives.js';
import { collectRow1SplitPoints } from './elevationDimSplit.js';
import { drawnRiserX, halfWallThicknessMm } from './elevationFloorProfile.js';
import { kneeDropRecordsOnAxis } from '../finish/kneeDropWall.js';
import {
  ElevationLineRole, weightForRole,
  WALL_LABEL_LINE_GAP_MM,
  OPENING_TAG_RADIUS_PX, GRID_TAG_RADIUS_PX, GRID_TAG_FONT_PX,
  FACE_LABEL_FONT_PX, GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
  DEFAULT_OPENING_TAG_ROW_MM, DEFAULT_DIM_ROW_GAP_MM, DEFAULT_GRID_ROW_GAP_MM,
  DEFAULT_WALL_LESS_END_EXTEND_MM, CH_DIM_OFFSET_MM, SPLIT_MERGE_EPS_MM,
} from './elevationStyle.js';

// 項目4: 壁2段書きの省略判定用テキスト幅概算。renderText（figurePrimitivesKonva.jsx）は
// size省略時fontSize=12を使うため、ここでも同じ12pxを使う。
// QA G1: 全角主体ラベル向けのVoidLayer.jsx方式（1文字=fontSize幅）を全文字一律で使うと、
// 壁2段書きは「壁：PB ア)12.5」のように変換後は半角ASCII（記号・数値・アルファベット）が
// 主体になるため幅を約1.5倍も過大概算し、通常サイズの面でも省略され気味になってしまう
// （項目3の材名変換がほぼ描画されない事態）。文字クラス別に幅係数を分ける
// （全角(CJK等)=1.0×fontSize、半角ASCII=0.5×fontSize）ことで、実際のグリフ幅に近い概算にする。
const WALL_LABEL_FONT_PX = 12;
const WALL_LABEL_HALF_WIDTH_RATIO = 0.5; // 半角ASCII(\x20-\x7e)の幅係数
const WALL_LABEL_FULL_WIDTH_RATIO = 1.0; // 全角(CJK等。半角ASCII以外)の幅係数

/**
 * 壁2段書きラベルのテキスト幅概算(px)。文字クラス別（半角ASCII=0.5倍・それ以外(全角等)=1.0倍）に
 * 積算する（QA G1。全角一律だと変換後の半角主体ラベルの幅を過大概算し過剰に省略されるため）。
 * サロゲートペア文字（絵文字等）を1文字として数えるため配列展開([...text])を使う
 * （文字コード上は想定しないが、文字数を過剰カウントしない安全側の実装として）。
 * @param {string} text
 * @returns {number}
 */
export function estimateWallLabelWidthPx(text) {
  return [...text].reduce((w, ch) =>
    w + (/[\x20-\x7e]/.test(ch) ? WALL_LABEL_HALF_WIDTH_RATIO : WALL_LABEL_FULL_WIDTH_RATIO), 0) * WALL_LABEL_FONT_PX;
}

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
 * 材名の展開図表示用言い換え（項目3。表示専用の変換——材マスター側のデータ（materialData.js）は
 * 変更しない）。「せっこうボード」→「PB」（複合名「強化せっこうボード」等も部分一致で「強化PB」に
 * なる。単純な文字列置換のため）、「t=<数値>」→「ア)<数値>」（せっこうボードに限らず全材共通。
 * 仕様に略記の指定が無いためt=表記の変換のみ全材適用する）。
 * @param {string} name
 * @returns {string}
 */
export function formatMaterialLabel(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/せっこうボード/g, 'PB').replace(/t=(\d+(?:\.\d+)?)/g, 'ア)$1');
}

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
 * ラベル（幅labelWidthMmの矩形とみなす）のxを、障害物区間（開口・アキ・段差縦線など）と
 * 重ならない位置へ退避させる（項目4。avoidGridCollisionXと同系の最広ギャップ方式だが、
 * 障害物が点ではなく幅を持つ区間である点が異なる——単純な点集合の間ではなく、区間同士を
 * 併合してできる「空き区間」の中から最も広いものを選ぶ）。
 * @param {number} defaultX - ラベル既定x（ローカル座標。通常は面中心）
 * @param {Array<{lo:number, hi:number}>} obstacles - 障害物区間（ローカルx）一覧
 * @param {{lo:number, hi:number}} boundary - 探索範囲の両端
 * @param {number} labelWidthMm - ラベル自身の幅（衝突判定・空き区間探索の両方に使う）
 * @returns {number}
 */
export function avoidObstacleRangesX(defaultX, obstacles, boundary, labelWidthMm) {
  const halfW = labelWidthMm / 2;
  const collides = obstacles.some(o => defaultX + halfW > o.lo && defaultX - halfW < o.hi);
  if (!collides) return defaultX;

  const sorted = [...obstacles].sort((a, b) => a.lo - b.lo);
  const merged = [];
  for (const o of sorted) {
    const last = merged[merged.length - 1];
    if (last && o.lo <= last.hi) last.hi = Math.max(last.hi, o.hi);
    else merged.push({ ...o });
  }

  const gaps = [];
  let cursor = boundary.lo;
  for (const m of merged) {
    if (m.lo > cursor) gaps.push({ lo: cursor, hi: m.lo });
    cursor = Math.max(cursor, m.hi);
  }
  if (cursor < boundary.hi) gaps.push({ lo: cursor, hi: boundary.hi });
  if (gaps.length === 0) return defaultX; // 空き区間が無ければ諦めて既定位置のまま

  let best = gaps[0];
  for (const g of gaps) if (g.hi - g.lo > best.hi - best.lo) best = g;
  return (best.lo + best.hi) / 2;
}

/**
 * アキ（腰壁＋垂れ壁の同時指定でできる四角い穴）1件ぶんのプリミティブをprimsへ積む
 * （新仕様: 通常面の腰壁・垂れ壁アキと段差見付け面(kind==='step')上部のアキで共用するため抽出）。
 * 矩形(SILHOUETTE)＋対角線2本(一点鎖線・DETAIL)＋「ア キ」テキスト。
 * @param {object[]} prims
 * @param {{x:number, y:number, w:number, h:number}} gap
 * @param {string} silhouetteWeight
 * @param {string} detailWeight
 */
export function appendGapMark(prims, gap, silhouetteWeight, detailWeight) {
  prims.push({ type: 'rect', x: gap.x, y: gap.y, w: gap.w, h: gap.h, weight: silhouetteWeight });
  prims.push({ type: 'line', x1: gap.x,         y1: gap.y,         x2: gap.x + gap.w, y2: gap.y + gap.h, dash: 'center', weight: detailWeight });
  prims.push({ type: 'line', x1: gap.x + gap.w, y1: gap.y,         x2: gap.x,         y2: gap.y + gap.h, dash: 'center', weight: detailWeight });
  prims.push({ type: 'text', x: gap.x + gap.w / 2, y: gap.y + gap.h / 2, text: 'ア キ', anchor: 'middle', baseline: 'middle' });
}


/**
 * face 上のアキ（腰壁＋垂れ壁の同時指定でできる四角い穴）の矩形一覧（ローカル座標）。
 * kneeDropRecordsOnAxis（finish/kneeDropWall.js。QA修正L1でkey解読を集約）を面のaxisCL・
 * face.lo..hiで絞り込み、区間をface.lo..hiへクランプしてローカル矩形へ変換する。
 * @returns {Array<{x:number, y:number, w:number, h:number}>}
 */
export function kneeDropGapsOnFace(face, graph, ceilingHeightMm) {
  const out = [];
  for (const { rec, lo, hi } of kneeDropRecordsOnAxis(graph, face.axisCL.id, face.lo, face.hi)) {
    if (!rec.knee || !rec.drop) continue; // アキ＝腰壁・垂れ壁の同時指定のみ
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
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number,
 *   floorSegments?:Array<{loX:number,hiX:number,floorDeltaMm:number}>}} ctx
 *   faceLabelAvoidThresholdModelMm省略時はDEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM（QA B3。
 *   ElevationModeState.initが2パス目でscreenMmToModelMm換算した値を渡す）。
 *   prevFace/nextFace省略時（項目3非対応呼び出し・単体テスト等）は建具断面を描かない。
 *   openingTagRowModelMm/dimRowGapModelMm/gridRowGapModelMm省略時はDEFAULT_OPENING_TAG_ROW_MM/
 *   DEFAULT_DIM_ROW_GAP_MM/DEFAULT_GRID_ROW_GAP_MM（QA C1→D1/D2。ElevationModeState.initが
 *   2パス目でscreenMmToModelMm換算した値を渡す。3つとも独立したスクリーンmm予算から換算する
 *   ——QA D2: 「ROW1をタグ行の2倍として式で導出する」設計は値を機械的に押し上げ、ユーザーが
 *   調整済みの見た目を大きく踏み外したため撤回した）。
 *   floorSegments省略時は床線1本のフラット区間（項目4。elevationFloorProfile.jsの
 *   wallAdjacentFloorSegmentsをbuildRoomBand/buildStairBandが計算して渡す。単体テスト等
 *   buildFaceFigureを直接呼ぶ場合は明示的に渡さない限りフラットになる）。
 * @returns {object[]}
 */
export function buildFaceFigure(face, ctx) {
  const {
    graph, project, room, ceilingHeight: CH, materialMap, gridCLs, faceLabelAvoidThresholdModelMm,
    prevFace, nextFace, openingTagRowModelMm, dimRowGapModelMm, gridRowGapModelMm, floorSegments,
    wallLessEndExtendModelMm, scale,
  } = ctx;
  const run = face.run;
  const prims = [];
  // 項目3・4: 壁2段書きの配置・省略判定でも面の壁中心線区間（boundary）が要るため、従来
  // ROW1寸法線の直前にあった算出をここへ前倒しする（値はfaceとgraphのみに依存し不変）。
  const boundary = faceBoundaryLocalX(face, graph);

  // QA C1→D1/D2: 建具記号丸(タグ)行・ROW1（壁芯間寸法行）の床線からの距離、ROW1→ROW2・
  // ROW2→通り芯丸行の行間。ctx未指定時（単体テスト等）はモジュール読み込み時に決め打ちできる
  // 仮既定値へフォールバックする。
  const openingTagRowY = openingTagRowModelMm ?? DEFAULT_OPENING_TAG_ROW_MM;
  const dimRow1Y       = dimRowGapModelMm ?? DEFAULT_DIM_ROW_GAP_MM;
  const gridRowGapMm   = gridRowGapModelMm ?? DEFAULT_GRID_ROW_GAP_MM;
  const dimRow2Y       = dimRow1Y + gridRowGapMm;
  const gridCircleRowY = dimRow2Y + gridRowGapMm;
  const faceLabelRowY  = gridCircleRowY;

  // 新仕様「段差見付け面」: kind==='step'（elevationStepFace.jsのbuildStepFacesが作る面）は
  // 通常面と描画分岐が異なる——低い側床線・両端縦線（壁断面）・天井線をCUTで描き、他の面と
  // y=-CHで同じ高さに並ぶよう揃える。上部にアキ（kneeDropWalls。通常面と同じappendGapMark）。
  // 開口・巾木・壁2段書きはスキップし、注記帯（ROW1/ROW2/面ラベル）はappendAnnotationRowsで
  // 通常面と共通合流する（floorSegments未指定＝ROW1のS1段差CL源は無し）。
  // QA修正（ユーザー差し戻し・新指示）: 見付け上端（高い側床線。1FL+100等の段差先の床の
  // 見えがかり）はCUTではなくSILHOUETTE（中線）——両端縦線は実際に切断される壁の断面（CUT）
  // だが、見付け上端は段差の向こうの床が見えているだけの見えがかり線のため。
  if (face.kind === 'step') {
    const stepCutWeight = weightForRole(ElevationLineRole.CUT);
    const stepSilhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
    const stepDetailWeight = weightForRole(ElevationLineRole.DETAIL);
    const floorY = -face.baseFloorDeltaMm;
    const topY = -(face.baseFloorDeltaMm + face.stepHeightMm);
    prims.push({ type: 'line', x1: 0, y1: floorY, x2: run, y2: floorY, weight: stepCutWeight }); // 低い側床線
    prims.push({ type: 'line', x1: 0, y1: topY,   x2: run, y2: topY,   weight: stepSilhouetteWeight }); // 高い側床線(見付け上端。中線)
    // QA修正（ユーザー明示指示）: 両端縦線（壁断面=CUT）はtopY（見付け上端）で止めず天井(-CH)まで
    // 描画する——見付け上端はあくまで段差先の床の見えがかり線であり、壁自体は天井まで続くため。
    prims.push({ type: 'line', x1: 0,   y1: floorY, x2: 0,   y2: -CH, weight: stepCutWeight });
    prims.push({ type: 'line', x1: run, y1: floorY, x2: run, y2: -CH, weight: stepCutWeight });
    prims.push({ type: 'line', x1: 0, y1: -CH, x2: run, y2: -CH, weight: stepCutWeight }); // 天井線
    // QA修正（ユーザー明示指示）: 見付け上端(topY)から天井(-CH)までは壁が無く見通せるため、
    // 常にアキ（腰壁・垂れ壁と同じappendGapMark）を描く——旧実装はkneeDropGapsOnFace（腰壁・
    // 垂れ壁の明示指定がある軸だけ）にしか頼っておらず、指定が無い通常の段差見付け面では
    // アキが一切描かれない欠落があった（コミット5f8ec62で段差見付け面を新設した時点から
    // 一貫してこの欠落があり、後続のどのラウンドの変更にも起因しない）。
    appendGapMark(prims, { x: 0, y: -CH, w: run, h: CH + topY }, stepSilhouetteWeight, stepDetailWeight);
    for (const gap of kneeDropGapsOnFace(face, graph, CH)) {
      appendGapMark(prims, gap, stepSilhouetteWeight, stepDetailWeight);
    }
    appendAnnotationRows(prims, face, graph, {
      boundary, floorSegments: undefined, gridCLs, dimRow1Y, dimRow2Y, gridCircleRowY, faceLabelRowY,
      detailWeight: stepDetailWeight, faceLabelAvoidThresholdModelMm, CH,
    });
    return prims;
  }

  // 床線・天井線・両端縦線（切断面＝太）。項目4: 部分指定（referenceRoomIds）が壁際の一部を占め
  // floorLevelが親と異なる区間があれば、床線は一直線ではなく段差付きの階段状polylineになる
  // （segs＝elevationFloorProfile.jsのwallAdjacentFloorSegments。buildRoomBand/buildStairBand
  // がctx.floorSegmentsとして渡す。未指定時=単体テスト等はフラット1区間へフォールバックし、
  // 常に従来どおりの床線1本になる）。天井線は項目5（部分指定のCHを段差ぶん増減して天井の絶対
  // 高さを親と揃える）により水平のまま——ここでは一切変更しない。
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const segs = floorSegments ?? [{ loX: 0, hiX: run, floorDeltaMm: 0 }];
  // floorDeltaMm:0 を -0 にせずそのまま 0 として扱う（-0 は等値比較・テストの落とし穴になるため）。
  const floorYOf = s => (s.floorDeltaMm ? -s.floorDeltaMm : 0);

  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const detailWeight     = weightForRole(ElevationLineRole.DETAIL);

  // 項目1・2・QA修正(5a): 面端は「壁のない端部」（hasWallAtLocal0/hasWallAtLocalRun=false。
  // elevationFaces.jsのsnapFaceEndsToCorners参照。単体テスト等でface自体に無い場合はtrue=壁あり
  // 扱いにフォールバックし従来どおりの見た目を保つ）と「出隅」（壁がある＝true。部屋の凸角で、
  // 視線方向に壁が折れて向こうへ続く角）を区別して描く:
  //   壁のない端部 … 「続きがある」ことを示すため床線・天井線を図の外側へextendMmぶん延長し、
  //                   端の縦線は描かない（壁が無い＝切断していないため）。
  //   出隅         … 縦線を描くが、切断面(CUT)ではなく見えがかりの折れ角のためSILHOUETTE
  //                   （中線）で描く（QA修正。前回CUTのまま描いていたのを是正——出隅は壁が
  //                   折れて向こうの面へ続くだけで、そこで部屋の断面が切れているわけではない）。
  const hasWallAtLocal0   = face.hasWallAtLocal0   ?? true;
  const hasWallAtLocalRun = face.hasWallAtLocalRun ?? true;
  const extendMm = wallLessEndExtendModelMm ?? DEFAULT_WALL_LESS_END_EXTEND_MM;
  const drawnX0   = hasWallAtLocal0   ? 0   : -extendMm;
  const drawnXRun = hasWallAtLocalRun ? run : run + extendMm;

  // 新仕様「段差位置のCLオフセット」: 内部境界（区間水平床線の端x・段差縦線x）は寸法・CL位置
  // （segs[i].hiX＝オフセット前）そのものではなく、床が低い側へ半壁厚ぶんずらした位置
  // （drawnRiserX）に描く——寸法線・CL一点鎖線側は従来どおりsegs[i].hiXのまま（elevation-model.md参照）。
  const halfWallMm = halfWallThicknessMm(face);
  const riserXAt = i => drawnRiserX(segs, i, halfWallMm);

  for (const [i, s] of segs.entries()) {
    const y = floorYOf(s);
    const x1 = i === 0 ? drawnX0 : riserXAt(i - 1);
    const x2 = i === segs.length - 1 ? drawnXRun : riserXAt(i);
    prims.push({ type: 'line', x1, y1: y, x2, y2: y, weight: cutWeight });
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    // 段差の縦線（明示指示により寸法線・寸法値は描かない）。床の段差そのものはCUT
    // （切断面＝部屋の輪郭そのものという既存慣習のまま。出隅の縦線とは別物）。
    const x = riserXAt(i);
    prims.push({
      type: 'line', x1: x, y1: floorYOf(segs[i]), x2: x, y2: floorYOf(segs[i + 1]),
      weight: cutWeight,
    });
  }
  const floorYAtStart = floorYOf(segs[0]);
  const floorYAtEnd   = floorYOf(segs[segs.length - 1]);
  prims.push({ type: 'line', x1: drawnX0, y1: -CH, x2: drawnXRun, y2: -CH, weight: cutWeight });
  // 端の縦線（中線）: 壁がある端（出隅・入隅）に加え、見えがかりエッジ（edgeAtLocal0/Run＝
  // 実壁が切断面を横切らず向こう側へ折れて続く凹み角。ユーザー明示指示2026-08）にも描く——
  // 壁断面は無いが角のエッジ自体は見えるため。エッジ端は壁のない端部でもあるので、
  // 床・天井線の延長（drawnX0/drawnXRun）はそのまま併用される（縦線の外側へ続きがある表現）。
  const edgeAtLocal0   = face.edgeAtLocal0   ?? false;
  const edgeAtLocalRun = face.edgeAtLocalRun ?? false;
  if (hasWallAtLocal0 || edgeAtLocal0) {
    prims.push({ type: 'line', x1: 0,   y1: -CH, x2: 0,   y2: floorYAtStart, weight: silhouetteWeight });
  }
  if (hasWallAtLocalRun || edgeAtLocalRun) {
    prims.push({ type: 'line', x1: run, y1: -CH, x2: run, y2: floorYAtEnd,   weight: silhouetteWeight });
  }

  // 新仕様「袖壁・腰壁の面分割」: 袖壁で分割された端（hasWallAtLocal0/Run=falseで縦線を描かない
  // 代わりに床・天井が延長される既存の「壁のない端部」表現の上に）、袖壁自身の断面（厚みthicknessMm・
  // 高さ0..-(topHeightMm??CH)。腰壁ならtopHeightMm=knee.topHeightで低く、無ければ天井まで）を
  // CUT枠として重ねる（openingSectionPrimitivesと同じ「面端から帯を起こす」慣習）。
  if (face.partitionCutAtLocal0) {
    const { thicknessMm, topHeightMm } = face.partitionCutAtLocal0;
    const h = topHeightMm ?? CH;
    prims.push({ type: 'rect', x: 0, y: -h, w: thicknessMm, h, weight: cutWeight });
  }
  if (face.partitionCutAtLocalRun) {
    const { thicknessMm, topHeightMm } = face.partitionCutAtLocalRun;
    const h = topHeightMm ?? CH;
    prims.push({ type: 'rect', x: run - thicknessMm, y: -h, w: thicknessMm, h, weight: cutWeight });
  }

  // アキ（腰壁＋垂れ壁の同時指定でできる四角い穴）
  for (const gap of kneeDropGapsOnFace(face, graph, CH)) {
    appendGapMark(prims, gap, silhouetteWeight, detailWeight);
  }

  // face.lo/hiの位置(x)を含むfloorSegments（segs）の区間のfloorDeltaMmを返す（無ければ0＝親扱い。
  // 開放スパンの遠側床線・境界エッジ描画が「近側の床の高さ」を求めるのに使う共通ヘルパ）。
  const nearDeltaAt = x => {
    const seg = segs.find(s => x >= s.loX - 1e-6 && x <= s.hiX + 1e-6);
    return seg ? seg.floorDeltaMm : 0;
  };

  // 新仕様「開放スパン」（elevationOpenSpan.js。face.spans）: 壁のある区間の先に続く、同室内部の
  // 壁の無い開放区間の描画。壁区間はここまでの床線・天井線・両端縦線で既に表現済みのため、
  // ここではopen区間（kind==='open'）だけを追加で描く。
  //   1. 遠側床線: near側（segs＝wallAdjacentFloorSegments）の床yと開放先(farFloorDeltaMm)の
  //      床yが異なる場合だけ、開放先の床の高さで水平線（SILHOUETTE＝見えがかり）を引く。
  //      far側の方が低ければ（見下ろす方向）破線にする（QA修正・ユーザー明示指示）。
  //   2. 上部あき: `appendGapMark`（腰壁＋垂れ壁のアキと共用）で天井から遠側床までの矩形を描く。
  //   3. 境界エッジ: open区間の両端のうち隣がwall側（区間 or 面端）ならSILHOUETTE縦線を引く
  //      （far側の方が低ければ破線。ユーザー明示指示）。
  const spans = face.spans ?? [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.kind !== 'open') continue;
    const farDelta = s.farFloorDeltaMm ?? 0;
    const nearDelta = nearDeltaAt((s.loX + s.hiX) / 2);
    // QA修正（ユーザー明示指示）: 開放先の床がnear側より低い（見下ろす方向）場合、遠側床線・
    // 境界縦線を破線にする（見えがかりの隠れ線表現）。従来の一律SILHOUETTE実線から変更。
    const looksDown = farDelta < nearDelta;
    const dashOpt = looksDown ? { dash: 'dashed' } : {};
    if (farDelta !== nearDelta) {
      prims.push({ type: 'line', x1: s.loX, y1: -farDelta, x2: s.hiX, y2: -farDelta, weight: silhouetteWeight, ...dashOpt });
    }
    const gapH = CH - farDelta;
    if (gapH > 0) {
      appendGapMark(prims, { x: s.loX, y: -CH, w: s.hiX - s.loX, h: gapH }, silhouetteWeight, detailWeight);
    }
    const prevIsWall = i > 0 ? spans[i - 1].kind === 'wall' : hasWallAtLocal0;
    const nextIsWall = i < spans.length - 1 ? spans[i + 1].kind === 'wall' : hasWallAtLocalRun;
    if (prevIsWall) {
      prims.push({ type: 'line', x1: s.loX, y1: -nearDeltaAt(s.loX), x2: s.loX, y2: -CH, weight: silhouetteWeight, ...dashOpt });
    }
    if (nextIsWall) {
      prims.push({ type: 'line', x1: s.hiX, y1: -nearDeltaAt(s.hiX), x2: s.hiX, y2: -CH, weight: silhouetteWeight, ...dashOpt });
    }
  }

  // 開口（建具の姿＋記号丸。項目1・2）。姿図は openings/openingElevationFigure.js の
  // buildOpeningElevation を編集用寸法・動作線・FL基準線を抑制したうえで再利用する
  // （枠・吊元表示・レバーハンドル・機構表現は残す）。座標系は両モジュールともFL=y0・
  // 上方向が負で共通のため、(x, 0)の平行移動だけで面のローカル座標へそのまま乗る。
  // 姿図の正準向きは「世界座標昇順＝図のx昇順」（吊元 hingeSide<0＝coord1側＝図のx=0。
  // 平面記号 OpeningsLayer.jsx swingSymbol の hingeAlong と同じ世界アンカー）のため、
  // 世界順とローカル順が反転する面（dirSign<0）では左右反転してから置く——反転しないと
  // 吊元・親子扉の子・レバーハンドル等の非対称要素が逆端に描かれる（裏側から見る面も
  // dirSign が逆になるため、この同じ反転で物理的に正しい見えがかりになる）。
  // 床に高低差がある面（部分指定の段差＝floorSegments）では、建具はその位置の実際の床に
  // 乗せる——姿図はFL=y0（帯の親FL）基準のため、開口中心位置の区間の床yへ平行移動する。
  // 親FL基準のまま置くと、段差区間の建具が床から浮く／めり込む（例: 親FL+100の帯で
  // 実効FL±0の部分指定区間にあるドアが1FL+100に描かれる）。段差をまたぐ開口は
  // 開口中心位置の区間の床を採る。
  // 区間の同定は論理境界（segs[i].hiX）ではなく描画上の段差線（riserXAt＝床が低い側へ
  // 半壁厚ずらした位置。床線・巾木の区間端と同じ基準）で行う——論理境界で判定すると、
  // 境界から半壁厚以内に中心がある建具だけが「描かれた床」と別の区間に判定され浮く。
  // どの論理区間にも入らない欠測x（floorSegmentsの隙間）は親扱い（0）にフォールバックする。
  const drawnDeltaAt = (x) => {
    const idx = segs.findIndex(s => x >= s.loX - 1e-6 && x <= s.hiX + 1e-6);
    if (idx === -1) return 0;
    if (idx > 0 && x < riserXAt(idx - 1)) return segs[idx - 1].floorDeltaMm;
    if (idx < segs.length - 1 && x > riserXAt(idx)) return segs[idx + 1].floorDeltaMm;
    return segs[idx].floorDeltaMm;
  };
  const floorDyAt = x => { const d = drawnDeltaAt(x); return d ? -d : 0; };
  const openings = openingsOnFace(face, graph);
  for (const o of openings) {
    const localX = localXOf(face, o.centerCoord);
    const x = localX - o.width / 2;
    const entry = findCatalogEntry(o.category, o.subType);
    const figurePrims = buildOpeningElevation(o, {
      entry, includeDims: false, includeMotionArrows: false, includeLevelLine: false,
    });
    const oriented = face.dirSign < 0 ? figurePrims.map(p => mirrorPrimitiveX(p, o.width)) : figurePrims;
    for (const p of oriented) prims.push(translatePrimitive(p, x, floorDyAt(localX)));

    // 建具記号丸（項目2）: 建具の中心ではなく、姿が見える図の下（注記帯側。寸法行より図寄りの
    // 専用段=openingTagRowY）へ置く。背景透明の仕様は不変（fill指定なし）。
    // QA項目3: openingIdを持たせ、クリックで建具リストパネルを開けるようにする
    // （figurePrimitivesKonva.jsxのrenderTagがopeningId有無でクリック可否を判定する）。
    const { symbol, number } = openingTagPartsOf(o, project);
    prims.push({
      type: 'tag', cx: localX, cy: openingTagRowY, rPx: OPENING_TAG_RADIUS_PX,
      top: symbol, bottom: number ?? '', openingId: o.id,
    });
  }

  // 直交壁の建具が切断位置にかかる場合、その断面（枠2断面＋扉1枚）を面の両端に描く（項目3）。
  // 新仕様「開放スパン」: extendedAtLocal0/Run=true（開放スパンで延長された端）はそもそも
  // 実在する隅ではない（prevFace/nextFaceの隅共有という前提が成立しない）ため、断面を描かない。
  // 壁のない端部（hasWallAtLocal0/Run=false。直交壁が切断面を横切らない凹み角等）も同様——
  // 壁の切断面自体を描かない端に建具の断面だけ残すと「ここに切断面がある」と誤読される
  // （QA指摘: 隅共有の前提が凹み角で崩れたのに合わせてガードを拡張）。
  // 断面も姿図と同様、その隅の実際の床（floorSegments）に乗せる（隅は両面で床を共有するため、
  // 自面の端x=0/runの床yを使えば隣接面側の実効FLと一致する）。
  if (prevFace && !face.extendedAtLocal0 && (face.hasWallAtLocal0 ?? true)) {
    const dy = floorDyAt(0);
    for (const o of openingsReachingCorner(prevFace, graph, 'end')) {
      prims.push(...openingSectionPrimitives(o, 0, 1, cutWeight, silhouetteWeight)
        .map(p => translatePrimitive(p, 0, dy)));
    }
  }
  if (nextFace && !face.extendedAtLocalRun && (face.hasWallAtLocalRun ?? true)) {
    const dy = floorDyAt(run);
    for (const o of openingsReachingCorner(nextFace, graph, 'start')) {
      prims.push(...openingSectionPrimitives(o, run, -1, cutWeight, silhouetteWeight)
        .map(p => translatePrimitive(p, 0, dy)));
    }
  }

  // 巾木（h=<mm>と解釈できた場合のみ。床まで達する開口の区間は途切れさせる）。
  // 項目6: 床に段差がある場合、巾木は床断面線（区間水平線＋段差の縦線）をhだけ上へそのまま
  // 平行移動した連続ポリラインとして描く（前回=項目7の「区間水平線＋段差縦線から水平にh離れた
  // 位置の返し線」という表現を撤回し、水平方向にはオフセットしない素直な平行オフセットに変更。
  // 区間の水平線は従来どおり開口で途切れさせ、段差の縦線も同じx位置のまま床側のy2点をhだけ
  // 上へ平行移動する——開口がその段差位置をまたいでいれば同様に途切れさせる）。
  const baseboardH = parseBaseboardHeightMm(room.finish?.baseboardHeight);
  if (baseboardH != null && baseboardH < CH) {
    // 新仕様「開放スパン」: open区間は壁が無い＝巾木も存在しないため、開口と同じ「途切れさせる
    // 区間」として扱う（既存floorGapsへ足すだけ）。
    const floorGaps = [
      ...openings
        .filter(o => (o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0) === 0)
        .map(o => {
          const localX = localXOf(face, o.centerCoord);
          return [Math.max(0, localX - o.width / 2), Math.min(run, localX + o.width / 2)];
        }),
      ...spans.filter(s => s.kind === 'open').map(s => [s.loX, s.hiX]),
    ].sort((a, b) => a[0] - b[0]);
    for (const [i, s] of segs.entries()) {
      const y = floorYOf(s) - baseboardH;
      // 新仕様「段差位置のCLオフセット」: 内部境界はriserXAt（床が低い側へ半壁厚ずらした位置）を使う。
      const segLo = i === 0 ? s.loX : riserXAt(i - 1);
      const segHi = i === segs.length - 1 ? s.hiX : riserXAt(i);
      let cursor = segLo;
      for (const [gLo, gHi] of floorGaps) {
        const cgLo = Math.max(gLo, segLo), cgHi = Math.min(gHi, segHi);
        if (cgHi <= cgLo) continue; // この区間に重ならない開口
        if (cgLo > cursor) prims.push({ type: 'line', x1: cursor, y1: y, x2: cgLo, y2: y, weight: detailWeight });
        cursor = Math.max(cursor, cgHi);
      }
      if (cursor < segHi) prims.push({ type: 'line', x1: cursor, y1: y, x2: segHi, y2: y, weight: detailWeight });
    }
    for (let i = 0; i + 1 < segs.length; i++) {
      const riserX = riserXAt(i);
      if (floorGaps.some(([gLo, gHi]) => riserX > gLo && riserX < gHi)) continue; // 開口がまたぐ段差は途切れさせる
      prims.push({
        type: 'line', x1: riserX, y1: floorYOf(segs[i]) - baseboardH, x2: riserX, y2: floorYOf(segs[i + 1]) - baseboardH,
        weight: detailWeight,
      });
    }
  }

  // 「壁：<壁材>」「<壁仕上げ材>」2段書き（材が引けない行は描かない。項目3・4）。
  // 項目3: 材名は表示専用にformatMaterialLabelで言い換える（材マスター自体は変更しない）。
  // 項目4: 位置は原則、面の壁中心線区間の中心。開口・アキ・段差縦線と重なる場合は
  // avoidObstacleRangesX（avoidGridCollisionXと同系の最広ギャップ方式。障害物が区間の版）で
  // 最も広い空き区間へ退避する。巾木は対象外とした——巾木は面のほぼ全幅を覆う帯のため、
  // 障害物に含めると「空いている場所」がほぼ無くなり退避が機能しなくなるため。
  // 縦位置は天井線の上ではなく天井高の中央（-CH/2）に置く——避ける対象（開口・アキ等）は
  // いずれも天井線より下にしかないため、天井線より上のままでは退避が意味を持たない。
  // 省略: 壁中心線間の描画長さ(boundary.hi-boundary.lo)がラベル幅の2倍未満なら描画しない
  // （狭い面での文字潰れを避ける。テキスト幅はestimateWallLabelWidthPx——文字クラス別の
  // フォントサイズ概算（QA G1）。scale未指定＝倍率決定用の1パス目では省略判定を行わない
  // =常に描画する。理由: 省略の有無がbounds/heightに与える影響は無視できる一方、1パス目で
  // scaleそのものは未確定のため判定できないため）。
  const info = room.getFinishInfo();
  const wallLabelLines = [
    materialMap?.get(info.wallMaterial)?.name ? `壁：${formatMaterialLabel(materialMap.get(info.wallMaterial).name)}` : null,
    materialMap?.get(info.wallFinish)?.name ? formatMaterialLabel(materialMap.get(info.wallFinish).name) : null,
  ].filter(Boolean);
  if (wallLabelLines.length > 0) {
    const labelWidthPx = Math.max(...wallLabelLines.map(estimateWallLabelWidthPx));
    const labelWidthMm = scale ? labelWidthPx / scale : 0;
    if (boundary.hi - boundary.lo >= labelWidthMm * 2) {
      const obstacles = [
        ...openings.map(o => {
          const localX = localXOf(face, o.centerCoord);
          return { lo: localX - o.width / 2, hi: localX + o.width / 2 };
        }),
        ...kneeDropGapsOnFace(face, graph, CH).map(g => ({ lo: g.x, hi: g.x + g.w })),
        // 段差の縦線（新仕様「段差位置のCLオフセット」: riserXAt=床が低い側へ半壁厚ずらした位置）。
        ...segs.slice(0, -1).map((s, i) => ({ lo: riserXAt(i), hi: riserXAt(i) })),
        // 新仕様「開放スパン」: open区間には壁材そのものが無いため、2段書きラベルを置かない。
        ...spans.filter(s => s.kind === 'open').map(s => ({ lo: s.loX, hi: s.hiX })),
      ];
      const labelX = avoidObstacleRangesX((boundary.lo + boundary.hi) / 2, obstacles, boundary, labelWidthMm);
      const totalLinesHeightMm = (wallLabelLines.length - 1) * WALL_LABEL_LINE_GAP_MM;
      let labelY = -CH / 2 - totalLinesHeightMm / 2;
      for (const line of wallLabelLines) {
        // QA修正(項目1): レンダラ(figurePrimitivesKonva.jsxのrenderText)はanchor==='middle'かつ
        // baseline==='middle'の両方が揃って初めて字群幅を基準にした中央寄せ(Text align='center')に
        // なる——anchorだけでは中央寄せの分岐に入らず左端合わせのまま描画されていた（不具合）。
        prims.push({ type: 'text', x: labelX, y: labelY, text: line, anchor: 'middle', baseline: 'middle' });
        labelY += WALL_LABEL_LINE_GAP_MM;
      }
    }
  }

  // 壁芯間寸法（面の両端＝壁中心線。ROW1）。項目2・6: 寸法線足(dim.foot)は廃止し、代わりに
  // 壁中心線自体（一点鎖線）を寸法線の位置まで下ろし、交点に塗り丸(dim.dot)を置く。
  // 項目4: 通り芯線（GRID_LINE_ABOVE_CH_MM）と同様、壁中心線も天井線より上まで突き出す
  // （y1=0ではなく-CH-GRID_LINE_ABOVE_CH_MMから始める。壁中心線も本来、床から天井を貫通して
  // 続く線のため。同じGRID_LINE_ABOVE_CH_MMを流用する）。
  // 新仕様「ROW1寸法のCL分割」: boundary.lo〜hiを1本で通すのではなく、段差CL・面へ到達する
  // 直交壁（袖壁等）・面に届く非通り芯中心線の3源（collectRow1SplitPoints）で分割した
  // 「寸法の鎖」にする——marks=[boundary.lo,...分割x,boundary.hi]を区間ごとにdim(dot:true)で結ぶ。

  // 項目5: 床に段差がある面（segs.length>1）は、図の右側にも天井高さ寸法を描く（左のCH寸法と
  // 同じ様式=縦書き値・端部塗り丸。値は右端区間の実効CH=天井絶対高−右端区間FL）。左のCH寸法は
  // 帯の先頭面だけに1本（elevationBand.js/elevationStair.js）だが、こちらは面ごとに判定する
  // ——段差は面単位のプロファイルのため、段差がある面それぞれに必要になる。
  if (segs.length > 1) {
    const rightSeg = segs[segs.length - 1];
    const rightChDimX = boundary.hi + CH_DIM_OFFSET_MM;
    const rightFloorY = floorYOf(rightSeg);
    prims.push({
      type: 'dim', dir: 'v', at: rightChDimX, from: -CH, to: rightFloorY, foot: boundary.hi, dot: true,
      label: Math.round(CH - rightSeg.floorDeltaMm),
    });
  }

  appendAnnotationRows(prims, face, graph, {
    boundary, floorSegments: segs, gridCLs, dimRow1Y, dimRow2Y, gridCircleRowY, faceLabelRowY,
    detailWeight, faceLabelAvoidThresholdModelMm, CH,
  });

  return prims;
}

/**
 * 注記帯（ROW1鎖・ROW2通り芯間寸法・通り芯丸+ラベル・面ラベル）をprimsへ積む
 * （新仕様。通常面・段差見付け面(kind==='step')の両方から共通で呼ぶ——見付け面は
 * floorSegments未指定（S1の段差CL源が無い）で呼ばれる。開口・巾木・壁2段書きは対象外
 * ＝呼び出し元がkind==='step'なら別途スキップする）。
 * @param {object[]} prims
 * @param {object} face
 * @param {object} graph
 * @param {{boundary:{lo:number,hi:number}, floorSegments?:Array, gridCLs?:object[],
 *   dimRow1Y:number, dimRow2Y:number, gridCircleRowY:number, faceLabelRowY:number,
 *   detailWeight:string, faceLabelAvoidThresholdModelMm?:number, CH:number}} opts
 */
function appendAnnotationRows(prims, face, graph, opts) {
  const {
    boundary, floorSegments, gridCLs, dimRow1Y, dimRow2Y, gridCircleRowY, faceLabelRowY,
    detailWeight, faceLabelAvoidThresholdModelMm, CH,
  } = opts;

  // 通り芯間寸法（面を貫く通り芯同士。ROW2）より先にgridPointsを求める——ROW1の一点鎖線が
  // 「通り芯と同位置なら重複させない」判定にgridPointsを使うため。
  const gridPoints = gridCLsOnFace(face, gridCLs ?? [])
    .map(cl => ({ x: localXOf(face, cl.effectiveValue), label: cl.label }))
    .sort((a, b) => a.x - b.x);

  // 壁芯間寸法（面の両端＝壁中心線。ROW1）。新仕様「ROW1寸法のCL分割」: boundary.lo〜hiを
  // 1本で通すのではなく、段差CL・面へ到達する直交壁（袖壁等）・面に届く非通り芯中心線・
  // 開放スパンの内部境界の4源（collectRow1SplitPoints）で分割した「寸法の鎖」にする。
  const centerLineTopY = -CH - GRID_LINE_ABOVE_CH_MM;
  const row1SplitXs = collectRow1SplitPoints(face, graph, { floorSegments, boundary, spans: face.spans });
  const row1Marks = [boundary.lo, ...row1SplitXs, boundary.hi];
  for (const x of row1Marks) {
    const onGrid = gridPoints.some(g => Math.abs(g.x - x) <= SPLIT_MERGE_EPS_MM);
    if (onGrid) continue; // 通り芯の一点鎖線（ROW2側）と重複させない
    prims.push({ type: 'line', x1: x, y1: centerLineTopY, x2: x, y2: dimRow1Y, dash: 'center', weight: detailWeight });
  }
  for (let i = 0; i + 1 < row1Marks.length; i++) {
    prims.push({
      type: 'dim', dir: 'h', at: dimRow1Y, from: row1Marks[i], to: row1Marks[i + 1], dot: true,
      label: Math.round(row1Marks[i + 1] - row1Marks[i]),
    });
  }

  // 通り芯間寸法（面を貫く通り芯同士。ROW2）。項目2・6: こちらも足は出さない。通り芯自体の
  // 一点鎖線（下のgridCircleRowYまで伸びる縦線）が寸法線位置(dimRow2Y)を通過するため、
  // その交点に塗り丸(dim.dot)を置くだけでよい。
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
}
