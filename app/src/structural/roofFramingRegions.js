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
 *     ・下屋の片流れ（L字。ステップ E1b・E2b）:
 *       { key:'lean:…', rect:null, rects, shape:'mono', ridgeIsVertical:null, highSide:null, leanToWings, leanToUnassigned }
 *       （翼＝leanToWingsOf。描画・外周の梁・床梁のガード・小屋梁［面ごと。woodRoofFraming.js］）。
 *       他の形状の矩形でない下屋は region なし
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
import { roofHighSideViewOfRoom, roofEdgeInteriorContacts, roofBoundaryInteriorContacts } from '../finish/roof/roofOrientation.js';
import { rectOfBounds, resolveRoofRidgeIsVertical } from '../finish/roof/roofGeometry.js';
import { refreshCells } from '../finish/gridCells.js';
import { roofRidgeIsVertical, roofOutline, roofOutlineExposedPaths, orthogonalBoundaryLoops, leanToWingsOf } from './roofFramingGeometry.js';
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
 * 無ければ null＝形状から辺ごとに決める）。
 */
function withOutline(region, spec, zeroZones = [], kindZones = null) {
  const { edges, outline } = roofOutline(outlineArgs(region, spec, zeroZones, kindZones));
  return { ...region, edges, outline };
}

/** roofOutline・roofOutlineExposedPaths に渡す引数（withOutline と平面の exposedPaths が共有する）。 */
function outlineArgs(region, spec, zeroZones, kindZones) {
  return {
    rects: region.rect ? [region.rect] : region.rects,
    shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    eaveOverhangMm: overhangOf(spec?.eaveOverhangMm, DEFAULT_ROOF_EAVE_OVERHANG_MM),
    gableOverhangMm: overhangOf(spec?.gableOverhangMm, DEFAULT_ROOF_GABLE_OVERHANG_MM),
    zeroZones, kindZones, tolMm: CL_OVERLAP_TOL_MM,
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
 * 矩形でない下屋（L字）の片流れも region にする（描画・外周の梁・床梁のガード・小屋梁が同じ region を使う。ステップ E2b）。
 * L字の region は
 * { key, rect:null, rects, shape:'mono', ridgeIsVertical:null, highSide:null, leanToWings, leanToUnassigned, edges, outline }。
 * 形状（自動なら導いた形状）が片流れのときだけ（切妻になる L字・明示の寄棟や陸屋根は region なし）。翼がひとつも
 * 作れなければ（屋根範囲に有効なセルが無い）region なし。
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
 * zeroZones・kindZones は region の外形線に使った出幅 0 の区間・辺の部分ごとの種別（平面の exposedPaths が同じ入力で
 * roofOutlineExposedPaths を呼ぶために返す。矩形は kindZones=null）。
 * @returns {{region: object, zeroZones: Array<object>, kindZones: Array<object>|null}|null}
 */
function framingRegionOfRoom(room, graph) {
  const boundsList = roofRoomBounds(room, graph);
  const rect = rectOfBounds(boundsList);
  if (!rect) {
    const rects = validCellRects(boundsList);
    if (!rects || resolveRoofShape(room.roofSpec, { boundsList }) !== RoofShape.MONO) return null;
    const edges = orthogonalBoundaryLoops({ rects, tolMm: CL_OVERLAP_TOL_MM }).flat();
    const contacts = roofBoundaryInteriorContacts(edges, graph); // 屋内に接する区間＝翼の壁・出幅 0 の区間
    const { wings, unassigned, kindZones } = leanToWingsOf({ rects, contacts, tolMm: CL_OVERLAP_TOL_MM });
    if (wings.length === 0) return null;
    const region = {
      key: `lean:${room.id}`, rect: null, rects, shape: RoofShape.MONO, ridgeIsVertical: null, highSide: null,
      leanToWings: wings, leanToUnassigned: unassigned,
    };
    return { region: withOutline(region, room.roofSpec, contacts, kindZones), zeroZones: contacts, kindZones };
  }
  const shape = resolveRoofShape(room.roofSpec, { boundsList });
  if (!FRAMING_SHAPES.has(shape)) return null;
  const highSide = shape === RoofShape.MONO ? roofHighSideViewOfRoom(room, graph).value : null;
  const region = { key: `lean:${room.id}`, rect, shape, ridgeIsVertical: regionRidgeIsVertical(shape, room.roofSpec, rect), highSide };
  const zeroZones = roofEdgeInteriorContacts(rect, graph); // 屋内に接する部分は出幅 0
  return { region: withOutline(region, room.roofSpec, zeroZones), zeroZones, kindZones: null };
}

/**
 * 平面の表示（軒先・棟木・隅木・谷木の線）だけのための補完 region。framingRegionOfRoom が null のとき（陸屋根・棟違い・
 * 切妻になる L字・片流れで翼が0の L字・明示の寄棟の L字）に作る。範囲が空・不正なら null。
 * 外形線は全辺を軒とみなす（kindZones＝全辺 'eave'。roofEdgeKind は陸屋根で RangeError のため kindZones の経路を通す）。
 * 明示の寄棟の L字だけ shape が寄棟で、棟木・隅木・谷木が導かれる。他は shape を実効値のままにするが線は外形だけ
 * （roofRidgeLines・roofHipDiagonals が寄棟・L字の片流れの翼以外に空を返す）。
 * @returns {{region: object, zeroZones: Array<object>, kindZones: Array<object>}|null}
 */
function planOutlineOnlyRegion(room, graph) {
  const boundsList = roofRoomBounds(room, graph);
  const rect = rectOfBounds(boundsList);
  const rects = rect ? [rect] : validCellRects(boundsList);
  if (!rects) return null;
  const shape = resolveRoofShape(room.roofSpec, { boundsList });
  const edges = orthogonalBoundaryLoops({ rects, tolMm: CL_OVERLAP_TOL_MM }).flat();
  const zeroZones = roofBoundaryInteriorContacts(edges, graph); // 屋内に接する部分は出幅 0（壁の中に重なるので線を描かない）
  const kindZones = edges.map(e => ({ isVertical: e.isVertical, coord: e.coord, lo: e.lo, hi: e.hi, outward: e.outward, kind: 'eave' }));
  const region = { key: `lean:${room.id}`, rect, shape, ridgeIsVertical: null, highSide: null };
  if (!rect) region.rects = rects;
  return { region: withOutline(region, room.roofSpec, zeroZones, kindZones), zeroZones, kindZones };
}

/**
 * 平面に描く下屋（屋根セルのある階の屋根の部屋）ごとの region。構造ゲートは見ない（全構造種別で出す。project 不要）。
 * 部屋ごとに framingRegionOfRoom の結果（伏図と同じ幾何）、無ければ平面専用の補完 region（planOutlineOnlyRegion）。
 * どちらも平面用に exposedPaths（roofOutlineExposedPaths。壁の中に重なる部分を除いた外形線）と slope（roofSpec.slope）を足す
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
      exposedPaths: roofOutlineExposedPaths(outlineArgs(r.region, room.roofSpec, r.zeroZones, r.kindZones)),
      slope: room.roofSpec.slope,
    });
  }
  return out;
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
