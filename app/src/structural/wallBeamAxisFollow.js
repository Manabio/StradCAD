// 壁由来梁芯の追従（壁再生成をFinishModeStateから独立させる計画のステップ2）。
// wallBeamAxes.js（純な収集・対応づけ・検索）と分離したのは、ここだけが実際に CL の値・
// 除外集合を書き換える（runInAction・undo/redo・transform/centerLineOps.js への依存）ため——
// 収集側を純関数のまま保つ。
import { runInAction } from 'mobx';
import { CenterLineType } from '../core.js';
import { bakeCLValue } from '../transform/centerLineOps.js';
import { findWallBeamAxisCL, findBeamAnchorCL, isProtectedWallBeamAxis, wallBeamAxisExcludeKey } from './wallBeamAxes.js';

// 旧梁芯（cl）を撤去前にスナップショットし、undo（同idで再追加）・redo（再撤去）の関数を作る
// （transform/centerLineMerge.js absorbCenterLineのloserSnapshotと同じ手法。refId・extentLoRef/HiRef・
// staticなextentLo/Hiまで含めて再現する——案B到達時はisProtectedWallBeamAxisでrefId!=nullを弾いた
// 後なのでrefIdは通常null想定だが、対称性のため一般形のまま持つ）。
// graph.removeCenterLine は内部で乗っていたauto柱・梁・基礎（dimensionStatus:'auto'）も撤去する
// （_teardownCenterLine→removeDependentsOfCenterLine）——それらは道連れに消えたまま個別復元しない
// （次の構造同期・モード境界再計算が「同期で作り直し」の原則どおり再生成する。呼び出し元
// （commitCLMoveOp・wallRefresh.js・finishBoundary.js）はいずれもこの直後・次のモード境界で
// 構造再計算を伴う経路にだけ乗る）。
function snapshotForRestore(cl) {
  return {
    id: cl.id,
    centerLineType: cl.centerLineType,
    value: cl._value,
    props: {
      labeled: cl.labeled,
      lineType: cl.lineType,
      discipline: cl.discipline,
      trim: cl.trim,
      ...(cl.refId != null ? { refId: cl.refId, refOffset: cl.refOffset } : {}),
      ...(cl.extentLoRef != null ? { extentLoRef: cl.extentLoRef } : {}),
      ...(cl.extentHiRef != null ? { extentHiRef: cl.extentHiRef } : {}),
      ...(cl._extentLo != null ? { extentLo: cl._extentLo } : {}),
      ...(cl._extentHi != null ? { extentHi: cl._extentHi } : {}),
    },
  };
}

/**
 * mapBackingCenterMoves の結果（下地帯中心が動いた箇所）を、壁由来の梁芯CL（discipline:fuse）へ
 * 反映する。各 move について:
 *   1. from の位置に壁由来の梁芯があれば（findWallBeamAxisCL。通り芯は対象にしない——from側は
 *      「追従元が壁由来の梁芯か」だけを見る。通り芯を動かす経路にしない）
 *   2. to の位置に**通り芯または壁由来の梁芯**（findBeamAnchorCL。autoFillWallBeamAxes の重複ガードと
 *      同じ述語）が既に無ければ bakeCLValue(cl, to) で値を書き換える。
 *      あれば（ユーザー裁定・案B・2026-09-26）: 旧梁芯（cl）が isProtectedWallBeamAxis で保護されて
 *      いなければ吸収して撤去する（graph.removeCenterLine。乗っていたauto柱・梁・基礎も道連れ——
 *      次の構造同期で作り直される）。相手（通り芯・梁芯いずれでも）はそのまま残す——相手が既に
 *      その座標の壁の根拠を持っているため。保護されていれば従来どおりskip（旧を残す）。
 *   3. 追従（bake）した場合のみ graph.excludedWallBeamAxes の旧座標キーを新座標キーへ張り替える
 *      （忘れると「ユーザーが消した梁芯が壁の移動で復活＝柱が湧く」）。吸収（撤去）した場合は
 *      excludedWallBeamAxesに一切触れない——旧CL自体が無くなるため張り替え先が無く、それまでの
 *      除外指定（あれば）もそのまま残す（案Bの明示指示。孤児梁芯の道連れ削除と同じ「触れない」規律）。
 * from に対応する梁芯が無い move は無視する（この階の主構造が壁由来梁芯を生成しない等。
 * 対応先の壁が無くなった孤児梁芯を撤去しない裁定と対称——ここで触れない梁芯には一切手を出さない）。
 * @param {object} graph
 * @param {Array<{axisCLId:string, isVertical:boolean, from:number, to:number}>} moves
 * @returns {{ moved: Array<{clId:string, isVertical:boolean, from:number, to:number}>,
 *   skipped: Array<{isVertical:boolean, from:number, to:number, reason:string}>,
 *   absorbed: Array<{clId:string, isVertical:boolean, from:number, to:number}>,
 *   undoFns: Function[], redoFns: Function[] }}
 */
export function followWallBeamAxes(graph, moves) {
  const moved = [];
  const skipped = [];
  const absorbed = [];
  const undoFns = [];
  const redoFns = [];

  for (const { isVertical, from, to } of moves) {
    const cl = findWallBeamAxisCL(graph, isVertical, from);
    if (!cl) continue; // この階に壁由来の梁芯が無い（主構造が生成しない等）— 何もしない

    const toType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    if (findBeamAnchorCL(graph, toType, to)) {
      if (isProtectedWallBeamAxis(graph, cl)) {
        skipped.push({ isVertical, from, to, reason: 'duplicate' });
        continue;
      }
      // 案B: 保護されない旧梁芯は吸収して撤去する（相手はそのまま残す）。
      const snapshot = snapshotForRestore(cl);
      runInAction(() => { graph.removeCenterLine(cl.id); });
      absorbed.push({ clId: cl.id, isVertical, from, to });
      undoFns.push(() => runInAction(() => {
        graph.addCenterLine(snapshot.centerLineType, snapshot.value, snapshot.props, snapshot.id);
      }));
      redoFns.push(() => runInAction(() => {
        graph.removeCenterLine(snapshot.id);
      }));
      continue;
    }

    const oldKey = wallBeamAxisExcludeKey(isVertical, from);
    const newKey = wallBeamAxisExcludeKey(isVertical, to);
    const hadOldExclude = graph.excludedWallBeamAxes.has(oldKey);

    runInAction(() => {
      bakeCLValue(cl, to);
      if (hadOldExclude) {
        graph.excludedWallBeamAxes.delete(oldKey);
        graph.excludedWallBeamAxes.add(newKey);
      }
    });
    moved.push({ clId: cl.id, isVertical, from, to });

    undoFns.push(() => runInAction(() => {
      bakeCLValue(cl, from);
      if (hadOldExclude) {
        graph.excludedWallBeamAxes.delete(newKey);
        graph.excludedWallBeamAxes.add(oldKey);
      }
    }));
    redoFns.push(() => runInAction(() => {
      bakeCLValue(cl, to);
      if (hadOldExclude) {
        graph.excludedWallBeamAxes.delete(oldKey);
        graph.excludedWallBeamAxes.add(newKey);
      }
    }));
  }

  return { moved, skipped, absorbed, undoFns, redoFns };
}
