// finish/equipment/equipmentFloorSync.js（昇降機の設置。I/Oを含む手順の本体）の単体テスト。
// 昇降機の仕様追加 ステップ4・S3a。
//
// peekFn・saveFloorFn は注入する（floorSwapManager.peek・storage/db.js saveFloor という
// モジュールスコープのシングルトンは差し替えない。設計書 S3a §1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../../core.js';
import { worldToCell } from '../gridCells.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { undoManager } from '../../undoManager.js';
import { noteFloorWrite } from '../../storage/floorWriteGeneration.js';
import { makeStorePeek, makeStoreSave, decodeFloor, assertShaftInvariant } from './equipmentTestFixtures.js';
import { installEquipment } from './equipmentOps.js';
import { runElevatorInstall, loadOtherFloorEquipmentRows } from './equipmentFloorSync.js';
import { ERR_ELEVATOR_FLOORS_CHANGED, ERR_ELEVATOR_OP_FAILED, ERR_ELEVATOR_UPPER_CONFLICT } from '../../error.js';

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
// Q5: 検討案の平面がアクティブ
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
