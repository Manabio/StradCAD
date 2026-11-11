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

/** 部材を手動削除し、Undo を 1 件積む。mapName は REMOVE_FN_BY_MAP のキー（未知は例外）。
 *  graph の該当 map に実在しない id は無視する（実在 0 件なら Undo を積まない）。
 *  採番は呼ばない（現行のリストタブの削除と同じ。採番の扱いは別段で決める）。
 *  project は現状未使用。削除後の採番（別段）で使うため署名に置く。
 *  @returns 消した本数 */
export function commitManualMemberRemoval(graph, project, mapName, ids) {
  const removeFn = REMOVE_FN_BY_MAP[mapName];
  if (!removeFn) throw new Error(`commitManualMemberRemoval: 未知の mapName です: ${mapName}`);
  const targets = [...new Set(ids)].filter(id => graph[mapName].has(id));
  if (targets.length === 0) return 0;
  const before = serializeGraph(graph);
  for (const id of targets) graph[removeFn](id);
  pushGraphUndo(graph, before);
  return targets.length;
}
