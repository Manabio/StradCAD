/**
 * 昇降機の設置（I/O を含む手順の本体）。floorSwapManager.peek・saveFloor・undoManager 等を
 * 実際に呼ぶ層——判定・上階生成そのものは finish/equipment/equipmentFloorPlan.js（純関数）に委ねる。
 *
 * 呼び出し元（App.jsx installElevatorFromNaming。ステップ4 S3b）が、設置階の確定（commitActive）・
 * 有効性チェック（isStillValid）・反映後コールバック（onApplied）を注入する。
 *
 * 巻き戻し（rollbackSavedFloors）・undo 合成（applyRecords・amendOnAppliedOnly）は
 * finish/floorUndoRecords.js へ移した（階段の連動削除と共有。呼び出し側が ERR_ELEVATOR_OP_FAILED 等へ
 * 丸めて再スローする）。
 */
import { EvUsage } from '@core';
import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { saveFloor } from '../../storage/db.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { undoManager } from '../../undoManager.js';
import { floorWriteGeneration } from '../../storage/floorWriteGeneration.js';
import { rollbackSavedFloors, applyRecords, amendOnAppliedOnly } from '../floorUndoRecords.js';
import { judgeElevatorInstall, installOnUpperFloor, copyElevatorRowsToGraph } from './equipmentFloorPlan.js';
import { equipmentFloorSpanLabel, buildingNumbersAfterRemoval, renumberEquipment, selfFloorEquipmentCatalog } from './equipmentNumbering.js';
import { applyEquipmentRemovalToFloor, applyEquipmentUsageToFloor, applyEquipmentNumbers } from './equipmentOps.js';
import {
  ERR_ELEVATOR_FLOORS_CHANGED, tagElevatorOpFailure,
  ERR_ELEVATOR_REMOVE_FAILED, ERR_ELEVATOR_REMOVE_FAILED_MESSAGE,
  ERR_ELEVATOR_USAGE_FAILED, ERR_ELEVATOR_USAGE_FAILED_MESSAGE,
  ERR_ELEVATOR_COPY_FAILED, ERR_ELEVATOR_COPY_FAILED_MESSAGE,
  ERR_ELEVATOR_RENUMBER_FAILED, ERR_ELEVATOR_RENUMBER_FAILED_MESSAGE,
} from '../../error.js';

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

  // 検討案の平面がアクティブ（採用フロアでない）→ 判定・上階生成をせず設置階だけ確定する。
  // 採番は自階の行だけ（equipment=null で commitActive に委ねる＝FinishModeState側の従来経路）。
  // 上階は無いが、undo/redo の後も project.equipmentIndex・記号の再読込みが要る（QA指摘M2）ため、
  // 「何もしない＋onApplied を呼ぶ」だけの合成をamendする。
  if (activeIndex < 0) {
    const entry = commitActive(null);
    if (!entry) throw tagElevatorOpFailure(new Error('runElevatorInstall: commitActive returned no undo entry (検討案の平面)'));
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
    // 延長: 上階には何も書かない（延長は既存グループへの合流であり上階は既に設置済みのため）。
    // undo対象は設置階の1エントリだけだが、
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
    // installOnUpperFloor（変更）・serializeGraph（直列化）・saveFloorFn（保存）のいずれが例外を
    // 投げても、保存済みの階を巻き戻してから識別コード付きで再スローする（QA指摘F1: 従来は
    // saveFloorFnだけがtryの中で、installOnUpperFloor・serializeGraphの例外は捕捉されず
    // 巻き戻し・識別コードのどちらも無いまま素通ししていた）。
    try {
      installOnUpperFloor(graph, { ...judged.equipment, cells: targetCells });
      const afterBytes = serializeGraph(graph);
      await saveFloorFn(plane.id, afterBytes);
      afterBytesByPlane.set(plane.id, afterBytes);
      savedPlaneIds.push(plane.id);
    } catch (err) {
      await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
      throw tagElevatorOpFailure(err);
    }
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
  // undo/redo の後も project.equipmentIndex・記号の再読込みが要る（QA指摘M2）ため、
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

// runElevatorRemoval・runElevatorUsageChangeが共有する「アクティブ以外の全採用階をpeekし、
// peek直前の書込み世代とpeek直後のbeforeバイト列を控える」手順（runElevatorInstallの手順1と
// 同じ規則。例外はまだ何も書き込んでいない状態で伝播するため、呼び出し側がtagElevatorOpFailure
// で識別コードを付けてから再スローする）。
async function peekNonActiveFloors(project, activeGraph, peekFn) {
  const genBeforePeek = new Map();
  const beforeBytesByPlane = new Map();
  const floors = [];
  for (const plane of project.planes) {
    if (plane.id === activeGraph.plane.id) { floors.push({ plane, graph: activeGraph }); continue; }
    genBeforePeek.set(plane.id, floorWriteGeneration(plane.id));
    const g = await peekFn(plane);
    beforeBytesByPlane.set(plane.id, serializeGraph(g));
    floors.push({ plane, graph: g });
  }
  return { floors, genBeforePeek, beforeBytesByPlane };
}

/**
 * 昇降機の削除本体（ステップ5・全階連動）。アクティブ階に equipmentId の行が無ければ何もしない
 * （noop）。検討案の平面がアクティブなら自階だけ確定する。それ以外は他階を先に保存し、
 * アクティブ階を最後に commitActive で同期確定する——runElevatorInstall と同じ順序規則。
 *
 * @param {object} params
 * @param {object} params.project
 * @param {object} params.activeGraph
 * @param {string} params.equipmentId
 * @param {(noById: Map<string,number>|null) => object|null} params.commitActive - アクティブ階を
 *   同期で確定し、undo エントリ（undoManager.push の戻り値）を返す。
 * @param {() => boolean} params.isStillValid
 * @param {() => void} [params.onApplied]
 * @param {(plane: object) => Promise<object>} [params.peekFn]
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [params.saveFloorFn]
 * @returns {Promise<{status:'removed'}|{status:'aborted', message:string|null}|{status:'noop'}>}
 */
export async function runElevatorRemoval({
  project, activeGraph, equipmentId,
  commitActive, isStillValid, onApplied,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  // 1. アクティブ階に equipmentId の行が無ければ何もしない。
  if (!activeGraph.equipmentRows.some(r => r.id === equipmentId)) return { status: 'noop' };

  const planes = project.planes;
  const activeIndex = planes.findIndex(p => p.id === activeGraph.plane.id);

  // 2. 検討案の平面がアクティブ（採用フロアでない）→ 自階だけ確定・自階の番号詰め。
  if (activeIndex < 0) {
    const entry = commitActive(null);
    if (!entry) {
      throw tagElevatorOpFailure(
        new Error('runElevatorRemoval: commitActive returned no undo entry (検討案の平面)'),
        { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE },
      );
    }
    amendOnAppliedOnly(entry, onApplied);
    onApplied?.();
    return { status: 'removed' };
  }

  // 3. アクティブ以外の全採用階をpeekし、世代とbeforeバイト列を控える。
  let floors, genBeforePeek, beforeBytesByPlane;
  try {
    ({ floors, genBeforePeek, beforeBytesByPlane } = await peekNonActiveFloors(project, activeGraph, peekFn));
  } catch (err) {
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE });
  }

  // 4. 建物全体（アクティブ階は生きている行）で番号を詰め直す。
  const noById = buildingNumbersAfterRemoval(floors.map(f => f.graph.equipmentRows), equipmentId);

  // 5. isStillValid確認。
  if (!isStillValid()) return { status: 'aborted', message: null };

  // 6. アクティブ以外の各階（昇順）: 変更があった階だけ世代を確認して保存する（削除する器具が
  // 無い階でも、番号が変わる行を持てば保存対象になる仕様）。
  const savedPlaneIds = [];
  const afterBytesByPlane = new Map();
  for (const { plane, graph } of floors) {
    if (plane.id === activeGraph.plane.id) continue;
    // applyEquipmentRemovalToFloor（変更）・serializeGraph（直列化）・saveFloorFn（保存）の
    // いずれが例外を投げても、保存済みの階を巻き戻してから識別コード付きで再スローする
    // （QA指摘F1: 従来はsaveFloorFnだけがtryの中だった）。世代の不一致による中断（aborted）は
    // 例外ではなくreturnのため、この try の中にあっても従来どおり中断として扱われる。
    try {
      const changed = applyEquipmentRemovalToFloor(graph, equipmentId, noById);
      if (!changed) continue;
      if (floorWriteGeneration(plane.id) !== genBeforePeek.get(plane.id)) {
        await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
        return { status: 'aborted', message: ERR_ELEVATOR_FLOORS_CHANGED };
      }
      const afterBytes = serializeGraph(graph);
      await saveFloorFn(plane.id, afterBytes);
      afterBytesByPlane.set(plane.id, afterBytes);
      savedPlaneIds.push(plane.id);
    } catch (err) {
      await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
      throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE });
    }
  }

  // 7. isStillValid再確認。
  if (!isStillValid()) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    return { status: 'aborted', message: null };
  }

  // 8. アクティブ階を同期で確定する。
  let entry;
  try {
    entry = commitActive(noById);
  } catch (err) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE });
  }
  if (!entry) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    throw tagElevatorOpFailure(
      new Error('runElevatorRemoval: commitActive returned no undo entry'),
      { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE },
    );
  }

  // 9. undoManager.amend（削除も全階の before/after を1エントリに合成。Ctrl+Zで全階が戻る）。
  const records = savedPlaneIds.map(planeId => ({
    planeId, before: beforeBytesByPlane.get(planeId), after: afterBytesByPlane.get(planeId),
  }));
  undoManager.amend(
    entry,
    () => { applyRecords(project, records, 'before', saveFloorFn); onApplied?.(); },
    () => { applyRecords(project, records, 'after', saveFloorFn); onApplied?.(); },
  );
  onApplied?.();

  return { status: 'removed' };
}

/**
 * 昇降機の用途変更本体（ステップ5・全階連動）。アクティブ階に equipmentId の行が無い、または
 * 既に同じ用途なら何もしない（noop）。それ以外は runElevatorRemoval と同じ順序規則
 * （他階を先に保存し、アクティブ階を最後に commitActive で同期確定）。番号の詰め直しは
 * 用途変更では起きないため commitActive は引数を取らない。
 *
 * @param {object} params
 * @param {object} params.project
 * @param {object} params.activeGraph
 * @param {string} params.equipmentId
 * @param {string} params.usage
 * @param {() => object|null} params.commitActive - アクティブ階の用途を変えて undo エントリを返す。
 * @param {() => boolean} params.isStillValid
 * @param {() => void} [params.onApplied]
 * @param {(plane: object) => Promise<object>} [params.peekFn]
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [params.saveFloorFn]
 * @returns {Promise<{status:'changed'}|{status:'aborted', message:string|null}|{status:'noop'}>}
 */
export async function runElevatorUsageChange({
  project, activeGraph, equipmentId, usage,
  commitActive, isStillValid, onApplied,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  // usage が EvUsage のいずれでもなければ、noop 判定・検討案の平面の分岐より前に拒否する
  // （アクティブ階に行が無い・1階建て・検討案の平面でも不正な値は弾く）。
  if (!Object.values(EvUsage).includes(usage)) {
    throw tagElevatorOpFailure(
      new Error(`runElevatorUsageChange: 不正な用途: ${usage}`),
      { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE },
    );
  }
  const activeRow = activeGraph.equipmentRows.find(r => r.id === equipmentId);
  if (!activeRow || activeRow.usage === usage) return { status: 'noop' };

  const planes = project.planes;
  const activeIndex = planes.findIndex(p => p.id === activeGraph.plane.id);

  // 検討案の平面がアクティブ→自階だけ。
  if (activeIndex < 0) {
    const entry = commitActive();
    if (!entry) {
      throw tagElevatorOpFailure(
        new Error('runElevatorUsageChange: commitActive returned no undo entry (検討案の平面)'),
        { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE },
      );
    }
    amendOnAppliedOnly(entry, onApplied);
    onApplied?.();
    return { status: 'changed' };
  }

  let floors, genBeforePeek, beforeBytesByPlane;
  try {
    ({ floors, genBeforePeek, beforeBytesByPlane } = await peekNonActiveFloors(project, activeGraph, peekFn));
  } catch (err) {
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE });
  }

  if (!isStillValid()) return { status: 'aborted', message: null };

  const savedPlaneIds = [];
  const afterBytesByPlane = new Map();
  for (const { plane, graph } of floors) {
    if (plane.id === activeGraph.plane.id) continue;
    // applyEquipmentUsageToFloor（変更）・serializeGraph（直列化）・saveFloorFn（保存）の
    // いずれが例外を投げても、保存済みの階を巻き戻してから識別コード付きで再スローする
    // （QA指摘F1。runElevatorRemovalと同じ規則）。
    try {
      const changed = applyEquipmentUsageToFloor(graph, equipmentId, usage);
      if (!changed) continue;
      if (floorWriteGeneration(plane.id) !== genBeforePeek.get(plane.id)) {
        await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
        return { status: 'aborted', message: ERR_ELEVATOR_FLOORS_CHANGED };
      }
      const afterBytes = serializeGraph(graph);
      await saveFloorFn(plane.id, afterBytes);
      afterBytesByPlane.set(plane.id, afterBytes);
      savedPlaneIds.push(plane.id);
    } catch (err) {
      await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
      throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE });
    }
  }

  if (!isStillValid()) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    return { status: 'aborted', message: null };
  }

  let entry;
  try {
    entry = commitActive();
  } catch (err) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE });
  }
  if (!entry) {
    await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
    throw tagElevatorOpFailure(
      new Error('runElevatorUsageChange: commitActive returned no undo entry'),
      { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE },
    );
  }

  const records = savedPlaneIds.map(planeId => ({
    planeId, before: beforeBytesByPlane.get(planeId), after: afterBytesByPlane.get(planeId),
  }));
  undoManager.amend(
    entry,
    () => { applyRecords(project, records, 'before', saveFloorFn); onApplied?.(); },
    () => { applyRecords(project, records, 'after', saveFloorFn); onApplied?.(); },
  );
  onApplied?.();

  return { status: 'changed' };
}

/**
 * 階追加時、直下の採用階の器具行を新階へ複製する。floorOrderChange.js の elevator follower が
 * stairVoidReconcile（reconcileAllStairVoids）の後・exteriorRoom（addNewFloorRoomFromSource）の前に呼ぶ
 * （階段同期の後＝新階にできた階段・階段吹抜けを衝突判定の相手にできる。外壁内側の部屋の前＝
 * 部屋は新階で割当済みのセルを除くので、昇降路を先に作れば部屋から自然に外れる）。
 *
 * 直下階は project.planes（採用階だけ・elevation昇順）で newPlane の1つ下。新階が先頭（最下）
 * なら何もしない。直下階がアクティブ階なら生きているグラフ（activeGraph）、そうでなければ peek。
 * 直下階の器具行が0件（器具行の無い昇降路だけ、または昇降路が無い）なら noop（新階を peek も
 * しない）。undo の新規エントリは積まない——withFloorOpUndo が新階のバイト列を丸ごと記録する
 * ため、複製は階追加のエントリに自然に含まれる。
 *
 * @param {object} params
 * @param {object} params.project
 * @param {object} params.activeGraph - 表示中（元階）のグラフ
 * @param {object} params.newPlane - 追加した新しい Plane
 * @param {(plane: object) => Promise<object>} [params.peekFn] - 既定 floorSwapManager.peek
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [params.saveFloorFn] - 既定 saveFloor
 * @returns {Promise<{status:'noop'} | {status:'copied', copiedIds: string[], skipped: Array<{id:string, reason:string}>}>}
 */
export async function copyElevatorsToNewFloor({
  project, activeGraph, newPlane,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  const planes = project.planes;
  const idx = planes.findIndex(p => p.id === newPlane.id);
  if (idx <= 0) return { status: 'noop' }; // 新階が先頭（最下）→直下階なし

  const lowerPlane = planes[idx - 1];
  let lowerGraph;
  try {
    lowerGraph = lowerPlane.id === activeGraph.plane.id ? activeGraph : await peekFn(lowerPlane);
  } catch (err) {
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_COPY_FAILED, message: ERR_ELEVATOR_COPY_FAILED_MESSAGE });
  }
  if (lowerGraph.equipmentRows.length === 0) return { status: 'noop' };

  let newGraph;
  try {
    newGraph = await peekFn(newPlane);
  } catch (err) {
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_COPY_FAILED, message: ERR_ELEVATOR_COPY_FAILED_MESSAGE });
  }

  const { copiedIds, skipped } = copyElevatorRowsToGraph(newGraph, lowerGraph, project.structGraph);

  if (copiedIds.length > 0) {
    try {
      await saveFloorFn(newPlane.id, serializeGraph(newGraph));
    } catch (err) {
      throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_COPY_FAILED, message: ERR_ELEVATOR_COPY_FAILED_MESSAGE });
    }
  }

  return { status: 'copied', copiedIds, skipped };
}

/**
 * 消す階（planeId）の器具行の id 一覧を読む。App.jsx runDeleteFloor が removeFloor より前に呼ぶ
 * （削除後は peek できないため）。消す階がアクティブならメモリ上の生きているグラフ、そうでなければ
 * peek する。peek の例外は識別コード付きで再スローする（削除前のため状態は変わっていない）。
 * @param {object} project
 * @param {object} plane - 消す階の Plane
 * @param {(plane: object) => Promise<object>} [peekFn] - 既定 floorSwapManager.peek
 * @returns {Promise<string[]>}
 */
export async function readFloorEquipmentIds(project, plane, peekFn = (p) => floorSwapManager.peek(p, project.structGraph)) {
  try {
    const graph = project.activePlane?.id === plane.id ? project.activeGraph : await peekFn(plane);
    return graph.equipmentRows.map(r => r.id);
  } catch (err) {
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_RENUMBER_FAILED, message: ERR_ELEVATOR_RENUMBER_FAILED_MESSAGE });
  }
}

/**
 * 階削除後、全階から消えた器具があれば番号を詰め直す。App.jsx runDeleteFloor が
 * removeFloor の直後に呼ぶ。検討案の平面は対象外（project.planes は採用階だけ）。undo エントリは
 * 積まない（現行の階削除の扱いに従う＝undo できない）。
 * @param {object} params
 * @param {object} params.project
 * @param {object} params.activeGraph - アクティブ階のグラフ（削除後の現在値）
 * @param {string[]} params.removedIds - 消えた階が持っていた器具行の id 一覧（readFloorEquipmentIds の戻り値）
 * @param {(plane: object) => Promise<object>} [params.peekFn]
 * @param {(planeId: string, bytes: Uint8Array) => Promise<void>} [params.saveFloorFn]
 * @returns {Promise<{status:'noop'} | {status:'renumbered', savedPlaneIds: string[]}>}
 */
export async function renumberEquipmentAfterFloorRemoval({
  project, activeGraph, removedIds,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  if (removedIds.length === 0) return { status: 'noop' };

  let floors, beforeBytesByPlane;
  try {
    ({ floors, beforeBytesByPlane } = await peekNonActiveFloors(project, activeGraph, peekFn));
  } catch (err) {
    throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_RENUMBER_FAILED, message: ERR_ELEVATOR_RENUMBER_FAILED_MESSAGE });
  }

  const remainingIds = new Set(floors.flatMap(f => f.graph.equipmentRows.map(r => r.id)));
  const vanished = removedIds.filter(id => !remainingIds.has(id));
  if (vanished.length === 0) return { status: 'noop' }; // 器具が残る場合は何もしない（書込みゼロ）

  const noById = renumberEquipment(selfFloorEquipmentCatalog(floors.flatMap(f => f.graph.equipmentRows)));

  const savedPlaneIds = [];
  for (const { plane, graph } of floors) {
    if (plane.id === activeGraph.plane.id) continue;
    // 変更→直列化→保存を1つのtryで囲む（いずれかが例外を投げても保存済みの階を巻き戻してから
    // 識別コード付きで再スローする。runElevatorRemovalと同じ規則）。
    try {
      const changed = applyEquipmentNumbers(graph, noById);
      if (changed === 0) continue;
      const afterBytes = serializeGraph(graph);
      await saveFloorFn(plane.id, afterBytes);
      savedPlaneIds.push(plane.id);
    } catch (err) {
      await rollbackSavedFloors(savedPlaneIds, beforeBytesByPlane, project, saveFloorFn);
      throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_RENUMBER_FAILED, message: ERR_ELEVATOR_RENUMBER_FAILED_MESSAGE });
    }
  }

  // 最後にアクティブ階（生きているグラフへ適用。自動保存に任せる）——検討案の平面がアクティブなら
  // 適用しない（検討案は採用階の再採番の対象外。project.planesは採用階だけを持つため、そこに
  // 含まれるかどうかで判定する）。
  if (project.planes.some(p => p.id === activeGraph.plane.id)) {
    applyEquipmentNumbers(activeGraph, noById);
  }

  return { status: 'renumbered', savedPlaneIds };
}
