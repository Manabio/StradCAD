// finish/equipment/equipmentFloorSync.js（昇降機の設置。I/Oを含む手順の本体）の単体テスト。
// 昇降機の仕様追加 ステップ4・S3a。
//
// peekFn・saveFloorFn は注入する（floorSwapManager.peek・storage/db.js saveFloor という
// モジュールスコープのシングルトンは差し替えない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline } from '../../core.js';
import { worldToCell } from '../gridCells.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { undoManager } from '../../undoManager.js';
import { noteFloorWrite } from '../../storage/floorWriteGeneration.js';
import { makeStorePeek, makeStoreSave, decodeFloor, assertShaftInvariant } from './equipmentTestFixtures.js';
import { installEquipment, removeEquipment, applyEquipmentUsageToFloor } from './equipmentOps.js';
import { runElevatorInstall, loadOtherFloorEquipmentRows, runElevatorRemoval, runElevatorUsageChange } from './equipmentFloorSync.js';
import {
  ERR_ELEVATOR_FLOORS_CHANGED, ERR_ELEVATOR_OP_FAILED, ERR_ELEVATOR_UPPER_CONFLICT,
  ERR_ELEVATOR_REMOVE_FAILED, ERR_ELEVATOR_USAGE_FAILED,
} from '../../error.js';

// ---- 共通フィクスチャ（equipmentFloorPlan.test.js と同じ構図: X:[0,1000,2000] Y:[0,1000]） ----
function setupProject(floorCount) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000, grid);
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}
function leftKey(graph)  { return worldToCell(500, 500, graph).key; }
function rightKey(graph) { return worldToCell(1500, 500, graph).key; }

// restoreGraph→serializeGraphの往復はバイト単位で安定しない（FlatBuffersの符号化差。実測で
// peek直後のバイト長が保存前と異なる）ため、巻き戻しの確認は生バイト比較ではなく
// decodeFloorで復号した意味内容（器具行が無い＝巻き戻り済み）で行う。
function assertNoEquipmentOnFloor(project, plane, store, message) {
  const decoded = decodeFloor(project, plane, store.get(plane.id));
  assert.equal(decoded.equipmentRows.length, 0, message ?? `${plane.name}に器具行が残っていない（巻き戻り済み）`);
}

/**
 * commitActive のテスト用実体（FinishModeState.applyNaming の代役）: activeGraph へ実際に
 * installEquipment し、undoManager.push で本物の undo エントリを返す。呼び出し引数（equipment）は
 * calls 配列へ記録する。
 * @param {object} activeGraph
 * @param {Array} calls - 呼び出しごとの equipment 引数を push する
 * @param {{returnsNull?: boolean, throws?: boolean}} [opts]
 */
function makeCommitActive(activeGraph, calls, { returnsNull = false, throws = false } = {}) {
  return (equipment) => {
    calls.push(equipment);
    if (throws) throw new Error('commitActive: 意図した失敗');
    if (returnsNull) return null;
    const before = serializeGraph(activeGraph);
    const eq = equipment ?? { id: crypto.randomUUID(), category: 'ev', usage: 'passenger', no: 1 };
    installEquipment(activeGraph, { ...eq, cells: new Set([leftKey(activeGraph)]), candidateRoomId: null });
    const after = serializeGraph(activeGraph);
    return undoManager.push(
      () => restoreGraph(activeGraph, before),
      () => restoreGraph(activeGraph, after),
    );
  };
}

const alwaysValid = () => true;

// ---- ステップ5（削除・用途変更）専用の追加フィクスチャ ----

// 3セル横並びの構造グリッド（equipmentFloorPlan.test.jsと同じ構図。X:[0,2000,4000,6000] Y:[0,3000]）
// ——1つの昇降路に3基を並べるテスト専用（setupProjectのleft/rightだけでは足りない）。
function setupProjectWide(floorCount) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   4000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   6000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, grid);
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}
function leftKeyW(graph)  { return worldToCell(1000, 1500, graph).key; }
function midKeyW(graph)   { return worldToCell(3000, 1500, graph).key; }
function rightKeyW(graph) { return worldToCell(5000, 1500, graph).key; }

// 全階に、隣接する3基（left/mid/right。辺で接するので installEquipment が自動で1つの昇降路へ
// まとめる）を同じid/noで直接インストールする（runElevatorInstallを介さない——上階自動設置の
// 判定は既にrunElevatorInstall側のテストで確認済みのため、削除の全階連動の確認には不要）。
function install3AcrossAllFloors(graphs) {
  for (const g of graphs) {
    installEquipment(g, { id: 'left',  category: 'ev', usage: 'passenger', no: 1, cells: new Set([leftKeyW(g)]) });
    installEquipment(g, { id: 'mid',   category: 'ev', usage: 'passenger', no: 2, cells: new Set([midKeyW(g)]) });
    installEquipment(g, { id: 'right', category: 'ev', usage: 'passenger', no: 3, cells: new Set([rightKeyW(g)]) });
  }
}

// 器具行だけを直接足す（Room無し。番号の伝播・保存の機構だけを確かめたいテスト用の軽量フィクスチャ
// ——equipmentOps.test.jsの「roomIdが存在しないRoomを指す行」と同じ扱いで、removeEquipmentは
// room=null分岐を通るだけで例外にならない）。
function addRow(graph, id, no, usage = 'passenger') {
  graph.addEquipmentRow({ id, category: 'ev', usage, no, cellKeys: new Set([leftKey(graph)]) });
}

/**
 * runElevatorRemoval用のcommitActiveの実体: activeGraphへ実際にremoveEquipment(noById込み)し、
 * undoManager.pushで本物のundoエントリを返す。makeCommitActiveと同じ型。
 */
function makeCommitActiveForRemoval(activeGraph, equipmentId, calls, { returnsNull = false, throws = false } = {}) {
  return (noById) => {
    calls.push(noById);
    if (throws) throw new Error('commitActive: 意図した失敗');
    if (returnsNull) return null;
    const before = serializeGraph(activeGraph);
    removeEquipment(activeGraph, equipmentId, { noById });
    const after = serializeGraph(activeGraph);
    return undoManager.push(
      () => restoreGraph(activeGraph, before),
      () => restoreGraph(activeGraph, after),
    );
  };
}

/**
 * runElevatorUsageChange用のcommitActiveの実体: activeGraphへ実際にapplyEquipmentUsageToFloorし、
 * undoManager.pushで本物のundoエントリを返す。
 */
function makeCommitActiveForUsage(activeGraph, equipmentId, usage, calls, { returnsNull = false, throws = false } = {}) {
  return () => {
    calls.push(usage);
    if (throws) throw new Error('commitActive: 意図した失敗');
    if (returnsNull) return null;
    const before = serializeGraph(activeGraph);
    applyEquipmentUsageToFloor(activeGraph, equipmentId, usage);
    const after = serializeGraph(activeGraph);
    return undoManager.push(
      () => restoreGraph(activeGraph, before),
      () => restoreGraph(activeGraph, after),
    );
  };
}

// ================================================================
// 正常系: 新規設置
// ================================================================

test('runElevatorInstall: 新規設置→上階(2・3階)へ保存され、復号した各階に同じidの行・I1が成り立つ。commitActiveは1回・onAppliedは1回', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];
  let appliedCount = 0;

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid,
    onApplied: () => { appliedCount++; },
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'installed');
  assert.equal(result.upperSpanLabel, '2階〜3階');
  assert.deepEqual(saveLog, ['p2', 'p3'], '保存は2階→3階の順');
  assert.equal(commitCalls.length, 1);
  assert.equal(commitCalls[0].no, 1);
  assert.equal(appliedCount, 1);

  const equipmentId = commitCalls[0].id;
  for (const planeId of ['p2', 'p3']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assertShaftInvariant(decoded, planeId);
    assert.equal(decoded.equipmentRows.length, 1);
    assert.equal(decoded.equipmentRows[0].id, equipmentId);
  }
});

test('runElevatorInstall: 上階の保存は設置階の確定（commitActive）より前に完了する（順序固定）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const callOrder = [];
  const commitCalls = [];
  const baseCommit = makeCommitActive(g1, commitCalls);
  const commitActive = (equipment) => { callOrder.push('commit'); return baseCommit(equipment); };
  const baseSave = makeStoreSave(store, []);
  const saveFloorFn = async (planeId, bytes) => { callOrder.push(`save:${planeId}`); return baseSave(planeId, bytes); };

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive, isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn,
  });

  assert.equal(result.status, 'installed');
  assert.deepEqual(callOrder, ['save:p2', 'save:p3', 'commit'], '上階の保存(2・3階)が設置階の確定より先に完了する');
});

test('runElevatorInstall: 設置→undo→redo→undoの各時点で設置階（生きているグラフ）と上階（ストア復号）のRoom・行が一致し、I1が成り立つ', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid,
    onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(result.status, 'installed');
  const equipmentId = commitCalls[0].id;

  // amend済みのエントリは undoManager の undo スタック最上部にある（他のテストとスタックを
  // 共有しないよう、このテストの実行前にスタックが空であることを前提にする——node:testは
  // このファイルを1プロセス・順次実行するため、直前のテストがスタックへ積んでいないことを
  // beforeEachではなく先頭のassertで確認する）。
  assert.equal(g1.equipmentRows.length, 1, '設置階には行がある');
  assertShaftInvariant(g1, '1階(設置直後)');
  let decoded2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  assert.equal(decoded2.equipmentRows.length, 1);
  assertShaftInvariant(decoded2, '2階(設置直後)');

  undoManager.undo();
  assert.equal(g1.equipmentRows.length, 0, 'undoで設置階の行が消える');
  decoded2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  assert.equal(decoded2.equipmentRows.length, 0, 'undoで2階の行も消える（ストアがbeforeへ戻る）');

  undoManager.redo();
  assert.equal(g1.equipmentRows.length, 1, 'redoで設置階の行が戻る');
  assert.equal(g1.equipmentRows[0].id, equipmentId);
  decoded2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  assert.equal(decoded2.equipmentRows.length, 1, 'redoで2階の行も戻る');
  assert.equal(decoded2.equipmentRows[0].id, equipmentId);
  assertShaftInvariant(decoded2, '2階(redo後)');

  undoManager.undo();
  assert.equal(g1.equipmentRows.length, 0);
  decoded2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  assert.equal(decoded2.equipmentRows.length, 0);
});

// ---- M2（QA指摘・2026-09-30）: undo/redoの後もonAppliedが呼ばれ、project.equipmentIndex・記号の
// 再読込みが起きるようにする（amendのundo/redoコールバックの最後でonAppliedを呼ぶ）。 ----

test('【M2】runElevatorInstall（新規・上階あり）: 設置後にonAppliedが1回、undo後に2回、redo後に3回', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  let appliedCount = 0;

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => { appliedCount++; },
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(result.status, 'installed');
  assert.equal(appliedCount, 1, '設置直後に1回');

  undoManager.undo();
  assert.equal(appliedCount, 2, 'undo後に2回');

  undoManager.redo();
  assert.equal(appliedCount, 3, 'redo後に3回');
});

test('【M2】runElevatorInstall（延長。上階への書込みなし）: 設置後にonAppliedが1回、undo後に2回、redo後に3回', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  installEquipment(g2, { id: 'ev-existing', category: 'ev', usage: 'passenger', no: 3, cells: new Set([leftKey(g2)]) });
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  let appliedCount = 0;

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => { appliedCount++; },
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(result.status, 'extended');
  assert.equal(appliedCount, 1, '延長の確定直後に1回');

  undoManager.undo();
  assert.equal(appliedCount, 2, 'undo後に2回（延長でも読み直しが要る）');

  undoManager.redo();
  assert.equal(appliedCount, 3, 'redo後に3回');
});

test('【M2】runElevatorInstall（Q5。検討案の平面）: 設置後にonAppliedが1回、undo後に2回、redo後に3回', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  const store = new Map();
  const commitCalls = [];
  let appliedCount = 0;

  const result = await runElevatorInstall({
    project, activeGraph: altGraph, cells: new Set([leftKey(altGraph)]),
    commitActive: makeCommitActive(altGraph, commitCalls),
    isStillValid: alwaysValid, onApplied: () => { appliedCount++; },
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(result.status, 'installed');
  assert.equal(appliedCount, 1, 'Q5の確定直後に1回');

  undoManager.undo();
  assert.equal(appliedCount, 2, 'undo後に2回');

  undoManager.redo();
  assert.equal(appliedCount, 3, 'redo後に3回');
});

test('runElevatorInstall: 上階の1つに、設置位置と辺で隣接する別グループの昇降路がある→その階では統合、他の階では独立のRoom。どちらもI1成立', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  const [, g2] = graphs;
  // 2階のrightに既存の昇降路（設置予定のleftと辺で隣接）
  installEquipment(g2, { id: 'ev-existing', category: 'ev', usage: 'passenger', no: 5, cells: new Set([rightKey(g2)]) });
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(result.status, 'installed');
  const equipmentId = commitCalls[0].id;

  const decoded2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  assertShaftInvariant(decoded2, '2階');
  const rooms2 = decoded2.rooms.filter(r => r.feature === 'elevatorEquipment');
  assert.equal(rooms2.length, 1, '2階は隣接する既存グループへ統合され1つのRoom');
  assert.equal(decoded2.equipmentRows.length, 2, '2階は既存行(ev-existing)＋新規行の2行');

  const decoded3 = decodeFloor(project, g3.plane, store.get(g3.plane.id));
  assertShaftInvariant(decoded3, '3階');
  const rooms3 = decoded3.rooms.filter(r => r.feature === 'elevatorEquipment');
  assert.equal(rooms3.length, 1, '3階は独立のRoom');
  assert.equal(decoded3.equipmentRows.length, 1);
  assert.equal(decoded3.equipmentRows[0].id, equipmentId);
});

// ---- T2（QA指摘・2026-09-30）: 上階にCLを足した設置のundoで、上階のCL数が元に戻る ----
// 設置階(1階)にX500の per-floor 中心線を作り、footprintをleft内の半分にする。2階は同座標に
// 梁芯だけ（分割線ではないので新しい中心線が足される）・3階はCL無し（同じく新規に足される）。
// 設置→undoで、ストアを復号した2階・3階の中心線の本数が設置前と一致することを確かめる
// （beforeの直列化がCLの追加より前で採られていることの検証。QAのS1_beforeAfterCL変異で赤）。
test('【T2】runElevatorInstall: 上階にCLを足した設置をundoすると、上階のCL数が元に戻る', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  g1.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.FUSE }); // 梁芯のみ
  const clCountBefore2 = g2.centerLines.length;
  const clCountBefore3 = g3.centerLines.length;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  const sourceCells = new Set([worldToCell(250, 500, g1).key]);

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: sourceCells,
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(result.status, 'installed');
  // 前提: 実際にCLが足された上でインストールが成立していること（空振り防止）。
  const decodedAfter2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  const decodedAfter3 = decodeFloor(project, g3.plane, store.get(g3.plane.id));
  assert.ok(decodedAfter2.centerLines.length > clCountBefore2, '前提: 2階に中心線が足されている');
  assert.ok(decodedAfter3.centerLines.length > clCountBefore3, '前提: 3階に中心線が足されている');

  undoManager.undo();

  const decodedUndo2 = decodeFloor(project, g2.plane, store.get(g2.plane.id));
  const decodedUndo3 = decodeFloor(project, g3.plane, store.get(g3.plane.id));
  assert.equal(decodedUndo2.centerLines.length, clCountBefore2, '2階の中心線の本数が設置前に戻るはず');
  assert.equal(decodedUndo3.centerLines.length, clCountBefore3, '3階の中心線の本数が設置前に戻るはず');
});

// ---- T6（QA指摘・m4とセット）: peek（手順1）の失敗はERR_ELEVATOR_OP_FAILEDで、書き込みは0件 ----
test('【T6・失敗系】runElevatorInstall: peek（手順1）が例外→ERR_ELEVATOR_OP_FAILEDを付けて再スロー・書き込みは0件・commitActive 0回', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];
  const peekFn = async () => { throw new Error('IDB読込み失敗（意図した失敗）'); };

  await assert.rejects(
    () => runElevatorInstall({
      project, activeGraph: g1, cells: new Set([leftKey(g1)]),
      commitActive: makeCommitActive(g1, commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn,
      saveFloorFn: makeStoreSave(store, saveLog),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_OP_FAILED); return true; },
  );
  assert.deepEqual(saveLog, [], '書き込みは0件のまま');
  assert.equal(commitCalls.length, 0);
});

// ================================================================
// 拒否・延長
// ================================================================

test('runElevatorInstall: 拒否（上階に命名済み部屋）→保存ログ空・commitActive 0回', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  g2.addRoom(new Set([leftKey(g2)]), '居間');
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '居間'));
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 0);
});

test('runElevatorInstall: 延長（k+1に完全一致する器具行）→保存0件・commitActiveに既存グループのid', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  installEquipment(g2, { id: 'ev-existing', category: 'ev', usage: 'passengerFreight', no: 3, cells: new Set([leftKey(g2)]) });
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'extended');
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 1);
  assert.deepEqual(commitCalls[0], { id: 'ev-existing', category: 'ev', usage: 'passengerFreight', no: 3 });
});

// ================================================================
// 失敗系
// ================================================================

test('【失敗系】runElevatorInstall: 3階の保存が例外→2階がbeforeに戻り・commitActive 0回・ERR_ELEVATOR_OP_FAILEDを付けて再スロー', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorInstall({
      project, activeGraph: g1, cells: new Set([leftKey(g1)]),
      commitActive: makeCommitActive(g1, commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, saveLog, { failOn: 'p3' }),
    }),
    (err) => {
      assert.equal(err.code, ERR_ELEVATOR_OP_FAILED);
      return true;
    },
  );
  assert.deepEqual(saveLog, ['p2', 'p2'], '2階は設置で1回・巻き戻しで1回保存される（3階の保存は失敗しログに残らない）');
  assert.equal(commitCalls.length, 0, '上階の保存で失敗したためcommitActiveへ到達しない');
  assertNoEquipmentOnFloor(project, graphs[1].plane, store, '2階はbeforeへ巻き戻る');
});

// QA指摘F1（2026-09-30）: 従来はsaveFloorFnだけがtryの中で、installOnUpperFloor（変更処理）・
// serializeGraph（直列化）の例外は捕捉されず巻き戻し・識別コードのどちらも無いまま素通ししていた。
// 変更処理そのものの失敗を、peekが返す一時グラフのメソッドを差し替える形で注入する
// （製品コードに失敗用の口は作らない）。
test('【QA指摘F1・失敗系】runElevatorInstall: 3階の変更処理（installOnUpperFloor経由のgraph.addEquipmentRow）が例外→2階がbeforeに戻り・commitActive 0回・undo件数不変・識別コード付きで例外', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const basePeek = makeStorePeek(project, store);
  let injectFired = 0;
  const peekFn = (plane) => {
    const g = basePeek(plane);
    if (plane.id === g3.plane.id) {
      g.addEquipmentRow = () => { injectFired++; throw new Error('注入した変更処理の失敗'); };
    }
    return g;
  };
  const saveLog = [];
  const commitCalls = [];
  const undoCountBefore = undoManager._undoStack.length;

  await assert.rejects(
    () => runElevatorInstall({
      project, activeGraph: g1, cells: new Set([leftKey(g1)]),
      commitActive: makeCommitActive(g1, commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn,
      saveFloorFn: makeStoreSave(store, saveLog),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_OP_FAILED); return true; },
  );

  assert.equal(injectFired, 1, '注入は1回だけ発火するはず');
  assert.deepEqual(saveLog, ['p2', 'p2'], '2階は設置で1回・巻き戻しで1回保存される');
  assert.equal(commitCalls.length, 0);
  assert.equal(undoManager._undoStack.length, undoCountBefore, 'undo件数は変わらないはず');
  assertNoEquipmentOnFloor(project, graphs[1].plane, store, '2階はbeforeへ巻き戻る');
});

test('【失敗系】runElevatorInstall: commitActiveが例外→全上階(2・3階)がbeforeへ戻る', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorInstall({
      project, activeGraph: g1, cells: new Set([leftKey(g1)]),
      commitActive: makeCommitActive(g1, commitCalls, { throws: true }),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_OP_FAILED); return true; },
  );
  assertNoEquipmentOnFloor(project, graphs[1].plane, store);
  assertNoEquipmentOnFloor(project, graphs[2].plane, store);
});

test('【失敗系】runElevatorInstall: commitActiveがundoエントリを返さない(null)→ERR_ELEVATOR_OP_FAILEDで例外・上階が戻る', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorInstall({
      project, activeGraph: g1, cells: new Set([leftKey(g1)]),
      commitActive: makeCommitActive(g1, commitCalls, { returnsNull: true }),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_OP_FAILED); return true; },
  );
  assertNoEquipmentOnFloor(project, graphs[1].plane, store);
});

test('【失敗系】runElevatorInstall: 保存後にisStillValidが偽→巻き戻してaborted', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  let callCount = 0;
  const isStillValid = () => { callCount++; return callCount === 1; }; // 1回目（判定後）はtrue、2回目（保存後）はfalse

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'aborted');
  assert.equal(result.message, null);
  assert.equal(commitCalls.length, 0);
  assertNoEquipmentOnFloor(project, graphs[1].plane, store);
  assertNoEquipmentOnFloor(project, graphs[2].plane, store);
});

test('【失敗系】runElevatorInstall: 世代の割り込み→巻き戻してabortedとERR_ELEVATOR_FLOORS_CHANGED（割り込みの発火回数を固定）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  const basePeek = makeStorePeek(project, store);
  let interferenceFired = 0;
  const peekFn = async (plane) => {
    const g = basePeek(plane);
    if (plane.id === g3.plane.id) { noteFloorWrite(plane.id); interferenceFired++; } // 3階のpeek直後に割り込み書込みが起きたことを模す
    return g;
  };

  const result = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn,
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'aborted');
  assert.equal(result.message, ERR_ELEVATOR_FLOORS_CHANGED);
  assert.equal(interferenceFired, 1, '割り込みは1回だけ発火する');
  assert.equal(commitCalls.length, 0);
  assertNoEquipmentOnFloor(project, graphs[1].plane, store, '2階は保存済みだったため巻き戻る');
});

// ================================================================
// 検討案の平面がアクティブ
// ================================================================

test('runElevatorInstall: 検討案の平面がアクティブ（project.planesに無い）→設置階だけ確定。上階判定なし・採番は自階だけ', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  const store = new Map();
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorInstall({
    project, activeGraph: altGraph, cells: new Set([leftKey(altGraph)]),
    commitActive: makeCommitActive(altGraph, commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'installed');
  assert.equal(result.upperSpanLabel, null);
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 1);
  assert.equal(commitCalls[0], null, 'Q5では equipment=null で commitActive を呼ぶ（自階だけの採番に委ねる）');
  assert.equal(altGraph.equipmentRows.length, 1);
});

// ================================================================
// loadOtherFloorEquipmentRows（S4: project.equipmentIndex を埋める読み出し）
// ================================================================

test('loadOtherFloorEquipmentRows: アクティブ以外の全採用階をpeekしplain値の器具行配列を返す', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  installEquipment(g2, { id: 'ev-2', category: 'ev', usage: 'passenger', no: 1, cells: new Set([leftKey(g2)]) });
  installEquipment(g3, { id: 'ev-3', category: 'ev', usage: 'freight', no: 2, cells: new Set([leftKey(g3)]) });
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));

  const entries = await loadOtherFloorEquipmentRows(project, g1, { peekFn: makeStorePeek(project, store) });

  assert.equal(entries.length, 2, 'アクティブ(p1)を除く2階分');
  const byPlane = new Map(entries);
  assert.deepEqual(byPlane.get('p2'), [{ id: 'ev-2', category: 'ev', no: 1, usage: 'passenger' }]);
  assert.deepEqual(byPlane.get('p3'), [{ id: 'ev-3', category: 'ev', no: 2, usage: 'freight' }]);
});

test('loadOtherFloorEquipmentRows: 器具が無い階はrows:[]（一時グラフ・MobX行オブジェクトは返さない）', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));

  const entries = await loadOtherFloorEquipmentRows(project, g1, { peekFn: makeStorePeek(project, store) });

  assert.deepEqual(entries, [['p2', []]]);
});

// ================================================================
// runElevatorRemoval（ステップ5: 削除・全階連動）
// ================================================================

test('runElevatorRemoval: 3階建てで1階設置(2・3階へ自動生成)した器具を2階（中間階）から削除→保存ログは1階・3階(昇順)、全階で行0件・I1成立、commitActiveは1回。undoで全階が戻りredoで戻る', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const installCommitCalls = [];
  const installResult = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, installCommitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(installResult.status, 'installed');
  const equipmentId = installCommitCalls[0].id;
  // 設置階(1階)は設置フローでは store へ保存されない（活きたグラフのまま）。本番は階切替時に
  // FloorSwapManager.swap が保存するため、その手順を模してここで一度 store へ反映しておく。
  store.set(g1.plane.id, serializeGraph(g1));

  // 2階（設置階ではない中間階）へ切替えた体で削除する: 本番の階切替（FloorSwapManager.swap）は
  // graphMap の既存グラフ実体（ここでは g2）へ restoreGraph するだけで、新しいインスタンスは
  // 作らない——project.activeGraph の同一性比較（applyRecords 等）を成立させるため、テストでも
  // 同じ手順（g2へrestoreGraph→project.activePlaneIdをp2へ）で切替を模す。
  restoreGraph(g2, store.get(g2.plane.id));
  runInAction(() => { project.activePlaneId = g2.plane.id; });
  const g2Active = g2;
  assert.equal(g2Active.equipmentRows.length, 1, '前提: 2階に自動延長された行がある');

  const removeCommitCalls = [];
  const saveLog = [];
  let appliedCount = 0;

  const result = await runElevatorRemoval({
    project, activeGraph: g2Active, equipmentId,
    commitActive: makeCommitActiveForRemoval(g2Active, equipmentId, removeCommitCalls),
    isStillValid: alwaysValid, onApplied: () => { appliedCount++; },
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'removed');
  assert.deepEqual(saveLog, ['p1', 'p3'], '保存は1階→3階の順（2階はcommitActiveで確定される）');
  assert.equal(removeCommitCalls.length, 1);
  assert.equal(appliedCount, 1);
  assert.equal(g2Active.equipmentRows.length, 0);
  assertShaftInvariant(g2Active, '2階(削除後)');
  for (const planeId of ['p1', 'p3']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assertShaftInvariant(decoded, planeId);
    assert.equal(decoded.equipmentRows.length, 0);
  }

  undoManager.undo();
  assert.equal(appliedCount, 2, 'undo後に2回');
  assert.equal(g2Active.equipmentRows.length, 1, 'undoで2階の行が戻る');
  for (const planeId of ['p1', 'p3']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assert.equal(decoded.equipmentRows.length, 1, `${planeId}もundoで戻る`);
    assert.equal(decoded.equipmentRows[0].id, equipmentId);
  }

  undoManager.redo();
  assert.equal(appliedCount, 3, 'redo後に3回');
  assert.equal(g2Active.equipmentRows.length, 0);
  for (const planeId of ['p1', 'p3']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assert.equal(decoded.equipmentRows.length, 0);
  }
});

test('runElevatorRemoval: 最上階（3階）から削除しても全階で消える（アクティブ階が設置階と異なる中間・最上のもう一方）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const installCommitCalls = [];
  await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, installCommitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  const equipmentId = installCommitCalls[0].id;
  // 設置階(1階)は設置フローでは store へ保存されない（活きたグラフのまま）。本番は階切替時に
  // FloorSwapManager.swap が保存するため、その手順を模してここで一度 store へ反映しておく。
  store.set(g1.plane.id, serializeGraph(g1));
  const g3Active = makeStorePeek(project, store)(g3.plane);
  assert.equal(g3Active.equipmentRows.length, 1, '前提: 3階にも自動延長された行がある');

  const removeCommitCalls = [];
  const saveLog = [];
  const result = await runElevatorRemoval({
    project, activeGraph: g3Active, equipmentId,
    commitActive: makeCommitActiveForRemoval(g3Active, equipmentId, removeCommitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'removed');
  assert.deepEqual(saveLog, ['p1', 'p2'], '3階がアクティブなので1・2階が保存される（昇順）');
  assert.equal(g3Active.equipmentRows.length, 0);
  for (const planeId of ['p1', 'p2']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assert.equal(decoded.equipmentRows.length, 0);
  }
});

test('runElevatorRemoval【再採番・A5】: 削除した器具Aが無い階（Bだけの階）も番号が更新され保存ログに入る', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g1, 'C', 3);
  addRow(g2, 'B', 2); // Aは無い階
  addRow(g3, 'C', 3);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorRemoval({
    project, activeGraph: g1, equipmentId: 'A',
    commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'removed');
  assert.deepEqual(saveLog, ['p2', 'p3'], 'Aの無い2階も番号更新で保存されるはず');
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows.find(r => r.id === 'B').no, 1);
  const decoded3 = decodeFloor(project, g3.plane, store.get('p3'));
  assert.equal(decoded3.equipmentRows.find(r => r.id === 'C').no, 2);
  assert.equal(g1.equipmentRows.find(r => r.id === 'C').no, 2, 'アクティブ階(1階)のCも詰まるはず');
});

test('runElevatorRemoval: 1つの昇降路に3基が並ぶ全階で中央を削除→各階で昇降路が2つに分かれ、I1成立', async () => {
  const { project, graphs } = setupProjectWide(3);
  install3AcrossAllFloors(graphs);
  const [, g2] = graphs;
  for (const g of graphs) assertShaftInvariant(g, `install直後 ${g.plane.name}`);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  const result = await runElevatorRemoval({
    project, activeGraph: g2, equipmentId: 'mid',
    commitActive: makeCommitActiveForRemoval(g2, 'mid', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'removed');
  assertShaftInvariant(g2, '2階(削除後・アクティブ)');
  assert.equal(g2.equipmentRows.length, 2);
  for (const planeId of ['p1', 'p3']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assertShaftInvariant(decoded, planeId);
    assert.equal(decoded.equipmentRows.length, 2, `${planeId}は中央が消えて2行`);
  }
});

test('runElevatorRemoval: 下方延長したグループ(1〜3階)の削除→全階から消える', async () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const installCommitCalls = [];
  const installResult = await runElevatorInstall({
    project, activeGraph: g1, cells: new Set([leftKey(g1)]),
    commitActive: makeCommitActive(g1, installCommitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });
  assert.equal(installResult.status, 'installed');
  const equipmentId = installCommitCalls[0].id;

  const removeCalls = [];
  const result = await runElevatorRemoval({
    project, activeGraph: g1, equipmentId,
    commitActive: makeCommitActiveForRemoval(g1, equipmentId, removeCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'removed');
  assert.equal(g1.equipmentRows.length, 0);
  for (const planeId of ['p2', 'p3']) {
    const decoded = decodeFloor(project, project.planeMap.get(planeId), store.get(planeId));
    assert.equal(decoded.equipmentRows.length, 0, `${planeId}も削除されるはず`);
  }
});

test('runElevatorRemoval: 存在しない器具idはnoop・保存0件・commitActive 0回', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorRemoval({
    project, activeGraph: g1, equipmentId: 'no-such-id',
    commitActive: makeCommitActiveForRemoval(g1, 'no-such-id', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'noop');
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 0);
});

test('runElevatorRemoval: 検討案の平面がアクティブ→自階だけ確定。採用階(1階)のストアは不変', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  addRow(altGraph, 'A', 1);
  const store = new Map();
  store.set(g1.plane.id, serializeGraph(g1));
  const before1 = store.get(g1.plane.id);
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorRemoval({
    project, activeGraph: altGraph, equipmentId: 'A',
    commitActive: makeCommitActiveForRemoval(altGraph, 'A', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'removed');
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 1);
  assert.equal(commitCalls[0], null, 'Q5ではnoByIdをnullで渡す（自階だけの番号詰めに委ねる）');
  assert.equal(altGraph.equipmentRows.length, 0);
  assert.equal(store.get(g1.plane.id), before1, '採用階(1階)のストアは変わらないはず');
});

test('【T6・失敗系】runElevatorRemoval: peekが例外→ERR_ELEVATOR_REMOVE_FAILEDを付けて再スロー・書き込みゼロ・commitActive 0回', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  addRow(g1, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];
  const peekFn = async () => { throw new Error('IDB読込み失敗（意図した失敗）'); };

  await assert.rejects(
    () => runElevatorRemoval({
      project, activeGraph: g1, equipmentId: 'A',
      commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn,
      saveFloorFn: makeStoreSave(store, saveLog),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_REMOVE_FAILED); return true; },
  );
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 0);
});

test('【失敗系】runElevatorRemoval: 3階の保存が例外→2階がbeforeに戻り・commitActive 0回・識別コード付きで例外', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorRemoval({
      project, activeGraph: g1, equipmentId: 'A',
      commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, saveLog, { failOn: 'p3' }),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_REMOVE_FAILED); return true; },
  );
  assert.deepEqual(saveLog, ['p2', 'p2'], '2階は削除で1回・巻き戻しで1回保存される（3階の保存は失敗しログに残らない）');
  assert.equal(commitCalls.length, 0);
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows.length, 1, '2階はbeforeへ巻き戻る（Aの行が残る）');
});

// QA指摘F1（2026-09-30）: 従来はsaveFloorFnだけがtryの中で、applyEquipmentRemovalToFloor
// （変更処理）・serializeGraph（直列化）の例外は捕捉されなかった。変更処理そのものの失敗を、
// peekが返す一時グラフのメソッド（graph.removeEquipmentRow）を差し替える形で注入する。
test('【QA指摘F1・失敗系】runElevatorRemoval: 3階の変更処理（removeEquipment経由のgraph.removeEquipmentRow）が例外→2階がbeforeに戻り・commitActive 0回・undo件数不変・識別コード付きで例外', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const basePeek = makeStorePeek(project, store);
  let injectFired = 0;
  const peekFn = (plane) => {
    const g = basePeek(plane);
    if (plane.id === g3.plane.id) {
      g.removeEquipmentRow = () => { injectFired++; throw new Error('注入した変更処理の失敗'); };
    }
    return g;
  };
  const saveLog = [];
  const commitCalls = [];
  const undoCountBefore = undoManager._undoStack.length;

  await assert.rejects(
    () => runElevatorRemoval({
      project, activeGraph: g1, equipmentId: 'A',
      commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn,
      saveFloorFn: makeStoreSave(store, saveLog),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_REMOVE_FAILED); return true; },
  );

  assert.equal(injectFired, 1, '注入は1回だけ発火するはず');
  assert.deepEqual(saveLog, ['p2', 'p2'], '2階は削除で1回・巻き戻しで1回保存される');
  assert.equal(commitCalls.length, 0);
  assert.equal(undoManager._undoStack.length, undoCountBefore, 'undo件数は変わらないはず');
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows.length, 1, '2階はbeforeへ巻き戻る（Aの行が残る）');
});

test('【失敗系】runElevatorRemoval: commitActiveが例外→全上階(2・3階)がbeforeへ戻る', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorRemoval({
      project, activeGraph: g1, equipmentId: 'A',
      commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls, { throws: true }),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_REMOVE_FAILED); return true; },
  );
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  const decoded3 = decodeFloor(project, g3.plane, store.get('p3'));
  assert.equal(decoded2.equipmentRows.length, 1);
  assert.equal(decoded3.equipmentRows.length, 1);
});

test('【失敗系】runElevatorRemoval: commitActiveがundoエントリを返さない(null)→識別コード付き例外・上階が戻る', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorRemoval({
      project, activeGraph: g1, equipmentId: 'A',
      commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls, { returnsNull: true }),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_REMOVE_FAILED); return true; },
  );
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows.length, 1);
});

test('【失敗系】runElevatorRemoval: 保存後にisStillValidが偽→巻き戻してaborted', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  let callCount = 0;
  const isStillValid = () => { callCount++; return callCount === 1; }; // 1回目(手順5)はtrue、2回目(手順7)はfalse

  const result = await runElevatorRemoval({
    project, activeGraph: g1, equipmentId: 'A',
    commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls),
    isStillValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'aborted');
  assert.equal(result.message, null);
  assert.equal(commitCalls.length, 0);
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  const decoded3 = decodeFloor(project, g3.plane, store.get('p3'));
  assert.equal(decoded2.equipmentRows.length, 1);
  assert.equal(decoded3.equipmentRows.length, 1);
});

test('【失敗系】runElevatorRemoval: 世代の割り込み→巻き戻してabortedとERR_ELEVATOR_FLOORS_CHANGED（割り込みの発火回数を固定）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  const basePeek = makeStorePeek(project, store);
  let interferenceFired = 0;
  const peekFn = async (plane) => {
    const g = basePeek(plane);
    if (plane.id === g3.plane.id) { noteFloorWrite(plane.id); interferenceFired++; } // 3階のpeek直後に割り込み書込みが起きたことを模す
    return g;
  };

  const result = await runElevatorRemoval({
    project, activeGraph: g1, equipmentId: 'A',
    commitActive: makeCommitActiveForRemoval(g1, 'A', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn,
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'aborted');
  assert.equal(result.message, ERR_ELEVATOR_FLOORS_CHANGED);
  assert.equal(interferenceFired, 1, '割り込みは1回だけ発火する');
  assert.equal(commitCalls.length, 0);
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows.length, 1, '2階は保存済みだったため巻き戻る');
});

// ================================================================
// runElevatorUsageChange（ステップ5: 用途変更・全階連動）
// ================================================================

test('runElevatorUsageChange: 1階で用途を変える→全階の同じidの行が変わる。undoで全階が戻る', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  let appliedCount = 0;

  const result = await runElevatorUsageChange({
    project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
    commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls),
    isStillValid: alwaysValid, onApplied: () => { appliedCount++; },
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'changed');
  assert.equal(g1.equipmentRows[0].usage, 'freight');
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  const decoded3 = decodeFloor(project, g3.plane, store.get('p3'));
  assert.equal(decoded2.equipmentRows[0].usage, 'freight');
  assert.equal(decoded3.equipmentRows[0].usage, 'freight');
  assert.equal(appliedCount, 1);

  undoManager.undo();
  assert.equal(appliedCount, 2, 'undo後に2回');
  assert.equal(g1.equipmentRows[0].usage, 'passenger');
  const decoded2u = decodeFloor(project, g2.plane, store.get('p2'));
  const decoded3u = decodeFloor(project, g3.plane, store.get('p3'));
  assert.equal(decoded2u.equipmentRows[0].usage, 'passenger');
  assert.equal(decoded3u.equipmentRows[0].usage, 'passenger');

  undoManager.redo();
  assert.equal(appliedCount, 3, 'redo後に3回');
  assert.equal(g1.equipmentRows[0].usage, 'freight');
});

test('runElevatorUsageChange: 同じ用途はnoop・保存0件・undo件数不変', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];
  const undoCountBefore = undoManager._undoStack.length;

  const result = await runElevatorUsageChange({
    project, activeGraph: g1, equipmentId: 'A', usage: 'passenger',
    commitActive: makeCommitActiveForUsage(g1, 'A', 'passenger', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'noop');
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 0);
  assert.equal(undoManager._undoStack.length, undoCountBefore);
});

test('runElevatorUsageChange: 行が無い階（等号の分類に見えて実は行が無い）はnoop', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorUsageChange({
    project, activeGraph: g1, equipmentId: 'no-such-id', usage: 'freight',
    commitActive: makeCommitActiveForUsage(g1, 'no-such-id', 'freight', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'noop');
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 0);
});

test('runElevatorUsageChange: 検討案の平面がアクティブ→自階だけ確定', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  addRow(altGraph, 'A', 1);
  const store = new Map();
  const saveLog = [];
  const commitCalls = [];

  const result = await runElevatorUsageChange({
    project, activeGraph: altGraph, equipmentId: 'A', usage: 'freight',
    commitActive: makeCommitActiveForUsage(altGraph, 'A', 'freight', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, saveLog),
  });

  assert.equal(result.status, 'changed');
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 1);
  assert.equal(altGraph.equipmentRows[0].usage, 'freight');
});

// QA指摘F7（2026-09-30）: usageがEvUsageのいずれでもなければ、noop判定・検討案の平面の分岐
// より前に拒否する——アクティブ階に行が無い・検討案の平面（1階建て）でも検査される。
test('【QA指摘F7・失敗系】runElevatorUsageChange: usageが不正な値なら、行が無い・検討案の平面でも識別コード付きで拒否する（noopにならない）', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  // altGraphには行が無い（本来ならnoopになる状態）。それでも不正な用途は先に拒否されるはず。
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorUsageChange({
      project, activeGraph: altGraph, equipmentId: 'no-such-id', usage: 'not-a-usage',
      commitActive: makeCommitActiveForUsage(altGraph, 'no-such-id', 'not-a-usage', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, new Map()),
      saveFloorFn: makeStoreSave(new Map(), []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_USAGE_FAILED); return true; },
  );
  assert.equal(commitCalls.length, 0, 'commitActiveへは到達しないはず');
});

test('【T6・失敗系】runElevatorUsageChange: peekが例外→ERR_ELEVATOR_USAGE_FAILEDを付けて再スロー・書き込みゼロ', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  addRow(g1, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];
  const peekFn = async () => { throw new Error('IDB読込み失敗（意図した失敗）'); };

  await assert.rejects(
    () => runElevatorUsageChange({
      project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
      commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn,
      saveFloorFn: makeStoreSave(store, saveLog),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_USAGE_FAILED); return true; },
  );
  assert.deepEqual(saveLog, []);
  assert.equal(commitCalls.length, 0);
});

test('【失敗系】runElevatorUsageChange: commitActiveが例外→上階(2階)がbeforeへ戻る', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorUsageChange({
      project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
      commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls, { throws: true }),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_USAGE_FAILED); return true; },
  );
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows[0].usage, 'passenger', '2階はbeforeへ戻るはず');
});

// QA指摘T2（2026-09-30）: runElevatorRemovalには揃っていたが、runElevatorUsageChangeには
// 無かった失敗系3件を足す（isStillValidの2回目の呼び出しを外す変異で赤くなることを狙う）。

test('【QA指摘T2・失敗系】runElevatorUsageChange: 保存後にisStillValidが偽→巻き戻してaborted', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  let callCount = 0;
  const isStillValid = () => { callCount++; return callCount === 1; }; // 1回目(手順「isStillValid確認」)はtrue、2回目(保存後の再確認)はfalse

  const result = await runElevatorUsageChange({
    project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
    commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls),
    isStillValid, onApplied: () => {},
    peekFn: makeStorePeek(project, store),
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'aborted');
  assert.equal(result.message, null);
  assert.equal(commitCalls.length, 0);
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  const decoded3 = decodeFloor(project, g3.plane, store.get('p3'));
  assert.equal(decoded2.equipmentRows[0].usage, 'passenger', '2階はbeforeへ巻き戻るはず');
  assert.equal(decoded3.equipmentRows[0].usage, 'passenger', '3階はbeforeへ巻き戻るはず');
});

test('【QA指摘T2・失敗系】runElevatorUsageChange: 3階の保存が例外→2階がbeforeに戻り・commitActive 0回・用途変更の識別コード付きで例外', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const saveLog = [];
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorUsageChange({
      project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
      commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, saveLog, { failOn: 'p3' }),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_USAGE_FAILED); return true; },
  );
  assert.deepEqual(saveLog, ['p2', 'p2'], '2階は用途変更で1回・巻き戻しで1回保存される（3階の保存は失敗しログに残らない）');
  assert.equal(commitCalls.length, 0, '上階の保存で失敗したためcommitActiveへ到達しない');
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows[0].usage, 'passenger', '2階はbeforeへ戻るはず');
});

// QA指摘F1（2026-09-30）: 従来はsaveFloorFnだけがtryの中で、applyEquipmentUsageToFloor
// （変更処理）・serializeGraph（直列化）の例外は捕捉されなかった。変更処理そのものの失敗を、
// peekが返す一時グラフの行オブジェクトのメソッド（row.setUsage）を差し替える形で注入する。
test('【QA指摘F1・失敗系】runElevatorUsageChange: 3階の変更処理（applyEquipmentUsageToFloor経由のrow.setUsage）が例外→2階がbeforeに戻り・commitActive 0回・undo件数不変・識別コード付きで例外', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1); addRow(g3, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const basePeek = makeStorePeek(project, store);
  let injectFired = 0;
  const peekFn = (plane) => {
    const g = basePeek(plane);
    if (plane.id === g3.plane.id) {
      const row = g.equipmentRows.find(r => r.id === 'A');
      row.setUsage = () => { injectFired++; throw new Error('注入した変更処理の失敗'); };
    }
    return g;
  };
  const saveLog = [];
  const commitCalls = [];
  const undoCountBefore = undoManager._undoStack.length;

  await assert.rejects(
    () => runElevatorUsageChange({
      project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
      commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn,
      saveFloorFn: makeStoreSave(store, saveLog),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_USAGE_FAILED); return true; },
  );

  assert.equal(injectFired, 1, '注入は1回だけ発火するはず');
  assert.deepEqual(saveLog, ['p2', 'p2'], '2階は用途変更で1回・巻き戻しで1回保存される');
  assert.equal(commitCalls.length, 0);
  assert.equal(undoManager._undoStack.length, undoCountBefore, 'undo件数は変わらないはず');
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows[0].usage, 'passenger', '2階はbeforeへ戻るはず');
});

test('【QA指摘T2・失敗系】runElevatorUsageChange: commitActiveがundoエントリを返さない(null)→用途変更の識別コード付き例外・上階が戻る', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];

  await assert.rejects(
    () => runElevatorUsageChange({
      project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
      commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls, { returnsNull: true }),
      isStillValid: alwaysValid, onApplied: () => {},
      peekFn: makeStorePeek(project, store),
      saveFloorFn: makeStoreSave(store, []),
    }),
    (err) => { assert.equal(err.code, ERR_ELEVATOR_USAGE_FAILED); return true; },
  );
  const decoded2 = decodeFloor(project, g2.plane, store.get('p2'));
  assert.equal(decoded2.equipmentRows[0].usage, 'passenger', '2階はbeforeへ戻るはず');
});

test('【失敗系】runElevatorUsageChange: 世代の割り込み→巻き戻してabortedとERR_ELEVATOR_FLOORS_CHANGED', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addRow(g1, 'A', 1); addRow(g2, 'A', 1);
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const commitCalls = [];
  const basePeek = makeStorePeek(project, store);
  let interferenceFired = 0;
  const peekFn = async (plane) => {
    const g = basePeek(plane);
    if (plane.id === g2.plane.id) { noteFloorWrite(plane.id); interferenceFired++; }
    return g;
  };

  const result = await runElevatorUsageChange({
    project, activeGraph: g1, equipmentId: 'A', usage: 'freight',
    commitActive: makeCommitActiveForUsage(g1, 'A', 'freight', commitCalls),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn,
    saveFloorFn: makeStoreSave(store, []),
  });

  assert.equal(result.status, 'aborted');
  assert.equal(result.message, ERR_ELEVATOR_FLOORS_CHANGED);
  assert.equal(interferenceFired, 1);
  assert.equal(commitCalls.length, 0);
});
