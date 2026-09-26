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
//
// **段階(g)・2026-09-26**: 上記「undo対象外」は自階のメモリ上の構造変化（graphインスタンスの
// 差し替えを避ける理由）についての規律であり、非アクティブ階・屋根へのIDB書込みは別軸——
// request()のopts.undoRecordsに配列（起動元CL操作のundoエントリが持つ`floorRecords`）を渡すと、
// この同期の実行中に他階へ保存されたバイトの前後（before/after）をそこへ追記する
// （`structural/syncFloorRecorder.js`）。起動元は`applyFloorUndoRecords`（既存）でその配列を
// undo/redoに使う——構造同期モジュール自身は依然としてundoエントリを積まない（3引数版の
// request呼び出し・undoRecords省略時は従来どおり記録しない）。
import { rulesFor, effectiveStructure } from './structureRules.js';
import { recomputeForStructuralSync } from './structuralOrchestration.js';
import { createSyncFloorRecorder } from './syncFloorRecorder.js';
import { loadFloor, saveFloor } from '../storage/db.js';

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

// project.planeMap の非アクティブ全階（検討・屋根Planeを含む）のid配列。
// transform/centerLineFloorSync.js の otherPlanes と同じ集合（非export のためここで複製する——
// 一方は「他CLへ複製する対象階」、他方は「構造同期の記録対象階」という別の目的のヘルパのため、
// 共有ユーティリティへ括り出さず素の走査のまま持つ）。
function nonActivePlaneIds(project) {
  const activeId = project.activePlaneId;
  return [...project.planeMap.values()].filter(p => p.id !== activeId).map(p => p.id);
}

/**
 * request(graph, project, opts) を唯一の起動口として持つ同期オーケストレータを作る。
 * - opts.scope は必須（SYNC_SCOPES のいずれか）。未指定・未知の値は同期的にthrowする
 *   （プログラミングエラー。core/centerLineKindPolicy.js assertKnownKindと同じ流儀）。
 * - opts.applies 省略時は「常に真」（通り芯削除はこの既定——非在来（S造・RC造）のグリッド柱にも
 *   効くため、建具のような主構造限定にしない。.claude/structural-model.md「主構造」節参照）。
 * - opts.undoRecords（段階(g)）: 起動元CL操作のundoエントリが持つ配列を渡すと、実行中に他階へ
 *   保存されたバイトの前後を追記する（下記runLoop参照）。省略時は記録しない（従来どおり）。
 * - 実行中に来た要求は1件にコアレスする: graph/projectは最新で上書き、scopeは合流した要求のうち
 *   最も広いもの（SYNC_SCOPES.indexOf最大）、appliesは要求ごとに集めた配列へ追加する。
 *   undoRecordsは「持つ」要求のうち最後のものを記録先にする（持たない要求が後から合流しても、
 *   既にある記録先を消さない。裁定3「合流時は最新エントリにまとめる扱いを許容」）。
 * - 実行開始時に (1) graph!==project.activeGraph なら skip、(2) 合流したapplies配列のいずれかが
 *   真でなければ skip、(3) recompute(project, scope, recorder) を呼ぶ。scopeは合流した全要求の
 *   最大値をそのまま使う——applies が偽だった要求のscopeも含めて広い方を採用する。広いscopeは
 *   狭いscopeの上位集合（'active'⊂'activeAndAbove'⊂'all'）のため、取りこぼしは起きない
 *   （正しさは保たれる）。
 * - 対象外（非アクティブ階／applies不成立）の判定はコアレスされた要求が実際に実行され始める
 *   タイミングで都度再確認する（キュー待ちの間に階・主構造が変わり得るため）。
 * - request()自体は実行完了を待たない（fire-and-forget）。完了を待つ必要がある呼び出し側
 *   （undo/redo・モード/フロアまたぎ切替の直前）は whenIdle() を使う。
 */
export function createStructuralSync({
  recompute = (p, s, recorder) => recomputeForStructuralSync(p, s, undefined, recorder ? { save: recorder.wrapSave(saveFloor) } : undefined),
  onError = console.error,
  loadFloorBytes = loadFloor,
} = {}) {
  let busy = false;
  let queued = null; // 実行中に来た最新の要求（1件にコアレス）: { graph, project, scope, appliesList, undoRecords }
  let idleResolvers = [];

  function mergeIntoQueue(graph, project, scope, applies, undoRecords) {
    if (!queued) {
      queued = { graph, project, scope, appliesList: [applies], undoRecords };
      return;
    }
    queued.graph = graph;
    queued.project = project;
    if (SYNC_SCOPES.indexOf(scope) > SYNC_SCOPES.indexOf(queued.scope)) queued.scope = scope;
    queued.appliesList.push(applies);
    if (undoRecords) queued.undoRecords = undoRecords; // 「持つ」要求のうち最後のものを記録先にする
  }

  async function runLoop(graph, project, scope, appliesList, undoRecords) {
    busy = true;
    let g = graph, p = project, s = scope, list = appliesList, target = undoRecords;
    for (;;) {
      if (g === p.activeGraph && list.some(f => f(g, p))) {
        // 実行を決めた時点（skipしないと分かった時点）で記録先があり、'active'以外のときだけ
        // recorderを作る（'active'＝建具の確定は自階しか書かないため記録の意味が無く、不変のまま
        // にする）。
        let recorder = null;
        if (target && s !== 'active') {
          recorder = createSyncFloorRecorder({ loadBytes: loadFloorBytes, excludePlaneId: p.activePlaneId });
          try {
            await recorder.captureBefore(nonActivePlaneIds(p));
          } catch (err) {
            onError(err);
            recorder = null; // captureBefore失敗時は記録なしで続行する
          }
        }
        try {
          await recompute(p, s, recorder);
        } catch (err) {
          onError(err);
        } finally {
          // 例外で途中終了しても、そこまでに書いた分は追記する（finally）。
          // idleResolversを解決する前（このfor文の中）に追記を終える。
          if (recorder) target.push(...recorder.records());
        }
      }
      if (!queued) break;
      ({ graph: g, project: p, scope: s, appliesList: list, undoRecords: target } = queued);
      queued = null;
    }
    busy = false;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function request(graph, project, opts) {
    if (!opts) throw new Error('structuralSync.request: opts.scope は必須です');
    const { scope, applies = ALWAYS_APPLIES, undoRecords } = opts;
    assertKnownScope(scope);
    if (busy) { mergeIntoQueue(graph, project, scope, applies, undoRecords); return; }
    void runLoop(graph, project, scope, [applies], undoRecords);
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
