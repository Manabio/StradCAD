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
import {
  DetailSlot, SWING_LEAF_SUBTYPE, DETAIL_PRIM_SOURCE, DETAIL_FIT_EPS_MM, WINDOW_FRAME_JAMB_WIDTH_MM,
} from '../core/constants.js';
import { graphList } from '../graphReadScope.js';
import { rect as rectPrim, line as linePrim, polyline as polylinePrim } from '../elevation/elevationPrimitives.js';
import { findCatalogEntry, frameProfileFor, OpeningMechanism, IMPLEMENTED_MECHANISMS } from './openingCatalog.js';
import { findHostWall, wallFaceRange } from './openingGeometry.js';
import { frameOnlyInnerRect } from './openingElevationFigure.js';
import {
  FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM, DOOR_LEAF_THICKNESS_MM, FRAME_OVERHANG_MM,
  swingOpenPerpDir, frameOnlyPerpRange, frameOnlyJambProfiles, clampFrameFaceWidth,
  trackPerp, trackOf, resolveSlideLayoutPanels,
} from './openingPlanSymbolGeometry.js';
import { resolveDetailFrame, resolveSwingDoorFrame } from './openingDetailFit.js';

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
  let lo = Infinity, hi = -Infinity;
  for (const r of wallMaterialRangesOf(o, graph)) {
    lo = Math.min(lo, r.lo);
    hi = Math.max(hi, r.hi);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/**
 * wallMaterialRangeForOpening の合併の元になる、同じ通りで建具の位置を覆う実壁それぞれの材の範囲。
 * 展開の切断壁の帯は合併でなく当該部屋側の壁 1 枚の範囲（band.wall.materialRange）で上枠を描くので、通知は両方を試す。
 * @returns {{lo:number, hi:number}[]}
 */
export function wallMaterialRangesOf(o, graph) {
  if (!graph || !o?.axisCL) return [];
  const ranges = [];
  for (const w of graphList(graph, 'walls') ?? []) {
    if (w.isVertical !== o.isVertical || w.axisCL?.id !== o.axisCL.id) continue;
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    if (o.centerCoord < c1 || o.centerCoord > c2) continue;
    if (!w.materialRange) continue;
    ranges.push({ lo: w.materialRange.lo, hi: w.materialRange.hi });
  }
  return ranges;
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
 * その建具の断面帯の全幅(mm)。呼び出し側は帯を「壁の材の範囲の下端−出幅」から +方向へこの幅だけ置く
 * （中央寄せはしない）。
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
const SECTION_METHODS = { [SWING_LEAF_SUBTYPE]: 'swingLeaf' };

function methodFor(o) {
  const entry = findCatalogEntry(o?.category, o?.subType);
  if (entry?.mechanism === OpeningMechanism.FRAME_ONLY) return 'frameOnly';
  if (SECTION_METHODS[o?.subType]) return SECTION_METHODS[o.subType];
  // 窓（種別が引けて機構が実装済み）は上枠・下枠＋障子の断面。参照切れ・実装外の機構は従来の描き方（平面も目印だけ）。
  if (o?.category === OpeningCategory.WINDOW && entry && IMPLEMENTED_MECHANISMS.has(entry.mechanism)) return 'window';
  return 'legacy';
}

/** 窓の断面の描き方（上枠・下枠＋障子）で描く建具か。 */
export function isWindowSection(o) {
  return methodFor(o) === 'window';
}

/**
 * 窓台があるか（窓台高さ≠0）。掃き出し窓（窓台0）だけが下枠を描かず、障子・竪枠の線は床まで届く。
 * 床線の判定（elevationFigure.js reachesFloor＝窓台が0）と同じ境界（負の窓台＝不正値は従来どおり床下に描く）。
 */
export function windowHasSill(o) {
  return sillOf(o) !== 0;
}

/**
 * 窓・片開き戸の断面の枠の見付(mm)。窓＝窓の見付（開口高さの半分で頭打ち。上枠と下枠が交わらない）、
 * 片開き戸ほか＝建具の見付（三方枠は frameOnlyInnerRect）。3c の通知（上枠・下枠が壁厚に合うか）と描画が共有する。
 * @param {import('@core').Opening} o
 * @returns {number}
 */
export function sectionFrameFaceWidthFor(o) {
  return isWindowSection(o)
    ? clampFrameFaceWidth(WINDOW_FRAME_JAMB_WIDTH_MM, 0, effectiveHeight(o))
    : FRAME_JAMB_WIDTH_MM;
}

// 開く向き（±1。開かない・引けないは0）。呼び出し側の指定（opts.openPerpDir）が建具自身の導出に優先する。
const openDirOf = (o, opts) => opts.openPerpDir ?? openingOpenPerpDir(o);

/**
 * 開く側の壁面が帯の**奥側**（mmの大きい側）に来るか。壁面は帯の端から FRAME_OVERHANG_MM だけ内側にある
 * （枠が壁面から12ずつ外へ出るため）。帯のmmは呼び出し側の向き（x0からdir方向）なので、世界座標の増える向きとの
 * 対応を `worldPerDirSign`（+1で一致）で受け取る。開かない（0）は奥側。
 */
function openSideAtFar(o, opts) {
  const openDir = openDirOf(o, opts);
  const sign = opts.worldPerDirSign ?? 1;
  return openDir === 0 ? true : (openDir > 0) === (sign > 0);
}

/**
 * 窓の障子の置き方（帯のmm座標。0〜full）。平面の記号と同じ分け方——開き系は開く側の壁の面、
 * 引き違い系はトラック、FIXは障子なしでガラスの線1本、他は中央。
 * @param {object} entry - 窓のカタログ種別
 * @param {{full:number, atFar:boolean, open:boolean}} ctx - open＝開き系（開く向きが±1）
 * @returns {{sashes: {lo:number, hi:number}[], glassAt: number|null}}
 */
export function windowSashLayout(entry, { full, atFar, open }) {
  const leaf = DOOR_LEAF_THICKNESS_MM;
  const around = c => ({ lo: c - leaf / 2, hi: c + leaf / 2 });
  if (open) {
    const lo = atFar ? full - FRAME_OVERHANG_MM - leaf : FRAME_OVERHANG_MM;
    return { sashes: [{ lo, hi: lo + leaf }], glassAt: null };
  }
  if (entry.mechanism === OpeningMechanism.FIXED) return { sashes: [], glassAt: full / 2 };
  if (entry.mechanism === OpeningMechanism.SLIDE_DOUBLE) {
    return { sashes: [0, 1].map(k => around(trackPerp(full / 2, k, 2, full))), glassAt: null };
  }
  if (entry.mechanism === OpeningMechanism.SLIDE_LAYOUT) {
    const panels = resolveSlideLayoutPanels(entry);
    // 空判定を先に（slideLayout 欄の無い種別を許す。平面 openingPlanSymbol.js と同じ順）。
    if (panels.length > 0) {
      const tracks = entry.slideLayout?.tracks;
      const hasFix = panels.some(p => p.fix);
      const used = [...new Set(panels.map((p, i) => trackOf(p, i, tracks, hasFix)))].sort((a, b) => a - b);
      return { sashes: used.map(k => around(trackPerp(full / 2, k, tracks, full))), glassAt: null };
    }
  }
  return { sashes: [around(full / 2)], glassAt: null };
}

/** 三方枠（機構 FRAME_ONLY）の断面の描き方（frameOnly）で描く建具か。呼び出し側が壁の範囲の取り方を分けるのに使う。 */
export function isFrameOnlySection(o) {
  return methodFor(o) === 'frameOnly';
}

/** 片開き戸（swingLeaf）の断面の描き方で描く建具か。通知（openingDetailFitCheck.js）が使う。 */
export function isSwingLeafSection(o) {
  return methodFor(o) === 'swingLeaf';
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

const isAxisAlignedRect = points => points.length === 4 && points.every((p, i) => {
  const q = points[(i + 1) % 4];
  return Math.abs(p.along - q.along) <= DETAIL_FIT_EPS_MM || Math.abs(p.perp - q.perp) <= DETAIL_FIT_EPS_MM;
});

// 片開き戸の断面の上枠（部分詳細図 S8e-2）。建具個別の detailRefs ＞ 記号の detailFigures の head（無ければ jamb の流用。R9）の図があれば
// この断面の寸法（coord1=上端・coord2=開口下端・見込帯の壁の面＝帯の端から出幅ずつ内側・見付 30）で fit して写し、
// 無ければ組込みの上枠（暗黙の既定。従来の矩形と同じ出力）。図が引けない（null）・fit できない（error）ときは従来の矩形（source なし）。
// 断面の帯は常に「壁の面−出幅〜壁の面＋出幅」で見付も常に 30（従来の式に頭打ちが無い）ので、方立の R4 に当たる除外は無い。
// t の正の側（扉が閉じる側）＝開く側の面は、atFar なら帯の奥（mm の大きい側）＝perp の増える向き。図は coord1 側の 1 組だけ使う。
// 展開の図は source=DETAIL_PRIM_SOURCE を付ける（R3。輪郭が 4 点の軸平行な矩形なら従来と同じ rect、それ以外は閉じた polyline）。
function swingHeadPrimitives(o, { top, sillTop, full, atFar, at, rect, polylinePrim, cutWeight, opts }) {
  const legacy = () => [rect(0, full, top, top + FRAME_JAMB_WIDTH_MM, cutWeight)];
  const wall = Number.isFinite(opts.wallThicknessMm) ? opts.wallThicknessMm : FALLBACK_WALL_THICKNESS_MM;
  const resolved = resolveSwingDoorFrame({
    symbolKey: fixtureSymbolOf(o), detailRefs: o.detailRefs ?? null, slot: DetailSlot.HEAD, coord1: top, coord2: sillTop,
    faceMin: FRAME_OVERHANG_MM, faceMax: FRAME_OVERHANG_MM + wall, wallThickness: wall,
    tSign: atFar ? 1 : -1, faceWidth: FRAME_JAMB_WIDTH_MM, projection: FRAME_OVERHANG_MM,
  });
  if (resolved === null || resolved.error) return legacy();
  const source = { source: DETAIL_PRIM_SOURCE };
  return resolved.sides[0].map(st => {
    const ps = st.points;
    if (st.closed && isAxisAlignedRect(ps)) {
      const perps = ps.map(p => p.perp), alongs = ps.map(p => p.along);
      return rect(Math.min(...perps), Math.max(...perps), Math.min(...alongs), Math.max(...alongs), cutWeight, source);
    }
    return polylinePrim([...ps, ...(st.closed ? [ps[0]] : [])].map(p => [at(p.perp), p.along]), { weight: cutWeight, ...source });
  });
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
  const rect = (loMm, hiMm, y1, y2, weight, extra) => rectPrim(
    Math.min(at(loMm), at(hiMm)), Math.min(y1, y2),
    Math.abs(at(hiMm) - at(loMm)), Math.abs(y2 - y1), { weight, ...extra },
  );

  if (methodFor(o) === 'swingLeaf') {
    const leaf = DOOR_LEAF_THICKNESS_MM;
    const full = openingSectionWidthMm(o, opts);       // 見込＝壁厚+24
    // **扉は開き勝手の側の壁面に寄る**（ユーザー明示指示2026-09「建具の開き勝手から決めて」）。
    // 平面と同じ導出（openingOpenPerpDir）で、開く側の**壁の面**から壁の中へ扉厚ぶん。
    // 帯のmmは呼び出し側の向き（x0からdir方向）なので、世界座標の増える向きとの対応を
    // `worldPerDirSign`（+1で一致）で受け取り、必要なら鏡像にする。
    const atFar = openSideAtFar(o, opts);
    const leafLo = atFar ? full - FRAME_OVERHANG_MM - leaf : FRAME_OVERHANG_MM;
    // **扉のない側の枠の縦線は見えがかりで描く**（ユーザー明示指示2026-09）——開口を覗くと、
    // 扉が無い側は枠の見込面が奥まで見え、その端（枠の外縁）が1本の縦線として現れる。
    const freeEdgeMm = atFar ? 0 : full;
    // 扉の上端は戸当たり（かかり代）まで＝上枠の見付のうち本体ぶん（30-10=20）だけ下がる。
    const leafTop = top + (FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM);
    return [
      ...swingHeadPrimitives(o, { top, sillTop, full, atFar, at, rect, polylinePrim, cutWeight, opts }),
      rect(leafLo, leafLo + leaf, leafTop, sillTop - DOOR_LEAF_BOTTOM_MM, silhouetteWeight), // 扉
      // 扉のない側の枠の縦線。**見えがかりなので細線**（ユーザー明示指示2026-09
      // 「「13」D: 建具建枠の見えがかりは細線」）。呼び出し側が detailWeight を渡さない場合は
      // 中線へフォールバックする（既存呼び出しの後方互換）。
      linePrim(at(freeEdgeMm), top + FRAME_JAMB_WIDTH_MM, at(freeEdgeMm), sillTop,
        { weight: opts.detailWeight ?? silhouetteWeight }),
    ];
  }

  if (methodFor(o) === 'window') {
    // 窓の縦断面: 上枠・下枠（見付 fw。CUT）＋障子（見え掛かり。SILHOUETTE）＋竪枠の見え掛かり（細線）。
    // 障子は枠にかかり代ぶん掛かる。窓台0（掃き出し窓）は下枠を描かず、障子・竪枠の線は床まで。
    const entry = findCatalogEntry(o.category, o.subType);
    const full = openingSectionWidthMm(o, opts);
    const fw = sectionFrameFaceWidthFor(o);
    const open = openDirOf(o, opts) !== 0;
    const atFar = openSideAtFar(o, opts);
    const hasSill = windowHasSill(o);
    const kakari = Math.min(FRAME_KAKARI_WIDTH_MM, fw); // 見付より深く掛からない（開口が極端に低くても開口の外へ出ない）
    const sashTop = top + fw - kakari;
    const sashBottom = hasSill ? sillTop - fw + kakari : sillTop;
    const { sashes, glassAt } = windowSashLayout(entry, { full, atFar, open });
    const sashDrawn = sashBottom > sashTop;
    const prims = [rect(0, full, top, top + fw, cutWeight)];
    if (hasSill) prims.push(rect(0, full, sillTop - fw, sillTop, cutWeight));
    if (sashDrawn) {
      for (const s of sashes) prims.push(rect(s.lo, s.hi, sashTop, sashBottom, silhouetteWeight));
      if (glassAt !== null) prims.push(linePrim(at(glassAt), sashTop, at(glassAt), sashBottom, { weight: silhouetteWeight }));
    }
    // 竪枠の見え掛かり（細線）。開き系は障子の無い側の端だけ、他は両端。上枠の下端から下枠の上端（掃き出しは床）まで。
    const jambTop = top + fw, jambBottom = hasSill ? sillTop - fw : sillTop;
    if (jambBottom > jambTop) {
      for (const e of open ? [atFar ? 0 : full] : [0, full]) {
        prims.push(linePrim(at(e), jambTop, at(e), jambBottom, { weight: opts.detailWeight ?? silhouetteWeight }));
      }
    }
    return prims;
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
    const symbolKey = fixtureSymbolOf(o);
    const profile = o.frameProfile ?? frameProfileFor(symbolKey);
    // 部分詳細図（S3）: head（無ければ jamb。R9）の図を、**平面の点列を流用せず**この断面の寸法
    // （coord1=上端・coord2=開口下端・面=proj〜proj+t）で fit し直す。建具個別の detailRefs ＞ 記号の割当て。
    // 図が無い・失敗は profile（frameProfile 明示 ＞ 記号の profile）へ戻す（通知は init）。壁厚は呼び出し側の値を
    // そのまま渡す（t = full − 2·proj の再計算は集計側の値と 1ULP ずれて鍵が二重になるため）。
    const resolved = resolveDetailFrame({
      symbolKey, detailRefs: o.detailRefs ?? null, slot: DetailSlot.HEAD, coord1: top, coord2: sillTop, faceMin: proj,
      wallThickness: Number.isFinite(opts.wallThicknessMm) ? opts.wallThicknessMm : FALLBACK_WALL_THICKNESS_MM,
      faceWidth: clampFrameFaceWidth(fw, top, sillTop), projection: proj,
    });
    const detail = resolved && !resolved.error ? resolved : null;
    // 上枠の線は coord1 側（上端から下へ見付）だけ。detail は図のストローク数ぶん、従来は1本。
    const heads = frameOnlyJambProfiles({
      coord1: top, coord2: sillTop, faceLo: proj, faceHi: proj + t, axisValue: 0,
      faceWidth: fw, projection: proj, profile, detail: detail?.profiles ?? null,
    }).slice(0, detail ? detail.sides[0].length : 1);
    const headPrims = heads.map(head => (detail
      ? polylinePrim([...head.points, ...(head.closed ? [head.points[0]] : [])].map(p => [at(p.perp), p.along]), { weight: cutWeight })
      : head.closed
        ? rect(
          Math.min(...head.points.map(p => p.perp)), Math.max(...head.points.map(p => p.perp)),
          Math.min(...head.points.map(p => p.along)), Math.max(...head.points.map(p => p.along)), cutWeight)
        : polylinePrim(head.points.map(p => [at(p.perp), p.along]), { weight: cutWeight })));
    // 竪枠の見えがかり: 開口を覗くと左右の竪枠の見込面が奥まで見え、枠の外縁が縦線2本に現れる（上枠の下端から床まで）。
    // 見えがかりなので細線（detailWeight。呼び出し側が渡さなければ中線）。
    const jambBottom = top + fw;
    const jambWeight = opts.detailWeight ?? silhouetteWeight;
    return [
      ...headPrims,
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
