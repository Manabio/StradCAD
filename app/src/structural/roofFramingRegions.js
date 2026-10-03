/**
 * 小屋組（棟木・母屋・束）を描く屋根の範囲（region）の導出。ステップ C3a。graph を読む（幾何の純関数は
 * roofFramingGeometry.js、描画の判断は framingDrawing.js roofFramingPrimitives）。store.js / snap.js / .jsx を
 * 静的に import しない（node:test から単体で import できる）。
 *
 * region＝{ key, rect, shape, ridgeIsVertical, highSide }。次をすべて満たす屋根だけが region になる:
 *   - 在来木造（rulesFor(effectiveStructure(graph, project)).framing が真。構造種別の直接比較はしない）
 *   - 範囲が矩形（rectOfBounds が非 null）。矩形でない主屋根は寄棟のときだけ例外で、
 *     { key:'main', rect:null, rects:セル矩形の配列, shape:'hip', ridgeIsVertical:null, highSide:null }（描画と、
 *     翼ごとの小屋梁・飛び梁の生成＝woodRoofFraming.js C2e-3b。下屋の矩形でない範囲は region なし）
 *   - 形状（自動なら導いた形状）が片流れ・切妻・寄棟（陸屋根・棟違いは小屋組を持たない）
 * ridgeIsVertical は切妻だけ spec.ridgeDirection（指定が無ければ長手）に従う。他の形状は常に長手。
 * 形状・範囲・高い側の判断は既存の関数（mainRoof.js・roofDefaults.js・roofOrientation.js・roofGeometry.js）を
 * そのまま使い、ここで複製しない。
 *
 * どの graph から作るか（呼び出し側は roofFramingRegionsForFigure を使う）:
 *   主屋根＝最上階の graph（屋根専用平面＝小屋伏図では柱レイヤ columnMap の供給階。mainRoofSpec と部屋を持つ）。
 *   下屋＝屋根セルのある階の graph（その階の伏図の自階 graph）。
 */
import { isRoofFeature, RoofShape, CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { mainRoofBounds, resolveMainRoofShape, mainRoofHighSideView } from '../finish/roof/mainRoof.js';
import { resolveRoofShape, roofRoomBounds } from '../finish/roof/roofDefaults.js';
import { roofHighSideViewOfRoom } from '../finish/roof/roofOrientation.js';
import { rectOfBounds, resolveRoofRidgeIsVertical } from '../finish/roof/roofGeometry.js';
import { refreshCells } from '../finish/gridCells.js';
import { roofRidgeIsVertical } from './roofFramingGeometry.js';
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

/**
 * 矩形でない主屋根の region（ステップ C2e-2）。形状（自動なら導いた形状）が寄棟のときだけ作る（矩形でない切妻・片流れは
 * 小屋組を持たない）。rect=null・rects＝セル矩形（有効なもののコピー。無ければ null を返す）。描画（棟木・母屋・束）と
 * 小屋梁・飛び梁の生成（woodRoofFraming.js C2e-3b）に使う。
 */
function hipOnlyRegion(topGraph, project, bounds) {
  const rects = (bounds ?? [])
    .filter(b => b && [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) && b.x2 > b.x1 && b.y2 > b.y1)
    .map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }));
  if (rects.length === 0) return null;
  if (resolveMainRoofShape(topGraph, project) !== RoofShape.HIP) return null;
  return { key: 'main', rect: null, rects, shape: RoofShape.HIP, ridgeIsVertical: null, highSide: null };
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
  return { key: 'main', rect, shape, ridgeIsVertical: regionRidgeIsVertical(shape, topGraph.mainRoofSpec, rect), highSide };
}

/** 下屋の region と、その元の部屋の組（leanToFramingRegions・leanToFramingCellKeys の共通の導出）。 */
function leanToFramingEntries(graph, project) {
  if (!graph) return [];
  if (!rulesFor(effectiveStructure(graph, project)).framing) return [];
  const entries = [];
  for (const room of graph.rooms) {
    if (!isRoofFeature(room.feature) || !room.roofSpec) continue;
    const boundsList = roofRoomBounds(room, graph);
    const rect = rectOfBounds(boundsList);
    if (!rect) continue;
    const shape = resolveRoofShape(room.roofSpec, { boundsList });
    if (!FRAMING_SHAPES.has(shape)) continue;
    const highSide = shape === RoofShape.MONO ? roofHighSideViewOfRoom(room, graph).value : null;
    entries.push({ room, region: { key: `lean:${room.id}`, rect, shape, ridgeIsVertical: regionRidgeIsVertical(shape, room.roofSpec, rect), highSide } });
  }
  return entries;
}

/** 下屋（屋根セルのある階の屋根の部屋）ごとの小屋組の region。条件を満たす部屋だけの配列（無ければ空）。 */
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
  return memo(subjectGraph, 'roofFramingLeanRegions', () => leanToFramingRegions(subjectGraph, project));
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
