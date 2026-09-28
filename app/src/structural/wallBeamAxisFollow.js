// 壁由来梁芯の追従（壁再生成をFinishModeStateから独立させる計画のステップ2）。
// wallBeamAxes.js（純な収集・対応づけ・検索）と分離したのは、ここだけが実際に CL の値・
// 除外集合を書き換える（runInAction・undo/redo・transform/centerLineOps.js への依存）ため——
// 収集側を純関数のまま保つ。
import { runInAction } from 'mobx';
import { CenterLineType } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
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
// cl（吸収対象の旧梁芯）をextentLoRef/extentHiRefで参照している由来OPENINGのCLと、その参照側
// （'lo'|'hi'）を列挙する（ステップ6・吸収時の参照張り替え。設計§3後段）。壁由来梁芯は
// 他CLのextentRefから参照されない（extentLoRef/HiRefで梁芯を参照する生成源はopeningBeamAxes.jsの
// 短辺→通し辺の参照だけ——wallBeamAxes.js/woodAutoFill.jsのextentRefは通り芯（gridCLs）を指す）
// ため、壁のみの追従（他3呼び出し元）では常に空配列になり挙動は変わらない（REASONED）。
// @param {object} graph
// @param {import('../core.js').CenterLine} cl
// @returns {Array<{referrer: import('../core.js').CenterLine, side: 'lo'|'hi', oldRef: {clId:string, offset:number}}>}
function openingReferrersOf(graph, cl) {
  const out = [];
  for (const referrer of graph.referencingCenterLines(cl.id)) {
    if (referrer.beamAxisOrigin !== BeamAxisOrigin.OPENING) continue;
    if (referrer.extentLoRef?.clId === cl.id) out.push({ referrer, side: 'lo', oldRef: referrer.extentLoRef });
    if (referrer.extentHiRef?.clId === cl.id) out.push({ referrer, side: 'hi', oldRef: referrer.extentHiRef });
  }
  return out;
}

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
      ...(cl.beamAxisOrigin != null ? { beamAxisOrigin: cl.beamAxisOrigin } : {}),
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
 * @param {{repointRefsFrom?: boolean}} [opts] - repointRefsFrom（既定false。ステップ6・設計§3後段）:
 *   trueのとき、吸収対象の旧梁芯を`extentLoRef`/`extentHiRef`で参照しているCLのうち由来OPENINGの
 *   ものだけを保護理由から除外し（isProtectedWallBeamAxisのignoreRefsFrom）、参照元が全て由来OPENING
 *   （＝他に保護理由が無い）なら、それらの参照を吸収先アンカーのidへ張り替えてから吸収する
 *   （張り替えないとgraph.removeCenterLineのdetachFromCenterLineが参照を現在座標で静的化してしまい、
 *   短辺の追従が「参照」ではなく「固定値」に落ちる）。falseなら従来どおり（何であれ参照されていれば
 *   保護してskip）——壁由来のみの追従（finishBoundary.js・wallRefresh.js・commitCLMoveOpの偏芯分岐）は
 *   既定のまま呼ぶ。
 * @returns {{ moved: Array<{clId:string, isVertical:boolean, from:number, to:number}>,
 *   skipped: Array<{isVertical:boolean, from:number, to:number, reason:string}>,
 *   absorbed: Array<{clId:string, isVertical:boolean, from:number, to:number}>,
 *   undoFns: Function[], redoFns: Function[] }}
 */
export function followWallBeamAxes(graph, moves, opts = {}) {
  const { repointRefsFrom = false } = opts;
  const moved = [];
  const skipped = [];
  const absorbed = [];
  const undoFns = [];
  const redoFns = [];

  for (const { isVertical, from, to } of moves) {
    const cl = findWallBeamAxisCL(graph, isVertical, from);
    if (!cl) continue; // この階に壁由来の梁芯が無い（主構造が生成しない等）— 何もしない

    const toType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const anchor = findBeamAnchorCL(graph, toType, to);
    if (anchor) {
      const repointTargets = repointRefsFrom ? openingReferrersOf(graph, cl) : [];
      const ignoreRefsFrom = new Set(repointTargets.map(r => r.referrer.id));
      if (isProtectedWallBeamAxis(graph, cl, { ignoreRefsFrom })) {
        skipped.push({ isVertical, from, to, reason: 'duplicate' });
        continue;
      }
      // 案B: 保護されない旧梁芯は吸収して撤去する（相手はそのまま残す）。
      // 張り替えは撤去の**前**に行う——removeCenterLineのdetachFromCenterLineは「まだcl.idを
      // 参照しているCL」の参照を現在座標へ静的化するため、先に参照先を付け替えておく。
      const snapshot = snapshotForRestore(cl);
      runInAction(() => {
        for (const { referrer, side, oldRef } of repointTargets) {
          graph.setCenterLineExtentRef(referrer, side, { clId: anchor.id, offset: oldRef.offset ?? 0 });
        }
        graph.removeCenterLine(cl.id);
      });
      absorbed.push({ clId: cl.id, isVertical, from, to });
      undoFns.push(() => runInAction(() => {
        graph.addCenterLine(snapshot.centerLineType, snapshot.value, snapshot.props, snapshot.id);
        // cl自身を先に復元してから参照を戻す（setCenterLineExtentRefの解決対象がshapeMapに
        // 無ければ_extentLoCL/HiCLが未解決のまま残るため）。
        for (const { referrer, side, oldRef } of repointTargets) {
          graph.setCenterLineExtentRef(referrer, side, oldRef);
        }
      }));
      redoFns.push(() => runInAction(() => {
        for (const { referrer, side, oldRef } of repointTargets) {
          graph.setCenterLineExtentRef(referrer, side, { clId: anchor.id, offset: oldRef.offset ?? 0 });
        }
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
