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
// **降格の移籍前に複製する**（通り芯が project.structGraph に残っている間に peek しないと、
// 他階の壁が graphSnapshot.js の resolveCL で解決できず復元時に捨てられる。2026-09-17実測）。
import { runInAction } from 'mobx';
import { Discipline, centerLineKind } from '@core';
import { sameCoordCounterparts, CROSS_FLOOR_COUNTERPART_KINDS } from '../core/centerLineKindPolicy.js';
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
 * 昇格・降格双方の事前ガードとして使う: cl と同じ centerLineType・ほぼ同じ座標に非通り芯CL
 * （中心線・補助線・梁芯。CROSS_FLOOR_COUNTERPART_KINDS）を持つ Plane を、アクティブ以外の全 Plane
 * から探す。昇格（centerLineOps.js の promoteCenterToGridWithUndo）は cl がまだ中心線のときに呼び、
 * 降格（demoteGridToCenterWithUndo）は cl がまだ通り芯のときに呼ぶ——どちらも
 * cl.centerLineType/cl.value は変換前の値をそのまま使えるため、呼び出し側の型は同じでよい。
 * 同一 id の CL は重複として報告しない——降格（propagateDemotedCenterLine）が非アクティブ全階へ
 * 複製した「同じ線の分身」であり、昇格の回収対象（recallPromotedCenterLineDuplicates）である
 * ため、ここで重複扱いにすると同じ線の往復（降格→昇格）が永久に塞がれてしまう。
 * id による除外は sameCoordCounterparts の exclude（オブジェクト参照比較）では表現できない——
 * temp は他階を peek した別グラフインスタンスのため、そこに含まれる CenterLine は cl と id が
 * 同じでも参照が別（別オブジェクト）になる。呼び出し側（ここ）で id 比較により明示的に除外する。
 * 対象種別（CROSS_FLOOR_COUNTERPART_KINDS）は同階内の入替えガード（CONVERT_BLOCKING_KINDS。
 * 方向ごとに別集合）とは別の関係——通り芯は全階共有オブジェクトのため他階では相手たりえない一方、
 * 中心線・補助線・梁芯はいずれも階ローカルの実体のため、方向（昇格・降格）を問わず同じ集合になる
 * （centerLineKindPolicy.js「原始事実6」参照）。
 * 1つの階に複数種別が同座標にあるときは、CROSS_FLOOR_COUNTERPART_KINDS の並び順（中心線＞補助線＞
 * 梁芯。centerLineOps.js addCenterLineFromDialog の優先順と同じ規約）で1つ選んで報告する。
 * @returns {Promise<Array<{plane: Plane, kind: string}>>} 見つかった Plane と相手種別（0件なら変換して問題ない）
 */
export async function findFloorsWithCounterpartCL(project, activeGraph, cl) {
  const result = [];
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    const counterparts = sameCoordCounterparts(temp, { centerLineType: cl.centerLineType, value: cl.value })
      .filter(other => other.id !== cl.id && CROSS_FLOOR_COUNTERPART_KINDS.includes(centerLineKind(other)));
    if (counterparts.length === 0) continue;
    const kind = CROSS_FLOOR_COUNTERPART_KINDS.find(k => counterparts.some(c => centerLineKind(c) === k));
    result.push({ plane, kind });
  }
  return result;
}

// propagateDemotedCenterLine / recallPromotedCenterLineDuplicates 共通: ループ途中で例外
// （IDB書込失敗等）が起きても、そこまでに保存できた分だけは undo で戻せるよう必ず amend する
// （一部の階だけ複製・回収された不整合な状態のまま undo 不能になるのを防ぐ）。
// 呼び出し側は finally で呼ぶこと——finally を抜けた後、例外があれば自然に再スローされる
// （catchしていないため）。saveFloorFn は呼び出し時に渡されたものを使う（往復テストのため、
// undo/redo時の書き戻しもテスト用の差し替えに乗せられるようにする）。
// centerLineOps.js の降格（複製フェーズをundoエントリ作成前に行う）からも呼べるよう export する
// （undoEntry が無いうちは no-op で返るため、そこでの呼び出しは安全）。
// amendFloorUndoRecords の内部処理（旧 applyBytes）を export として切り出したもの（挙動不変。
// 2026-09-25）。centerLineOps.js の通り芯削除（deleteCenterLineWithUndo）は、他階への伝播
// （propagateGridCenterLineDeletion）を自前のundo/redoクロージャの中で順序制御して呼ぶため
// （amendではなく、structGraph・自階の復元と同じエントリに直接組み込む——amendFloorUndoRecordsは
// undoManager.amendを内部で呼ぶため、まだエントリが無い段階や順序を自分で組みたい呼び出し元には
// 使えない）、amendに包まれた形ではなく本関数を直接呼べるようにする。
export function applyFloorUndoRecords(project, records, which, saveFloorFn = saveFloor) {
  for (const rec of records) {
    if (project.activePlane?.id === rec.planeId) {
      restoreGraph(project.activeGraph, rec[which]); // undo実行時にその階がアクティブなら生きているグラフへ復元
    } else {
      saveFloorFn(rec.planeId, rec[which]).catch(console.error); // 非アクティブ階は IDB のみが正
    }
  }
}

export function amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn = saveFloor) {
  if (!undoEntry || undoRecords.length === 0) return;
  undoManager.amend(
    undoEntry,
    () => applyFloorUndoRecords(project, undoRecords, 'before', saveFloorFn),
    () => applyFloorUndoRecords(project, undoRecords, 'after', saveFloorFn),
  );
}

/**
 * 通り芯削除の**移籍前**に、アクティブ以外の全 Plane（検討階・屋根を含む）で、この通り芯を参照する
 * 壁・部材・extent参照があれば detach＋撤去する（呼び出し側 centerLineOps.js の deleteCenterLineWithUndo
 * は、この後で `project.structGraph.removeCenterLine(cl.id)` を呼ぶこと——通り芯が project.structGraph に
 * 残っている間に他階を peek しないと、他階の壁の axisCL/clStart/clEnd が graphSnapshot.js の resolveCL
 * で解決できず、復元時に黙って捨てられる。端点ルール（detachFromCenterLine）が一切効かないまま壁が
 * 消える——降格 propagateDemotedCenterLine と同じ「複製（ここでは撤去）→移籍」の型。2026-09-17実測の
 * 教訓を通り芯削除にも適用する）。
 *
 * 参照が1つも無い階（この通り芯と無関係な階）は peek はするが detach・保存は行わずスキップする
 * （hasExternalCenterLineReferences。無駄な保存・undoレコードを増やさない）。
 * **既知の限界（m-8・QA指摘・2026-09-25。修正せず記録のみ）**: skip 判定
 * （`hasExternalCenterLineReferences`）は柱・梁・耐力壁・基礎・スリーブ・一般Shape・他CLの
 * extentLoRef/HiRef しか見ず、`columnAxisOffsets`・`clEccentricities` のキーや、他CLの `refId` が
 * この通り芯を指す子CL（extentRefではない参照）は見ない——それらだけを持つ階は誤ってスキップされ、
 * 削除idを指したままのキー・refIdが残る。実害は小さい（座標のオフセット量・偏芯レコードが孤立キーの
 * まま残るだけで、壁・部材が消える`resolveCL`欠落とは異なり描画・保存は壊れない）。HEAD（本モジュール
 * 導入前）にはこの伝播経路自体が無かったため、この限界は退行ではなく新規追加分の既知の未対応。
 *
 * undoEntry はまだ無い段階（centerLineOps.js が structGraph 側の削除より前に呼ぶ）で呼ばれるため、
 * amendFloorUndoRecords は使わない——undoRecords への蓄積のみ行い、呼び出し側がstructGraph・自階の
 * 復元と同じundoエントリへ`applyFloorUndoRecords`経由で組み込む。例外発生時も、そこまでに
 * saveFloorFn した階のundoRecordsは呼び出し側に残る（呼び出し側がrollbackFloorRecordsで巻き戻す）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  削除を実行する階のグラフ（アクティブ階）
 * @param {CenterLine} cl          削除前の通り芯（まだ project.structGraph に居る）
 * @param {{undoRecords?: Array, saveFloorFn?: Function}} [opts]
 * @returns {Promise<Array>} undoRecords（呼び出し側が渡した配列、省略時は内部で新規作成したもの）
 */
export async function propagateGridCenterLineDeletion(project, activeGraph, cl, { undoRecords = [], saveFloorFn = saveFloor } = {}) {
  for (const plane of otherPlanes(project, activeGraph)) {
    const temp = await floorSwapManager.peek(plane, project.structGraph);
    if (!temp.hasExternalCenterLineReferences(cl.id)) continue;
    const before = serializeGraph(temp);
    runInAction(() => {
      temp.detachFromCenterLine(cl.id);
      temp.removeDependentsOfCenterLine(cl.id);
    });
    await saveFloorFn(plane.id, serializeGraph(temp));
    undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
  }
  return undoRecords;
}

/**
 * 降格（通り芯→中心）の**移籍前**に、アクティブ以外の全 Plane へ同一 id で中心線を複製する
 * （呼び出し側は centerLineConvert.js の applyDemoteToCenter より先にこれを呼ぶこと——通り芯が
 * project.structGraph に残っている間に peek しないと、他階の壁の axisCL/clStart/clEnd が
 * graphSnapshot.js の resolveCL で解決できず復元時に黙って捨てられる。2026-09-17実測）。
 * extent は昇格前と同じ最外郭通り芯2本への ref（loCL/hiCL）にする。複製が読む
 * cl.centerLineType/_value/trim/refId/refOffset は applyDemoteToCenter が変更しないフィールド
 * なので、移籍前に読んでも複製内容は移籍後に読むのと同一。
 * undoEntry を渡すと、変更した各階の before/after を undoManager.amend で合成する
 * （eccentricityFloorSync.js の propagateCLEccentricities と同じパターン）。undoEntry が無い
 * 呼び出し（centerLineOps.js の降格はまだ undo エントリを作っていない段階でこれを呼ぶ）でも
 * before/after は常に undoRecords へ記録する——呼び出し側が opts.undoRecords に配列を渡せば、
 * 例外発生時も途中まで積んだ記録を参照できる（ロールバックに使う）。
 * @param {object} project
 * @param {PlanGraph} activeGraph  降格を実行する階のグラフ（アクティブ階）
 * @param {CenterLine} cl          降格前の通り芯（まだ project.structGraph に居る）
 * @param {{loCL, hiCL, undoEntry?: object|null, saveFloorFn?: Function, undoRecords?: Array}} opts
 * @returns {Promise<Array>} undoRecords（呼び出し側が渡した配列、省略時は内部で新規作成したもの）
 */
export async function propagateDemotedCenterLine(project, activeGraph, cl, { loCL, hiCL, undoEntry = null, saveFloorFn = saveFloor, undoRecords = [] }) {
  try {
    for (const plane of otherPlanes(project, activeGraph)) {
      const temp = await floorSwapManager.peek(plane, project.structGraph);
      const before = serializeGraph(temp);
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
      undoRecords.push({ planeId: plane.id, before, after: serializeGraph(temp) });
    }
  } finally {
    amendFloorUndoRecords(project, undoEntry, undoRecords, saveFloorFn);
  }
  return undoRecords;
}

/**
 * demoteGridToCenterWithUndo・deleteCenterLineWithUndo 専用の失敗時ロールバック: 複製・伝播フェーズ
 * （propagateDemotedCenterLine・propagateGridCenterLineDeletion）の途中で例外が起きた場合、または
 * 直後の本体処理（applyDemoteToCenter等）がエラーを返した場合に、そこまでに saveFloorFn した階を
 * before バイトで書き戻す（best effort）。undoManager には触れない（呼び出し側がまだ undo エントリを
 * 積んでいない段階でのみ使う）。
 * **project を渡すと、対象階が現在アクティブならIDBではなく生きているgraphへ`restoreGraph`する**
 * （`applyFloorUndoRecords`と同じ分岐。n-1・QA指摘・2026-09-25: project省略時（従来どおりIDBのみ）は、
 * 伝播中に階が切り替わり、切り替え先の階が既に「detach後のバイト」で生きているgraphへ復元・保持
 * されていると、rollbackがIDBへ書き戻したbeforeバイトが後続の自動保存（auto-save）で上書きされ、
 * 壁だけがundoも効かずに消える——生きているgraphが保持する状態と、IDBに書く状態を一致させる必要が
 * ある）。降格側（propagateDemotedCenterLine失敗時）の既存呼び出しはprojectを渡さず据え置く
 * （挙動不変。将来同種の問題が実測されたら同様に直す）。
 * @param {Array<{planeId, before}>} records
 * @param {Function} [saveFloorFn]
 * @param {object} [project] - 省略時は従来どおりIDB（saveFloorFn）のみで書き戻す。
 */
export async function rollbackFloorRecords(records, saveFloorFn = saveFloor, project = undefined) {
  for (const rec of records) {
    if (project?.activePlane?.id === rec.planeId) {
      try { restoreGraph(project.activeGraph, rec.before); } catch (err) { console.error(err); }
      continue;
    }
    try { await saveFloorFn(rec.planeId, rec.before); } catch (err) { console.error(err); }
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
