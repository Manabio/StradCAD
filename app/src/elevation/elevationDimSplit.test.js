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

// ---- 廃止仕様の固定（ユーザー実機指摘2026-08）: 中心線は分割点にしない ----
// 旧S3（面に届く非通り芯の中心線で寸法を割る）は撤去した——階段室「6」Bで、あるべき「2500」が
// 中心線1本で「1500+1000」へ割れる実機不良の原因だったため。中心線は壁を伴わない作図補助であり、
// 分割は実体（段差・直交壁・開放境界）と通り芯だけが担う。
test('collectRow1SplitPoints: 面に届く中心線があっても分割点にしない（旧S3の撤去）', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  // x=2000に、面A(y=0)まで届く縦の中心線（extent未指定=常時アクティブ）を追加。
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary });
  assert.equal(pts.length, 0, `中心線は分割点にならないはず（実際:${pts}）`);
});

// ---- S5: 面を貫く通り芯は分割点になる（旧ROW2＝通り芯間寸法の統合先） ----
test('collectRow1SplitPoints: S5＝呼び出し側が渡す通り芯のローカルxが分割点になる', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  const pts = collectRow1SplitPoints(faceA, graph, { boundary, gridXs: [1500, 2500] });
  assert.deepEqual(pts, [1500, 2500], '通り芯のローカルxがそのまま鎖の分割点になるはず');
});

// ---- 失敗系: 通り芯はgraph走査では拾わない（S5＝呼び出し側のgridXsだけが源） ----
test('【失敗系】collectRow1SplitPoints: gridXs未指定なら通り芯は分割点に含めない', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });

  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary });
  assert.ok(!pts.some(x => Math.abs(x - 2000) < 1e-6), 'gridXs未指定なら通り芯由来の点は出ないはず');
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

// ---- S4: 開放スパンの内部境界（spans[i].hiCLId）は分割点になる ----
// S1/S2/S3のいずれとも重ならない（graph.centerLinesを空にしてS3を、floorSegments未指定でS1を
// それぞれ無効化する）ようにして、S4だけを単独で検証する——Round Fフィクスチャでの検証は
// たまたまS3も同じ位置(中心3)を独立に検出してしまい、S4を無効化しても症状が隠れてしまうため
// （実際にこの「隠れ」を発見し、単独検証の必要性に気づいた）。
test('collectRow1SplitPoints: S4＝開放スパンの内部境界（spans[i].hiCLIdが実在する境界）は分割点になる', () => {
  const graph = makeGraph(); // 中心線を追加しないためS3は該当なし
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  const spans = [
    { loX: 0, hiX: 2000, kind: 'wall', hiCLX: 2000, hiCLId: 'someRealCL' },
    { loX: 2000, hiX: faceA.run, kind: 'open', farFloorDeltaMm: -50, hiCLX: null, hiCLId: null },
  ];
  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary, spans });
  assert.ok(pts.includes(2000), `spans[0].hiCLXのx=2000は分割点になるはず（実際:${pts}）`);
});

// ---- 失敗系: spans[i].hiCLIdがnull（面端そのもの）はS4の対象外 ----
test('【失敗系】collectRow1SplitPoints: spans[i].hiCLIdがnull（面端そのもの）はS4の対象外', () => {
  const graph = makeGraph();
  const room = makeRoom(graph);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);

  const spans = [
    { loX: 0, hiX: faceA.run, kind: 'wall', hiCLX: null, hiCLId: null },
  ];
  const pts = collectRow1SplitPoints(faceA, graph, { floorSegments: undefined, boundary, spans });
  assert.equal(pts.length, 0, '内部境界が無ければS4からの分割点は無いはず');
});

// ---- 不良修正2026-08（実機「6」B）: UI経路の中心線でも寸法は割らない ----
// 実アプリ経路（transform/centerLineOps.js の addCenterLineAt。kind='center'）で作られる
// 中心線は labeled:true（CenterLineの既定値）・discipline:ARCH になる。この生成でも分割点が
// 出ないこと＝旧S3の撤去が実データ条件でも効いていることを固定する（フィクスチャはこれまで
// 中心線を明示的に labeled:false で作っており、実アプリの既定値と食い違っていた）。
test('【不良修正】collectRow1SplitPoints: UI経路の中心線（labeled既定=true・ARCH）でも寸法を割らない', () => {
  const graph = makeGraph();
  // 通り芯（kind='struct'相当）で囲った部屋。
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { discipline: Discipline.STRUCT });
  // 中心線（kind='center'）= propsなし。実アプリと同じ既定値になる。
  const mid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {});
  assert.equal(mid.labeled, true, '前提: UI経路の中心線はlabeled:trueになる');

  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const boundary = faceBoundaryLocalX(faceA, graph);
  assert.equal(collectRow1SplitPoints(faceA, graph, { boundary }).length, 0,
    '中心線は寸法の鎖を割らない（実機「6」Bの1500+1000の原因）');
});
