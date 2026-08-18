// ROW1寸法の分割点抽出（collectRow1SplitPoints）のテスト。
// S1（段差CL）・S2（面へ到達する直交壁）・S3（面に届く非通り芯中心線）の3源を、実core.jsの
// グラフで検証する（elevationFaces.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { collectRow1SplitPoints } from './elevationDimSplit.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRoom(graph) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// ---- S3: 面に直交し面まで届く非通り芯中心線は分割点になる ----
test('collectRow1SplitPoints: S3＝面に直交しextentが面まで届く非通り芯中心線は分割点になる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  // x=2000に、面A(y=0)まで届く縦の中心線（extent未指定=常時アクティブ）を追加。
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary });
  // 面Aのローカル原点(originWorld)は仕上げ面基準でCLのvalue(0)そのものではない（壁厚ぶんずれる）
  // ため、期待値も同じ変換式（world-originWorld）*dirSignで求める。
  const expectedX = (2000 - faceA.originWorld) * faceA.dirSign;
  assert.ok(pts.some(x => Math.abs(x - expectedX) < 1e-6), `x=2000相当の分割点が見つかるはず（実際:${pts}, 期待:${expectedX}）`);
});

// ---- 失敗系: 通り芯（labeled）は除外する（ROW2と二重になるため） ----
test('【失敗系】collectRow1SplitPoints: 通り芯（labeled）はROW2と二重になるため分割点に含めない', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });

  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary });
  assert.ok(!pts.some(x => Math.abs(x - 2000) < 1e-6), '通り芯由来の点は含まれないはず');
});

// ---- 失敗系: extentが面（axisCLの位置）まで届かない中心線は分割点にしない ----
test('【失敗系】collectRow1SplitPoints: extentが面まで届かない中心線は分割点にならない', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // extentを[1000,2000]に短縮——面A(axisCL.effectiveValue=0)には届かない。
  graph.setCenterLineExtentRef(cl, 'lo', { clId: y1000.id, offset: 0 });
  graph.setCenterLineExtentRef(cl, 'hi', { clId: y2000.id, offset: 0 });

  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary });
  assert.ok(!pts.some(x => Math.abs(x - 2000) < 1e-6), 'extentが面まで届かないため分割点にならないはず');
});

// ---- 失敗系: boundary.lo/hiちょうど（許容差内）の点は除外する ----
test('【失敗系】collectRow1SplitPoints: boundary.lo/hiとほぼ同位置の点は除外される', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  // S1: boundary.hiちょうどに段差CLの境界を置く（実際には起こりにくいが境界値テストとして）。
  const floorSegments = [
    { loX: 0, hiX: boundary.hi, floorDeltaMm: 0, hiCLId: 'dummyCL' },
    { loX: boundary.hi, hiX: faceA.run, floorDeltaMm: 100, hiCLId: null },
  ];
  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments, boundary });
  assert.ok(!pts.some(x => Math.abs(x - boundary.hi) < 1), 'boundary.hiちょうどの点は除外されるはず');
});

// ---- S1: 段差CL（floorSegments[i].hiCLIdが実在する境界）は分割点になる ----
test('collectRow1SplitPoints: S1＝段差CL（floorSegments[i].hiXでhiCLIdが実在する境界）は分割点になる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, hiCLId: 'someRealCL' },
    { loX: 2000, hiX: faceA.run, floorDeltaMm: 300, hiCLId: null },
  ];
  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments, boundary });
  assert.ok(pts.includes(2000), `hiCLIdが実在するx=2000は分割点になるはず（実際:${pts}）`);
});

// ---- 失敗系: gap-fillの境界（hiCLIdがnull）はS1の対象外 ----
test('【失敗系】collectRow1SplitPoints: hiCLIdがnull（gap-fillの境界）はS1の対象外', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, hiCLId: null },
    { loX: 2000, hiX: faceA.run, floorDeltaMm: 300, hiCLId: null },
  ];
  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments, boundary });
  assert.ok(!pts.includes(2000), 'hiCLId無しの境界はS1として拾わないはず');
});
