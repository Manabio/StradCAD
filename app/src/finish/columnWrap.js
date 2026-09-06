/**
 * 柱の仕上げ包み（追加仕様2026-08「柱を仕上げ材で覆い展開図に反映」）の幾何。
 * **展開図の柱型（elevation/section/sectionStructure.js）と平面図の柱（renderer/
 * StructuralLayer.jsx）が共有する単一の情報源**——両者が別々に包み厚を算出すると、同じ柱が
 * 図面ごとに違う太さで描かれる（構造と仕上げの境界にある値なので、どちらか片方の層に埋めない）。
 *
 * 規約（ユーザー指示2026-08）:
 *   1. **柱は原則、仕上げ材で覆う**（壁と干渉する柱に限らない）。厚みはその面に向き合う壁の
 *      「下地材＋壁仕上げ材」＝その部屋の層構成。
 *   2. **覆った柱の表面と内壁仕上げの隙間が`TRIM_GAP_MM`(150)以下ならそこでトリム**＝包みを
 *      壁の仕上げ面まで伸ばして揃える（狭い隙間は塞いで壁と一体に納める）。この面は壁と
 *      「接続した」ものとして扱い、展開図はその壁の面に柱型を出す。
 *   3. **壁内は下地材・壁仕上げ材ともになし**＝柱の面が壁の材厚の中にあるなら、その面は覆わない。
 *
 * 純モジュール（node:testから単体import可能。store.js/*.jsx/react-konva を静的importしない）。
 * 設計意図は `.claude/elevation-model.md`「2.5D立体の加算レイヤ」節を参照。
 */
import { findSectionEntry, diaphragmProjection } from '../structural/sectionCatalog.js';
import { resolveFinVisibility, finishJoinInset } from './wallFinishJoin.js';

// 座標比較の許容（elevation/elevationStyle.js の GAP_EPS_MM と同値。finish/ が elevation/ へ
// 依存しないよう独立に持つ）。
const GAP_EPS = 1e-6;

// 断面がカタログに無い柱のフォールバック辺長（sectionStructure.js の梁と同じ木造既定断面）。
const DEFAULT_SECTION_MM = 105;

// 基礎（杭）を表す role。仕上げで覆う対象ではない。
const FOUNDATION_ROLE = 'foundation';

/** 覆った柱の表面と内壁仕上げの隙間がこの値以下ならトリムする(mm)。ユーザー指示2026-08。 */
export const TRIM_GAP_MM = 150;

/**
 * @typedef {{xLo:number, xHi:number, yLo:number, yHi:number, baseZ:number,
 *   sectionWMm:number, sectionHMm:number, diaphragmMm:number}} ColumnRect
 */

/**
 * @typedef {{xLo:number, xHi:number, yLo:number, yHi:number}} SideAmounts
 *   4面それぞれの量（包み厚など）。柱は壁との位置関係が面ごとに違うため対称ではない。
 */

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

// ================================================================
// 壁ビュー（描画ホットパス用の POJO スナップショット）
//
// このモジュールの主要な入口（columnWrapSolids / columnWallCuts）は「柱1本×壁全件」を
// 6周ほど回す（面の包み4面・壁埋まり判定・食い込み判定）。内側で読む
// `wall.materialRange` / `coord1` / `coord2` / `backingRange` はすべて MobX の computed で、
// 実データ規模（壁200本・柱60本）だとこの読み出し自体が支配的なコストになる
// （実測）。そこで判定に必要な値だけを 1 回だけコピーした
// POJO を組み、内側のループはそれを見る（finish/gridCells.js の分割格子スナップショットと同じ手口）。
// 公開関数の引数（生の wall 配列）・戻り値は変えない——入口でビューを組むだけ。
// ================================================================

/**
 * 壁1本分のビュー。mr は materialRange（null 可）、backingMm は下地帯の厚み（null=下地なし）。
 * finLine は内側線（仕上げ／下地の境界線）の位置と可視性——柱壁の内側境界をここへ合わせる
 * （`resolveSideCover` のトリム分岐。規則は finish/wallFinishJoin.js が唯一の供給源）。
 * materialRange 同様 MobX の computed 由来のため、ここで1回だけ写して内側のループは読まない。
 */
function makeWallView(wall) {
  const mr = wall.materialRange ?? null;
  const br = wall.backingRange ?? null;
  const c1 = wall.coord1, c2 = wall.coord2;
  return {
    wall,
    isVertical: wall.isVertical,
    mr,
    spanLo: Math.min(c1, c2), spanHi: Math.max(c1, c2),
    wallFinish: wall.wallFinish ?? 0,
    // 軸CLを持たない壁（手動作成の退化データ・テストダブル）はfin線を解決できない＝取り合わない。
    finLine: mr && wall.axisCL ? resolveFinVisibility(wall) : null,
    backingMm: br ? Math.abs(br.hi - br.lo) : null,
    axisId: wall.axisCL?.id ?? null,
  };
}

/** 壁配列 → ビュー集合（向き別・軸CL別の束ね込みを含む）。 */
function makeWallSet(walls) {
  const all = [], vertical = [], horizontal = [], byAxis = new Map();
  for (const wall of walls ?? []) {
    const view = makeWallView(wall);
    all.push(view);
    (view.isVertical ? vertical : horizontal).push(view);
    if (view.axisId == null) continue;
    const bucket = byAxis.get(view.axisId);
    if (bucket) bucket.push(view);
    else byAxis.set(view.axisId, [view]);
  }
  return { all, vertical, horizontal, byAxis };
}

/**
 * 柱の素の平面外形（カタログ断面＋鋼管のダイヤフラム出）。仕上げ包みは含まない
 * ——壁埋まり判定・包みの起点はこの外形。
 * 断面の width(X方向)×height(Y方向)、rotation 90/270 での入れ替えは renderer/ColumnSymbol と
 * 同じ規約。それ以外の角度は回転前の寸法をそのまま使う（軸並行の外接矩形にはしない。defer）。
 * @param {object} column - graph.columns の1件
 * @param {number} [baseZ] - その層の床の絶対z（展開図用。平面では0）
 * @returns {ColumnRect}
 */
export function bareColumnRect(column, baseZ = 0) {
  const sec = findSectionEntry(column.sectionDefId);
  let w = sec?.width ?? DEFAULT_SECTION_MM;
  let h = sec?.height ?? DEFAULT_SECTION_MM;
  const rot = (((column.rotation ?? 0) % 360) + 360) % 360;
  if (Math.abs(rot - 90) < 1 || Math.abs(rot - 270) < 1) { const t = w; w = h; h = t; }
  const e = diaphragmProjection(sec); // ダイヤフラム出（鋼管のみ非0）は柱の外形そのもの
  return {
    xLo: column.x - w / 2 - e, xHi: column.x + w / 2 + e,
    yLo: column.y - h / 2 - e, yHi: column.y + h / 2 + e,
    baseZ, sectionWMm: w, sectionHMm: h, diaphragmMm: e,
  };
}

/**
 * 壁の下地材の厚み(mm)。**仕上げのみの薄壁（`backingRange===null`）は、同じ軸CL上でスパンが
 * 重なる下地オーナー壁の下地帯を採る**（実機フィードバック修正2026-08「柱周りに壁下地材がない」）
 * ——部屋境界の壁は「下地オーナー壁＋仕上げ薄壁」のペアで、下地はオーナー側だけが持つ
 * （`wallGeneration.js`「下地オーナー解決」）。薄壁だけを見ると下地厚0になり、柱の包みが
 * 仕上げ12.5mmだけに潰れて「柱フランジの周りに壁下地材を置いてから壁仕上げ材」という規約を
 * 満たせなくなる。
 * @param {object} wall
 * @param {object[]} [walls] - 同一graphの壁（薄壁のオーナー探索用。省略時は探索しない）
 * @returns {number}
 */
function wallBackingMm(view, set) {
  if (view.backingMm != null) return view.backingMm;
  if (view.axisId == null) return 0;
  let backing = 0;
  for (const other of set.byAxis.get(view.axisId) ?? []) { // 同じ軸CLのペアだけ
    if (other.wall === view.wall || other.isVertical !== view.isVertical) continue;
    if (other.backingMm == null) continue;
    if (!rangesOverlap(view.spanLo, view.spanHi, other.spanLo, other.spanHi)) continue; // 別の場所のオーナー壁は拾わない
    backing = Math.max(backing, other.backingMm);
  }
  return backing;
}

/**
 * 壁の「下地材＋壁仕上げ材」の合計厚(mm)。**壁自身の現在の寸法値**から求める（実装方針6）
 * ——部屋の内装マスターを materialMap から引き直さない。壁はその部屋のマスターから生成された
 * 結果であり下地帯・仕上げ厚を既に保持しているため、引き直すと同じ厚みに二系統の情報源ができる。
 * 下地は薄壁ならペアのオーナー壁から採る（`wallBackingMm`）。寸法が判らない手動壁
 * （wallFinish=null かつ下地も無い）は0＝覆わない（固定値で代用しない）。
 * @param {object} wall
 * @param {object[]} [walls] - 同一graphの壁（薄壁のオーナー探索用）
 * @returns {number}
 */
export function wallFinishCoverMm(wall, walls) {
  return wallBackingMm(makeWallView(wall), makeWallSet(walls)) + (wall.wallFinish ?? 0);
}

/**
 * 柱の平面矩形が壁の材厚・スパンの両方と正の幅で重なるか（＝壁に食い込んでいる柱か）。
 * @param {ColumnRect} rect
 * @param {object} wall
 * @returns {boolean}
 */
export function columnMeetsWall(rect, wall) {
  return columnMeetsWallView(rect, makeWallView(wall));
}

function columnMeetsWallView(rect, view) {
  const mr = view.mr;
  if (!mr) return false;
  const [acrossLo, acrossHi, spanLo, spanHi] = view.isVertical
    ? [rect.xLo, rect.xHi, rect.yLo, rect.yHi]
    : [rect.yLo, rect.yHi, rect.xLo, rect.xHi];
  return rangesOverlap(acrossLo, acrossHi, mr.lo, mr.hi)
      && rangesOverlap(spanLo, spanHi, view.spanLo, view.spanHi);
}

/**
 * 柱の平面矩形が、いずれかの壁の材厚に収まり（厚み方向は完全に）、かつその壁のスパンに
 * 収まっているか（＝壁に隠れて見えない柱か。梁の `isInsideWall` と同じ考え方・同じ許容量）。
 * スパン方向は壁厚ぶんの食い違いを許容する——柱・梁はCL間を張るのに対し、壁は隅で
 * `chamferWalls` が半壁厚ほど詰めるため、完全被覆を要求するとこの規則が実データで発動しない。
 * @param {ColumnRect} rect
 * @param {object[]} walls
 * @returns {boolean}
 */
export function isColumnInsideWall(rect, walls) {
  return isColumnInsideWallSet(rect, makeWallSet(walls));
}

function isColumnInsideWallSet(rect, set) {
  for (const view of set.all) {
    const mr = view.mr;
    if (!mr) continue;
    const [acrossLo, acrossHi, spanLo, spanHi] = view.isVertical
      ? [rect.xLo, rect.xHi, rect.yLo, rect.yHi]
      : [rect.yLo, rect.yHi, rect.xLo, rect.xHi];
    if (!(acrossLo >= mr.lo - GAP_EPS && acrossHi <= mr.hi + GAP_EPS)) continue;
    const tol = Math.abs(mr.hi - mr.lo); // 隅の取り合い（chamferWalls）ぶんの許容
    if (spanLo >= view.spanLo - tol - GAP_EPS && spanHi <= view.spanHi + tol + GAP_EPS) return true;
  }
  return false;
}

/**
 * 柱の1面（axis+side で指定）の包み量を決める。上記規約1〜3の本体。
 *
 * その面に**向き合う**壁（面の法線方向に材厚を持つ＝axis'x'なら垂直壁）のうち、柱のスパン方向と
 * 重なるものだけを見る。
 *  - 面が壁の材厚の中 → 覆わない（規約3「壁内は下地材・仕上げ材ともになし」）
 *  - 面の外側で最も近い壁との隙間が trimGapMm 以下 → その隙間ぶん伸ばして壁面と揃える（規約2）。
 *    この壁を「接続した壁」として返す＝展開図がその面に柱型を出す索引になる。
 *  - それより遠い／向き合う壁が無い → その壁の層構成ぶん覆う（規約1。壁が無ければ覆えない=0）
 * @param {ColumnRect} rect
 * @param {object[]} walls
 * @param {'x'|'y'} axis - 面の法線の軸
 * @param {-1|1} side - -1: lo側の面 / +1: hi側の面
 * @param {number} trimGapMm
 * @returns {{coverMm:number, finishMm:number, wall:object|null, trimmed:boolean, inWall:boolean}}
 *   finishMm はその面から内側境界（仕上げ材と下地材の境目）までの見込み量。平面図が包みを
 *   2層で描くのに使う。**トリムした面では負になりうる**——そこは壁の仕上げ材と取り合う面で、
 *   内側境界は自前の仕上げ厚ぶん内側ではなく**相手の内側線の位置**に置くため
 *   （finish/wallFinishJoin.js が唯一の供給源）。
 */
function resolveSideCover(rect, set, axis, side, trimGapMm) {
  const facingVertical = axis === 'x'; // x方向の面と向き合うのは垂直壁（厚み方向がX）
  const face = axis === 'x' ? (side < 0 ? rect.xLo : rect.xHi) : (side < 0 ? rect.yLo : rect.yHi);
  const [spanLo, spanHi] = axis === 'x' ? [rect.yLo, rect.yHi] : [rect.xLo, rect.xHi];
  let nearest = null;      // {gapMm, view} — 面の外側にある最も近い壁
  let fallbackCover = 0;   // 向き合う壁は在るが遠い場合に使う層構成
  for (const view of facingVertical ? set.vertical : set.horizontal) {
    const mr = view.mr;
    if (!mr) continue;
    if (!rangesOverlap(spanLo, spanHi, view.spanLo, view.spanHi)) continue;
    // 面が材厚の中＝壁内。この面は覆わない（規約3）。
    if (face > mr.lo + GAP_EPS && face < mr.hi - GAP_EPS) {
      return { coverMm: 0, finishMm: 0, wall: view.wall, trimmed: false, inWall: true };
    }
    const gapMm = side < 0 ? face - mr.hi : mr.lo - face;
    if (gapMm < -GAP_EPS) continue; // その壁は面の反対側にある
    if (!nearest || gapMm < nearest.gapMm) nearest = { gapMm, view };
  }
  if (nearest) fallbackCover = wallBackingMm(nearest.view, set) + nearest.view.wallFinish;
  // 仕上げ材の厚み。包みの残りが下地材（平面図はこの2層を描き分ける）。包みが仕上げ厚より
  // 薄い（トリム量が小さい）場合は全部を仕上げ材とみなす——下地を入れる余地が無いため。
  // これは**壁と取り合っていない面**（宙に浮いた包みの見付け）の式。
  const finishOf = (view, coverMm) => Math.min(view?.wallFinish ?? 0, coverMm);
  if (nearest && nearest.gapMm <= trimGapMm + GAP_EPS) {
    // 隙間を塞いで壁の仕上げ面と揃える（規約2）。隙間0＝既に接している場合も接続扱い。
    const trimmedFace = face + side * nearest.gapMm; // 相手の仕上げ面と揃った位置
    // 取り合う面の内側境界は**相手の内側線の位置**へ置く（壁同士の取り合い＝
    // wallJunctionResolve.js パス2 と同じ規則・同じ経路。finish/wallFinishJoin.js）。
    // 自前の仕上げ厚で内側へ入れると、壁のfin線と柱壁の内側線が仕上げ厚2枚ぶん食い違って
    // 離れて見える（実機指摘2026-09）。相手のfin線が描かれない壁とは取り合えないので、
    // その場合だけ取り合わない面と同じ式へフォールバックする。
    const joined = finishJoinInset(nearest.view.finLine, trimmedFace, side);
    return {
      coverMm: nearest.gapMm,
      finishMm: joined ?? finishOf(nearest.view, nearest.gapMm),
      wall: nearest.view.wall, trimmed: true, inWall: false,
    };
  }
  return {
    coverMm: fallbackCover, finishMm: finishOf(nearest?.view, fallbackCover),
    wall: null, trimmed: false, inWall: false,
  };
}

/**
 * 柱を仕上げ材で覆った外形を返す（上記規約1〜3）。
 *
 * `wallAxes` には**トリムで接続した壁・食い込んでいる壁**の軸CL値を記録する——展開図が
 * 「この柱はどの面に現れるか」を面の軸CLと照合して決めるため（実機フィードバック2026-08。
 * `sectionStructure.js` の `structuralColumnPrimitivesForCut` 参照）。150mmを超えて離れた壁は
 * 接続しない＝その面には柱型を出さない（独立柱の見えがかりは defer のまま）。
 * @param {ColumnRect} rect - ダイヤフラム出まで含んだ素の外形
 * @param {object[]} walls
 * @param {{trimGapMm?:number}} [opts]
 * @returns {ColumnRect & {covers:SideAmounts, trimmed:SideAmounts,
 *   wallAxes:Array<{isVertical:boolean, axisValue:number}>}}
 */
export function wrapColumnWithFinish(rect, walls, opts = {}) {
  return wrapColumnWithFinishSet(rect, makeWallSet(walls), opts);
}

function wrapColumnWithFinishSet(rect, set, opts = {}) {
  const trimGapMm = opts.trimGapMm ?? TRIM_GAP_MM;
  const covers = {}, finishes = {}, trimmed = {}, wallAxes = [];
  // 包みの線の色。**包みは壁（仕上げ材）であって構造材ではない**ので、取り合う壁の線色を継ぐ
  // ——柱の材種色（COLOR_BY_MATERIAL。伏図で部材の種別を示すための色）で描くと、平面では
  // 同じ1本の仕上げ線が柱のところだけ色違いになる（ユーザー実機指摘2026-09）。
  let wallColor = null;
  const pushAxis = wall => {
    if (wallColor == null && wall?.color) wallColor = wall.color;
    const axisValue = wall?.axisCL?.effectiveValue;
    if (!Number.isFinite(axisValue)) return;
    if (wallAxes.some(a => a.isVertical === wall.isVertical && Math.abs(a.axisValue - axisValue) <= GAP_EPS)) return;
    wallAxes.push({ isVertical: wall.isVertical, axisValue });
  };
  for (const [axis, side, key] of [['x', -1, 'xLo'], ['x', 1, 'xHi'], ['y', -1, 'yLo'], ['y', 1, 'yHi']]) {
    const r = resolveSideCover(rect, set, axis, side, trimGapMm);
    covers[key] = r.coverMm;
    finishes[key] = r.finishMm;
    trimmed[key] = r.trimmed;
    // 接続（トリム）した壁・食い込んでいる壁だけを索引に積む。遠い壁は積まない。
    if (r.trimmed || r.inWall) pushAxis(r.wall);
  }
  // 柱に食い込まれている壁（面が壁内でなくても柱が壁を貫いている構成）も接続扱いにする。
  for (const view of set.all) if (columnMeetsWallView(rect, view)) pushAxis(view.wall);
  return {
    ...rect,
    xLo: rect.xLo - covers.xLo, xHi: rect.xHi + covers.xHi,
    yLo: rect.yLo - covers.yLo, yHi: rect.yHi + covers.yHi,
    covers, finishes, trimmed, wallAxes, wallColor,
  };
}

/**
 * 柱に占有されて壁側を描かなくなる区間を壁ごとに返す（ユーザー指示2026-08「干渉した壁と柱壁は
 * 取り合う。壁仕上げ材は互いにトリム。不要になった壁下地材は削除」）。
 *
 * **層ごとに区間が違う**のが要点（ユーザー実機指摘2026-08「壁仕上げ線2本の内、柱側の1本が柱を
 * 一周している。正しくは、壁仕上げ材の内側にある1本と柱内側の1本が取り合う」）——柱壁と壁は
 * 同じ層どうしが連続するため、
 *  - `face`（仕上げ面線）は柱壁の**外形**の見付け幅で切る＝壁の面線が柱の出っ張りへ折れて続く
 *  - `fin`（仕上げ／下地の境界線）は柱壁の**内側境界**の見付け幅で切る＝壁のfin線が柱回りの
 *    境界線へ折れて続く（外形より左右の仕上げ厚ぶん狭い）
 * 同じ区間で両方を切ると、fin線の端が柱の境界線の端と食い違い、柱側の線が一周して見える。
 *  - `backing`（下地＝間柱）は`fin`と同じ幅だが、**その下地に乗っている壁仕上げ材が他に残って
 *    いれば空**（下記 `canRemoveBacking`）。
 * @param {object} graph
 * @param {{trimGapMm?:number}} [opts]
 * @returns {Map<string, {face:Array<[number,number]>, fin:Array<[number,number]>,
 *   backing:Array<[number,number]>}>} 壁id → 層ごとの、壁の長さ方向で落とす区間（複数可）
 */
export function columnWallCuts(graph, opts = {}) {
  const set = makeWallSet(graph?.walls ?? []);
  const cuts = new Map();
  for (const { wrapped, hidden } of columnWrapSolidsSet(graph, set, opts)) {
    if (hidden) continue; // 壁に完全に埋まる柱は壁の描画を変えない
    const f = wrapped.finishes ?? {};
    // この柱が接する壁の集合。下地を消してよいかの判定（canRemoveBacking）に使う。
    const touched = set.all.filter(v => wallTouchedByColumn(wrapped, v));
    const touchedSet = new Set(touched);
    for (const view of touched) {
      const wall = view.wall;
      if (wall.id == null) continue;
      const [spanLo, spanHi, finLo, finHi] = view.isVertical
        ? [wrapped.yLo, wrapped.yHi, f.yLo ?? 0, f.yHi ?? 0]
        : [wrapped.xLo, wrapped.xHi, f.xLo ?? 0, f.xHi ?? 0];
      const clip = (lo, hi) => {
        const a = Math.max(lo, view.spanLo), b = Math.min(hi, view.spanHi);
        return b - a > GAP_EPS ? [a, b] : null;
      };
      const face = clip(spanLo, spanHi);
      const fin = clip(spanLo + finLo, spanHi - finHi);
      if (!face && !fin) continue;
      if (!cuts.has(wall.id)) cuts.set(wall.id, { face: [], fin: [], backing: [] });
      const entry = cuts.get(wall.id);
      if (face) entry.face.push(face);
      if (fin) entry.fin.push(fin);
      if (fin && canRemoveBacking(view, set, touchedSet)) entry.backing.push(fin);
    }
  }
  return cuts;
}

/** 柱の包みが壁の材厚と重なる、または接するか（トリムで面が揃うと重なり0になるため接触も含む）。 */
function wallTouchedByColumn(wrapped, view) {
  const mr = view.mr;
  if (!mr) return false;
  const [acrossLo, acrossHi, spanLo, spanHi] = view.isVertical
    ? [wrapped.xLo, wrapped.xHi, wrapped.yLo, wrapped.yHi]
    : [wrapped.yLo, wrapped.yHi, wrapped.xLo, wrapped.xHi];
  if (acrossHi < mr.lo - GAP_EPS || acrossLo > mr.hi + GAP_EPS) return false;
  return rangesOverlap(spanLo, spanHi, view.spanLo, view.spanHi);
}

/**
 * その壁の下地を、柱の位置で削除してよいか（ユーザー指示2026-08「柱近傍で壁下地材を削除する場合、
 * 削除候補の壁下地を使っている壁仕上げ材（例えば反対側の部屋の壁）があったら、削除しない」）。
 *
 * 下地オーナー壁の下地帯は、**両側の部屋の仕上げ材**が乗る共有の下地（`wallGeneration.js`の
 * 下地オーナー解決＝オーナー壁＋反対面の仕上げ薄壁のペア）。柱は壁の片側にしか出っ張らないため、
 * 柱壁が置き換えるのは柱側の仕上げ材だけで、反対側の部屋の仕上げ材はそのまま残る——その仕上げを
 * 支える下地を消すと、反対側の壁が宙に浮く。同じ軸CL上でスパンが重なる仕上げ材のうち**1枚でも
 * 柱に接していないものがあれば残す**（判定は壁単位。区間単位まで細かくしない割り切り）。
 * @param {object} wall - 下地を持つ壁
 * @param {object[]} walls
 * @param {object[]} touched - この柱が接している壁
 * @returns {boolean}
 */
function canRemoveBacking(view, set, touchedSet) {
  if (view.axisId == null) return true;
  for (const other of set.byAxis.get(view.axisId) ?? []) { // この下地に乗りうるのは同じ軸CLの壁だけ
    if (other.isVertical !== view.isVertical) continue;
    if (!(other.wallFinish > 0)) continue;       // 仕上げ材を持たない壁は下地を必要としない
    if (!rangesOverlap(view.spanLo, view.spanHi, other.spanLo, other.spanHi)) continue;
    if (!touchedSet.has(other)) return false;    // 柱に置き換えられない仕上げ材が残っている
  }
  return true;
}

/**
 * graph の全柱について、仕上げ包みの外形を解決する（平面図の描画・展開図の寄与が共有する入口）。
 * 杭（role:'foundation'）は対象外。壁に完全に埋まる柱は `hidden:true` を立てて返す
 * ——平面図では柱そのものは描かれ続ける（消してはいけない）ので、除外ではなく印にする。
 * @param {object} graph
 * @param {{trimGapMm?:number}} [opts]
 * @returns {Array<{column:object, bare:ColumnRect, wrapped:object, hidden:boolean}>}
 */
export function columnWrapSolids(graph, opts = {}) {
  return columnWrapSolidsSet(graph, makeWallSet(graph?.walls ?? []), opts);
}

function columnWrapSolidsSet(graph, set, opts) {
  const out = [];
  for (const column of graph?.columns ?? []) {
    if (column.role === FOUNDATION_ROLE) continue;
    const bare = bareColumnRect(column);
    out.push({
      column, bare,
      wrapped: wrapColumnWithFinishSet(bare, set, opts),
      hidden: isColumnInsideWallSet(bare, set),
    });
  }
  return out;
}
