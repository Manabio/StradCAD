// 構造同期オーケストレータ（openingStructuralSync.js を一般化・改名したもの。2026-09-25）。
// 壁位置が確定した直後（建具の確定・通り芯削除など）に、構造（柱・梁）を決定的・冪等に
// 再計算するための単一の起動口を提供する。
//
// 壁 → 構造は一方向: 要求元が壁位置を確定してから request() を呼ぶ（本モジュール自身は壁を
// 生成・変更しない）。undo に積まない理由は建具・通り芯削除で共通——recomputeForStructuralSync
// 自体が決定的・冪等（同じgraph・同じscopeからは常に同じ結果になる）ため、要求元側のundo/redoで
// 本モジュールが再実行されれば、それだけで元の状態へ戻る。もしここで別途undoエントリを積むと、
// その復元手段（restoreGraph）がgraph上のインスタンスを丸ごと差し替えてしまい、要求元側の
// undo/redoクロージャが握る参照（例: openings/openingEdit.jsのOpening）が古いインスタンスを
// 指したままになる（.claude/undo-redo.md「undo対象外」参照）。
// 通り芯削除側（transform/centerLineOps.js）は undo/redo クロージャの最後で listener を呼ぶ——
// 他階への detach 伝播は undo 対象（transform/centerLineFloorSync.js propagateGridCenterLineDeletion）
// だが、構造反映自体はこの規律どおり undo 対象外のまま。
import { rulesFor, effectiveStructure } from './structureRules.js';
import { recomputeForStructuralSync } from './structuralOrchestration.js';

/** scope（狭い→広い）。coalesce時は合流した要求のうち最も広いものへ昇格する。 */
export const SYNC_SCOPES = Object.freeze(['active', 'activeAndAbove', 'all']);

function assertKnownScope(scope) {
  if (!SYNC_SCOPES.includes(scope)) throw new Error(`未知の構造同期scope: ${scope}`);
}

// 在来木造（columnPlacement:'wallIntersections'）の柱自動生成が袖柱を扱う唯一の経路
// （structuralAutoFill.js autoFillColumnsForStructure と同じ述語）。建具の変更はこの主構造でしか
// 意味を持たないため、request の既定 applies（常に真）ではなくこの述語を建具専用の要求形にだけ適用する。
function wallIntersectionColumnsApply(graph, project) {
  return rulesFor(effectiveStructure(graph, project)).columnPlacement === 'wallIntersections';
}

/** 建具（openings/）の確定・undo/redo直後の要求形（scope='active'・在来限定）。 */
export const OPENING_STRUCTURAL_SYNC = Object.freeze({ scope: 'active', applies: wallIntersectionColumnsApply });

const ALWAYS_APPLIES = () => true;

/**
 * request(graph, project, opts) を唯一の起動口として持つ同期オーケストレータを作る。
 * - opts.scope は必須（SYNC_SCOPES のいずれか）。未指定・未知の値は同期的にthrowする
 *   （プログラミングエラー。core/centerLineKindPolicy.js assertKnownKindと同じ流儀）。
 * - opts.applies 省略時は「常に真」（通り芯削除はこの既定——非在来（S造・RC造）のグリッド柱にも
 *   効くため、建具のような主構造限定にしない。.claude/structural-model.md「主構造」節参照）。
 * - 実行中に来た要求は1件にコアレスする: graph/projectは最新で上書き、scopeは合流した要求のうち
 *   最も広いもの（SYNC_SCOPES.indexOf最大）、appliesは要求ごとに集めた配列へ追加する。
 * - 実行開始時に (1) graph!==project.activeGraph なら skip、(2) 合流したapplies配列のいずれかが
 *   真でなければ skip、(3) recompute(project, scope) を呼ぶ。scopeは合流した全要求の最大値を
 *   そのまま使う——applies が偽だった要求のscopeも含めて広い方を採用する。広いscopeは狭いscopeの
 *   上位集合（'active'⊂'activeAndAbove'⊂'all'）のため、取りこぼしは起きない（正しさは保たれる）。
 * - 対象外（非アクティブ階／applies不成立）の判定はコアレスされた要求が実際に実行され始める
 *   タイミングで都度再確認する（キュー待ちの間に階・主構造が変わり得るため）。
 * - request()自体は実行完了を待たない（fire-and-forget）。完了を待つ必要がある呼び出し側
 *   （undo/redo・モード/フロアまたぎ切替の直前）は whenIdle() を使う。
 */
export function createStructuralSync({
  recompute = (project, scope) => recomputeForStructuralSync(project, scope),
  onError = console.error,
} = {}) {
  let busy = false;
  let queued = null; // 実行中に来た最新の要求（1件にコアレス）: { graph, project, scope, appliesList }
  let idleResolvers = [];

  function mergeIntoQueue(graph, project, scope, applies) {
    if (!queued) {
      queued = { graph, project, scope, appliesList: [applies] };
      return;
    }
    queued.graph = graph;
    queued.project = project;
    if (SYNC_SCOPES.indexOf(scope) > SYNC_SCOPES.indexOf(queued.scope)) queued.scope = scope;
    queued.appliesList.push(applies);
  }

  async function runLoop(graph, project, scope, appliesList) {
    busy = true;
    let g = graph, p = project, s = scope, list = appliesList;
    for (;;) {
      if (g === p.activeGraph && list.some(f => f(g, p))) {
        try {
          await recompute(p, s);
        } catch (err) {
          onError(err);
        }
      }
      if (!queued) break;
      ({ graph: g, project: p, scope: s, appliesList: list } = queued);
      queued = null;
    }
    busy = false;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function request(graph, project, opts) {
    if (!opts) throw new Error('structuralSync.request: opts.scope は必須です');
    const { scope, applies = ALWAYS_APPLIES } = opts;
    assertKnownScope(scope);
    if (busy) { mergeIntoQueue(graph, project, scope, applies); return; }
    void runLoop(graph, project, scope, [applies]);
  }

  function whenIdle() {
    if (!busy) return Promise.resolve();
    return new Promise(resolve => { idleResolvers.push(resolve); });
  }

  return { request, whenIdle };
}

// アプリ全体で共有する唯一のインスタンス（undoManager.contextProviderと同じ「シングルトン＋
// App.jsxが依存注入で配線する」作法）。
export const structuralSync = createStructuralSync();
