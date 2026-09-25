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
  ERR_CL_CONVERT_DUP_DEMOTE, ERR_CL_DELETE_LAST_GRID,
} from '../error.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { calcStep } from '../renderer/clMoveMath.js';
import {
  shouldSuggestWoodStructure, commitCLMoveOp, deleteCenterLineWithUndo, addCenterLineFromDialog,
  promoteCenterToGridWithUndo, demoteGridToCenterWithUndo, setCenterLineStructuralListener,
} from './centerLineOps.js';
import { CL_KINDS, coexistenceAt } from '../core/centerLineKindPolicy.js';

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

test('deleteCenterLineWithUndo: 補助線・梁芯の削除は構造同期リスナーを呼ばない（段階(a)のピン留め継続。補助線はstructuralSyncScopeOfKindがnull=段階(d)、梁芯は専用経路のため対象外）', async () => {
  const graph = makeGraph();
  const auxCL    = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' });
  const beamCL   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.FUSE });
  const project = {};

  let calls = 0;
  setCenterLineStructuralListener(() => { calls++; });
  try {
    await deleteCenterLineWithUndo(graph, project, auxCL);
    await deleteCenterLineWithUndo(graph, project, beamCL);
    assert.equal(calls, 0, '補助線・梁芯の削除では構造同期リスナーを呼ばないはず');
  } finally {
    setCenterLineStructuralListener(null);
  }
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

test('promoteCenterToGridWithUndo: 他階の相手が梁芯のみのときはトースト文言に「梁芯」と表示される', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 梁芯のみ
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl);
    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: '2階', kind: 'beam' }]));
    assert.equal(toast, '2階 の同じ位置に梁芯があるため通り芯にできません。', 'リテラル文字列で固定（QA指摘m-1）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
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
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });  // 2階=梁芯
  g3.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });  // 3階=梁芯
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
