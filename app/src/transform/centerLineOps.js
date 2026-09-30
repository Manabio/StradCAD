// CL（通り芯・中心線・補助線・梁芯）に対するユーザー操作（移動確定・削除・
// AddCLDialog確定・木造提案判定）の実処理＋Undo登録。App.jsx から状態を持たない純粋な形へ
// 抽出したもの（挙動は元コードのまま。呼び出し側の setState・modeRef 操作だけを App.jsx に残す）。
import { runInAction } from 'mobx';
import { CenterLineType, Discipline, centerLineKind, isGridCenterLine } from '@core';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import {
  ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS,
  ERR_CL_CONVERT_DUP_FLOOR, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE, ERR_CL_DELETE_LAST_GRID, ERR_CL_CONVERT_NO_GRID,
  ERR_CL_DELETE_FOOTPRINT, ERR_CL_DELETE_UNRESOLVABLE, ERR_CL_DELETE_WALLS_UNAVAILABLE, ERR_CATALOG_DUPLICATE,
  ERR_CL_CONVERT_SAME_ID_FLOOR, ERR_CL_CONVERT_SAME_ID_FLOOR_DEMOTE, ERR_CL_CONVERT_ABSORB_CONFLICT_FLOOR,
  ERR_CL_ADD_DUP_FLOOR, ERR_CL_ADD_DUP_FLOOR_SPAN,
} from '../error.js';
import { findUnresolvableCells, collectUnresolvableCells } from '../finish/roomReinterpret.js';
import { findBracketingCLs, overhangMm } from '../snapGeometry.js';
import { calcStep } from '../renderer/clMoveMath.js';
import {
  orthoAnchorCandidatesForNew, allowsWallAnchor, extentAnchorStyle, isReferencedByAux,
  sameCoordCounterparts, coexistenceAt, CL_KINDS, structuralSyncScopeOfKind, structuralSyncScopeOfConversion,
  structuralSyncScopeForCenterLine, isFinishCellDivider,
} from '../core/centerLineKindPolicy.js';
import { mergeCenterLineChain, composeUndoWithMergeChain } from './centerLineMerge.js';
import {
  applyPromoteToGrid, applyDemoteToCenter, checkPromoteToGridGuards, checkDemoteToCenterGuards,
  isLastGridOnAxis, outermostGridExtentRefs, isFootprintBoundaryCL,
} from './centerLineConvert.js';
import { resolveSecondaryBeamsForAxis } from '../structural/beamAxisMove.js';
import { renumberMembers } from '../structural/memberNumbering.js';
import { autoFillSecondaryBeams, autoFillBeamEccentricity, UNSPECIFIED_STRUCTURE } from '../structural/structuralAutoFill.js';
import {
  wallBeamAxisExcludeKey, peekBelowGraph, wallBeamSourcesFor, removeOrphanedWallBeamAxesFor, belowPlaneOf,
  wallBackingCenters, mapBackingCenterMoves, isProtectedWallBeamAxis, findWallBeamAxisCLs,
} from '../structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../structural/wallBeamAxisFollow.js';
import { openingBeamSourcesFor, mapOpeningSourceMoves } from '../structural/openingBeamAxes.js';
import { stairRiserOf } from '../finish/stair/stairDimensions.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';
import { peekVia } from '../structural/structuralPeek.js';
// wallRefresh.js・finish/wallRegeneration.js は静的import——centerLineOps.jsは既に
// wallBeamAxes.js→structuralPeek.js経由でFloorSwapManager.js・storage/db.jsを静的に引いている
// （centerLineFloorSync.jsの静的import化と同じ理由。冒頭コメント参照）ため、wallRefresh.jsが
// 同じ依存（FloorSwapManager.js・storage/db.js）を静的に引いても単体importは壊れない。
import { hasNeverBuiltWalls } from '../wallRefresh.js';
import { loadMaterialMap, preloadWallRegenerationModules } from '../finish/wallRegeneration.js';
// centerLineFloorSync.js は静的importする（段階(g)・QA指摘m-3・2026-09-26。旧コメント「IndexedDBに
// 連鎖するためnode:testからの単体importを壊さないよう動的importにする」は、centerLineOps.jsが既に
// wallBeamAxes.js→structuralPeek.js経由でFloorSwapManager.js・storage/db.jsを静的に引いている
// （＝centerLineFloorSync.js自身が使うsaveFloorの既定値と同じ依存）ため成り立たない——
// commitCLMoveOp（非梁芯分岐）の静的importが単体import・フルスイート・buildいずれも無問題だった
// （段階(g)で実測済み）ことから、他の呼び出し元（旧・動的import）も静的に統一できる）。
import {
  applyFloorUndoRecords, rollbackFloorRecords,
  detachOtherFloorsFromGridCenterLine, applyOtherFloorsGridCenterLineAftermath,
  saveOtherFloorsAfterGridCenterLineAftermath,
  findFloorsWithCounterpartCL, findFloorsWithSameLineId, absorbWallBeamAxesOnPromote,
  findCenterLinesToAbsorbOnPromote, applyCenterLineAbsorptionOnPromote,
  findCenterLinesToAbsorbForValues, applyCenterLineAbsorptionForValues,
  propagateDemotedCenterLine, findFloorsBlockingGridDeletion, applyCenterLineRemovalAftermath,
} from './centerLineFloorSync.js';
// 降格（通り芯→中心線）で固定材（非auto）が確認済みで削除されるとき用（手動追加材サイレント撤去回避
// 指示書§5ステップ4）。fixedMemberRefs.jsはcenterLineFloorSync.js（otherPlanes）をimportするが、
// centerLineOps.js自身はfixedMemberRefs.jsをimportしない（このimportがそれ）ため、ここから
// fixedMemberRefs.jsをimportしても循環にならない（fixedMemberRefs.js冒頭コメント参照）。
import { removeFixedMembersReferencing } from '../structural/fixedMemberRefs.js';

// CL削除・中心線移動の直後・undo/redo直後に構造同期（structural/structuralSync.js）を起動するための
// 依存注入フック（App.jsxがsetOpeningGeometryListenerと同じ作法で設定する）。未設定（構造モジュール
// 未配線のテスト等）では何もしない。centerLineOps.js自身は構造同期モジュールをimportしない——
// 起動は依存注入だけで結ぶ（openings/openingEdit.jsのsetOpeningGeometryListenerと同じ理由。
// node:testからの単体import可能性・循環import回避）。
let structuralSyncListener = null;
export function setCenterLineStructuralListener(fn) { structuralSyncListener = fn; }

// 段階(c)・2026-09-25: addCenterLineFromDialogの4箇所のundoManager.pushを寄せる非公開ヘルパー。
// scopeがnull（補助線・専用経路の梁芯）ならnotifyは何もしない。確定直後・undo・redoのそれぞれで
// 1回ずつnotifyする（commitCLMoveOpと同じ「確定・undo・redoの3点で呼ぶ」規約）。
// 段階(g)・2026-09-26: floorRecords（この関数内で新設。「配列を持たない3か所」の1つ）を確定時の
// notifyだけに渡し、構造同期が非アクティブ階・屋根へ書いたバイトの前後を受け取れるようにする。
// undo/redoクロージャは、その配列をapplyFloorUndoRecordsで戻してからnotify（undoRecords省略＝
// 再同期はするが記録はしない）。
function pushUndoWithStructuralSync(graph, project, scope, undoFn, redoFn, saveFloorFn) {
  const floorRecords = [];
  const notify = (records) => { if (scope) structuralSyncListener?.(graph, project, scope, records); };
  const entry = undoManager.push(
    () => { undoFn(); applyFloorUndoRecords(project, floorRecords, 'before', saveFloorFn); notify(); },
    () => { redoFn(); applyFloorUndoRecords(project, floorRecords, 'after', saveFloorFn); notify(); },
  );
  notify(floorRecords);
  return entry;
}

// CL の pendingDelta を実座標に bake する（ref CL / 通常 CL 両対応）
export function bakeCLValue(cl, newVal) {
  // refIdはあるが未解決（_referencedCL無し）なら、はね出し追従が成立していないため
  // refOffsetを書いても黙って捨てられる（core/centerLine.js get value()は未解決時に
  // refOffsetを足さない＝案A）。この場合はvalue（=_value。絶対座標）を直接書く。
  if (cl.refId && cl._referencedCL) {
    cl.refOffset = newVal - cl._referencedCL.value;
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
// @param {object} [opts] - opts.saveFloorFn はテスト用の差し替え（既定はcenterLineFloorSync.js側の
//   saveFloor。段階(g)・2026-09-26。非梁芯分岐でのみ使う——梁芯分岐は他階を書かないため無関係）。
//   opts.belowGraph（ステップ6）は開口由来梁芯の追従（規則O）が「下階に到達元の階段があるか」の
//   判定に使う1つ下の実体階のgraph——省略時はnull扱い（同期関数のためここではpeekしない。
//   階段由来の開口はこの経路では追従されず、次のモード境界再計算のreconcileOpeningBeamAxesが
//   撤去→再生成する。受容する限界）。非梁芯分岐でのみ使う。
// @returns {{ toast: string|null }}
export function commitCLMoveOp(graph, project, cl, originalValue, opts = {}) {
  const newValue = cl.effectiveValue;
  if (newValue === originalValue) {
    runInAction(() => { cl.pendingDelta = 0; });
    return { toast: null };
  }

  if (centerLineKind(cl) !== 'beam') {
    // 段階(b)/(c)・2026-09-25: 中心線・通り芯の移動でも構造同期を起動する（種別ポリシー
    // structuralSyncScopeOfKind経由——「操作×種別」の専用表は作らず、削除・追加・変換と同じ表を使う。
    // 通り芯（struct）は'all'、中心線（center）は'activeAndAbove'、補助線・梁芯自身の移動はnull＝
    // 起動しない（補助線は段階(d)）。同じundoエントリで壁由来梁芯（discipline:fuse）を移動分だけ
    // 追従させる（followWallBeamAxes。仕上げモード脱出時の壁再生成＝wallRefresh.js と同じ手順で、
    // 専用の再計算経路を持たない「軽い」移動確定にも同じ追従を効かせる）。通り芯移動は壁が全階で
    // 参照追従する（Wall.backingRangeはaxisCL.effectiveValueから都度計算されるため、他階もpeek時に
    // structGraphから解決される）が、梁芯追従自体は自階のみ——通り芯の座標には重複ガードで梁芯が
    // 生成されないため、実際に追従するのは偏芯壁（backingOffset≠0）の梁芯と、この通り芯をrefId参照
    // する子中心線が乗る壁の梁芯だけ。他階の梁芯・自階で「下階の壁が根拠」の梁芯は追従しない——
    // 削除と同じ「他階・下階由来の孤児梁芯は段階(g)まで許容」の裁定の範囲（R1）。
    // scopeはstructuralSyncScopeForCenterLine（段階(d)・2026-09-25）——cl自身の種別ポリシーに加え、
    // clをextentLoRef/extentHiRef・refIdで参照している他CLの種別のscopeも合成する。補助線（aux）は
    // 自身のscopeはnullだが、それを参照する中心線があれば'activeAndAbove'になる——参照先を動かすと
    // 参照元中心線のextentが追従するため（bake前＝現在の参照関係で算出する）。
    const scope = structuralSyncScopeForCenterLine(graph, cl);
    // 段階(g)・2026-09-26: floorRecords（この関数内で新設。「配列を持たない3か所」の1つ）を確定時の
    // notifyだけに渡す（undo/redoクロージャはapplyFloorUndoRecordsで戻してから記録なしで再同期する）。
    const floorRecords = [];
    const notify = (records) => structuralSyncListener?.(graph, project, scope, records);
    // wallBackingCenters（wallBackingCenterCoord経由）はaxisCL.effectiveValue（=value+pendingDelta）を
    // 読むため、bakeCLValueで未確定のまま素直に呼ぶと「まだ確定していないドラッグ後の壁位置」を
    // 返してしまう（ドラッグ中プレビューがeffectiveValueを見る設計と同じ理由。実装時に実測で確認した
    // 食い違い——設計書の記述はbake前のCLがまだ旧位置にある前提だった）。pendingDeltaだけを一時的に0へ
    // 戻し「確定済みの旧座標（=value=originalValue）」を読ませてから元に戻す（_valueは触らない。
    // runInAction 1本にまとめ、MobXへ中間状態を観測させない）。
    // 開口由来梁芯の追従（ステップ6の3）: 主構造が規則O対象（openingBeamAxes:'slabOpenings'）の
    // ときだけ、壁由来と同じ手順（bake前後のopeningBeamSourcesForを突き合わせ、followWallBeamAxesへ
    // 1本化して渡す）で追従させる。belowGraphはopts.belowGraph（省略時null）——commitCLMoveOpは
    // 同期関数のためここでpeekできない。belowGraphが無いと「下階に到達元の階段があるか」
    // （stairFilterFor）が常にfalseになり、階段由来の開口はここでの追従対象から外れる——
    // その梁芯は次のモード境界再計算のreconcileOpeningBeamAxesが「撤去→再生成」する（idは変わる。
    // 受容する限界（ステップ9で.claude/cl-conversion-limits.mdに追記予定・m-6是正）。
    const openingRules = scope ? rulesFor(effectiveStructure(graph, project)) : null;
    const collectOpeningMoves = !!openingRules && openingRules.openingBeamAxes === 'slabOpenings';
    const openingSourcesOpts = { riserOf: (s) => stairRiserOf(s, project, graph.plane), belowGraph: opts.belowGraph ?? null };

    let backingBefore = null;
    let openingBefore = null;
    if (scope) {
      runInAction(() => {
        const savedDelta = cl.pendingDelta;
        cl.pendingDelta = 0;
        try {
          backingBefore = wallBackingCenters(graph);
          if (collectOpeningMoves) openingBefore = openingBeamSourcesFor(graph, project, openingSourcesOpts);
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

    // 壁由来梁芯・開口由来梁芯の追従はbake・結合の**後**に行う（結合で軸CLが変わりうるため、
    // 追従前後のスナップショットは常に確定済みの位置から採る）。両者の move を1本化して
    // followWallBeamAxes（由来を問わず座標一致だけで梁芯を探す）へ渡す——追従先の重複吸収（案B）も
    // 由来を問わず共通に効く。
    const backingMoves = scope ? mapBackingCenterMoves(backingBefore, wallBackingCenters(graph)) : [];
    const openingMoves = collectOpeningMoves
      ? mapOpeningSourceMoves(openingBefore, openingBeamSourcesFor(graph, project, openingSourcesOpts)) : [];
    // repointRefsFrom:true（ステップ6・設計§3後段）——この呼び出しだけが開口由来梁芯の追従moves
    // （openingMoves）を持ちうるため、吸収時に短辺のextentLoRef/HiRefを吸収先へ張り替える。
    // 壁のみの追従（finishBoundary.js・wallRefresh.js・偏芯分岐）は既定のfalseのまま。
    const axis = scope ? followWallBeamAxes(graph, [...backingMoves, ...openingMoves], { repointRefsFrom: true }) : null;

    const [undoFn, redoFn] = composeUndoWithMergeChain(
      () => bakeCLValue(cl, originalValue),
      () => bakeCLValue(cl, newValue),
      chainResult,
    );
    undoManager.push(
      () => {
        runInAction(() => { [...(axis?.undoFns ?? [])].reverse().forEach(f => f()); undoFn(); });
        if (scope) { applyFloorUndoRecords(project, floorRecords, 'before', opts.saveFloorFn); notify(); }
      },
      () => {
        runInAction(() => { redoFn(); axis?.redoFns.forEach(f => f()); });
        if (scope) { applyFloorUndoRecords(project, floorRecords, 'after', opts.saveFloorFn); notify(); }
      },
    );
    if (scope) notify(floorRecords);
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
    // 開口由来（規則O）の梁芯を手動で動かしたら由来をUSERへ切り替える（ステップ6・設計§2）——
    // 再計算時の照合（reconcileOpeningBeamAxes）は「開口の位置に無い開口由来梁芯」を孤児とみなすため、
    // 手動移動を区別する印が要る。壁由来（WALL）はソース差分方式（wallBeamAxisFollow.js）が手動移動を
    // 誤認しないため、由来は変えない。before/afterのグラフスナップショット方式でundo/redoに乗る。
    if (cl.beamAxisOrigin === BeamAxisOrigin.OPENING) cl.beamAxisOrigin = BeamAxisOrigin.USER;
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

// ---- CL偏芯の確定（EccentricityDialog onConfirm。段階(e)・2026-09-26）----
// 偏芯の適用（finish/clEccentricity.js applyCLEccentricity）・自階の壁由来梁芯の追従
// （structural/wallBeamAxisFollow.js followWallBeamAxes。commitCLMoveOpと同じ手順）・他階連動
// （finish/eccentricityFloorSync.js propagateCLEccentricities。階段・吹抜けの連動先へレコードを
// 複製）を1つのundoエントリにまとめ、最後に構造同期（structural/structuralSync.js）を起動する。
// amendは使わない——自階を先に変更してから他階連動をawaitする構造のため、失敗時は自階を含めて
// 巻き戻す必要があり、deleteCenterLineWithUndo（通り芯分岐）と同じ「自前でundo/redoクロージャを
// 組む」型にする（undoManager.amendは既に積まれたエントリへの合成しかできないため、自階側の
// 巻き戻しまでは面倒を見られない）。
// applyFn／propagateFn はテスト用の差し替え口（既定は動的importの実体）。finish/clEccentricity.js・
// finish/eccentricityFloorSync.js は依然として動的import——centerLineFloorSync.jsと違い、
// centerLineOps.jsが既に静的に引いている依存（wallBeamAxes.js経由のFloorSwapManager.js・
// storage/db.js）とは別系統のため、静的importで安全か未検証（QA指摘m-3の範囲外。段階(g)・2026-09-26）。
// @param {object} [opts]
// @param {object|null} [opts.rec] - 偏芯レコード（null/undefined＝解除）
// @param {Map} [opts.materialMap]
// @param {Function} [opts.saveFloorFn] - テスト用の差し替え（既定はcenterLineFloorSync.js側のsaveFloor）
// @param {Function} [opts.applyFn] - テスト用の差し替え（既定はfinish/clEccentricity.js applyCLEccentricity）
// @param {Function} [opts.propagateFn] - テスト用の差し替え（既定はfinish/eccentricityFloorSync.js propagateCLEccentricities）
// @returns {Promise<{ toast: null }>}
export async function applyCLEccentricityWithUndo(graph, project, cl, opts = {}) {
  const { rec, materialMap, saveFloorFn } = opts;

  // 1. 動的importをすべて先に済ませる（finish/clEccentricity.js・finish/eccentricityFloorSync.jsの
  // 実体。centerLineFloorSync.jsのapplyFloorUndoRecords／rollbackFloorRecordsは段階(g)・QA指摘m-3で
  // 静的importへ統一済み——ファイル冒頭のimportを参照）。この関数の途中でawaitを挟むたびに動的import
  // を跨ぐと、テスト用の差し替え（applyFn/propagateFn）と実体のimportタイミングが混ざって読みにくく
  // なるため、残る2つも先に済ませる。
  const { applyCLEccentricity } = await import('../finish/clEccentricity.js');
  const { propagateCLEccentricities } = await import('../finish/eccentricityFloorSync.js');
  const applyFn = opts.applyFn ?? applyCLEccentricity;
  const propagateFn = opts.propagateFn ?? propagateCLEccentricities;

  // 2. scopeはstructuralSyncScopeForCenterLine（段階(d)）——通り芯='all'、中心線='activeAndAbove'。
  // 偏芯は内壁指定CL（isFinishCellDivider）にしか付かないため、実務上は補助線・梁芯には来ない
  // （UIからは到達不能。スコープ判定自体はCL種別を問わず同じ表を使う——「操作×種別」の専用表は作らない）。
  const scope = structuralSyncScopeForCenterLine(graph, cl);

  // 早期ガード（QA指摘m-2・2026-09-26）: 呼び出し側（App.jsx handleEccConfirm）はwhenIdle()を
  // 待ってからこの関数を呼ぶが、そのawaitの間にhistoryナビゲーション等でアクティブ階が切り替わって
  // いる可能性がある——他のCL操作（deleteCenterLineWithUndo等）のM-2ガードと同じ理由。何も書き換える
  // 前（手順3のserializeGraphより前）に検出すれば、rollbackFloorRecordsを呼ぶまでもなく即toast:null
  // で戻れる。
  if (graph !== project.activeGraph) return { toast: null };

  // 3. beforeは偏芯適用前のスナップショット。backingBeforeは壁由来梁芯の追従用（wallBackingCenters
  // はwall.axisOffset/backingOffset等の確定値を読むため、CL移動時のようなpendingDeltaの退避は不要）。
  const before = serializeGraph(graph);
  const backingBefore = scope ? wallBackingCenters(graph) : null;

  // 4. 偏芯レコードの更新→フル再計算の適用（毎回冪等。finish/clEccentricity.js参照）。
  runInAction(() => {
    if (rec) graph.setCLEccentricity(cl.id, rec);
    else     graph.removeCLEccentricity(cl.id);
    applyFn(graph, cl.id, { materialMap });
  });

  // 5. 壁由来梁芯の追従はapplyFnの**後**に行う（backingOffset確定後の帯中心で比較するため）。
  if (scope) followWallBeamAxes(graph, mapBackingCenterMoves(backingBefore, wallBackingCenters(graph)));

  // 6. after。追従した梁芯の値・excludedWallBeamAxesの張り替えはどちらもserializeGraphに含まれる
  // （graphSnapshot.js参照）ため、followWallBeamAxesの戻り値（undoFns/redoFns）は使わない——
  // 全体をbefore/afterのフルスナップショットで往復させる（commitCLMoveOpの個別合成とは違う型）。
  const after = serializeGraph(graph);

  // 7. 他階連動（階段・吹抜け）。失敗時は保存済みの階＋自階（before）を巻き戻して再throwする
  // （自階は既に4.でrunInAction変更済みのため、floorRecordsに含まれない自階分も明示的に足す）。
  const floorRecords = [];
  try {
    await propagateFn(project, graph, [cl.id], { materialMap, undoRecords: floorRecords, saveFloorFn });
  } catch (e) {
    await rollbackFloorRecords([...floorRecords, { planeId: graph.plane.id, before }], saveFloorFn, project);
    throw e;
  }

  // 8. await（IDB書込を伴う他階連動）の間に階が切り替わった可能性を再評価する（他のCL操作の
  // M-2ガードと同型）。切り替わっていれば自階を含めて巻き戻し、undoは積まずnotifyもしない。
  if (graph !== project.activeGraph) {
    await rollbackFloorRecords([...floorRecords, { planeId: graph.plane.id, before }], saveFloorFn, project);
    return { toast: null };
  }

  // 9. 他階へ連動した（吹抜け直下階の壁も変わりうる）場合はsyncScopeを'all'へ引き上げる。
  // scopeがnull（補助線。UIからは到達しない防御的分岐）ならfloorRecordsの有無に関わらずnullのまま
  // （notifyしない）——'all'への引き上げは「scopeがそもそも構造同期対象のとき」だけ意味を持つ。
  const syncScope = (scope && floorRecords.length > 0) ? 'all' : scope;
  const notify = (records) => { if (syncScope) structuralSyncListener?.(graph, project, syncScope, records); };

  // 10-11. amendは使わない（自階の復元→他階レコード適用→notifyの順序を自分で制御するため）。
  undoManager.push(
    () => {
      restoreGraph(graph, before);
      applyFloorUndoRecords(project, floorRecords, 'before', saveFloorFn);
      notify();
    },
    () => {
      restoreGraph(graph, after);
      applyFloorUndoRecords(project, floorRecords, 'after', saveFloorFn);
      notify();
    },
  );
  notify(floorRecords);
  return { toast: null };
}

// ---- CL削除（メニューの cl-del）----
// 通り芯（isGridCenterLine＝labeled かつ種別struct）は structGraph 経由でスナップショット方式のUndo、
// それ以外（中心線・補助線・梁芯）は excludedWallBeamAxes 記録（梁芯のみ）＋removeCenterLine。
// 呼び出し側（App.jsx handleDeleteCenterLine）はメニューを閉じる等の setState を行う。
// 戻り値 {toast}: 通り芯側のみ拒否がありうる（軸最後の1本）ため、promoteCenterToGridWithUndo等の
// 変換系と同じ {toast: string|null} 契約に揃える——呼び出し側は toast があればトースト表示するだけでよい。
//
// 通り芯削除は他階（検討・屋根を含む）への detach 伝播・後始末（transform/centerLineFloorSync.js
// detachOtherFloorsFromGridCenterLine・applyOtherFloorsGridCenterLineAftermath。IDB読み書きを
// 伴う）と、構造同期（structural/structuralSync.js。
// setCenterLineStructuralListener経由の依存注入）を伴うため async 化した（案P・2026-09-25裁定。
// 非通り芯分岐にIDB・構造同期は無いが、関数全体をasyncにする機械的な波及を受ける）。
// centerLineFloorSync.jsは静的import（段階(g)・QA指摘m-3。ファイル冒頭のimport参照——旧「動的import
// でnode:testからの単体import可能性を保つ」は既に成り立たない）。
// @param {object} [opts] - opts.saveFloorFn はテスト用の差し替え（既定値はcenterLineFloorSync.js側のsaveFloor）。
//   opts.loadMaterialMapFn／opts.peek はステップ3（自階の壁再生成。wallRefresh.js refreshWallsForGraph）用の
//   テスト差し替え（既定値はそれぞれ finish/wallRegeneration.js の loadMaterialMap・
//   structuralPeek.js peekVia(undefined,…)＝floorSwapManager.peek直呼び）。opts.peekBelow は既存どおり
//   壁由来梁芯の道連れ削除（selfAndBelow）用の1つ下の実体階peek差し替え。opts.regenerateWallsFn は
//   wallRefresh.js refreshWallsForGraph へそのまま渡すテスト差し替え（既定は finish/wallRegeneration.js
//   の regenerateWalls。変更後の区間で例外が起きた場合の巻き戻しを検証する注入口。QA指摘H1のテスト9）。
//   opts.preloadWallRegenerationModulesFn は finish/wallRegeneration.js の
//   preloadWallRegenerationModules のテスト差し替え（モジュール事前読込みの失敗を再現する。QA指摘M1'）。
// resolveStairContext（finish/stair/stairUnderRooms.js :102-106）が必要とする「1つ下の実体階」を、
// structural/wallBeamAxes.js の belowPlaneOf（QA指摘9是正・2026-09-27でexport済み）で求める
// （壁再生成に必要な下階peekを変更前に前倒しするための算出だけに使う——実際のpeek自体はcachedPeek
// 経由で行う）。旧belowPlaneOfProject（同じ3行の重複実装）はここから削除し、belowPlaneOfへ一本化。

// ---- in-flight 追跡（QA指摘M・2026-09-27）----
// deleteCenterLineWithUndo の実行中、store.js switchFloor が floorSwapManager.swap
// （対象階の graph を IDB へ保存してから graph.clearFloorData() で空にする処理を含む）を挟むと、
// 削除処理が「後で書き戻すために握っていたbefore/beforeArchスナップショット」の復元先を
// 失う（クリア済みの非アクティブ graph に書くだけになり、戻った階ではCLが消えたままundoも無い。
// QA実測）。structuralSync.whenIdle()と同じ形（busyカウント＋idleResolvers配列）で追跡し、
// store.js switchFloor の冒頭が await して待ち合わせる（centerLineOps.js→store.js の逆方向
// importは禁止のため、store.js側からこちらをimportする一方向）。
let inFlightCount = 0;
let idleResolvers = [];

function beginCenterLineOp() { inFlightCount++; }

function endCenterLineOp() {
  inFlightCount--;
  if (inFlightCount === 0) {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/**
 * transform/centerLineOps.js のCL操作（現状は deleteCenterLineWithUndo のみ）が実行中なら、
 * その完了（成功・失敗いずれも）を待つPromiseを返す。実行中でなければ即座に解決済み
 * （structuralSync.whenIdle()と同じ形）。store.js switchFloor が階切替の直前に呼ぶ。
 * @returns {Promise<void>}
 */
export function whenCenterLineOpsIdle() {
  if (inFlightCount === 0) return Promise.resolve();
  return new Promise(resolve => { idleResolvers.push(resolve); });
}

/**
 * cl が今なお削除可能な状態か（App.jsx handleDeleteCenterLine の2段目runBusy専用の再検証。
 * 手動追加材サイレント撤去回避 指示書§5ステップ3・QA指摘）。固定材の事前確認ダイアログ表示中は
 * 関門（uiBusy.js runBusy）を開けておく必要があるため、その間にundo/redo・階切替が割り込みうる
 * ——2段目のrunBusy（whenIdle()の後・runDeleteCenterLine呼び出しの前）でこの関数を呼び、falseなら
 * グラフ・undoに一切触れず中止する。判定は本ファイル内の既存の階切替・CL消失再評価（例: 通り芯削除
 * 分岐のL485付近・非struct分岐のL768付近）と同じ形——graphが今もアクティブか、clを所有するグラフ
 * （通り芯=全階共有=project.structGraph、それ以外（中心線・補助線・梁芯）=階固有=graph自身）の
 * shapeMapに同一参照のまま残っているか。
 * 降格（App.jsx handleConvertCenterLineの2段目runBusy。§5ステップ4）でも同じ理由・同じ判定内容
 * （削除固有の判定は含まない）でそのまま流用する。
 * @param {object} project
 * @param {import('@core').PlanGraph} graph 削除を試みた時点の自階グラフ（呼び出し側のクロージャに閉じ込めた値）
 * @param {import('@core').CenterLine} cl
 * @returns {boolean}
 */
export function isCenterLineStillDeletable(project, graph, cl) {
  if (graph !== project.activeGraph) return false;
  const owningGraph = isGridCenterLine(cl) ? project.structGraph : graph;
  return owningGraph.shapeMap.get(cl.id) === cl;
}

// @returns {Promise<{ toast: string|null }>}
export async function deleteCenterLineWithUndo(graph, project, cl, opts = {}) {
  // beginCenterLineOp/endCenterLineOpは例外でも必ず対で呼ぶ（finally）——whenCenterLineOpsIdleの
  // 待ち手を永久に待たせないため。実処理は runDeleteCenterLineWithUndo に委譲する（薄いラッパー）。
  beginCenterLineOp();
  try {
    return await runDeleteCenterLineWithUndo(graph, project, cl, opts);
  } finally {
    endCenterLineOp();
  }
}

async function runDeleteCenterLineWithUndo(graph, project, cl, opts = {}) {
  const isStruct = isGridCenterLine(cl);

  // CL削除ステップ3: 自階の壁をこの削除に限り明示的に作り直す（新ルール1「壁再生成」）。
  // wallFreshnessKey はCL位相（部屋の分割/併合）を入力に含まないため、削除の前後で鍵が一致した
  // ままになりうる——refreshWallsForGraph を force:true で呼ぶ（wallRefresh.js JSDoc参照）。
  // getMaterialMap・peek は refreshWallsAllFloors と同じ型のテスト差し替え口（opts.loadMaterialMapFn／
  // opts.peek。既定値はそれぞれ finish/wallRegeneration.js の loadMaterialMap・structuralPeek.js
  // peekVia(undefined,…)＝floorSwapManager.peek直呼び）。opts.peekBelow は既存どおり壁由来梁芯の
  // 道連れ削除（selfAndBelow）用の1つ下の実体階peek差し替え。
  //
  // QA指摘H1/H2/M1是正（2026-09-27）・M1'是正（同日再指摘）: 壁再生成に必要な実I/Oは、
  // 削除・detach・後始末が確定する**前**（変更前のawaitゾーン）で完了させる——変更後
  // （後始末→壁再生成→道連れ削除→after採取）のawaitに新規の実I/Oを持ち込まない。対象は
  // (1) materialMap取得、(2) resolveStairContext用の下階peek（下記peekのメモ化キャッシュを
  // 変更前に温める）、(3) regenerateWallsが動的importする2モジュール（edgeComposition.js・
  // clEccentricity.js。本番ビルドでは別チャンクのためネットワーク取得を伴いうる——
  // preloadWallRegenerationModules）。conformWoodBacking・followWallBeamAxesは同期関数で
  // 対象外。(1)〜(3)を変更前にまとめて済ませても「変更後は実I/Oが絶対に無い」とは言い切れない
  // （将来regenerateWalls自身が変更されうる・想定外の分岐がありうる）ため、加えて
  // refreshWallsForGraphのawait直後に階切替・CL消失を検知する防御（下記M1'-b）も置く——
  // 前倒しは「起きにくくする」対策、await直後の再評価は「起きても壊れない」対策として両方持つ。
  // peek はメモ化ラッパー（plane id → 取得済み graph の Promise。refreshWallsAllFloorsの
  // materialMapメモ化と同型）にし、opts.peekが素通りでも二重に同じ階へ実peekしないようにする。
  const loadMaterialMapFn = opts.loadMaterialMapFn ?? loadMaterialMap;
  let materialMapPromise = null;
  const getMaterialMap = () => (materialMapPromise ??= loadMaterialMapFn());
  const preloadWallRegenerationModulesFn = opts.preloadWallRegenerationModulesFn ?? preloadWallRegenerationModules;
  const basePeek = opts.peek ?? ((plane, structGraph) => peekVia(undefined, plane, structGraph));
  const peekCache = new Map(); // planeId -> Promise<graph|null>
  const peek = (plane, structGraph) => {
    if (!peekCache.has(plane.id)) peekCache.set(plane.id, basePeek(plane, structGraph));
    return peekCache.get(plane.id);
  };
  // materialMap取得と(3)のモジュール事前読込を1つの結果へまとめる（willRegenerateWallsのときだけ
  // 呼ぶ。失敗はERR_CATALOG_DUPLICATEなら再throw、それ以外はERR_CL_DELETE_WALLS_UNAVAILABLEで
  // 拒否——struct分岐・非struct分岐の両方で共有する）。
  const makeWallRegenPrereqTask = (willRegenerateWalls) => (willRegenerateWalls
    ? Promise.all([getMaterialMap(), preloadWallRegenerationModulesFn()])
        .then(([materialMap]) => ({ ok: true, materialMap }))
        .catch(error => ({ ok: false, error }))
    : Promise.resolve({ ok: true, materialMap: null }));

  if (isStruct) {
    // 軸最後の通り芯は削除できない（ユーザー要望。中心線化ガードERR_CL_CONVERT_LAST_GRIDと同じ
    // isLastGridOnAxis判定を共有——二重実装によるズレを防ぐ。UI側の長押しメニューのグレー化
    // （interaction/usePointerInteraction.js・menuItems.js）はこの防御ガードの多層防御であり、
    // グレー化を回避して呼ばれても最終的にここで拒否される）。isStruct成立後は向き（V/H/RADIAL）を
    // 問わず呼ぶため、RADIALの通り芯に対しても呼ばれうるが、実際にはUIから到達不能
    // （centerLineConvert.test.jsの【到達不能経路・軸選択の正常化】参照）。
    if (isLastGridOnAxis(graph, cl)) return { toast: ERR_CL_DELETE_LAST_GRID };
    // フットプリント境界削除ガード（第1段階）: 自階でこの通り芯が外壁線を担っていれば即拒否
    // （detach・detachOtherFloorsFromGridCenterLineより前。centerLineConvert.js isFootprintBoundaryCL参照）。
    if (isFootprintBoundaryCL(graph, cl)) return { toast: ERR_CL_DELETE_FOOTPRINT };
    // 復元不能セルガード（ステップ2）: 自階の部屋セル・スラブセルのうち、この通り芯を失うと
    // 対辺2本同時喪失になるもの、または再解釈除外部屋（階段・階段吹抜け・未定義・昇降路）のセル辺が
    // この通り芯を持つものが1つでもあれば拒否する（finish/roomReinterpret.js
    // findUnresolvableCells。フットプリント境界ガードと同格——detach・他階伝播より前に判定する）。
    if (findUnresolvableCells(graph, cl.id).length > 0) return { toast: ERR_CL_DELETE_UNRESOLVABLE };

    // 他階（検討・屋根含む）でもフットプリント境界・復元不能セルになっていないか確認する（副作用の
    // 無い読み取りのみ。centerLineFloorSync.js findFloorsBlockingGridDeletion。ステップ4・ルール2:
    // 復元不能セル判定（他階版findUnresolvableCells）も同じpeekへ統合——別関数にすると他階を2回
    // peekすることになる）。実際の伝播（detachOtherFloorsFromGridCenterLine）より前に行う——N5と同じ
    // 「先に判定・失敗するなら書き込まない」規律。
    const blockingFloors = await findFloorsBlockingGridDeletion(project, graph, cl);
    // 他階peekのawait中に階が切り替わった・この通り芯自体が消えた可能性を再評価する
    // （非struct分岐のneedsBelowPeekガードと同型。副作用が無い読み取りのためrollbackFloorRecordsは
    // 不要——floorRecordsはまだ何も積んでいない）。
    if (graph !== project.activeGraph || project.structGraph.shapeMap.get(cl.id) !== cl) {
      return { toast: null };
    }
    if (blockingFloors.footprintPlanes.length > 0) return { toast: ERR_CL_DELETE_FOOTPRINT };
    if (blockingFloors.unresolvablePlanes.length > 0) return { toast: ERR_CL_DELETE_UNRESOLVABLE };

    // resolveStairContext用の1つ下の実体階をpeekする（非struct分岐のbelowPlaneForStairsと同じ理由）。
    // QA指摘H1/H2/M1/M1'是正: struct分岐は壁を持つ限り常に壁再生成の対象（canCarryWalls相当が
    // 常にtrue）のため、壁を一度も持っていない階（hasNeverBuiltWalls）でなければ、materialMap
    // 取得・モジュール事前読込み（makeWallRegenPrereqTask）・resolveStairContext用の下階peek
    // （cachedPeekのウォームアップ）も同じawaitゾーンにまとめる。ステップ4・ルール2是正: 他階にも
    // 壁再生成が要る階がある（blockingFloors.anyOtherFloorNeedsWallRegen）場合もここでmaterialMapを
    // 要求する——他階の後始末（applyOtherFloorsGridCenterLineAftermath内。変更後の区間）が新規に
    // materialMapを読みに行かないようにするため（team-lessons「変更確定後に挟んだ非同期処理」参照）。
    // 自階のwallBeamSourcesFor用「1つ下の実体階」のpeek（QA指摘5是正・2026-09-27）はここでは行わない
    // ——detachOtherFloorsFromGridCenterLineが他階と同じpeekキャッシュから解決する（下階が他階の1つと
    // 重なっていても、どの階もdetachしていない一貫した値になるようにするため）。opts.peekBelowは
    // 同関数へそのまま渡す（従来どおりのテスト差し替え契約を維持）。
    const willRegenerateWalls = !hasNeverBuiltWalls(graph) || blockingFloors.anyOtherFloorNeedsWallRegen;
    const belowPlaneForStairs = !hasNeverBuiltWalls(graph) ? belowPlaneOf(graph.plane, project) : null;
    const [, wallRegenPrereq] = await Promise.all([
      belowPlaneForStairs ? peek(belowPlaneForStairs, project.structGraph) : Promise.resolve(null),
      makeWallRegenPrereqTask(willRegenerateWalls),
    ]);
    // 下階peek・materialMap取得のawaitを新たに挟んだため、同じ再評価をもう一度行う。
    if (graph !== project.activeGraph || project.structGraph.shapeMap.get(cl.id) !== cl) {
      return { toast: null };
    }
    // materialMap取得・モジュール事前読込みの失敗（QA指摘H2・M1'）: ERR_CATALOG_DUPLICATEは
    // 合成後例外のため握りつぶさず再throw（wallRefresh.js既存の扱いと同じ）。それ以外
    // （IDB読込失敗・チャンク取得失敗等）は、まだ何も変更していない段階で拒否する——壁を作り
    // 直せないまま削除だけ通すと、壁がdetachで切られたまま再生成されない事故になる。
    if (!wallRegenPrereq.ok) {
      if (wallRegenPrereq.error?.code === ERR_CATALOG_DUPLICATE) throw wallRegenPrereq.error;
      return { toast: ERR_CL_DELETE_WALLS_UNAVAILABLE };
    }
    const materialMap = wallRegenPrereq.materialMap;

    // 案P（採用）: 他階の detach を削除の前に行う（降格の「複製→移籍」と同じ型）。通り芯が
    // project.structGraph に残っている間に他階を peek しないと、他階の壁の axisCL/clStart/clEnd が
    // graphSnapshot.js の resolveCL で解決できず、復元時に黙って捨てられる
    // （detachOtherFloorsFromGridCenterLine のJSDoc・2026-09-17実測の教訓）。まだ何も保存していない
    // 段階（フェーズ1）のため、例外はそのまま素通しでよい（N5と同じ「先に判定・失敗するなら
    // 書き込まない」規律）。selfのbelowGraph/sourcesBeforeも同じフェーズ1の返り値から受け取る
    // （QA指摘5是正——他階と同じpeekキャッシュ・同じdetach前タイミングで採る）。
    const { contexts: otherFloorContexts, orphanOnly: orphanOnlyContexts, self: selfWallBeamInfo } = await detachOtherFloorsFromGridCenterLine(
      project, graph, cl, { peekBelow: opts.peekBelow },
    );
    const { belowGraph: selfBelowGraph, sourcesBefore: selfSourcesBefore } = selfWallBeamInfo;

    // 他階peek・detach（IDB読み込みを伴うawait）の間に、階が切り替わった・この通り芯自体が消えた・
    // 軸最後の1本になった可能性を再評価する（await前の同期ガードだけでは足りない——N5とは逆に、
    // ここは非同期処理を挟んだ「後」に再評価する）。階切替（graph!==project.activeGraph）を
    // チェックするのは、この間にユーザー操作やhistoryナビゲーションでアクティブ階が変わりうるため
    // ——切り替わった後に自階（もう非アクティブになったgraph）を書き換えるのは誤り（M-2・QA指摘）。
    // まだ何も保存していないため rollbackFloorRecords は不要。
    if (graph !== project.activeGraph || project.structGraph.shapeMap.get(cl.id) !== cl) {
      return { toast: null };
    }
    if (isLastGridOnAxis(graph, cl)) return { toast: ERR_CL_DELETE_LAST_GRID };
    // F5（QA指摘）: 他階のdetach（IDB書込を伴うawait）の間に自階のフットプリント・セル構成が
    // 変わりうるため（並行編集・他の非同期処理の割り込み）、フットプリント境界ガード・復元不能セル
    // ガードも同じ場所で再評価する——isLastGridOnAxisの再評価と同型（await前の同期ガードだけでは
    // 足りない。「判定不能の持ち越しは認めない」方針）。
    if (isFootprintBoundaryCL(graph, cl)) return { toast: ERR_CL_DELETE_FOOTPRINT };
    if (findUnresolvableCells(graph, cl.id).length > 0) return { toast: ERR_CL_DELETE_UNRESOLVABLE };

    // 通り芯の削除 — structGraph をスナップショット経由で Undo。
    // structGraph の teardown は階グラフの図形に届かないため、アクティブ階グラフ側の
    // 壁端・extent 参照を先に切り離し（端点ルール）、続けて自階の柱・梁・基礎等（この通り芯に
    // dangling 参照のまま残る部材）も撤去する（removeDependentsOfCenterLine。段階(a)の主目的——
    // 従来は detachFromCenterLine のみで、袖柱・この通り芯上の部材が孤立していた）。階グラフも
    // Undo 対象に含める。
    const beforeArch = serializeGraph(graph);
    const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    const clId = cl.id; // 削除前に控える——undo/redoクロージャ・notifyはcl自体を参照しない
    // 安全網（QA指摘1是正・2026-09-27）: 削除前後の復元不能セル差分は「CLがgraphに存在する」削除前の
    // 状態と比較しないと意味を持たない——detach・structGraph.removeCenterLineより前に採る。
    const beforeUnresolvable = collectUnresolvableCells(graph);

    // 新ルール1（境界での後始末）〜壁再生成は centerLineFloorSync.js applyCenterLineRemovalAftermath
    // へ集約（ステップ4・自階分）。detach・removeDependentsOfCenterLine・structGraph.removeCenterLine
    // （自階の実削除）はopts.deleteFnとして渡し、後始末と同じrunInAction 1本の中で先頭に実行される
    // （QA指摘7是正——削除と後始末を2つのactionに分けない）。他階分（他階のフェーズ2。
    // applyOtherFloorsGridCenterLineAftermath）も同じtry/catchの中で行い、自階・他階どちらかが
    // 失敗しても同じ安全網（restoreStructCLs→restoreGraph→rollbackFloorRecords）で巻き戻す
    // ——他階のフェーズ2はまだundoが積まれていないこの時点でのみ呼べるため、自階のundo push
    // より前に完了させる必要がある。materialMap・resolveStairContext用peekは変更前に取得済み
    // （上記）——この区間のawaitは実I/Oを伴わないマイクロタスクのみのはずだが、regenerateWalls
    // 自体が想定外の理由で例外を投げた場合に備え、安全網と同じ巻き戻しをしてから再throwする——
    // 削除・detach・後始末が反映済みのままundoも無く放置される事故を防ぐ。
    const floorRecords = [];
    let afterArch, after;
    try {
      const { newlyUnresolved } = await applyCenterLineRemovalAftermath(graph, project, clId, {
        materialMap, peek, willRegenerateWalls, beforeUnresolvable,
        deleteFn: () => {
          // core/planGraph.js removeCenterLineと同じ順序（reparent→detach→teardown）。自階の
          // 子CL（refIdでこの通り芯を参照するaux/center）のrefIdを繰り上げてから壁端・extent参照の
          // 切り離しへ進む——reparentChildCenterLinesは通り芯がgraph自身のshapeMapに無くても
          // _structGraph側から解決する（2026-09-27是正）。
          graph.reparentChildCenterLines(clId);
          graph.detachFromCenterLine(clId);
          graph.removeDependentsOfCenterLine(clId);
          // ステップ4・ルール2是正: 通り芯を structGraph から外すのは自階・他階すべてのdetachが
          // 終わった直後の、ここ1箇所だけ（自階分）。detachOtherFloorsFromGridCenterLine のJSDoc
          // 「2フェーズに分けた理由」参照——後始末（部屋再解釈）はCLがgraphに実在しないことを
          // 「辺の喪失」の判定に使うため、自階・他階どちらの後始末も、この行の**後**でなければ
          // 正しく動かない（実測: 先に呼ぶと「辺を1つも失っていない」と判定され部屋が併合されない）。
          project.structGraph.removeCenterLine(clId);
        },
        ...(opts.regenerateWallsFn ? { regenerateWallsFn: opts.regenerateWallsFn } : {}),
        // QA指摘M是正（2026-09-27・M1'是正(b)を裁定変更）: 実I/Oの有無に頼らない防御。前倒し
        // （上記）で変更後のawaitから実I/Oを無くしても「絶対に無い」とは言い切れないため、
        // 壁再生成await後にもう一度階切替・通り芯の消失（例: 別経路でundoが実行され通り芯が
        // structGraphへ復元された等）を検知する。**到達しない前提**: store.js switchFloor が
        // 冒頭で whenCenterLineOpsIdle() を await するため、この関数の実行中に
        // floorSwapManager.swap（対象階のIDB保存＋clearFloorData）を伴う階切替は起きない
        // （QA指摘M・裁定(1)）。検知した場合は独自に巻き戻さず例外を投げ、下のcatch（安全網。
        // restoreStructCLs→restoreGraph→rollbackFloorRecords→再throw）へ委ねる——ここで
        // {toast:null}を返すと、switchFloorが実際にswapしてしまった後（本来届かない
        // はずのケース）にbefore/beforeArchが既にクリア済みの非アクティブgraphへの復元になり、
        // 復元が効かないままundoも無く終わる事故になりうるため（QA実測）。
        assertStillValid: () => {
          if (graph !== project.activeGraph || project.structGraph.shapeMap.get(clId) !== undefined) {
            throw new Error('deleteCenterLineWithUndo: 壁再生成の待機中に階切替・通り芯の消失を検知しました（到達しない想定の防御）');
          }
        },
      });
      // ルール4の安全網（S1・2026-09-27。M2で前後差分方式へ一般化）: findUnresolvableCells の
      // 先読みが正しければここには到達しない——先読みの漏れ（未知の退化パターン）があっても
      // 削除済みidを残さないよう、削除前後の「復元不能セル集合」の差分（新規に増えた分）を見て
      // 非空なら通り芯削除自体を取り消す（tryの内側だが例外ではなくreturnのため、この関数は
      // ここで終了する。まだ他階フェーズ2は未実行＝floorRecordsは空のため
      // rollbackFloorRecordsは実質no-opだが、形を揃えるため呼ぶ）。
      if (newlyUnresolved.length > 0) {
        restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger);
        restoreGraph(graph, beforeArch);
        await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
        return { toast: ERR_CL_DELETE_UNRESOLVABLE };
      }

      // 他階のフェーズ2（後始末→壁再生成のみ。保存・道連れ削除はまだ行わない——QA指摘5是正）。
      // 自階分の直後・undo push より前に行う——他階が復元不能で拒否されたら自階分も含めて巻き戻す
      // 必要があるため。
      const { rejectedPlane, processed } = await applyOtherFloorsGridCenterLineAftermath(otherFloorContexts, project, clId, {
        materialMap,
        ...(opts.regenerateWallsFn ? { regenerateWallsFn: opts.regenerateWallsFn } : {}),
      });
      if (rejectedPlane) {
        restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger);
        restoreGraph(graph, beforeArch);
        await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
        return { toast: ERR_CL_DELETE_UNRESOLVABLE };
      }

      // 壁由来梁芯の道連れ削除（QA指摘5是正・2026-09-27。案i・2026-09-27で対象を全非屋根他階へ拡大）:
      // 自階・全非屋根他階（processed＝この通り芯を参照していた階、orphanOnlyContexts＝参照して
      // いなかった階）の壁再生成が終わった後に1パスで評価する——selfAndBelow規則は「1つ下の実体階」の
      // 壁も根拠にするため、参照を持たない階でもその下階（自階または他階）の壁が今回の削除の後始末で
      // 変わると壁由来梁芯が孤児になりうる（structural/wallBeamAxes.js removeOrphanedWallBeamAxesFor）。
      removeOrphanedWallBeamAxesFor(graph, project, selfBelowGraph, selfSourcesBefore);
      for (const ctx of processed) {
        if (!ctx.isRoof) removeOrphanedWallBeamAxesFor(ctx.temp, project, ctx.belowGraph, ctx.sourcesBefore);
      }

      // 他階の保存（道連れ削除後の最終状態）。他階フェーズ2は階ごとにIDB書込（saveFloorFn）を伴う
      // awaitを挟むため、自階のQA指摘M是正と同型の防御をこの後に置く（到達しない前提は
      // assertStillValidと同じ——whenCenterLineOpsIdle()により本関数の実行中は
      // floorSwapManager.swap を伴う階切替が起きない）。検知した場合は例外を投げ、下のcatch
      // （安全網）へ委ねる——floorRecordsには既に保存済みの他階分（rollback対象）が含まれている。
      await saveOtherFloorsAfterGridCenterLineAftermath(processed, {
        undoRecords: floorRecords,
        ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
      });
      // 参照を持たなかった他階（orphanOnlyContexts）は、道連れ削除で実際に梁芯が消えた階だけを
      // 保存・floorRecordsへ記録する（無変更の階はIDBを一切書かない）。removeOrphanedWallBeamAxesFor
      // の呼び出し元をcenterLineOps.js側に一本化する（structural/wallBeamAxes.jsのJSDoc参照）。
      // saveOtherFloorsAfterGridCenterLineAftermathへ「実際に消えた階だけ」絞り込んで渡すことで、
      // 保存・undoRecords記録のロジックを重複実装しない。
      const changedOrphanFloors = [];
      for (const ctx of orphanOnlyContexts) {
        const orphaned = removeOrphanedWallBeamAxesFor(ctx.temp, project, ctx.belowGraph, ctx.sourcesBefore);
        if (orphaned.length > 0) changedOrphanFloors.push(ctx);
      }
      await saveOtherFloorsAfterGridCenterLineAftermath(changedOrphanFloors, {
        undoRecords: floorRecords,
        ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
      });
      if (graph !== project.activeGraph || project.structGraph.shapeMap.get(clId) !== undefined) {
        throw new Error('deleteCenterLineWithUndo: 他階の後始末の待機中に階切替・通り芯の消失を検知しました（到達しない想定の防御）');
      }

      afterArch = serializeGraph(graph);
      after = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    } catch (e) {
      restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger);
      restoreGraph(graph, beforeArch);
      await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
      throw e;
    }

    // 通り芯削除は種別ポリシーから導いたscope（通り芯＝FLOOR_SHARED_KINDSのため常に'all'）で
    // 構造同期を起動する（structural/structuralSync.js。App.jsxがsetCenterLineStructuralListenerで
    // 配線する）。建具と違い在来限定にしない（applies省略＝常に真。非在来のグリッド柱にも効くため）。
    const scope = structuralSyncScopeOfKind(centerLineKind(cl));
    const notify = (records) => structuralSyncListener?.(graph, project, scope, records);

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
    notify(floorRecords);
    return { toast: null };
  }

  // 非通り芯（中心線・補助線・梁芯）は種別ポリシーから導いたscopeで構造同期を起動する
  // （実機報告2026-09-25: tategu-test3.stqで中心線を削除すると壁交点柱が残ったままだったバグの
  // 修正——.claude/structural-model.md「起動点」節参照）。中心線は
  // structuralSyncScopeOfKind('center')==='activeAndAbove'（'all'と同じ処理のまま恒久化。在来木造の
  // 3b/3h-2による下方向依存があるため自階＋上階だけでは足りない——structuralOrchestration.js
  // recomputeForStructuralSync のコメント参照）。補助線・梁芯自身はnullが基本だが、scopeは
  // structuralSyncScopeForCenterLine（段階(d)・2026-09-25）で算出する——削除される補助線を
  // extentLoRef/extentHiRef・refIdで参照している中心線があれば、その中心線のscope
  // （'activeAndAbove'）を合成する（削除で参照は端点ルールにより静的化されるため、必ず
  // **削除前（detach前）**に算出する）。梁芯はnull（専用経路structural/wallBeamAxes.js。
  // 条件10で二重に動かさない）——それ以外の非通り芯削除では従来どおりlistenerを呼ばない。
  const scope = structuralSyncScopeForCenterLine(graph, cl);
  // 段階(g)・2026-09-26: floorRecords（この関数内で新設。「配列を持たない3か所」の1つ）を確定時の
  // notifyだけに渡す。
  const floorRecords = [];
  const notify = (records) => structuralSyncListener?.(graph, project, scope, records);
  // 壁の軸になれる種別（セル分割線。isFinishCellDivider——このブランチには通り芯は来ないため
  // 実質center種別のみが真になる）の削除だけが壁ソースを変えうる——補助線・梁芯自身の削除は
  // 壁の軸にならないため対象外。
  const canCarryWalls = isFinishCellDivider(cl);
  // フットプリント境界削除ガード（自階判定のみ。中心線・補助線・梁芯のうちセル分割に参加する
  // 種別＝canCarryWalls===isFinishCellDivider(cl)。centerLineConvert.js isFootprintBoundaryCL参照。
  // 補助線・梁芯はセル分割に参加しないため対象外）。struct分岐と異なり中心線は階固有の実体で
  // 他階から参照されないため、他階peekは行わない（centerLineConvert.jsコメント・findFloorsWhereFootprintBoundaryのJSDoc参照）。
  if (canCarryWalls && isFootprintBoundaryCL(graph, cl)) return { toast: ERR_CL_DELETE_FOOTPRINT };
  // 復元不能セルガード（ステップ2。struct分岐と同じfindUnresolvableCells）。セル分割に参加する
  // 種別（canCarryWalls）のときだけ判定する——補助線・梁芯の削除はセルに影響しないため対象外。
  if (canCarryWalls && findUnresolvableCells(graph, cl.id).length > 0) return { toast: ERR_CL_DELETE_UNRESOLVABLE };

  // ユーザー承認済み例外（2026-09-25）: 明示的な中心線削除に限り、その削除で失われる壁だけを
  // 根拠にしていた壁由来梁芯（discipline:fuse。structural/wallBeamAxes.js autoFillWallBeamAxes）を
  // 同じundoエントリで道連れにする——一般に孤児梁芯を撤去する規律は作らない
  // （.claude/structural-model.md「孤児梁芯を撤去する規律は作らない」節。今回は「同じ操作の中で
  // 壁ソースが消えた事実」が出自の代わりになる、明示的な中心線削除だけの特例）。
  // 在来木造（wallBeamAxes:'selfAndBelow'）は自階＋1つ下の階の壁を根拠にするため、道連れ判定にも
  // 下階の壁区間が要る——中心線削除のときだけ、その主構造ルールのときだけ下階をpeekする
  // （RC造・非生成主構造でIDBを無駄に読まない。opts.peekBelowはテスト用の差し替え）。
  const needsBelowPeek = canCarryWalls && rulesFor(effectiveStructure(graph, project)).wallBeamAxes === 'selfAndBelow';
  // QA指摘H1/H2/M1/M1'是正（2026-09-27）: canCarryWallsの削除は壁再生成の対象になりうるため、壁を
  // 一度も持っていない階（hasNeverBuiltWalls）でなければ、materialMap取得・モジュール事前読込み
  // （makeWallRegenPrereqTask）・resolveStairContext用の下階peek（cachedPeekのウォームアップ）も、
  // この下階peek（needsBelowPeek）と同じawaitゾーンにまとめて変更前に済ませる（struct分岐と
  // 同じ設計。詳細は関数冒頭のコメント参照）。
  const willRegenerateWalls = canCarryWalls && !hasNeverBuiltWalls(graph);
  const belowPlaneForStairs = willRegenerateWalls ? belowPlaneOf(graph.plane, project) : null;
  const [belowGraph, , wallRegenPrereq] = await Promise.all([
    needsBelowPeek ? (opts.peekBelow ?? peekBelowGraph)(graph, project) : Promise.resolve(null),
    belowPlaneForStairs ? peek(belowPlaneForStairs, project.structGraph) : Promise.resolve(null),
    makeWallRegenPrereqTask(willRegenerateWalls),
  ]);

  // 下階peek・materialMap取得の await 中に階が切り替わった・この中心線自体が消えた可能性を
  // 再評価する（通り芯削除のM-2ガードと同型）。needsBelowPeek・willRegenerateWallsのどちらも
  // falseならawaitを挟んでいない（aux・beam・壁未生成の中心線）ため再評価は不要。
  if (needsBelowPeek || willRegenerateWalls) {
    if (graph !== project.activeGraph || graph.shapeMap.get(cl.id) !== cl) {
      return { toast: null };
    }
    // struct分岐のF5（QA指摘）と同型: 下階peek（awaitを挟む）の間に自階のフットプリント・
    // セル構成が変わりうる（並行編集・他の非同期処理の割り込み）ため、フットプリント境界ガード・
    // 復元不能セルガードも同じ場所で再評価する（「判定不能の持ち越しは認めない」方針）。
    // この分岐へ入る条件はneedsBelowPeek・willRegenerateWallsのいずれかがtrueで、どちらの定義も
    // canCarryWallsを含むため、ここではcanCarryWalls===trueが保証されている
    // （非canCarryWallsの経路はそもそもここへ来ない）。
    if (isFootprintBoundaryCL(graph, cl)) return { toast: ERR_CL_DELETE_FOOTPRINT };
    if (findUnresolvableCells(graph, cl.id).length > 0) return { toast: ERR_CL_DELETE_UNRESOLVABLE };
  }
  // materialMap取得・モジュール事前読込みの失敗（QA指摘H2・M1'）: ERR_CATALOG_DUPLICATEは
  // 合成後例外のため握りつぶさず再throw（wallRefresh.js既存の扱いと同じ）。それ以外
  // （IDB読込失敗・チャンク取得失敗等）は、まだ何も変更していない段階で拒否する——壁を作り
  // 直せないまま削除だけ通すと、壁がdetachで切られたまま再生成されない事故になる。
  if (!wallRegenPrereq.ok) {
    if (wallRegenPrereq.error?.code === ERR_CATALOG_DUPLICATE) throw wallRegenPrereq.error;
    return { toast: ERR_CL_DELETE_WALLS_UNAVAILABLE };
  }
  const materialMap = wallRegenPrereq.materialMap;

  const before = serializeGraph(graph);
  // 安全網（QA指摘1是正・2026-09-27）: struct分岐と同じ理由で、削除前（graph.removeCenterLineより
  // 前）の「今のgraphで実際に復元不能なセル集合」を採っておく（collectUnresolvableCells）。
  const beforeUnresolvable = collectUnresolvableCells(graph);
  // 壁由来梁芯の道連れ削除（structural/wallBeamAxes.js removeOrphanedWallBeamAxesFor）用の「削除前」
  // スナップショット。壁はまだ何も変わっていないこの時点で採る（sourcesAfterは壁再生成の後で採り、
  // 1回の評価にまとめる。canCarryWallsがfalseの経路（補助線・梁芯自身）は壁の軸にならないためnull）。
  const sourcesBefore = canCarryWalls ? wallBeamSourcesFor(graph, project, belowGraph) : null;
  const clId = cl.id; // removeCenterLine後もkneeDropWalls掃除・部屋再解釈のキー参照に使う（applyCenterLineRemovalAftermath内）
  // 新ルール1（境界での後始末）〜壁再生成は centerLineFloorSync.js applyCenterLineRemovalAftermath
  // へ集約（ステップ4・struct分岐と共有。canCarryWalls===falseなら内部で後始末・壁再生成そのものを
  // スキップする）。graph.removeCenterLine自体もopts.deleteFnとして渡し、後始末と同じrunInAction
  // 1本の中で先頭に実行される（QA指摘7是正——削除と後始末を2つのactionに分けない。旧実装は
  // 1つのrunInActionだった）。materialMapは変更前に取得済み（上記）で、resolveStairContext用の
  // peekも同じく変更前に温めたキャッシュを使うため、この区間のawaitは実I/Oを伴わないマイクロタスク
  // のみのはずだが、regenerateWalls自体が想定外の理由で例外を投げた場合に備え、安全網と同じ
  // 巻き戻し（restoreGraph）をしてから再throwする——削除・後始末が反映済みのままundoも無く放置
  // される事故を防ぐ（非struct分岐は他階伝播が無いためrestoreGraphのみでよい）。
  let after;
  try {
    const { newlyUnresolved } = await applyCenterLineRemovalAftermath(graph, project, clId, {
      materialMap, peek, canCarryWalls, willRegenerateWalls, beforeUnresolvable,
      deleteFn: () => {
        // 梁芯CLの削除は「壁由来の梁芯自動生成」に対する明示的な手動削除として扱う——次回のモード
        // 境界再計算で元の座標に再生成されないよう、座標ベースの除外集合へ記録する（壁の位置自体は
        // 削除しないため、記録しないと自動生成が復活させてしまう）。キーは structural/wallBeamAxes.js
        // と同じ形式。中心線の道連れ削除（removeOrphanedWallBeamAxesFor）は excludedWallBeamAxes
        // に触れない——壁が戻れば（undo）再生成されるため、手動削除・移動の記録と同列に扱わない。
        if (centerLineKind(cl) === 'beam') {
          graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(cl.centerLineType === CenterLineType.VERTICAL, cl.effectiveValue));
        }
        // graph.removeCenterLine は内部で detachFromCenterLine（壁端・extent参照の切り離し）→
        // _teardownCenterLine（removeDependentsOfCenterLineで柱・梁・耐力壁・基礎・スリーブを撤去
        // →Intersection撤去）を行うため、通り芯削除のように別途removeDependentsOfCenterLineを
        // 呼ぶ必要はない——この1行の時点で壁位置は既に確定済み（構造同期の前提を満たす）。
        // 中心線は階固有の実体で他階からは参照されない（昇格・降格が他階に作る・吸収する線は別
        // オブジェクト——transform/centerLineFloorSync.js propagateDemotedCenterLine/
        // applyCenterLineAbsorptionOnPromote 参照）ため、通り芯削除と違い他階への伝播（propagate*）は不要。
        graph.removeCenterLine(cl.id);
      },
      ...(opts.regenerateWallsFn ? { regenerateWallsFn: opts.regenerateWallsFn } : {}),
      // QA指摘M是正（2026-09-27・M1'是正(b)を裁定変更）: 実I/Oの有無に頼らない防御。前倒し（上記）で
      // 変更後のawaitから実I/Oを無くしても「絶対に無い」とは言い切れないため、壁再生成await後に
      // もう一度階切替・この中心線の消失（graph.shapeMap.has(clId)。struct分岐の
      // project.structGraph.shapeMap.get(clId)!==undefinedと対称——別経路でundoが実行され
      // この中心線が復活した等）を検知する。**到達しない前提**: store.js switchFloor が冒頭で
      // whenCenterLineOpsIdle() を await するため、この関数の実行中に floorSwapManager.swap
      // （対象階のIDB保存＋clearFloorData）を伴う階切替は起きない（QA指摘M・裁定(1)）。検知した
      // 場合は独自に巻き戻さず例外を投げ、下のcatch（安全網。restoreGraph→再throw）へ委ねる
      // ——ここで{toast:null}を返すと、switchFloorが実際にswapしてしまった後（本来届かない
      // はずのケース）にbeforeが既にクリア済みの非アクティブgraphへの復元になり、復元が効かない
      // ままundoも無く終わる事故になりうるため（QA実測）。
      assertStillValid: () => {
        if (graph !== project.activeGraph || graph.shapeMap.has(clId)) {
          throw new Error('deleteCenterLineWithUndo: 壁再生成の待機中に階切替・中心線の復活を検知しました（到達しない想定の防御）');
        }
      },
    });
    // ルール4の安全網（S1・2026-09-27。M2で前後差分方式へ一般化）: findUnresolvableCells の
    // 先読みが正しければここには到達しない——先読みの漏れ（未知の退化パターン）があっても
    // 削除済みidを残さないよう、削除前後の「復元不能セル集合」の差分（新規に増えた分）を見て
    // 非空なら削除自体を取り消す（他階への伝播はこの分岐には無いためrestoreGraphのみ。
    // undoは積まない。tryの内側だが例外ではなくreturnのため、この関数はここで終了する）。
    if (newlyUnresolved.length > 0) {
      restoreGraph(graph, before);
      return { toast: ERR_CL_DELETE_UNRESOLVABLE };
    }

    // 壁由来梁芯の道連れ削除（1パス化）: canCarryWallsのときだけ（壁の軸になれる種別の削除のみ壁
    // ソースを変えうる）。struct分岐と違い他階の壁再生成が絡まないため、自階の壁再生成が終わった
    // 直後に評価してよい（QA指摘5は他階を持つstruct分岐特有の問題——非struct分岐は階固有の実体で
    // 他階へ伝播しないため対象外）。
    if (canCarryWalls) removeOrphanedWallBeamAxesFor(graph, project, belowGraph, sourcesBefore);

    after = serializeGraph(graph);
  } catch (e) {
    restoreGraph(graph, before);
    throw e;
  }
  undoManager.push(
    () => { restoreGraph(graph, before); if (scope) { applyFloorUndoRecords(project, floorRecords, 'before', opts.saveFloorFn); notify(); } },
    () => { restoreGraph(graph, after); if (scope) { applyFloorUndoRecords(project, floorRecords, 'after', opts.saveFloorFn); notify(); } },
  );
  if (scope) notify(floorRecords);
  return { toast: null };
}

// ---- 中心⇔通り芯の入替え（平面モード限定・メニューの cl-to-grid / cl-to-center）----
// グラフ変更本体（純粋部分）は transform/centerLineConvert.js。ここは undo 登録・階またぎ同期の
// 呼び出しを担う（centerLineFloorSync.js は静的import——段階(g)・QA指摘m-3。ファイル冒頭のimport参照）。
// 通り芯削除（deleteCenterLineWithUndo の isStruct 分岐）と同じ二重スナップショット方式のUndo。
// 復元順序厳守: struct を先に戻してから階グラフを戻す（階グラフの CL 参照解決が structGraph を
// 引くため——階グラフ側を先に戻すと一時的に参照先を失った状態を経由してしまう）。

// ---- 中心線 → 通り芯 ----
// 同期ガード（型・直交通り芯・図形干渉・同グラフ内重複）を先に評価してから、Q11（既存データに
// 同じidの線が他の平面へ残っていないか。findFloorsWithSameLineId）→ IDBを伴う他階重複チェック
// （findFloorsWithCounterpartCL）の順に呼ぶ——確実に失敗する同期ガードのために無駄な全階IDB
// 読み込みが走り、本来と異なるトーストが先に出るのを防ぐ（N5）。他の平面の同座標の中心線は
// 拒否の相手にせず（findFloorsWithCounterpartCLへabsorbCenter:trueを渡して除外する）、
// findCenterLinesToAbsorbOnPromoteで事前調査だけ行い、実際の吸収書込み（applyCenterLineAbsorption
// OnPromote）は**移籍（applyPromoteToGrid）の後**に行う（線種変更の移籍一本化・裁定Q1・Q2・
// 2026-09-30。QA所見5是正: 他平面の壁は自平面の中心線idを参照する側のため、移籍前に他平面の
// afterバイトへ通り芯id（まだ共有グラフに無い）を書くと、その直後にタブが落ちる等で再読込みされた
// 場合に他平面の壁・部屋が解決できず消える——降格propagateDemotedCenterLineとは逆に、吸収は
// 参照先が移籍後に実在するようになる側のため、書込みも移籍後に揃える）。
// @param {{saveFloorFn?: Function}} [opts] - saveFloorFn はテスト用の差し替え（既定値は
//   centerLineFloorSync.js 側の saveFloor。呼び出し側（App.jsx）は無改造でよい）。
// @returns {Promise<{ toast: string|null }>}
export async function promoteCenterToGridWithUndo(graph, project, cl, opts = {}) {
  // 発見②・ユーザー裁定・案A・2026-09-25: 同座標の壁由来梁芯のうち保護されない（ユーザーが個別に
  // 手を加えた形跡が無い）ものは障害物にせず、昇格後に吸収して撤去する（下記）。保護判定は
  // orphanedWallBeamAxesと同じ述語（isProtectedWallBeamAxis）を共有——重複実装しない。
  // centerLineConvert.jsはimport-free規約のためwallBeamAxes.jsを直接importできず、判定はここ
  // （centerLineOps.js。既にwallBeamAxes.jsをimport済み）で行い、判定済みidの配列だけを渡す。
  // 梁芯の検索はfindWallBeamAxisCLs（centerLineKind(x)==='beam'のインライン比較を増やさない。
  // G3ガード）を使う。線種変更の移籍一本化 ステップ6是正（2026-09-30）: 同座標に区間の離れた
  // 梁芯が複数本ありうるため複数形で列挙し、保護されないものだけ吸収対象にする——保護される梁芯が
  // 1本でもあれば、その分は excludeBeamAxisIds に含めないため checkPromoteToGridGuards が拒否する
  // （従来どおり「1本でも保護されれば昇格自体を拒否」の規則を保つ）。
  const sameCoordBeamAxes = findWallBeamAxisCLs(graph, cl.centerLineType === CenterLineType.VERTICAL, cl.value);
  const absorbableBeamAxisIds = sameCoordBeamAxes.filter(ax => !isProtectedWallBeamAxis(graph, ax)).map(ax => ax.id);

  const guardError = checkPromoteToGridGuards(graph, project.structGraph, cl, { excludeBeamAxisIds: absorbableBeamAxisIds });
  if (guardError) return { toast: guardError };

  // 裁定Q11（線種変更の移籍一本化）: 既存データに同じidの線が他の平面へ残っていないかを確認する
  // （降格側 demoteGridToCenterWithUndo と同じ規律。findFloorsWithCounterpartCL より先に置く——
  // 座標一致より id 一致のほうが実装上の不変条件違反であり、優先して検出・拒否する）。
  const sameIdFloors = await findFloorsWithSameLineId(project, graph, cl.id);
  if (sameIdFloors.length > 0) {
    return { toast: ERR_CL_CONVERT_SAME_ID_FLOOR(sameIdFloors.map(f => f.plane.name)) };
  }

  // 発見④・ユーザー裁定・案A・2026-09-25: 他階の保護されない壁由来梁芯は重複相手から除外する
  // （absorbWallBeamAxesOnPromoteが同じ階を後で吸収撤去するため）。裁定Q1（2026-09-30）: 他階の
  // 同座標の中心線も重複相手から除外する（findCenterLinesToAbsorbOnPromote/applyCenterLineAbsorption
  // OnPromoteが同じ階を後で吸収するため）。
  const dupFloors = await findFloorsWithCounterpartCL(project, graph, cl, { excludeAbsorbableBeam: true, absorbCenter: true });
  if (dupFloors.length > 0) {
    return { toast: ERR_CL_CONVERT_DUP_FLOOR(dupFloors.map(f => ({ name: f.plane.name, kind: f.kind }))) };
  }

  // 他階の壁由来梁芯の吸収（移籍前に行う。propagateDemotedCenterLineと同じ規律——他階を先に確定させ
  // てから自階を変換する）。保護される梁芯がある階が1つでもあればERR_CL_CONVERT_DUP_FLOORで拒否する
  // （findFloorsWithCounterpartCLの他階重複トーストと同じ文言・形。kindは常に'beam'）。
  const floorRecords = [];
  let blockedPlanes;
  try {
    ({ blockedPlanes } = await absorbWallBeamAxesOnPromote(project, graph, cl, {
      undoRecords: floorRecords,
      ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
    }));
  } catch (e) {
    await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
    throw e;
  }
  if (blockedPlanes.length > 0) {
    return { toast: ERR_CL_CONVERT_DUP_FLOOR(blockedPlanes.map(p => ({ name: p.name, kind: 'beam' }))) };
  }

  // 他階の中心線吸収の事前調査（QA所見5是正: 書込みはまだしない。移籍後にapplyCenterLineAbsorption
  // OnPromoteで書く）。
  const absorbTargets = await findCenterLinesToAbsorbOnPromote(project, graph, cl);

  // 他階peek（IDBを伴うawait）の間に、階が切り替わった・このCL自体が消えた可能性を再評価する
  // （通り芯削除のM-2ガードと同型）。
  if (graph !== project.activeGraph || graph.shapeMap.get(cl.id) !== cl) {
    await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
    // 線種変更の移籍一本化 ステップ5是正: この中止はエラーではなく「割り込みで対象が変わった」状態
    // のため toast は出さないが、呼び出し側（addCenterLineFromDialogの昇格分岐）が「成功した」と
    // 誤認しないよう aborted:true を返す（ダイアログを閉じない・Q9の文言を出さない）。
    return { toast: null, aborted: true };
  }

  const fromKind = centerLineKind(cl);
  const beforeArch   = serializeGraph(graph);
  const beforeStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const { error } = applyPromoteToGrid(graph, project.structGraph, cl, { excludeBeamAxisIds: absorbableBeamAxisIds });
  if (error) {
    await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
    return { toast: error };
  }
  // 吸収撤去（発見②）: 昇格確定の直後・afterArchを採る前に、保護されない壁由来梁芯を自階から
  // 撤去する（乗っていたauto柱・梁・基礎はgraph.removeCenterLine内のremoveDependentsOfCenterLineで
  // 道連れになり、以後の構造同期（'all'）で作り直される）。excludedWallBeamAxesには触れない
  // ——手動削除の記録ではなく、通り芯化に伴う自然な後始末のため。undoはbeforeArchの全体スナップ
  // ショットで戻るため、この撤去専用のundo処理は不要。
  runInAction(() => {
    for (const id of absorbableBeamAxisIds) graph.removeCenterLine(id);
  });

  // 他階の中心線吸収の本体（QA所見5是正・裁定Q1・Q2）: ここで初めて他平面へ書き込む——
  // clが既にproject.structGraphへ移った（applyPromoteToGridが完了した）後なので、他平面のafter
  // バイトがcl.idを参照しても常に解決できる。複数の中心線を同じ通り芯idへ寄せようとして参照が
  // 衝突したら（QA所見2。hasAbsorptionConflict）、その平面名を出して拒否する——この時点では
  // 既にapplyPromoteToGridで自階・structGraphを変更済み・場合によってはabsorbWallBeamAxesOnPromote
  // が他平面へ書込み済みのため、失敗時はstructGraph・自階・floorRecordsの全てをbeforeへ巻き戻す
  // （undoは積まない。例外はQA所見3是正によりtry/catchで丸めず素通しする——呼び出し側
  // App.jsxのtagCLOpFailureがERR_CL_CONVERT_SYNC_FAILEDへ丸める）。
  let conflictPlane;
  try {
    ({ conflictPlane } = await applyCenterLineAbsorptionOnPromote(absorbTargets, cl, {
      undoRecords: floorRecords,
      ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
    }));
  } catch (e) {
    await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
    restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
    restoreGraph(graph, beforeArch);
    throw e;
  }
  if (conflictPlane) {
    await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
    restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
    restoreGraph(graph, beforeArch);
    return { toast: ERR_CL_CONVERT_ABSORB_CONFLICT_FLOOR(conflictPlane.name) };
  }

  // 他階peek・saveFloorFn（IDBを伴うawait）の間に、この通り芯が共有グラフから消えた・別物に
  // 差し替わった可能性を再評価する（通り芯削除のM-2ガード・上の「アクティブ再確認」と同型の
  // 防御。QA指摘5是正で吸収がここまで来た＝既にapplyPromoteToGridを経ているため、確認対象は
  // 「graphのshapeMapにcl.idが無いこと」ではなく「project.structGraphのshapeMapが依然としてcl
  // 自身を指していること」——移籍後は前者が常に真（releaseCenterLine済み）になるため使えない）。
  // 検知した場合は既にabsorbWallBeamAxesOnPromote・applyCenterLineAbsorptionOnPromoteの両方が
  // 書いた分をfloorRecordsごと巻き戻し、structGraph・自階もbeforeへ戻してundoを積まずに終える。
  if (project.structGraph.shapeMap.get(cl.id) !== cl) {
    await rollbackFloorRecords(floorRecords, opts.saveFloorFn, project);
    restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
    restoreGraph(graph, beforeArch);
    // 線種変更の移籍一本化 ステップ5是正: 上と同じ理由でaborted:trueを返す。
    return { toast: null, aborted: true };
  }

  // 段階(c)・2026-09-25: structuralSyncScopeOfConversion('center','struct')は常に'all'
  // （どちらかが'all'なら全体で'all'。centerLineKindPolicy.js参照）。
  const scope = structuralSyncScopeOfConversion(fromKind, centerLineKind(cl));
  const notify = (records) => { if (scope) structuralSyncListener?.(graph, project, scope, records); };
  const afterArch   = serializeGraph(graph);
  const afterStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  // amendは使わない（design-c.md §3）——他階の梁芯吸収（absorbWallBeamAxesOnPromote・移籍前）・
  // 他階の中心線吸収（applyCenterLineAbsorptionOnPromote・線種変更の移籍一本化・2026-09-30・
  // QA所見5是正で移籍後に変更）はいずれもこのundoManager.pushより前にfloorRecordsへ積み終えて
  // いるため、undo/redoクロージャが参照するfloorRecordsは push の時点で既に確定している
  // （発見④・案Aで両方の記録を同じ配列に積む——ユーザー裁定。旧・回収
  // （recallPromotedCenterLineDuplicates）は確定後に追記していたためpush後もfloorRecordsへ
  // 追加され続けたが、分身廃止に伴いその経路は無くなった）。
  undoManager.push(
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
      restoreGraph(graph, beforeArch);
      applyFloorUndoRecords(project, floorRecords, 'before', opts.saveFloorFn);
      notify();
    },
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, afterStruct, project.memberGroupLedger);
      restoreGraph(graph, afterArch);
      applyFloorUndoRecords(project, floorRecords, 'after', opts.saveFloorFn);
      notify();
    },
  );

  notify(floorRecords);
  return { toast: null };
}

// ---- 通り芯 → 中心線 ----
// 同期ガードを先に評価してから（N5。promoteCenterToGridWithUndoと同じ理由）、Q11（既存データに
// 同じidの線が他の平面へ残っていないか）→ 変換前の他階の同座標重複チェックの順に呼ぶ
// （スキップ方式は不採用——片階だけ複製漏れすると壁参照が壊れるため、1階でも重複していれば全体を
// 拒否する）。Q11を先に置く理由: findFloorsWithCounterpartCLの同id除外を廃止した（線種変更の
// 移籍一本化・2026-09-30）ため、Q11を後に回すと id 一致（実装上の不変条件違反）が座標一致の通常
// 重複に埋もれてしまう——promoteCenterToGridWithUndoと同じ順序に揃える。
// 順序は「複製→移籍」（案A、2026-09-17裁定）: 通り芯が project.structGraph に残っている間に
// 非アクティブ全階へ新しいidの中心線を作り、その平面の通り芯id参照を一括置換してから
// （propagateDemotedCenterLine。線種変更の移籍一本化・分身廃止・2026-09-30）、本体を移籍する
// （applyDemoteToCenter）。逆順（移籍→複製）だと、複製フェーズで他階を peek した時点で通り芯が
// structGraph に無く、他階の壁の axisCL/clStart/clEnd が graphSnapshot.js の resolveCL で解決
// できず復元時に黙って捨てられ、その欠落が saveFloor で永続化される（2026-09-17実測。昇格は
// 逆に「移籍→回収」で正しい——promoteCenterToGridWithUndo参照）。
// 複製フェーズが途中で失敗（例外）した場合、またはその直後の applyDemoteToCenter がエラーを
// 返した場合は、そこまでに保存できた階を rollbackFloorRecords で before に書き戻す
// （best effort）。前者は自階・structGraphとも未変更のため undo エントリを積まず例外を再スロー
// （呼び出し側 App.jsx の handleConvertCenterLine が tagCLOpFailure で code を付け、guardUi層
// （floorTransitionErrorMessage）が ERR_CL_CONVERT_SYNC_FAILED を出す。入力規制ステップ3で関門化）。
// 後者は従来どおり { toast: error } を返す。
// removeFixedMembers（既定false・手動追加材サイレント撤去回避 指示書§3裁定4・§5ステップ4）:
// trueなら、この通り芯を参照する固定材（非auto。柱・梁・基礎/柱脚・梁ホストのスリーブ）を
// 全階（自階＋propagateDemotedCenterLineが新しいidの中心線を作る他階）で削除する。壁・図形は消さない
// （removeDependentsOfCenterLineは壁・図形も消すため使わない。structural/fixedMemberRefs.js
// removeFixedMembersReferencingが柱・梁・基礎/柱脚・スリーブだけを直接mapから削除する）。
// 呼び出し側（App.jsx handleConvertCenterLine）が事前にcollectFixedMembersByFloorで確認済みの
// ときだけtrueを渡す——確認なしの経路（probe・既存テスト）はopts省略のままfalseで、削除は発火しない。
// @param {{saveFloorFn?: Function, removeFixedMembers?: boolean}} [opts] - saveFloorFn はテスト用の差し替え（既定値は
//   centerLineFloorSync.js 側の saveFloor。呼び出し側（App.jsx）は無改造でよい）。
// @returns {Promise<{ toast: string|null }>}
export async function demoteGridToCenterWithUndo(graph, project, cl, opts = {}) {
  const guardError = checkDemoteToCenterGuards(graph, project.structGraph, cl);
  if (guardError) return { toast: guardError };

  // 裁定Q11（線種変更の移籍一本化・ステップ4で昇格側と順序をそろえた）: 既存データに同じidの線が
  // 他の平面へ残っていないかを、座標一致の重複チェックより先に確認する。線idはプロジェクト全体で
  // 一意という前提（propagateDemotedCenterLineが新idで複製する規律）が崩れているデータに対しては、
  // 書き換えずに拒否する（黙って壊さない）。findFloorsWithCounterpartCLの同id除外を廃止した
  // （線種変更の移籍一本化・2026-09-30）ため、Q11を先に置かないと id 一致（実装上の不変条件違反）が
  // 座標一致の通常重複（ERR_CL_CONVERT_DUP_FLOOR_DEMOTE）に埋もれて誤った理由を表示してしまう
  // ——昇格側 promoteCenterToGridWithUndo と同じ順序（ガード→Q11→findFloorsWithCounterpartCL）。
  const sameIdFloors = await findFloorsWithSameLineId(project, graph, cl.id);
  if (sameIdFloors.length > 0) {
    return { toast: ERR_CL_CONVERT_SAME_ID_FLOOR_DEMOTE(sameIdFloors.map(f => f.plane.name)) };
  }

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
      ...(opts.newIdFn ? { newIdFn: opts.newIdFn } : {}),
      removeFixedMembersFn: opts.removeFixedMembers ? removeFixedMembersReferencing : null,
    });
  } catch (e) {
    // 複製フェーズが途中で失敗——自階・structGraphともガード契約によりまだ未変更のため、
    // ここまでに保存できた他階だけをbefore（削除前）へ書き戻せば整合する（rollbackFloorRecords）。
    await rollbackFloorRecords(propagationRecords, opts.saveFloorFn);
    throw e;
  }

  const fromKind = centerLineKind(cl);
  const beforeArch   = serializeGraph(graph);
  const beforeStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const result = applyDemoteToCenter(graph, project.structGraph, cl);
  if (result.error) {
    // applyDemoteToCenterのエラーは自階・structGraphを変更する前に検出される（centerLineConvert.js
    // checkDemoteToCenterGuards相当の再チェック）——自階の固定材削除はまだ行っていないため、
    // 複製済みの他階（固定材削除を含む）だけをrollbackFloorRecordsで巻き戻せば足りる。
    await rollbackFloorRecords(propagationRecords, opts.saveFloorFn);
    return { toast: result.error };
  }
  // 降格が成功した直後・afterArch採取前に自階の固定材を削除する（他階は上のpropagateDemotedCenterLine
  // 内で既に削除済み）。runInActionで包む（fixedMemberRefs.js側はmobxを静的に引かないため、
  // ここ（App.jsx以外の呼び出し元でも共通の作法）で包む）。
  if (opts.removeFixedMembers) runInAction(() => removeFixedMembersReferencing(graph, cl.id));
  // 段階(c)・2026-09-25: structuralSyncScopeOfConversion('struct','center')は常に'all'
  // （どちらかが'all'なら全体で'all'。centerLineKindPolicy.js参照）。
  const scope = structuralSyncScopeOfConversion(fromKind, centerLineKind(cl));
  const notify = (records) => { if (scope) structuralSyncListener?.(graph, project, scope, records); };
  const afterArch   = serializeGraph(graph);
  const afterStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  // amendは使わない（design-c.md §3）——他階の複製（propagationRecords）の適用は、structCLs・自階の
  // 復元と同じundo/redoクロージャの中に、notifyの直前として組み込む（順序: struct→自階→他階→notify）。
  undoManager.push(
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
      restoreGraph(graph, beforeArch);
      applyFloorUndoRecords(project, propagationRecords, 'before', opts.saveFloorFn);
      notify();
    },
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, afterStruct, project.memberGroupLedger);
      restoreGraph(graph, afterArch);
      applyFloorUndoRecords(project, propagationRecords, 'after', opts.saveFloorFn);
      notify();
    },
  );
  notify(propagationRecords);

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

// ---- 通り芯の追加（ダイアログの単体追加・スパン配列）における他平面の吸収・拒否 ----
// 線種変更の移籍一本化・ステップ6（2026-09-30・裁定Q4〜Q6・Q8）: 通り芯を追加する経路は、昇格
// （promoteCenterToGridWithUndo）と同じ「他平面の同座標チェック」を通す。単体追加（values=[value]）・
// スパン配列（values=newValues）の両方がこの内部関数を通ることで、他平面の処理を2回書かない
// （addCenterLineFromDialogのkind==='struct'分岐・Array.isArray(value)分岐の両方から呼ぶ）。
// 手順（指示書§手順6 設計a〜h）:
//   a. 値ごとに他平面の同座標チェック（findFloorsWithCounterpartCL。中心線・保護されない壁由来梁芯は
//      相手から除外する——後続の手順c・fが同じ階を吸収するため）。1つでも相手（補助線・保護される
//      梁芯）があれば全体を拒否する（何も書かない）。
//   b. 自階の壁由来梁芯（裁定Q8）: 保護されなければ吸収対象（手順eで追加後に撤去）、保護されれば
//      拒否する（既存の事前拒否 `kind==='struct'&&existingKind!=='center'&&sameCoord.some(beam)` は
//      この判定に置き換える——呼び出し側 addCenterLineFromDialog 参照）。
//      【リード裁定・現状維持】単体追加とスパン配列とで実際にはここへの到達可否が異なる——単体は
//      同座標に既存が無いときだけこの関数を呼ぶが、そのまま梁芯があればここで吸収・拒否を判定する。
//      スパン配列は呼び出し側が`sameCoordCounterparts`で「自階に何か線（梁芯を含む）がある値」を
//      上流で黙って飛ばすため、梁芯がある値はそもそも`values`に含まれず、この手順に到達しない
//      （＝スパン配列は自階の梁芯を吸収しない。設計h「自階の同座標重複は範囲外」と同じ理由で、
//      単体とスパンの差はこのステップの範囲外として現状維持する）。
//   c. 他平面の保護されない壁由来梁芯を吸収する（追加前。promoteCenterToGridWithUndoと同じ規律）。
//      aで弾かれているはずだが、防御としてここでもblockedPlanesを確認する。
//   d. 他平面の中心線吸収の対象を調べる（**平面単位**。1平面につき1回peekし、値ごとの吸収対象idを
//      Mapへまとめる——findCenterLinesToAbsorbForValues。書込みは手順fで行う）。
//   e. 手順eの前にアクティブ再確認（graph!==project.activeGraphなら中止。QA指摘6・
//      promoteCenterToGridWithUndoのM-2ガードと同型）。通り芯を追加し、自階の吸収対象梁芯
//      （手順b）を撤去する。
//   f. 他平面の中心線を吸収する（**平面単位**。1平面につき1回のbefore/afterへまとめて保存する
//      ——applyCenterLineAbsorptionForValues。線種変更の移籍一本化 ステップ6是正・2026-09-30・
//      QA指摘1: 値ごとに独立してbefore/afterを作る旧実装は、同じ平面を複数の値で吸収すると
//      後の値の保存が先の値の吸収結果を上書きし1本しか残らない不良になっていた——移籍後に書く
//      ことに変わりはない）。失敗したら自階・structGraph・floorRecordsをすべて巻き戻す。
//   g. undo/redoを積む（promoteCenterToGridWithUndoと同じ型——beforeArch/afterArch・
//      beforeStruct/afterStruct・floorRecordsを1つのundoエントリにまとめる）。
//   h. 自階の同座標の重複（スパン配列で黙って飛ばす既存挙動）はこの関数の範囲外——呼び出し側が
//      values に渡す前に除外済みという前提（addCenterLineFromDialogのnewValuesフィルタ参照）。
// 性能: 値ごとに他平面をpeekする手順a・cは値の数だけ他平面を繰り返しpeekする——1平面1回の
// peekにまとめる余地がある（設計§3後段。既知の残件。findFloorsWithCounterpartCL・
// absorbWallBeamAxesOnPromoteはfloorSwapManager.peekのメモ化キャッシュを持たない独立呼び出しの
// ため）。手順d・fは平面単位へ改めたため、この性能残件の対象ではない（QA指摘1是正）。
// @param {import('@core').PlanGraph} graph 自階グラフ（アクティブ階）
// @param {object} project
// @param {object} opts
// @param {string} opts.clType CenterLineType
// @param {number[]} opts.values 追加する座標（単体は要素1つの配列）
// @param {object} opts.props project.structGraph.addCenterLine へ渡すprops（discipline:STRUCT前提）
// @param {string|null} opts.syncScope structuralSyncScopeOfKind('struct')相当（常に'all'のはずだが
//   呼び出し側の値をそのまま使う）
// @param {Function} [opts.saveFloorFn] テスト用の差し替え（既定はcenterLineFloorSync.js側のsaveFloor）
// @returns {Promise<{ done: boolean, toast: string|null }>}
async function addGridLinesWithFloorAbsorption(graph, project, { clType, values, props, syncScope, saveFloorFn }) {
  const isVertical = clType === CenterLineType.VERTICAL;
  const axisLabel = isVertical ? 'X' : 'Y';

  // a. 他平面の同座標チェック（全体拒否。何も書かない）。
  const blockedByValue = [];
  for (const v of values) {
    const floors = await findFloorsWithCounterpartCL(project, graph, { centerLineType: clType, value: v }, {
      excludeAbsorbableBeam: true, absorbCenter: true,
    });
    if (floors.length > 0) {
      blockedByValue.push({ value: v, floorsByKind: floors.map(f => ({ name: f.plane.name, kind: f.kind })) });
    }
  }
  if (blockedByValue.length > 0) {
    const toast = values.length === 1
      ? ERR_CL_ADD_DUP_FLOOR(blockedByValue[0].floorsByKind)
      // QA指摘4: 値は画面表示（ui/AddCLDialog.jsx `Math.round(sign * value)`。Y軸は符号反転）に
      // 合わせる——ワールド座標をそのまま出すと通り芯追加ダイアログの表示値と符号・丸めが食い違う。
      : ERR_CL_ADD_DUP_FLOOR_SPAN(blockedByValue.map(({ value, floorsByKind }) =>
          ({ axis: axisLabel, value: Math.round((isVertical ? 1 : -1) * value), floorsByKind })));
    return { done: false, toast };
  }

  // b. 自階の壁由来梁芯（裁定Q8）。線種変更の移籍一本化 ステップ6是正（2026-09-30）: 同座標に
  // 区間の離れた梁芯が複数本ありうるため findWallBeamAxisCLs（複数形）で全て列挙する——1本でも
  // 保護されれば拒否、そうでなければ全部吸収対象にする。
  const ownAbsorbableBeamIds = [];
  for (const v of values) {
    const beamAxes = findWallBeamAxisCLs(graph, isVertical, v);
    if (beamAxes.length === 0) continue;
    if (beamAxes.some(ax => isProtectedWallBeamAxis(graph, ax))) {
      return { done: false, toast: ERR_CL_DUPLICATE('beam') };
    }
    for (const ax of beamAxes) ownAbsorbableBeamIds.push(ax.id);
  }

  // c. 他平面の保護されない壁由来梁芯を吸収する（移籍＝追加の前）。
  const floorRecords = [];
  for (const v of values) {
    let blockedPlanes;
    try {
      ({ blockedPlanes } = await absorbWallBeamAxesOnPromote(project, graph, { centerLineType: clType, value: v }, {
        undoRecords: floorRecords,
        ...(saveFloorFn ? { saveFloorFn } : {}),
      }));
    } catch (e) {
      await rollbackFloorRecords(floorRecords, saveFloorFn, project);
      throw e;
    }
    if (blockedPlanes.length > 0) {
      // 手順aで弾かれているはずの防御——実際には到達しない想定（promoteCenterToGridWithUndoの
      // 同型ガードと同じ理由）。
      await rollbackFloorRecords(floorRecords, saveFloorFn, project);
      return { done: false, toast: ERR_CL_ADD_DUP_FLOOR(blockedPlanes.map(p => ({ name: p.name, kind: 'beam' }))) };
    }
  }

  // d. 他平面の中心線吸収の対象（平面単位。peekのみ。書込みはfで行う）。線種変更の移籍一本化
  // ステップ6是正（2026-09-30・QA指摘1）: 値ごとに独立してpeekしていた旧実装は、同じ平面を複数の
  // 値で吸収すると、後で処理した値の保存が先に処理した値の吸収結果を上書きして1本しか残らない
  // 不良になっていた（実測）——findCenterLinesToAbsorbForValuesで1平面につき1回peekしてまとめる。
  const absorbTargets = await findCenterLinesToAbsorbForValues(project, graph, { centerLineType: clType, values });

  // 手順e（追加）の前にアクティブ再確認（QA指摘6。promoteCenterToGridWithUndoのM-2ガードと同型）:
  // 他平面peek（IDBを伴うawait）の間に階が切り替わった可能性があるため、書込み前に検出すれば
  // rollbackFloorRecordsで足りる（floorRecordsは手順cの梁芯吸収分のみ。ここまでは自階・structGraph
  // とも未変更のためrestoreStructCLs/restoreGraphは不要）。
  if (graph !== project.activeGraph) {
    await rollbackFloorRecords(floorRecords, saveFloorFn, project);
    return { done: false, toast: null, aborted: true };
  }

  // e. 追加し、自階の吸収対象梁芯（手順b）を撤去する。
  const beforeArch = serializeGraph(graph);
  const beforeStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const addedIds = [];
  runInAction(() => {
    for (const v of values) addedIds.push(project.structGraph.addCenterLine(clType, v, props).id);
    for (const id of ownAbsorbableBeamIds) graph.removeCenterLine(id);
  });
  const gridIdByValue = new Map(values.map((v, i) => [v, addedIds[i]]));

  // f. 他平面の中心線を吸収する（移籍後。平面ごとに1回のbefore/afterへまとめて保存する
  // ——applyCenterLineAbsorptionForValuesのJSDoc「平面単位」参照）。
  let conflictPlane;
  try {
    ({ conflictPlane } = await applyCenterLineAbsorptionForValues(absorbTargets, gridIdByValue, {
      undoRecords: floorRecords,
      ...(saveFloorFn ? { saveFloorFn } : {}),
    }));
  } catch (e) {
    await rollbackFloorRecords(floorRecords, saveFloorFn, project);
    restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
    restoreGraph(graph, beforeArch);
    throw e;
  }
  if (conflictPlane) {
    await rollbackFloorRecords(floorRecords, saveFloorFn, project);
    restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
    restoreGraph(graph, beforeArch);
    return { done: false, toast: ERR_CL_CONVERT_ABSORB_CONFLICT_FLOOR(conflictPlane.name) };
  }

  // g. undo/redoを積む（promoteCenterToGridWithUndoと同じ型）。
  const notify = (records) => { if (syncScope) structuralSyncListener?.(graph, project, syncScope, records); };
  const afterArch = serializeGraph(graph);
  const afterStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  undoManager.push(
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, beforeStruct, project.memberGroupLedger);
      restoreGraph(graph, beforeArch);
      applyFloorUndoRecords(project, floorRecords, 'before', saveFloorFn);
      notify();
    },
    () => {
      restoreStructCLs(project.structGraph, project.structuralInfo, afterStruct, project.memberGroupLedger);
      restoreGraph(graph, afterArch);
      applyFloorUndoRecords(project, floorRecords, 'after', saveFloorFn);
      notify();
    },
  );
  notify(floorRecords);

  return { done: true, toast: null };
}

// ---- AddCLDialog確定（handleCLDialogConfirm） ----
// extent解決・重複判定（ERR_CL_DUPLICATE等）・結合連鎖（mergeCenterLineChain/composeUndoWithMergeChain）・
// undo登録を行う。ダイアログを閉じる setState・木造提案 ConfirmDialog の表示は呼び出し側（App.jsx）。
// @param {object} payload { clDialog, value, kind, refId, refOffset }
// @param {object} [opts] - opts.saveFloorFn はテスト用の差し替え（既定はcenterLineFloorSync.js側のsaveFloor。
//   段階(g)・2026-09-26。構造同期が非アクティブ階へ書く際のsave差し替えに使う——probeで実IDBへの
//   誤書込みを防ぐため必須）。
// @returns {Promise<{ done: boolean, toast: string|null, suggestWood: {clType, newValues}|null }>}
export async function addCenterLineFromDialog(graph, project, payload, viewport, opts = {}) {
  const { clDialog, value, kind, refId, refOffset } = payload;
  const clType = clDialog.type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  // 段階(c)・2026-09-25: 「操作×種別」の専用表は作らず、削除・移動と同じstructuralSyncScopeOfKindを
  // 使う（struct='all'、center='activeAndAbove'、aux=null）。梁芯（kind='beam'）は専用経路
  // （下のif (kind === 'beam')ブロック）を通り、ここでは触らない——nullなのでpushUndoWithStructuralSync
  // 経由でも実害はないが、梁芯追加は既存のグラフスナップショット方式のままにする（design-c.md item2）。
  const syncScope = structuralSyncScopeOfKind(kind);

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
    // 線種変更の移籍一本化・ステップ6（2026-09-30・裁定Q4〜Q6・Q8）: 他平面の同座標チェック・
    // 自階/他平面の梁芯吸収・他平面の中心線吸収は addGridLinesWithFloorAbsorption に一本化する
    // （単体追加＝下のkind==='struct'分岐と処理を共有——他平面の処理を2回書かない）。自階の同座標
    // 重複（黙って飛ばす既存挙動）は上のfilterで既に除いてある（設計h・この関数の範囲外）。
    const result = await addGridLinesWithFloorAbsorption(graph, project, {
      clType, values: newValues,
      props: { discipline: Discipline.STRUCT, labeled: true },
      syncScope,
      saveFloorFn: opts.saveFloorFn,
    });
    // QA指摘6: 手順eの前のアクティブ再確認で中止した場合はtoast:nullで戻るため、そのまま素通しすると
    // 成功扱い（done:true）になってしまう——promoteCenterToGridWithUndoのaborted処理と同型。
    if (result.aborted) return { done: false, toast: null, suggestWood: null };
    if (!result.done) return { done: false, toast: result.toast, suggestWood: null };
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
  // 移籍して通り芯化）に入らず、通り芯・中心線・補助線が3本併存する（並び順依存。QA指摘）。
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
        pushUndoWithStructuralSync(
          graph, project, syncScope,
          () => runInAction(chainResult.undo),
          () => runInAction(chainResult.redo),
          opts.saveFloorFn,
        );
        return { done: true, toast: null, suggestWood: null };
      }
    }

    // 梁芯の手動追加は他種別（通り芯/中心/補助線）と同位置に共存できない（大梁と完全重複する小梁の
    // 生成防止）。kind==='beam'は coexistenceAt(kind, existingKind) で判定できる（beam行はbeam自身
    // 以外すべてforbiddenのため、existingKind!=='beam'と同値）。
    // kind==='struct'側（通り芯の追加が既存の梁芯と同座標のとき）は、線種変更の移籍一本化・
    // ステップ6是正（2026-09-30・裁定Q8・COEXISTENCE.struct.beam='absorb'）により、ここでは
    // 拒否しない——addGridLinesWithFloorAbsorptionが自階の壁由来梁芯を「保護されなければ吸収・
    // 保護されれば拒否」で判定する（同座標に中心線があり昇格分岐（promote）へ入る場合は、ここへ
    // 来る前に下のif（coexistenceAt==='promote'）で処理される）。
    if (kind === 'beam' && coexistenceAt(kind, existingKind) === 'forbidden') {
      return { done: false, toast: ERR_CL_DUPLICATE(existingKind), suggestWood: null };
    }

    if (coexistenceAt(kind, existingKind) === 'promote') {
      // 線種変更の移籍一本化・ステップ5（2026-09-30）: 削除して作り直す旧経路を廃止し、メニューと
      // 同じpromoteCenterToGridWithUndo（移籍。他平面の吸収・Q11の同id拒否・undoを含む）へ委譲する。
      // 裁定Q7: 既存の中心線（existing）の座標・参照（refId・extent）をそのまま使う——ダイアログの
      // value・refId・refOffsetは捨てる（existingを渡すだけで自動的に満たされる）。
      const { toast: promoteToast, aborted } = await promoteCenterToGridWithUndo(graph, project, existing, {
        ...(opts.saveFloorFn ? { saveFloorFn: opts.saveFloorFn } : {}),
      });
      // QA指摘是正: promoteCenterToGridWithUndoが中止（階が変わった・clが消えた・移籍後の再確認不成立）
      // した場合はtoast:nullで戻るため、そのまま素通しすると成功扱い（done:true＋Q9文言）になってしまう
      // ——aborted:trueのときは失敗扱い（done:false・toastなし・ダイアログは閉じない）にする。
      if (aborted) return { done: false, toast: null, suggestWood: null };
      if (promoteToast) return { done: false, toast: promoteToast, suggestWood: null };
      // 裁定Q9: 文言は「削除して作り直す」ではなく「移籍」の実態に合わせる（error.js参照）。
      return { done: true, toast: ERR_CL_CENTER_UPGRADED, suggestWood: { clType, newValues: [existing.value] } };
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
    ...(kind === 'beam'   ? { discipline: Discipline.FUSE, labeled: false, beamAxisOrigin: BeamAxisOrigin.USER } : {}),
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

  if (kind === 'struct') {
    // 線種変更の移籍一本化・ステップ6（2026-09-30・裁定Q4〜Q6・Q8）: 単体追加もスパン配列と同じ
    // addGridLinesWithFloorAbsorptionへ委譲する（他平面の処理を2回書かない。上のスパン配列分岐参照）。
    const result = await addGridLinesWithFloorAbsorption(graph, project, {
      clType, values: [value], props, syncScope,
      saveFloorFn: opts.saveFloorFn,
    });
    // QA指摘6: 手順eの前のアクティブ再確認で中止した場合はtoast:nullで戻るため、そのまま素通しすると
    // 成功扱い（done:true）になってしまう——promoteCenterToGridWithUndoのaborted処理と同型。
    if (result.aborted) return { done: false, toast: null, suggestWood: null };
    if (!result.done) return { done: false, toast: result.toast, suggestWood: null };
    return { done: true, toast: null, suggestWood: { clType, newValues: [value] } };
  }

  const cl = targetGraph.addCenterLine(clType, value, props);
  const clId = cl.id;
  // center/auxはtargetGraph===graphのため、graph.removeCenterLine自体が既にdetach→
  // removeDependentsOfCenterLineを内包しており従来どおりでよい（structはaddGridLinesWithFloorAbsorption
  // 経由のため、ここに到達するのはcenter/auxのみ）。
  pushUndoWithStructuralSync(
    graph, project, syncScope,
    () => targetGraph.removeCenterLine(clId),
    () => targetGraph.addCenterLine(clType, value, props, clId),
    opts.saveFloorFn,
  );
  return { done: true, toast: null, suggestWood: null };
}
