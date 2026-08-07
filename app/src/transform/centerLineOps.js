// CL（通り芯・中心線・補助線・梁芯）に対するユーザー操作（移動確定・ストレッチ確定・削除・
// AddCLDialog確定・木造提案判定）の実処理＋Undo登録。App.jsx から状態を持たない純粋な形へ
// 抽出したもの（挙動は元コードのまま。呼び出し側の setState・modeRef 操作だけを App.jsx に残す）。
import { runInAction } from 'mobx';
import { CenterLineType, Discipline, centerLineKind, CL_OVERLAP_TOL_MM } from '@core';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import { ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS } from '../error.js';
import { findBracketingCLs, overhangMm } from '../snapGeometry.js';
import { calcStep } from '../renderer/clMoveMath.js';
import { mergeCenterLineChain, composeUndoWithMergeChain } from './centerLineMerge.js';
import { resolveSecondaryBeamsForAxis } from '../structural/beamAxisMove.js';
import { renumberMembers } from '../structural/memberNumbering.js';
import { autoFillSecondaryBeams, autoFillBeamEccentricity } from '../structural/structuralAutoFill.js';

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
    let chainResult = { merged: false };
    runInAction(() => {
      bakeCLValue(cl, newValue);
      // 通り芯(labeled:true)は結合対象外。編集確定のたびに隣接する中心線との結合を確認する
      if (!cl.labeled) chainResult = mergeCenterLineChain(graph, cl, { kind: centerLineKind(cl) });
    });
    const [undoFn, redoFn] = composeUndoWithMergeChain(
      () => bakeCLValue(cl, originalValue),
      () => bakeCLValue(cl, newValue),
      chainResult,
    );
    undoManager.push(() => runInAction(undoFn), () => runInAction(redoFn));
    return { toast: null };
  }

  // ---- 梁芯: グラフスナップショット方式（局所再解決・再採番を含む1 undoエントリ）----
  const before = serializeGraph(graph);
  let counts = { before: 0, after: 0 };
  runInAction(() => {
    // 移動＝元位置の放棄と解釈する。次回のモード境界再計算で「壁由来の梁芯自動生成」が元の座標に
    // 復活しないよう、移動前の座標を除外集合へ記録する（cl-del分岐の記録と同じ意味・同じキー形式。
    // 手動追加の梁芯を動かした場合も無害——その座標に壁が無ければ単に使われないキーが残るだけ）。
    const axisKey = cl.centerLineType === CenterLineType.VERTICAL ? 'X' : 'Y';
    graph.excludedWallBeamAxes.add(`${axisKey}:${Math.round(originalValue)}`);
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

// ---- ストレッチ確定（交点 or 自由点のドラッグをbake→Undo登録）----
// ジェスチャー判定（stretchState の有無・commitStretch()呼び出し・ref のクリア）は呼び出し側（App.jsx）
// が担う。ここでは「graph 変更＋undo push」だけを行う。
// @param {{ target, originalVVal?, originalHVal?, originalX?, originalY? }} ss modeRef.current.stretchState
export function commitStretchWithUndo(ss) {
  const { target } = ss;
  if (target.type === 'intersection') {
    const clV = target.vertex.clVertical;
    const clH = target.vertex.clHorizontal;
    const newVVal  = clV.effectiveValue;
    const newHVal  = clH.effectiveValue;
    const origVVal = ss.originalVVal;
    const origHVal = ss.originalHVal;
    if (newVVal !== origVVal || newHVal !== origHVal) {
      runInAction(() => { bakeCLValue(clV, newVVal); bakeCLValue(clH, newHVal); });
      undoManager.push(
        () => runInAction(() => { bakeCLValue(clV, origVVal); bakeCLValue(clH, origHVal); }),
        () => runInAction(() => { bakeCLValue(clV, newVVal);  bakeCLValue(clH, newHVal);  }),
      );
    } else {
      runInAction(() => { clV.pendingDelta = 0; clH.pendingDelta = 0; });
    }
  } else {
    const pt   = target.vertex;
    const newX = pt.effectiveX, newY = pt.effectiveY;
    const origX = ss.originalX,  origY = ss.originalY;
    if (newX !== origX || newY !== origY) {
      runInAction(() => { pt.x = newX; pt.y = newY; pt.pendingDX = 0; pt.pendingDY = 0; });
      undoManager.push(
        () => runInAction(() => { pt.x = origX; pt.y = origY; }),
        () => runInAction(() => { pt.x = newX;  pt.y = newY;  }),
      );
    } else {
      runInAction(() => { pt.pendingDX = 0; pt.pendingDY = 0; });
    }
  }
}

// ---- CL削除（メニューの cl-del）----
// 通り芯（discipline:STRUCT かつ labeled）は structGraph 経由でスナップショット方式のUndo、
// それ以外（中心線・補助線・梁芯）は excludedWallBeamAxes 記録（梁芯のみ）＋removeCenterLine。
// 呼び出し側（App.jsx）はメニューを閉じる等の setState を行う。
export function deleteCenterLineWithUndo(graph, project, cl) {
  const isStruct = cl.discipline === Discipline.STRUCT && cl.labeled;
  if (isStruct) {
    // 通り芯の削除 — structGraph をスナップショット経由で Undo。
    // structGraph の teardown は階グラフの図形に届かないため、アクティブ階グラフ側の
    // 壁端・extent 参照を先に切り離す（端点ルール）。階グラフも Undo 対象に含める。
    const beforeArch = serializeGraph(graph);
    const before = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    graph.detachFromCenterLine(cl.id);
    project.structGraph.removeCenterLine(cl.id);
    const afterArch = serializeGraph(graph);
    const after = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
    undoManager.push(
      () => {
        restoreStructCLs(project.structGraph, project.structuralInfo, before, project.memberGroupLedger);
        restoreGraph(graph, beforeArch);
      },
      () => {
        restoreStructCLs(project.structGraph, project.structuralInfo, after, project.memberGroupLedger);
        restoreGraph(graph, afterArch);
      },
    );
  } else {
    const before = serializeGraph(graph);
    // 梁芯CLの削除は「壁由来の梁芯自動生成」に対する明示的な手動削除として扱う——次回のモード境界
    // 再計算で元の座標に再生成されないよう、座標ベースの除外集合へ記録する（壁の位置自体は削除しない
    // ため、記録しないと自動生成が復活させてしまう）。キーは structural/wallBeamAxes.js と同じ形式。
    runInAction(() => {
      if (centerLineKind(cl) === 'beam') {
        const axisKey = cl.centerLineType === CenterLineType.VERTICAL ? 'X' : 'Y';
        graph.excludedWallBeamAxes.add(`${axisKey}:${Math.round(cl.effectiveValue)}`);
      }
      graph.removeCenterLine(cl.id);
    });
    const after = serializeGraph(graph);
    undoManager.push(
      () => restoreGraph(graph, before),
      () => restoreGraph(graph, after),
    );
  }
}

// 木造（在来）の自動判定（問題.md）: 平面モードで主構造が未指定のとき、追加した通り芯が
// 既存グリッドと910の倍数間隔をなすなら「木造（在来）」を提案する確認ダイアログを出す。
// 「寸法指定を910で割った余りが0」を、隣接グリッドCLとの最小間隔で判定する（参照なし絶対座標入力にも効く）。
// この関数は「提案すべきか」の判定部のみを行う純関数。ダイアログ表示（setFloorConfirm）は呼び出し側（App.jsx）。
export function shouldSuggestWoodStructure(graph, project, appMode, clType, newValues) {
  if (appMode !== 'floorplan') return false;
  if (project.structuralInfo.mainStructure !== '未定') return false; // 既に主構造が確定済みなら提案しない
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
    const newValues = value.filter(v =>
      !graph.centerLines.some(cl => cl.centerLineType === clType && Math.abs(cl.value - v) < CL_OVERLAP_TOL_MM)
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
    const perpType = clType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const wc = clDialog.worldCoord;
    const perpCLs = graph.centerLines.filter(cl => {
      if (cl.centerLineType !== perpType) return false;
      if (kind === 'beam') {
        // 梁芯の端部候補は通り芯（labeled）のみに限定する。中心線・補助線を候補に含めると
        // 直交グリッド（autoFillSecondaryBeamsが見るgraph.gridXs/Ys＝通り芯のみ）に存在しない
        // 区画へextentが確定してしまい、小梁が0本になる事故になる（QA指摘）。
        return cl.labeled;
      }
      // center: 梁芯（discipline:'fuse'。構造モード専用表示で他モードでは非表示）は
      // 端部候補から除外する——非表示の線が中心線のextent端部に選ばれるのを防ぐ。
      if (centerLineKind(cl) === 'beam') return false;
      // 非ラベルCL: extentLo/Hi の実範囲（はね出し前）に新規CLの座標が含まれるものだけ対象
      if (!cl.labeled && cl.extentLo != null && cl.extentHi != null) {
        if (wc < cl.extentLo || wc > cl.extentHi) return false;
      }
      return true;
    });
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
    const perpType = clType === CenterLineType.VERTICAL ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const isNewV   = clType === CenterLineType.VERTICAL;
    const wc       = clDialog.worldCoord;
    const pc       = clDialog.perpCoord;
    const overhang = overhangMm(viewport, false);

    // フリーエンドポイント用: ポインティング座標をキリ良い数値に丸める
    const niceStep = calcStep(viewport.scaleDenominator);
    const roundToNiceCoord = (coord) =>
      niceStep > 0 ? Math.round(coord / niceStep) * niceStep : Math.round(coord);

    // 直交壁を検出（新CLの座標が壁の長手範囲に含まれるもの）
    const perpWalls = graph.walls.filter(w => {
      if (w.isVertical === isNewV) return false;
      const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
      return c1 <= wc && wc <= c2;
    });
    const loWall = perpWalls.filter(w => w.axisValue <= pc)
      .reduce((best, w) => !best || w.axisValue > best.axisValue ? w : best, null);
    const hiWall = perpWalls.filter(w => w.axisValue >= pc)
      .reduce((best, w) => !best || w.axisValue < best.axisValue ? w : best, null);

    // 直交CLを検出（非ラベルCLは延伸範囲内のもののみ）
    const allPerpCLs = graph.centerLines.filter(cl => {
      if (cl.centerLineType !== perpType) return false;
      if (!cl.labeled && cl.extentLo != null && cl.extentHi != null) {
        if (wc < cl.extentLo || wc > cl.extentHi) return false;
      }
      return true;
    });
    const [loCL, hiCL] = findBracketingCLs(allPerpCLs, pc);

    // 既存補助線が指定CLを extentLoRef/HiRef で参照しているか
    const anyAuxRefsCL = (cl) => graph.centerLines.some(ex =>
      ex.lineType === 'dashed' && !ex.labeled &&
      (ex.extentLoRef?.clId === cl.id || ex.extentHiRef?.clId === cl.id)
    );

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
      if (anyAuxRefsCL(bestLo.item)) {
        // 既存補助線が同じCLを参照 → リアクティブ参照（CLと連動してトリム）
        loRef       = { clId: bestLo.item.id, offset: 0 };
        newExtentLo = bestLo.val;
      } else {
        // 既存参照なし → はね出し（静的座標）
        loStaticVal = bestLo.val - overhang;
        newExtentLo = loStaticVal;
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
      if (anyAuxRefsCL(bestHi.item)) {
        hiRef       = { clId: bestHi.item.id, offset: 0 };
        newExtentHi = bestHi.val;
      } else {
        hiStaticVal = bestHi.val + overhang;
        newExtentHi = hiStaticVal;
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
  const existing = graph.centerLines.find(
    cl => cl.centerLineType === clType && Math.abs(cl.value - value) < CL_OVERLAP_TOL_MM
  );
  if (existing) {
    const existingKind = centerLineKind(existing);

    if (kind === existingKind) {
      if (kind === 'struct') {
        return { done: false, toast: ERR_CL_DUPLICATE(kind), suggestWood: null };
      }
      // center / aux: extent が重ならなければ追加を許可
      const exLo = existing.extentLo;
      const exHi = existing.extentHi;
      const extentsOverlap =
        newExtentLo == null || newExtentHi == null ||
        exLo == null || exHi == null ||
        !(newExtentHi <= exLo || newExtentLo >= exHi);
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

    // 梁芯は他種別（通り芯/中心/補助線）と同位置に共存できない（大梁と完全重複する小梁の生成防止）。
    // 逆方向（既存が梁芯で新規が別種別）も同様に拒否する。
    if (kind !== existingKind && (kind === 'beam' || existingKind === 'beam')) {
      return { done: false, toast: ERR_CL_DUPLICATE(existingKind), suggestWood: null };
    }

    if (kind === 'struct' && existingKind === 'center') {
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

    if (kind === 'center' && existingKind === 'struct') {
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
      const axisKey = clType === CenterLineType.VERTICAL ? 'X' : 'Y';
      graph.excludedWallBeamAxes.delete(`${axisKey}:${Math.round(newCl.effectiveValue)}`);
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
