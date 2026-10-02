/**
 * 小屋組（棟木・母屋・束）を描く屋根の範囲（region）の導出。ステップ C3a。graph を読む（幾何の純関数は
 * roofFramingGeometry.js、描画の判断は framingDrawing.js roofFramingPrimitives）。store.js / snap.js / .jsx を
 * 静的に import しない（node:test から単体で import できる）。
 *
 * region＝{ key, rect, shape, ridgeIsVertical, highSide }。次をすべて満たす屋根だけが region になる:
 *   - 在来木造（rulesFor(effectiveStructure(graph, project)).framing が真。構造種別の直接比較はしない）
 *   - 範囲が矩形（rectOfBounds が非 null。矩形でない屋根は後続ステップ）
 *   - 形状（自動なら導いた形状）が片流れ・切妻・寄棟（陸屋根・棟違いは小屋組を持たない）
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
import { rectOfBounds } from '../finish/roof/roofGeometry.js';
import { roofRidgeIsVertical } from './roofFramingGeometry.js';
import { showRoofFraming, roofFramingWidths, roofFramingHostMembers, roofFramingPrimitives } from './framingDrawing.js';

/** 小屋組を持つ形状（陸屋根・棟違いは持たない）。 */
const FRAMING_SHAPES = new Set([RoofShape.MONO, RoofShape.GABLE, RoofShape.HIP]);

/** 主屋根（最上階の建物範囲）の小屋組の region。条件を満たさなければ null。 */
export function mainRoofFramingRegion(topGraph, project) {
  if (!topGraph) return null;
  if (!rulesFor(effectiveStructure(topGraph, project)).framing) return null;
  const rect = rectOfBounds(mainRoofBounds(topGraph));
  if (!rect) return null;
  const shape = resolveMainRoofShape(topGraph, project);
  if (!FRAMING_SHAPES.has(shape)) return null;
  const highSide = shape === RoofShape.MONO ? mainRoofHighSideView(topGraph, project).value : null;
  return { key: 'main', rect, shape, ridgeIsVertical: roofRidgeIsVertical(rect, CL_OVERLAP_TOL_MM), highSide };
}

/** 下屋（屋根セルのある階の屋根の部屋）ごとの小屋組の region。条件を満たす部屋だけの配列（無ければ空）。 */
export function leanToFramingRegions(graph, project) {
  if (!graph) return [];
  if (!rulesFor(effectiveStructure(graph, project)).framing) return [];
  const regions = [];
  for (const room of graph.rooms) {
    if (!isRoofFeature(room.feature) || !room.roofSpec) continue;
    const boundsList = roofRoomBounds(room, graph);
    const rect = rectOfBounds(boundsList);
    if (!rect) continue;
    const shape = resolveRoofShape(room.roofSpec, { boundsList });
    if (!FRAMING_SHAPES.has(shape)) continue;
    const highSide = shape === RoofShape.MONO ? roofHighSideViewOfRoom(room, graph).value : null;
    regions.push({ key: `lean:${room.id}`, rect, shape, ridgeIsVertical: roofRidgeIsVertical(rect, CL_OVERLAP_TOL_MM), highSide });
  }
  return regions;
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
    purlinPitchesMm: rules.framing.purlinPitchesMm,
    maxEaveGapMm: rules.framing.purlinMaxEaveGapMm,
    tolMm: CL_OVERLAP_TOL_MM,
  });
}
