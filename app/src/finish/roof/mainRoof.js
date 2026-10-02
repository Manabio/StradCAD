/**
 * 主屋根（最上階の外部タブ先頭の固定の群「屋根」）の導出。ステップ B3。
 *
 * 主屋根は最上階（とその検討案）の graph.mainRoofSpec が持つ（値の保持と外部タブの表示だけ。壁・境界・構造・
 * 展開図には一切影響しない）。形状（spec.shape===null＝自動）は表示時に導く:
 *   - 範囲＝最上階の建物範囲（structural/wallGate.js footprintCellKeys。「建物範囲」の定義を二重化しない）
 *   - 主構造のルール＝rulesFor(effectiveStructure(graph, project)).mainRoofDefaultShape
 *     （非木造は陸屋根・木造系と主構造未定は null＝短手の規則。構造種別の直接比較はしない）
 *
 * wallGate.js は storage 系を連鎖して引くため、graphSnapshot.js が引く roofDefaults.js には置かず、
 * この葉モジュールに分ける（graphSnapshot → roofDefaults → wallGate → … → graphSnapshot の循環を作らない）。
 * store.js / snap.js / .jsx を静的に import しない。
 */
import { rulesFor, effectiveStructure } from '../../structural/structureRules.js';
import { footprintCellKeys } from '../../structural/wallGate.js';
import { cellBoundsList } from '../gridCells.js';
import { resolveRoofShape } from './roofDefaults.js';

/**
 * 最上階の建物範囲のセル矩形群（現在の格子で解決。部屋が無い・階段だけの階は空）。
 * @param {object} graph 最上階（またはその検討案）の graph
 */
export function mainRoofBounds(graph) {
  return cellBoundsList(footprintCellKeys(graph), graph);
}

/**
 * 主屋根の形状の実効値。明示値はそのまま。自動のとき、主構造のルールが既定の形状を持てばそれ（非木造＝陸屋根）、
 * 持たなければ建物範囲の短手で片流れ／切妻。建物範囲は必要なときだけ計算する。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {object|null} [project] 主構造の建物全体値の解決用（graph の階ごと設定が優先）
 * @returns {string} RoofShape の値
 */
export function resolveMainRoofShape(graph, project = null) {
  const spec = graph.mainRoofSpec;
  const rules = rulesFor(effectiveStructure(graph, project));
  if (spec?.shape || rules.mainRoofDefaultShape) return resolveRoofShape(spec, { rules });
  return resolveRoofShape(spec, { boundsList: mainRoofBounds(graph), rules });
}
