// 中心⇔通り芯の入替えの階またぎ同期。finish/eccentricityFloorSync.js（peek→操作→saveFloor→
// undoManager.amend という階またぎ同期パターン）を雛形にする。
//
// findFloorsWithCounterpartCL は昇格・降格の双方の事前ガードとして使う（スキップ方式は不採用——
// 片階だけ複製漏れすると壁参照が壊れるため、1階でも重複していれば全体を拒否する）:
//   昇格（中心→通り芯）: 通り芯化すると全階の同じグリッドに現れる。既に他階の同じ座標に
//   意匠側の中心線・補助線があると座標が重複して混乱するため、昇格前に拒否する。
//   降格（通り芯→中心）: 降格後に他階へ複製する座標が、既にその階にある中心線・補助線と
//   衝突しないことを事前に確認する（複製自体は下記 propagateDemotedCenterLine）。
// 降格（通り芯→中心）: アクティブ階にだけ中心線が現れるのは不整合（通り芯は全階共通だった）
// なので、非アクティブの全階へ同一idで複製する（propagateDemotedCenterLine）。
import { runInAction } from 'mobx';
import { Discipline, CL_OVERLAP_TOL_MM } from '@core';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { saveFloor } from '../storage/db.js';
import { undoManager } from '../undoManager.js';

// アクティブ以外の全 Plane（project.planeMap。検討・屋根 Plane 含む）を返す。
function otherPlanes(project, activeGraph) {
  const activeId = activeGraph?.plane?.id;
  return [...project.planeMap.values()].filter(p => p.id !== activeId);
}

/**
 * 昇格・降格双方の事前ガードとして使う: cl と同じ centerLineType・ほぼ同じ座標に非labeled CL
 * （中心線・補助線・梁芯）を持つ Plane を、アクティブ以外の全 Plane から探す。
 * 昇格（centerLineOps.js の promoteCenterToGridWithUndo）は cl がまだ中心線のときに呼び、
 * 降格（demoteGridToCenterWithUndo）は cl がまだ通り芯のときに呼ぶ——どちらも
 * cl.centerLineType/cl.value は変換前の値をそのまま使えるため、呼び出し側の型は同じでよい。
 * 同一 id の CL は重複として報告しない——降格（propagateDemotedCenterLine）が非アクティブ全階へ
 * 複製した「同じ線の分身」であり、昇格の回収対象（recallPromotedCenterLineDuplicates）である
 * ため、ここで重複扱いにすると同じ線の往復（降格→昇格）が永久に塞がれてしまう。
 * @returns {Promise<Plane[]>} 見つかった Plane（0件なら変換して問題ない）
 */
export async function findFloorsWithCounterpartCL(project, activeGraph, cl) {
  const result = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const hasCounterpart = temp.centerLines.some(other =>
      other.id !== cl.id
      && !other.labeled
      && other.centerLineType === cl.centerLineType
      && Math.abs(other.value - cl.value) < CL_OVERLAP_TOL_MM
    );
    if (hasCounterpart) result.push(plane);
  }
  return result;
}

// propagateDemotedCenterLine / recallPromotedCenterLineDuplicates 共通: ループ途中で例外
// （IDB書込失敗等）が起きても、そこまでに保存できた分だけは undo で戻せるよう必ず amend する
// （一部の階だけ複製・回収された不整合な状態のまま undo 不能になるのを防ぐ）。
// 呼び出し側は finally で呼ぶこと——finally を抜けた後、例外があれば自然に再スローされる
// （catchしていないため）。saveFloorFn は呼び出し時に渡されたものを使う（往復テストのため、
// undo/redo時の書き戻しもテスト用の差し替えに乗せられるようにする）。
function amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn) {
  if (!undoEntry || undoRecords.length === 0) return;
  const applyBytes = (which) => {
    for (const rec of undoRecords) {
      if (project.activePlane?.id === rec.planeId) {
        restoreGraph(project.activeGraph, rec[which]); // undo実行時にその階がアクティブなら生きているグラフへ復元
      } else {
        saveFloorFn(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
      }
    }
  };
  undoManager.amend(undoEntry, () => applyBytes('before'), () => applyBytes('after'));
}

/**
 * 降格（通り芯→中心）後、アクティブ以外の全 Plane へ同一 id で中心線を複製する。
 * extent は昇格前と同じ最外郭通り芯2本への ref（loCL/hiCL）にする。
 * undoEntry を渡すと、変更した各階の before/after を undoManager.amend で合成する
 * （eccentricityFloorSync.js の propagateCLEccentricities と同じパターン）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  降格を実行した階のグラフ（アクティブ階）
 * @param {CenterLine} cl          降格後の中心線（graph.adoptCenterLine 済み）
 * @param {{loCL, hiCL, undoEntry?: object|null, saveFloorFn?: Function}} opts
 */
export async function propagateDemotedCenterLine(project, activeGraph, cl, { loCL, hiCL, undoEntry = null, saveFloorFn = saveFloor }) {
  const undoRecords = [];
  try {
    for (const plane of otherPlanes(project, activeGraph)) {
      const temp = await floorSwapManager.peek(plane, project.structGraph);
      const before = undoEntry ? serializeGraph(temp) : null;
      runInAction(() => {
        temp.addCenterLine(cl.centerLineType, cl._value, {
          labeled: false, discipline: Discipline.ARCH, lineType: 'center', trim: cl.trim,
          refId: cl.refId, refOffset: cl.refOffset,
          extentLoRef: { clId: loCL.id, offset: 0 },
          extentHiRef: { clId: hiCL.id, offset: 0 },
        }, cl.id);
        temp.columnAxisOffsets.delete(cl.id);
      });
      await saveFloorFn(plane.id, serializeGraph(temp));
      if (undoEntry) undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
    }
  } finally {
    amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn);
  }
}

/**
 * 昇格（中心線→通り芯）成功後、アクティブ以外の全 Plane にある「同一 id の中心線複製」
 * （降格時に propagateDemotedCenterLine が複製したもの）を回収する。
 * 昇格により cl.id は project.structGraph 側の通り芯として解決されるようになるため、非アクティブ
 * 階に残った同一 id の複製は「同じ線の分身」であり、回収しないと graph.centerLines に同一 id が
 * 2件現れる不整合になる（他階の壁は id 参照のため見た目上は壊れないが、状態としては誤り）。
 *
 * removeCenterLine は使わない（壁が道連れ削除される）。
 * detachFromCenterLine は呼ばない（アクティブ階の applyPromoteToGrid と対称。extent/refId は
 * id のまま structGraph 側の通り芯へ解決される——releaseCenterLine は shapeMap から外すだけで
 * 壁の axisCL/clStart/clEnd 参照（id・オブジェクト identity）自体は無傷のため、他階の壁は消えない）。
 * temp は使い捨て（peek はキャッシュしない。FloorSwapManager.js peek 参照）。
 * 回収は昇格確定後に置く（先に回収して途中失敗すると、複製を失った階の壁が restoreGraph で
 * 捨てられる）。
 * clEccentricities / columnAxisOffsets は触らない（降格時の複製がそもそも設定しないため）。
 *
 * @param {object} project
 * @param {PlanGraph} activeGraph  昇格を実行した階のグラフ（アクティブ階）
 * @param {CenterLine} cl          昇格後の通り芯（project.structGraph.adoptCenterLine 済み）
 * @param {{undoEntry?: object|null, saveFloorFn?: Function}} [opts]
 */
export async function recallPromotedCenterLineDuplicates(project, activeGraph, cl, { undoEntry = null, saveFloorFn = saveFloor } = {}) {
  const undoRecords = [];
  try {
    for (const plane of otherPlanes(project, activeGraph)) {
      const temp = await floorSwapManager.peek(plane, project.structGraph);
      const before = undoEntry ? serializeGraph(temp) : null;
      const released = runInAction(() => temp.releaseCenterLine(cl.id));
      if (!released) continue; // この階に同一id複製が無い → saveFloorせずスキップ
      await saveFloorFn(plane.id, serializeGraph(temp));
      if (undoEntry) undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
    }
  } finally {
    amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn);
  }
}
