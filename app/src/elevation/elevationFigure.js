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
import { openingsOnFace, faceBoundaryLocalX, drawnSpanRanges } from './elevationFaces.js';
import { effectiveHeight, openingTagPartsOf } from '../openings/openingNumbering.js';
import { findCatalogEntry } from '../openings/openingCatalog.js';
import { buildOpeningElevation } from '../openings/openingElevationFigure.js';
import { translatePrimitive, mirrorPrimitiveX } from './elevationPrimitives.js';
import { collectRow1SplitPoints } from './elevationDimSplit.js';
import { drawnRiserX, drawnCeilingRiserX, halfWallThicknessMm } from './elevationFloorProfile.js';
import { solidPrimitivesForFace } from './elevationSolids.js';
import { kneeDropRecordsOnAxis } from '../finish/kneeDropWall.js';
import {
  ElevationLineRole, weightForRole,
  WALL_LABEL_LINE_GAP_MM,
  OPENING_TAG_RADIUS_PX, GRID_TAG_RADIUS_PX, GRID_TAG_FONT_PX,
  FACE_LABEL_FONT_PX, GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
  DEFAULT_OPENING_TAG_ROW_MM, DEFAULT_DIM_ROW_GAP_MM, DEFAULT_GRID_ROW_GAP_MM,
  DEFAULT_WALL_LESS_END_EXTEND_MM, CH_DIM_OFFSET_MM, SPLIT_MERGE_EPS_MM, DEFAULT_DIM_FOOT_GAP_MM,
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
 * 面の区間端（先頭 or 末尾）の「床・天井の起点」を返す（問題修正2026-08その4改）。
 * 帯レイアウト（elevationBand.jsのlayoutBandFaces）が「直前の面の右端と次の面の左端で
 * 床の起点高さが変わったら、次の面の左側にCH寸法を描く」判定と寸法値の算出に使う。
 *
 * 端区間は素の（描かれるままの）先頭/末尾区間を読む——入隅の面端に挟まる半壁厚程度の
 * gap-fill区間も実際に床として描かれるため、読み飛ばさない（問題修正2026-08その6:
 * 実機ではB1右端の半壁厚区間の床(+100)が「B1の右側の床」であり、これと次の面の左端の床の
 * 不一致こそが継ぎ目＝CH寸法を出す箇所。一時導入した「幅閾値で端区間を読み飛ばす」方式は
 * この実機挙動と逆で撤回した）。
 * @param {Array<{floorDeltaMm:number, chMm?:number}>|undefined} segs - wallAdjacentFloorSegments
 * @param {number} CH - 帯のCH（chMm未指定区間の天井絶対高さフォールバック）
 * @param {'first'|'last'} end
 * @returns {{floorDeltaMm:number, ceilAbsMm:number}|null} segs未指定はnull
 */
export function segEndProfile(segs, CH, end) {
  if (!segs || segs.length === 0) return null;
  const s = end === 'first' ? segs[0] : segs[segs.length - 1];
  const floorDeltaMm = s.floorDeltaMm ?? 0;
  return { floorDeltaMm, ceilAbsMm: s.chMm != null ? floorDeltaMm + s.chMm : CH };
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
 * アキ1件ぶんのプリミティブをprimsへ積む（段差見付け面(kind==='step')上部のアキと開放スパンの
 * 上部あきで共用）。対角線2本(一点鎖線・DETAIL)＋「ア キ」テキスト。
 *
 * **輪郭の矩形は描かない**（ユーザー明示指示「矩形をやめて」）——アキの輪郭は定義上つねに周囲の
 * 実体（壁の断面・床/天井の断面線・腰壁の天端・面端の縦線）と一致するため、矩形として独立に
 * 描くと必ず二重になる。しかも矩形は中線なので、後から重なって**断面＝太線という線種の情報を
 * 上書きしてしまう**。断面エンジン側のアキ標記（emitOpenGapMarks）と同じ規則。
 * @param {object[]} prims
 * @param {{x:number, y:number, w:number, h:number}} gap
 * @param {string} detailWeight - 対角線・一点鎖線の線種
 */
export function appendGapMark(prims, gap, detailWeight) {
  prims.push({ type: 'line', x1: gap.x,         y1: gap.y,         x2: gap.x + gap.w, y2: gap.y + gap.h, dash: 'center', weight: detailWeight });
  prims.push({ type: 'line', x1: gap.x + gap.w, y1: gap.y,         x2: gap.x,         y2: gap.y + gap.h, dash: 'center', weight: detailWeight });
  prims.push({ type: 'text', x: gap.x + gap.w / 2, y: gap.y + gap.h / 2, text: 'ア キ', anchor: 'middle', baseline: 'middle' });
}


/**
 * face 上のアキ（腰壁＋垂れ壁の同時指定でできる四角い穴）の矩形一覧（ローカル座標）。
 * kneeDropRecordsOnAxis（finish/kneeDropWall.js。QA修正L1でkey解読を集約）を面のaxisCL・
 * face.lo..hiで絞り込み、区間をface.lo..hiへクランプしてローカル矩形へ変換する。
 *
 * **通常面のアキの標記はここでは描かない**（断面エンジンのemitOpenGapMarksへ移行済み）
 * ——「指定があるか」しか見ない面図側と違い、実際に抜けているかは他階・遮蔽まで見ないと
 * 決まらないため。この関数が残るのは次の2つだけ:
 *   - 段差見付け面（kind==='step'）の上部のアキ。断面エンジンに対応概念が無い専用描画。
 *   - 壁2段書きラベルの回避範囲。描画ではなく**配置の都合**（エンジンの出力は
 *     buildFaceFigureの後に積まれるため、ここからは見えない）。
 * @returns {Array<{x:number, y:number, w:number, h:number}>}
 */
export function kneeDropGapsOnFace(face, graph, ceilingHeightMm) {
  const out = [];
  for (const { rec, lo, hi } of kneeDropRecordsOnAxis(graph, face.axisCL, face.lo, face.hi)) {
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
 *
 * 不良修正2026-08（「通り芯の丸ナンバーが描画されない場合がある」）: 範囲は face.lo..hi
 * （＝直交壁の**室内側仕上げ面**へ詰めた端。snapFaceEndsToCorners）ではなく、呼び出し側が渡す
 * worldRange（＝面の両端の**壁中心線**＝faceBoundaryLocalXのboundaryを世界座標へ戻したもの）で
 * 判定する——面端の通り芯は必ず壁中心線に乗るため、face.lo..hi基準だと半壁厚＋仕上げ厚ぶん
 * 外側にあり常に除外され、「両端だけに通り芯がある面」では通り芯丸・ROW2寸法が1つも描かれない
 * （実グラフの単純な矩形部屋で全4面とも丸0個になることを検証済み）。ROW1側に「通り芯と同位置の
 * 一点鎖線は重複させない」判定（appendAnnotationRowsのonGrid。marksにboundary.lo/hiを含む）が
 * ある事実が、元々この範囲を意図していたことを示している。
 * worldRange未指定（単体テスト等の直接呼び出し）は従来どおりface.lo..hi。
 */
function gridCLsOnFace(face, gridCLs, worldRange) {
  // isVertical=falseの面(A/C)は面軸に直交する垂直CL、isVertical=trueの面(B/D)は水平CLを表示する。
  const wantVertical = !face.isVertical;
  const lo = worldRange?.lo ?? face.lo;
  const hi = worldRange?.hi ?? face.hi;
  return gridCLs.filter(cl =>
    cl.centerLineType !== CenterLineType.RADIAL &&
    (cl.centerLineType === CenterLineType.VERTICAL) === wantVertical &&
    cl.effectiveValue >= lo - SPLIT_MERGE_EPS_MM && cl.effectiveValue <= hi + SPLIT_MERGE_EPS_MM);
}

/**
 * gridCLsOnFace へ渡す世界座標範囲。face.lo..hi（仕上げ面基準）と boundary（壁中心線基準）の
 * 和集合を返す——boundaryはローカルxのため originWorld/dirSign で世界座標へ戻す。
 * originWorld/dirSign を持たない合成face（既存単体テストの後方互換）はnullを返し、
 * gridCLsOnFace側が従来どおりface.lo..hiへフォールバックする。
 * @param {object} face
 * @param {{lo:number, hi:number}} boundary - faceBoundaryLocalX の結果（ローカルx）
 * @returns {{lo:number, hi:number}|null}
 */
function gridWorldRange(face, boundary) {
  if (!Number.isFinite(face.originWorld) || (face.dirSign !== 1 && face.dirSign !== -1)) return null;
  const a = face.originWorld + boundary.lo * face.dirSign;
  const b = face.originWorld + boundary.hi * face.dirSign;
  // 範囲は face.lo/hi と boundary の**和集合ちょうど**にとどめる。一度「面端の壁の半厚ぶん外へ
  // 広げる」拡張を入れたが、その根拠にした実機報告（「1」のB右/D左のY1が出ない）はユーザーの
  // 指示ミスで、実際には正しく描かれていた——確認済みの根拠が無い一般化は入れない
  // （このモジュールの既存方針: 類似規則への拡張は明示指示がある場合のみ）。
  return { lo: Math.min(face.lo, a, b), hi: Math.max(face.hi, a, b) };
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
 *   floorSegments?:Array<{loX:number,hiX:number,floorDeltaMm:number,chMm?:number}>,
 *   beyondCeilings?:Array<{loX:number,hiX:number,ceilAbsMm:number}>,
 *   ceilingProfile?:Array<[number,number]>, skipBaseboard?:boolean, skipWallLabel?:boolean,
 *   floorSpanX?:{lo:number,hi:number}}} ctx
 *   beyondCeilings省略時（単体テスト等）は別エリアの天井の破線を描かない
 *   （elevationFloorProfile.jsのfamilyCeilingSegmentsをlayoutBandFacesが計算して渡す）。
 *   ceilingProfile（WP-2。[[localX,ceilAbsMm],...]・昇順の区分線形の天井。面の描画範囲を
 *   覆う必要はない——QA修正: 旧「覆わなければフォールバック」契約は、壁のない端部の延長で
 *   描画範囲が広がるだけで勾配天井が丸ごとフラット化する本番バグの原因だったため撤廃。
 *   省略時（空配列・1点のみを含む）は現行の水平天井（区間別のchMmベース）へフォールバック
 *   する（例外を投げない）。指定時（2点以上）は範囲外のxを端点値へクランプして常にprofile
 *   から解決し、天井の水平線群＋段差縦線の代わりに
 *   1本のpolyline（CUT）で描き、beyondCeilingsの破線処理は対象外（スキップ）になる。
 *   skipBaseboard/skipWallLabel（WP-2。既定false）はそれぞれ巾木・壁2段書きの描画を省略する
 *   （階段帯等、これらの表現が不要な帯からの呼び出し用）。
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
 *   solids（追加仕様2026-08。{upperGraph?, floorHeightMm?}）指定時のみ、2.5D立体の加算レイヤ
 *   （構造柱の柱型・梁型。elevationSolids.js）を重ねる。省略時（既定・階段帯・単体テスト）は
 *   出力完全不変——階段帯は自前の断面エンジン経路（elevationStairSequence.jsのcontentForCut）で
 *   既に構造梁を描くため、ここで重ねると二重描画になる。
 *   floorSpanX（WP-E7・defer D2）省略時は現行のdrawnX0/drawnXRun（壁のない端部延長込み）を
 *   そのまま使う（通常部屋帯・吹抜け帯は無指定のため出力が完全一致＝WP-G0ゲートで担保）。
 *   指定時はdrawnX0/drawnXRunをMath.max/minでこの範囲へクランプする——階段の腰壁越しに
 *   見える向こう側の床線・天井線を、cutAlong壁（往復間の壁）の実位置で打ち切るためのフック。
 * @returns {object[]}
 */
export function buildFaceFigure(face, ctx) {
  const {
    graph, project, room, ceilingHeight: CH, materialMap, gridCLs, faceLabelAvoidThresholdModelMm,
    prevFace, nextFace, openingTagRowModelMm, dimRowGapModelMm, gridRowGapModelMm, floorSegments,
    wallLessEndExtendModelMm, scale, ceilingProfile, skipBaseboard, skipWallLabel, floorSpanX,
    solids, extraCenterLineXs,
  } = ctx;
  const run = face.run;
  const prims = [];
  // 項目3・4: 壁2段書きの配置・省略判定でも面の壁中心線区間（boundary）が要るため、従来
  // ROW1寸法線の直前にあった算出をここへ前倒しする（値はfaceとgraphのみに依存し不変）。
  const boundary = faceBoundaryLocalX(face, graph);

  // WP-2: ctx.ceilingProfile（[[localX, ceilAbsMm], ...]。昇順の区分線形の天井。階段勾配天井用の
  // フック）が指定されていれば線形補間した天井絶対高さを返す。未指定（空配列含む）はfallbackAbsMm
  // （呼び出し側が既に算出済みの現行の値）をそのまま返す——未指定時に現行出力と完全一致させる
  // ため、呼び出し側は必ず既存の計算式の結果そのものをfallbackAbsMmへ渡すこと（例外は投げない）。
  // QA修正: 指定時、xが範囲外（面の壁のない端部延長=wallLessEndExtendMm分などでprofile自体の
  // 範囲を超える）でもfallbackAbsMmへ黙って戻さず、範囲の端点値へクランプして常にprofileから
  // 解決する——旧実装は「範囲を覆っていなければ丸ごとフォールバック」だったため、本番設定
  // （wallLessEndExtendModelMm≈150が常に渡る）では描画範囲がprofile範囲よりわずかに広がり、
  // 勾配天井が一度も描かれない不具合があった。
  const ceilAbsAtX = (x, fallbackAbsMm) => {
    if (!Array.isArray(ceilingProfile) || ceilingProfile.length === 0) return fallbackAbsMm;
    const first = ceilingProfile[0], last = ceilingProfile[ceilingProfile.length - 1];
    const cx = Math.min(Math.max(x, first[0]), last[0]); // 範囲外は端点値へクランプ
    for (let i = 0; i + 1 < ceilingProfile.length; i++) {
      const [x1, y1] = ceilingProfile[i];
      const [x2, y2] = ceilingProfile[i + 1];
      if (cx >= x1 - 1e-6 && cx <= x2 + 1e-6) {
        return x2 === x1 ? y2 : y1 + ((cx - x1) / (x2 - x1)) * (y2 - y1);
      }
    }
    return last[1];
  };

  // QA C1→D1/D2: 建具記号丸(タグ)行・ROW1（壁芯間寸法行）の床線からの距離、ROW1→ROW2・
  // ROW2→通り芯丸行の行間。ctx未指定時（単体テスト等）はモジュール読み込み時に決め打ちできる
  // 仮既定値へフォールバックする。
  const openingTagRowY = openingTagRowModelMm ?? DEFAULT_OPENING_TAG_ROW_MM;
  const dimRow1Y       = dimRowGapModelMm ?? DEFAULT_DIM_ROW_GAP_MM;
  const gridRowGapMm   = gridRowGapModelMm ?? DEFAULT_GRID_ROW_GAP_MM;
  // ユーザー明示指示2026-08「展開図に寸法2段書きは不要」: 旧ROW2（通り芯間寸法の独立行）を
  // 廃止したぶん、通り芯丸の段を1行ぶん（gridRowGapMm）繰り上げる——寸法行と丸行の間隔は
  // 従来と同じgridRowGapMmのまま保つ（この値はユーザー調整済みの独立定数。倍数で導出しない）。
  const gridCircleRowY = dimRow1Y + gridRowGapMm;
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
    // 問題修正2026-08その6（ユーザー明示指示。実機の「C1」=段差見付け面）: 見付け面は
    // 低い側エリアを見込む展開図のため、天井断面はそのエリア自身の天井（ceilAbsMm=低い側FL+
    // 低い側の解決済みCH。例: 3'の帯のC1=3の展開図→3の天井）。旧実装の帯CH固定（-CH）だと
    // 低い側のFL・CH次第で誤った高さになる。ceilAbsMm未指定（単体テスト等の合成face）は
    // 従来どおり帯CHへフォールバック。
    const stepCeilY = -(face.ceilAbsMm ?? CH);
    prims.push({ type: 'line', x1: 0, y1: floorY, x2: run, y2: floorY, weight: stepCutWeight }); // 低い側床線
    prims.push({ type: 'line', x1: 0, y1: topY,   x2: run, y2: topY,   weight: stepSilhouetteWeight }); // 高い側床線(見付け上端。中線)
    // QA修正（ユーザー明示指示）: 両端縦線（壁断面=CUT）はtopY（見付け上端）で止めず天井まで
    // 描画する——見付け上端はあくまで段差先の床の見えがかり線であり、壁自体は天井まで続くため。
    prims.push({ type: 'line', x1: 0,   y1: floorY, x2: 0,   y2: stepCeilY, weight: stepCutWeight });
    prims.push({ type: 'line', x1: run, y1: floorY, x2: run, y2: stepCeilY, weight: stepCutWeight });
    prims.push({ type: 'line', x1: 0, y1: stepCeilY, x2: run, y2: stepCeilY, weight: stepCutWeight }); // 天井線
    // 問題修正2026-08その6: 高い側エリア（向こう側）の天井が天井断面より上にあれば、
    // 「床断面下・天井断面上の向こう側の断面は細線の破線」の既存規則どおり細線の破線で描く
    // （「C1の天井断面上+100に3'の天井を表す破線」——見付け面は部分指定関係のエリア同士の
    // 境界そのものなので、常に「またぐ面」に該当する）。
    if (face.beyondCeilAbsMm != null && -face.beyondCeilAbsMm < stepCeilY) {
      prims.push({
        type: 'line', x1: 0, y1: -face.beyondCeilAbsMm, x2: run, y2: -face.beyondCeilAbsMm,
        weight: stepDetailWeight, dash: 'dashed',
      });
    }
    // QA修正（ユーザー明示指示）: 見付け上端(topY)から天井までは壁が無く見通せるため、
    // 常にアキ（腰壁・垂れ壁と同じappendGapMark）を描く——旧実装はkneeDropGapsOnFace（腰壁・
    // 垂れ壁の明示指定がある軸だけ）にしか頼っておらず、指定が無い通常の段差見付け面では
    // アキが一切描かれない欠落があった（コミット5f8ec62で段差見付け面を新設した時点から
    // 一貫してこの欠落があり、後続のどのラウンドの変更にも起因しない）。
    appendGapMark(prims, { x: 0, y: stepCeilY, w: run, h: -stepCeilY + topY }, stepDetailWeight);
    for (const gap of kneeDropGapsOnFace(face, graph, CH)) {
      appendGapMark(prims, gap, stepDetailWeight);
    }
    appendAnnotationRows(prims, face, graph, {
      boundary, floorSegments: undefined, gridCLs, dimRow1Y, gridCircleRowY, faceLabelRowY,
      detailWeight: stepDetailWeight, faceLabelAvoidThresholdModelMm,
      // 注記一点鎖線の突き出し基準: この面で実際に描く最上位の水平線（天井断面・向こう側の破線）。
      CH: Math.max(face.ceilAbsMm ?? CH, face.beyondCeilAbsMm ?? -Infinity),
    });
    return prims;
  }

  // 床線・天井線・両端縦線（切断面＝太）。項目4: 部分指定（referenceRoomIds）が壁際の一部を占め
  // floorLevelが親と異なる区間があれば、床線は一直線ではなく段差付きの階段状polylineになる
  // （segs＝elevationFloorProfile.jsのwallAdjacentFloorSegments。buildRoomBand/buildStairBand
  // がctx.floorSegmentsとして渡す。未指定時=単体テスト等はフラット1区間へフォールバックし、
  // 常に従来どおりの床線1本になる）。天井線は問題修正2026-08で区間ごとのchMmに追従する
  // 段差付き描画になった（下の「天井断面線」ブロック参照。自CH指定なしの部分指定は項目5＝
  // roomCeilingHeightの調整で親と天井が揃うため、従来どおり水平1本になる）。
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
  // WP-E7 defer D2: ctx.floorSpanX（既定=未指定=現行の値そのまま）で床線・天井線の描画範囲を
  // クランプする。未指定時はMath.max/min自体が素通りするため現行と完全一致する。
  const drawnX0   = floorSpanX ? Math.max(hasWallAtLocal0   ? 0   : -extendMm, floorSpanX.lo)
                                : (hasWallAtLocal0   ? 0   : -extendMm);
  const drawnXRun = floorSpanX ? Math.min(hasWallAtLocalRun ? run : run + extendMm, floorSpanX.hi)
                                : (hasWallAtLocalRun ? run : run + extendMm);

  // 新仕様「段差位置のCLオフセット」: 内部境界（区間水平床線の端x・段差縦線x）は寸法・CL位置
  // （segs[i].hiX＝オフセット前）そのものではなく、床が低い側へ半壁厚ぶんずらした位置
  // （drawnRiserX）に描く——寸法線・CL一点鎖線側は従来どおりsegs[i].hiXのまま（elevation-model.md参照）。
  const halfWallMm = halfWallThicknessMm(face);
  const riserXAt = i => drawnRiserX(segs, i, halfWallMm);

  for (const [i, s] of segs.entries()) {
    // QA実機フィードバック修正: 区間の床線は既定で描くが、`s.hideFlatLine===true`の区間だけは
    // 描かない（段差縦線・注記等の他の処理には影響しない。既定値undefined=falsyのため
    // floorSegments未指定・既存呼び出しは完全無変化）。階段帯のレーン区間（段鼻の断面
    // ジグザグが同じ高さを既に表現している区間）で、床の水平線がジグザグの下を素通りして
    // 面の遠端まで貫通してしまう実機不具合の修正に使う（elevationStairSequence.js参照）。
    if (s.hideFlatLine) continue;
    const y = floorYOf(s);
    const x1 = i === 0 ? drawnX0 : riserXAt(i - 1);
    const x2 = i === segs.length - 1 ? drawnXRun : riserXAt(i);
    prims.push({ type: 'line', x1, y1: y, x2, y2: y, weight: cutWeight });
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    // 段差の縦線（明示指示により寸法線・寸法値は描かない）。床の段差そのものはCUT
    // （切断面＝部屋の輪郭そのものという既存慣習のまま。出隅の縦線とは別物）。
    // 問題修正2026-08: 区間の分割は天井高さ(chMm)の違いだけでも起きるため、床が同じ高さの
    // 境界には床の段差縦線を描かない（描くと長さ0の線が残る）。
    if (floorYOf(segs[i]) === floorYOf(segs[i + 1])) continue;
    const x = riserXAt(i);
    prims.push({
      type: 'line', x1: x, y1: floorYOf(segs[i]), x2: x, y2: floorYOf(segs[i + 1]),
      weight: cutWeight,
    });
  }
  const floorYAtStart = floorYOf(segs[0]);
  const floorYAtEnd   = floorYOf(segs[segs.length - 1]);

  // 天井断面線（問題修正2026-08）: 帯のCH1本の水平線ではなく、区間（エリア）ごとに
  // 「その区間の床断面（描画エリアFL）から、その区間の天井高さ(chMm)の距離」に描く。
  // CLをまたいで天井の絶対高さが異なる境界は段差＝縦線になり、その描画xは
  // 「低い方からみてCLの向こう側」＝天井が高い側へ半壁厚ずらした位置（drawnCeilingRiserX。
  // 床の段差のdrawnRiserX＝低い側へずらす、と対になる規約）。chMm未指定の区間
  // （単体テスト等の合成segs・floorSegments未指定のフラット1区間）は従来どおり帯のCH
  // （水平1本の天井線）へフォールバックする——実経路はwallAdjacentFloorSegmentsが常に
  // chMm（区間の所有Roomの解決済みCH。部分指定の自CH指定なしは親と天井が揃うよう
  // roomCeilingHeightが調整済み＝段差は明示CH指定時のみ現れる）を与える。
  const ceilAbsOf = s => (s.chMm != null ? s.floorDeltaMm + s.chMm : CH);
  const ceilYOf = s => -ceilAbsOf(s);
  // QA H1: 実際に描いたbeyondCeilings(bc)破線の最大天井高さを控え、注記一点鎖線の突き出し
  // 基準に含める（ceilingProfile有りの面ではbeyondCeilingsを描かないため-Infinityのまま）。
  let maxDrawnBcCeilAbs = -Infinity;
  // WP-2: ctx.ceilingProfileが（2点以上）指定されていれば、天井の水平線群＋天井段差縦線の
  // 代わりに1本のpolyline（CUT）で描く——beyondCeilings（別エリアの天井の破線）の処理は
  // ceilingProfile有りの面では対象外（スキップ）。profile未指定（空配列含む）の場合のみ現行の
  // 水平天井（区間別のchMmベース）へフォールバックする（例外を投げない）。
  // QA修正: 従来は「profileが面の描画範囲(drawnX0..drawnXRun)を覆っていること」も条件にしていたが、
  // 壁のない端部延長（wallLessEndExtendMm）で描画範囲がprofile範囲よりわずかに広がる本番設定では
  // 常にこの条件が偽になり勾配天井が一度も描かれない不具合があったため撤去した（範囲外はceilAbsAtX
  // 側のクランプで解決する）。
  const hasCeilingProfile = Array.isArray(ceilingProfile) && ceilingProfile.length >= 2;
  if (hasCeilingProfile) {
    const points = [[drawnX0, -ceilAbsAtX(drawnX0, CH)]];
    for (const [x, y] of ceilingProfile) {
      if (x > drawnX0 + 1e-6 && x < drawnXRun - 1e-6) points.push([x, -y]);
    }
    points.push([drawnXRun, -ceilAbsAtX(drawnXRun, CH)]);
    prims.push({ type: 'polyline', points, weight: cutWeight });
  } else {
    const ceilRiserXAt = i => drawnCeilingRiserX(segs, i, halfWallMm, CH);
    // 天井の絶対高さが同じ隣接区間は1本の水平線に結合する（床だけの段差では天井線を分割しない）。
    // 新仕様（ユーザー明示指示）: **高低差のある、階の異なる水平な天井断面線は結ばない**。
    // 区間ごとの`ceilFloorZMm`（その区間の天井が属する階の床レベル。既定=0＝自階。上部吹抜けの
    // 多層書きだけが上階の値を入れる。elevationVoid.js）が違う隣り合う天井線は、段差の縦線で
    // 繋がずそれぞれ独立した断面線として描く——別の階の天井どうしを1本の輪郭で結ぶと、実際には
    // その境界に立っている壁の断面（断面エンジンが描く）と二重の縦線になり、しかも壁厚を持たない
    // 1本線なので「何の線か」が図から読み取れなくなる。
    const ceilStoreyOf = s => s.ceilFloorZMm ?? 0;
    const ceilRuns = [];
    for (const [i, s] of segs.entries()) {
      const y = ceilYOf(s), storey = ceilStoreyOf(s);
      const last = ceilRuns[ceilRuns.length - 1];
      if (last && last.y === y && last.storey === storey) last.endIdx = i;
      else ceilRuns.push({ y, storey, startIdx: i, endIdx: i });
    }
    // 隣り合う天井線が別の階のものなら、段差の縦線を描かず、境界の描画xも半壁厚ずらさない
    // （ずらす規約は段差の縦線を「低い方からみてCLの向こう側」へ置くためのもの。縦線を描かない
    // なら区間の境界そのもの＝その位置に立つ壁の面で終わらせる）。
    const crossesStorey = ri => ri + 1 < ceilRuns.length && ceilRuns[ri].storey !== ceilRuns[ri + 1].storey;
    // 問題修正2026-08その3（ユーザー明示指示: C1の天井断面上+100に「3'」の天井を表す破線。
    // A1/B1/D2には不要）: 天井断面より上に見える「別エリアの天井」（親の天井等。境界の
    // 下がり壁の縁）は、その面のrun軸に投影した実セル範囲（ctx.beyondCeilings＝
    // familyCeilingSegments）と天井断面が実際に重なる区間だけへ、細線の破線で描く——
    // 「床断面より下・天井断面より上の向こう側の断面は細線の破線」（その2）の既存規則の天井側。
    // 旧実装（その2）の「帯CHと区間CHの比較だけで面全域にy=-CHの中線実線を引く」ヒューリス
    // ティックは、当該エリアが実際にはその面の向こうに無い面（A1/B1/D2）へも誤って線を出し、
    // 線種も既存規則（細線の破線）に反していたため撤回した。開放スパン区間はfar天井線
    // （spansのfarCeilAbsMm）の管轄のため差し引く。天井断面と同じ高さ・断面より下のエリアは
    // 描かない（明示指示の範囲外——類似規則への拡張は明示指示がある場合のみ行う既存方針）。
    const beyondCeilings = ctx.beyondCeilings ?? [];
    const openRangesForCeil = (face.spans ?? []).filter(s => s.kind === 'open').sort((a, b) => a.loX - b.loX);
    // QA H3: 差し引くのは「同じ高さのfar天井線が既に描かれる」開放
    // スパンだけ——開放先のさらに奥にある、より高いファミリー天井(bc)は開放スパン上にも描く
    // （壁区間との情報量の非対称を作らない）。farCeilAbsMm未指定（旧形式spans）はfar天井線
    // 自体が描かれないため差し引かない（二重描画の回避だけが差し引きの目的）。
    const subtractOpenRanges = (lo, hi, ceilAbsMm) => {
      const pieces = [];
      let cursor = lo;
      for (const o of openRangesForCeil) {
        if (o.farCeilAbsMm !== ceilAbsMm) continue;
        if (o.hiX <= lo || o.loX >= hi) continue;
        if (o.loX > cursor) pieces.push([cursor, Math.min(o.loX, hi)]);
        cursor = Math.max(cursor, o.hiX);
      }
      if (cursor < hi) pieces.push([cursor, hi]);
      return pieces;
    };
    const ceilBoundaryX = ri => (crossesStorey(ri) ? segs[ceilRuns[ri].endIdx].hiX : ceilRiserXAt(ceilRuns[ri].endIdx));
    for (const [ri, r] of ceilRuns.entries()) {
      const x1 = ri === 0 ? drawnX0 : ceilBoundaryX(ri - 1);
      const x2 = ri === ceilRuns.length - 1 ? drawnXRun : ceilBoundaryX(ri);
      prims.push({ type: 'line', x1, y1: r.y, x2, y2: r.y, weight: cutWeight });
    }
    // 別エリア天井の破線は「論理区間（segs）」基準で天井断面と比較する——描画済みrun範囲
    // （天井段差の描画x＝±半壁厚オフセット後）と比較すると、bcの境界（論理CL値）と天井段差の
    // 論理境界が一致する面（縦面のB/D等）で、オフセット差ぶん（半壁厚≒57.5mm）の偽の破線
    // スリバーが必ず生じるため（実際に発生・修正した）。
    // QA H2: bcごとに断片を集めて「接する区間」をマージしてから1本ずつ積む——segs境界（天井が
    // 同じで床だけ違う隣接区間）で分割したまま積むと、座標は連続でも破線パターンの位相が中間で
    // 再スタートし「破線同士の角は必ず破線の交点」の既存配慮（belowFloorEdge参照）に反する。
    for (const bc of beyondCeilings) {
      const pieces = [];
      for (const seg of segs) {
        if (bc.ceilAbsMm <= ceilAbsOf(seg)) continue;
        const lo = Math.max(bc.loX, seg.loX, 0);
        const hi = Math.min(bc.hiX, seg.hiX, run); // 壁のない端部の延長は対象外
        if (hi - lo <= 0) continue;
        pieces.push(...subtractOpenRanges(lo, hi, bc.ceilAbsMm));
      }
      pieces.sort((a, b) => a[0] - b[0]);
      const mergedPieces = [];
      for (const [a, b] of pieces) {
        const last = mergedPieces[mergedPieces.length - 1];
        if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
        else mergedPieces.push([a, b]);
      }
      for (const [a, b] of mergedPieces) {
        prims.push({ type: 'line', x1: a, y1: -bc.ceilAbsMm, x2: b, y2: -bc.ceilAbsMm, weight: detailWeight, dash: 'dashed' });
        maxDrawnBcCeilAbs = Math.max(maxDrawnBcCeilAbs, bc.ceilAbsMm);
      }
    }
    for (let ri = 0; ri + 1 < ceilRuns.length; ri++) {
      if (crossesStorey(ri)) continue; // 階の異なる天井断面線は結ばない（上記の新仕様）
      const x = ceilRiserXAt(ceilRuns[ri].endIdx);
      prims.push({ type: 'line', x1: x, y1: ceilRuns[ri].y, x2: x, y2: ceilRuns[ri + 1].y, weight: cutWeight });
    }
  }
  // 端の縦線（中線）: 壁がある端（出隅・入隅）に加え、見えがかりエッジ（edgeAtLocal0/Run＝
  // 実壁が切断面を横切らず向こう側へ折れて続く凹み角。ユーザー明示指示2026-08）にも描く——
  // 壁断面は無いが角のエッジ自体は見えるため。エッジ端は壁のない端部でもあるので、
  // 床・天井線の延長（drawnX0/drawnXRun）はそのまま併用される（縦線の外側へ続きがある表現）。
  const edgeAtLocal0   = face.edgeAtLocal0   ?? false;
  const edgeAtLocalRun = face.edgeAtLocalRun ?? false;
  // 問題修正2026-08: 端の縦線の上端は帯のCH固定ではなく、その端の区間の実際の天井y
  // （ceilYOf。天井断面線と同じ基準）まで描く。WP-2: ceilingProfile有りの面ではceilAbsAtXが
  // 補間値を返す（未指定・範囲外はceilYOf(segs[0]/segs[last])のまま＝現行同値）。
  if (hasWallAtLocal0 || edgeAtLocal0) {
    prims.push({ type: 'line', x1: 0,   y1: -ceilAbsAtX(0, ceilAbsOf(segs[0])), x2: 0,   y2: floorYAtStart, weight: silhouetteWeight });
  }
  if (hasWallAtLocalRun || edgeAtLocalRun) {
    prims.push({ type: 'line', x1: run, y1: -ceilAbsAtX(run, ceilAbsOf(segs[segs.length - 1])), x2: run, y2: floorYAtEnd, weight: silhouetteWeight });
  }

  // アキ（腰壁＋垂れ壁の同時指定でできる四角い穴）の標記は**断面エンジンの責務**へ移した
  // （section/sectionEmit.js の emitOpenGapMarks）——面図側は「腰壁・垂れ壁の指定がある区間」
  // しか知らないが、実際に抜けているかは他階・遮蔽まで見ないと決まらない。
  // 下の壁2段書きの回避範囲だけは、描画ではなく**配置の都合**として指定を読み続ける
  // （エンジンの出力はこの関数の後に積まれるため、ここからは見えない）。
  // face.lo/hiの位置(x)を含むfloorSegments（segs）の区間のfloorDeltaMm・天井絶対高さを返す
  // （無ければ親扱い=0/帯のCH。開放スパンの遠側床線・境界エッジ・アキ描画が「近側の床・天井の
  // 高さ」を求めるのに使う共通ヘルパ）。
  const nearSegAt = x => segs.find(s => x >= s.loX - 1e-6 && x <= s.hiX + 1e-6);
  const nearDeltaAt = x => nearSegAt(x)?.floorDeltaMm ?? 0;
  const nearCeilAbsAt = x => { const seg = nearSegAt(x); return seg ? ceilAbsOf(seg) : CH; };

  // 新仕様「開放スパン」（elevationOpenSpan.js。face.spans）: 壁のある区間の先に続く、同室内部の
  // 壁の無い開放区間の描画。壁区間はここまでの床線・天井線・両端縦線で既に表現済みのため、
  // ここではopen区間（kind==='open'）だけを追加で描く。
  //   1. 遠側床線: near側（segs＝wallAdjacentFloorSegments）の床yと開放先(farFloorDeltaMm)の
  //      床yが異なる場合だけ、開放先の床の高さで水平線を引く。far側の方が低い（見下ろす方向＝
  //      床断面より下にある向こう側の断面）場合は細線の破線（ユーザー明示指示2026-08:
  //      「床断面より下、または天井断面より上にある展開面の向こう側の断面は、細線の破線」。
  //      見上げる方向・床〜天井の間に見える線は従来どおりSILHOUETTE実線）。
  //   2. 上部あき: `appendGapMark`（段差見付け面のアキと共用）で天井から遠側床までの範囲へ
  //      バツと「ア キ」を描く（輪郭の矩形は描かない。appendGapMarkのヘッダ参照）。
  //   3. 境界エッジ: open区間の両端のうち隣がwall側（区間 or 面端）ならSILHOUETTE縦線を引く
  //      （far側の方が低ければ破線。ユーザー明示指示）。床断面より下の部分（near床〜far床）は
  //      1と同じ細線の破線で継ぎ足す——端点をfar床線と厳密に一致させ、破線同士の角が必ず
  //      交点で接続するようにする（ユーザー明示指示: 「端部の縦線共（破線同士の角は必ず
  //      破線の交点）」）。
  const spans = face.spans ?? [];
  // ユーザー実機指摘2026-08: 開放スパンの**内部**境界の描画xは、CL位置ではなくその境界に立つ
  // 直交壁の「開放側の面」（壁厚×1/2ぶん開放側。偏芯込み＝drawnSpanBoundaryX）。実際の抜けは
  // 壁の面から始まるため、CLで切ると開口を半壁厚ぶん広く描いてしまう。
  // **面端（i===0のlo・最終spanのhi）はオフセットしない**——そこは既にsnapFaceEndsToCornersが
  // 直交壁の仕上げ面へ詰め済みで、二重にずらすことになる（実機で指摘のあった5箇所は
  // すべて内部境界だった）。
  const drawnSpans = drawnSpanRanges(face, graph);
  for (let i = 0; i < spans.length; i++) {
    const s = { ...spans[i], ...drawnSpans[i] };
    if (s.kind !== 'open') continue;
    const farDelta = s.farFloorDeltaMm ?? 0;
    const nearDelta = nearDeltaAt((s.loX + s.hiX) / 2);
    // QA修正（ユーザー明示指示）: 開放先の床がnear側より低い（見下ろす方向）場合、遠側床線・
    // 境界縦線を破線にする（見えがかりの隠れ線表現）。従来の一律SILHOUETTE実線から変更。
    const looksDown = farDelta < nearDelta;
    const dashOpt = looksDown ? { dash: 'dashed' } : {};
    // near床のy（-0を0へ正規化。floorYOfと同じ規約——-0は等値比較・テストの落とし穴になるため）
    const nearFloorYAt = x => { const d = nearDeltaAt(x); return d ? -d : 0; };
    if (farDelta !== nearDelta) {
      // 床断面（near床）より下に見える遠側床線は細線（見上げ方向は従来どおり中線）
      prims.push({
        type: 'line', x1: s.loX, y1: -farDelta, x2: s.hiX, y2: -farDelta,
        weight: looksDown ? detailWeight : silhouetteWeight, ...dashOpt,
      });
    }
    // アキ標記の範囲は近側床（床断面）までにクランプする——建築的に、あき＝壁面の抜けは
    // 立っている近側の床までで、その下は床の落差の見えがかりだから（far床まで伸ばすと、
    // 床断面下の細破線＝遠側床線・床下縦線の領域までバツが入り込む）。
    // 見上げ方向は従来どおりfar床まで（far床の方が高い＝あきはそこで終わる）。
    // 問題修正2026-08: 上端は帯のCH固定ではなく、その区間の実際の天井（天井断面線と同じ基準）。
    // 問題修正2026-08その2: 開放先の天井(farCeilAbsMm)が近側の天井より低い場合、あき＝壁面の
    // 抜けとして見えるのは開放先の天井まで（その上は境界の下がり壁の見えがかり）のため、
    // far天井へもクランプする（床側の「近側床までにクランプ」と対の規約）。
    // WP-2: アキ上端（近側天井）もceilAbsAtX経由——ceilingProfile未指定・範囲外は
    // nearCeilAbsAtの値のまま（現行同値）。
    const spanMidX = (s.loX + s.hiX) / 2;
    const spanCeilAbs = ceilAbsAtX(spanMidX, nearCeilAbsAt(spanMidX));
    const farCeilAbs = s.farCeilAbsMm ?? spanCeilAbs; // 未指定（単体テスト等）は近側と同じ＝従来挙動
    const gapTop = Math.min(spanCeilAbs, farCeilAbs);
    const gapH = gapTop - Math.max(farDelta, nearDelta);
    // ユーザー実機指摘2026-08（「5」C2: X2上のエッジ線・アキ・バツが不要／床天井の延長はこのままで
    // 良い）: **開放スパンが「壁のない端部」に接している場合はアキ標記を描かない**。
    // その端は既に床線・天井線の延長で「続きがある」ことを表しており、同じ場所へアキを重ねると
    // 二重表現になる（かつては`appendGapMark`が矩形も積んでいたため、その辺が面端ちょうどに
    // 縦線として現れ、実機では「X2上のエッジ線」に見えていた——矩形は後に廃止したが、
    // 「壁のない端部にアキを重ねない」というこの判定自体は今も要る）。
    // 反対側が壁で閉じている開放スパン（室が自分自身へ回り込む内部の抜け等）は従来どおり
    // アキを描く——実機の他の面（10/B2・10/C2・10/D1・11'/A2・5/D1）はすべてこちらで、
    // 診断ログでもアキが壁のない端部に接するのは指摘のあった面だけだった。
    const touchesWallLessEnd =
      (!hasWallAtLocal0 && Math.abs(s.loX) < SPLIT_MERGE_EPS_MM) ||
      (!hasWallAtLocalRun && Math.abs(s.hiX - run) < SPLIT_MERGE_EPS_MM);
    if (gapH > 0 && !touchesWallLessEnd) {
      appendGapMark(prims, { x: s.loX, y: -gapTop, w: s.hiX - s.loX, h: gapH }, detailWeight);
    }
    const prevIsWall = i > 0 ? spans[i - 1].kind === 'wall' : hasWallAtLocal0;
    const nextIsWall = i < spans.length - 1 ? spans[i + 1].kind === 'wall' : hasWallAtLocalRun;
    // 問題修正2026-08その2（ユーザー明示指示: 「3'」のA2, 1200の天井に「3」の天井の見えがかり線
    // （中線））: 開放先の天井が近側の天井断面と異なる高さなら、開放先の天井線を描く——
    // 床〜天井断面の間に見える（far天井が低い）場合はSILHOUETTE実線（中線）、天井断面より上に
    // ある（far天井が高い）場合は「向こう側の断面は細線の破線」の既存規則（ユーザー明示指示
    // 2026-08その2の未実装分）どおりDETAILの破線＋端部縦線（near天井〜far天井）を継ぎ足す
    // （床側のbelowFloorEdgeと同じく、角=far天井側を始点にして破線同士の角を交点にする）。
    if (farCeilAbs !== spanCeilAbs) {
      const aboveCeil = farCeilAbs > spanCeilAbs;
      // 旧QA G2は「far天井が低くアキ矩形が出る場合、矩形の上辺が同座標・同weightの線になるため
      // far天井線を積まない」という抑止だったが、アキ標記から矩形を廃止した（ユーザー明示指示
      // 「矩形をやめて」）ため撤回する——抑止を残すとfar天井の見えがかり線が誰にも描かれない。
      prims.push({
        type: 'line', x1: s.loX, y1: -farCeilAbs, x2: s.hiX, y2: -farCeilAbs,
        weight: aboveCeil ? detailWeight : silhouetteWeight, ...(aboveCeil ? { dash: 'dashed' } : {}),
      });
      if (aboveCeil) {
        const aboveCeilEdge = x => ({
          type: 'line', x1: x, y1: -farCeilAbs, x2: x, y2: -nearCeilAbsAt(x),
          weight: detailWeight, dash: 'dashed',
        });
        if (prevIsWall) prims.push(aboveCeilEdge(s.loX));
        if (nextIsWall) prims.push(aboveCeilEdge(s.hiX));
      }
    }
    // 床断面より下の縦線（far床〜near床。遠側床線と同じ細線の破線）。角＝far床側を始点に
    // することで、破線の位相が角から始まり「破線同士の角は必ず破線の交点」になる
    // （破線パターンは線の始点から刻まれるため、角を始点にしないと線長次第で角がギャップに落ちる）。
    const belowFloorEdge = (x) => ({
      type: 'line', x1: x, y1: -farDelta, x2: x, y2: nearFloorYAt(x),
      weight: detailWeight, dash: 'dashed',
    });
    if (prevIsWall) {
      prims.push({ type: 'line', x1: s.loX, y1: nearFloorYAt(s.loX), x2: s.loX, y2: -nearCeilAbsAt(s.loX), weight: silhouetteWeight, ...dashOpt });
      if (looksDown) prims.push(belowFloorEdge(s.loX));
    }
    if (nextIsWall) {
      prims.push({ type: 'line', x1: s.hiX, y1: nearFloorYAt(s.hiX), x2: s.hiX, y2: -nearCeilAbsAt(s.hiX), weight: silhouetteWeight, ...dashOpt });
      if (looksDown) prims.push(belowFloorEdge(s.hiX));
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
  // WP-2: ctx.skipBaseboard（既定false）指定時は巾木ブロック自体を実行しない（階段帯等、
  // 巾木表現が不要な帯からの呼び出し用）。
  if (!skipBaseboard && baseboardH != null && baseboardH < CH) {
    // 新仕様「開放スパン」: open区間は壁が無い＝巾木も存在しないため、開口と同じ「途切れさせる
    // 区間」として扱う（既存floorGapsへ足すだけ）。
    const floorGaps = [
      ...openings
        .filter(o => (o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0) === 0)
        .map(o => {
          const localX = localXOf(face, o.centerCoord);
          return [Math.max(0, localX - o.width / 2), Math.min(run, localX + o.width / 2)];
        }),
      // 巾木は**描画**要素のため、open区間の範囲もCL基準(spans)ではなく描画基準
      // （drawnSpans＝境界に立つ実壁の「開放側の面」。床線・境界エッジと同じ）を使う
      // ——CL基準だと巾木がCLで切れ、CLと壁面の間（半壁厚）に巾木の無い隙間ができる
      // （ユーザー実機指摘2026-08その9:「22」A1のX3・「22」D2の2000CLとも
      // 「CL右側の壁まで」＝壁の面まで巾木を伸ばすのが正）。
      ...spans.map((s, i) => ({ ...s, ...drawnSpans[i] }))
        .filter(s => s.kind === 'open').map(s => [s.loX, s.hiX]),
    ].sort((a, b) => a[0] - b[0]);
    for (const [i, s] of segs.entries()) {
      const y = floorYOf(s) - baseboardH;
      // 新仕様「段差位置のCLオフセット」: 内部境界はriserXAt（床が低い側へ半壁厚ずらした位置）を使う。
      // **面の端は床線と同じ描画基準（drawnX0/drawnXRun）を使う**——壁のない端部では床線・
      // 天井線と同じだけ図の外へはね出す（ユーザー実機指摘2026-08「「5」D1・B1: 1階巾木、
      // CLで終わらず、開いている壁にはね出し」）。s.loX/s.hiX は論理境界（CL）なので、
      // そのまま使うと巾木だけがCLで止まり、はね出した床線との間に段が付く。
      const segLo = i === 0 ? drawnX0 : riserXAt(i - 1);
      const segHi = i === segs.length - 1 ? drawnXRun : riserXAt(i);
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
      if (floorYOf(segs[i]) === floorYOf(segs[i + 1])) continue; // 天井高さ違いだけの境界に床段差は無い
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
  // WP-2: ctx.skipWallLabel（既定false）指定時は壁2段書きブロック自体を実行しない。
  if (!skipWallLabel && wallLabelLines.length > 0) {
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
        // 問題修正2026-08(QA F4): 床段差の無い（chMmだけ異なる）境界には縦線が描かれないため
        // 障害物にも積まない（積むと存在しない線を避けてラベルが偏る）。
        ...segs.slice(0, -1).flatMap((s, i) =>
          floorYOf(segs[i]) === floorYOf(segs[i + 1]) ? [] : [{ lo: riserXAt(i), hi: riserXAt(i) }]),
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

  // 追加仕様2026-08「2.5D仕様の展開ロジックを全ての展開図に適用」: 2.5D立体の加算レイヤ
  // （構造柱の柱型・梁型。elevationSolids.js）。ctx.solids未指定（既定＝階段帯・単体テスト・
  // ゴールデンゲート）は空配列のため出力は完全に不変。注記帯より前に積むのは、注記帯の
  // 一点鎖線・寸法・丸番号を構造材の線で隠さないため（Konvaは配列の後ろほど手前）。
  if (solids) {
    for (const p of solidPrimitivesForFace(face, { graph, ceilingHeight: CH, ...solids })) prims.push(p);
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
  // 問題修正2026-08その4改: 「床側起点高さが変わる面のCH寸法」は面の左側＝帯レイアウト
  // （elevationBand.jsのlayoutBandFaces。直前の面の右端と比較）が担当する。ここ（右側）は
  // 従来どおり段差のある面（segs.length>1）のみ。
  // 階段帯（ユーザー明示指示2026-08その12）: chDimChainsを渡す帯ではCH寸法の判断を
  // 呼び出し側（stairChDimChains）が一括で持つため、ここでの面ごとの右CH寸法は描かない
  // ——段差の有無ではなく「端の断面プロファイルが前の端から変わったか」で決まるため。
  if (segs.length > 1 && !ctx.chDimChains) {
    const rightSeg = segs[segs.length - 1];
    const rightChDimX = boundary.hi + CH_DIM_OFFSET_MM;
    const rightFloorY = floorYOf(rightSeg);
    // 問題修正2026-08: 値・上端は「右端区間の実際の床〜天井」（天井断面線と同じ基準）。
    // chMm未指定のフラット天井では従来どおり天井絶対高(CH)−右端区間FLになる。
    prims.push({
      // 足はCLに触れず手前で止める（ユーザー明示指示2026-08その13。展開図で統一）。
      type: 'dim', dir: 'v', at: rightChDimX, from: ceilYOf(rightSeg), to: rightFloorY,
      foot: boundary.hi + Math.min(ctx.dimFootGapModelMm ?? DEFAULT_DIM_FOOT_GAP_MM, CH_DIM_OFFSET_MM), dot: true,
      label: Math.round(ceilAbsOf(rightSeg) - rightSeg.floorDeltaMm),
    });
  }

  // 問題修正2026-08: 注記の縦一点鎖線（壁中心線・通り芯）の上端は「天井線より上へ突き出す」
  // 仕様のため、面内で最も高い天井（区間ごとのchMmを反映した天井絶対高さの最大）を基準にする
  // ——帯のCH固定のままだと、CH指定で持ち上がった区間の天井線を突き抜けない。
  // QA G3: 帯CH自体も最大値の候補に含める（帯CHの高さの線が描かれ得るため）。
  // QA H1: 実際に描いた別エリア天井の破線（beyondCeilings）の最大も含める——bc破線が
  // 最上位の水平線になる面で、一点鎖線が線より下で止まらないようにする（描かなかったbcまで
  // 含めると余白が過剰になるため、pushループで控えた実描画の最大値=maxDrawnBcCeilAbsを使う）。
  // WP-2: ceilingProfile自体の最大天井高さも候補に含める（未指定時は-Infinityのため無効=現行同値）。
  const ceilProfileMaxAbs = Array.isArray(ceilingProfile) && ceilingProfile.length > 0
    ? Math.max(...ceilingProfile.map(p => p[1])) : -Infinity;
  appendAnnotationRows(prims, face, graph, {
    boundary, floorSegments: segs, gridCLs, dimRow1Y, gridCircleRowY, faceLabelRowY,
    detailWeight, faceLabelAvoidThresholdModelMm, extraCenterLineXs,
    CH: Math.max(CH, ...segs.map(ceilAbsOf), maxDrawnBcCeilAbs, ceilProfileMaxAbs),
  });

  return prims;
}

/**
 * 注記帯（寸法の鎖1行・通り芯丸+ラベル・面ラベル）をprimsへ積む
 * （新仕様。通常面・段差見付け面(kind==='step')の両方から共通で呼ぶ——見付け面は
 * floorSegments未指定（S1の段差CL源が無い）で呼ばれる。開口・巾木・壁2段書きは対象外
 * ＝呼び出し元がkind==='step'なら別途スキップする）。
 * @param {object[]} prims
 * @param {object} face
 * @param {object} graph
 * @param {{boundary:{lo:number,hi:number}, floorSegments?:Array, gridCLs?:object[],
 *   dimRow1Y:number, gridCircleRowY:number, faceLabelRowY:number,
 *   detailWeight:string, faceLabelAvoidThresholdModelMm?:number, CH:number}} opts
 */
function appendAnnotationRows(prims, face, graph, opts) {
  const {
    boundary, floorSegments, gridCLs, dimRow1Y, gridCircleRowY, faceLabelRowY,
    detailWeight, faceLabelAvoidThresholdModelMm, CH, extraCenterLineXs,
  } = opts;

  // 面を貫く通り芯（寸法の鎖の分割点＝S5・一点鎖線・丸番号の共通の源）。
  const gridPoints = gridCLsOnFace(face, gridCLs ?? [], gridWorldRange(face, boundary))
    .map(cl => ({ x: localXOf(face, cl.effectiveValue), label: cl.label }))
    .sort((a, b) => a.x - b.x);

  // 寸法行（1行のみ。ユーザー明示指示2026-08「展開図に寸法2段書きは不要」——旧ROW2＝通り芯間
  // 寸法の独立行は廃止し、通り芯を鎖の分割点（S5）として取り込んだ。「壁幅が通り芯をまたぐ場合は
  // 通り芯から」も、両端が壁中心線・内部の分割点が通り芯というこの鎖1本で満たされる）。
  // 分割源は段差CL・面へ到達する直交壁（袖壁等）・開放スパンの内部境界・通り芯の4源
  // （collectRow1SplitPoints）。
  const centerLineTopY = -CH - GRID_LINE_ABOVE_CH_MM;
  const dimSplitXs = collectRow1SplitPoints(face, graph, {
    floorSegments, boundary, spans: face.spans, gridXs: gridPoints.map(g => g.x),
  });
  const row1Marks = [boundary.lo, ...dimSplitXs, boundary.hi];
  for (const x of row1Marks) {
    const onGrid = gridPoints.some(g => Math.abs(g.x - x) <= SPLIT_MERGE_EPS_MM);
    if (onGrid) continue; // 通り芯の一点鎖線（下のループ）と重複させない
    prims.push({ type: 'line', x1: x, y1: centerLineTopY, x2: x, y2: dimRow1Y, dash: 'center', weight: detailWeight, dashAnchor: dimRow1Y });
  }
  for (let i = 0; i + 1 < row1Marks.length; i++) {
    prims.push({
      type: 'dim', dir: 'h', at: dimRow1Y, from: row1Marks[i], to: row1Marks[i + 1], dot: true,
      label: Math.round(row1Marks[i + 1] - row1Marks[i]),
    });
  }

  // 呼び出し側が明示指定する追加の中心線（ローカルx）。**一点鎖線だけを描き、寸法の鎖は分割しない**
  // （ユーザー実機指摘2026-08「6」C「1500の一点鎖線が出ていない」）。
  // 用途: 階段帯の往復間の壁の芯——この壁は切断線から見て**面の裏側**へ伸びるため、
  // `collectRow1SplitPoints`の直交壁検出（室内側へMIN_PROJECTION_MM以上突出する袖壁が対象）に
  // 掛からず、一点鎖線の源が1つも無かった。寸法を分割しないのは、以前「1500と1000の間のCLは
  // どこからきたのか」と指摘された寸法鎖への副作用を避けるため（線だけという明示指示に従う）。
  for (const x of extraCenterLineXs ?? []) {
    const dup = gridPoints.some(g => Math.abs(g.x - x) <= SPLIT_MERGE_EPS_MM)
      || row1Marks.some(m => Math.abs(m - x) <= SPLIT_MERGE_EPS_MM);
    if (dup) continue;
    prims.push({ type: 'line', x1: x, y1: centerLineTopY, x2: x, y2: dimRow1Y, dash: 'center', weight: detailWeight, dashAnchor: dimRow1Y });
  }

  // 通り芯縦一点鎖線＋丸番号（寸法行のさらに下＝gridCircleRowY。QA G4: 寸法行とは別の段）。
  // 調整項目3: 下端(gridCircleRowY)だけでなく天井線(-CH)より上へも少し突き出す
  // （y1=-CH-GRID_LINE_ABOVE_CH_MM。通り芯は本来、床から天井を貫通して続く線のため）。
  for (const g of gridPoints) {
    // 通り芯の縦線は**寸法行を境に2本へ分ける**（ユーザー明示指示2026-08その10）。
    //   上（天井上〜寸法行）: 一点鎖線。dashAnchorで位相を寸法行へ合わせ、寸法線との交点に
    //     必ずインクが乗るようにする（figurePrimitivesKonva.js / dashPhase.js 参照）。
    //   下（寸法行〜丸番号）: **実線**。ここを一点鎖線のまま通すと、(a)寸法行が破線の
    //     すき間に当たって交点が消える (b)丸の手前で破線が切れて「丸とCLが離れて見える」
    //     の2つが起きる。丸の位置（gridCircleRowY）は変えず、線分の描き方だけで解決する
    //     ——丸は背景色で塗って線の上に重なるため、実線を丸の中心まで引けば丸の縁に接する。
    prims.push({
      type: 'line', x1: g.x, y1: -CH - GRID_LINE_ABOVE_CH_MM, x2: g.x, y2: dimRow1Y,
      dash: 'center', weight: detailWeight, dashAnchor: dimRow1Y,
    });
    prims.push({ type: 'line', x1: g.x, y1: dimRow1Y, x2: g.x, y2: gridCircleRowY, weight: detailWeight });
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
