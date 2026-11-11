// ================================================================
// 構造部材の手動追加・手動削除の「確定」（グラフ変更＋Undo 記録）を 1 か所にまとめる純モジュール。
//
// MemberListTab.jsx（.jsx は node:test から単体 import できない）にあった
// 「before を採る → 変更する → pushGraphUndo」の組を抽出し、リストタブ以外（平面・構造モードの
// 長クリック等）からも同じ経路で柱を追加・削除できるようにする。経路が 2 本になると
// 採番・Undo の取りこぼしが片方にだけ入るため、確定はここだけに置く。
// addManualColumn（manualMemberAdd.js）は Undo を持たない層のまま残し、Undo はここで積む。
//
// 構造再計算は呼ばない（呼ぶかどうかは呼び元の責務。現行のリストタブ「＋追加」と同じ）。
//
// 純モジュール: react/.jsx/store.js/snap.js を静的 import しない。
// ================================================================
import { runInAction } from 'mobx';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { columnSlotKey, columnAnchorKey } from '../core.js';
import { addManualColumn, resolveManualColumnAnchors } from './manualMemberAdd.js';
import { renumberMembers } from './memberNumbering.js';
import { REMOVE_FN_BY_MAP } from './memberCatalog.js';

/** グラフ全体のスナップショットで Undo を記録する（CL削除等の既存パターンと同じ手法）。
 *  before は変更前に呼び元が serializeGraph で採っておく。 */
export function pushGraphUndo(graph, before) {
  const after = serializeGraph(graph);
  undoManager.push(
    () => restoreGraph(graph, before),
    () => restoreGraph(graph, after),
  );
}

/** 柱を手動追加し、採番して Undo を 1 件積む。vCL・hCL は明示必須。
 *  欠落は before を採る前に例外にする（失敗時に graph も Undo も変えないため）。
 *  @returns 追加した StructuralColumn */
export function commitManualColumnAdd(graph, project, { vCL, hCL }) {
  if (!vCL || !hCL) throw new Error('commitManualColumnAdd: vCL と hCL は必須です');
  // 在来木造は自動補完と同じアンカー（通り芯／梁芯→中心線）へ解決してから立てる（識別キーが食い違うと
  // 再計算のたびに auto の柱が作られては消える。manualMemberAdd.js resolveManualColumnAnchors）。
  const anchors = resolveManualColumnAnchors(graph, project, { vCL, hCL });
  const before = serializeGraph(graph);
  let column;
  runInAction(() => {
    column = addManualColumn(graph, project, anchors);
    renumberMembers(graph, project, 'columnMap');
  });
  pushGraphUndo(graph, before);
  return column;
}

// 素の CL の組で立つ柱（袖柱 woodJambRef・オフセット柱 woodAxisOffset でない）の、自動補完が同じ位置に立てる
// アンカーのスロットキー。柱自身のキーと同じなら null（removeColumn が記録するキーと同じで足すものが無い）。
function resolvedColumnKeyOf(graph, project, column) {
  if (column.woodJambRef || column.woodAxisOffset) return null;
  const { vCL, hCL } = resolveManualColumnAnchors(graph, project, { vCL: column.verticalCL, hCL: column.horizontalCL });
  const key = columnSlotKey(vCL, hCL);
  return key === columnAnchorKey(column) ? null : key;
}

/** 部材を手動削除し、Undo を 1 件積む。mapName は REMOVE_FN_BY_MAP のキー（未知は例外）。
 *  graph の該当 map に実在しない id は無視する（実在 0 件なら Undo を積まない）。
 *  採番は呼ばない（現行のリストタブの削除と同じ。採番の扱いは別段で決める）。
 *  柱（'columnMap'）は、素の CL の組で立っていて（袖柱・オフセット柱でない）自動補完が同じ位置に立てるアンカー
 *  （resolveManualColumnAnchors。在来木造は梁芯の組など）のキーが柱自身のキーと違うとき、そのキーも除外集合へ
 *  記録する——removeColumn が記録するのは柱自身のキー（中心線の組）だけで、梁芯が後から生えた位置では
 *  梁芯の組のキーの auto 柱が次の再計算で復活するため（実測）。非在来は解決が恒等なので何も足さない。
 *  除外集合は before の後に書くので Undo で柱とともに戻る。
 *  @returns 消した本数 */
export function commitManualMemberRemoval(graph, project, mapName, ids) {
  const removeFn = REMOVE_FN_BY_MAP[mapName];
  if (!removeFn) throw new Error(`commitManualMemberRemoval: 未知の mapName です: ${mapName}`);
  const targets = [...new Set(ids)].filter(id => graph[mapName].has(id));
  if (targets.length === 0) return 0;
  const before = serializeGraph(graph);
  // 削除前に解決後のキーを採る（柱が消えると CL の組が引けなくなる）。
  const resolvedKeys = mapName === 'columnMap' ? targets.map(id => resolvedColumnKeyOf(graph, project, graph.columnMap.get(id))).filter(k => k != null) : [];
  for (const id of targets) graph[removeFn](id);
  if (resolvedKeys.length > 0) runInAction(() => { for (const k of resolvedKeys) graph.excludedColumnSlots.add(k); });
  pushGraphUndo(graph, before);
  return targets.length;
}
