// 壁由来梁芯の追従（壁再生成をFinishModeStateから独立させる計画のステップ2）。
// wallBeamAxes.js（純な収集・対応づけ・検索）と分離したのは、ここだけが実際に CL の値・
// 除外集合を書き換える（runInAction・undo/redo・transform/centerLineOps.js への依存）ため——
// 収集側を純関数のまま保つ。
import { runInAction } from 'mobx';
import { CenterLineType } from '../core.js';
import { bakeCLValue } from '../transform/centerLineOps.js';
import { findWallBeamAxisCL, findBeamAnchorCL, wallBeamAxisExcludeKey } from './wallBeamAxes.js';

/**
 * mapBackingCenterMoves の結果（下地帯中心が動いた箇所）を、壁由来の梁芯CL（discipline:fuse）へ
 * 反映する。各 move について:
 *   1. from の位置に壁由来の梁芯があれば（findWallBeamAxisCL。通り芯は対象にしない——from側は
 *      「追従元が壁由来の梁芯か」だけを見る。通り芯を動かす経路にしない）
 *   2. to の位置に**通り芯または壁由来の梁芯**が既に無ければ bakeCLValue(cl, to) で値を書き換える
 *      （重複ガード。autoFillWallBeamAxes の重複ガード＝findBeamAnchorCL と同じ述語に揃える——
 *      to側だけ findWallBeamAxisCL のままだと、動いた先に通り芯があるのに気付かず同座標にCLが
 *      2本並ぶ事故になる。QA S1）。CL_OVERLAP_TOL_MM 以内に既にあれば書き換えず skipped へ積む。
 *   3. graph.excludedWallBeamAxes に旧座標のキーがあれば、新座標のキーへ張り替える
 *      （忘れると「ユーザーが消した梁芯が壁の移動で復活＝柱が湧く」）。
 * from に対応する梁芯が無い move は無視する（この階の主構造が壁由来梁芯を生成しない等。
 * 対応先の壁が無くなった孤児梁芯を撤去しない裁定と対称——ここで触れない梁芯には一切手を出さない）。
 * @param {object} graph
 * @param {Array<{axisCLId:string, isVertical:boolean, from:number, to:number}>} moves
 * @returns {{ moved: Array<{clId:string, isVertical:boolean, from:number, to:number}>,
 *   skipped: Array<{isVertical:boolean, from:number, to:number, reason:string}>,
 *   undoFns: Function[], redoFns: Function[] }}
 */
export function followWallBeamAxes(graph, moves) {
  const moved = [];
  const skipped = [];
  const undoFns = [];
  const redoFns = [];

  for (const { isVertical, from, to } of moves) {
    const cl = findWallBeamAxisCL(graph, isVertical, from);
    if (!cl) continue; // この階に壁由来の梁芯が無い（主構造が生成しない等）— 何もしない

    const toType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    if (findBeamAnchorCL(graph, toType, to)) {
      skipped.push({ isVertical, from, to, reason: 'duplicate' });
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

  return { moved, skipped, undoFns, redoFns };
}
