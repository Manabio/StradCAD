// 平面・構造モードの長クリックで柱を追加・削除するための判断を、usePointerInteraction.js / App.jsx から抽出した純モジュール
// （react/store.js/snap.js/.jsx に推移的にも届かない。node:test から単体 import できる）。
//   resolveColumnLongPress … 押した位置が「柱の断面内」か「CL の交点（柱を立てられる）」か、柱追加が可能かを解く。
//   runColumnMenuAction    … メニュー選択時に状況を再確認して追加・削除を確定する。
// 追加・削除の直後に構造再計算・壁再生成は走らせない（裁定 e。構造リストの追加・削除と同じ）。
import { ColumnMenuItemId } from '../core/constants.js';
import { ERR_COLUMN_ADD_ABORTED, ERR_COLUMN_DEL_ABORTED } from '../error.js';
import { findCLCrossing } from '../snapGeometry.js';
import { columnAtPoint, isInsideColumnRect } from './columnPick.js';
import { resolveColumnEditTarget, resolveColumnSlot, columnAnchorLinesFor } from '../structural/columnEditTarget.js';
import { commitManualColumnAdd, commitManualMemberRemoval } from '../structural/manualMemberCommit.js';
import { isStructureSpecified } from '../structural/structuralAutoFill.js';
import { effectiveStructure } from '../structural/structureRules.js';
import { structureHasMemberKind, MEMBER_KIND, FIGURE_TYPE } from '../structural/structuralClassification.js';

function assertFinite(name, v) {
  if (!Number.isFinite(v)) throw new Error(`resolveColumnLongPress: ${name} は有限の数値が必要です（実際: ${v}）`);
}

// 構造リストが柱グループを隠す条件（MemberListTab.jsx: 実効主構造が柱を持たない種別なら非表示）と同じ意味。
// figureType は構造モードの R階伏図（屋根専用平面）だけ ROOF、それ以外は null（所属図面ルールのまま）。
function structureHasColumns(graph, project, appMode, composition) {
  const structure = effectiveStructure(graph, project);
  if (structure == null) return true; // 構造リストも未解決（null）は隠さない
  const figureType = appMode === 'structure' && composition?.subjectPlane?.isRoofPlane ? FIGURE_TYPE.ROOF : null;
  return structureHasMemberKind(MEMBER_KIND.COLUMN, structure, figureType);
}

// 線が今もその階で有効か（階固有の線は shapeMap、通り芯は全階共有で gridXs/gridYs に載る）。
// graph.centerLines を直接走査しない（CL 種別ポリシーのガード G1。ここは相手選択でなく存在確認）。
function isCenterLineAlive(graph, cl) {
  return graph.shapeMap.get(cl.id) === cl || graph.gridXs.includes(cl) || graph.gridYs.includes(cl);
}

/**
 * 長クリック位置（world）が柱の断面内か、CL の交点か（柱追加位置）を解く。優先順: 柱 > 交点。
 * 候補の柱は編集先 graph の柱すべて（平面の ColumnsLayer・構造伏図の柱グループとも、描くときは graph.columns を
 * 個体ごとには絞り込まない）。柱グループごと描かない伏図（在来木造の基礎伏図。slotView が柱を描かない視点）では
 * 編集先そのものが null になる（resolveColumnEditTarget）。thresholdPx は呼び出し側が既存の CL_THRESHOLD_PX を渡す。
 * 他の候補に譲る 2 つの規則（どちらも呼び出し側が発火位置で求めて明示的に渡す。欠落・型違いは throw）:
 *  - endpointDistPx（number|null）: 発火位置から CL 端点候補（突端円・はね出し線分・足）までの画面距離。交点（柱追加）までの
 *    画面距離より**小さければ**柱追加にせず（slot なし）従来の端点メニューへ譲る。等距離は柱追加。柱の判定には影響しない。
 *  - openingHit（boolean）: 発火位置に建具の当たりがあるか。柱の**広げた当たり幅**（実際の断面の外）で建具に当たるときは柱にせず
 *    建具メニューへ譲る。実際の断面の内側は常に柱。壁・CL・交点には譲らない。構造モード（建具を解決しない）は false を渡す。
 * @returns {null | {graph, column: object|null, slot: {vCL,hCL,x,y,occupied}|null, addable: boolean}}
 *   null＝柱の編集対象でないモード・編集先なし（従来のメニューへ）。
 */
export function resolveColumnLongPress({ appMode, activeGraph, composition, project, slotView = null, world, scaleX, scaleY, thresholdPx, endpointDistPx, openingHit } = {}) {
  if (!world) throw new Error('resolveColumnLongPress: world は必須です');
  assertFinite('world.x', world.x);
  assertFinite('world.y', world.y);
  assertFinite('scaleX', scaleX);
  assertFinite('scaleY', scaleY);
  assertFinite('thresholdPx', thresholdPx);
  if (endpointDistPx !== null && !Number.isFinite(endpointDistPx)) {
    throw new Error(`resolveColumnLongPress: endpointDistPx は有限の数値か null が必要です（実際: ${endpointDistPx}）`);
  }
  if (typeof openingHit !== 'boolean') throw new Error(`resolveColumnLongPress: openingHit は真偽値が必要です（実際: ${openingHit}）`);
  const target = resolveColumnEditTarget({ appMode, activeGraph, composition, project, slotView });
  if (!target) return null;
  const { graph } = target;
  const hit = columnAtPoint(graph.columns, world.x, world.y, { scaleX, scaleY, minHalfPx: thresholdPx });
  if (hit) {
    // 建具に譲るのは平面モードだけ（構造モードは建具を描かず・解決もしない）
    const yieldsToOpening = openingHit && appMode === 'floorplan';
    if (!yieldsToOpening || isInsideColumnRect(hit, world.x, world.y)) return { graph, column: hit, slot: null, addable: false };
    // 広げた当たり幅だけで当たっていて建具の上: 別の柱の実際の断面が点の下にあればそれ、無ければ建具に譲る
    const inner = columnAtPoint(graph.columns.filter(c => isInsideColumnRect(c, world.x, world.y)), world.x, world.y, { scaleX, scaleY, minHalfPx: thresholdPx });
    if (inner) return { graph, column: inner, slot: null, addable: false };
    return { graph, column: null, slot: null, addable: false };
  }
  const { verticals, horizontals } = columnAnchorLinesFor(graph, project, appMode);
  const crossing = findCLCrossing(verticals, horizontals, world.x, world.y, thresholdPx, scaleX, scaleY);
  if (!crossing) return { graph, column: null, slot: null, addable: false };
  // 交点より端点のほうが近ければ端点に譲る（T 字・L 字で中心線・梁芯の端が交点に止まるとき、端点メニューを食わない）
  const crossingDistPx = Math.hypot((crossing.x - world.x) * scaleX, (crossing.y - world.y) * scaleY);
  if (endpointDistPx !== null && endpointDistPx < crossingDistPx) return { graph, column: null, slot: null, addable: false };
  const slot = resolveColumnSlot(graph, project, crossing);
  const addable = !slot.occupied && isStructureSpecified(graph, project) && structureHasColumns(graph, project, appMode, composition);
  return { graph, column: null, slot, addable };
}

/**
 * メニュー選択時の再確認＋確定。長クリックから選択までの間に階切替・undo・他経路の変更が入りうるため、
 * 編集先（currentTarget＝選択時点で resolveColumnEditTarget をやり直した結果）・交点の占有・柱の実在を見直し、
 * 変わっていれば何も変えずに中止する（graph も undo も不変）。
 * @param {string} itemId ColumnMenuItemId の値（未知は例外）
 * @param {{columnEdit: {graph, column, slot}, currentTarget: {graph}|null, project}} args
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function runColumnMenuAction(itemId, { columnEdit, currentTarget, project } = {}) {
  if (itemId !== ColumnMenuItemId.ADD && itemId !== ColumnMenuItemId.DEL) {
    throw new Error(`runColumnMenuAction: 未知の itemId です: ${itemId}`);
  }
  const abort = itemId === ColumnMenuItemId.ADD ? { ok: false, error: ERR_COLUMN_ADD_ABORTED } : { ok: false, error: ERR_COLUMN_DEL_ABORTED };
  if (!columnEdit || !currentTarget || currentTarget.graph !== columnEdit.graph) return abort;
  const { graph } = columnEdit;
  if (itemId === ColumnMenuItemId.ADD) {
    if (!columnEdit.slot) return abort;
    const { vCL, hCL, x, y } = columnEdit.slot;
    // 交点の線が消えていないか・同じ位置に柱が立っていないか（解決は押した時点と同じ resolveColumnSlot でやり直す）
    if (!isCenterLineAlive(graph, vCL) || !isCenterLineAlive(graph, hCL)) return abort;
    const now = resolveColumnSlot(graph, project, { vCL, hCL, x, y });
    if (now.occupied) return abort;
    commitManualColumnAdd(graph, project, { vCL: now.vCL, hCL: now.hCL });
    return { ok: true };
  }
  const { column } = columnEdit;
  if (!column || graph.columnMap.get(column.id) !== column) return abort;
  commitManualMemberRemoval(graph, project, 'columnMap', [column.id]);
  return { ok: true };
}
