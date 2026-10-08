/**
 * 小屋組（棟木・母屋・束）を描く屋根の範囲（region）の導出。ステップ C3a。graph を読む（幾何の純関数は
 * roofFramingGeometry.js、描画の判断は framingDrawing.js roofFramingPrimitives）。store.js / snap.js / .jsx を
 * 静的に import しない（node:test から単体で import できる）。
 *
 * region＝{ key, rect, shape, ridgeIsVertical, highSide, edges, outline }。edges・outline は屋根の外形線（軒先・けらば。
 * ステップ D1。withOutline）。次をすべて満たす屋根だけが region になる:
 *   - 在来木造（rulesFor(effectiveStructure(graph, project)).framing が真。構造種別の直接比較はしない）
 *   - 範囲が矩形（rectOfBounds が非 null）。矩形でない屋根の例外は2つ:
 *     ・主屋根の寄棟: { key:'main', rect:null, rects:セル矩形の配列, shape:'hip', ridgeIsVertical:null, highSide:null }
 *       （描画と、翼ごとの小屋梁・飛び梁の生成＝woodRoofFraming.js C2e-3b）
 *     ・下屋の水下の場の region（rect:null・rects・leanToDrains。2026-10-05: 水下＝軒の辺から屋内に接する部分を除いたもの。
 *       壁へ下る面は作らない。振り分けは leanToDrainRoute）。L字の切妻・明示の寄棟、壁に一部接する矩形の切妻・片流れ、
 *       壁に接する矩形の寄棟もここ。shape は実効の小屋組の形状（欄の表示と違うことがある）
 *     ・下屋の片流れ（L字。ステップ E1b・E2b）:
 *       { key:'lean:…', rect:null, rects, shape:'mono', ridgeIsVertical:null, highSide:null, leanToWings, leanToUnassigned,
 *         leanToDrains, leanToPurlinDepthMm }
 *       （翼＝leanToWingsOf。leanToDrains＝水下・leanToPurlinDepthMm＝母屋の段の基準＝長手方向の翼の奥行き。
 *       描画の母屋・棟木・隅木・谷木は水下への距離の場［leanToDrainFraming］、外周の梁・床梁のガードは翼のセル、
 *       小屋梁［面ごと。woodRoofFraming.js］は水下ごとの面）。
 *     ・下屋の切妻（L字。腕ごとに棟木）:
 *       { key:'lean:…', rect:null, rects, shape:'gable', ridgeIsVertical:null, highSide:null, leanToDrains, leanToPurlinDepthMm }
 *       （翼は持たない。軒・けらばは gableArmDrainsOf が辺を掃いて決め、leanToDrains＝軒の辺・leanToPurlinDepthMm＝長手方向の腕の
 *       半スパン。水下が空・けらばが無い形は region なし）
 *       陸屋根・棟違いの下屋、全周が壁・向かい合う壁の間の下屋は region なし
 *   - 形状（自動なら導いた形状）が片流れ・切妻・寄棟（陸屋根・棟違いは小屋組を持たない）
 * ridgeIsVertical は切妻だけ spec.ridgeDirection（指定が無ければ長手）に従う。他の形状は常に長手。
 * 形状・範囲・高い側の判断は既存の関数（mainRoof.js・roofDefaults.js・roofOrientation.js・roofGeometry.js）を
 * そのまま使い、ここで複製しない。
 *
 * 平面の表示（軒先・棟木・隅木・谷木の細線）用は別入口 leanToPlanRegions（構造ゲートなし・全構造種別・補完 region あり。
 * 伏図用の結果は変えない）。
 *
 * どの graph から作るか（呼び出し側は roofFramingRegionsForFigure を使う）:
 *   主屋根＝最上階の graph（屋根専用平面＝小屋伏図では柱レイヤ columnMap の供給階。mainRoofSpec と部屋を持つ）。
 *   下屋＝屋根セルのある階の graph（その階の伏図の自階 graph）。
 */
import {
  isRoofFeature, RoofShape, CL_OVERLAP_TOL_MM, DEFAULT_ROOF_EAVE_OVERHANG_MM, DEFAULT_ROOF_GABLE_OVERHANG_MM,
} from '../core/constants.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { mainRoofBounds, resolveMainRoofShape, mainRoofHighSideView } from '../finish/roof/mainRoof.js';
import { resolveRoofShape, roofRoomBounds } from '../finish/roof/roofDefaults.js';
import { roofHighSideViewOfRoom, roofEdgeInteriorAdjacency, roofEdgeInteriorContacts, roofBoundaryInteriorContacts, roofInteriorRects } from '../finish/roof/roofOrientation.js';
import { rectOfBounds, resolveRoofRidgeIsVertical, resolveRoofHighSide } from '../finish/roof/roofGeometry.js';
import { refreshCells } from '../finish/gridCells.js';
import { roofRidgeIsVertical, roofOutline, roofOutlineExposedPaths, orthogonalBoundaryLoops, leanToDrainRoute, eaveBeamCorners } from './roofFramingGeometry.js';
import { showRoofFraming, roofFramingWidths, roofFramingHostMembers, roofFramingPrimitives } from './framingDrawing.js';

/** 小屋組を持つ形状（陸屋根・棟違いは持たない）。 */
const FRAMING_SHAPES = new Set([RoofShape.MONO, RoofShape.GABLE, RoofShape.HIP]);

/**
 * region の棟木の向き。指定（spec.ridgeDirection）が効くのは切妻だけ。それ以外の形状は従来の長手
 * （寄棟の棟木は長手に沿わないと成り立たない。片流れは棟木が無い）。
 */
function regionRidgeIsVertical(shape, spec, rect) {
  if (shape !== RoofShape.GABLE) return roofRidgeIsVertical(rect, CL_OVERLAP_TOL_MM);
  return resolveRoofRidgeIsVertical(spec?.ridgeDirection ?? null, rect, CL_OVERLAP_TOL_MM);
}

/** 出幅の値。非有限・負は既定値（RoofSpec.fromData と同じ。描画で例外にしない）。 */
function overhangOf(v, fallback) {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * region に屋根の外形線（軒先・けらば。ステップ D1）を足す。outline＝閉路ごとの点列 [{points}]、edges＝辺の部分ごとの出幅
 * [{isVertical, coord, lo, hi, outward, overhangMm}]（母屋・棟木・隅木の延長＝D2 が使う）。基準は屋根範囲の辺（通り芯）。
 * zeroZones＝出幅 0 の区間（下屋の辺が屋内に接する部分）。kindZones＝辺の部分ごとの種別（L字の下屋の翼。leanToWingsOf。
 * 無ければ null＝形状から辺ごとに決める）。interiorRects＝建物範囲のセル矩形（外形線が建物の出隅を回り込む判定。null なら回り込まない。
 * 回り込みは outline の点列（と平面の exposedPaths）だけを変え、edges は変えない）。
 */
function withOutline(region, spec, zeroZones = [], kindZones = null, interiorRects = null) {
  const { edges, outline } = roofOutline(outlineArgs(region, spec, zeroZones, kindZones, interiorRects));
  return { ...region, edges, outline };
}

/** roofOutline・roofOutlineExposedPaths に渡す引数（withOutline と平面の exposedPaths が共有する）。 */
function outlineArgs(region, spec, zeroZones, kindZones, interiorRects = null) {
  return {
    rects: region.rect ? [region.rect] : region.rects,
    shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    eaveOverhangMm: overhangOf(spec?.eaveOverhangMm, DEFAULT_ROOF_EAVE_OVERHANG_MM),
    gableOverhangMm: overhangOf(spec?.gableOverhangMm, DEFAULT_ROOF_GABLE_OVERHANG_MM),
    zeroZones, kindZones, interiorRects, tolMm: CL_OVERLAP_TOL_MM,
  };
}

/** セル矩形（有効なもの＝有限で幅・高さが正のもののコピー）。無ければ null。矩形でない屋根範囲の region の rects。 */
function validCellRects(bounds) {
  const rects = (bounds ?? [])
    .filter(b => b && [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) && b.x2 > b.x1 && b.y2 > b.y1)
    .map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }));
  return rects.length === 0 ? null : rects;
}

/**
 * 矩形でない主屋根の region（ステップ C2e-2）。形状（自動なら導いた形状）が寄棟のときだけ作る（矩形でない切妻・片流れは
 * 小屋組を持たない）。rect=null・rects＝セル矩形（有効なもののコピー。無ければ null を返す）。描画（棟木・母屋・束）と
 * 小屋梁・飛び梁の生成（woodRoofFraming.js C2e-3b）に使う。
 */
function hipOnlyRegion(topGraph, project, bounds) {
  const rects = validCellRects(bounds);
  if (!rects) return null;
  if (resolveMainRoofShape(topGraph, project) !== RoofShape.HIP) return null;
  return withOutline({ key: 'main', rect: null, rects, shape: RoofShape.HIP, ridgeIsVertical: null, highSide: null }, topGraph.mainRoofSpec);
}

/** 主屋根（最上階の建物範囲）の小屋組の region。条件を満たさなければ null。 */
export function mainRoofFramingRegion(topGraph, project) {
  if (!topGraph) return null;
  if (!rulesFor(effectiveStructure(topGraph, project)).framing) return null;
  const bounds = mainRoofBounds(topGraph);
  const rect = rectOfBounds(bounds);
  if (!rect) return hipOnlyRegion(topGraph, project, bounds);
  const shape = resolveMainRoofShape(topGraph, project);
  if (!FRAMING_SHAPES.has(shape)) return null;
  const highSide = shape === RoofShape.MONO ? mainRoofHighSideView(topGraph, project).value : null;
  return withOutline({ key: 'main', rect, shape, ridgeIsVertical: regionRidgeIsVertical(shape, topGraph.mainRoofSpec, rect), highSide }, topGraph.mainRoofSpec);
}

/**
 * 下屋の region と、その元の部屋の組（leanToFramingRegions・leanToFramingCellKeys の共通の導出）。
 * 矩形でない下屋（L字）の片流れ・切妻・寄棟も region にする（描画・外周の梁・床梁のガード・小屋梁が同じ region を使う。ステップ E2b。
 * 寄棟は2026-10-05）。片流れの L字の region は
 * { key, rect:null, rects, shape:'mono', ridgeIsVertical:null, highSide:null, leanToWings, leanToUnassigned, leanToDrains,
 *   leanToPurlinDepthMm, edges, outline }。切妻・寄棟の L字は翼なし。導出は framingRegionOfRoom（leanToDrainRoute）。
 * 形状（自動なら導いた形状）が片流れ・切妻・寄棟のときだけ（陸屋根・棟違いは region なし）。翼がひとつも
 * 作れなければ（屋根範囲に有効なセルが無い）・水下が空（全周が壁など）なら region なし。
 */
function leanToFramingEntries(graph, project) {
  if (!graph) return [];
  if (!rulesFor(effectiveStructure(graph, project)).framing) return [];
  const entries = [];
  for (const room of graph.rooms) {
    if (!isRoofFeature(room.feature) || !room.roofSpec) continue;
    const r = framingRegionOfRoom(room, graph);
    if (r) entries.push({ room, region: r.region });
  }
  return entries;
}

/**
 * 下屋1部屋の小屋組の region（構造ゲートは見ない。leanToFramingEntries が部屋ごとに呼ぶ）。region にならなければ null。
 * 水下の振り分けは leanToDrainRoute（roofFramingGeometry.js。2026-10-05 裁定: 下屋は壁へ下る面を作らない）で、ここは結果に従って
 * region を組むだけ（平面と伏図が同じ region を使う）。
 *  - kind 'rect': 矩形の region { key, rect, shape, ridgeIsVertical, highSide }。**shape は実効の小屋組の形状**
 *    （欄の表示＝resolveRoofShape が切妻でも、棟木が壁と平行なら片流れ。保存値は変えない）
 *  - kind 'field': 水下の場の region { key, rect:null, rects, shape, ridgeIsVertical:null, highSide:null, leanToDrains（壁を除いた水下）,
 *    leanToPurlinDepthMm（母屋の段の基準）, ＋L字の片流れだけ leanToWings・leanToUnassigned }。矩形の下屋でも壁に一部接するとき
 *    （一部だけ壁の片流れ・切妻、壁に接する寄棟）はこちら（rects＝[rect]）。L字の切妻・明示の寄棟もこちら
 *  - kind 'none'（陸屋根・棟違い・全周が壁・向かい合う壁の間・けらばの無い L字の切妻・翼の無い L字の片流れ）: null
 * zeroZones・kindZones は region の外形線に使った出幅 0 の区間・辺の部分ごとの種別（平面の exposedPaths が同じ入力で
 * roofOutlineExposedPaths を呼ぶために返す。矩形の kind 'rect' は kindZones=null）。
 * @returns {{region: object, zeroZones: Array<object>, kindZones: Array<object>|null}|null}
 */
function framingRegionOfRoom(room, graph) {
  const boundsList = roofRoomBounds(room, graph);
  const rect = rectOfBounds(boundsList);
  const rects = rect ? [rect] : validCellRects(boundsList);
  if (!rects) return null;
  const shape = resolveRoofShape(room.roofSpec, { boundsList });
  if (!FRAMING_SHAPES.has(shape)) return null;
  const interiorRects = roofInteriorRects(graph); // 屋内のセル矩形（接する区間と外形線の回り込みの判定が共用）
  // 屋内に接する区間＝壁（出幅 0 の区間。水下から除く）
  const zeroZones = rect
    ? roofEdgeInteriorContacts(rect, graph, interiorRects)
    : roofBoundaryInteriorContacts(orthogonalBoundaryLoops({ rects, tolMm: CL_OVERLAP_TOL_MM }).flat(), graph, interiorRects);
  const mono = !!rect && shape === RoofShape.MONO;
  const route = leanToDrainRoute({
    shape, rect, rects,
    ridgeIsVertical: rect && shape === RoofShape.GABLE ? regionRidgeIsVertical(shape, room.roofSpec, rect) : null,
    highSide: mono ? roofHighSideViewOfRoom(room, graph).value : null,
    autoHighSide: mono ? resolveRoofHighSide(null, rect, roofEdgeInteriorAdjacency(rect, graph)) : null,
    zeroZones, tolMm: CL_OVERLAP_TOL_MM,
  });
  if (route.kind === 'none') return null;
  const key = `lean:${room.id}`;
  if (route.kind === 'rect') {
    const region = { key, rect, shape: route.shape, ridgeIsVertical: regionRidgeIsVertical(route.shape, room.roofSpec, rect), highSide: route.highSide };
    return { region: withOutline(region, room.roofSpec, zeroZones, null, interiorRects), zeroZones, kindZones: null, interiorRects };
  }
  const region = {
    key, rect: null, rects, shape: route.shape, ridgeIsVertical: null, highSide: null,
    ...(route.wings ? { leanToWings: route.wings, leanToUnassigned: route.unassigned } : {}),
    leanToDrains: route.drains, leanToPurlinDepthMm: route.purlinDepthMm,
  };
  return { region: withOutline(region, room.roofSpec, zeroZones, route.kindZones, interiorRects), zeroZones, kindZones: route.kindZones, interiorRects };
}

/**
 * 平面の表示（外形線）だけのための補完 region。framingRegionOfRoom が null のとき（陸屋根・棟違い・全周が壁・向かい合う壁の間・
 * けらばの無い L字の切妻・翼の無い L字の片流れ）に作る。範囲が空・不正なら null。
 * 外形線は全辺を軒とみなす（kindZones＝全辺 'eave'。roofEdgeKind は陸屋根で RangeError のため kindZones の経路を通す）。
 * 線は外形だけ（outlineOnly:true。棟木・隅木・谷木・傾斜ラベルは出さない）。shape は実効値のまま。
 * @returns {{region: object, zeroZones: Array<object>, kindZones: Array<object>}|null}
 */
function planOutlineOnlyRegion(room, graph) {
  const boundsList = roofRoomBounds(room, graph);
  const rect = rectOfBounds(boundsList);
  const rects = rect ? [rect] : validCellRects(boundsList);
  if (!rects) return null;
  const shape = resolveRoofShape(room.roofSpec, { boundsList });
  const edges = orthogonalBoundaryLoops({ rects, tolMm: CL_OVERLAP_TOL_MM }).flat();
  const interiorRects = roofInteriorRects(graph);
  const zeroZones = roofBoundaryInteriorContacts(edges, graph, interiorRects); // 屋内に接する部分は出幅 0（壁の中に重なるので線を描かない）
  const kindZones = edges.map(e => ({ isVertical: e.isVertical, coord: e.coord, lo: e.lo, hi: e.hi, outward: e.outward, kind: 'eave' }));
  const region = { key: `lean:${room.id}`, rect, shape, ridgeIsVertical: null, highSide: null, outlineOnly: true };
  if (!rect) region.rects = rects;
  return { region: withOutline(region, room.roofSpec, zeroZones, kindZones, interiorRects), zeroZones, kindZones, interiorRects };
}

/**
 * 平面に描く下屋（屋根セルのある階の屋根の部屋）ごとの region。構造ゲートは見ない（全構造種別で出す。project 不要）。
 * 部屋ごとに framingRegionOfRoom の結果（伏図と同じ幾何）、無ければ平面専用の補完 region（planOutlineOnlyRegion）。
 * どちらも平面用に exposedPaths（roofOutlineExposedPaths。壁の中に重なる部分を除いた外形線）・slope（roofSpec.slope）・
 * zeroZones（屋内に接する区間。S5b で旧 roofPlanWallTrim.js〔壁に当たる線の端止め〕が消え、今は読む製品コードが無い）を足す
 * ・planDrains（傾斜ラベルの水下。planDrainsOf）を足す
 * （伏図用の region＝leanToFramingRegions には足さない）。範囲が空・不正・roofSpec が無い部屋は出ない。
 * 戻り値は読み取り専用（renderer の graphComputed が共有する）。
 */
export function leanToPlanRegions(graph) {
  if (!graph) return [];
  const out = [];
  for (const room of graph.rooms) {
    if (!isRoofFeature(room.feature) || !room.roofSpec) continue;
    const r = framingRegionOfRoom(room, graph) ?? planOutlineOnlyRegion(room, graph);
    if (!r) continue;
    out.push({
      ...r.region,
      exposedPaths: roofOutlineExposedPaths(outlineArgs(r.region, room.roofSpec, r.zeroZones, r.kindZones, r.interiorRects)),
      slope: room.roofSpec.slope,
      zeroZones: r.zeroZones,
      planDrains: planDrainsOf(r.region),
    });
  }
  return out;
}

/**
 * 平面の傾斜ラベル用の水下（流れの先の軒の辺。{isVertical, coord, lo, hi, outward}）。矩形の片流れ＝高い側の反対の辺・切妻＝棟木と
 * 平行な2辺・寄棟（矩形の kind:'rect' の region。壁に接しないので全辺）・水下の場の region＝leanToDrains（壁を除いた水下）。陸屋根・
 * 外形線だけの region（outlineOnly。棟違い・全周が壁・向かい合う壁の間など）は []（ラベルなし）。
 */
function planDrainsOf(region) {
  if (region.outlineOnly) return [];
  if (region.leanToDrains) return region.leanToDrains.map(({ isVertical, coord, lo, hi, outward }) => ({ isVertical, coord, lo, hi, outward }));
  const rects = region.rect ? [region.rect] : region.rects;
  const edges = orthogonalBoundaryLoops({ rects, tolMm: CL_OVERLAP_TOL_MM }).flat()
    .map(({ isVertical, coord, lo, hi, outward }) => ({ isVertical, coord, lo, hi, outward }));
  if (region.shape === RoofShape.HIP) return edges;
  if (!region.rect) return [];
  if (region.shape === RoofShape.GABLE) return edges.filter(e => e.isVertical === region.ridgeIsVertical);
  if (region.shape === RoofShape.MONO) {
    const verticalFlow = region.highSide === 'left' || region.highSide === 'right'; // 縦の水下（左右の辺）
    const outward = region.highSide === 'top' || region.highSide === 'left' ? 1 : -1; // 高い側の反対の辺の外向き
    return edges.filter(e => e.isVertical === verticalFlow && e.outward === outward);
  }
  return [];
}

/**
 * 下屋（屋根セルのある階の屋根の部屋）ごとの小屋組の region。条件を満たす部屋だけの配列（無ければ空）。
 * 矩形でない下屋（L字）の片流れも含む（leanToFraming・leanToFramingCellKeys と同じ結果）。
 */
export function leanToFramingRegions(graph, project) {
  return leanToFramingEntries(graph, project).map(e => e.region);
}

/**
 * 小屋組の対象の下屋（leanToFramingRegions が region を返す部屋）のセルキー → その下屋の region の key の Map
 * （現在の格子で解決。無ければ空。`.has`・`.size` は集合と同じに使える）。自階単独ゲート（wallGate.js
 * buildSelfFootprintGate の roofPerimeterCellKeys）と床梁のガード（woodAutoFill.js autoFillWoodFloorBeams）が
 * 共有する「対象の屋根セル」。値（どの下屋のセルか）はゲートが使う——隣り合う別々の下屋の境界も、
 * それぞれの下屋の外周として扱うため。
 */
export function leanToFramingCellKeys(graph, project) {
  return cellKeysOfEntries(leanToFramingEntries(graph, project), graph);
}

function cellKeysOfEntries(entries, graph) {
  const keys = new Map();
  for (const { room, region } of entries) {
    for (const key of refreshCells(room.cells, graph)) keys.set(key, region.key);
  }
  return keys;
}

/**
 * 実体階の再計算が1回の部屋の走査で両方を得る入口: 下屋の region 群（小屋梁の生成。woodRoofFraming.js）と
 * セルキー（外周の梁・床梁のガード）。結果は leanToFramingRegions・leanToFramingCellKeys と同じ。
 */
export function leanToFraming(graph, project) {
  const entries = leanToFramingEntries(graph, project);
  return { regions: entries.map(e => e.region), cellKeys: cellKeysOfEntries(entries, graph) };
}

/**
 * 表示中の伏図に描く小屋組の region 群。屋根専用平面（小屋伏図）は主屋根（最上階の graph から）、
 * 実体階の伏図は下屋（自階の graph から）。屋根専用平面に下屋は、実体階に主屋根は載せない。
 * @param {object} p
 * @param {boolean} p.isRoofPlane 主題階が屋根専用平面か（composition.subjectPlane.isRoofPlane）
 * @param {object|null} p.subjectGraph 主題階（自階）の graph（beamMap の供給階）
 * @param {object|null} p.topGraph 屋根専用平面のときの最上階の graph（columnMap の供給階）
 * @param {object|null} p.project
 * @param {(graph: object|null, key: string, compute: () => Array<object>) => Array<object>} [p.memo]
 *   region の導出（建物範囲・形状の計算。moku4 で約13ms）を graph 単位に使い回す関数。renderer の graphComputed
 *   （MobX の computed）を呼び出し側が渡す——純モジュールから renderer を import しないため引数で受ける。
 *   省略時は毎回計算する。compute は graph の observable と project だけから結果を決める（key に符号化する非observableは無い）。
 *   戻り値は読み取り専用（同じインスタンスが共有される）。
 */
export function roofFramingRegionsForFigure({ isRoofPlane, subjectGraph, topGraph, project, memo = (_graph, _key, compute) => compute() }) {
  if (isRoofPlane) {
    return memo(topGraph, 'roofFramingMainRegions', () => {
      const region = mainRoofFramingRegion(topGraph, project);
      return region ? [region] : [];
    });
  }
  return memo(subjectGraph, 'roofFramingLeanRegions', () => leanToFramingRegions(subjectGraph, project));}

/**
 * 表示中の伏図で、軒の側の梁が出隅で勝ってけらばの出幅ぶん延びる角（beamJunction.js resolveBeamJunctionSpans の eaveCorners。
 * 描画だけ）。小屋組の外形線を描く条件（showRoofFraming）と同じときだけ。下屋（実体階の伏図）と主屋根（屋根専用平面＝小屋伏図の
 * 軒桁。2026-10-05 ユーザー裁定で主屋根へ拡大）の両方が対象。主屋根は寄棟（全辺が軒）・region なし・陸屋根・topGraph 無しなら []。
 * region は roofFramingFigurePrimitives と同じ memo のもの。
 * @param {object} p roofFramingFigurePrimitives と同じ（widths は不要）
 * @returns {Array<{x:number, y:number, eaveIsVertical:boolean, extendMm:number}>}
 */
export function roofFramingEaveCorners({ rules, lod, isRoofPlane, subjectGraph, topGraph, project, memo }) {
  if (!subjectGraph || !showRoofFraming(rules.drawing, lod)) return [];
  const regions = roofFramingRegionsForFigure({ isRoofPlane, subjectGraph, topGraph, project, memo });
  return regions.flatMap(region => eaveBeamCorners(region, CL_OVERLAP_TOL_MM));
}

/**
 * 表示中の伏図に描く小屋組のプリミティブ（renderer/StructuralLayer.jsx はこれを描くだけ）。描かない条件
 * （非在来・略図）では region の導出（graph の読み）自体を省いて [] を返す。
 * 束を立てる横架材は主題階（自階）の graph の梁（beamMap の供給階）——小屋伏図では屋根専用平面の軒桁など、
 * 下屋の伏図ではその階の壁線の通し梁。
 * @param {object} p
 * @param {object} p.rules 主題階の rulesFor(effectiveStructure(...))
 * @param {string} p.lod LodLevel
 * @param {boolean} p.isRoofPlane
 * @param {object|null} p.subjectGraph beamMap の供給階（自階）
 * @param {object|null} p.topGraph columnMap の供給階（屋根専用平面のとき最上階）
 * @param {object|null} p.project
 * @param {Function} [p.memo] roofFramingRegionsForFigure の memo（StructuralLayer が graphComputed を渡す）
 */
export function roofFramingFigurePrimitives({ rules, lod, isRoofPlane, subjectGraph, topGraph, project, memo }) {
  if (!showRoofFraming(rules.drawing, lod)) return [];
  const widths = roofFramingWidths(rules.framing);
  if (!widths || !subjectGraph) return [];
  const regions = roofFramingRegionsForFigure({ isRoofPlane, subjectGraph, topGraph, project, memo });
  if (regions.length === 0) return [];
  return roofFramingPrimitives(rules.drawing, lod, {
    regions,
    hostBeams: roofFramingHostMembers(subjectGraph.beams, rules.baseMaterial),
    ...widths,
    purlinPitchMm: rules.framing.purlinPitchMm,
    purlinStartOffsetsMm: rules.framing.purlinStartOffsetsMm,
    tolMm: CL_OVERLAP_TOL_MM,
  });
}
