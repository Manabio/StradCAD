// 平面・構造モードの長クリックによる柱の追加・削除（manualMemberCommit.js）の「編集先の階」と「占有」の判定（純関数）。
// react/store.js/snap.js/.jsx に依存しない（node:test から単体 import 可能）。
import { rulesFor, effectiveStructure, usesWallIntersectionColumns } from './structureRules.js';
import { columnListCategory } from './framingDrawing.js';
import { LayerRole } from '../figure/figureTypes.js';
import { columnSlotKey, columnAnchorKey } from '../core/structuralEntities.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { bareColumnRect } from '../finish/columnWrap.js';
import { manualColumnAnchorLines } from '../core/centerLineKindPolicy.js';
import { resolveManualColumnAnchors } from './manualMemberAdd.js';

/**
 * 柱を立てられる線（縦・横）を appMode ごとに解決する唯一の口。構造リスト「＋追加」（intersectionMemberOptions）と
 * 長クリックの柱追加が同じ集合を使うため、ここに集める。structure は梁芯を含めるか（在来木造＝壁交点方式だけ）を
 * 自階の実効主構造から決めて core の manualColumnAnchorLines へ渡す（ポリシーは主構造を知らない）。
 * @returns {{verticals: Array, horizontals: Array}}
 */
export function columnAnchorLinesFor(graph, project, appMode) {
  if (appMode !== 'structure') return manualColumnAnchorLines(graph, appMode);
  return manualColumnAnchorLines(graph, appMode, { beamAxesAllowed: usesWallIntersectionColumns(graph, project) });
}

/**
 * 構造リスト「＋追加」の交点選択肢（縦・横の線）。柱グループ（'columnMap'）は柱を立てられる線の表
 * （columnAnchorLinesFor の structure）、それ以外（基礎・柱脚）は従来どおり通り芯だけ。
 * @returns {{verticals: Array, horizontals: Array}}
 */
export function intersectionMemberOptions(mapName, graph, project) {
  if (mapName === 'columnMap') return columnAnchorLinesFor(graph, project, 'structure');
  return { verticals: graph.gridXs, horizontals: graph.gridYs };
}

/**
 * 長クリックで押した交点（x, y。vCL × hCL で引いた線）に立てる柱のアンカーと占有を 1 回で解決する。
 * アンカーは resolveManualColumnAnchors（在来木造は通り芯／梁芯→中心線）で解決し、**解決後**の線で
 * isColumnSlotOccupied を評価する——占有の判定と実際に立てるアンカー（commitManualColumnAdd が使う解決）が
 * 食い違わない唯一の口。x, y は入力のまま返す。vCL/hCL 欠落・x/y 非有限は例外。
 * @returns {{vCL: object, hCL: object, x: number, y: number, occupied: boolean}}
 */
export function resolveColumnSlot(graph, project, { vCL, hCL, x, y } = {}) {
  const anchors = resolveManualColumnAnchors(graph, project, { vCL, hCL });
  const occupied = isColumnSlotOccupied(graph, { ...anchors, x, y });
  return { ...anchors, x, y, occupied };
}

/**
 * 柱の追加・削除を行う先の graph を解決する。見つからなければ null（編集不可）。
 *  - 平面（floorplan）: 表示中の階（activeGraph）。
 *  - 構造（structure）: 構造リストの柱グループと同じ解決（MemberListTab.jsx）——自階の実効主構造から柱一覧の
 *    供給カテゴリ（columnListCategory）を決め、composition.resolveCategory で供給階を引く。供給階が無い
 *    （基礎伏図の下階柱）、または参照のみ（REFERENCE）で供給階が主題階でない場合は編集不可＝null。
 *  - その他のモード: null。
 * @param {{appMode:string, activeGraph:object, composition:object|null, project:object}} args
 * @returns {{graph:object}|null}
 */
export function resolveColumnEditTarget({ appMode, activeGraph, composition, project }) {
  if (appMode === 'floorplan') return activeGraph ? { graph: activeGraph } : null;
  if (appMode !== 'structure' || !composition) return null;
  const selfGraph = composition.graphForCategory('columnMapSelf');
  const selfStructure = selfGraph ? effectiveStructure(selfGraph, project) : null;
  const resolved = composition.resolveCategory(columnListCategory(rulesFor(selfStructure).drawing));
  if (!resolved) return null;
  const readOnly = resolved.spec.role === LayerRole.REFERENCE && resolved.graph.plane.id !== composition.subjectPlane.id;
  return readOnly ? null : { graph: resolved.graph };
}

/**
 * 交点（vCL × hCL、位置 x, y）に既に柱があるか。既存柱の識別キー（columnAnchorKey）がこの交点のスロットキーと
 * 一致する、または既存柱の断面矩形（bareColumnRect）が交点を許容 CL_OVERLAP_TOL_MM つきで含めば真。
 * 在来木造の壁交点方式のアンカー解決（袖柱・オフセット柱）は含まない。
 * @param {object} graph
 * @param {{vCL:object, hCL:object, x:number, y:number}} slot
 * @returns {boolean}
 */
export function isColumnSlotOccupied(graph, { vCL, hCL, x, y } = {}) {
  if (!vCL || !hCL) throw new Error('isColumnSlotOccupied: vCL と hCL は必須です');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`isColumnSlotOccupied: x と y は有限の数値が必要です（実際: ${x}, ${y}）`);
  const slotKey = columnSlotKey(vCL, hCL);
  return graph.columns.some(column => {
    if (columnAnchorKey(column) === slotKey) return true;
    const r = bareColumnRect(column);
    return x >= r.xLo - CL_OVERLAP_TOL_MM && x <= r.xHi + CL_OVERLAP_TOL_MM
        && y >= r.yLo - CL_OVERLAP_TOL_MM && y <= r.yHi + CL_OVERLAP_TOL_MM;
  });
}
