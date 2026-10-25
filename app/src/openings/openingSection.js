/**
 * 建具の**断面**の描き方（ユーザー明示指示2026-09「建具の断面描画方法：各建具が断面の描画方法を
 * 所持する」）。展開図で建具が仮想断面に切られたときに描く、枠と扉の断面の唯一の情報源。
 *
 * - 建具ごとの描き方は**カタログの種別（subType）に紐づく**（`SECTION_METHODS`）。指定の無い
 *   建具は従来の描き方（`legacyStrip`）のままで挙動不変。
 * - 寸法は**平面記号と同じ定数**（`openingPlanSymbolGeometry.js`）を引く——枠見付30・戸当たり10・
 *   扉厚30。「平面に指定があるので参照のこと」（同指示）。二重管理を作らない。
 * - **LODで分岐しない**（省略・一般・詳細とも同じ描き方。同指示）。`viewport.js`のLodLevelは見ない。
 *
 * 座標系: 呼び出し側が「帯の起点x0」「伸びる向き dir(+1/-1)」「床のz=0」を与える。返す矩形は
 * 図のローカル座標（yは上向き負）。
 */
import { effectiveHeight, effectiveFrameProjection, fixtureSymbolOf } from './openingNumbering.js';
import { OpeningCategory } from '@core';
import { graphList } from '../graphReadScope.js';
import { rect as rectPrim, line as linePrim, polyline as polylinePrim } from '../elevation/elevationPrimitives.js';
import { findCatalogEntry, frameProfileFor, OpeningMechanism } from './openingCatalog.js';
import { findHostWall, wallFaceRange } from './openingGeometry.js';
import { frameOnlyInnerRect } from './openingElevationFigure.js';
import {
  FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM, DOOR_LEAF_THICKNESS_MM, FRAME_OVERHANG_MM,
  swingOpenPerpDir, frameOnlyPerpRange, frameOnlyJambProfiles,
} from './openingPlanSymbolGeometry.js';

// 従来の断面帯（枠40＋扉40＋枠40）。描き方の指定が無い建具はこのまま。
const LEGACY_FRAME_W = 40;
const LEGACY_LEAF_TH = 40;

/** 扉の下端（FLからの逃げ）。ユーザー明示指示2026-09「下はFL10」。 */
export const DOOR_LEAF_BOTTOM_MM = 10;

// 壁厚が引けないとき（合成face・単体テスト）の見込のフォールバック。
const FALLBACK_WALL_THICKNESS_MM = 115;

/**
 * その建具が入っている壁の**層厚**(mm)。同じ通り（軸CL）で建具の位置を覆う実壁の材の範囲の
 * 合併幅——枠の見込はこれで決まる（ユーザー明示指示2026-09「枠全体の見込みは、壁厚で調整する。
 * 具体的には壁厚+24」）。引けなければnull。
 * @param {import('@core').Opening} o
 * @param {object|null} graph
 * @returns {number|null}
 */
export function wallMaterialRangeForOpening(o, graph) {
  if (!graph || !o?.axisCL) return null;
  let lo = Infinity, hi = -Infinity;
  for (const w of graphList(graph, 'walls') ?? []) {
    if (w.isVertical !== o.isVertical || w.axisCL?.id !== o.axisCL.id) continue;
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    if (o.centerCoord < c1 || o.centerCoord > c2) continue;
    if (!w.materialRange) continue;
    lo = Math.min(lo, w.materialRange.lo);
    hi = Math.max(hi, w.materialRange.hi);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/**
 * その建具が**開く側**（±1。壁の厚み方向の世界座標が増える側なら+1）。扉はこの側の壁面で
 * 閉じる（蝶番もその面にある）ので、断面の扉はその面に寄る——平面の閉じた扉の四角
 * （`swingClosedLeafSpan`／`planSymbolPlan`の`leafOutward`）と同じ導出を使う。
 * @param {import('@core').Opening} o
 * @returns {1|-1|0}
 */
export function openingOpenPerpDir(o) {
  const entry = findCatalogEntry(o?.category, o?.subType);
  if (!entry) return 0;
  return swingOpenPerpDir(o.isVertical, o.hingeSide, o.swingSide, entry.mechanism, entry);
}

/**
 * その建具の断面帯の全幅(mm)。呼び出し側が帯の配置（面端からの伸び・壁厚の中央寄せ）を
 * 決めるために先に引ける。
 * @param {import('@core').Opening} o
 * @returns {number}
 */
export function openingSectionWidthMm(o, opts = {}) {
  const method = methodFor(o);
  if (method === 'legacy') return LEGACY_FRAME_W * 2 + LEGACY_LEAF_TH;
  // 枠の見込＝壁の層厚＋出しぶん（室内外へ出幅ずつ）。片開き戸は 12 固定＝壁厚+24、三方枠は出幅の編集値
  // （平面・建具モードの「見込み」欄と同じ式 frameOnlyPerpRange の depth）。
  const t = Number.isFinite(opts.wallThicknessMm) ? opts.wallThicknessMm : FALLBACK_WALL_THICKNESS_MM;
  if (method === 'frameOnly') {
    return frameOnlyPerpRange({ faceLo: 0, faceHi: t, axisValue: 0, projection: effectiveFrameProjection(o) }).depth;
  }
  return t + FRAME_OVERHANG_MM * 2;
}

// 種別 → 断面の描き方。ここに無い種別は従来の描き方（legacyStrip）。
// ユーザー明示指示2026-09「AW他、描画方法の指定のない片開き戸は全て適用」——建具記号（WD/AW…）
// では分けず、**片開き戸という種別**に紐づける。三方枠（機構 FRAME_ONLY）は種別（subType）が
// カタログで増えうるため、表ではなく機構で引く（methodFor。姿図 openingElevationFigure.js と同じ判定）。
const SECTION_METHODS = { singleSwing: 'swingLeaf' };

function methodFor(o) {
  if (findCatalogEntry(o?.category, o?.subType)?.mechanism === OpeningMechanism.FRAME_ONLY) return 'frameOnly';
  return SECTION_METHODS[o?.subType] ?? 'legacy';
}

/** 三方枠（機構 FRAME_ONLY）の断面の描き方（frameOnly）で描く建具か。呼び出し側が壁の範囲の取り方を分けるのに使う。 */
export function isFrameOnlySection(o) {
  return methodFor(o) === 'frameOnly';
}

/**
 * 枠が壁の両面から室内外へ出る量(mm)。三方枠は出幅の編集値（`effectiveFrameProjection`。未設定・0以下は既定12）、
 * それ以外は `FRAME_OVERHANG_MM`（12 固定）。帯の始点＝壁の材の範囲の下端−この値。
 * @param {import('@core').Opening} o
 * @returns {number}
 */
export function openingSectionOverhangMm(o) {
  return isFrameOnlySection(o) ? effectiveFrameProjection(o) : FRAME_OVERHANG_MM;
}

/**
 * 断面の帯を置く**壁の範囲**（壁厚方向の世界座標 {lo,hi}）。三方枠は枠が壁全体を包む（見込み＝壁の面から面＋2×出幅）
 * ので、ホスト壁の**両仕上げ面**（`wallFaceRange`）。壁が引けなければ null。それ以外は従来の
 * `wallMaterialRangeForOpening`（同じ通りの実壁の材の合併）。
 * @param {import('@core').Opening} o
 * @param {object|null} graph
 * @returns {{lo:number, hi:number}|null}
 */
export function openingSectionWallRange(o, graph) {
  if (!isFrameOnlySection(o)) return wallMaterialRangeForOpening(o, graph);
  if (!graph?.walls || !o?.axisCL) return null;
  const host = findHostWall(o, graph);
  if (!host) return null;
  const [lo, hi] = wallFaceRange(host, graph);
  return { lo, hi };
}

/** その建具の開口の下端z（窓は腰高・建具は0）。姿図・断面・探査で同じ規約。 */
function sillOf(o) {
  return o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0;
}

/**
 * 建具の断面プリミティブ（枠＝CUT・扉＝SILHOUETTE）。
 *
 * `swingLeaf`（片開き戸）の構成（ユーザー明示指示2026-09）。**縦断面**なので、切断線が通る
 * 開口の真ん中に現れるのは上枠と扉だけ（竪枠は開口の左右にあり、この断面には掛からない）:
 *   - 上枠 …… 竪枠と同じ断面（見付`FRAME_JAMB_WIDTH_MM`=30）を**見込いっぱい**（壁厚+24）へ。
 *             指定高さの直下。CUT（太線）。
 *   - 扉 …… 厚`DOOR_LEAF_THICKNESS_MM`(30)・下端FL+`DOOR_LEAF_BOTTOM_MM`(10)・上端は
 *            **枠の戸当たり**＝指定高さ−(見付30−かかり代10)＝指定高さ−20。SILHOUETTE（中線）。
 *            寄る側は**建具の開き勝手**（`openingOpenPerpDir`）で決まる。
 *   - 枠の縦線 … 扉のない側の枠の外縁。上枠の下端から床まで。SILHOUETTE（中線）。
 *
 * `frameOnly`（三方枠。機構 FRAME_ONLY）: 上枠だけを CUT で描き（扉・下枠なし）、見付は `frameOnlyInnerRect` の
 * 見付（開口幅の半分で頭打ち）、見込は壁の面から面＋2×出幅（`openingSectionWidthMm`）。竪枠は左右の外縁の
 * 縦線2本（細線）。
 * @param {import('@core').Opening} o
 * @param {number} x0 - 帯の起点（面ローカルx）
 * @param {1|-1} dir - 帯が伸びる向き
 * @param {string} cutWeight
 * @param {string} silhouetteWeight
 * @returns {object[]}
 */
export function openingSectionPrimitives(o, x0, dir, cutWeight, silhouetteWeight, opts = {}) {
  const h = effectiveHeight(o);
  const sill = sillOf(o);
  // 腰高0のとき -0 にしない（-0 は等値比較・テストの落とし穴。elevationFigure.jsの床yと同じ規約）。
  const top = -(sill + h), sillTop = sill ? -sill : 0;
  const at = mm => x0 + dir * mm;
  const rect = (loMm, hiMm, y1, y2, weight) => rectPrim(
    Math.min(at(loMm), at(hiMm)), Math.min(y1, y2),
    Math.abs(at(hiMm) - at(loMm)), Math.abs(y2 - y1), { weight },
  );

  if (methodFor(o) === 'swingLeaf') {
    const leaf = DOOR_LEAF_THICKNESS_MM;
    const full = openingSectionWidthMm(o, opts);       // 見込＝壁厚+24
    // **扉は開き勝手の側の壁面に寄る**（ユーザー明示指示2026-09「建具の開き勝手から決めて」）。
    // 平面と同じ導出（openingOpenPerpDir）で、開く側の**壁の面**から壁の中へ扉厚ぶん。
    // 帯のmmは呼び出し側の向き（x0からdir方向）なので、世界座標の増える向きとの対応を
    // `worldPerDirSign`（+1で一致）で受け取り、必要なら鏡像にする。
    const openDir = opts.openPerpDir ?? openingOpenPerpDir(o);
    const sign = opts.worldPerDirSign ?? 1;
    // 開く側の壁面が帯の**奥側**（mmの大きい側）に来るか。壁面は帯の端から
    // FRAME_OVERHANG_MM だけ内側にある（枠が壁面から12ずつ外へ出るため）。
    const atFar = openDir === 0 ? true : (openDir > 0) === (sign > 0);
    const leafLo = atFar ? full - FRAME_OVERHANG_MM - leaf : FRAME_OVERHANG_MM;
    // **扉のない側の枠の縦線は見えがかりで描く**（ユーザー明示指示2026-09）——開口を覗くと、
    // 扉が無い側は枠の見込面が奥まで見え、その端（枠の外縁）が1本の縦線として現れる。
    const freeEdgeMm = atFar ? 0 : full;
    // 扉の上端は戸当たり（かかり代）まで＝上枠の見付のうち本体ぶん（30-10=20）だけ下がる。
    const leafTop = top + (FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM);
    return [
      rect(0, full, top, top + FRAME_JAMB_WIDTH_MM, cutWeight),     // 上枠（竪枠と同じ断面。見付30）
      rect(leafLo, leafLo + leaf, leafTop, sillTop - DOOR_LEAF_BOTTOM_MM, silhouetteWeight), // 扉
      // 扉のない側の枠の縦線。**見えがかりなので細線**（ユーザー明示指示2026-09
      // 「「13」D: 建具建枠の見えがかりは細線」）。呼び出し側が detailWeight を渡さない場合は
      // 中線へフォールバックする（既存呼び出しの後方互換）。
      linePrim(at(freeEdgeMm), top + FRAME_JAMB_WIDTH_MM, at(freeEdgeMm), sillTop,
        { weight: opts.detailWeight ?? silhouetteWeight }),
    ];
  }

  if (methodFor(o) === 'frameOnly') {
    // 三方枠（WF/SF/SSF。扉なし）の縦断面。切断線が通る開口の真ん中に現れるのは**上枠だけ**。
    // 断面形は平面の竪枠と同じ関数（frameOnlyJambProfiles）から取る——木製＝閉じた矩形、鋼板＝壁面へ戻る
    // 返しを持つ開いたコの字。平面の along（壁の長さ）は断面では縦（上端から下へ見付）に当たる。
    // 見込（壁の面から面＋2×出幅）は帯の全幅 full、左右対称なので開き勝手・worldPerDirSign は使わない。
    const proj = effectiveFrameProjection(o);
    const full = openingSectionWidthMm(o, opts);
    const t = full - proj * 2;
    const fw = frameOnlyInnerRect(o).fw;
    const profile = o.frameProfile ?? frameProfileFor(fixtureSymbolOf(o));
    const [head] = frameOnlyJambProfiles({
      coord1: top, coord2: sillTop, faceLo: proj, faceHi: proj + t, axisValue: 0,
      faceWidth: fw, projection: proj, profile,
    });
    const headPrim = head.closed
      ? rect(
        Math.min(...head.points.map(p => p.perp)), Math.max(...head.points.map(p => p.perp)),
        Math.min(...head.points.map(p => p.along)), Math.max(...head.points.map(p => p.along)), cutWeight)
      : polylinePrim(head.points.map(p => [at(p.perp), p.along]), { weight: cutWeight });
    // 竪枠の見えがかり: 開口を覗くと左右の竪枠の見込面が奥まで見え、枠の外縁が縦線2本に現れる（上枠の下端から床まで）。
    // 見えがかりなので細線（detailWeight。呼び出し側が渡さなければ中線）。
    const jambBottom = top + fw;
    const jambWeight = opts.detailWeight ?? silhouetteWeight;
    return [
      headPrim,
      linePrim(at(0), jambBottom, at(0), sillTop, { weight: jambWeight }),
      linePrim(at(full), jambBottom, at(full), sillTop, { weight: jambWeight }),
    ];
  }

  const a = 0, b = LEGACY_FRAME_W, c = LEGACY_FRAME_W + LEGACY_LEAF_TH;
  const d = LEGACY_FRAME_W * 2 + LEGACY_LEAF_TH;
  return [
    rect(a, b, top, sillTop, cutWeight),
    rect(b, c, top, sillTop, silhouetteWeight),
    rect(c, d, top, sillTop, cutWeight),
  ];
}
