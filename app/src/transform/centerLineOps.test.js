// beamAxisMove.test.js / graphSnapshot.test.js と同じ方針: ダックタイピングでは effectiveValue・
// centerLines・structGraph 連携の実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '../core.js';
import {
  ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS,
  ERR_CL_CONVERT_ATTACHED, ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_DUP_FLOOR, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE,
} from '../error.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import {
  shouldSuggestWoodStructure, commitCLMoveOp, deleteCenterLineWithUndo, addCenterLineFromDialog,
  promoteCenterToGridWithUndo, demoteGridToCenterWithUndo,
} from './centerLineOps.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// project.structGraph・graph._structGraph の連携（struct CL の追加・重複判定）が必要なテスト用。
function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- shouldSuggestWoodStructure ----

test('shouldSuggestWoodStructure: appMode!=="floorplan"なら常にfalse', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '未定' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'structure', CenterLineType.VERTICAL, [910]), false);
});

test('shouldSuggestWoodStructure: 主構造が確定済み（未定でない）なら提案しない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '木造（在来）' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'floorplan', CenterLineType.VERTICAL, [910]), false);
});

test('shouldSuggestWoodStructure: グリッドが追加CL自身1本しか無ければ比較対象が無くfalse', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 910, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '未定' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'floorplan', CenterLineType.VERTICAL, [910]), false);
});

test('shouldSuggestWoodStructure: 既存グリッドと910mm間隔ならtrue', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '未定' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'floorplan', CenterLineType.VERTICAL, [910]), true);
});

// ---- commitCLMoveOp ----

test('commitCLMoveOp: 移動量ゼロ（effectiveValue===originalValue）ならundoを積まずtoast:null', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const project = {};
  const beforeTop = undoManager.peekUndo();

  const result = commitCLMoveOp(graph, project, cl, cl.value);

  assert.equal(result.toast, null);
  assert.equal(cl.pendingDelta, 0);
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれないはず');
});

test('commitCLMoveOp: 梁芯移動は移動元座標をexcludedWallBeamAxesへ記録し、undoで移動前座標へ戻る', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 8000,
  });
  const clId = cl.id;
  const project = {
    structuralInfo: { mainStructure: 'S造' },
    memberGroupLedger: new Map(),
    memberNumberIndex: new Map(),
    planes: [],
  };
  cl.pendingDelta = 500; // 2000 → 2500 へドラッグ確定

  const result = commitCLMoveOp(graph, project, cl, 2000);

  assert.equal(cl.value, 2500);
  assert.equal(cl.pendingDelta, 0);
  assert.ok(graph.excludedWallBeamAxes.has('X:2000'), '移動元座標(2000)が除外集合に記録される');
  assert.equal(result.toast, null, '直交大梁(host)が無いため小梁本数は0→0で変化なし＝トーストなし');

  // 梁芯分岐のUndoはグラフスナップショット方式（graph.clear()→再構築）のため、undo後は
  // 同一idの「新しいCenterLineインスタンス」に置き換わる——元の cl 参照ではなく id で引き直す
  // （graphSnapshot.js applySnapshot 参照）。
  undoManager.undo();
  const restored = graph.shapeMap.get(clId);
  assert.equal(restored.value, 2000, 'undoで移動前座標に戻る');
  assert.equal(graph.excludedWallBeamAxes.has('X:2000'), false, 'undoで除外集合の記録も取り消される');
});

// ---- deleteCenterLineWithUndo ----

test('deleteCenterLineWithUndo: 中心線削除はexcludedWallBeamAxesを変えず、梁芯削除だけ記録する', () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const beamCL   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const project = {};

  deleteCenterLineWithUndo(graph, project, centerCL);
  assert.equal(graph.shapeMap.has(centerCL.id), false);
  assert.equal(graph.excludedWallBeamAxes.size, 0, '中心線の削除ではexcludedWallBeamAxesは変化しない');

  deleteCenterLineWithUndo(graph, project, beamCL);
  assert.equal(graph.shapeMap.has(beamCL.id), false);
  assert.ok(graph.excludedWallBeamAxes.has('Y:3000'), '梁芯の削除は除外集合に記録される');

  undoManager.undo();
  assert.ok(graph.shapeMap.has(beamCL.id), '直前の梁芯削除はundoで復元される');
});

// ---- addCenterLineFromDialog ----

test('addCenterLineFromDialog: 通り芯を既存通り芯と同座標に追加しようとするとdone:falseでERR_CL_DUPLICATE、undoは積まれない', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, false);
  assert.equal(result.toast, ERR_CL_DUPLICATE('struct'));
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 既存通り芯と同座標へ中心線を追加しようとするとdone:falseでERR_CL_STRUCT_EXISTS', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, false);
  assert.equal(result.toast, ERR_CL_STRUCT_EXISTS);
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 梁芯は他種別CLと同位置に双方向で共存できずdone:false', () => {
  const { project, graph } = makeProjectWithGraph();

  // 既存=梁芯、新規=中心線
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const r1 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r1.done, false);
  assert.equal(r1.toast, ERR_CL_DUPLICATE('beam'));

  // 既存=中心線、新規=梁芯（別軸で独立させる）
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false });
  const r2 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 2000, perpCoord: 0 }, value: 2000, kind: 'beam', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('center'));
});

test('addCenterLineFromDialog: 既存中心線位置への通り芯追加は中心線を削除して昇格し、done:true+ERR_CL_CENTER_UPGRADEDでundo可能', () => {
  const { project, graph } = makeProjectWithGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const centerId = centerCL.id;

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  assert.equal(result.toast, ERR_CL_CENTER_UPGRADED);
  assert.deepEqual(result.suggestWood, { clType: CenterLineType.VERTICAL, newValues: [1000] });
  assert.equal(graph.shapeMap.has(centerId), false, '旧中心線は削除される');
  assert.ok(project.structGraph.centerLines.some(cl => cl.value === 1000), '通り芯として structGraph に追加される');

  undoManager.undo();
  assert.ok(graph.shapeMap.has(centerId), 'undoで中心線が復元される');
  assert.equal(project.structGraph.centerLines.some(cl => cl.value === 1000), false, 'undoで通り芯は消える');
});

// ---- promoteCenterToGridWithUndo / demoteGridToCenterWithUndo ----
// findFloorsWithCounterpartCL・propagateDemotedCenterLine は project.planeMap の「アクティブ以外の
// 全Plane」を floorSwapManager.peek（IndexedDB経由）する。単一階の project では対象階が0件となり
// peek は発生しないため、そのまま node:test で検証できる（下の大半のテスト）。複数階をまたぐ
// シナリオ（重複ガード・複製伝播）は structural/wallBeamAxes.test.js:197-207 と同じ方式——
// floorSwapManager.peek をテスト中だけ差し替え（try/finallyで必ず復元）、実IDBを経由せずに
// ロジックだけを検証する。IDB不在を理由に断念しない。

test('promoteCenterToGridWithUndo: 直交通り芯があれば通り芯化しundoで中心線に戻る', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });
  const clId = cl.id;

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(graph.shapeMap.has(clId), false);
  assert.equal(project.structGraph.shapeMap.has(clId), true);
  assert.equal(project.structGraph.shapeMap.get(clId).discipline, Discipline.STRUCT);

  undoManager.undo();
  assert.equal(graph.shapeMap.has(clId), true, 'undoで中心線に戻る');
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  const restored = graph.shapeMap.get(clId);
  assert.equal(restored.discipline, Discipline.ARCH);
  assert.equal(restored.labeled, false);

  undoManager.redo();
  assert.equal(graph.shapeMap.has(clId), false);
  assert.equal(project.structGraph.shapeMap.has(clId), true, 'redoで通り芯に戻る');
});

test('promoteCenterToGridWithUndo: 斜線が取り付いた中心線はtoast:ERR_CL_CONVERT_ATTACHEDでundoを積まない', async () => {
  const { project, graph } = makeProjectWithGraph();
  // NO_GRIDガード（F4）を通過させ、ATTACHEDガードを狙って踏むため直交通り芯を2本用意する。
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000,  { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  graph.addDiagonalLine(ix, graph.addPoint(2000, 2000));
  const beforeTop = undoManager.peekUndo();

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

  assert.equal(toast, ERR_CL_CONVERT_ATTACHED);
  assert.equal(graph.shapeMap.has(cl.id), true, '変換されず階グラフに残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('demoteGridToCenterWithUndo: 直交通り芯2本があれば中心線化しundoで通り芯に戻る', async () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const clId = cl.id;

  const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  assert.equal(graph.shapeMap.has(clId), true);
  const demoted = graph.shapeMap.get(clId);
  assert.equal(demoted.discipline, Discipline.ARCH);
  assert.equal(demoted.labeled, false);
  assert.deepEqual(demoted.extentLoRef, { clId: y1.id, offset: 0 });
  assert.deepEqual(demoted.extentHiRef, { clId: y2.id, offset: 0 });

  undoManager.undo();
  assert.equal(graph.shapeMap.has(clId), false, 'undoで通り芯に戻る');
  assert.equal(project.structGraph.shapeMap.has(clId), true);
  assert.equal(project.structGraph.shapeMap.get(clId).labeled, true);
});

test('demoteGridToCenterWithUndo: 直交する通り芯が1本しかなければtoast:ERR_CL_CONVERT_NO_GRIDでundoを積まない', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

  assert.equal(toast, ERR_CL_CONVERT_NO_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, '変換されずstructGraphに残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('demoteGridToCenterWithUndo: discipline:STRUCTだがlabeled:falseの想定外CLはtoastにエラーが入りundoも積まれず例外も出ない', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

  assert.equal(typeof toast, 'string');
  assert.ok(toast.length > 0, 'エラーメッセージがtoastに入る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

// ---- N5: 同期ガードをIDB peekより先に評価する ----

test('promoteCenterToGridWithUndo: 同期ガード（NO_GRID）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 直交通り芯0本
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_NO_GRID);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('demoteGridToCenterWithUndo: 同期ガード（想定外の discipline/labeled 組合せ）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

    assert.equal(typeof toast, 'string');
    assert.ok(toast.length > 0);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 複数階シナリオ（floorSwapManager.peek 差し替え方式） ----

test('promoteCenterToGridWithUndo: 他階に同座標の中心線があればフロア名入りトーストで拒否され変換されない', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beforeTop = undoManager.peekUndo();

  // floorSwapManager.peek はIndexedDBに依存するため、テスト用に一時的に差し替える
  // （structural/wallBeamAxes.test.js:197-207 と同じ方式。floorSwapManagerはシングルトンインスタンス）。
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR('2階'));
    assert.equal(activeGraph.shapeMap.has(cl.id), true, '変換されず階グラフに残る');
    assert.equal(project.structGraph.shapeMap.has(cl.id), false);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('demoteGridToCenterWithUndo: 他階（アクティブ階の移籍先ではない階）に同座標の中心線があればフロア名入りトーストで拒否され変換されない（F3-2）', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 他階に同座標の中心線
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await demoteGridToCenterWithUndo(activeGraph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE('2階'), '降格専用の文言（「中心線にできません」）が使われる（N1）');
    assert.equal(project.structGraph.shapeMap.has(cl.id), true, '変換されずstructGraphに残る（片階だけ複製漏れを防ぐ）');
    assert.equal(activeGraph.shapeMap.has(cl.id), false);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});
