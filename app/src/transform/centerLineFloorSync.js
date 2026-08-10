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
 * @returns {Promise<Plane[]>} 見つかった Plane（0件なら変換して問題ない）
 */
export async function findFloorsWithCounterpartCL(project, activeGraph, cl) {
  const result = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const hasCounterpart = temp.centerLines.some(other =>
      !other.labeled
      && other.centerLineType === cl.centerLineType
      && Math.abs(other.value - cl.value) < CL_OVERLAP_TOL_MM
    );
    if (hasCounterpart) result.push(plane);
  }
  return result;
}

/**
 * 降格（通り芯→中心）後、アクティブ以外の全 Plane へ同一 id で中心線を複製する。
 * extent は昇格前と同じ最外郭通り芯2本への ref（loCL/hiCL）にする。
 * undoEntry を渡すと、変更した各階の before/after を undoManager.amend で合成する
 * （eccentricityFloorSync.js の propagateCLEccentricities と同じパターン）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  降格を実行した階のグラフ（アクティブ階）
 * @param {CenterLine} cl          降格後の中心線（graph.adoptCenterLine 済み）
 * @param {{loCL, hiCL, undoEntry?: object|null}} opts
 */
export async function propagateDemotedCenterLine(project, activeGraph, cl, { loCL, hiCL, undoEntry = null }) {
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
      await saveFloor(plane.id, serializeGraph(temp));
      if (undoEntry) undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
    }
  } finally {
    // ループ途中で例外（IDB書込失敗等）が起きても、そこまでに保存できた分だけは undo で
    // 戻せるよう必ず amend する（一部の階だけ複製された不整合な状態のまま undo 不能になるのを防ぐ）。
    // finally を抜けた後、例外があれば自然に再スローされる（catchしていないため）。
    if (undoEntry && undoRecords.length > 0) {
      const applyBytes = (which) => {
        for (const rec of undoRecords) {
          if (project.activePlane?.id === rec.planeId) {
            restoreGraph(project.activeGraph, rec[which]); // undo実行時にその階がアクティブなら生きているグラフへ復元
          } else {
            saveFloor(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
          }
        }
      };
      undoManager.amend(undoEntry, () => applyBytes('before'), () => applyBytes('after'));
    }
  }
}
