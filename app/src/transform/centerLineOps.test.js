// beamAxisMove.test.js / graphSnapshot.test.js と同じ方針: ダックタイピングでは effectiveValue・
// centerLines・structGraph 連携の実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, centerLineKind, OpeningCategory, StructuralMaterialType,
} from '../core.js';
import {
  ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS,
  ERR_CL_CONVERT_ATTACHED, ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_DUP_FLOOR, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE,
  ERR_CL_CONVERT_DUP_DEMOTE, ERR_CL_DELETE_LAST_GRID, ERR_CL_CONVERT_DUP,
} from '../error.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { calcStep } from '../renderer/clMoveMath.js';
import {
  shouldSuggestWoodStructure, commitCLMoveOp, deleteCenterLineWithUndo, addCenterLineFromDialog,
  promoteCenterToGridWithUndo, demoteGridToCenterWithUndo, setCenterLineStructuralListener,
  applyCLEccentricityWithUndo,
} from './centerLineOps.js';
import { CL_KINDS, coexistenceAt } from '../core/centerLineKindPolicy.js';
import { BeamAxisOrigin } from '../core/centerLine.js';

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

// ---- commitCLMoveOp: 中心線移動 → 構造同期リスナー＋壁由来梁芯の追従（段階(b)・2026-09-25） ----
// setCenterLineStructuralListener はテスト間で必ず finally で null に戻す（他テストへ漏らさない）。

test('commitCLMoveOp: 中心線の移動は構造同期リスナーを(graph, project, "activeAndAbove")で呼ぶ（確定1回・undo1回・redo1回＝計3回。T1）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const project = {};
  cl.pendingDelta = 500; // 1000→1500へドラッグ確定

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, 1000);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '確定直後に1回呼ばれるはず');
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'activeAndAbove');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(cl.value, 1000);

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(cl.value, 1500);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 参照する中心線が無い補助線の移動は構造同期リスナーを呼ばない（T2。段階(d)で「参照なし」に読み替え）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  const project = {};
  cl.pendingDelta = 300;

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    commitCLMoveOp(graph, project, cl, 2000);
    assert.equal(calls, 0);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 中心線がextentLoRefで参照する補助線の移動は構造同期リスナーを(graph, project, "activeAndAbove")で呼ぶ（確定1回・undo1回・redo1回＝計3回。段階(d)・2026-09-25）', () => {
  const graph = makeGraph();
  const aux = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: aux.id, offset: 0 },
  });
  const project = {};
  aux.pendingDelta = 300; // 2000→2300へドラッグ確定

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = commitCLMoveOp(graph, project, aux, 2000);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '確定直後に1回呼ばれるはず');
    assert.equal(calls[0].scope, 'activeAndAbove', '補助線自身のscopeはnullだが、参照する中心線のscopeが合成される');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(aux.value, 2000);

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(aux.value, 2300);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 補助線をrefIdで参照する中心線の壁は補助線の移動で動き、壁由来梁芯も追従する（段階(d)・2026-09-25）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const aux = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  // はね出し追従の親子参照（refId）——centerCLの座標はauxのeffectiveValue + refOffsetから導出される
  // （core/centerLine.js get value/effectiveValue）。壁はこのcenterCLを軸に持つ。
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, {
    labeled: false, discipline: Discipline.ARCH, refId: aux.id, refOffset: 0,
  });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  const project = {};
  aux.pendingDelta = 300; // 2000→2300へドラッグ確定（centerCLはrefId経由で追従する）

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = commitCLMoveOp(graph, project, aux, 2000);
    assert.equal(toast, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'activeAndAbove', '補助線を参照するcenterCLのscopeが合成される');
    assert.equal(centerCL.value, 2300, 'refId子のcenterCLは補助線の移動へ自動で追従する');
    const axAfter = graph.shapeMap.get(beamAxisId);
    assert.equal(axAfter.value, 2300, '壁の下地帯中心の移動分だけ壁由来梁芯も追従するはず');

    undoManager.undo();
    assert.equal(calls.length, 2);
    assert.equal(aux.value, 2000);
    assert.equal(centerCL.value, 2000);
    const axRestored = graph.shapeMap.get(beamAxisId);
    assert.equal(axRestored.value, 2000, 'undoで梁芯も戻る');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 通り芯の移動は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回。段階(c)でT3を反転。2026-09-25）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 結合回避用に離しておく
  const project = {};
  cl.pendingDelta = 500;

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, 1000);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '確定直後に1回呼ばれるはず');
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'all');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(cl.value, 1000);

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(cl.value, 1500);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 通り芯の移動はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・2026-09-26）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const project = {};
  cl.pendingDelta = 500;

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, 1000);
    assert.equal(toast, null);
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');

    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: undoでは箱(floorRecords)のbefore保存がnotifyより前に実行される（順序スパイ・段階(g)・2026-09-26）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const project = {}; // activePlane未設定＝applyFloorUndoRecordsは常にsaveFloorFn分岐
  cl.pendingDelta = 500;

  const order = [];
  const saveFloorFn = async (planeId, bytes) => { order.push(`save:${planeId}:${bytes}`); };
  setCenterLineStructuralListener((g, p, scope, undoRecords) => {
    // 構造同期（実体はstructuralSync.js）が他階f1へ書いたことを模す（配列があるのはコミット時のみ）。
    if (undoRecords) undoRecords.push({ planeId: 'f1', before: 'b0', after: 'a1' });
    order.push('notify');
  });
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, 1000, { saveFloorFn });
    assert.equal(toast, null);
    assert.deepEqual(order, ['notify'], 'コミット時は記録するだけで保存はしない');

    order.length = 0;
    undoManager.undo();
    assert.deepEqual(order, ['save:f1:b0', 'notify'], 'undoではbefore保存がnotifyより前のはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 同じ階(f1)への連鎖書込み(f0→f1→f2)がある箱で、undoの最後の保存はf0・redoの最後の保存はf2（発見④と同じ「同一planeIdが複数回出てよい」順序。段階(g)・2026-09-26）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const project = {};
  cl.pendingDelta = 500;

  const saves = [];
  const saveFloorFn = async (planeId, bytes) => { saves.push({ planeId, bytes }); };
  setCenterLineStructuralListener((g, p, scope, undoRecords) => {
    if (undoRecords) {
      // 同じ階へ2回書いた構造同期の実行を模す（例: 絶対吸収＋複製回収のように同一配列へ2件積む）。
      undoRecords.push({ planeId: 'f1', before: 'f0', after: 'f1' });
      undoRecords.push({ planeId: 'f1', before: 'f1', after: 'f2' });
    }
  });
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, 1000, { saveFloorFn });
    assert.equal(toast, null);

    saves.length = 0;
    undoManager.undo();
    const f1Saves = saves.filter(s => s.planeId === 'f1');
    assert.equal(f1Saves.at(-1).bytes, 'f0', 'undoの最後の保存はf0（真の元の状態）のはず');

    saves.length = 0;
    undoManager.redo();
    const f1SavesRedo = saves.filter(s => s.planeId === 'f1');
    assert.equal(f1SavesRedo.at(-1).bytes, 'f2', 'redoの最後の保存はf2（最終状態）のはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 偏芯壁の下地帯中心に乗る壁由来梁芯は通り芯の移動分だけ同idで追従し、undoで戻る（段階(c)追加①・2026-09-25）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  // backingOffsetを与えて下地帯中心を通り芯からずらす（偏芯壁）
  graph.addWall(axisCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 40, backingDepth: 120, wallFinish: 12.5 });
  const backingCenterY = 2000 + 40; // wallBackingCenterCoordの下地帯中心
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, backingCenterY, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  const project = {};
  axisCL.pendingDelta = 300; // 2000→2300

  const { toast } = commitCLMoveOp(graph, project, axisCL, 2000);
  assert.equal(toast, null);
  assert.equal(axisCL.value, 2300);
  const axAfter = graph.shapeMap.get(beamAxisId);
  assert.equal(axAfter.id, beamAxisId, '同idのまま追従するはず');
  assert.equal(axAfter.value, backingCenterY + 300, '通り芯の移動量ぶんだけ梁芯も動くはず');

  undoManager.undo();
  const axRestored = graph.shapeMap.get(beamAxisId);
  assert.equal(axisCL.value, 2000, 'undoで通り芯が戻る');
  assert.equal(axRestored.value, backingCenterY, 'undoで梁芯も戻る');
});

test('commitCLMoveOp: 対称壁（backingOffset===0）だけが乗る通り芯の移動では梁芯の本数・値は変わらない（段階(c)追加②・2026-09-25）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addWall(axisCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const project = {};
  const beamCountBefore = graph.centerLines.filter((c) => centerLineKind(c) === 'beam').length;
  axisCL.pendingDelta = 300;

  const { toast } = commitCLMoveOp(graph, project, axisCL, 2000);
  assert.equal(toast, null);
  assert.equal(axisCL.value, 2300);
  const beamCountAfter = graph.centerLines.filter((c) => centerLineKind(c) === 'beam').length;
  assert.equal(beamCountAfter, beamCountBefore, '対称壁だけなら梁芯は生成・変化しないはず');
});

test('【失敗系】commitCLMoveOp: 通り芯の移動は構造同期リスナー未設定（null）でも例外なく行える（段階(c)・2026-09-25）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const project = {};
  cl.pendingDelta = 500;

  assert.doesNotThrow(() => commitCLMoveOp(graph, project, cl, 1000));
  assert.equal(cl.value, 1500);
  assert.doesNotThrow(() => undoManager.undo());
  assert.equal(cl.value, 1000);
});

test('【失敗系】commitCLMoveOp: 通り芯の移動量ゼロは構造同期リスナーを呼ばずundoも積まない（段階(c)・2026-09-25）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const project = {};
  const beforeTop = undoManager.peekUndo();

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, cl.value);
    assert.equal(toast, null);
    assert.equal(calls, 0);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 梁芯の移動は構造同期リスナーを呼ばない（専用の追従経路wallBeamAxisFollow.jsと二重に動かさないため・条件10。T4）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 8000,
  });
  const project = {
    structuralInfo: { mainStructure: 'S造' }, memberGroupLedger: new Map(), memberNumberIndex: new Map(), planes: [],
  };
  cl.pendingDelta = 500;

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    commitCLMoveOp(graph, project, cl, 2000);
    assert.equal(calls, 0);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 移動量ゼロ（中心線）は構造同期リスナーを呼ばずundoも積まない（T5）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const project = {};
  const beforeTop = undoManager.peekUndo();

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = commitCLMoveOp(graph, project, cl, cl.value);
    assert.equal(toast, null);
    assert.equal(calls, 0);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('commitCLMoveOp: 結合が起きる移動でも構造同期リスナーは1回、undoで吸収側CLが同idで戻りリスナーも呼ばれる（T6）', () => {
  const graph = makeGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 500, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 0, extentHi: 1000,
  });
  const neighbor = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: 1000, extentHi: 2000,
  });
  const neighborId = neighbor.id;
  const project = {};
  subject.pendingDelta = 500; // 500→1000（neighborと同座標に達し結合するはず）

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push(scope));
  try {
    const { toast } = commitCLMoveOp(graph, project, subject, 500);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '結合が起きても構造同期リスナーは1回のはず');
    assert.equal(calls[0], 'activeAndAbove');
    assert.equal(graph.shapeMap.has(neighborId), false, '結合で吸収された側は削除される');
    assert.equal(subject.extentHi, 2000, 'survivorのextentが延伸される');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでもリスナーが呼ばれるはず');
    assert.equal(graph.shapeMap.has(neighborId), true, 'undoで吸収側CLが同idで戻る');
    assert.equal(subject.value, 500, 'undoで移動も戻る');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】commitCLMoveOp: 構造同期リスナー未設定（null）でも中心線の移動・undoが例外なく行える（T7）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const project = {};
  cl.pendingDelta = 500;

  assert.doesNotThrow(() => commitCLMoveOp(graph, project, cl, 1000));
  assert.equal(cl.value, 1500);
  assert.doesNotThrow(() => undoManager.undo());
  assert.equal(cl.value, 1000);
});

test('【失敗系】commitCLMoveOp: 中心線が参照する補助線の移動は構造同期リスナー未設定（null）でも例外なく行える（段階(d)・2026-09-25）', () => {
  const graph = makeGraph();
  const aux = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: aux.id, offset: 0 },
  });
  const project = {};
  aux.pendingDelta = 300;

  assert.doesNotThrow(() => commitCLMoveOp(graph, project, aux, 2000));
  assert.equal(aux.value, 2300);
  assert.doesNotThrow(() => undoManager.undo());
  assert.equal(aux.value, 2000);
});

test('commitCLMoveOp: 壁由来梁芯が下地帯中心の移動分だけ追従し、undoで値と除外キーが戻る（T8）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  graph.excludedWallBeamAxes.add('Y:2000'); // 手動でこの座標を除外していた想定（張り替えの確認用）
  const project = {};
  centerCL.pendingDelta = 300; // 2000→2300

  const { toast } = commitCLMoveOp(graph, project, centerCL, 2000);
  assert.equal(toast, null);
  assert.equal(centerCL.value, 2300);
  const axAfter = graph.shapeMap.get(beamAxisId);
  assert.equal(axAfter.value, 2300, '壁の下地帯中心の移動分だけ梁芯も追従するはず');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2000'), false, '旧キーは張り替えで消える');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2300'), true, '新キーへ張り替わる');

  undoManager.undo();
  const axRestored = graph.shapeMap.get(beamAxisId);
  assert.equal(centerCL.value, 2000, 'undoで中心線が戻る');
  assert.equal(axRestored.value, 2000, 'undoで梁芯も戻る');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2000'), true, 'undoで除外キーも戻る');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2300'), false);
});

test('【案B】commitCLMoveOp: 移動先に通り芯があれば、保護されない壁由来梁芯は吸収されて撤去され、移動自体はtoast:nullで成功する。undoで同idで戻る（T9・旧: スキップして残す→2026-09-26吸収に反転）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  const gridCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2300, { labeled: true, discipline: Discipline.STRUCT }); // 移動先に既存の通り芯
  const gridCLId = gridCL.id;
  const project = {};
  centerCL.pendingDelta = 300; // 2000→2300

  const { toast } = commitCLMoveOp(graph, project, centerCL, 2000);
  assert.equal(toast, null, '移動自体は成功するはず');
  assert.equal(centerCL.value, 2300);
  assert.equal(graph.shapeMap.has(beamAxisId), false, '保護されない壁由来梁芯は吸収されて撤去される（案B）');
  assert.equal(graph.shapeMap.get(gridCLId)?.value, 2300, '移動先の通り芯（相手）はそのまま残る');

  undoManager.undo();
  assert.equal(centerCL.value, 2000, 'undoで中心線が戻る');
  const beamRestored = graph.shapeMap.get(beamAxisId);
  assert.ok(beamRestored, 'undoで吸収された梁芯が同じidで復元される');
  assert.equal(beamRestored.value, 2000, 'undoで復元された梁芯の値も旧位置のまま');

  undoManager.redo();
  assert.equal(centerCL.value, 2300, 'redoで中心線が再度動く');
  assert.equal(graph.shapeMap.has(beamAxisId), false, 'redoで再び吸収され撤去される');
});

// QA指摘n-1（2026-09-25）: pendingDeltaを一時的に0へ戻してwallBackingCenters(移動前スナップショット)を
// 読む処理は、例外が起きてもtry/finallyで必ず元の値へ復元されること（復元漏れがあると、この後に
// 例外を握りつぶす呼び出し元がいた場合、CLのドラッグ中表示位置が0のまま固まってしまう）。
test('【失敗系・n-1】commitCLMoveOp: 移動前スナップショット中にwallBackingCentersが例外を投げてもpendingDeltaは必ず元の値へ復元される（try/finally）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(cl, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const project = {};
  cl.pendingDelta = 300; // 2000→2300

  // graph.walls はMobXのcomputedのため、graph.shapeMap自体を差し替えても再評価が保証されない
  // （委譲先のObservableMapの中身を変えていないため）。wallBackingCenterCoord（wallBackingCenters内部）
  // が読む wall.axisCL.effectiveValue を直接投げるようにして、wallBackingCenters自体を確実に
  // 例外送出させる。
  const originalAxisCL = wall.axisCL;
  wall.axisCL = { get effectiveValue() { throw new Error('wallBackingCenters boom'); } };
  try {
    assert.throws(() => commitCLMoveOp(graph, project, cl, 2000), /wallBackingCenters boom/);
  } finally {
    wall.axisCL = originalAxisCL;
  }
  assert.equal(cl.pendingDelta, 300, '例外が起きてもpendingDeltaは元の値(300)に復元されるはず');
});

// ---- deleteCenterLineWithUndo ----

test('deleteCenterLineWithUndo: 中心線削除はexcludedWallBeamAxesを変えず、梁芯削除だけ記録する', async () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const beamCL   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const project = {};

  await deleteCenterLineWithUndo(graph, project, centerCL);
  assert.equal(graph.shapeMap.has(centerCL.id), false);
  assert.equal(graph.excludedWallBeamAxes.size, 0, '中心線の削除ではexcludedWallBeamAxesは変化しない');

  await deleteCenterLineWithUndo(graph, project, beamCL);
  assert.equal(graph.shapeMap.has(beamCL.id), false);
  assert.ok(graph.excludedWallBeamAxes.has('Y:3000'), '梁芯の削除は除外集合に記録される');

  undoManager.undo();
  assert.ok(graph.shapeMap.has(beamCL.id), '直前の梁芯削除はundoで復元される');
});

// ---- deleteCenterLineWithUndo: 軸最後の通り芯ガード（ユーザー要望で新設。中心化ガードと同じ
// isLastGridOnAxis判定を共有する多層防御——UIのグレー化を回避して呼ばれても最終的にここで拒否する）----

test('deleteCenterLineWithUndo: 同軸に他の通り芯があれば（軸最後の1本ではない）通り芯の削除は従来どおり成功しtoast:null', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 同軸に他の通り芯
  const clId = cl.id;

  const { toast } = await deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(project.structGraph.shapeMap.has(clId), false, '削除される');

  undoManager.undo();
  assert.ok(project.structGraph.shapeMap.has(clId), 'undoで復元される');
});

test('deleteCenterLineWithUndo異常系: 軸最後の通り芯はtoast:ERR_CL_DELETE_LAST_GRIDで拒否されグラフ無変更・undoも積まれない', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // VERTICAL軸唯一の通り芯
  const beforeTop = undoManager.peekUndo();

  const { toast } = await deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, ERR_CL_DELETE_LAST_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, '削除されずstructGraphに残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('deleteCenterLineWithUndo: 中心線（非struct）の削除は同軸の通り芯本数に関係なく従来どおり成功する', async () => {
  const { project, graph } = makeProjectWithGraph();
  // 直交・同軸とも通り芯を1本も用意しない（同軸の通り芯本数=0でも中心線の削除は無関係のはず）。
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const { toast } = await deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, null, '中心線は軸最後ガードの対象外');
  assert.equal(graph.shapeMap.has(cl.id), false, '削除される');
});

// 【旧データ限定・種別ベースへ統一】isStruct判定を `discipline===STRUCT && labeled` の生フィールドから
// isGridCenterLine（centerLineKind経由）へ統一したことによる反転ピン留め。移行前は
// lineType:'dashed' な異常値（通常経路では生成されない）でも通り芯扱いされ、structGraphの
// スナップショット方式Undo（軸最後の1本ガードを含む）に入っていた。移行後はisGridCenterLineが
// centerLineKind(cl)==='struct'まで見るため、この異常値は通り芯扱いされず（削除は
// excludedWallBeamAxes記録＋removeCenterLine経由の通常分岐になる）、軸最後の1本ガードの対象にも
// ならない。
test('【旧データ限定・種別ベースへ統一】deleteCenterLineWithUndo: {labeled:true, discipline:STRUCT, lineType:dashed}の異常値は通り芯扱いされず、軸最後の1本でも削除できる（移行前はstructGraph側の通り芯として扱いERR_CL_DELETE_LAST_GRIDで拒否していた）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  // VERTICAL軸唯一の"通り芯のつもりの"CLだが、旧UI経路のlineType:'dashed'異常値（通常経路では作れない）。
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(centerLineKind(legacy), 'aux', '前提: lineType=dashedなのでaux種別（labeled:true・discipline:STRUCTの異常値）');

  const { toast } = await deleteCenterLineWithUndo(graph, project, legacy);

  assert.equal(toast, null, '移行前はisStruct=trueとなり軸最後の1本ガード（ERR_CL_DELETE_LAST_GRID）で拒否していたが、移行後は通常のCL削除経路（軸最後ガードの対象外）になる');
  assert.equal(graph.shapeMap.has(legacy.id), false, '削除される');
});

// ---- deleteCenterLineWithUndo: 通り芯削除 → 構造同期リスナー（段階(a)・案P） ----
// setCenterLineStructuralListener はテスト間で必ず finally で null に戻す（他テストへ漏らさない）。

test('deleteCenterLineWithUndo: 通り芯削除は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, cl);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '削除確定直後に1回呼ばれるはず');
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'all', '通り芯（FLOOR_SHARED_KINDS）はstructuralSyncScopeOfKind経由で常にall');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(calls[1].scope, 'all');

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(calls[2].scope, 'all');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 通り芯削除はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, cl);
    assert.equal(toast, null);
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');
    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 通り芯削除のundoでは箱(floorRecords)のbefore保存がnotifyより前に実行される（順序スパイ・段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const order = [];
  const saveFloorFn = async (planeId, bytes) => { order.push(`save:${planeId}:${bytes}`); };
  setCenterLineStructuralListener((g, p, scope, undoRecords) => {
    if (undoRecords) undoRecords.push({ planeId: 'f1', before: 'b0', after: 'a1' });
    order.push('notify');
  });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.deepEqual(order, ['notify'], 'コミット時は記録するだけで保存はしない');

    order.length = 0;
    undoManager.undo();
    assert.deepEqual(order, ['save:f1:b0', 'notify'], 'undoではbefore保存がnotifyより前のはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】deleteCenterLineWithUndo: 構造同期リスナー未設定（null）でも例外なく通り芯を削除・undoできる', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const clId = cl.id;

  await assert.doesNotReject(() => deleteCenterLineWithUndo(graph, project, cl));
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  assert.doesNotThrow(() => undoManager.undo());
  assert.equal(project.structGraph.shapeMap.has(clId), true);
});

test('【失敗系】deleteCenterLineWithUndo: 軸最後の通り芯を拒否したときは構造同期リスナーを呼ばない', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // VERTICAL軸唯一

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, cl);
    assert.equal(toast, ERR_CL_DELETE_LAST_GRID);
    assert.equal(calls, 0);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

// 段階(b)・実機報告2026-09-25（tategu-test3.stqで中心線削除後に壁交点柱が残る）の修正:
// 「非通り芯の削除はlistener 0回」というピン留めを中心線だけ反転する（補助線・梁芯は0回のまま）。
test('deleteCenterLineWithUndo: 中心線の削除は構造同期リスナーを(graph, project, "activeAndAbove")で呼ぶ（確定1回・undo1回・redo1回＝計3回。実機報告2026-09-25の修正）', async () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const centerCLId = centerCL.id;
  const project = {};

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '削除確定直後に1回呼ばれるはず');
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'activeAndAbove', 'structuralSyncScopeOfKind("center")の結果がそのまま渡るはず');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(calls[1].scope, 'activeAndAbove');
    assert.equal(graph.shapeMap.has(centerCLId), true, 'undoで中心線が復元される');

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(calls[2].scope, 'activeAndAbove');
    assert.equal(graph.shapeMap.has(centerCLId), false, 'redoで再び削除される');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 中心線削除（非通り芯）はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const project = {};

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL);
    assert.equal(toast, null);
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');
    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 中心線削除（非通り芯）のundoでは箱(floorRecords)のbefore保存がnotifyより前に実行される（順序スパイ・段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const project = {};

  const order = [];
  const saveFloorFn = async (planeId, bytes) => { order.push(`save:${planeId}:${bytes}`); };
  setCenterLineStructuralListener((g, p, scope, undoRecords) => {
    if (undoRecords) undoRecords.push({ planeId: 'f1', before: 'b0', after: 'a1' });
    order.push('notify');
  });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, { saveFloorFn });
    assert.equal(toast, null);
    assert.deepEqual(order, ['notify'], 'コミット時は記録するだけで保存はしない');

    order.length = 0;
    undoManager.undo();
    assert.deepEqual(order, ['save:f1:b0', 'notify'], 'undoではbefore保存がnotifyより前のはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 参照する中心線が無い補助線・梁芯の削除は構造同期リスナーを呼ばない（段階(a)のピン留め継続。段階(d)で「参照なし」に読み替え。梁芯は専用経路のため対象外）', async () => {
  const graph = makeGraph();
  const auxCL    = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  const beamCL   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.FUSE });
  const project = {};

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await deleteCenterLineWithUndo(graph, project, auxCL);
    await deleteCenterLineWithUndo(graph, project, beamCL);
    assert.equal(calls, 0, '参照が無い補助線・梁芯の削除では構造同期リスナーを呼ばないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 中心線がextentLoRefで参照する補助線の削除は構造同期リスナーを(graph, project, "activeAndAbove")で呼ぶ（確定1回・undo1回・redo1回＝計3回。段階(d)・2026-09-25）', async () => {
  const graph = makeGraph();
  const auxCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  const auxCLId = auxCL.id;
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: auxCLId, offset: 0 },
  });
  const project = {};

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, auxCL);
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '削除直後に1回呼ばれるはず（scopeは削除前・detach前の参照関係から算出）');
    assert.equal(calls[0].scope, 'activeAndAbove');
    assert.equal(graph.shapeMap.has(auxCLId), false);

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(graph.shapeMap.has(auxCLId), true);

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(graph.shapeMap.has(auxCLId), false);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 中心線がextentLoRefで参照する梁芯の削除は構造同期リスナーを呼ばない（段階(d)裁定「beamは参照があってもnull」。auxとの非対称性の回帰固定）', async () => {
  const graph = makeGraph();
  const beamCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: beamCL.id, offset: 0 },
  });
  const project = {};

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, beamCL);
    assert.equal(toast, null);
    assert.equal(calls, 0, '梁芯を参照する中心線があっても、梁芯自身の削除は構造同期リスナーを呼ばないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】deleteCenterLineWithUndo: 中心線が参照する補助線の削除は構造同期リスナー未設定（null）でも例外なく削除・undoできる（段階(d)・2026-09-25）', async () => {
  const graph = makeGraph();
  const auxCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  const auxCLId = auxCL.id;
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: auxCLId, offset: 0 },
  });
  const project = {};

  await assert.doesNotReject(() => deleteCenterLineWithUndo(graph, project, auxCL));
  assert.equal(graph.shapeMap.has(auxCLId), false);
  assert.doesNotThrow(() => undoManager.undo());
  assert.equal(graph.shapeMap.has(auxCLId), true);
});

test('【失敗系】deleteCenterLineWithUndo: 中心線削除で構造同期リスナー未設定（null）でも例外なく削除・undo・redoできる', async () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const centerCLId = centerCL.id;
  const project = {};

  await assert.doesNotReject(() => deleteCenterLineWithUndo(graph, project, centerCL));
  assert.equal(graph.shapeMap.has(centerCLId), false);
  assert.doesNotThrow(() => undoManager.undo());
  assert.equal(graph.shapeMap.has(centerCLId), true);
  assert.doesNotThrow(() => undoManager.redo());
  assert.equal(graph.shapeMap.has(centerCLId), false);
});

test('deleteCenterLineWithUndo: 中心線を参照する自階の柱は削除直後に撤去され、構造同期リスナーも1回呼ばれる（実機の症状＝参照しない壁交点柱が残る件の再現はprobeが担保）', async () => {
  // graph.removeCenterLine は内部で detachFromCenterLine→_teardownCenterLine
  // （removeDependentsOfCenterLine）を行うため、この柱は「構造同期を待たずとも」削除直後に
  // 撤去される（読んで確認済み。通り芯削除のように別途removeDependentsOfCenterLineを呼ぶ必要は
  // 無い）——実機で「柱が残る」ように見えたのは、構造同期（recompute/reflect）自体が
  // 一切起動しておらず、削除に伴う他の副作用（隣接候補の再評価等）が反映されなかったため
  // （notify()が呼ばれていなかった。今回の修正対象）。
  const graph = makeGraph();
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', centerCL, y0);
  const project = {};

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL);
    assert.equal(toast, null);
    assert.equal(graph.columnMap.has(column.id), false, '中心線を参照する柱は削除直後に撤去されるはず');
    assert.equal(calls, 1, '構造同期リスナーが1回呼ばれるはず');

    undoManager.undo();
    assert.equal(graph.columnMap.has(column.id), true, 'undoで柱が復元されるはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

// ---- deleteCenterLineWithUndo: 中心線削除で失われる壁だけが根拠の壁由来梁芯の道連れ
// （ユーザー承認済み例外・2026-09-25。.claude/structural-model.md「孤児梁芯を撤去する規律は
// 作らない」節の例外。structural/wallBeamAxes.js wallBeamSourcesFor/orphanedWallBeamAxes参照）----

test('deleteCenterLineWithUndo: 自階の壁1本だけが根拠の壁由来梁芯は中心線と一緒に消え、undoで同じidのまま戻り、redoで再び消える（auto柱も道連れ）', async () => {
  // 通り芯（discipline:STRUCT）は本来project.structGraph側に属する実体——serializeGraph/restoreGraph
  // は階固有CL（isStructCLでないもの）だけをフロアのスナップショットに含める（graphSnapshot.js
  // buildSnapshot「通り芯は除外、階固有CLのみ」）。柱の直交CLは通り芯である必要が無いため
  // discipline:ARCHにする（STRUCTをgraphへ直接addすると、undo復元時にfloorCLsから漏れて
  // 柱が re-resolve できなくなる——本テストの前提と無関係な落とし穴）。
  const graph = makeGraph();
  graph.structureOverride = '木造（在来）';
  const project = { activeGraph: graph };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  // 実運用では直前の構造再計算（autoFillWallBeamAxes）がこの壁から生成した梁芯。ここでは
  // wallBeamSourcesFor/orphanedWallBeamAxesの入力を単純にするため直接同じ座標へ手で置く。
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, beamAxis); // dimensionStatus省略→既定'auto'
  const columnId = column.id;

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, { peekBelow: async () => null });
    assert.equal(toast, null);
    assert.equal(graph.shapeMap.has(beamAxisId), false, '壁を失った梁芯も同じ削除で道連れに消えるはず');
    assert.equal(graph.columnMap.has(columnId), false, '梁芯に乗っていたauto柱も道連れで消えるはず');
    assert.equal(graph.excludedWallBeamAxes.size, 0, '道連れ削除はexcludedWallBeamAxesに触れない（壁が戻れば再生成されるべきため）');
    assert.equal(calls, 1);

    undoManager.undo();
    assert.equal(graph.shapeMap.get(beamAxisId)?.id, beamAxisId, 'undoで同じidの梁芯が戻るはず');
    assert.equal(graph.columnMap.has(columnId), true, 'undoで柱も戻るはず');
    assert.equal(graph.excludedWallBeamAxes.size, 0);
    assert.equal(calls, 2);

    undoManager.redo();
    assert.equal(graph.shapeMap.has(beamAxisId), false, 'redoで再び消えるはず');
    assert.equal(graph.columnMap.has(columnId), false);
    assert.equal(calls, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系・保持】deleteCenterLineWithUndo: locked（dimensionStatus!==auto）の柱が乗る壁由来梁芯は中心線削除に道連れにしない', async () => {
  const graph = makeGraph();
  graph.structureOverride = '木造（在来）';
  const project = { activeGraph: graph };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, beamAxis, { dimensionStatus: 'locked' });

  const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, { peekBelow: async () => null });
  assert.equal(toast, null);
  assert.equal(graph.shapeMap.has(centerCL.id), false, '中心線自体は削除されるはず');
  assert.equal(graph.shapeMap.has(beamAxisId), true, 'lockedの柱が乗る梁芯は道連れにしないはず（ユーザー確定値の保護）');
});

// QA指摘M-1（2026-09-25）: 在来木造（wallBeamAxes:'selfAndBelow'）で「自階の壁は消えたが直下階の
// 同座標に壁がある」梁芯は、下階peekの結果をsourcesAfterへ正しく反映して道連れにしない。
// 変異W4（sourcesAfterをbelowGraphなし＝nullで算出）はこのテストが無いと緑のまま通ってしまう
// （既存テストは全てpeekBelow:null固定か下階peek非対象のケースのため、下階ソースで護られる
// 経路を一度も通っていなかった）。
test('【M-1】deleteCenterLineWithUndo: 直下階の同座標に壁がある壁由来梁芯は、自階の壁が消えても道連れにしない（下階peekの保護）', async () => {
  const graph = makeGraph('p2');
  graph.structureOverride = '木造（在来）';
  const project = { activeGraph: graph };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;

  // 下階: 同座標(y=2000)に壁がある別グラフ。
  const belowGraph = makeGraph('p1');
  const bx0 = belowGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const bx1 = belowGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const belowAxisCL = belowGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  belowGraph.addWall(belowAxisCL, 0, false, bx0, 0, bx1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });

  let peekCalls = 0;
  const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, {
    peekBelow: async () => { peekCalls++; return belowGraph; },
  });
  assert.equal(toast, null);
  assert.equal(peekCalls, 1, 'peekBelowは1回呼ばれるはず');
  assert.equal(graph.shapeMap.has(centerCL.id), false, '中心線自体は削除されるはず');
  assert.equal(graph.shapeMap.has(beamAxisId), true, '直下階の同座標の壁がまだ根拠になるため梁芯は残るはず');
});

// 対照（M-1）: 下階スタブに同座標の壁が無ければ、自階の壁が消えた時点で正しく道連れに消える。
test('【M-1対照】deleteCenterLineWithUndo: 下階に同座標の壁が無ければ壁由来梁芯は道連れに消える', async () => {
  const graph = makeGraph('p2');
  graph.structureOverride = '木造（在来）';
  const project = { activeGraph: graph };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;

  const belowGraph = makeGraph('p1'); // 壁なし（下階スタブに保護材料が無い）

  const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, {
    peekBelow: async () => belowGraph,
  });
  assert.equal(toast, null);
  assert.equal(graph.shapeMap.has(beamAxisId), false, '下階に保護材料が無いため梁芯は道連れに消えるはず');
});

// QA指摘m-2（2026-09-25）: opts.peekBelowがthrowしたときの失敗系。
test('【失敗系・m-2】deleteCenterLineWithUndo: opts.peekBelowがthrowしたらrejectし、中心線は残り、undoは積まれず、listenerは呼ばれない', async () => {
  const graph = makeGraph();
  graph.structureOverride = '木造（在来）';
  const project = { activeGraph: graph };
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const centerCLId = centerCL.id;
  const beforeTop = undoManager.peekUndo();

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await assert.rejects(
      () => deleteCenterLineWithUndo(graph, project, centerCL, {
        peekBelow: async () => { throw new Error('下階の読み取りに失敗'); },
      }),
      /下階の読み取りに失敗/,
    );
    assert.equal(graph.shapeMap.has(centerCLId), true, '中心線は削除されずに残るはず');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれないはず');
    assert.equal(calls, 0, '構造同期リスナーは呼ばないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

// 段階(a)のM-2ガード（通り芯削除の伝播await中の階切替）と同型: 下階peekのawait中に
// アクティブ階が切り替わった・削除対象の中心線自体が消えた場合、道連れ判定もスキップし
// 何も変更せず{toast:null}で戻る（listenerも呼ばない）。
test('【失敗系・await中の階切替】deleteCenterLineWithUndo: 下階peekのawait中にアクティブ階が切り替わったら道連れ判定もせず{toast:null}で戻る（listener 0回）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const { graph: other } = project.addPlane(3000, '2階', 'p2');
  graph.structureOverride = '木造（在来）';
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const centerCLId = centerCL.id;

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, {
      peekBelow: async () => { project.activePlaneId = other.plane.id; return null; },
    });
    assert.equal(toast, null, 'await中に階が切り替わったら削除を確定せずtoast:nullで戻るはず');
    assert.equal(graph.shapeMap.has(centerCLId), true, '削除は行われていないはず');
    assert.equal(calls, 0, '構造同期リスナーは呼ばないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系・await中にCL自体が消える】deleteCenterLineWithUndo: 下階peekのawait中に削除対象の中心線自体が別経路で消えていたら道連れ判定もせず{toast:null}で戻る（listener 0回）', async () => {
  const { project, graph } = makeProjectWithGraph();
  graph.structureOverride = '木造（在来）';
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const centerCLId = centerCL.id;

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, {
      peekBelow: async () => { graph.removeShape(centerCLId); return null; },
    });
    assert.equal(toast, null, 'await中に対象CL自体が消えたら{toast:null}で戻るはず');
    assert.equal(calls, 0, '構造同期リスナーは呼ばないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('deleteCenterLineWithUndo: 主構造が在来木造でない中心線削除は下階peekを一切呼ばない（RC造・未定でIDBを無駄に読まない）', async () => {
  const { project, graph } = makeProjectWithGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const { toast } = await deleteCenterLineWithUndo(graph, project, centerCL, {
    peekBelow: async () => { throw new Error('RC造では下階peekを呼んではいけない'); },
  });
  assert.equal(toast, null);
  assert.equal(graph.shapeMap.has(centerCL.id), false);
});

test('deleteCenterLineWithUndo: 通り芯を参照する自階の柱・梁・基礎は削除直後に撤去され、undoで復元される（removeDependentsOfCenterLine）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  const column  = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', cl, y0);
  const beam    = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', cl, true, y0, y1);
  const footing = graph.addFooting('independent', 'SEC-FTG', cl, y0);

  const { toast } = await deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(graph.columnMap.has(column.id), false, '通り芯を参照する柱は削除直後に撤去されるはず');
  assert.equal(graph.beamMap.has(beam.id), false, '通り芯を参照する梁は削除直後に撤去されるはず');
  assert.equal(graph.footingMap.has(footing.id), false, '通り芯を参照する基礎は削除直後に撤去されるはず');

  undoManager.undo();
  assert.equal(graph.columnMap.has(column.id), true, 'undoで柱が復元されるはず');
  assert.equal(graph.beamMap.has(beam.id), true, 'undoで梁が復元されるはず');
  assert.equal(graph.footingMap.has(footing.id), true, 'undoで基礎が復元されるはず');
});

// ---- deleteCenterLineWithUndo: 通り芯削除の他階への detach 伝播（案P。複製ではなく撤去を先に伝播する
// 型は降格 propagateDemotedCenterLine と同じ）。本番同型 peek（下記 withProductionPeek。L1138付近で
// 定義・関数宣言のためホイストされ、ここから参照できる）を使う。----

test('deleteCenterLineWithUndo: 他階で通り芯を軸に持つ壁は削除され、片端だけ参照する壁は端点ルールで残る（本番同型peek）', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;
  const gridV2 = [...project.structGraph.centerLines].find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 5000);

  const axisWall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false }); // clを軸に持つ壁（削除される）
  const axisWallId = axisWall.id;
  const hAxisCL = p2.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const endpointWall = p2.addWall(hAxisCL, 0, false, cl, 0, gridV2, 0, { isExteriorWall: false }); // clを片端(clStart)に持つ壁（端点ルールで残る）
  const endpointWallId = endpointWall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { toast } = await withProductionPeek(project, store, () =>
    deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn })
  );

  assert.equal(toast, null);
  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.walls.length, 1, '軸参照の壁は削除され、片端参照の壁だけ残るはず');
  assert.equal(decoded.walls[0].id, endpointWallId);
  assert.equal(decoded.walls.some(w => w.id === axisWallId), false, '通り芯を軸に持つ壁は削除されるはず');
  assert.notEqual(decoded.walls[0].clStart.id, clId, '端点ルールでclStartは削除された通り芯から繰り上がるはず');
});

test('deleteCenterLineWithUndo: undoで他階の保存バイトが削除前へ・redoで削除後へ戻る（本番同型peek）', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const wall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  const wallId = wall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push({ planeId, bytes }); store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    const { toast } = await deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.equal(saved.length, 1, '削除確定時に1回保存される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).walls.some(w => w.id === wallId), false, '削除直後の保存バイトは壁が消えた状態');

    saved.length = 0;
    undoManager.undo();
    assert.equal(saved.length, 1, 'undoでp2への書き戻しが記録される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).walls.some(w => w.id === wallId), true, 'undoで書き戻すバイトは削除前（壁が残る）状態');
    assert.equal(project.structGraph.shapeMap.has(clId), true, 'undoでstructGraph側の通り芯も復元される');

    saved.length = 0;
    undoManager.redo();
    assert.equal(saved.length, 1, 'redoでp2への書き戻しが記録される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).walls.some(w => w.id === wallId), false, 'redoで書き戻すバイトは削除後（壁が消えた）状態');
  });
});

test('deleteCenterLineWithUndo: 伝播の2階目でsaveFloorFnがthrowしたら、1階目はbeforeへrollbackされ、自階・structGraphは無変更・undoも積まれず、rejectする', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: p3 } = project.addPlane(6000, '3階', 'p3');
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  p3.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });

  const store = new Map([[p2.plane.id, serializeGraph(p2)], [p3.plane.id, serializeGraph(p3)]]);
  const calls = [];
  const saveFloorFn = async (planeId, bytes) => {
    calls.push(planeId);
    if (planeId === p3.plane.id) throw new Error('p3 save failed');
    store.set(planeId, bytes);
  };
  const beforeTop = undoManager.peekUndo();

  // m-10・QA指摘: 伝播が失敗した経路では構造同期リスナーが1回も呼ばれないことも確認する
  // （通り芯削除が確定しないまま構造再計算が走るのは誤り）。
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    await withProductionPeek(project, store, async () => {
      await assert.rejects(() => deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn }), /p3 save failed/);

      assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
      assert.equal(p1.shapeMap.has(clId), false, '自階（structGraph参照のためshapeMapには元々無い）は無変更');
      assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');

      assert.equal(calls.filter(id => id === p2.plane.id).length, 2, 'p2は伝播→ロールバックの2回saveFloorFnが呼ばれる');
      assert.equal(calls.filter(id => id === p3.plane.id).length, 1, 'p3は伝播の1回（例外で失敗）だけ');
      assert.equal(listenerCalls, 0, '伝播が失敗した削除では構造同期リスナーは呼ばれないはず');

      const decodedP2 = decodeFloor(project, p2.plane, store.get(p2.plane.id));
      assert.equal(decodedP2.walls.some(w => w.axisCL.id === clId), true, 'p2はロールバックされ壁が残ったまま（beforeに書き戻された）');
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】deleteCenterLineWithUndo: 伝播のawait中に同じ通り芯が消えていたらrollbackしてtoast:null・undoは積まれない', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;
  p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let intruded = false;
  const saveCalls = [];
  // IDB待ち（saveFloorFn の await）の間に、この通り芯自体が別経路で先に削除された状況を模擬する。
  // project.structGraphから実際にclを取り除くため、以降このprojectでcl参照を復号する
  // （decodeFloor等・restoreGraph往復はapplySnapshotの既定寸法線補完で非バイト同一になる既知の
  // 性質もあるため）resolveCLが解決できず壁ごと落ちてしまう——本テストは toast・undo・ロールバックの
  // saveFloorFn呼び出し回数（propagation 1回＋rollback 1回＝計2回）で確認する（デコード・バイト比較に頼らない）。
  const saveFloorFn = async (planeId, bytes) => {
    saveCalls.push(planeId);
    store.set(planeId, bytes);
    if (!intruded) {
      intruded = true;
      project.structGraph.removeCenterLine(clId);
    }
  };
  const beforeTop = undoManager.peekUndo();

  // m-10・QA指摘: rollbackされた削除では構造同期リスナーが呼ばれないことも確認する。
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    await withProductionPeek(project, store, async () => {
      const { toast } = await deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn });

      assert.equal(toast, null);
      assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
      assert.deepEqual(saveCalls, [p2.plane.id, p2.plane.id], 'p2への保存はpropagation 1回＋rollback 1回の計2回のはず');
      assert.equal(listenerCalls, 0, 'rollbackされた削除では構造同期リスナーは呼ばれないはず');
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系・M-2】deleteCenterLineWithUndo: 伝播のawait中にアクティブ階が切り替わったらrollbackしてtoast:null・undoは積まれず構造同期も呼ばれない', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;
  p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let switched = false;
  const saveCalls = [];
  // IDB待ち（saveFloorFn の await）の間に、historyナビゲーション等でアクティブ階が切り替わった
  // 状況を模擬する（M-2・QA指摘）——project.activeGraph は project.addPlane の順に決まる
  // activePlaneId で解決されるため、activePlaneId を直接書き換えて切替を模す。
  const saveFloorFn = async (planeId, bytes) => {
    saveCalls.push(planeId);
    store.set(planeId, bytes);
    if (!switched) {
      switched = true;
      project.activePlaneId = p2.plane.id;
    }
  };
  const beforeTop = undoManager.peekUndo();
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    await withProductionPeek(project, store, async () => {
      const { toast } = await deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn });

      assert.equal(toast, null, '階切替後は削除を確定せずtoast:nullで戻るはず');
      assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
      assert.equal(p1.shapeMap.has(clId), false, '自階（structGraph参照）は無変更');
      assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
      // n-1・QA指摘の修正後: rollback時点でp2が既にアクティブなため、rollbackFloorRecordsは
      // IDB（saveFloorFn）ではなく生きているp2グラフへ直接restoreGraphする——saveFloorFnはpropagation
      // の1回だけ（rollback分は増えない）。
      assert.deepEqual(saveCalls, [p2.plane.id], 'p2への保存はpropagationの1回だけのはず（rollbackはp2がアクティブなためrestoreGraph経由になる）');
      assert.equal(listenerCalls, 0, '階切替で中止された削除では構造同期リスナーは呼ばれないはず');
    });
  } finally {
    setCenterLineStructuralListener(null);
    project.activePlaneId = p1.plane.id;
  }
});

test('【失敗系・n-1】deleteCenterLineWithUndo: 伝播中にp2がアクティブへ切り替わり伝播後バイトが生きているグラフへ既に反映されていても、rollbackはIDBではなく生きているグラフへbeforeを書き戻し壁が残る', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const wall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  const wallId = wall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let switched = false;
  const saveCalls = [];
  // saveFloorFn の await 中に、他の経路（ユーザー操作等）がp2へ切り替え、伝播後（detach後）の
  // バイトを「生きているp2グラフ」へ既に読み込んだ状況を模す（floorSwapManager.activate相当。
  // n-1・QA指摘: この状況でrollbackがIDB（saveFloorFn）にしか書き戻さないと、生きているp2の
  // グラフは detach 後のまま——壁が undo も効かずに消えたままになる）。restoreGraph は
  // switched フラグで1回だけ行う（rollback呼び出し時に再度書き換わらないようにするため——
  // 本番のsaveFloorはIDBへ書くだけで生きているグラフには触れないのと同じにする）。
  const saveFloorFn = async (planeId, bytes) => {
    saveCalls.push(planeId);
    store.set(planeId, bytes);
    if (!switched) {
      switched = true;
      restoreGraph(p2, bytes);
      project.activePlaneId = p2.plane.id;
    }
  };
  const beforeTop = undoManager.peekUndo();

  try {
    await withProductionPeek(project, store, async () => {
      const { toast } = await deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn });

      assert.equal(toast, null, '階切替後は削除を確定せずtoast:nullで戻るはず（M-2ガード）');
      assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
      // n-1の修正により、rollback時点でp2は既にアクティブなためsaveFloorFn（IDB）ではなく
      // restoreGraph（生きているグラフへ直接）で書き戻る——saveFloorFnは伝播の1回だけ。
      assert.deepEqual(saveCalls, [p2.plane.id], 'p2への保存は伝播の1回だけのはず（rollbackはrestoreGraph経由でsaveFloorFnを呼ばない）');
      assert.equal(project.activeGraph, p2, '前提: rollback時点でp2がアクティブのはず');
      assert.equal(p2.walls.some(w => w.id === wallId), true,
        'rollback後、生きているp2グラフに壁が残るはず（n-1の修正が無いとIDBにしか書き戻らず、生きているグラフは detach 後のまま＝壁が消えたままになる）');
    });
  } finally {
    project.activePlaneId = p1.plane.id;
  }
});

test('【失敗系・m-2】deleteCenterLineWithUndo: 伝播のawait中に軸最後の1本になっていたらrollbackしtoast:ERR_CL_DELETE_LAST_GRIDで戻る', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxis対策の「同軸もう1本」——これを伝播中の割り込みで消す。
  const otherAxisCL = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const clId = cl.id, otherAxisId = otherAxisCL.id;

  p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let intruded = false;
  const saveCalls = [];
  const saveFloorFn = async (planeId, bytes) => {
    saveCalls.push(planeId);
    store.set(planeId, bytes);
    if (!intruded) {
      intruded = true;
      project.structGraph.removeCenterLine(otherAxisId); // 同軸もう1本を消し、clを軸最後の1本にする
    }
  };
  const beforeTop = undoManager.peekUndo();
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    await withProductionPeek(project, store, async () => {
      const { toast } = await deleteCenterLineWithUndo(p1, project, cl, { saveFloorFn });

      assert.equal(toast, ERR_CL_DELETE_LAST_GRID);
      assert.equal(project.structGraph.shapeMap.has(clId), true, '削除されずstructGraphに残る');
      assert.equal(project.structGraph.shapeMap.has(otherAxisId), false, '割り込みで消した方は戻らない（このテストの前提操作）');
      assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
      assert.deepEqual(saveCalls, [p2.plane.id, p2.plane.id], 'p2への保存はpropagation 1回＋rollback 1回の計2回のはず');
      assert.equal(listenerCalls, 0, '軸最後で拒否された削除では構造同期リスナーは呼ばれないはず');
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
});

// ---- addCenterLineFromDialog ----

// ---- スパン配列バッチモード（kind='struct' かつ value が配列。QA指摘m-4）----
// 既存テストが無かった経路（QA実測）。sameCoordCounterparts経由への移行後も、重複除外の
// 述語（tolMm既定=CL_OVERLAP_TOL_MM）が従来の`< CL_OVERLAP_TOL_MM`と完全一致することを固定する。

test('addCenterLineFromDialog: スパン配列バッチモードは重複する値を除外し、新規の値だけ通り芯として追加する', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // 既存
  const beforeTop = undoManager.peekUndo();

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical' }, value: [1000, 2000, 3000], kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  assert.equal(result.toast, null);
  assert.deepEqual(result.suggestWood.newValues, [2000, 3000], '既存の1000は除外され、新規の2本だけが追加対象になる');
  const values = project.structGraph.centerLines
    .filter(cl => cl.centerLineType === CenterLineType.VERTICAL)
    .map(cl => cl.value).sort((a, b) => a - b);
  assert.deepEqual(values, [1000, 2000, 3000]);
  assert.notEqual(undoManager.peekUndo(), beforeTop, 'undoが積まれる');

  undoManager.undo();
  const valuesAfterUndo = project.structGraph.centerLines
    .filter(cl => cl.centerLineType === CenterLineType.VERTICAL)
    .map(cl => cl.value);
  assert.deepEqual(valuesAfterUndo, [1000], 'undoで新規2本が消え既存の1本だけ残る');
});

test('addCenterLineFromDialog: スパン配列バッチモードは全値が重複すればdone:trueかつERR_CL_DUPLICATEでundoを積まない', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical' }, value: [1000, 2000], kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  assert.equal(result.toast, ERR_CL_DUPLICATE('struct'));
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('【失敗系】addCenterLineFromDialog: スパン配列バッチモードの重複除外はtolMm境界（CL_OVERLAP_TOL_MM未満は重複扱い）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // 既存

  const result = addCenterLineFromDialog(
    graph, project,
    // 1000.4は既存(1000)との差が0.4mm（既定tolMm=CL_OVERLAP_TOL_MM=0.5未満）で重複扱いになるはず
    // ——tolMmが0に壊れる変異（QA指摘m-4）が注入されるとこのケースだけ非重複扱いに変わり検出できる。
    { clDialog: { type: 'vertical' }, value: [1000.4, 5000], kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  assert.deepEqual(result.suggestWood.newValues, [5000], '1000.4は既存1000の重複としてtolMm境界内で除外される');
});

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

test('addCenterLineFromDialog: 既存の梁芯（自動生成・平面では非表示）の位置へ中心線・補助線は追加でき、梁芯も残る', () => {
  const { project, graph } = makeProjectWithGraph();
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beforeTop = undoManager.peekUndo();

  // 既存=梁芯、新規=中心線 → 拒否しない（下階の壁由来で自階に湧いた梁芯を障害物にしない）
  const r1 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r1.done, true);
  assert.equal(r1.toast, null);
  const vAt1000 = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  assert.equal(vAt1000.length, 2, '梁芯と中心線が同位置に共存する');
  assert.ok(vAt1000.some(cl => cl.id === beam.id), '既存の梁芯は削除されない');
  assert.ok(vAt1000.some(cl => centerLineKind(cl) === 'center'), '中心線が追加される');
  assert.notEqual(undoManager.peekUndo(), beforeTop, 'undoが積まれる');

  // 既存=梁芯、新規=補助線（別軸で独立させる） → 同様に拒否しない
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const r1b = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 3000, perpCoord: 0 }, value: 3000, kind: 'aux', refId: null, refOffset: 0 },
    { scaleDenominator: 100 }, // aux の extent 計算（はね出し・丸め）が viewport.scaleDenominator を読む
  );
  assert.equal(r1b.done, true);
  assert.equal(r1b.toast, null);
  assert.ok(graph.centerLines.some(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000 && centerLineKind(cl) === 'aux'));
});

test('addCenterLineFromDialog: 補助線と中心線が共存する位置への通り芯追加は、並び順によらず中心線を削除して昇格する（相手選択は種別優先順）', () => {
  const vp = { scaleDenominator: 100 };
  for (const order of ['aux-first', 'center-first']) {
    const { project, graph } = makeProjectWithGraph();
    const addAux    = () => graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
    const addCenter = () => graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
    const [aux, center] = order === 'aux-first' ? [addAux(), addCenter()] : (() => { const c = addCenter(); const a = addAux(); return [a, c]; })();

    const r = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
      vp,
    );
    assert.equal(r.done, true, order);
    assert.equal(r.toast, ERR_CL_CENTER_UPGRADED, `${order}: 中心線を削除して昇格する`);
    assert.equal(graph.shapeMap.has(center.id), false, `${order}: 中心線は削除される`);
    assert.equal(graph.shapeMap.has(aux.id), true, `${order}: 補助線は残る`);
    const kinds = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000).map(centerLineKind).sort();
    assert.deepEqual(kinds, ['aux', 'struct'], `${order}: 通り芯＋補助線の2本になる`);
  }
});

test('addCenterLineFromDialog: 直交する線・壁が無く extent が1点に退化した補助線でも、同座標の2本目は拒否される', () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1'); // 直交CL・壁なし → フリー端点が両方 perpCoord に丸められ長さ0
  const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 };
  const vp = { scaleDenominator: 100 };

  const r1 = addCenterLineFromDialog(graph, project, payload, vp);
  assert.equal(r1.done, true);
  const first = graph.centerLines.find(cl => centerLineKind(cl) === 'aux');
  assert.equal(first.extentLo, first.extentHi, '前提: extent が1点に退化している');
  const beforeTop = undoManager.peekUndo();

  const r2 = addCenterLineFromDialog(graph, project, payload, vp);
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('aux'));
  assert.equal(graph.centerLines.filter(cl => centerLineKind(cl) === 'aux').length, 1, '補助線は1本のまま');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 梁芯と共存する中心線・補助線があるとき、同位置への2本目の同種別は先頭が梁芯でも拒否される', () => {
  const { project, graph } = makeProjectWithGraph();
  const vp = { scaleDenominator: 100 };

  // 梁芯が先（＝下階由来の自動生成が先にある実機の状況）→ 中心線を追加 → もう1本中心線
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const payloadC = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 };
  assert.equal(addCenterLineFromDialog(graph, project, payloadC, null).done, true);
  const beforeTop = undoManager.peekUndo();
  const r2 = addCenterLineFromDialog(graph, project, payloadC, null);
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('center'));
  assert.equal(graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000).length, 2, '梁芯＋中心線の2本のまま');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');

  // 補助線も同様（extent が重なる2本目は拒否）
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const payloadA = { clDialog: { type: 'horizontal', worldCoord: 3000, perpCoord: 0 }, value: 3000, kind: 'aux', refId: null, refOffset: 0 };
  assert.equal(addCenterLineFromDialog(graph, project, payloadA, vp).done, true);
  const r3 = addCenterLineFromDialog(graph, project, payloadA, vp);
  assert.equal(r3.done, false);
  assert.equal(r3.toast, ERR_CL_DUPLICATE('aux'));
  assert.equal(graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000 && centerLineKind(cl) === 'aux').length, 1);

  // 通り芯追加は梁芯と中心線の並び順によらず梁芯を理由に拒否する（中心線が先でも昇格経路へ入らない）
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false });                                  // 中心線が先
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false, discipline: Discipline.FUSE });    // 梁芯が後
  const beforeTop2 = undoManager.peekUndo();
  const r4 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 5000, perpCoord: 0 }, value: 5000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r4.done, false);
  assert.equal(r4.toast, ERR_CL_DUPLICATE('beam'));
  assert.equal(graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000).length, 2, '中心線は削除されず通り芯も増えない');
  assert.equal(undoManager.peekUndo(), beforeTop2, 'undoは積まれない');
});

// 由来フィールド（BeamAxisOrigin。ステップ2・2026-09-26）
test('addCenterLineFromDialog: 梁芯の手動追加はbeamAxisOrigin:userになり、undo/redoを経ても保たれる', () => {
  const { project, graph } = makeProjectWithGraph();
  const r = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 2000, perpCoord: 0 }, value: 2000, kind: 'beam', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r.done, true);
  const beam = graph.centerLines.find(cl => centerLineKind(cl) === 'beam' && cl.value === 2000);
  const beamId = beam.id;
  assert.equal(beam.beamAxisOrigin, BeamAxisOrigin.USER);

  // 梁芯追加はグラフスナップショット方式のUndo（graph.clear()→再構築）のため、undo/redo後は
  // 同一idの新しいCenterLineインスタンスに置き換わる（他の梁芯テストと同じ確認手順）。
  undoManager.undo();
  assert.equal(graph.shapeMap.has(beamId), false, 'undoで削除される');
  undoManager.redo();
  const restored = graph.shapeMap.get(beamId);
  assert.equal(restored.beamAxisOrigin, BeamAxisOrigin.USER, 'redo後もbeamAxisOriginが保たれる（graphSnapshot往復）');
});

test('addCenterLineFromDialog: 通り芯・中心線・補助線の追加ではbeamAxisOriginは付かない（null のまま）', () => {
  const { project, graph } = makeProjectWithGraph();
  const rStruct = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(rStruct.done, true);
  const struct = project.structGraph.centerLines.find(cl => cl.value === 1000);
  assert.equal(struct.beamAxisOrigin, null);

  const rCenter = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 3000, perpCoord: 0 }, value: 3000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(rCenter.done, true);
  const center = graph.centerLines.find(cl => centerLineKind(cl) === 'center' && cl.value === 3000);
  assert.equal(center.beamAxisOrigin, null);

  const rAux = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 5000, perpCoord: 0 }, value: 5000, kind: 'aux', refId: null, refOffset: 0 },
    { scaleDenominator: 100 },
  );
  assert.equal(rAux.done, true);
  const aux = graph.centerLines.find(cl => centerLineKind(cl) === 'aux' && cl.value === 5000);
  assert.equal(aux.beamAxisOrigin, null);
});

test('addCenterLineFromDialog: 梁芯の手動追加は既存の中心線・通り芯と同位置に共存できず、通り芯追加も既存の梁芯を拒否する', () => {
  const { project, graph } = makeProjectWithGraph();

  // 既存=中心線、新規=梁芯
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false });
  const r2 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 2000, perpCoord: 0 }, value: 2000, kind: 'beam', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('center'));

  // 既存=梁芯、新規=通り芯 → 拒否（大梁と完全重複する小梁の生成防止）
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beforeTop = undoManager.peekUndo();
  const r3 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r3.done, false);
  assert.equal(r3.toast, ERR_CL_DUPLICATE('beam'));
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
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

// ---- addCenterLineFromDialog: 構造同期リスナー（段階(c)・pushUndoWithStructuralSync・2026-09-25） ----
// setCenterLineStructuralListener はテスト間で必ず finally で null に戻す（他テストへ漏らさない）。

test('addCenterLineFromDialog: スパン配列バッチモード（通り芯）は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical' }, value: [1000, 2000, 3000], kind: 'struct', refId: null, refOffset: 0 },
      null,
    );
    assert.equal(result.done, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'all');

    undoManager.undo();
    assert.equal(calls.length, 2);
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: 単体の通り芯追加は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回）', () => {
  const { project, graph } = makeProjectWithGraph();

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
      null,
    );
    assert.equal(result.done, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'all');

    undoManager.undo();
    assert.equal(calls.length, 2);
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: 単体の通り芯追加はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・QA指摘M-1・2026-09-26）', () => {
  const { project, graph } = makeProjectWithGraph();

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
      null,
    );
    assert.equal(result.done, true);
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');
    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: undoでは箱(floorRecords)のbefore保存がnotifyより前に実行される（順序スパイ・段階(g)・QA指摘M-1・2026-09-26）', () => {
  const { project, graph } = makeProjectWithGraph();

  const order = [];
  const saveFloorFn = async (planeId, bytes) => { order.push(`save:${planeId}:${bytes}`); };
  setCenterLineStructuralListener((g, p, scope, undoRecords) => {
    // 構造同期（実体はstructuralSync.js）が他階f1へ書いたことを模す（配列があるのはコミット時のみ）。
    if (undoRecords) undoRecords.push({ planeId: 'f1', before: 'b0', after: 'a1' });
    order.push('notify');
  });
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
      null,
      { saveFloorFn },
    );
    assert.equal(result.done, true);
    assert.deepEqual(order, ['notify'], 'コミット時は記録するだけで保存はしない');

    order.length = 0;
    undoManager.undo();
    assert.deepEqual(order, ['save:f1:b0', 'notify'], 'undoではbefore保存がnotifyより前のはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: 既存中心線位置への通り芯追加（昇格経路）は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回）', () => {
  const { project, graph } = makeProjectWithGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
      null,
    );
    assert.equal(result.done, true);
    assert.equal(result.toast, ERR_CL_CENTER_UPGRADED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'all');

    undoManager.undo();
    assert.equal(calls.length, 2);
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: 単体の中心線追加は構造同期リスナーを(graph, project, "activeAndAbove")で呼ぶ（確定1回・undo1回・redo1回＝計3回）', () => {
  const { project, graph } = makeProjectWithGraph();

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
      null,
    );
    assert.equal(result.done, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'activeAndAbove');

    undoManager.undo();
    assert.equal(calls.length, 2);
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: 同種別（中心線）の結合連鎖でも構造同期リスナーは(graph, project, "activeAndAbove")で1回・undo1回・redo1回＝計3回', () => {
  const { project, graph } = makeProjectWithGraph();
  // 直交する通り芯Y=1000・Y=2000でperpCoord=1500をブラケットし、新規中心線のextentを[1000,2000]にする
  // （orthoAnchorCandidatesForNewの候補になれるようdiscipline:STRUCT・labeled:trueにする）。
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  // 既存の中心線: 同じX=1000でextent[0,1000]（新規の[1000,2000]と端点で接するだけ＝結合対象）
  const existing = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, extentLo: 0, extentHi: 1000 });
  const existingId = existing.id;

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const result = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 1500 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
      null,
    );
    assert.equal(result.done, true, JSON.stringify(result));
    assert.equal(graph.shapeMap.has(existingId), true, '既存CLがsurvivorとして残り延伸される（新規側は別オブジェクトを作らない）');
    assert.equal(existing.extentHi, 2000, 'extentが新規分だけ延伸される');
    assert.equal(calls.length, 1, '結合が起きても構造同期リスナーは1回のはず');
    assert.equal(calls[0].scope, 'activeAndAbove');

    undoManager.undo();
    assert.equal(calls.length, 2);
    assert.equal(existing.extentHi, 1000, 'undoでextentが元に戻る');
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('addCenterLineFromDialog: 補助線の単体追加・結合連鎖、梁芯の追加は構造同期リスナーを呼ばない（structuralSyncScopeOfKindがaux/beamでnullのため）', () => {
  // ---- 補助線・単体 ----
  {
    const { project, graph } = makeProjectWithGraph();
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
        { scaleDenominator: 100 },
      );
      assert.equal(result.done, true, '補助線・単体');
      assert.equal(calls, 0, '補助線・単体は呼ばれないはず');
    } finally {
      setCenterLineStructuralListener(null);
    }
  }

  // ---- 補助線・結合連鎖（壁で挟まれた区間を直接指定し、overhang計算を避けて厳密に端点を接させる） ----
  {
    const { project, graph } = makeProjectWithGraph();
    const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false });
    const y2000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false });
    const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false });
    const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false });
    graph.addWall(y1000, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
    graph.addWall(y2000, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
    const existing = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed', extentLo: 0, extentHi: 1000 });
    const existingId = existing.id;

    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 1500 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
        { scaleDenominator: 100 },
      );
      assert.equal(result.done, true, JSON.stringify(result));
      assert.equal(graph.shapeMap.has(existingId), true, '既存CLがsurvivorとして残る（結合自体は起きる前提の確認）');
      assert.equal(existing.extentHi, 2000, 'extentが新規分だけ延伸される（結合が起きた確認）');
      assert.equal(calls, 0, '補助線の結合は呼ばれないはず');
    } finally {
      setCenterLineStructuralListener(null);
    }
  }

  // ---- 梁芯・単体追加 ----
  {
    const { project, graph } = makeProjectWithGraph();
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'beam', refId: null, refOffset: 0 },
        null,
      );
      assert.equal(result.done, true, '梁芯・単体');
      assert.equal(calls, 0, '梁芯は専用経路のため呼ばれないはず');
    } finally {
      setCenterLineStructuralListener(null);
    }
  }
});

test('【失敗系】addCenterLineFromDialog: 拒否・全件重複の経路は構造同期リスナーを呼ばない（ERR_CL_DUPLICATE/ERR_CL_STRUCT_EXISTS/バッチ全件重複/梁芯の重複拒否）', () => {
  // ---- struct×struct 同座標 ----
  {
    const { project, graph } = makeProjectWithGraph();
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
        null,
      );
      assert.equal(result.done, false);
      assert.equal(result.toast, ERR_CL_DUPLICATE('struct'));
      assert.equal(calls, 0);
    } finally {
      setCenterLineStructuralListener(null);
    }
  }

  // ---- 既存通り芯位置への中心線追加（ERR_CL_STRUCT_EXISTS） ----
  {
    const { project, graph } = makeProjectWithGraph();
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
        null,
      );
      assert.equal(result.done, false);
      assert.equal(result.toast, ERR_CL_STRUCT_EXISTS);
      assert.equal(calls, 0);
    } finally {
      setCenterLineStructuralListener(null);
    }
  }

  // ---- バッチ全件重複 ----
  {
    const { project, graph } = makeProjectWithGraph();
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical' }, value: [1000, 2000], kind: 'struct', refId: null, refOffset: 0 },
        null,
      );
      assert.equal(result.done, true);
      assert.equal(result.toast, ERR_CL_DUPLICATE('struct'));
      assert.equal(calls, 0);
    } finally {
      setCenterLineStructuralListener(null);
    }
  }

  // ---- 梁芯の重複拒否（既存=梁芯、新規=通り芯） ----
  {
    const { project, graph } = makeProjectWithGraph();
    graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
        null,
      );
      assert.equal(result.done, false);
      assert.equal(result.toast, ERR_CL_DUPLICATE('beam'));
      assert.equal(calls, 0);
    } finally {
      setCenterLineStructuralListener(null);
    }
  }
});

test('【失敗系】addCenterLineFromDialog: 構造同期リスナー未設定（null）でも通り芯の追加・undoが例外なく行える', () => {
  const { project, graph } = makeProjectWithGraph();
  assert.doesNotThrow(() => addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  ));
  assert.doesNotThrow(() => undoManager.undo());
});

// ---- 裁定(a)・2026-09-25: 通り芯追加のundo（単体追加・昇格経路・バッチ）は実質的な通り芯削除のため、
// deleteCenterLineWithUndoのstruct分岐と同じ順序（graph.detachFromCenterLine→
// graph.removeDependentsOfCenterLine→structGraph側の削除）で自階の格子柱等を撤去する。
// S造の格子柱は生成時のフィルタしか通らないため再計算しても自然には消えない
// （core/planGraph.js removeDependentsOfCenterLineのJSDoc参照）——gridAddStructuralSyncProbe.mjsの
// A4（実データ・13.stq）で発見。

test('addCenterLineFromDialog: 単体の通り芯追加のundoは、その通り芯を参照する自階の柱を撤去し、redoでCLが戻る（裁定(a)）', () => {
  const { project, graph } = makeProjectWithGraph();
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(result.done, true);
  const newCl = project.structGraph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  const newClId = newCl.id;
  // 実運用では構造同期（recompute）がこの通り芯×y0の交点に格子柱を生成する——ここではその結果を
  // 模して直接addColumnする（自グラフのcolumnMapに、新規通り芯をverticalCLとする柱を1本置く）。
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', newCl, y0);

  undoManager.undo();
  assert.equal(project.structGraph.shapeMap.has(newClId), false, 'undoで通り芯自体は消える');
  assert.equal(graph.columnMap.has(column.id), false, 'undoでその通り芯を参照する自階の柱も撤去されるはず（裁定(a)）');

  undoManager.redo();
  assert.equal(project.structGraph.shapeMap.has(newClId), true, 'redoで通り芯が同idで戻る（以後の同期で柱も再生成されうる）');
});

test('addCenterLineFromDialog: 昇格経路（既存中心線位置への通り芯追加）のundoは、通り芯化後に生成された自階の柱を撤去する（裁定(a)）', () => {
  const { project, graph } = makeProjectWithGraph();
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false }); // 昇格対象の中心線

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(result.done, true);
  assert.equal(result.toast, ERR_CL_CENTER_UPGRADED);
  const structCl = project.structGraph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  const structId = structCl.id;
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', structCl, y0);

  undoManager.undo();
  assert.equal(project.structGraph.shapeMap.has(structId), false, 'undoで通り芯は消え中心線に戻る');
  assert.equal(graph.columnMap.has(column.id), false, 'undoで通り芯化後に生成された柱も撤去されるはず（裁定(a)）');
  assert.ok(graph.centerLines.some(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000 && centerLineKind(cl) === 'center'), 'undoで中心線が復元される');
});

test('addCenterLineFromDialog: スパン配列バッチモードのundoは、追加された各通り芯を参照する自階の柱をすべて撤去する（裁定(a)）', () => {
  const { project, graph } = makeProjectWithGraph();
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical' }, value: [1000, 2000], kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(result.done, true);
  const cl1000 = project.structGraph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  const cl2000 = project.structGraph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const column1 = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', cl1000, y0);
  const column2 = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', cl2000, y0);

  undoManager.undo();
  assert.equal(project.structGraph.centerLines.some(cl => cl.value === 1000 || cl.value === 2000), false, 'undoで追加した2本の通り芯は両方消える');
  assert.equal(graph.columnMap.has(column1.id), false, 'undoで1000側の柱も撤去されるはず（裁定(a)）');
  assert.equal(graph.columnMap.has(column2.id), false, 'undoで2000側の柱も撤去されるはず（裁定(a)）');

  undoManager.redo();
  assert.equal(project.structGraph.centerLines.filter(cl => cl.value === 1000 || cl.value === 2000).length, 2, 'redoで2本とも同idで戻る');
});

// ---- ステップ3: addCenterLineFromDialog の直交端部走査を orthoAnchorCandidates（core/centerLineKindPolicy.js）
// 経由へ移行したことの回帰確認（centerLineKindPolicy.test.js の特性テストと対をなす、centerLineOps.js
// 側からの直接確認）。

test('addCenterLineFromDialog: 補助線の追加extentは梁芯を端部候補にしない（手前に梁芯、奥に通り芯→通り芯＋はね出し。2026-09-18裁定）', () => {
  const { project, graph } = makeProjectWithGraph();
  const vp = { scaleDenominator: 100 };
  graph.addCenterLine(CenterLineType.HORIZONTAL, -100, { labeled: false, discipline: Discipline.FUSE }); // 梁芯（手前・候補にならない）
  const structFar = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -500, { labeled: true, discipline: Discipline.STRUCT });

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
    vp,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => centerLineKind(cl) === 'aux' && cl.centerLineType === CenterLineType.VERTICAL);
  assert.equal(added.extentLoRef, null, '初回追加のためref化されず静的値（はね出し）になる');
  const OVERHANG_AT_DENOM_100 = 300; // snapGeometry.js overhangMm: denom===100はBASE_MM(300)そのもの
  assert.equal(added.extentLo, structFar.value - OVERHANG_AT_DENOM_100, '梁芯(-100)は候補にならず通り芯(-500)がはね出し込みで選ばれる');
});

test('addCenterLineFromDialog: 補助線の追加extentは壁を境界候補に含める（CLより壁が近ければ壁を優先。現行どおり・移行で変わらない）', () => {
  const { project, graph } = makeProjectWithGraph();
  const vp = { scaleDenominator: 100 };
  const wallAxis  = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const wallStart = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const wallEnd   = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  const wall = graph.addWall(wallAxis, 0, true, wallStart, 0, wallEnd, 0, { isExteriorWall: false });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 壁より遠いCL候補（選ばれない）

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 0, perpCoord: 1000 }, value: 0, kind: 'aux', refId: null, refOffset: 0 },
    vp,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => centerLineKind(cl) === 'aux' && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 0);
  assert.deepEqual(added.extentHiRef, { wallId: wall.id }, '壁(3000)が通り芯(5000)より近いため優先される');
});

test('addCenterLineFromDialog: 既存の補助線が同じ直交CLを参照済みなら、新規補助線の端部ははね出しではなく直交CL参照（ref）になる（lo側）', () => {
  const { project, graph } = makeProjectWithGraph();
  const vp = { scaleDenominator: 100 };
  const structLo = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -500, { labeled: true, discipline: Discipline.STRUCT });
  // 既存の補助線が structLo を extentLoRef で既に参照している状態を作る（同方向=VERTICALにして
  // 新規補助線自身の直交候補探索には混ざらないようにする——isReferencedByAuxの走査対象になる
  // ことだけが目的）。
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, lineType: 'dashed', extentLoRef: { clId: structLo.id, offset: 0 }, extentHi: 5000,
  });

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
    vp,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => centerLineKind(cl) === 'aux' && cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  assert.deepEqual(added.extentLoRef, { clId: structLo.id, offset: 0 }, '既存補助線が参照済みなのでref化される（はね出しを引かない）');
  assert.equal(added.extentLo, -500, 'structLoの値そのまま（overhangを引いていない）');
});

test('addCenterLineFromDialog: 既存の補助線が同じ直交CLを参照済みなら、新規補助線の端部ははね出しではなく直交CL参照（ref）になる（hi側）', () => {
  const { project, graph } = makeProjectWithGraph();
  const vp = { scaleDenominator: 100 };
  const structHi = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, lineType: 'dashed', extentHiRef: { clId: structHi.id, offset: 0 }, extentLo: -3000,
  });

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
    vp,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => centerLineKind(cl) === 'aux' && cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  assert.deepEqual(added.extentHiRef, { clId: structHi.id, offset: 0 }, '既存補助線が参照済みなのでref化される（はね出しを足さない）');
  assert.equal(added.extentHi, 5000, 'structHiの値そのまま（overhangを足していない）');
});

test('【失敗系】addCenterLineFromDialog: 補助線の追加extentは直交CL・壁が無ければフリー端点（perpCoordをキリ良く丸めた値）になり、lo/hiとも同じ値に退化する', () => {
  const { project, graph } = makeProjectWithGraph(); // 直交CL・壁を一切置かない
  const vp = { scaleDenominator: 100 };
  const perpCoord = 137;

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
    vp,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => centerLineKind(cl) === 'aux');
  assert.equal(added.extentLoRef, null, '直交CLが無いためref化されない');
  assert.equal(added.extentHiRef, null);
  const niceStep = calcStep(vp.scaleDenominator);
  const expected = Math.round(perpCoord / niceStep) * niceStep;
  assert.equal(added.extentLo, expected, 'lo側はperpCoordをキリ良く丸めたフリー端点になる');
  assert.equal(added.extentHi, expected, 'hi側も同じ丸め値になり、線分は長さ0に退化する');
});

// ---- M-1（QA指摘）: 同座標に「複数種別」が同時にある場合の重複判定の総当り ----
// 従来のCOEXISTENCE 16セルテスト（centerLineKindPolicy.test.js）は既存が単一種別のときしか
// 見ておらず、「同座標に複数種別が同時にある」ケース（例: 既存=中心線+補助線の状態へ通り芯を
// 追加）を検証できていなかった——実データprobe（clCoexistProbe.mjs）はCL_KINDSの並び逆転の
// ような変異を検出できず（実データに「同座標に複数種別」がほぼ無いため）、QAがscratchpadの
// combi.mjs（新規4種別×既存部分集合16通り×extent配置2通り=128ケースの総当り）で16/128件の
// 回帰を実測した。本テストはそれを単体テストとして取り込む。
// 期待値は「製品コードのexisting選択規則（新規と同種別の既存があれば最優先、無ければ優先順で
// 1つ選ぶ）」と「coexistenceAt」から導出する——ただし newKind==='struct' のとき同座標に
// 梁芯が1本でもあれば拒否、という規約は coexistenceAt(newKind, existingKind) という2引数の関係
// （priorityで選ばれた1本だけを見る）では表現できない特例（centerLineOps.js のコメント参照。
// 表駆動へは寄せず走査のAPI化のみに留めた箇所）として明示的に加える。
// 優先順はCL_KINDSをそのままimportして使わず、リテラルでハードコードする——製品コード
// （centerLineOps.js）もCL_KINDSをそのまま使うため、importして使うと期待値・実測値の両方が
// 同じ壊れたCL_KINDSを経由してしまい、CL_KINDS自体の並びが壊れる変異を検出できない
// （QA指摘M-1・QAのcombi.mjsと同じ方針。下のassertで現在値と一致することは別途確認する）。
test('addCenterLineFromDialog: 同座標に複数種別が同時にある場合の重複判定を総当りで照合する（新規4種別×既存部分集合16通り×extent2通り=128ケース、QA指摘M-1）', () => {
  const KINDS = ['struct', 'center', 'aux', 'beam'];
  assert.deepEqual(KINDS, [...CL_KINDS], '前提: ハードコードした優先順はCL_KINDSの現在値と一致する（CL_KINDS自体が壊れたらこのassertで検出する）');
  const VALUE = 1000;
  const clType = CenterLineType.VERTICAL;
  const perpType = CenterLineType.HORIZONTAL;
  const vp = { scaleDenominator: 100 };

  // 製品コード（centerLineOps.js addCenterLineFromDialog）の existing 選択規則そのもの
  // （優先順はKINDS＝上でハードコードしたリテラル配列を使う。CL_KINDSは使わない）。
  function pickExistingKind(newKind, present) {
    if (present.includes(newKind)) return newKind;
    return KINDS.find(k => present.includes(k)) ?? null;
  }

  // ポリシー（coexistenceAt）から導出した帰結の分類。
  function decideOutcome(newKind, present) {
    if (present.length === 0) return 'allowed';
    const existingKind = pickExistingKind(newKind, present);
    if (newKind === existingKind) {
      return coexistenceAt(newKind, existingKind) === 'forbidden' ? 'forbidden-same' : 'extent';
    }
    if (newKind === 'beam' && coexistenceAt(newKind, existingKind) === 'forbidden') return 'forbidden-beam-existing';
    if (newKind === 'struct' && present.includes('beam')) return 'forbidden-beam-anywhere';
    if (coexistenceAt(newKind, existingKind) === 'promote') return 'promote';
    if (newKind === 'center' && coexistenceAt(newKind, existingKind) === 'forbidden') return 'struct-exists';
    return 'allowed';
  }

  function seed(graph, project, kind, ext) {
    const e = ext ? { extentLo: -3000, extentHi: -1000 } : {};
    switch (kind) {
      case 'struct': return project.structGraph.addCenterLine(clType, VALUE, { labeled: true, discipline: Discipline.STRUCT });
      case 'center': return graph.addCenterLine(clType, VALUE, { labeled: false, discipline: Discipline.ARCH, ...e });
      case 'aux':    return graph.addCenterLine(clType, VALUE, { labeled: false, lineType: 'dashed', ...e });
      case 'beam':   return graph.addCenterLine(clType, VALUE, { labeled: false, discipline: Discipline.FUSE, ...e });
      default: throw new Error(`未知のCL種別: ${kind}`);
    }
  }

  let caseCount = 0;
  for (const newKind of KINDS) {
    for (let mask = 0; mask < 16; mask++) {
      const present = KINDS.filter((_, i) => mask & (1 << i));
      for (const ext of [false, true]) {
        caseCount++;
        const label = `newKind=${newKind} present=[${present.join(',')}] ext=${ext}`;
        const project = new Project('proj', 'test');
        const { graph } = project.addPlane(0, '1階', 'p1');
        // 直交通り芯2本（新規のextentを解決させる。perpCoord=2000でブラケットする）
        project.structGraph.addCenterLine(perpType, 1000, { labeled: true, discipline: Discipline.STRUCT });
        project.structGraph.addCenterLine(perpType, 3000, { labeled: true, discipline: Discipline.STRUCT });
        const seeded = present.map(k => ({ k, cl: seed(graph, project, k, ext) }));

        const outcome = decideOutcome(newKind, present);
        const result = addCenterLineFromDialog(
          graph, project,
          { clDialog: { type: 'vertical', worldCoord: VALUE, perpCoord: 2000 }, value: VALUE, kind: newKind, refId: null, refOffset: 0 },
          vp,
        );

        const survivedKinds = seeded
          .filter(s => graph.shapeMap.has(s.cl.id) || project.structGraph.shapeMap.has(s.cl.id))
          .map(s => s.k).sort();
        const addedKinds = graph.centerLines
          .filter(c => c.centerLineType === clType && Math.abs(c.value - VALUE) < 1 && !seeded.some(s => s.cl.id === c.id))
          .map(centerLineKind);

        if (outcome === 'forbidden-same' || outcome === 'forbidden-beam-existing'
          || outcome === 'forbidden-beam-anywhere' || outcome === 'struct-exists') {
          assert.equal(result.done, false, label);
          assert.deepEqual(survivedKinds, [...present].sort(), `${label}: 既存は全て残る`);
          assert.deepEqual(addedKinds, [], `${label}: 何も追加されない`);
        } else if (outcome === 'extent' && !ext) {
          // 既存extentが未指定(null)のため常に重なり扱い→拒否（centerLineOps.jsの
          // 「exLo==null||exHi==null → extentsOverlap=true」短絡）。
          assert.equal(result.done, false, label);
          assert.deepEqual(survivedKinds, [...present].sort(), label);
          assert.deepEqual(addedKinds, [], label);
        } else if (outcome === 'extent' && ext) {
          // 既存extentが[-3000,-1000]で新規extent（[1000,3000]付近）と重ならない→2本目を許可
          // （隣接もしないため結合もしない）。
          assert.equal(result.done, true, label);
          assert.deepEqual(survivedKinds, [...present].sort(), `${label}: 既存は全て残る`);
          assert.deepEqual(addedKinds, [newKind], `${label}: 同種別が2本目として追加される`);
        } else if (outcome === 'promote') {
          assert.equal(result.done, true, label);
          assert.equal(result.toast, ERR_CL_CENTER_UPGRADED, label);
          assert.equal(pickExistingKind(newKind, present), 'center', label);
          assert.deepEqual(survivedKinds, present.filter(k => k !== 'center').sort(), `${label}: centerだけ削除され他は残る`);
          assert.ok(
            project.structGraph.centerLines.some(c => c.centerLineType === clType && Math.abs(c.value - VALUE) < 1),
            `${label}: structGraphに通り芯が増える`,
          );
        } else if (outcome === 'allowed') {
          assert.equal(result.done, true, label);
          assert.deepEqual(survivedKinds, [...present].sort(), `${label}: 既存は全て残る`);
          assert.deepEqual(addedKinds, [newKind], `${label}: 新規が追加される`);
        } else {
          assert.fail(`未知のoutcome: ${outcome} (${label})`);
        }
      }
    }
  }
  assert.equal(caseCount, 128, '4種別×16マスク×2extent=128ケースを網羅する');
});

// ---- promoteCenterToGridWithUndo / demoteGridToCenterWithUndo ----
// findFloorsWithCounterpartCL・propagateDemotedCenterLine は project.planeMap の「アクティブ以外の
// 全Plane」を floorSwapManager.peek（IndexedDB経由）する。単一階の project では対象階が0件となり
// peek は発生しないため、そのまま node:test で検証できる（下の大半のテスト）。複数階をまたぐ
// シナリオ（重複ガード・複製伝播）は structural/wallBeamAxes.test.js:231-234 と同じ方式——
// floorSwapManager.peek をテスト中だけ差し替え（try/finallyで必ず復元）、実IDBを経由せずに
// ロジックだけを検証する。IDB不在を理由に断念しない（QA指摘m-6: 旧コメントは:197-207を指しており
// 誤記だった）。ただしこの単純な「生きたグラフをそのまま返す」形は、peekの戻り値を読むだけで
// 書き込み（saveFloorFn経由の再シリアライズ）を経ない検証（同期ガード・重複判定の可否）に限る——
// シリアライズ往復を伴う複製・回収の検証は本番同型peek（下記 withProductionPeek）を使う。

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

// ---- 発見②（S造の降格ではなく在来木造の昇格ブロック）の解消: 昇格時に同座標の保護されない
// 壁由来梁芯を吸収して撤去する（ユーザー裁定・案A・2026-09-25）。保護判定は
// structural/wallBeamAxes.jsのisProtectedWallBeamAxis（orphanedWallBeamAxesと共有する単一の述語）。

test('promoteCenterToGridWithUndo: 保護されない壁由来梁芯が同座標にあっても昇格が成功し梁芯が消え、undoで同idのまま戻る', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
  assert.equal(toast, null, '梁芯があっても拒否されない（吸収して撤去する）');
  assert.equal(project.structGraph.shapeMap.get(cl.id), cl, '通り芯化される');
  assert.equal(graph.shapeMap.has(beamAxisId), false, '保護されない梁芯は吸収されて消える');

  undoManager.undo();
  assert.equal(graph.shapeMap.has(cl.id), true, 'undoで中心線に戻る');
  assert.equal(graph.shapeMap.has(beamAxisId), true, 'undoで梁芯も同idのまま戻る');

  undoManager.redo();
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'redoで通り芯に戻る');
  assert.equal(graph.shapeMap.has(beamAxisId), false, 'redoで梁芯も再び消える');
});

test('promoteCenterToGridWithUndo: lockedの柱が乗る壁由来梁芯は保護され、昇格はERR_CL_CONVERT_DUPで拒否される', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beamAxis, y0, { dimensionStatus: 'locked' }); // 手動固定

  const beforeTop = undoManager.peekUndo();
  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
  assert.equal(toast, ERR_CL_CONVERT_DUP('beam'));
  assert.equal(graph.shapeMap.has(cl.id), true, '拒否時は昇格されない');
  assert.equal(graph.shapeMap.has(beamAxis.id), true, '保護された梁芯は残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('promoteCenterToGridWithUndo: refIdを持つ壁由来梁芯（手動追加の可能性）は保護され、昇格は拒否される', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const refTarget = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: refTarget.id, refOffset: 1000 });

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
  assert.equal(toast, ERR_CL_CONVERT_DUP('beam'));
  assert.equal(graph.shapeMap.has(beamAxis.id), true, 'refIdを持つ梁芯は残る（保護される）');
});

test('promoteCenterToGridWithUndo: 他CLから参照される壁由来梁芯は保護され、昇格は拒否される', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  // 他の中心線（aux）がbeamAxisをextentLoRefで参照する。
  graph.addCenterLine(CenterLineType.HORIZONTAL, 500, {
    labeled: false, lineType: 'dashed', extentLoRef: { clId: beamAxis.id, offset: 0 }, extentHi: 2000,
  });

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
  assert.equal(toast, ERR_CL_CONVERT_DUP('beam'));
  assert.equal(graph.shapeMap.has(beamAxis.id), true, '他CLから参照される梁芯は残る（保護される）');
});

test('promoteCenterToGridWithUndo: 保護されない壁由来梁芯の吸収撤去はexcludedWallBeamAxesを変えない', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beforeSize = graph.excludedWallBeamAxes.size;

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
  assert.equal(toast, null);
  assert.equal(graph.excludedWallBeamAxes.size, beforeSize, '手動削除の記録ではないためexcludedWallBeamAxesは変わらない');
});

test('promoteCenterToGridWithUndo: 斜線が取り付いた中心線はtoast:ERR_CL_CONVERT_ATTACHEDでundoを積まない', async () => {
  const { project, graph } = makeProjectWithGraph();
  // 昇格は直交通り芯の本数を問わないため必須ではないが、実運用に近い状態（直交通り芯あり）でも
  // ATTACHEDガードが正しく効くことを確認するため用意する。
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
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にclの他にもう1本必要。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
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

// 昇格は直交通り芯の本数を問わないため（旧F4ガード撤去済み）、N5（同期ガード優先評価）の
// 昇格側デモには別の同期ガード（ATTACHED）を使う——降格側は別の同期ガード（想定外の
// discipline/labeled組合せ）で実演する（下記）。降格側のNO_GRID自体の先行評価は
// さらに下のテストで別途実証する。
test('promoteCenterToGridWithUndo: 同期ガード（ATTACHED）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  graph.addDiagonalLine(ix, graph.addPoint(2000, 2000));
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_ATTACHED);
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

// 降格は直交通り芯2本必須のガードを維持する（昇格と非対称。旧F4ガード撤去済みなのは昇格側のみ）
// ため、NO_GRID自体もIDB peekより先に評価されることを別途実証する。
test('demoteGridToCenterWithUndo: 同期ガード（NO_GRID）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_NO_GRID);
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
  // （structural/wallBeamAxes.test.js:231-234 と同じ方式。floorSwapManagerはシングルトンインスタンス）。
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'center' }]));
    // ERR_CL_CONVERT_DUP_FLOOR自体を呼んで期待値を作ると、その関数がkindを無視する変異を
    // 検出できない——リテラル文字列で固定する（QA指摘m-1）。
    assert.equal(toast, '2階 の同じ位置に中心線があるため通り芯にできません。');
    assert.equal(activeGraph.shapeMap.has(cl.id), true, '変換されず階グラフに残る');
    assert.equal(project.structGraph.shapeMap.has(cl.id), false);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('promoteCenterToGridWithUndo: 他階の相手が保護されない梁芯のみのときは拒否されず吸収される（発見④・ユーザー裁定・案A・2026-09-25）', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  const otherBeamAxis = otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 保護されない梁芯のみ
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  const saveFloorFn = async () => {}; // 生きたグラフをそのまま返すスタブのため実IDBを経由させない
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl, { saveFloorFn });
    assert.equal(toast, null, '保護されない梁芯のみでは拒否されない（吸収して撤去する）');
    assert.equal(otherGraph.shapeMap.has(otherBeamAxis.id), false, '他階の梁芯も吸収されて消える');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('promoteCenterToGridWithUndo: 2階建てで他階の壁由来梁芯が昇格時に吸収され保存バイトから消える。undoで同idのまま戻りredoで再び消える（発見④・案A）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const otherBeamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const otherBeamAxisId = otherBeamAxis.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    const { toast } = await promoteCenterToGridWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.equal(project.structGraph.shapeMap.has(cl.id), true, '通り芯化される');
    let decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(otherBeamAxisId), false, '他階の保存バイトから梁芯が消える');

    undoManager.undo();
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(otherBeamAxisId), true, 'undoで他階の梁芯が同idのまま戻る');

    undoManager.redo();
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(otherBeamAxisId), false, 'redoで他階の梁芯が再び消える');
  });
});

test('promoteCenterToGridWithUndo: 他階の壁由来梁芯にlockedの柱が乗っていれば拒否される（ERR_CL_CONVERT_DUP_FLOOR）。自階無変更・undo未積み・listenerは呼ばれない（発見④・案A）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const otherBeamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  p2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', otherBeamAxis, y0, { dimensionStatus: 'locked' });

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };
  const beforeTop = undoManager.peekUndo();
  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await withProductionPeek(project, store, async () => {
      const { toast } = await promoteCenterToGridWithUndo(p1, project, cl, { saveFloorFn });
      assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'beam' }]));
      assert.equal(p1.shapeMap.has(cl.id), true, '自階は無変更（中心線のまま）');
      assert.equal(project.structGraph.shapeMap.has(cl.id), false);
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  assert.equal(calls, 0, 'listenerは呼ばれない');
});

test('promoteCenterToGridWithUndo: 他階の壁由来梁芯がrefIdを持つ（手動追加の可能性）なら拒否される（発見④・案A）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const refTarget = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const otherBeamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, refId: refTarget.id, refOffset: 1000,
  });

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };
  await withProductionPeek(project, store, async () => {
    const { toast } = await promoteCenterToGridWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'beam' }]));
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(otherBeamAxis.id), true, 'refIdを持つ梁芯は残る（保護される）');
  });
});

test('【失敗系】promoteCenterToGridWithUndo: 他階の梁芯吸収でsaveFloorFnがthrowしたらrollbackし、自階・undoは無変更・listenerは呼ばれない（発見④・案A）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async () => { throw new Error('save failed'); };
  const beforeTop = undoManager.peekUndo();
  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await withProductionPeek(project, store, async () => {
      await assert.rejects(() => promoteCenterToGridWithUndo(p1, project, cl, { saveFloorFn }), /save failed/);
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
  assert.equal(project.structGraph.shapeMap.has(cl.id), false, '自階は無変更（中心線のまま）');
  assert.equal(p1.shapeMap.has(cl.id), true);
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  assert.equal(calls, 0, 'listenerは呼ばれない');
});

test('promoteCenterToGridWithUndo: 同じ他階に「梁芯吸収」と「複製回収」の記録が両方あってもundoで両方とも正しく復元される（発見④・案A。applyFloorUndoRecordsの逆順適用の裏取り）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const cl = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id); // 降格複製を模す（同一id）
  const otherBeamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const otherBeamAxisId = otherBeamAxis.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    const { toast } = await promoteCenterToGridWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    let decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(cl.id), false, '複製は回収される');
    assert.equal(decoded.shapeMap.has(otherBeamAxisId), false, '梁芯は吸収される');

    undoManager.undo();
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(cl.id), true, 'undoで複製が同idのまま戻る');
    assert.equal(decoded.shapeMap.has(otherBeamAxisId), true, 'undoで梁芯も同idのまま戻る');

    undoManager.redo();
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(cl.id), false, 'redoで複製が再び回収される');
    assert.equal(decoded.shapeMap.has(otherBeamAxisId), false, 'redoで梁芯も再び吸収される');
  });
});

test('promoteCenterToGridWithUndo: 同じ他階に中心線と梁芯の両方があれば中心線を優先して表示する（優先順: 中心線＞補助線＞梁芯）', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 梁芯
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 中心線（同座標に共存）
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'center' }]), '梁芯より中心線を優先して表示する');
    assert.equal(toast, '2階 の同じ位置に中心線があるため通り芯にできません。', 'リテラル文字列で固定（QA指摘m-1）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('promoteCenterToGridWithUndo: 複数階・種別混在のトーストは種別ごとにまとめ「、」で連結する（種別の並び順は中心線→補助線→梁芯）', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3');
  const { graph: g4 } = project.addPlane(9000, '4階', 'p4');
  g4.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 4階=中心線
  // 2階・3階=梁芯（発見④・案Aで保護されない梁芯は他階重複の相手から除外されるため、lockedの柱を
  // 乗せて保護し、引き続き他階重複の相手として残ることを確認する）。
  const beam2 = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beam3 = g3.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const y0g2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const y0g3 = g3.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  g2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beam2, y0g2, { dimensionStatus: 'locked' });
  g3.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beam3, y0g3, { dimensionStatus: 'locked' });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const graphsById = new Map([[g2.plane.id, g2], [g3.plane.id, g3], [g4.plane.id, g4]]);
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => graphsById.get(plane.id) ?? null;
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl);
    // 種別の並び順（中心線→補助線→梁芯）が優先され、階の登録順（2階・3階・4階）ではなく
    // 「4階（中心線）」が先に来る。同種別の階（2階・3階）は「・」で連結する。
    assert.equal(
      toast,
      '4階 の同じ位置に中心線、2階・3階 の同じ位置に梁芯があるため通り芯にできません。',
    );
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
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にclの他にもう1本必要（このテストの主眼＝DUP_FLOORとは無関係）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await demoteGridToCenterWithUndo(activeGraph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE([{ name: '2階', kind: 'center' }]), '降格専用の文言（「中心線にできません」）が使われる（N1）');
    assert.equal(toast, '2階 の同じ位置に中心線があるため中心線にできません。', 'リテラル文字列で固定（QA指摘m-1）');
    assert.equal(project.structGraph.shapeMap.has(cl.id), true, '変換されずstructGraphに残る（片階だけ複製漏れを防ぐ）');
    assert.equal(activeGraph.shapeMap.has(cl.id), false);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('demoteGridToCenterWithUndo: 他階の相手が補助線のみのときはトースト文言に「補助線」と表示される', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' }); // 補助線
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await demoteGridToCenterWithUndo(activeGraph, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE([{ name: '2階', kind: 'aux' }]));
    assert.equal(toast, '2階 の同じ位置に補助線があるため中心線にできません。', 'リテラル文字列で固定（QA指摘m-1）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 同一id複製（降格が propagateDemotedCenterLine で他階へ複製した「同じ線の分身」）の
// 往復シナリオ。saveFloorFn を注入して実IDBを経由せず記録だけで検証する（wallRefresh.js の
// saveFloorFn 注入と同じ前例。promoteCenterToGridWithUndo/demoteGridToCenterWithUndo の第4引数）。

test('promoteCenterToGridWithUndo: 他階にある同一idの複製は重複拒否の対象にせず昇格でき、複製は回収される', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id); // 降格複製を模す（同一id）
  const clId = cl.id;

  const saved = [];
  const saveFloorFn = async (planeId) => { saved.push(planeId); };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, { saveFloorFn });

    assert.equal(toast, null, '同一idは重複扱いされず拒否されない');
    assert.equal(project.structGraph.shapeMap.has(clId), true);
    assert.equal(graph.shapeMap.has(clId), false);
    assert.equal(otherGraph.shapeMap.has(clId), false, '他階の同一id複製は回収される');
    assert.deepEqual(saved, [otherGraph.plane.id]);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('降格→昇格→降格の往復が通り、最終状態で他階に同一idの中心線が1本だけ残る（R7）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 同軸にもう1本（isLastGridOnAxis対策）
  const clId = cl.id;

  const saveFloorFn = async () => {};
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    // 1回目: 降格
    const d1 = await demoteGridToCenterWithUndo(graph, project, cl, { saveFloorFn });
    assert.equal(d1.toast, null);
    assert.equal(graph.shapeMap.has(clId), true);
    assert.equal(otherGraph.shapeMap.has(clId), true, '他階へ複製される');

    // 2回目: 昇格（他階の同一id複製が重複拒否せず回収される）
    const p1r = await promoteCenterToGridWithUndo(graph, project, graph.shapeMap.get(clId), { saveFloorFn });
    assert.equal(p1r.toast, null);
    assert.equal(project.structGraph.shapeMap.has(clId), true);
    assert.equal(graph.shapeMap.has(clId), false);
    assert.equal(otherGraph.shapeMap.has(clId), false, '複製は回収される');

    // 3回目: 再度降格
    const d2 = await demoteGridToCenterWithUndo(graph, project, project.structGraph.shapeMap.get(clId), { saveFloorFn });
    assert.equal(d2.toast, null);
    assert.equal(graph.shapeMap.has(clId), true);
    assert.equal(otherGraph.shapeMap.has(clId), true);
    assert.equal(otherGraph.centerLines.filter(c => c.id === clId).length, 1, '最終状態でp2に同一idの中心線が1本だけ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('promoteCenterToGridWithUndo: undoで他階の複製が復活し、redoで再び回収される（saveFloorFn記録で観測。R9）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const otherPlane = otherGraph.plane;
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id);
  const clId = cl.id;

  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push({ planeId, bytes }); };
  // saveFloorFnで受け取ったバイト列を、peekと同じ手順（PlanGraph+_structGraph差し込み+restoreGraph）で
  // 復号して中身を確認する（otherGraphは生きた同一インスタンスのため、そのshapeMapでは undo/redo の
  // 書き戻しを観測できない——非アクティブ階はIDB書込のみが正であり、amendFloorUndoRecordsも
  // saveFloorFn呼び出しのみを行い、生きたotherGraphオブジェクト自体は書き換えない）。
  const decode = (bytes) => {
    const tmp = new PlanGraph(otherPlane);
    tmp._structGraph = project.structGraph;
    restoreGraph(tmp, bytes);
    return tmp;
  };

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherPlane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.equal(saved.length, 1, '昇格確定時に1回保存される');
    assert.equal(decode(saved[0].bytes).shapeMap.has(clId), false, '昇格直後の保存バイトは複製回収後の状態');

    saved.length = 0;
    undoManager.undo();
    assert.equal(saved.length, 1, 'undoでp2への書き戻しが記録される');
    assert.equal(saved[0].planeId, otherPlane.id);
    assert.equal(decode(saved[0].bytes).shapeMap.has(clId), true, 'undoで書き戻すバイトは複製が復活した状態');

    saved.length = 0;
    undoManager.redo();
    assert.equal(saved.length, 1, 'redoでp2への書き戻しが記録される');
    assert.equal(decode(saved[0].bytes).shapeMap.has(clId), false, 'redoで書き戻すバイトは複製が回収された状態');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- demoteGridToCenterWithUndo: 複製→移籍の順序（案A、2026-09-17裁定）----
// 上のR7/R9等は floorSwapManager.peek を「生きた他階グラフをそのまま返す」スタブに差し替えている
// ため、graphSnapshot.js の restoreGraph（axisCLの id 解決）を経由しない——本番の peek は毎回
// IDBのバイト列から PlanGraph を作り直す（FloorSwapManager.js peek 参照）。以下は本番と同型の
// peek（`new PlanGraph(plane)` + `_structGraph = project.structGraph` + `restoreGraph`）で、
// 他階の壁がその通り芯を id 参照している場合にだけ再現するリグレッション
// （複製フェーズより先に本体を移籍すると、複製のため他階を peek した時点で通り芯が
// project.structGraph に無く、壁の axisCL が resolveCL で解決できず復元時に捨てられる）を検証する。

// 2階建て・structGraph に perp軸(Y)の通り芯2本＋対象軸(V)の通り芯2本（isLastGridOnAxis対策）を
// 持つ最小構成を作る共通ヘルパ。
function makeTwoFloorsWithGridCL() {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  return { project, p1, p2, y0, y3, cl };
}

// 本番同型 peek（IDBの代わりに Map ストアを読む）＋ saveFloorFn（Map ストアへ書く）を差し替える共通ヘルパ。
function withProductionPeek(project, store, fn) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => {
    const g = new PlanGraph(plane);
    g._structGraph = project.structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  return (async () => {
    try {
      return await fn();
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  })();
}

// store に保存されたバイト列を、peek と同じ手順で復号する（decode ヘルパは saveFloorFn 観測テストで前例あり）。
function decodeFloor(project, plane, bytes) {
  const tmp = new PlanGraph(plane);
  tmp._structGraph = project.structGraph;
  if (bytes) restoreGraph(tmp, bytes);
  return tmp;
}

test('demoteGridToCenterWithUndo: 他階でその通り芯を軸にする壁・開口は降格後も残り、軸は複製された中心線に解決される（本番同型peek）', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const wall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  p2.addOpening(cl, 1, true, y0, 500, 800, OpeningCategory.FITTING, 'singleSwing', {});
  const wallId = wall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { toast } = await withProductionPeek(project, store, () =>
    demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn })
  );

  assert.equal(toast, null);

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.walls.length, 1, '他階の壁は降格後も残る');
  assert.equal(decoded.walls[0].id, wallId);
  assert.equal(decoded.walls[0].axisCL.id, clId, '壁の軸は複製された中心線（同一id）に解決される');
  assert.equal(decoded.walls[0].axisCL.labeled, false, '複製された中心線はlabeled:false（通り芯ではない）');
  assert.equal(decoded.openings.length, 1, '他階の開口も降格後も残る');
});

test('demoteGridToCenterWithUndo: 降格→昇格→降格の往復（本番同型peek）で他階の壁が3回とも残り、昇格後は structGraph 側の通り芯に解決される', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const wall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  const wallId = wall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    // 1回目: 降格
    const d1 = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(d1.toast, null);
    let decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.walls.length, 1, '降格後も壁は残る（1回目）');
    assert.equal(decoded.walls[0].id, wallId);
    assert.equal(decoded.walls[0].axisCL.id, clId);
    assert.equal(decoded.walls[0].axisCL.labeled, false, '降格後は複製（中心線）に解決される');

    // 2回目: 昇格
    const promoted = p1.shapeMap.get(clId);
    const p2r = await promoteCenterToGridWithUndo(p1, project, promoted, { saveFloorFn });
    assert.equal(p2r.toast, null);
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.walls.length, 1, '昇格後も壁は残る（2回目）');
    assert.equal(decoded.walls[0].id, wallId);
    assert.equal(decoded.walls[0].axisCL.id, clId);
    assert.equal(decoded.walls[0].axisCL.labeled, true, '昇格後はstructGraph側の通り芯に解決される');
    assert.equal(decoded.shapeMap.has(clId), false, '昇格後は他階の複製自体は回収されている');

    // 3回目: 再度降格
    const clAfterPromote = project.structGraph.shapeMap.get(clId);
    const d2 = await demoteGridToCenterWithUndo(p1, project, clAfterPromote, { saveFloorFn });
    assert.equal(d2.toast, null);
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.walls.length, 1, '再度の降格後も壁は残る（3回目）');
    assert.equal(decoded.walls[0].id, wallId);
    assert.equal(decoded.walls[0].axisCL.id, clId);
    assert.equal(decoded.walls[0].axisCL.labeled, false);
  });
});

test('demoteGridToCenterWithUndo: undoで他階の複製が消えredoで再び複製される（saveFloorFn記録のバイト列を復号して観測。本番同型peek）', async () => {
  const { project, p1, p2, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push({ planeId, bytes }); store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    const { toast } = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.equal(saved.length, 1, '降格確定時に1回保存される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).shapeMap.has(clId), true, '降格直後の保存バイトは複製後の状態');

    saved.length = 0;
    undoManager.undo();
    assert.equal(saved.length, 1, 'undoでp2への書き戻しが記録される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).shapeMap.has(clId), false, 'undoで書き戻すバイトは複製前の状態');

    saved.length = 0;
    undoManager.redo();
    assert.equal(saved.length, 1, 'redoでp2への書き戻しが記録される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).shapeMap.has(clId), true, 'redoで書き戻すバイトは複製後の状態');
  });
});

test('demoteGridToCenterWithUndo: 複製フェーズの2階目でsaveFloorFnがthrowしたら、1階目はbeforeで書き戻され、自階・structGraphは未変更、undoは積まれず、rejectする', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: p3 } = project.addPlane(6000, '3階', 'p3');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)], [p3.plane.id, serializeGraph(p3)]]);
  const calls = [];
  const saveFloorFn = async (planeId, bytes) => {
    calls.push(planeId);
    if (planeId === p3.plane.id) throw new Error('p3 save failed');
    store.set(planeId, bytes);
  };
  const beforeTop = undoManager.peekUndo();

  await withProductionPeek(project, store, async () => {
    await assert.rejects(() => demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn }), /p3 save failed/);

    assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
    assert.equal(p1.shapeMap.has(clId), false, '自階は未変更');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');

    assert.equal(calls.filter(id => id === p2.plane.id).length, 2, 'p2は複製→ロールバックの2回saveFloorFnが呼ばれる');
    assert.equal(calls.filter(id => id === p3.plane.id).length, 1, 'p3は複製の1回（例外で失敗）だけ');

    const decodedP2 = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decodedP2.shapeMap.has(clId), false, 'p2はロールバックされ複製が残らない（beforeに書き戻された）');
  });
});

test('demoteGridToCenterWithUndo: 複製後にapplyDemoteToCenterがエラーを返したら他階の複製も巻き戻り、自階・structGraph・undoは未変更でトーストだけ返す', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let intruded = false;
  // IDB待ち（saveFloorFn の await）の間に、自階の同座標へ中心線が割り込み追加される状況を模擬する
  // → 複製は済んでいるが applyDemoteToCenter が ERR_CL_CONVERT_DUP_DEMOTE('center') を返す経路。
  const saveFloorFn = async (planeId, bytes) => {
    store.set(planeId, bytes);
    if (!intruded) {
      intruded = true;
      p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'center' });
    }
  };
  const beforeTop = undoManager.peekUndo();

  await withProductionPeek(project, store, async () => {
    const { toast } = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });

    assert.equal(toast, ERR_CL_CONVERT_DUP_DEMOTE('center'));
    assert.equal(toast, '同じ位置に中心線があるため中心線にできません。', 'リテラル文字列で固定（QA指摘m-1）');
    assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
    assert.equal(p1.shapeMap.has(clId), false, '自階へは移籍していない');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
    const decodedP2 = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decodedP2.shapeMap.has(clId), false, 'p2の複製はロールバックされている');
  });
});

test('demoteGridToCenterWithUndo: ロールバックの書き戻しも失敗したら元の例外がそのままrejectされ、自階・structGraph・undoは未変更', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async () => { throw new Error('save failed'); }; // 複製もロールバックも常に失敗
  const beforeTop = undoManager.peekUndo();

  await withProductionPeek(project, store, async () => {
    await assert.rejects(() => demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn }), /save failed/);

    assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
    assert.equal(p1.shapeMap.has(clId), false, '自階は未変更');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  });
});

// ---- 段階(c)・2026-09-25: promoteCenterToGridWithUndo / demoteGridToCenterWithUndo → 構造同期
// リスナー（amendは使わないinline方式。他階レコードの適用はnotifyの直前に同じundo/redoクロージャで
// 行う——順序は「struct→自階→他階→notify」）。setCenterLineStructuralListener は必ずfinallyでnullに
// 戻す（他テストへ漏らさない）。

test('promoteCenterToGridWithUndo: 通り芯化は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回。単一階）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
    assert.equal(toast, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'all');

    undoManager.undo();
    assert.equal(calls.length, 2);
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('promoteCenterToGridWithUndo: 通り芯化はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
    assert.equal(toast, null);
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');
    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('demoteGridToCenterWithUndo: 中心線化は構造同期リスナーを(graph, project, "all")で呼ぶ（確定1回・undo1回・redo1回＝計3回。単一階）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);
    assert.equal(toast, null, JSON.stringify(toast));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'all');

    undoManager.undo();
    assert.equal(calls.length, 2);
    undoManager.redo();
    assert.equal(calls.length, 3);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('demoteGridToCenterWithUndo: 中心線化はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);
    assert.equal(toast, null, JSON.stringify(toast));
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');
    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

// ---- 順序テスト（最重要）: saveFloorFn（他階書込）がstructuralSyncListener（sync）より必ず先に
// 実行される（確定・undo・redoのいずれも）。共通配列logに save:${planeId} と sync を積んで確認する。

test('【順序が最重要】promoteCenterToGridWithUndo: 他階の梁芯吸収・複製回収（save）が構造同期（sync）より必ず先に実行される（確定・undo・redo。発見④分のsaveを含む）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const otherPlane = otherGraph.plane;
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id); // 降格複製を模す（同一id）
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null }); // 発見④: 保護されない壁由来梁芯（同座標）

  const log = [];
  const saveFloorFn = async (planeId) => { log.push(`save:${planeId}`); };
  setCenterLineStructuralListener(() => { log.push('sync'); });
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherPlane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.deepEqual(log, [`save:${otherPlane.id}`, `save:${otherPlane.id}`, 'sync'], '確定: 吸収・回収のsaveがともにsyncより先');

    log.length = 0;
    undoManager.undo();
    assert.deepEqual(log, [`save:${otherPlane.id}`, `save:${otherPlane.id}`, 'sync'], 'undo: saveがsyncより先');

    log.length = 0;
    undoManager.redo();
    assert.deepEqual(log, [`save:${otherPlane.id}`, `save:${otherPlane.id}`, 'sync'], 'redo: saveがsyncより先');
  } finally {
    floorSwapManager.peek = originalPeek;
    setCenterLineStructuralListener(null);
  }
});

test('【順序が最重要】demoteGridToCenterWithUndo: 他階への複製（save）が構造同期（sync）より必ず先に実行される（確定・undo・redo）', async () => {
  const { project, p1, p2, cl } = makeTwoFloorsWithGridCL();

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const log = [];
  const saveFloorFn = async (planeId, bytes) => { log.push(`save:${planeId}`); store.set(planeId, bytes); };
  setCenterLineStructuralListener(() => { log.push('sync'); });

  await withProductionPeek(project, store, async () => {
    const { toast } = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, null, JSON.stringify(toast));
    assert.deepEqual(log, [`save:${p2.plane.id}`, 'sync'], '確定: saveがsyncより先');

    log.length = 0;
    undoManager.undo();
    assert.deepEqual(log, [`save:${p2.plane.id}`, 'sync'], 'undo: saveがsyncより先');

    log.length = 0;
    undoManager.redo();
    assert.deepEqual(log, [`save:${p2.plane.id}`, 'sync'], 'redo: saveがsyncより先');
  });
  setCenterLineStructuralListener(null);
});

// ---- 失敗系: 構造同期リスナーは0回（ガードtoast・他階重複toast・apply系エラー・複製/伝播失敗） ----

test('【失敗系】promoteCenterToGridWithUndo: ガードtoast（ERR_CL_CONVERT_ATTACHED）は構造同期リスナーを呼ばない', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  graph.addDiagonalLine(ix, graph.addPoint(2000, 2000));

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_ATTACHED);
    assert.equal(calls, 0);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】promoteCenterToGridWithUndo: 他階重複トースト（ERR_CL_CONVERT_DUP_FLOOR）は構造同期リスナーを呼ばない', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 別id・同座標＝重複相手

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: otherGraph.plane.name, kind: 'center' }]));
    assert.equal(calls, 0);
  } finally {
    floorSwapManager.peek = originalPeek;
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】promoteCenterToGridWithUndo: 回収（recallPromotedCenterLineDuplicates）がthrowしたらnotifyせず再throwする（R2）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id); // 回収対象の複製

  const beforeTop = undoManager.peekUndo();
  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  const saveFloorFn = async () => { throw new Error('recall save failed'); };
  try {
    await assert.rejects(() => promoteCenterToGridWithUndo(graph, project, cl, { saveFloorFn }), /recall save failed/);
    assert.equal(calls, 0, '回収が失敗したらnotifyしないはず');
    assert.notEqual(undoManager.peekUndo(), beforeTop, '昇格自体のundoエントリは既に積まれたまま残る（R2の対象は回収失敗時のnotifyのみ）');
  } finally {
    floorSwapManager.peek = originalPeek;
    setCenterLineStructuralListener(null);
    undoManager.undo(); // 後続テストへ影響しないよう積まれたエントリを戻す
  }
});

test('【失敗系】demoteGridToCenterWithUndo: ガードtoast（ERR_CL_CONVERT_NO_GRID）は構造同期リスナーを呼ばない', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_NO_GRID);
    assert.equal(calls, 0);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】demoteGridToCenterWithUndo: 他階重複トースト（ERR_CL_CONVERT_DUP_FLOOR_DEMOTE）は構造同期リスナーを呼ばない', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 重複相手

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === p2.plane.id ? p2 : null);
  try {
    const { toast } = await demoteGridToCenterWithUndo(p1, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE([{ name: p2.plane.name, kind: 'center' }]));
    assert.equal(calls, 0);
  } finally {
    floorSwapManager.peek = originalPeek;
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】demoteGridToCenterWithUndo: 複製フェーズの2階目でsaveFloorFnがthrowしたら構造同期リスナーを呼ばない', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: p3 } = project.addPlane(6000, '3階', 'p3');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  const store = new Map([[p2.plane.id, serializeGraph(p2)], [p3.plane.id, serializeGraph(p3)]]);
  const saveFloorFn = async (planeId, bytes) => {
    if (planeId === p3.plane.id) throw new Error('p3 save failed');
    store.set(planeId, bytes);
  };
  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await withProductionPeek(project, store, async () => {
      await assert.rejects(() => demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn }), /p3 save failed/);
      assert.equal(calls, 0);
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】demoteGridToCenterWithUndo: 複製後にapplyDemoteToCenterがエラーを返す（ロールバック）経路は構造同期リスナーを呼ばない', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let intruded = false;
  const saveFloorFn = async (planeId, bytes) => {
    store.set(planeId, bytes);
    if (!intruded) {
      intruded = true;
      p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'center' });
    }
  };
  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await withProductionPeek(project, store, async () => {
      const { toast } = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });
      assert.equal(toast, ERR_CL_CONVERT_DUP_DEMOTE('center'));
      assert.equal(calls, 0);
    });
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系】promoteCenterToGridWithUndo: 構造同期リスナー未設定（null）でも例外なく通り芯化・undoできる', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });

  await assert.doesNotReject(() => promoteCenterToGridWithUndo(graph, project, cl));
  assert.doesNotThrow(() => undoManager.undo());
});

test('【失敗系】demoteGridToCenterWithUndo: 構造同期リスナー未設定（null）でも例外なく中心線化・undoできる', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策

  await assert.doesNotReject(() => demoteGridToCenterWithUndo(graph, project, cl));
  assert.doesNotThrow(() => undoManager.undo());
});

// ---- 【失敗系】QA指摘m-3: ERR_CL_CONVERT_DUP_FLOOR/_DEMOTE は未知種別でthrowする ----
// 'struct'はCL種別としては既知だが、他階の入替え相手（CROSS_FLOOR_COUNTERPART_KINDS＝
// center/aux/beam）としては無効——通り芯は全階共有オブジェクトのため他階の「別の相手」には
// なりえない（原理上そのようなfloorsByKindは作られないはずだが、防御的にthrowで検出する）。

test('【失敗系】ERR_CL_CONVERT_DUP_FLOOR: floorsByKindの要素に未知種別・struct種別があればthrowする', () => {
  assert.throws(() => ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'wood' }]), /未知のCL種別: wood/);
  assert.throws(() => ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'struct' }]), /未知のCL種別: struct/);
});

test('【失敗系】ERR_CL_CONVERT_DUP_FLOOR_DEMOTE: floorsByKindの要素に未知種別・struct種別があればthrowする', () => {
  assert.throws(() => ERR_CL_CONVERT_DUP_FLOOR_DEMOTE([{ name: '2階', kind: 'wood' }]), /未知のCL種別: wood/);
  assert.throws(() => ERR_CL_CONVERT_DUP_FLOOR_DEMOTE([{ name: '2階', kind: 'struct' }]), /未知のCL種別: struct/);
});

test('ERR_CL_CONVERT_DUP_FLOOR/_DEMOTEはcenter/aux/beamすべてでthrowせず、混在・複数階も正しく連結する', () => {
  for (const kind of ['center', 'aux', 'beam']) {
    assert.doesNotThrow(() => ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind }]));
    assert.doesNotThrow(() => ERR_CL_CONVERT_DUP_FLOOR_DEMOTE([{ name: '2階', kind }]));
  }
});

// ================================================================
// ---- CL偏芯（applyCLEccentricityWithUndo。段階(e)・2026-09-26）----
// fixtureはT8の型（graph.addWall直書き。Room/edge一式は組まない）。applyFnの偽物は
// graph.clEccentricities.get(id)?.value ?? 0 を対象壁のbackingOffsetへ直接書く
// （実際のfinish/clEccentricity.js applyCLEccentricityと同じ「backingOffsetが変わる」効果だけを
// 軽量に再現する）。propagateFnの偽物は既定で no-op（他階連動なし）にし、連動が必要なテストだけ
// 個別に差し替える。listenerはfinallyでnullに戻す。
// ================================================================

// x0-x1間、y=2000のHORIZONTAL中心線に対称壁（backingDepth:120）を1本張る最小fixture。
// project.activeGraphを持つ本物のProjectを使う（applyCLEccentricityWithUndoはpropagateFnを常に
// awaitするため、8.の「await中に階が切り替わったか」ガード（graph !== project.activeGraph）が
// 毎回評価される——project:{}のような偽物だとproject.activeGraphがundefinedになり常に「切り替わった」
// 扱いになってしまう。deleteCenterLineWithUndo等の従来テストがproject:{}を使えていたのは、それらの
// M-2ガードがawaitを伴う経路でしか評価されないため）。
function makeEccGraph() {
  const { project, graph } = makeProjectWithGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  return { project, graph, centerCL };
}

// 実際のfinish/clEccentricity.js applyCLEccentricityの代わりに使う軽量スタブ。
function stubApplyFn(graph, clId) {
  const value = graph.clEccentricities.get(clId)?.value ?? 0;
  for (const w of graph.walls) if (w.axisCL.id === clId) w.backingOffset = value;
  return [];
}

const noopPropagateFn = async () => {};

test('applyCLEccentricityWithUndo: 中心線の偏芯確定は構造同期リスナーを(graph, project, "activeAndAbove")で呼ぶ（確定1回・undo1回・redo1回＝計3回。ECC-1）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const centerCLId = centerCL.id;
  const rec = { mode: 'value', value: 300 };

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await applyCLEccentricityWithUndo(graph, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
    assert.equal(toast, null);
    assert.equal(calls.length, 1, '確定直後に1回呼ばれるはず');
    assert.equal(calls[0].g, graph);
    assert.equal(calls[0].p, project);
    assert.equal(calls[0].scope, 'activeAndAbove');
    assert.equal(graph.clEccentricities.get(centerCLId).value, 300);
    assert.equal(graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset, 300);

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoでも1回呼ばれるはず');
    assert.equal(graph.clEccentricities.has(centerCLId), false, 'undoでレコードが消える');
    assert.equal(graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset, 0);

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoでも1回呼ばれるはず');
    assert.equal(graph.clEccentricities.get(centerCLId).value, 300);
    assert.equal(graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset, 300);
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('applyCLEccentricityWithUndo: 中心線の偏芯確定はコミット時のnotifyだけ第4引数(undoRecords)に配列を渡し、undo/redo時のnotifyはundefined（段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const rec = { mode: 'value', value: 300 };

  const received = [];
  setCenterLineStructuralListener((g, p, scope, undoRecords) => received.push(undoRecords));
  try {
    const { toast } = await applyCLEccentricityWithUndo(graph, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
    assert.equal(toast, null);
    assert.ok(Array.isArray(received[0]), 'コミット時notifyの第4引数は配列のはず');

    undoManager.undo();
    assert.equal(received[1], undefined, 'undo時notifyの第4引数はundefinedのはず');
    undoManager.redo();
    assert.equal(received[2], undefined, 'redo時notifyの第4引数はundefinedのはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('applyCLEccentricityWithUndo: undoでは箱(floorRecords)のbefore保存がnotifyより前に実行される（順序スパイ・段階(g)・QA指摘M-1・2026-09-26）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const rec = { mode: 'value', value: 300 };

  const order = [];
  const saveFloorFn = async (planeId, bytes) => { order.push(`save:${planeId}:${bytes}`); };
  setCenterLineStructuralListener((g, p, scope, undoRecords) => {
    if (undoRecords) undoRecords.push({ planeId: 'f1', before: 'b0', after: 'a1' });
    order.push('notify');
  });
  try {
    const { toast } = await applyCLEccentricityWithUndo(graph, project, centerCL, { rec, materialMap: undefined, saveFloorFn, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
    assert.equal(toast, null);
    assert.deepEqual(order, ['notify'], 'コミット時は記録するだけで保存はしない');

    order.length = 0;
    undoManager.undo();
    assert.deepEqual(order, ['save:f1:b0', 'notify'], 'undoではbefore保存がnotifyより前のはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('applyCLEccentricityWithUndo: 通り芯の偏芯確定は構造同期リスナーを(graph, project, "all")で呼ぶ（ECC-1b）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const structCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addWall(structCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const rec = { mode: 'value', value: 300 };

  const calls = [];
  setCenterLineStructuralListener((g, p, scope) => calls.push({ g, p, scope }));
  try {
    const { toast } = await applyCLEccentricityWithUndo(graph, project, structCL, { rec, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
    assert.equal(toast, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'all');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('applyCLEccentricityWithUndo: propagateFnが他階へ記録を1件積めば、中心線でもscopeが"all"へ引き上がる（確定・undo・redo。記録0件のときは"activeAndAbove"のまま。QA指摘m-1）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const x0 = p1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = p1.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = p1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  p1.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const rec = { mode: 'value', value: 300 };

  // 記録0件（他階連動なし）: scopeはcenterの種別ポリシーどおり"activeAndAbove"のまま。
  const scopesNoRecord = [];
  setCenterLineStructuralListener((g, p, scope) => scopesNoRecord.push(scope));
  try {
    const { toast } = await applyCLEccentricityWithUndo(p1, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
    assert.equal(toast, null);
    assert.deepEqual(scopesNoRecord, ['activeAndAbove'], '記録0件では引き上げない');
    undoManager.undo();
  } finally {
    setCenterLineStructuralListener(null);
  }

  // 記録1件（他階連動あり）: scopeが"all"へ引き上がる（確定・undo・redoの3回とも）。
  const beforeP2 = serializeGraph(p2);
  const saveFloorFn = async (planeId, bytes) => { if (planeId === p2.plane.id) restoreGraph(p2, bytes); };
  const propagateFn = async (proj, g, clIds, { undoRecords, saveFloorFn: sf }) => {
    const after = serializeGraph(p2); // 他階で何か変更が起きたことにする最低限のスタブ
    await sf(p2.plane.id, after);
    if (undoRecords) undoRecords.push({ planeId: p2.plane.id, before: beforeP2, after });
  };
  const scopesWithRecord = [];
  setCenterLineStructuralListener((g, p, scope) => scopesWithRecord.push(scope));
  try {
    const { toast } = await applyCLEccentricityWithUndo(p1, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn, saveFloorFn });
    assert.equal(toast, null);
    assert.deepEqual(scopesWithRecord, ['all'], '確定: 記録1件で"all"へ引き上がる');

    undoManager.undo();
    assert.deepEqual(scopesWithRecord, ['all', 'all'], 'undo: 引き続き"all"');

    undoManager.redo();
    assert.deepEqual(scopesWithRecord, ['all', 'all', 'all'], 'redo: 引き続き"all"');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('applyCLEccentricityWithUndo: 壁由来梁芯が下地帯中心の移動分だけ同idで追従し除外キーも張り替わる。undoで値・キー・レコードが戻る（ECC-2）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const centerCLId = centerCL.id;
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  graph.excludedWallBeamAxes.add('Y:2000');
  const rec = { mode: 'value', value: 300 };

  const { toast } = await applyCLEccentricityWithUndo(graph, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
  assert.equal(toast, null);
  const axAfter = graph.shapeMap.get(beamAxisId);
  assert.equal(axAfter.value, 2300, '壁の下地帯中心の移動分だけ梁芯も追従するはず');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2000'), false, '旧キーは張り替えで消える');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2300'), true, '新キーへ張り替わる');
  assert.equal(graph.clEccentricities.get(centerCLId).value, 300);

  undoManager.undo();
  const axRestored = graph.shapeMap.get(beamAxisId);
  assert.equal(axRestored.value, 2000, 'undoで梁芯も戻る');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2000'), true, 'undoで除外キーも戻る');
  assert.equal(graph.excludedWallBeamAxes.has('Y:2300'), false);
  assert.equal(graph.clEccentricities.has(centerCLId), false, 'undoでレコードも消える');
});

test('applyCLEccentricityWithUndo: 解除（rec:null）でレコードが消え、undoで戻る（ECC-3）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const centerCLId = centerCL.id;
  graph.setCLEccentricity(centerCLId, { mode: 'value', value: 300 });
  graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset = 300; // stubApplyFn適用結果を模した前提状態

  const { toast } = await applyCLEccentricityWithUndo(graph, project, centerCL, { rec: null, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
  assert.equal(toast, null);
  assert.equal(graph.clEccentricities.has(centerCLId), false, '解除でレコードが消える');
  assert.equal(graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset, 0, 'stubApplyFnがvalue未設定(0)で書き戻す');

  undoManager.undo();
  assert.equal(graph.clEccentricities.get(centerCLId).value, 300, 'undoでレコードが戻る');
  assert.equal(graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset, 300);
});

test('【案B】applyCLEccentricityWithUndo: 通り芯上での偏芯解除は壁由来梁芯の追従先に相手がいても保護されなければ吸収して撤去し、例外なく完了する（相手の通り芯は残る）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const centerCLId = centerCL.id;
  graph.setCLEccentricity(centerCLId, { mode: 'value', value: 300 });
  graph.walls.find(w => w.axisCL.id === centerCLId).backingOffset = 300; // 偏芯適用済み（下地帯中心=2300）を模す
  const beamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2300, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  const gridCLId = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT }).id; // 解除後の戻り先(2000)に既存の通り芯

  const { toast } = await applyCLEccentricityWithUndo(graph, project, centerCL, { rec: null, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
  assert.equal(toast, null, '吸収されても例外は起きず、解除自体は成功する');
  assert.equal(graph.clEccentricities.has(centerCLId), false);
  assert.equal(graph.shapeMap.has(beamAxisId), false, '保護されない梁芯は吸収されて撤去される（案B。裁定1は解消）');
  assert.equal(graph.shapeMap.get(gridCLId)?.value, 2000, '移動先の通り芯（相手）はそのまま残る');
});

test('【案B】applyCLEccentricityWithUndo: 適用→（下階に同座標の壁がありその間に梁芯が作り直された状態を模す）→解除の往復で孤児0本になる（裁定1・案Aで残っていた限界の解消）', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const originalBeamAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const originalBeamAxisId = originalBeamAxis.id;

  // 適用: 下地帯中心が2000→2300へ動き、既存の梁芯（originalBeamAxis）が同idで追従する。
  const { toast: applyToast } = await applyCLEccentricityWithUndo(
    graph, project, centerCL, { rec: { mode: 'value', value: 300 }, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
  assert.equal(applyToast, null);
  assert.equal(graph.shapeMap.get(originalBeamAxisId)?.value, 2300, '前提: 追従で新座標へ移った');

  // 下階スタブ: 「下階に同座標(2000)の壁があり、その間の構造同期が旧座標に壁由来梁芯を作り直した」
  // 状態を模す（実運用ではwallBeamAxes.jsのselfAndBelow経由で自動生成される。ここでは直接1本置く）。
  const recreatedStubId = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null }).id;

  // 解除: 下地帯中心が2300→2000へ戻る。追従元（2300。originalBeamAxis）から見て、追従先(2000)には
  // 既にスタブ（相手）がいる——移動する側（originalBeamAxis）は保護されないため吸収されて撤去され、
  // 相手（recreatedStub。既にその座標の壁の根拠を持つ）はそのまま残る（判定の仕様どおり）。
  // 結果として梁芯は1本だけ（孤児0本）——案Aでは「追従が重複ガードでskipされ、originalBeamAxisが
  // 2300に孤児として残る」限界があったが、案Bではその限界が解消される。
  const { toast: undoToast } = await applyCLEccentricityWithUndo(
    graph, project, centerCL, { rec: null, applyFn: stubApplyFn, propagateFn: noopPropagateFn });
  assert.equal(undoToast, null);

  const remainingBeamAxes = graph.centerLines.filter(cl => cl.discipline === Discipline.FUSE);
  assert.equal(remainingBeamAxes.length, 1, '梁芯は1本だけ残る（孤児0本）');
  assert.equal(remainingBeamAxes[0].id, recreatedStubId, '生き残るのは相手（下階スタブ由来の作り直し梁芯。その座標の根拠を既に持つ）');
  assert.equal(remainingBeamAxes[0].value, 2000, '値は旧座標(2000)のまま');
  assert.equal(graph.shapeMap.has(originalBeamAxisId), false, '追従元（元の梁芯）は保護されないため吸収されて消える');
});

test('【順序が最重要】applyCLEccentricityWithUndo: 他階への連動（save）が構造同期（sync）より必ず先に実行される（確定・undo・redo。ECC-順序）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const x0 = p1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = p1.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = p1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  p1.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const rec = { mode: 'value', value: 300 };

  const log = [];
  const beforeP2 = serializeGraph(p2);
  const saveFloorFn = async (planeId, bytes) => { log.push(`save:${planeId}`); if (planeId === p2.plane.id) restoreGraph(p2, bytes); };
  const propagateFn = async (proj, g, clIds, { undoRecords, saveFloorFn: sf }) => {
    const after = serializeGraph(p2); // 何らかの変更を他階へ保存したことにする最低限のスタブ
    await sf(p2.plane.id, after);
    if (undoRecords) undoRecords.push({ planeId: p2.plane.id, before: beforeP2, after });
  };
  setCenterLineStructuralListener(() => { log.push('sync'); });
  try {
    const { toast } = await applyCLEccentricityWithUndo(p1, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn, saveFloorFn });
    assert.equal(toast, null);
    assert.deepEqual(log, [`save:${p2.plane.id}`, 'sync'], '確定: saveがsyncより先');

    log.length = 0;
    undoManager.undo();
    assert.deepEqual(log, [`save:${p2.plane.id}`, 'sync'], 'undo: saveがsyncより先');

    log.length = 0;
    undoManager.redo();
    assert.deepEqual(log, [`save:${p2.plane.id}`, 'sync'], 'redo: saveがsyncより先');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系1】applyCLEccentricityWithUndo: propagateFnが1階保存後にthrowしたらreject・その階にbeforeが書き戻され自階もbeforeと一致・undo未増加・listener0回', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const x0 = p1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = p1.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = p1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = p1.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const centerCLId = centerCL.id;
  const wallId = wall.id;
  const rec = { mode: 'value', value: 300 };

  const beforeP2 = serializeGraph(p2);
  const saveFloorFn = async (planeId, bytes) => { if (planeId === p2.plane.id) restoreGraph(p2, bytes); };
  const propagateFn = async (proj, g, clIds, { undoRecords, saveFloorFn: sf }) => {
    const after = serializeGraph(p2);
    await sf(p2.plane.id, after);
    if (undoRecords) undoRecords.push({ planeId: p2.plane.id, before: beforeP2, after });
    throw new Error('propagate boom');
  };

  const beforeTop = undoManager.peekUndo();
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    await assert.rejects(
      () => applyCLEccentricityWithUndo(p1, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn, saveFloorFn }),
      /propagate boom/,
    );
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
    assert.equal(listenerCalls, 0, '構造同期リスナーは呼ばれない');
    assert.equal(p1.clEccentricities.has(centerCLId), false, '自階のレコードも巻き戻る');
    assert.equal(p1.shapeMap.get(wallId).backingOffset, 0, '自階の壁backingOffsetも巻き戻る');
  } finally {
    setCenterLineStructuralListener(null);
  }
});

test('【失敗系2】applyCLEccentricityWithUndo: 構造同期リスナー未設定（null）でも例外なく確定・undoできる', async () => {
  const { project, graph, centerCL } = makeEccGraph();
  const rec = { mode: 'value', value: 300 };
  await assert.doesNotReject(() => applyCLEccentricityWithUndo(graph, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn: noopPropagateFn }));
  assert.doesNotThrow(() => undoManager.undo());
});

test('【失敗系3】applyCLEccentricityWithUndo: propagateFn内でactivePlaneIdが切り替わったらundo未積み・notify0・自階はsaveFloorFnでbeforeが書き戻される', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const x0 = p1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = p1.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = p1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  p1.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const rec = { mode: 'value', value: 300 };

  const saveCalls = [];
  const saveFloorFn = async (planeId) => { saveCalls.push(planeId); };
  const propagateFn = async (proj) => {
    proj.activePlaneId = p2.plane.id; // awaitの後にアクティブ階が切り替わった状況を模す（M-2と同型）
  };

  const beforeTop = undoManager.peekUndo();
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    const { toast } = await applyCLEccentricityWithUndo(p1, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn, saveFloorFn });
    assert.equal(toast, null);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
    assert.equal(listenerCalls, 0, '構造同期リスナーは呼ばれない');
    assert.ok(saveCalls.includes(p1.plane.id), '自階はsaveFloorFnでbeforeが書き戻されるはず（もうアクティブでないため）');
  } finally {
    setCenterLineStructuralListener(null);
    project.activePlaneId = p1.plane.id;
  }
});

test('【失敗系4】applyCLEccentricityWithUndo: 呼び出し時点で既にgraphがproject.activeGraphでなければ、何も書き換えずtoast:nullで即戻る（whenIdle待ちの間に階が切り替わった場合。QA指摘m-2）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const x0 = p1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = p1.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const centerCL = p1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = p1.addWall(centerCL, 0, false, x0, 0, x1, 0, { isExteriorWall: false, backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const centerCLId = centerCL.id;
  const wallId = wall.id;
  const rec = { mode: 'value', value: 300 };

  project.activePlaneId = p2.plane.id; // 呼び出し前（App.jsxのwhenIdle待ちの間）に既に切り替わっていた状況を模す
  let propagateFnCalled = false;
  const propagateFn = async () => { propagateFnCalled = true; };

  const beforeTop = undoManager.peekUndo();
  let listenerCalls = 0;
  setCenterLineStructuralListener(() => { listenerCalls++; });
  try {
    const { toast } = await applyCLEccentricityWithUndo(p1, project, centerCL, { rec, applyFn: stubApplyFn, propagateFn });
    assert.equal(toast, null);
    assert.equal(propagateFnCalled, false, 'propagateFnにすら到達せず即戻るはず（手順3より前のガードのため）');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
    assert.equal(listenerCalls, 0, '構造同期リスナーは呼ばれない');
    assert.equal(p1.clEccentricities.has(centerCLId), false, '偏芯レコードは一切書き換わらない');
    assert.equal(p1.shapeMap.get(wallId).backingOffset, 0, '壁のbackingOffsetも一切書き換わらない');
  } finally {
    setCenterLineStructuralListener(null);
    project.activePlaneId = p1.plane.id;
  }
});
