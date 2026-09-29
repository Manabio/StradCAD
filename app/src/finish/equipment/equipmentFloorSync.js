/**
 * 昇降機の設置（I/O を含む手順の本体）。floorSwapManager.peek・saveFloor・undoManager 等を
 * 実際に呼ぶ層——判定・上階生成そのものは finish/equipment/equipmentFloorPlan.js（純関数）に委ねる。
 *
 * 呼び出し元（App.jsx installElevatorFromNaming。ステップ4 S3b）が、設置階の確定（commitActive）・
 * 有効性チェック（isStillValid）・反映後コールバック（onApplied）を注入する。
 *
 * 巻き戻し（rollbackSavedFloors）は transform/centerLineFloorSync.js の rollbackFloorRecords と
 * 同じ規則（1件の失敗でも残りの巻き戻しを続ける）のローカル関数——finish/ から transform/ を
 * import しない（設計書 §1）。ただし本経路は最初の例外を記録し、全件試行後に再スローする
 * （呼び出し側が ERR_ELEVATOR_OP_FAILED へ丸めて再スローするため）。
 */
import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { saveFloor } from '../../storage/db.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { undoManager } from '../../undoManager.js';
import { floorWriteGeneration } from '../../storage/floorWriteGeneration.js';
import { judgeElevatorInstall, installOnUpperFloor } from './equipmentFloorPlan.js';
import { equipmentFloorSpanLabel } from './equipmentNumbering.js';
import { ERR_ELEVATOR_FLOORS_CHANGED, tagElevatorOpFailure } from '../../error.js';

// rollbackFloorRecords（transform/centerLineFloorSync.js）と同じ規則: アクティブ階なら
// restoreGraph、そうでなければ saveFloorFn。1件の失敗でも残りの巻き戻しを続ける——ただしこちらは
// 最初の例外を記録し、全件試行後に再スローする（呼び出し側が識別コード付きで包み直す）。
async function rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn) {
  let firstError = null;
  for (const planeId of savedPlaneIds) {
    const before = beforeBytesByPlane.get(planeId);
    try {
      if (project.activePlane?.id === planeId) {
        restoreGraph(project.activeGraph, before);
      } else {
        await saveFloorFn(planeId, before);
      }
    } catch (err) {
      console.error(err);
      if (!firstError) firstError = err;
    }
  }
  if (firstError) throw firstError;
}

// applyFloorUndoRecords（transform/centerLineFloorSync.js）と同じ規則のローカル関数
// （undoManager.amend のundo/redoコールバックから呼ぶ。同期関数——saveFloorFnは待たない
// ＝stairFloorSync.js applyBytesと同じ「非アクティブ階はfire-and-forget」規約）。
function applyRecords(project, records, which, saveFloorFn) {
  const ordered = which === 'before' ? [...records].reverse() : records;
  for (const rec of ordered) {
    if (project.activePlane?.id === rec.planeId) {
      restoreGraph(project.activeGraph, rec[which]);
    } else {
      saveFloorFn(rec.planeId, rec[which]).catch(console.error);
    }
  }
}

// 上階への書込みが無い経路（延長・Q5）でも、undo/redo の後に project.equipmentIndex・記号の
// 再読込みが要る（QA指摘M2）ため、記録は増やさず「何もしない＋onApplied を呼ぶ」だけを
// entry へ合成する（undoManager.amend と同じ合成規則。base の undo/redo の前後どちらに
// 副作用を足すかは undoManager.amend 自体が決める——ここでは意味を持たないため気にしない）。
function amendOnAppliedOnly(entry, onApplied) {
  undoManager.amend(entry, () => onApplied?.(), () => onApplied?.());
}

/**
 * 昇降機の設置本体。判定（judgeElevatorInstall）→上階への書込み→設置階の確定
 * （commitActive）→undo合成、の順で進める。失敗・中断時は保存済みの上階を before へ巻き戻す。
 *
 * @param {object} params
 * @param {object} params.project
 * @param {object} params.activeGraph - 設置階（アクティブ）のグラフ
 * @param {Set<string>} params.cells - 設置階の変換元セル（refresh 済み）
 * @param {(equipment: object|null) => object|null} params.commitActive - 設置階を同期で確定し、
 *   undo エントリ（undoManager.push の戻り値）を返す。equipment は 'new'|'extend' 判定結果、
 *   Q5（検討案）では null
 * @param {() => boolean} params.isStillValid - 非同期区間をまたいでダイアログ・選択が有効かの判定
 * @param {() => void} [params.onApplied] - 反映後（amend 済み）に1回呼ぶ
 * @param {(plane: object) => Promise<object>} [params.peekFn] - 既定 floorSwapManager.peek
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [params.saveFloorFn] - 既定 saveFloor
 * @returns {Promise<
 *   {status:'rejected', message:string} |
 *   {status:'aborted', message:string|null} |
 *   {status:'extended'} |
 *   {status:'installed', upperSpanLabel:string|null}
 * >}
 */
export async function runElevatorInstall({
  project, activeGraph, cells,
  commitActive, isStillValid, onApplied,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  const planes = project.planes; // 採用フロアのみ・elevation昇順（検討案・屋根は含まれない）
  const activeIndex = planes.findIndex(p => p.id === activeGraph.plane.id);

  // Q5: 検討案の平面がアクティブ（採用フロアでない）→ 判定・上階生成をせず設置階だけ確定する。
  // 採番は自階の行だけ（equipment=null で commitActive に委ねる＝FinishModeState側の従来経路）。
  // 上階は無いが、undo/redo の後も project.equipmentIndex・記号の再読込みが要る（QA指摘M2）ため、
  // 「何もしない＋onApplied を呼ぶ」だけの合成をamendする。
  if (activeIndex < 0) {
    const entry = commitActive(null);
    if (!entry) throw tagElevatorOpFailure(new Error('runElevatorInstall: commitActive returned no undo entry (Q5)'));
    amendOnAppliedOnly(entry, onApplied);
    onApplied?.();
    return { status: 'installed', upperSpanLabel: null };
  }

  // 1. 各階をpeekする直前にその階の書込み世代を控え、peek直後・変更前にbeforeを直列化する。
  // peek・直列化そのものが例外を投げた場合（IDB読込み失敗等）は、まだ何も書き込んでいない
  // （書込みはゼロのまま）ので巻き戻しは不要——識別コードだけ付けて再スローする（QA指摘m4。
  // これが無いと例外がそのままguardUi層まで抜け、階の切替の汎用文言に丸められてしまう）。
  const genBeforePeek = new Map(); // planeId -> peek直前の世代
  const beforeBytesByPlane = new Map(); // planeId -> peek直後のバイト列（非アクティブ階のみ）
  const floors = [];
  try {
    for (const plane of planes) {
      if (plane.id === activeGraph.plane.id) { floors.push({ plane, graph: activeGraph }); continue; }
      genBeforePeek.set(plane.id, floorWriteGeneration(plane.id));
      const g = await peekFn(plane);
      beforeBytesByPlane.set(plane.id, serializeGraph(g));
      floors.push({ plane, graph: g });
    }
  } catch (err) {
    throw tagElevatorOpFailure(err);
  }

  // 2. 判定。拒否なら書き込みゼロ（peekした一時グラフへの CL 追加は破棄するだけ）。
  const judged = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex, sourceCells: cells });
  if (judged.kind === 'reject') {
    return { status: 'rejected', message: judged.message };
  }

  // 3. isStillValid確認（判定中に非同期の隙間は無いが、判定前のpeek区間で状態が変わりうる）。
  if (!isStillValid()) return { status: 'aborted', message: null };

  if (judged.kind === 'extend') {
    // 延長: 上階には何も書かない（設計書§3）。undo対象は設置階の1エントリだけだが、
    // undo/redo の後も project.equipmentIndex・記号の再読込みが要る（QA指摘M2）ため、
    // 「何もしない＋onApplied を呼ぶ」だけの合成をamendする（上階への記録は増やさない）。
    const entry = commitActive(judged.equipment);
    if (!entry) throw tagElevatorOpFailure(new Error('runElevatorInstall: commitActive returned no undo entry (extend)'));
    amendOnAppliedOnly(entry, onApplied);
    onApplied?.();
    return { status: 'extended' };
  }

  // judged.kind === 'new'
  // 4. 上階ごとに「世代の確認→installOnUpperFloor→afterを直列化→保存→記録」。
  const savedPlaneIds = [];
  const afterBytesByPlane = new Map();
  for (const target of judged.upperTargets) {
    const { plane, graph, cells: targetCells } = target;
    if (floorWriteGeneration(plane.id) !== genBeforePeek.get(plane.id)) {
      await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
      return { status: 'aborted', message: ERR_ELEVATOR_FLOORS_CHANGED };
    }
    installOnUpperFloor(graph, { ...judged.equipment, cells: targetCells });
    const afterBytes = serializeGraph(graph);
    try {
      await saveFloorFn(plane.id, afterBytes);
    } catch (err) {
      await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
      throw tagElevatorOpFailure(err);
    }
    afterBytesByPlane.set(plane.id, afterBytes);
    savedPlaneIds.push(plane.id);
  }

  // 5. isStillValid再確認。偽なら上階を巻き戻す。
  if (!isStillValid()) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    return { status: 'aborted', message: null };
  }

  // 6. 設置階を同期で確定する。
  let entry;
  try {
    entry = commitActive(judged.equipment);
  } catch (err) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    throw tagElevatorOpFailure(err);
  }
  if (!entry) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    throw tagElevatorOpFailure(new Error('runElevatorInstall: commitActive returned no undo entry'));
  }

  // 7. undoManager.amend（その階がアクティブならrestoreGraph、そうでなければsaveFloorFn）。
  // undo/redo の後も project.equipmentIndex・記号の再読込みが要る（設計書§1手順7・QA指摘M2）ため、
  // 両コールバックの最後に onApplied を呼ぶ。savedPlaneIds が空（新規グループだが上階0件＝
  // 最上階に設置した場合）でも、設置階自体の undo/redo で再読込みが要るため同様にamendする。
  const records = savedPlaneIds.map(planeId => ({
    planeId, before: beforeBytesByPlane.get(planeId), after: afterBytesByPlane.get(planeId),
  }));
  undoManager.amend(
    entry,
    () => { applyRecords(project, records, 'before', saveFloorFn); onApplied?.(); },
    () => { applyRecords(project, records, 'after', saveFloorFn); onApplied?.(); },
  );
  onApplied?.();

  const upperSpanLabel = judged.upperTargets.length > 0
    ? equipmentFloorSpanLabel(judged.upperTargets.map(t => ({ label: t.plane.name, order: t.plane.elevation })))
    : null;
  return { status: 'installed', upperSpanLabel };
}

/**
 * project.equipmentIndex（finish/equipment/buildingEquipment.js floorEquipmentRowLists が読む
 * 非永続キャッシュ）を埋めるため、アクティブ以外の全採用階を peek して器具行を集める
 * （ステップ4・S4）。App.jsx の effect が呼び、戻り値をそのまま project.replaceEquipmentIndex に渡す。
 * 一時グラフ・MobX の行オブジェクトは返さない——plain な値（{id,category,no,usage}）だけを返す。
 * @param {object} project
 * @param {object} activeGraph
 * @param {{peekFn?: (plane:object) => Promise<object>}} [opts]
 * @returns {Promise<Array<[string, Array<{id:string,category:string,no:number,usage:string}>]>>}
 */
export async function loadOtherFloorEquipmentRows(project, activeGraph, {
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
} = {}) {
  const activePlaneId = activeGraph?.plane?.id ?? null;
  const entries = [];
  for (const plane of project.planes) {
    if (plane.id === activePlaneId) continue;
    const g = await peekFn(plane);
    entries.push([plane.id, g.equipmentRows.map(r => ({ id: r.id, category: r.category, no: r.no, usage: r.usage }))]);
  }
  return entries;
}
