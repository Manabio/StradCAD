// beamAxisMove.test.js / graphSnapshot.test.js と同じ方針: ダックタイピングでは effectiveValue・
// centerLines・structGraph 連携の実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '../core.js';
import { ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS } from '../error.js';
import { undoManager } from '../undoManager.js';
import {
  shouldSuggestWoodStructure, commitCLMoveOp, deleteCenterLineWithUndo, addCenterLineFromDialog,
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
