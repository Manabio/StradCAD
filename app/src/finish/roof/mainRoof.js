/**
 * 主屋根（最上階の外部タブ先頭の固定の群「屋根」）の導出。ステップ B3。
 *
 * 屋根区画（graph.roofZones。roofZones.js）があるとき、主屋根の範囲は建物範囲から区画の実効セルを除いた残り
 * （mainRoofBounds）。区画の形状・高い側・棟木の向きは同じ規則（resolveTopRoofShape）で区画の実効セルから導く。
 * 主屋根は最上階（とその検討案）の graph.mainRoofSpec が持つ（値の保持と外部タブの表示だけ。壁・境界・構造・
 * 展開図には一切影響しない）。形状（spec.shape===null＝自動）は表示時に導く:
 *   - 範囲＝最上階の建物範囲（structural/wallGate.js footprintCellKeys。「建物範囲」の定義を二重化しない）から
 *     屋根区画の実効セルを除いた残り（R3。区画が無ければ建物範囲そのもの）
 *   - 主構造のルール＝rulesFor(effectiveStructure(graph, project)).mainRoofDefaultShape
 *     （非木造は陸屋根・木造系と主構造未定は null＝短手の規則。構造種別の直接比較はしない）
 *
 * wallGate.js は storage 系を連鎖して引くため、graphSnapshot.js が引く roofDefaults.js には置かず、
 * この葉モジュールに分ける（graphSnapshot → roofDefaults → wallGate → … → graphSnapshot の循環を作らない）。
 * store.js / snap.js / .jsx を静的に import しない。
 */
import { rulesFor, effectiveStructure } from '../../structural/structureRules.js';
import { cellBoundsList } from '../gridCells.js';
import { RoofShape } from '../../core/constants.js';
import { resolveRoofShape } from './roofDefaults.js';
import { roofShortSpanMm, rectOfBounds, roofHighSideView, roofRidgeDirectionView } from './roofGeometry.js';
import { mainRoofRestCellKeys, roofZoneEffectiveCells } from './roofZones.js';

/**
 * 主屋根（区画以外の範囲）のセル矩形群（現在の格子で解決。部屋が無い・階段だけの階は空）。
 * 範囲＝建物範囲 − 屋根区画の実効セル（roofZones.js mainRoofRestCellKeys。R3）。区画が無ければ建物範囲そのもの。
 * @param {object} graph 最上階（またはその検討案）の graph
 */
export function mainRoofBounds(graph) {
  return cellBoundsList(mainRoofRestCellKeys(graph), graph);
}

/**
 * 屋根区画の範囲（実効セル）のセル矩形群。実効セルが0なら空。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {import('../../core/roofZone.js').RoofZone} zone
 */
export function roofZoneBounds(graph, zone) {
  return cellBoundsList(roofZoneEffectiveCells(zone, graph), graph);
}

/**
 * 主屋根・屋根区画に共通の形状の実効値（純粋な核）。明示値はそのまま。自動のとき、主構造のルールが既定の形状を
 * 持てばそれ（非木造＝陸屋根）、持たなければ範囲が矩形でない（L字など。空は含まない）なら寄棟、矩形なら短手で片流れ／切妻
 * （ユーザー裁定 2026-10-02。この寄棟は主屋根・区画だけ。下屋は矩形かどうかに依らず resolveRoofShape＝短手の規則のまま）。
 * @param {object|null|undefined} spec RoofSpec
 * @param {Array} boundsList 範囲のセル矩形群
 * @param {object} rules rulesFor(effectiveStructure(...))
 * @returns {string} RoofShape の値
 */
export function resolveTopRoofShape(spec, boundsList, rules) {
  if (spec?.shape || rules.mainRoofDefaultShape) return resolveRoofShape(spec, { rules });
  if (roofShortSpanMm(boundsList) > 0 && !rectOfBounds(boundsList)) return RoofShape.HIP; // 空（短手0）は今までどおり
  return resolveRoofShape(spec, { boundsList, rules });
}

/**
 * 主屋根の形状の実効値（範囲は区画以外＝mainRoofBounds。核は resolveTopRoofShape）。
 * 範囲は必要なときだけ計算する。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {object|null} [project] 主構造の建物全体値の解決用（graph の階ごと設定が優先）
 * @returns {string} RoofShape の値
 */
export function resolveMainRoofShape(graph, project = null) {
  const spec = graph.mainRoofSpec;
  const rules = rulesFor(effectiveStructure(graph, project));
  if (spec?.shape || rules.mainRoofDefaultShape) return resolveRoofShape(spec, { rules });
  return resolveTopRoofShape(spec, mainRoofBounds(graph), rules);
}

/**
 * 屋根区画の形状の実効値（範囲は区画の実効セル。規則は主屋根と同じ）。実効セルが0の区画は短手0＝主屋根の空と同じ
 * （非木造は陸屋根、木造は片流れ）で、例外にならない。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {import('../../core/roofZone.js').RoofZone} zone
 * @param {object|null} [project]
 * @returns {string} RoofShape の値
 */
export function resolveRoofZoneShape(graph, zone, project = null) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (zone.spec?.shape || rules.mainRoofDefaultShape) return resolveRoofShape(zone.spec, { rules });
  return resolveTopRoofShape(zone.spec, roofZoneBounds(graph, zone), rules);
}

/**
 * 主屋根の「高い側」の選択欄の表示判断（形状の実効値が片流れで主屋根の範囲（区画以外の残り）が矩形のときだけ visible）。
 * 主屋根は屋内に接する辺を持たない（adjacency なし）ので、既定は横長なら上・縦長なら左。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {object|null} [project]
 * @returns {{ visible: boolean, value: string|null }}
 */
export function mainRoofHighSideView(graph, project = null) {
  const shape = resolveMainRoofShape(graph, project);
  if (shape !== RoofShape.MONO) return { visible: false, value: null };
  const rect = rectOfBounds(mainRoofBounds(graph));
  return roofHighSideView({ shape, highSide: graph.mainRoofSpec?.highSide ?? null, rect, adjacency: null });
}

/**
 * 主屋根の「棟木の向き」の選択欄の表示判断（形状の実効値が切妻で主屋根の範囲（区画以外の残り）が矩形のときだけ visible）。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {object|null} [project]
 * @returns {{ visible: boolean, value: string|null }}
 */
export function mainRoofRidgeDirectionView(graph, project = null) {
  const shape = resolveMainRoofShape(graph, project);
  if (shape !== RoofShape.GABLE) return { visible: false, value: null };
  const rect = rectOfBounds(mainRoofBounds(graph));
  return roofRidgeDirectionView({ shape, ridgeDirection: graph.mainRoofSpec?.ridgeDirection ?? null, rect });
}

/**
 * 屋根区画の「高い側」の選択欄の表示判断（mainRoofHighSideView と同じ規則。範囲は区画の実効セル）。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {import('../../core/roofZone.js').RoofZone} zone
 * @param {object|null} [project]
 * @returns {{ visible: boolean, value: string|null }}
 */
export function roofZoneHighSideView(graph, zone, project = null) {
  const shape = resolveRoofZoneShape(graph, zone, project);
  if (shape !== RoofShape.MONO) return { visible: false, value: null };
  const rect = rectOfBounds(roofZoneBounds(graph, zone));
  return roofHighSideView({ shape, highSide: zone.spec?.highSide ?? null, rect, adjacency: null });
}

/**
 * 屋根区画の「棟木の向き」の選択欄の表示判断（mainRoofRidgeDirectionView と同じ規則。範囲は区画の実効セル）。
 * @param {object} graph 最上階（またはその検討案）の graph
 * @param {import('../../core/roofZone.js').RoofZone} zone
 * @param {object|null} [project]
 * @returns {{ visible: boolean, value: string|null }}
 */
export function roofZoneRidgeDirectionView(graph, zone, project = null) {
  const shape = resolveRoofZoneShape(graph, zone, project);
  if (shape !== RoofShape.GABLE) return { visible: false, value: null };
  const rect = rectOfBounds(roofZoneBounds(graph, zone));
  return roofRidgeDirectionView({ shape, ridgeDirection: zone.spec?.ridgeDirection ?? null, rect });
}
