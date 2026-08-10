// centerLineOps.test.js と同じ方針: ダックタイピングでは structGraph 連携・Intersection 生成の
// 実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../core.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import { ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_ATTACHED, ERR_CL_DUPLICATE } from '../error.js';
import {
  outermostGridExtentRefs, attachedShapeExists, applyPromoteToGrid, applyDemoteToCenter,
} from './centerLineConvert.js';

// project.structGraph・graph._structGraph の連携が必要なテスト用。
function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- 昇格（中心線 → 通り芯） ----

test('applyPromoteToGrid: id不変・structGraphへ移籍・discipline/labeled反転・extentRefが全null化・直交通り芯との交点生成・壁は生き残る', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });
  const clId = cl.id;
  const wall = graph.addWall(cl, 0, true, y1, 0, y2, 0);

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.deepEqual(result, {});
  assert.equal(graph.shapeMap.has(clId), false, '階グラフから消滅');
  assert.equal(project.structGraph.shapeMap.get(clId), cl, 'structGraphへ同一idで移籍（同一オブジェクト）');
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
  assert.equal(cl.trim, false);
  assert.equal(cl.extentLoRef, null);
  assert.equal(cl.extentHiRef, null);
  assert.equal(cl.extentLo, null);
  assert.equal(cl.extentHi, null);
  assert.ok(project.structGraph.intersectionMap.has(`${clId}:${y1.id}`), 'y1との交点生成');
  assert.ok(project.structGraph.intersectionMap.has(`${clId}:${y2.id}`), 'y2との交点生成');
  assert.equal(graph.walls.includes(wall), true, '壁は削除されず生き残る');
  assert.equal(wall.axisCL, cl, '壁のaxisCLは同一オブジェクト参照のまま無傷');
});

test('applyPromoteToGrid: refIdで階内の別CLを参照する中心線を昇格すると絶対値へベイクされ、参照先が動いても追従しない（F1）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const anchor = graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, discipline: Discipline.ARCH, refId: anchor.id, refOffset: 500,
  });
  assert.equal(cl.value, 1000, '前提: refId経由でanchor.value(500)+refOffset(500)=1000を返す');

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.deepEqual(result, {});
  assert.equal(cl.refId, null, 'refIdは外れる');
  assert.equal(cl.value, 1000, '絶対値1000へベイクされる');

  anchor.value = 2000; // 参照先を動かす
  assert.equal(cl.value, 1000, '通り芯化後は参照先の移動に追従しない（ベイク済み・全階共通の座標が固定される）');
});

test('applyPromoteToGrid異常系: structGraphに同座標・同軸の通り芯が既にあればERR_CL_DUPLICATEでグラフ無変更（F2）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // 同座標の既存通り芯
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_DUPLICATE('struct'));
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフに残ったまま（変換されない）');
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
});

test('applyPromoteToGrid異常系: 直交する通り芯が2本未満ならERR_CL_CONVERT_NO_GRIDで階グラフに残る（F4）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_NO_GRID);
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフに残ったまま（変換されない）');
  assert.equal(project.structGraph.shapeMap.has(cl.id), false);
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
});

test('applyPromoteToGrid異常系: 斜線が取り付いた中心線はERR_CL_CONVERT_ATTACHEDでグラフ無変更', () => {
  const { project, graph } = makeProjectWithGraph();
  // NO_GRIDガード（F4）を通過させ、ATTACHEDガードを狙って踏むため直交通り芯を2本用意する。
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000,  { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  const pt = graph.addPoint(2000, 2000);
  graph.addDiagonalLine(ix, pt);

  assert.equal(attachedShapeExists(graph, graph, cl.id), true);

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_ATTACHED);
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフに残ったまま（変換されない）');
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
  assert.equal(project.structGraph.shapeMap.has(cl.id), false);
});

// ---- 降格（通り芯 → 中心線） ----

test('applyDemoteToCenter: 階グラフへ移籍・extentLo/HiRefが最外郭通り芯を指す・label=""・structGraph側の交点消滅', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 中間（最外郭ではない）
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const clId = cl.id;
  assert.ok(project.structGraph.intersectionMap.has(`${clId}:${y2.id}`)); // 前提: 交点が既に存在する

  const refs = outermostGridExtentRefs(graph, cl);
  assert.equal(refs.loCL, y1);
  assert.equal(refs.hiCL, y3);

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.loCL, y1);
  assert.equal(result.hiCL, y3);
  assert.equal(project.structGraph.shapeMap.has(clId), false, 'structGraphから消滅');
  assert.equal(graph.shapeMap.get(clId), cl, '階グラフへ同一idで移籍（同一オブジェクト）');
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
  assert.equal(cl.label, '');
  assert.deepEqual(cl.extentLoRef, { clId: y1.id, offset: 0 });
  assert.deepEqual(cl.extentHiRef, { clId: y3.id, offset: 0 });
  assert.equal(cl.extentLo, y1.value);
  assert.equal(cl.extentHi, y3.value);
  assert.equal(project.structGraph.intersectionMap.has(`${clId}:${y1.id}`), false, 'structGraph側の交点消滅');
  assert.equal(project.structGraph.intersectionMap.has(`${clId}:${y2.id}`), false);
  assert.equal(project.structGraph.intersectionMap.has(`${clId}:${y3.id}`), false);
});

test('applyDemoteToCenter異常系: 直交する通り芯が1本しかなければERR_CL_CONVERT_NO_GRIDでグラフ無変更', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  assert.equal(outermostGridExtentRefs(graph, cl), null);

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_NO_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(graph.shapeMap.has(cl.id), false);
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
});

test('applyDemoteToCenter異常系: 移籍先の階グラフに同座標・同軸の中心線が既にあればERR_CL_DUPLICATEでグラフ無変更（F3）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 移籍先に既存の中心線

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_DUPLICATE('center'));
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
});

test('applyDemoteToCenter異常系: アクティブ階グラフ側に斜線が取り付いていればERR_CL_CONVERT_ATTACHEDでグラフ無変更（F7・N2再修正）', () => {
  const { project, graph } = makeProjectWithGraph();
  // 斜線・円弧のShape本体・ngraphリンクは常に階グラフ側（graph._graph/shapeMap）に登録される
  // （structGraphへShapeを追加する経路は存在しない）ため、「structGraph.addDiagonalLine」という
  // 実運用に存在しない状態でこのガードを検証してはならない——正しい再現は「structGraph側の交点
  // （x1×y1）に、階グラフ（graph）から斜線を張る」形（graph.getOrCreateIntersectionはstructGraphの
  // 既存交点を再利用してgraph._graphにもノード登録する。core/planGraph.js _getOrCreateIntersection 参照）。
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const ix = graph.getOrCreateIntersection(x1, y1);
  graph.addDiagonalLine(ix, graph.addPoint(3000, 3000));

  assert.equal(attachedShapeExists(project.structGraph, graph, x1.id), true);

  const result = applyDemoteToCenter(graph, project.structGraph, x1);

  assert.equal(result.error, ERR_CL_CONVERT_ATTACHED);
  assert.equal(project.structGraph.shapeMap.has(x1.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(graph.shapeMap.has(x1.id), false);
});

test('applyDemoteToCenter: ネガティブコントロール（同構成で斜線なし）は降格が成功しloCL/hiCLが返る', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  const result = applyDemoteToCenter(graph, project.structGraph, x1);

  assert.equal(result.error, undefined);
  assert.equal(result.loCL, y1);
  assert.equal(result.hiCL, y2);
  assert.equal(graph.shapeMap.has(x1.id), true, '階グラフへ移籍される');
});

// ---- 往復 ----

test('往復: 昇格→降格でarch/中心線の状態に戻り、シリアライズ結果も整合する', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });
  const clId = cl.id;

  assert.deepEqual(applyPromoteToGrid(graph, project.structGraph, cl), {});
  const demoted = applyDemoteToCenter(graph, project.structGraph, cl);
  assert.equal(demoted.loCL, y1);
  assert.equal(demoted.hiCL, y2);

  assert.equal(graph.shapeMap.has(clId), true);
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);

  // シリアライズ→別グラフへ復元しても整合する（id・extentRef・discipline/labeledが保たれる）
  const bytesFloor  = serializeGraph(graph);
  const bytesStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const { project: project2, graph: graph2 } = makeProjectWithGraph();
  restoreStructCLs(project2.structGraph, project2.structuralInfo, bytesStruct, project2.memberGroupLedger);
  restoreGraph(graph2, bytesFloor);

  assert.equal(graph2.shapeMap.has(clId), true, '復元後も階グラフ側に存在する');
  assert.equal(project2.structGraph.shapeMap.has(clId), false, 'structGraph側には存在しない');
  const restored = graph2.shapeMap.get(clId);
  assert.equal(restored.discipline, Discipline.ARCH);
  assert.equal(restored.labeled, false);
  assert.equal(restored.extentLoRef.clId, y1.id);
  assert.equal(restored.extentHiRef.clId, y2.id);
});
