// CL（通り芯・中心線・補助線・梁芯）に対するユーザー操作（移動確定・削除・
// AddCLDialog確定・木造提案判定）の実処理＋Undo登録。App.jsx から状態を持たない純粋な形へ
// 抽出したもの（挙動は元コードのまま。呼び出し側の setState・modeRef 操作だけを App.jsx に残す）。
import { runInAction } from 'mobx';
import { CenterLineType, Discipline, centerLineKind, isGridCenterLine } from '@core';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import {
  ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS,
  ERR_CL_CONVERT_DUP_FLOOR, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE, ERR_CL_DELETE_LAST_GRID, ERR_CL_CONVERT_NO_GRID,
} from '../error.js';
import { findBracketingCLs, overhangMm } from '../snapGeometry.js';
import { calcStep } from '../renderer/clMoveMath.js';
import {
  orthoAnchorCandidatesForNew, allowsWallAnchor, extentAnchorStyle, isReferencedByAux,
  sameCoordCounterparts, coexistenceAt, CL_KINDS, structuralSyncScopeOfKind, structuralSyncScopeOnMove,
  isFinishCellDivider,
} from '../core/centerLineKindPolicy.js';
import { mergeCenterLineChain, composeUndoWithMergeChain } from './centerLineMerge.js';
import {
  applyPromoteToGrid, applyDemoteToCenter, checkPromoteToGridGuards, checkDemoteToCenterGuards,
  isLastGridOnAxis, outermostGridExtentRefs,
} from './centerLineConvert.js';
import { resolveSecondaryBeamsForAxis } from '../structural/beamAxisMove.js';
import { renumberMembers } from '../structural/memberNumbering.js';
import { autoFillSecondaryBeams, autoFillBeamEccentricity, UNSPECIFIED_STRUCTURE } from '../structural/structuralAutoFill.js';
import {
  wallBeamAxisExcludeKey, peekBelowGraph, wallBeamSourcesFor, orphanedWallBeamAxes,
  wallBackingCenters, mapBackingCenterMoves,
} from '../structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../structural/wallBeamAxisFollow.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';

// CL削除・中心線移動の直後・undo/redo直後に構造同期（structural/structuralSync.js）を起動するための
// 依存注入フック（App.jsxがsetOpeningGeometryListenerと同じ作法で設定する）。未設定（構造モジュール
// 未配線のテスト等）では何もしない。centerLineOps.js自身は構造同期モジュールをimportしない——
// 起動は依存注入だけで結ぶ（openings/openingEdit.jsのsetOpeningGeometryListenerと同じ理由。
// node:testからの単体import可能性・循環import回避）。
let structuralSyncListener = null;
export function setCenterLineStructuralListener(fn) { structuralSyncListener = fn; }

// CL の pendingDelta を実座標に bake する（ref CL / 通常 CL 両対応）
export function bakeCLValue(cl, newVal) {
  if (cl.refId) {
    cl.refOffset = newVal - (cl._referencedCL?.value ?? cl._value);
  } else {
    cl.value = newVal;
  }
  cl.pendingDelta = 0;
}

// ---- CL移動の確定処理（ドラッグ確定=handlePointerUp・NumPad/Enter確定=CLMoveInput onCommit の
// 単一実装。以前は2箇所に重複しており、片方だけ直すと確定経路によって挙動が食い違うバグになるため
// 抽出した）。呼び出し側は「確定してよいか」（移動が実際にあったか等）を判定してから呼ぶこと——
// ここでは常に確定する（moveState を閉じる）前提で処理する。
// 平面モード等（通り芯・中心線・補助線）は従来どおり bake→隣接CLとの結合判定→Undo。
// 梁芯（centerLineKind(cl)==='beam'）は小梁の局所再解決・再採番が要るため、梁芯の追加・削除と同じ
// グラフスナップショット方式のUndoにする（mergeCenterLineChain は呼ばない——§3の範囲クランプで
// 他の梁芯と同一座標に到達できないため共線判定が成立せず、到達不能な分岐を残さないため）。
// 呼び出し側（App.jsx）は戻り値の toast を setToast へ反映し、常に modeRef.current?.commitMove() を
// 最後に呼ぶこと（全経路で commitMove が最後に呼ばれる構造を維持する）。
// @returns {{ toast: string|null }}
export function commitCLMoveOp(graph, project, cl, originalValue) {
  const newValue = cl.effectiveValue;
  if (newValue === originalValue) {
    runInAction(() => { cl.pendingDelta = 0; });
    return { toast: null };
  }

  if (centerLineKind(cl) !== 'beam') {
    // 段階(b)・2026-09-25: 中心線の移動でも構造同期を起動する（種別ポリシーのstructuralSyncScopeOnMove
    // 経由。通り芯・補助線は現状null＝起動しない——通り芯移動は段階(c)、補助線は段階(d)）。同じ
    // undoエントリで壁由来梁芯（discipline:fuse）を移動分だけ追従させる（followWallBeamAxes。
    // 仕上げモード脱出時の壁再生成＝wallRefresh.js と同じ手順で、専用の再計算経路を持たない
    // 「軽い」移動確定にも同じ追従を効かせる）。
    const scope = structuralSyncScopeOnMove(centerLineKind(cl));
    const notify = () => structuralSyncListener?.(graph, project, scope);
    // wallBackingCenters（wallBackingCenterCoord経由）はaxisCL.effectiveValue（=value+pendingDelta）を
    // 読むため、bakeCLValueで未確定のまま素直に呼ぶと「まだ確定していないドラッグ後の壁位置」を
    // 返してしまう（ドラッグ中プレビューがeffectiveValueを見る設計と同じ理由。実装時に実測で確認した
    // 食い違い——設計書の記述はbake前のCLがまだ旧位置にある前提だった）。pendingDeltaだけを一時的に0へ
    // 戻し「確定済みの旧座標（=value=originalValue）」を読ませてから元に戻す（_valueは触らない。
    // runInAction 1本にまとめ、MobXへ中間状態を観測させない）。
    let backingBefore = null;
    if (scope) {
      runInAction(() => {
        const savedDelta = cl.pendingDelta;
        cl.pendingDelta = 0;
        try {
          backingBefore = wallBackingCenters(graph);
        } finally {
          cl.pendingDelta = savedDelta;
        }
      });
    }

    let chainResult = { merged: false };
    runInAction(() => {
      bakeCLValue(cl, newValue);
      // 通り芯(labeled:true)は結合対象外。編集確定のたびに隣接する中心線との結合を確認する
      if (!cl.labeled) chainResult = mergeCenterLineChain(graph, cl, { kind: centerLineKind(cl) });
    });

    // 壁由来梁芯の追従はbake・結合の**後**に行う（結合で壁の軸CLが変わりうるため、追従前後の
    // wallBackingCentersは常に確定済みの壁位置から採る）。
    const axis = scope ? followWallBeamAxes(graph, mapBackingCenterMoves(backingBefore, wallBackingCenters(graph))) : null;

    const [undoFn, redoFn] = composeUndoWithMergeChain(
      () => bakeCLValue(cl, originalValue),
      () => bakeCLValue(cl, newValue),
      chainResult,
    );
    undoManager.push(
      () => {
        runInAction(() => { [...(axis?.undoFns ?? [])].reverse().forEach(f => f()); undoFn(); });
        if (scope) notify();
      },
      () => {
        runInAction(() => { redoFn(); axis?.redoFns.forEach(f => f()); });
        if (scope) notify();
      },
    );
    if (scope) notify();
    return { toast: null };
  }

  // ---- 梁芯: グラフスナップショット方式（局所再解決・再採番を含む1 undoエントリ）----
  const before = serializeGraph(graph);
  let counts = { before: 0, after: 0 };
  runInAction(() => {
    // 移動＝元位置の放棄と解釈する。次回のモード境界再計算で「壁由来の梁芯自動生成」が元の座標に
    // 復活しないよう、移動前の座標を除外集合へ記録する（cl-del分岐の記録と同じ意味・同じキー形式。
    // 手動追加の梁芯を動かした場合も無害——その座標に壁が無ければ単に使われないキーが残るだけ）。
    graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(cl.centerLineType === CenterLineType.VERTICAL, originalValue));
    bakeCLValue(cl, newValue);
    counts = resolveSecondaryBeamsForAxis(graph, cl, project);
    renumberMembers(graph, project, 'beamMap');
  });
  const after = serializeGraph(graph);
  undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
  if (counts.after !== counts.before) {
    return { toast: `小梁を${counts.before}本 → ${counts.after}本 に再構成しました` };
  }
  return { toast: null };
}

// ---- CL削除（メニューの cl-del）----
// 通り芯（isGridCenterLine＝labeled かつ種別struct）は structGraph 経由でスナップショット方式のUndo、
// それ以外（中心線・補助線・梁芯）は excludedWallBeamAxes 記録（梁芯のみ）＋removeCenterLine。
// 呼び出し側（App.jsx handleDeleteCenterLine）はメニューを閉じる等の setState を行う。
// 戻り値 {toast}: 通り芯側のみ拒否がありうる（軸最後の1本）ため、promoteCenterToGridWithUndo等の
// 変換系と同じ {toast: string|null} 契約に揃える——呼び出し側は toast があればトースト表示するだけでよい。
//
// 通り芯削除は他階（検討・屋根を含む）への detach 伝播（transform/centerLineFloorSync.js
// propagateGridCenterLineDeletion。IDB読み書きを伴う）と、構造同期（structural/structuralSync.js。
// setCenterLineStructuralListener経由の依存注入）を伴うため async 化した（案P・2026-09-25裁定。
// 非通り芯分岐にIDB・構造同期は無いが、関数全体をasyncにする機械的な波及を受ける）。
// centerLineFloorSync.js は動的 import（IndexedDBに連鎖するため、centerLineOps.js を node:test から
// 静的 import できる現状を壊さない——昇格・降格（promoteCenterToGridWithUndo/demoteGridToCenterWithUndo）
// と同じ理由）。
// @param {object} [opts] - opts.saveFloorFn はテスト用の差し替え（既定値はcenterLineFloorSync.js側のsaveFloor）。
// @returns {Promise<{ toast: string|null }>}
export async function deleteCenterLineWithUndo(graph, project, cl, opts = {}) {
  const isStruct = isGridCenterLine(cl);
  if (isStruct) {
    // 軸最後の通り芯は削除できない（ユーザー要望。中心線化ガードERR_CL_CONVERT_LAST_GRIDと同じ
    // isLastGridOnAxis判定を共有——二重実装によるズレを防ぐ。UI側の長押しメニューのグレー化
    // （interaction/usePointerInteraction.js・menuItems.js）はこの防御ガードの多層防御であり、
    // グレー化を回避して呼ばれても最終的にここで拒否される）。isStruct成立後は向き（V/H/RADIAL）を
    // 問わず呼ぶため、RADIALの通り芯に対しても呼ばれうるが、実際にはUIから到達不能
    // （centerLineConvert.test.jsの【到達不能経路・軸選択の正常化】参照）。
    if (isLastGridOnAxis(graph, cl)) return { toast: ERR_CL_DELETE_LAST_GRID };

    // 案P（採用）: 他階の detach を削除の前にundo付きで伝播する（降格の「複製→移籍」と同じ型）。
    // 通り芯が project.structGraph に残っている間に他階を peek しないと、他階の壁の
    // axisCL/clStart/clEnd が graphSnapshot.js の resolveCL で解決できず、復元時に黙って捨てられる
    // （propagateGridCenterLineDeletion のJSDoc・2026-09-17実測の教訓）。
    const { propagateGridCenterLineDeletion, applyFloorUndoRecords, rollbackFloorRecords } =
      await import('./centerLineFloorSync.js');
    const floorRecords = [];
    try {
      await propagateGridCenterLineDeletion(project, graph, cl, {
        undoRecords: floorRecords,
        ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
      });
    } catch (e) {
      await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
      throw e;
    }

    // 他階への伝播（IDB書込を伴うawait）の間に、階が切り替わった・この通り芯自体が消えた・
    // 軸最後の1本になった可能性を再評価する（await前の同期ガードだけでは足りない——N5とは逆に、
    // ここは非同期処理を挟んだ「後」に再評価する）。階切替（graph!==project.activeGraph）を
    // チェックするのは、伝播中にユーザー操作やhistoryナビゲーションでアクティブ階が変わりうるため
    // ——切り替わった後に自階（もう非アクティブになったgraph）を書き換えるのは誤り（M-2・QA指摘）。
    if (graph !== project.activeGraph || project.structGraph.shapeMap.get(cl.id) !== cl) {
      await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
      return { toast: null };
    }
    if (isLastGridOnAxis(graph, cl)) {
      await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
      return { toast: ERR_CL_DELETE_LAST_GRID };
    }

    // 通り芯の削除 — structGraph をスナップショット経由で Undo。
    // structGraph の teardown は階グラフの図形に届かないため、アクティブ階グラフ側の
    // 壁端・extent 参照を先に切り離し（端点ルール）、続けて自階の柱・梁・基礎等（この通り芯に
    // dangling 参照のまま残る部材）も撤去する（removeDependentsOfCenterLine。段階(a)の主目的——
    // 従来は detachFromCenterLine のみで、袖柱・この通り芯上の部材が孤立していた）。階グラフも
    // Undo 対象に含める。
    const beforeArch = serializeGraph(graph);
    const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    const clId = cl.id; // 削除前に控える——undo/redoクロージャ・notifyはcl自体を参照しない
    graph.detachFromCenterLine(clId);
    graph.removeDependentsOfCenterLine(clId);
    project.structGraph.removeCenterLine(clId);
    const afterArch = serializeGraph(graph);
    const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);

    // 通り芯削除は種別ポリシーから導いたscope（通り芯＝FLOOR_SHARED_KINDSのため常に'all'）で
    // 構造同期を起動する（structural/structuralSync.js。App.jsxがsetCenterLineStructuralListenerで
    // 配線する）。建具と違い在来限定にしない（applies省略＝常に真。非在来のグリッド柱にも効くため）。
    const scope = structuralSyncScopeOfKind(centerLineKind(cl));
    const notify = () => structuralSyncListener?.(graph, project, scope);

    const saveFloorFn = opts.saveFloorFn;
    // amendは使わない（他階の復元→自階の復元→構造同期の順序を自分で制御するため）。
    undoManager.push(
      () => {
        restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger);
        restoreGraph(graph, beforeArch);
        applyFloorUndoRecords(project, floorRecords, 'before', saveFloorFn);
        notify();
      },
      () => {
        restoreStructCLs(project.structGraph, project.structuralInfo, after, project.memberGroupLedger);
        restoreGraph(graph, afterArch);
        applyFloorUndoRecords(project, floorRecords, 'after', saveFloorFn);
        notify();
      },
    );
    notify();
    return { toast: null };
  }

  // 非通り芯（中心線・補助線・梁芯）は種別ポリシーから導いたscopeで構造同期を起動する
  // （実機報告2026-09-25: tategu-test3.stqで中心線を削除すると壁交点柱が残ったままだったバグの
  // 修正——.claude/structural-model.md「起動点」節参照）。中心線は
  // structuralSyncScopeOfKind('center')==='activeAndAbove'（'all'と同じ処理のまま恒久化。在来木造の
  // 3b/3h-2による下方向依存があるため自階＋上階だけでは足りない——structuralOrchestration.js
  // recomputeForStructuralSync のコメント参照）。補助線・梁芯はnull（補助線は段階(d)、梁芯は専用経路
  // structural/wallBeamAxes.js。条件10で二重に動かさない）——それ以外の非通り芯削除では
  // 従来どおりlistenerを呼ばない。
  const scope = structuralSyncScopeOfKind(centerLineKind(cl));
  const notify = () => structuralSyncListener?.(graph, project, scope);
  // 壁の軸になれる種別（セル分割線。isFinishCellDivider——このブランチには通り芯は来ないため
  // 実質center種別のみが真になる）の削除だけが壁ソースを変えうる——補助線・梁芯自身の削除は
  // 壁の軸にならないため対象外。
  const canCarryWalls = isFinishCellDivider(cl);

  // ユーザー承認済み例外（2026-09-25）: 明示的な中心線削除に限り、その削除で失われる壁だけを
  // 根拠にしていた壁由来梁芯（discipline:fuse。structural/wallBeamAxes.js autoFillWallBeamAxes）を
  // 同じundoエントリで道連れにする——一般に孤児梁芯を撤去する規律は作らない
  // （.claude/structural-model.md「孤児梁芯を撤去する規律は作らない」節。今回は「同じ操作の中で
  // 壁ソースが消えた事実」が出自の代わりになる、明示的な中心線削除だけの特例）。
  // 在来木造（wallBeamAxes:'selfAndBelow'）は自階＋1つ下の階の壁を根拠にするため、道連れ判定にも
  // 下階の壁区間が要る——中心線削除のときだけ、その主構造ルールのときだけ下階をpeekする
  // （RC造・非生成主構造でIDBを無駄に読まない。opts.peekBelowはテスト用の差し替え）。
  const needsBelowPeek = canCarryWalls && rulesFor(effectiveStructure(graph, project)).wallBeamAxes === 'selfAndBelow';
  const belowGraph = needsBelowPeek ? await (opts.peekBelow ?? peekBelowGraph)(graph, project) : null;

  // 下階peekの await 中に階が切り替わった・この中心線自体が消えた可能性を再評価する
  // （通り芯削除のM-2ガードと同型。peekしていない経路（aux・beam・selfAndBelow以外の中心線）は
  // awaitを挟まないため再評価は不要）。
  if (needsBelowPeek && (graph !== project.activeGraph || graph.shapeMap.get(cl.id) !== cl)) {
    return { toast: null };
  }

  const before = serializeGraph(graph);
  // 梁芯CLの削除は「壁由来の梁芯自動生成」に対する明示的な手動削除として扱う——次回のモード境界
  // 再計算で元の座標に再生成されないよう、座標ベースの除外集合へ記録する（壁の位置自体は削除しない
  // ため、記録しないと自動生成が復活させてしまう）。キーは structural/wallBeamAxes.js と同じ形式。
  // 中心線の道連れ削除（下記）は excludedWallBeamAxes に触れない——壁が戻れば（undo）再生成される
  // ため、手動削除・移動の記録と同列に扱わない。
  runInAction(() => {
    if (centerLineKind(cl) === 'beam') {
      graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(cl.centerLineType === CenterLineType.VERTICAL, cl.effectiveValue));
    }
    // graph.removeCenterLine は内部で detachFromCenterLine（壁端・extent参照の切り離し）→
    // _teardownCenterLine（removeDependentsOfCenterLineで柱・梁・耐力壁・基礎・スリーブを撤去
    // →Intersection撤去）を行うため、通り芯削除のように別途removeDependentsOfCenterLineを
    // 呼ぶ必要はない——この1行の時点で壁位置は既に確定済み（構造同期の前提を満たす）。
    // 中心線は階固有の実体で他階からは参照されない（昇格・降格の同一id複製は別オブジェクト
    // ——transform/centerLineFloorSync.js propagateDemotedCenterLine/recallPromotedCenterLineDuplicates
    // 参照）ため、通り芯削除と違い他階への伝播（propagate*）は不要。
    const sourcesBefore = canCarryWalls ? wallBeamSourcesFor(graph, project, belowGraph) : null;
    graph.removeCenterLine(cl.id);
    if (canCarryWalls) {
      const sourcesAfter = wallBeamSourcesFor(graph, project, belowGraph);
      for (const ax of orphanedWallBeamAxes(graph, sourcesBefore, sourcesAfter)) {
        graph.removeCenterLine(ax.id);
      }
    }
  });
  const after = serializeGraph(graph);
  undoManager.push(
    () => { restoreGraph(graph, before); if (scope) notify(); },
    () => { restoreGraph(graph, after); if (scope) notify(); },
  );
  if (scope) notify();
  return { toast: null };
}

// ---- 中心⇔通り芯の入替え（平面モード限定・メニューの cl-to-grid / cl-to-center）----
// グラフ変更本体（純粋部分）は transform/centerLineConvert.js。ここは undo 登録・階またぎ同期の
// 呼び出しを担う（centerLineFloorSync.js は動的 import——IndexedDB(storage/db.js) に連鎖するため、
// centerLineOps.js を node:test から静的 import できる現状を壊さないよう静的 import を避ける）。
// 通り芯削除（deleteCenterLineWithUndo の isStruct 分岐）と同じ二重スナップショット方式のUndo。
// 復元順序厳守: struct を先に戻してから階グラフを戻す（階グラフの CL 参照解決が structGraph を
// 引くため——階グラフ側を先に戻すと一時的に参照先を失った状態を経由してしまう）。

// ---- 中心線 → 通り芯 ----
// 同期ガード（型・直交通り芯・図形干渉・同グラフ内重複）を先に評価してから、IDBを伴う
// 他階重複チェック（findFloorsWithCounterpartCL）を呼ぶ——確実に失敗する同期ガードのために
// 無駄な全階IDB読み込みが走り、本来と異なるトーストが先に出るのを防ぐ（N5）。
// 成功後は非アクティブ全階にある同一idの複製（降格時にpropagateDemotedCenterLineが作った
// 「同じ線の分身」）を回収する（recallPromotedCenterLineDuplicates）。
// @param {{saveFloorFn?: Function}} [opts] - saveFloorFn はテスト用の差し替え（既定値は
//   centerLineFloorSync.js 側の saveFloor。呼び出し側（App.jsx）は無改造でよい）。
// @returns {Promise<{ toast: string|null }>}
export async function promoteCenterToGridWithUndo(graph, project, cl, opts = {}) {
  const guardError = checkPromoteToGridGuards(graph, project.structGraph, cl);
  if (guardError) return { toast: guardError };

  const { findFloorsWithCounterpartCL } = await import('./centerLineFloorSync.js');
  const dupFloors = await findFloorsWithCounterpartCL(project, graph, cl);
  if (dupFloors.length > 0) {
    return { toast: ERR_CL_CONVERT_DUP_FLOOR(dupFloors.map(f => ({ name: f.plane.name, kind: f.kind }))) };
  }

  const beforeArch   = serializeGraph(graph);
  const beforeStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const { error } = applyPromoteToGrid(graph, project.structGraph, cl);
  if (error) return { toast: error };
  const afterArch   = serializeGraph(graph);
  const afterStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const entry = undoManager.push(
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
      restoreGraph(graph, beforeArch);
    },
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, afterStruct, project.memberGroupLedger);
      restoreGraph(graph, afterArch);
    },
  );

  const { recallPromotedCenterLineDuplicates } = await import('./centerLineFloorSync.js');
  await recallPromotedCenterLineDuplicates(project, graph, cl, {
    undoEntry: entry,
    ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
  });
  return { toast: null };
}

// ---- 通り芯 → 中心線 ----
// 同期ガードを先に評価してから（N5。promoteCenterToGridWithUndoと同じ理由）、変換前に他階の
// 同座標重複もチェックする（スキップ方式は不採用——片階だけ複製漏れすると壁参照が壊れるため、
// 1階でも重複していれば全体を拒否する）。
// 順序は「複製→移籍」（案A、2026-09-17裁定）: 通り芯が project.structGraph に残っている間に
// 非アクティブ全階へ同一idで複製してから（propagateDemotedCenterLine）、本体を移籍する
// （applyDemoteToCenter）。逆順（移籍→複製）だと、複製フェーズで他階を peek した時点で通り芯が
// structGraph に無く、他階の壁の axisCL/clStart/clEnd が graphSnapshot.js の resolveCL で解決
// できず復元時に黙って捨てられ、その欠落が saveFloor で永続化される（2026-09-17実測。昇格は
// 逆に「移籍→回収」で正しい——promoteCenterToGridWithUndo参照）。
// 複製フェーズが途中で失敗（例外）した場合、またはその直後の applyDemoteToCenter がエラーを
// 返した場合は、そこまでに保存できた階を rollbackFloorRecords で before に書き戻す
// （best effort）。前者は自階・structGraphとも未変更のため undo エントリを積まず例外を再スロー
// （呼び出し側 App.jsx の catch が ERR_CL_CONVERT_SYNC_FAILED を出す）。後者は従来どおり
// { toast: error } を返す。
// @param {{saveFloorFn?: Function}} [opts] - saveFloorFn はテスト用の差し替え（既定値は
//   centerLineFloorSync.js 側の saveFloor。呼び出し側（App.jsx）は無改造でよい）。
// @returns {Promise<{ toast: string|null }>}
export async function demoteGridToCenterWithUndo(graph, project, cl, opts = {}) {
  const guardError = checkDemoteToCenterGuards(graph, project.structGraph, cl);
  if (guardError) return { toast: guardError };

  const { findFloorsWithCounterpartCL, propagateDemotedCenterLine, amendFloorUndoRecords, rollbackFloorRecords } =
    await import('./centerLineFloorSync.js');
  const dupFloors = await findFloorsWithCounterpartCL(project, graph, cl);
  if (dupFloors.length > 0) {
    // 降格（通り芯→中心）専用の文言。ERR_CL_CONVERT_DUP_FLOOR（昇格用「…通り芯にできません」）を
    // 流用すると方向が逆の誤表示になるため、DEMOTE専用の文言を使う（N1）。
    return { toast: ERR_CL_CONVERT_DUP_FLOOR_DEMOTE(dupFloors.map(f => ({ name: f.plane.name, kind: f.kind }))) };
  }

  // 複製フェーズ（通り芯はまだ structGraph にある。移籍前提のため applyDemoteToCenter と同じ
  // outermostGridExtentRefs を呼ぶ——二重計算になるが純関数のため結果は同一）。
  // 上の同期ガードから findFloorsWithCounterpartCL の await を挟むため、その間に直交通り芯が
  // 消えて null になりうる——TypeError で汎用トーストに劣化させず、ガードを再評価して NO_GRID を返す。
  const refs = outermostGridExtentRefs(graph, cl);
  if (!refs) return { toast: checkDemoteToCenterGuards(graph, project.structGraph, cl) ?? ERR_CL_CONVERT_NO_GRID };
  const { loCL, hiCL } = refs;
  const propagationRecords = [];
  try {
    await propagateDemotedCenterLine(project, graph, cl, {
      loCL, hiCL, undoRecords: propagationRecords,
      ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
    });
  } catch (e) {
    await rollbackFloorRecords(propagationRecords, opts.saveFloorFn);
    throw e;
  }

  const beforeArch   = serializeGraph(graph);
  const beforeStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const result = applyDemoteToCenter(graph, project.structGraph, cl);
  if (result.error) {
    // 複製済みの他階も巻き戻す（自階・structGraph はガード契約によりまだ未変更）。
    await rollbackFloorRecords(propagationRecords, opts.saveFloorFn);
    return { toast: result.error };
  }
  const afterArch   = serializeGraph(graph);
  const afterStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const entry = undoManager.push(
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
      restoreGraph(graph, beforeArch);
    },
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, afterStruct, project.memberGroupLedger);
      restoreGraph(graph, afterArch);
    },
  );
  amendFloorUndoRecords(project, entry, propagationRecords, opts.saveFloorFn);

  return { toast: null };
}

// 木造（在来）の自動判定: 平面モードで主構造が未指定のとき、追加した通り芯が
// 既存グリッドと910の倍数間隔をなすなら「木造（在来）」を提案する確認ダイアログを出す。
// 「寸法指定を910で割った余りが0」を、隣接グリッドCLとの最小間隔で判定する（参照なし絶対座標入力にも効く）。
// この関数は「提案すべきか」の判定部のみを行う純関数。ダイアログ表示（setFloorConfirm）は呼び出し側（App.jsx）。
export function shouldSuggestWoodStructure(graph, project, appMode, clType, newValues) {
  if (appMode !== 'floorplan') return false;
  if (project.structuralInfo.mainStructure !== UNSPECIFIED_STRUCTURE) return false; // 既に主構造が確定済みなら提案しない
  const grid = (clType === CenterLineType.VERTICAL ? graph.gridXs : graph.gridYs).map(cl => cl.effectiveValue);
  return newValues.some(v => {
    let nearest = Infinity;
    for (const u of grid) {
      const d = Math.abs(u - v);
      if (d > 0.5 && d < nearest) nearest = d; // 自分自身（d≈0）は除外
    }
    return nearest !== Infinity && Math.round(nearest) % 910 === 0;
  });
}

// ---- AddCLDialog確定（handleCLDialogConfirm） ----
// extent解決・重複判定（ERR_CL_DUPLICATE等）・結合連鎖（mergeCenterLineChain/composeUndoWithMergeChain）・
// undo登録を行う。ダイアログを閉じる setState・木造提案 ConfirmDialog の表示は呼び出し側（App.jsx）。
// @param {object} payload { clDialog, value, kind, refId, refOffset }
// @returns {{ done: boolean, toast: string|null, suggestWood: {clType, newValues}|null }}
export function addCenterLineFromDialog(graph, project, payload, viewport) {
  const { clDialog, value, kind, refId, refOffset } = payload;
  const clType = clDialog.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;

  // ---- スパン配列バッチモード（kind='struct' かつ value が配列）----
  if (Array.isArray(value)) {
    // 走査は sameCoordCounterparts（core/centerLineKindPolicy.js）経由——種別条件の無い素の
    // graph.centerLines 走査を個別に書かない（QA指摘m-4。述語はtolMm既定=CL_OVERLAP_TOL_MMで
    // 従来の `< CL_OVERLAP_TOL_MM` と完全一致）。
    const newValues = value.filter(v =>
      sameCoordCounterparts(graph, { centerLineType: clType, value: v }).length === 0
    );
    if (newValues.length === 0) {
      return { done: true, toast: ERR_CL_DUPLICATE('struct'), suggestWood: null };
    }
    const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    newValues.forEach(v =>
      project.structGraph.addCenterLine(clType, v, {
        discipline: Discipline.STRUCT,
        labeled:    true,
      })
    );
    const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    undoManager.push(
      () => restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger),
      () => restoreStructCLs(project.structGraph, project.structuralInfo, after, project.memberGroupLedger),
    );
    return { done: true, toast: null, suggestWood: { clType, newValues } };
  }

  // extent 計算: center・beam（梁芯は中心線相当の処理を共用）は直交CL参照、aux は3ケース判定（壁・CL・フリー）
  let extentProps = {};
  let newExtentLo = null, newExtentHi = null;
  if (kind === 'center' || kind === 'beam') {
    // 直交端部候補は orthoAnchorCandidatesForNew（core/centerLineKindPolicy.js）経由で選ぶ——
    // 種別の許可（center: 通り芯・中心線・補助線／beam: 通り芯のみ。ORTHO_ANCHOR_OVERRIDE特例。
    // autoFillSecondaryBeamsが見るgraph.gridXs/Ysは通り芯のみのため、梁芯の候補を中心線・補助線
    // まで広げると直交グリッドに存在しない区画へextentが確定し小梁0本事故になる）と、範囲被覆
    // （coversAlongAxis。非ラベルCLはextentLo/Hiの実範囲に新規CLの座標=wcが含まれるものだけ）を
    // 一括で判定する。coord には新規CL自身の「自軸座標」（perpCLsの extentLo/Hi と同じ軸=wc）を渡す
    // ——clDialog.perpCoord（findBracketingCLsが見るブラケット探索軸）とは別物。
    // kind・centerLineType・coord を明示引数で渡す（ダック型の仮オブジェクトを作らない——
    // valueの代わりにcoordを渡し忘れると例外なしに非labeled候補だけが静かに脱落する事故を防ぐ）。
    const wc = clDialog.worldCoord;
    const perpCLs = orthoAnchorCandidatesForNew(graph, { kind, centerLineType: clType, coord: wc });
    const [loCL, hiCL] = findBracketingCLs(perpCLs, clDialog.perpCoord);
    newExtentLo = loCL ? loCL.value : (perpCLs.length ? Math.min(...perpCLs.map(c => c.value)) : null);
    newExtentHi = hiCL ? hiCL.value : (perpCLs.length ? Math.max(...perpCLs.map(c => c.value)) : null);
    extentProps = {
      labeled:     false,
      extentLoRef: loCL ? { clId: loCL.id, offset: 0 } : null,
      extentHiRef: hiCL ? { clId: hiCL.id, offset: 0 } : null,
      extentLo:    !loCL ? newExtentLo : null,
      extentHi:    !hiCL ? newExtentHi : null,
    };
  } else if (kind === 'aux') {
    const isNewV   = clType === CenterLineType.VERTICAL;
    const wc       = clDialog.worldCoord;
    const pc       = clDialog.perpCoord;
    const overhang = overhangMm(viewport, false);

    // フリーエンドポイント用: ポインティング座標をキリ良い数値に丸める
    const niceStep = calcStep(viewport.scaleDenominator);
    const roundToNiceCoord = (coord) =>
      niceStep > 0 ? Math.round(coord / niceStep) * niceStep : Math.round(coord);

    // 直交壁を検出（新CLの座標が壁の長手範囲に含まれるもの）。allowsWallAnchor('aux')は常にtrueだが、
    // 壁候補の可否をポリシー経由で明示する（centerLineExtend.jsのfindExtendBoundaryと同じif形に揃える
    // ——三項演算子の`: []`は到達不能に見え誤読を招くため使わない）。
    let perpWalls = [];
    if (allowsWallAnchor('aux')) {
      perpWalls = graph.walls.filter(w => {
        if (w.isVertical === isNewV) return false;
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        return c1 <= wc && wc <= c2;
      });
    }
    const loWall = perpWalls.filter(w => w.axisValue <= pc)
      .reduce((best, w) => !best || w.axisValue > best.axisValue ? w : best, null);
    const hiWall = perpWalls.filter(w => w.axisValue >= pc)
      .reduce((best, w) => !best || w.axisValue < best.axisValue ? w : best, null);

    // 直交CLを検出（orthoAnchorCandidatesForNew経由。2026-09-18裁定: 梁芯は端部候補から除外する——
    // 補助線は壁になれず、端が壁で止まるのは作図上のトリムだけのため、追加extentと同じ
    // 「主体と同じモードで可視な種別」＝通り芯・中心線・補助線に揃える）。
    const allPerpCLs = orthoAnchorCandidatesForNew(graph, { kind: 'aux', centerLineType: clType, coord: wc });
    const [loCL, hiCL] = findBracketingCLs(allPerpCLs, pc);

    // lo側境界の決定: 壁とCLのうち perpCoordに近い（値が大きい）ものを優先
    let loRef = null, loStaticVal = null;
    const loByCL   = loCL  ? { type: 'cl',   val: loCL.value,       item: loCL   } : null;
    const loByWall = loWall ? { type: 'wall', val: loWall.axisValue, item: loWall } : null;
    const bestLo = (loByCL && loByWall) ? (loByWall.val >= loByCL.val ? loByWall : loByCL)
                 : (loByCL ?? loByWall);

    if (bestLo?.type === 'wall') {
      loRef       = { wallId: bestLo.item.id };
      newExtentLo = bestLo.val;
    } else if (bestLo?.type === 'cl') {
      if (extentAnchorStyle('aux') === 'overhang' && !isReferencedByAux(graph, bestLo.item)) {
        // 既存参照なし → はね出し（静的座標）
        loStaticVal = bestLo.val - overhang;
        newExtentLo = loStaticVal;
      } else {
        // 既存補助線が同じCLを参照 → リアクティブ参照（CLと連動してトリム）
        loRef       = { clId: bestLo.item.id, offset: 0 };
        newExtentLo = bestLo.val;
      }
    } else {
      // フリーエンドポイント: ポインティング座標をキリ良い数値に丸めて採用
      loStaticVal = roundToNiceCoord(pc);
      newExtentLo = loStaticVal;
    }

    // hi側境界の決定: 壁とCLのうち perpCoordに近い（値が小さい）ものを優先
    let hiRef = null, hiStaticVal = null;
    const hiByCL   = hiCL  ? { type: 'cl',   val: hiCL.value,       item: hiCL   } : null;
    const hiByWall = hiWall ? { type: 'wall', val: hiWall.axisValue, item: hiWall } : null;
    const bestHi = (hiByCL && hiByWall) ? (hiByWall.val <= hiByCL.val ? hiByWall : hiByCL)
                 : (hiByCL ?? hiByWall);

    if (bestHi?.type === 'wall') {
      hiRef       = { wallId: bestHi.item.id };
      newExtentHi = bestHi.val;
    } else if (bestHi?.type === 'cl') {
      if (extentAnchorStyle('aux') === 'overhang' && !isReferencedByAux(graph, bestHi.item)) {
        hiStaticVal = bestHi.val + overhang;
        newExtentHi = hiStaticVal;
      } else {
        hiRef       = { clId: bestHi.item.id, offset: 0 };
        newExtentHi = bestHi.val;
      }
    } else {
      // フリーエンドポイント: ポインティング座標をキリ良い数値に丸めて採用
      hiStaticVal = roundToNiceCoord(pc);
      newExtentHi = hiStaticVal;
    }

    extentProps = {
      labeled:     false,
      extentLoRef: loRef,
      extentHiRef: hiRef,
      extentLo:    loRef ? null : loStaticVal,
      extentHi:    hiRef ? null : hiStaticVal,
    };
  }

  // ---- 重複チェック（extent計算後に実施） ----
  // 同座標には梁芯と中心線・補助線が共存しうる（下記の梁芯ガード参照）ため、先頭1本ではなく全部を取り、
  // 同種別があればそれを existing にする——先頭が梁芯だと同種別の extent 重なり判定・結合連鎖に入らず
  // 同位置へ何本でも積めてしまう（QA指摘）。同種別が無いときも先頭順ではなく種別の優先順で相手を選ぶ
  // ——補助線→中心線の順で並ぶ位置へ通り芯を足すと、先頭の補助線が相手になって昇格経路（中心線を
  // 削除して通り芯化）に入らず、通り芯・中心線・補助線が3本併存する（並び順依存。QA指摘）。
  // 走査は sameCoordCounterparts（core/centerLineKindPolicy.js）経由——種別条件の無い素の
  // graph.centerLines 走査を個別に書かない（過去に3回、非表示の梁芯が誤って障害物に混入した教訓）。
  const sameCoord = sameCoordCounterparts(graph, { centerLineType: clType, value });
  // 優先順は CL_KINDS の並びそのもの（通り芯＞中心線＞補助線＞梁芯）——並び順に依存させないための
  // 規約であり、種別ごとの拒否・共存ルール自体はこの順に依存しない。
  const existing = sameCoord.find(cl => centerLineKind(cl) === kind)
    ?? CL_KINDS.map(k => sameCoord.find(cl => centerLineKind(cl) === k)).find(Boolean);
  if (existing) {
    const existingKind = centerLineKind(existing);

    if (kind === existingKind) {
      // COEXISTENCE の対角セル: struct×structのみforbidden、center/aux/beamはextent（重なり判定）。
      if (coexistenceAt(kind, existingKind) === 'forbidden') {
        return { done: false, toast: ERR_CL_DUPLICATE(kind), suggestWood: null };
      }
      // center / aux / beam: extent が重ならなければ追加を許可（端点が接するだけなら下の結合連鎖へ）。
      // どちらかの extent が1点に退化している（補助線のフリー端点が両方 perpCoord に丸められた
      // 長さ0の線。直交する線・壁が無い位置で起きる）場合は、開区間の重なりが常に空になって同座標に
      // 何本でも積めてしまうため、閉区間で点が含まれれば重なりとみなす（長さ0の補助線自体は許容）。
      const exLo = existing.extentLo;
      const exHi = existing.extentHi;
      const degenerate = newExtentLo === newExtentHi || exLo === exHi;
      const extentsOverlap =
        newExtentLo == null || newExtentHi == null ||
        exLo == null || exHi == null ||
        (degenerate ? !(newExtentHi < exLo || newExtentLo > exHi)
                    : !(newExtentHi <= exLo || newExtentLo >= exHi));
      if (extentsOverlap) {
        return { done: false, toast: ERR_CL_DUPLICATE(kind), suggestWood: null };
      }
      // 隣接するCLがあれば結合する（線分の端点一致をベクトル演算で確認、多段連鎖にも対応）
      // extentProps.extentLo/Hi は CenterLine コンストラクタ用の静的フォールバック値（ref があれば null）。
      // getCenterLineSegment が読む座標は常に解決済みの newExtentLo/newExtentHi で渡す必要がある。
      const virtualCandidate = { centerLineType: clType, value, ...extentProps, extentLo: newExtentLo, extentHi: newExtentHi };
      const chainResult = runInAction(() => mergeCenterLineChain(graph, virtualCandidate, { kind }));
      if (chainResult.merged) {
        undoManager.push(
          () => runInAction(chainResult.undo),
          () => runInAction(chainResult.redo),
        );
        return { done: true, toast: null, suggestWood: null };
      }
    }

    // 梁芯の手動追加は他種別（通り芯/中心/補助線）と同位置に共存できない（大梁と完全重複する小梁の
    // 生成防止）。通り芯の追加も既存の梁芯を拒否する。
    // ただし既存が梁芯で新規が中心線・補助線なら拒否しない——梁芯は在来木造の構造モードが「1つ下の階の壁」
    // からも自階へ自動生成し（structural/wallBeamAxes.js）平面モードでは非表示のため、障害物にすると
    // 「当該階に線が無いのに下階に線があると追加できない」になる。中心線・補助線の同位置不許可は同一図面内
    // の同種別（上の extent 重なり判定）だけで、autoFillWallBeamAxes の重複ガード（意匠中心線・補助線は
    // 障害物にしない）と対称にする。
    // kind==='beam'側は coexistenceAt(kind, existingKind) で判定できる（beam行はbeam自身以外すべて
    // forbiddenのため、existingKind!=='beam'と同値）。kind==='struct'側は existing（同種別優先＝
    // 中心線が先に選ばれうる）ではなく同座標全体で梁芯の有無を見る必要がある——中心線→梁芯の順に
    // 並んでいても昇格経路（中心線削除→通り芯追加）へ入って梁芯を残さないため。この2点目は
    // coexistenceAt(newKind, existingKind)（priority選択された1本だけを見る関係）では表現できない
    // （sameCoord全体を見る必要がある）ため、走査のAPI化のみに留める（表駆動へは寄せない）。
    if ((kind === 'beam' && coexistenceAt(kind, existingKind) === 'forbidden') ||
        (kind === 'struct' && sameCoord.some(cl => centerLineKind(cl) === 'beam'))) {
      return { done: false, toast: ERR_CL_DUPLICATE(kind === 'struct' ? 'beam' : existingKind), suggestWood: null };
    }

    if (coexistenceAt(kind, existingKind) === 'promote') {
      // 既存の中心線を削除して通り芯を新規追加
      const deletedId = existing.id;
      const deletedType = existing.centerLineType;
      const deletedRawValue = existing._value;
      const deletedProps = {
        labeled: existing.labeled,
        lineType: existing.lineType,
        discipline: existing.discipline,
        trim: existing.trim,
        ...(existing.refId != null ? { refId: existing.refId, refOffset: existing.refOffset } : {}),
        ...(existing.extentLoRef != null ? { extentLoRef: existing.extentLoRef } : {}),
        ...(existing.extentHiRef != null ? { extentHiRef: existing.extentHiRef } : {}),
        ...(existing._extentLo != null ? { extentLo: existing._extentLo } : {}),
        ...(existing._extentHi != null ? { extentHi: existing._extentHi } : {}),
      };
      graph.removeCenterLine(deletedId);
      const structProps = {
        discipline: Discipline.STRUCT,
        ...(refId ? { refId, refOffset: refOffset ?? 0 } : {}),
      };
      // 通り芯は project.structGraph に追加する
      const structCL = project.structGraph.addCenterLine(clType, value, structProps);
      const structId = structCL.id;
      undoManager.push(
        () => {
          project.structGraph.removeCenterLine(structId);
          graph.addCenterLine(deletedType, deletedRawValue, deletedProps, deletedId);
        },
        () => {
          graph.removeCenterLine(deletedId);
          project.structGraph.addCenterLine(clType, value, structProps, structId);
        },
      );
      return { done: true, toast: ERR_CL_CENTER_UPGRADED, suggestWood: { clType, newValues: [value] } };
    }

    // center行でforbiddenなのはstructのみ（COEXISTENCE.center.struct）。ERR_CL_DUPLICATEの
    // 「追加できません」ではなく専用文言（ERR_CL_STRUCT_EXISTS）を使う。
    if (kind === 'center' && coexistenceAt(kind, existingKind) === 'forbidden') {
      return { done: false, toast: ERR_CL_STRUCT_EXISTS, suggestWood: null };
    }
  }

  // 通り芯は project.structGraph へ、それ以外は activeGraph へ
  const targetGraph = kind === 'struct' ? project.structGraph : graph;
  // refId はターゲットグラフだけでなく structGraph も解決対象に含める
  // （center CL が struct CL を参照するケース）。addCenterLine 側も同じ範囲で
  // _referencedCL を解決するため、ここで解決可能と判定すれば二重加算は起きない。
  const isRefResolvable = refId
    ? !!(targetGraph.shapeMap.get(refId) ?? project.structGraph.shapeMap.get(refId))
    : false;
  const props = {
    ...extentProps,
    ...(kind === 'struct' ? { discipline: Discipline.STRUCT } : {}),
    ...(kind === 'aux'    ? { labeled: false, lineType: 'dashed' } : {}),
    ...(kind === 'beam'   ? { discipline: Discipline.FUSE, labeled: false } : {}),
    ...(isRefResolvable ? { refId, refOffset: refOffset ?? 0 } : {}),
  };

  if (kind === 'beam') {
    // 梁芯CL追加＋直交大梁に挟まれた区間の小梁自動生成＋採番を1 undoエントリにまとめる
    // （グラフスナップショット方式。CL削除連鎖などと同じ既存パターン）。
    const before = serializeGraph(graph);
    runInAction(() => {
      const newCl = graph.addCenterLine(clType, value, props);
      // 壁由来の梁芯自動生成の除外集合を解除する（addColumn/addBeamがexcluded*Slotsを解除する
      // 既存パターンと同型）——手動でこの位置に梁芯を追加した以上、以後の自動生成で復活してよい。
      graph.excludedWallBeamAxes.delete(wallBeamAxisExcludeKey(clType === CenterLineType.VERTICAL, newCl.effectiveValue));
      autoFillSecondaryBeams(graph, project);
      autoFillBeamEccentricity(graph, project);
      renumberMembers(graph, project, 'beamMap');
    });
    const after = serializeGraph(graph);
    undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
    return { done: true, toast: null, suggestWood: null };
  }

  const cl = targetGraph.addCenterLine(clType, value, props);
  const clId = cl.id;
  undoManager.push(
    () => targetGraph.removeCenterLine(clId),
    () => targetGraph.addCenterLine(clType, value, props, clId),
  );
  return { done: true, toast: null, suggestWood: kind === 'struct' ? { clType, newValues: [value] } : null };
}
