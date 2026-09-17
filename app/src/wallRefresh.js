// 仕上げモードを開かずに主構造（CommonInfoTab.setMainStructure）・階別構造
// （graph.structureOverride）を変えても、次の境界（仕上げ脱出／構造脱出／読込み。読込みはステップ5）
// で全階の壁が新しい入力で作り直され、梁芯・柱が同じバッチで追従する
// （壁の再生成をFinishModeStateから独立させる計画のステップ4）。
// 発火条件は「保存キー（graph.wallFreshnessKey）≠現在キー」のみ。一致階は peek 以外何もしない
// （saveFloor もしない）。
//
// トップレベル（floorOps.js・undoManager.js と同じ層）に置く——finish/ と structural/ の
// 両方を import する必要があるため（structural/ から wallRefresh.js を import しない・
// finish→structural の一方向依存は維持する）。
import { runInAction } from 'mobx';
import { undoManager } from './undoManager.js';
import { floorSwapManager as defaultFloorSwapManager } from './storage/FloorSwapManager.js';
import { saveFloor as defaultSaveFloor } from './storage/db.js';
import { serializeGraph } from './graphSnapshot.js';
import { loadMaterialMap, regenerateWalls } from './finish/wallRegeneration.js';
import { wallFreshnessKey } from './finish/wallFreshnessKey.js';
import { resolveStairContext } from './finish/stair/stairUnderRooms.js';
import { conformWoodBacking } from './structural/woodAutoFill.js';
import { wallBackingCenters, mapBackingCenterMoves } from './structural/wallBeamAxes.js';
import { followWallBeamAxes } from './structural/wallBeamAxisFollow.js';
import { recomputeActiveStructural, reflectStructuralToOtherFloors } from './structural/structuralOrchestration.js';

/**
 * graph 1件分の「鍵不一致なら壁を作り直す」処理本体。ステップ1〜3で finishBoundary.js の
 * runFinishExitBoundary が積んでいるのと同じ形の undo/redo を返す（呼び出し側が pushUndo なら
 * 1エントリとして undoManager.push する。他階は使い捨て graph のため pushUndo=false で呼ぶ）。
 * @param {() => Promise<Map<string,object>>} getMaterialMap - 遅延ロード・メモ化された
 *   materialMap の取得関数（呼び出し元 refreshWallsAllFloors が1個だけ生成し全階で共有する）。
 *   鍵比較まで materialMap は不要なため、鍵一致の階しか無ければ一度も呼ばれない
 *   （読込み時の起動クリティカルパス対策。ステップ5）。
 * @returns {Promise<boolean>} この graph の壁を実際に作り直したか
 */
async function refreshWallsForGraph(graph, project, getMaterialMap, { peek, pushUndo }) {
  // 壁を一度も持ったことのない階（wallFreshnessKey未設定かつ壁0本＝仕上げモード未着手）は
  // sweep の対象外にする（裁定案A）。conformWoodBacking も走らせず鍵も書かない——仕上げモードに
  // 入って脱出したときに初めて壁を持つ、という現状の挙動を変えない。壁0本のまま
  // regenerateWalls を走らせて壁を新規生成すると、woodAutoFill.js の autoFillWoodColumns が
  // 「壁が交点方式に切り替わった」とみなし、壁の無い階の通り芯交点auto柱を保全する裁定
  // （2026-09-14「壁が無い階は生成も撤去もしない（既存の柱を保全）」）が外れて無通知に撤去される。
  if (graph.wallFreshnessKey == null && graph.walls.length === 0) return false;

  // 在来木造: 共通仕様の壁下地材を柱同寸×30へ自動選択する（従来 runFinishEntryBoundary と同じ
  // 呼び出し。下地コードは wallFreshnessKey の入力のため、これを鍵比較より前に行わないと
  // 「下地材は変わったのに鍵は一致」という矛盾状態になりうる）。materialMap 不要のため
  // 鍵比較の前に置く（ステップ5: 鍵比較だけなら materialMap を要求しない）。
  const backingChanges = runInAction(() => conformWoodBacking(graph, project));

  const keyBefore = graph.wallFreshnessKey;
  const keyNow = wallFreshnessKey(graph, project);
  if (keyNow === keyBefore) return false; // 鍵一致: 何もしない（saveFloorもしない・materialMapも要求しない）

  // 鍵不一致の階が実際に見つかった時点で初めて materialMap を要求する（getMaterialMap が
  // 呼び出し元で1個にメモ化されているため、複数階が不一致でもロードは1回だけになる）。
  let materialMap;
  try {
    materialMap = await getMaterialMap();
  } catch {
    // materialMap が無ければ壁を再生成できない。conformWoodBacking の変更はここでは戻さない
    // （次回また同じ値に収束するため実害なし）。鍵も書かない——壁は実際には変わっていないため、
    // 鍵だけ新しい値にすると以後ずっと「鍵一致なのに壁は古いまま」に固定されてしまう。
    return false;
  }

  const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, peek);
  const backingCentersBefore = wallBackingCenters(graph);
  const { regenerated, undoFns, redoFns } = await regenerateWalls(graph, {
    materialMap, project, stairUnderEntries, extraStairOpenings,
  });
  // 現状 materialMap はこの時点で必ず truthy（直前の getMaterialMap() が失敗していれば既に
  // return 済みのため）なので regenerated が false になることは無い到達不能な防御的分岐。
  // 将来 regenerateWalls が他の理由（materialMap 以外）で false を返しうるようになった場合は、
  // conformWoodBacking の巻き戻しか鍵を書かないままにする裁定が別途要る（ここでは巻き戻さない
  // ＝次回また同じ値に収束するため実害なし）。
  if (!regenerated) return false;

  const backingCentersAfter = wallBackingCenters(graph);
  const backingMoves = mapBackingCenterMoves(backingCentersBefore, backingCentersAfter);
  if (backingMoves.length > 0) {
    const axis = followWallBeamAxes(graph, backingMoves);
    undoFns.push(...axis.undoFns);
    redoFns.push(...axis.redoFns);
  }

  const keyAfter = wallFreshnessKey(graph, project);
  graph.setWallFreshnessKey(keyAfter);
  if (keyAfter !== keyBefore) {
    undoFns.push(() => graph.setWallFreshnessKey(keyBefore));
    redoFns.push(() => graph.setWallFreshnessKey(keyAfter));
  }

  // conformWoodBacking の下地材変更も同じ1エントリに含める（壁と下地材コードが必ず揃って
  // 戻る/進む——unshift で undo 実行順（配列を逆順実行）の先頭＝最後に戻すよう並べる）。
  if (backingChanges.length > 0) {
    const setter = f => (f === 'exteriorWallBacking' ? 'setExteriorWallBacking' : 'setInteriorWallBacking');
    undoFns.unshift(() => { for (const c of backingChanges) graph[setter(c.field)](c.from); });
    redoFns.unshift(() => { for (const c of backingChanges) graph[setter(c.field)](c.to); });
  }

  if (pushUndo && undoFns.length > 0) {
    undoManager.push(
      () => { [...undoFns].reverse().forEach(fn => fn()); },
      () => { redoFns.forEach(fn => fn()); },
    );
  }
  return true;
}

/**
 * 全階の壁を「保存キー（graph.wallFreshnessKey）≠現在キー」の階だけ作り直す。
 * 主構造・階別構造・下地材コードを（仕上げモードを開かずに）変えた直後の境界
 * （仕上げ脱出／構造脱出／読込み）から呼ぶ。
 * @param {object} project
 * @param {object} [opts]
 * @param {boolean} [opts.skipActive=false] - 自階を対象から外す（finish脱出境界は自階を
 *   自分のステップ1〜3で既に処理済みのため、他階だけ回す用）
 * @param {boolean} [opts.pushUndo=true] - 自階自身の壁変更を undoManager.push するか
 * @param {boolean} [opts.pushActiveStructuralUndo=true] - 他階の変更を起因として自階構造が
 *   再計算された（recomputeActiveStructural）ときの undo を push するか。pushUndo とは別軸
 *   ——finishBoundary.js は自階の壁は既に処理済みなので pushUndo:false で呼ぶが、他階起因の
 *   自階構造再計算は undo 対象のまま残す必要があるため分離している。
 * @param {(plane:object, structGraph:object) => Promise<object|null>} [opts.peek] - 差し替え用
 *   （テストでは実IDBを経由せず floorSwapManager.peek 相当のスタブを注入する）
 * @param {(planeId:string, bytes:Uint8Array) => Promise<void>} [opts.saveFloorFn] - 差し替え用
 * @param {() => Promise<Map<string,object>>} [opts.loadMaterialMapFn] - 差し替え用
 *   （テストで materialMap のロード失敗を再現する）。鍵不一致の階が1つも無ければ一度も
 *   呼ばれない（遅延ロード。ステップ5: 読込み時 bootReady のクリティカルパス対策）。
 * @returns {Promise<{ changedPlaneIds: string[] }>}
 */
export async function refreshWallsAllFloors(project, {
  skipActive = false, pushUndo = true, pushActiveStructuralUndo = true,
  peek = (plane, structGraph) => defaultFloorSwapManager.peek(plane, structGraph),
  saveFloorFn = defaultSaveFloor,
  loadMaterialMapFn = loadMaterialMap,
} = {}) {
  const changedPlaneIds = [];

  // materialMap は鍵不一致の階が実際に見つかったときだけ要求する（遅延ロード＋1回だけの
  // メモ化。全階一致なら1文書も開かない）。ロードに失敗した階は個別にスキップする
  // （refreshWallsForGraph 側。以前の「全体を安全側で止める」から変更——鍵比較自体は
  // materialMap 無しでも安全に行えるため、conformWoodBacking・鍵比較は他階も含め通常どおり
  // 進める）。
  let materialMapPromise = null;
  const getMaterialMap = () => (materialMapPromise ??= loadMaterialMapFn());

  if (!skipActive && project.activeGraph) {
    const graph = project.activeGraph;
    const changed = await refreshWallsForGraph(graph, project, getMaterialMap, { peek, pushUndo });
    if (changed) changedPlaneIds.push(graph.plane.id);
  }

  for (const plane of project.planes) {
    if (plane.id === project.activePlaneId) continue;
    let temp;
    try {
      temp = await peek(plane, project.structGraph);
    } catch {
      continue; // peek失敗（例外throw）した階はスキップし、他階は続行する（nullが返る場合と同じ扱い）
    }
    if (!temp) continue; // peek失敗（未知の理由でnullが返った）階はスキップし、他階は続行する
    const changed = await refreshWallsForGraph(temp, project, getMaterialMap, { peek, pushUndo: false });
    if (changed) {
      try {
        await saveFloorFn(plane.id, serializeGraph(temp));
      } catch {
        // 保存失敗（例外throw）した階はスキップして他階は続行する。temp は使い捨てのpeekグラフ
        // （project.graphMap の実体ではない）ため、保存に失敗しても実データの鍵は書き換わって
        // いない＝この階は鍵未更新のまま次の境界（仕上げ脱出／構造脱出／読込み）で再度鍵不一致と
        // 判定され、そこで再試行される自己修復になる。changedPlaneIdsにも含めない
        // （このsweepでは実際には変更が反映されなかったため）。
        continue;
      }
      changedPlaneIds.push(plane.id);
    }
  }

  // 壁交点柱・conformWoodSections・採番は既存プリミティブに任せる（自前で書かない）。
  // 自階→他階の順（recomputeActiveStructural が自階の柱等を確定してから、
  // reflectStructuralToOtherFloors が他階の再計算＋建物全体の採番を1回だけ確定する）。
  if (changedPlaneIds.length > 0) {
    if (project.activeGraph) await recomputeActiveStructural(project, pushActiveStructuralUndo);
    await reflectStructuralToOtherFloors(project);
  }

  return { changedPlaneIds };
}
