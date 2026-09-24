// 建具（openings/）の確定・undo/redo直後に自階の構造を再計算する同期オーケストレータ。
//
// 建具の変更経路（配置・削除・幅/位置編集・ドラッグ確定）はどれも構造再計算を起動しない
// （構造再計算はモード境界＝structure enter/exit・finish exitと階追加でしか走らないため）。
// これにより建具に重なった自動柱が残ったまま・袖柱（.claude/structural-model.md「建具の袖柱」）が
// 立たないまま放置される——本モジュールは openings 側からの依存注入（openingEdit.js
// setOpeningGeometryListener）で呼ばれ、対象の自階だけを決定的・冪等に再計算する。
//
// undoに積まない理由: recomputeActiveStructural自体が決定的・冪等（同じgraphからは常に同じ結果に
// なる）ため、建具側のundo/redoで本モジュールが再実行されれば、それだけで元の柱配置へ戻る。もし
// ここで別途undoエントリを積むと、その復元手段（restoreGraph）がgraph上のOpeningインスタンスを
// まるごと差し替えてしまい、開口側のundo/redoクロージャが握るOpening参照（openingEdit.jsの`o`）が
// 古いインスタンスを指したままになる（snapshotOpening/restoreOpeningは同一インスタンスのフィールド
// を書き換える前提のため、差し替え後は書き込み先を失う）。
// 「どの建具変更が構造に影響しうるか」の判定（openingGeometryChanged）は openings/openingEdit.js が
// snapshotOpening と同じ場所で持つ——本モジュールは openings/ を import せず、起動は依存注入だけで結ぶ。
import { rulesFor, effectiveStructure } from './structureRules.js';
import { recomputeActiveStructural } from './structuralOrchestration.js';

/**
 * request(graph, project) を唯一の起動口として持つ同期オーケストレータを作る。
 * - 実行中に来た要求は1件にコアレスし、実行完了後にまとめて1回だけ再実行する
 *   （3件来ても合計2回＝実行中の1回＋コアレス後の1回）。
 * - request()自体は実行完了を待たない（fire-and-forget）。完了を待つ必要がある呼び出し側
 *   （undo/redo・モード/フロアまたぎ切替の直前）は whenIdle() を使う。
 * - 対象外（非アクティブ階／在来木造以外）の判定はコアレスされた要求が実際に実行され始める
 *   タイミングで都度再確認する（キュー待ちの間に階・主構造が変わり得るため）。
 */
export function createOpeningStructuralSync({
  recompute = (project) => recomputeActiveStructural(project, false),
  onError = console.error,
} = {}) {
  let busy = false;
  let queued = null; // 実行中に来た最新の要求（1件にコアレス。古い要求は上書きで捨てる）
  let idleResolvers = [];

  // 在来木造（columnPlacement:'wallIntersections'）の柱自動生成が袖柱を扱う唯一の経路
  // （structuralAutoFill.js autoFillColumnsForStructure と同じ述語）。それ以外の主構造では
  // 建具変更のたびに再計算しても意味がないため起動しない。
  function shouldSkip(graph, project) {
    if (graph !== project.activeGraph) return true;
    return rulesFor(effectiveStructure(graph, project)).columnPlacement !== 'wallIntersections';
  }

  async function runLoop(graph, project) {
    busy = true;
    let g = graph, p = project;
    for (;;) {
      if (!shouldSkip(g, p)) {
        try {
          await recompute(p);
        } catch (err) {
          onError(err);
        }
      }
      if (!queued) break;
      ({ graph: g, project: p } = queued);
      queued = null;
    }
    busy = false;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function request(graph, project) {
    if (busy) { queued = { graph, project }; return; }
    void runLoop(graph, project);
  }

  function whenIdle() {
    if (!busy) return Promise.resolve();
    return new Promise(resolve => { idleResolvers.push(resolve); });
  }

  return { request, whenIdle };
}

// アプリ全体で共有する唯一のインスタンス（undoManager.contextProviderと同じ「シングルトン＋
// App.jsxが依存注入で配線する」作法）。
export const openingStructuralSync = createOpeningStructuralSync();
