// wallAdjacentFloorSegments の基本挙動テスト。実 core.js（Plane/PlanGraph）+
// finish/wallGeneration.js で壁を生成した部屋に対して面を組み立てる（elevationFaces.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import { wallAdjacentFloorSegments } from './elevationFloorProfile.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// x0-xMid-x1 × y0-y1 の2セル矩形部屋（内部に中心線xMidを1本持つ）を作る。
function makeSplitRoom(graph, name = 'LDK') {
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xMid.id}:${y1.id}`;
  const rightKey = `${xMid.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, rightKey]), name);
  generateRoomWallsFromOutline(graph, room);
  return { room, x0, xMid, x1, y0, y1, leftKey, rightKey };
}

test('wallAdjacentFloorSegments: 部分指定が右半分を占めfloorLevelが異なるとき、面Aは左=0・右=段差の2区間になる', () => {
  const graph = makeGraph();
  const { room, xMid, rightKey } = makeSplitRoom(graph);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  assert.ok(faceA, '面Aが見つからない');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 2, '左(親=段差なし)・右(子=+300)の2区間になるはず');
  assert.equal(segs[0].floorDeltaMm, 0, '左区間は親自身なのでfloorDeltaMm=0のはず');
  assert.equal(segs[1].floorDeltaMm, 300, '右区間は子のfloorLevel(300)ぶんのはず');

  // 内部境界（xMid=2000）は隣接する直交壁の影響を受けないため、正確にlocalXへ変換した値になる。
  const toLocal = w => (w - faceA.originWorld) * faceA.dirSign;
  const expectedBoundary = toLocal(xMid.effectiveValue);
  assert.ok(Math.abs(segs[0].hiX - expectedBoundary) < 1e-6);
  assert.ok(Math.abs(segs[1].loX - expectedBoundary) < 1e-6);
  // 区間は面の全長(0..run)を隙間なく覆う。
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[1].hiX, faceA.run);
});

// ---- 失敗系: floorLevelが親と同じ部分指定は段差を作らない（1区間に結合される） ----
test('【失敗系】wallAdjacentFloorSegments: 部分指定のfloorLevelが親と同じなら段差にならず1区間に結合される', () => {
  const graph = makeGraph();
  const { room, rightKey } = makeSplitRoom(graph);
  graph.addRoom(new Set([rightKey]), '床材違いエリア', undefined, new Set([room.id]));
  // floorLevel未設定 = 親と同じ実効FL

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1, 'FL差が無ければ段差を作らず1区間に結合されるはず');
  assert.equal(segs[0].floorDeltaMm, 0);
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[0].hiX, faceA.run);
});

// ---- 失敗系: 部分指定が無い通常の部屋は常に1区間（floorDeltaMm:0）を返す ----
test('【失敗系】wallAdjacentFloorSegments: 部分指定が無い部屋は常に1区間（floorDeltaMm:0）を返す', () => {
  const graph = makeGraph();
  const { room } = makeSplitRoom(graph);

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1);
  assert.equal(segs[0].floorDeltaMm, 0);
});

// ---- QA指摘(a): dirSign=-1の面（C/D）でも0..runを単調・無間隙で被覆する ----
test('wallAdjacentFloorSegments: dirSign=-1の面（C）でも区間が0..runを単調・無間隙で被覆する', () => {
  const graph = makeGraph();
  const { room, rightKey } = makeSplitRoom(graph);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const faceC = buildRoomFaces(room, graph).find(f => f.label === 'C');
  assert.ok(faceC, '面Cが見つからない');
  assert.equal(faceC.dirSign, -1, '前提: 面Cはdirsign=-1のはず');
  const segs = wallAdjacentFloorSegments(faceC, room, graph);

  assert.equal(segs.length, 2, '面Cも段差で2区間に分かれるはず');
  assert.equal(segs[0].loX, 0, '先頭区間はloX=0から始まるはず');
  assert.equal(segs[segs.length - 1].hiX, faceC.run, '末尾区間はhiX=runで終わるはず');
  for (let i = 0; i + 1 < segs.length; i++) {
    assert.ok(segs[i].loX < segs[i].hiX, `区間${i}は空でないはず（loX<hiX）`);
    assert.equal(segs[i].hiX, segs[i + 1].loX, `区間${i}のhiXは次の区間のloXと一致し無間隙のはず`);
  }
});

// ---- QA指摘(b): 壁に接しない内側だけの部分指定では、その面はフラットのまま ----
test('【失敗系】wallAdjacentFloorSegments: 壁に接しない内側だけの部分指定は面Aをフラットのままにする', () => {
  const graph = makeGraph();
  // x0-x1(単一列) × y0-yMid-y1(2行)。面Aの軸はy0で、y0..yMid行だけが面Aに接する。
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const nearKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;   // 面A(y0)に接する行
  const farKey  = `${x0.id}:${yMid.id}:${x1.id}:${y1.id}`;   // 面Aに接しない奥の行
  const room = graph.addRoom(new Set([nearKey, farKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([farKey]), '奥だけの部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(300); // FL差があっても面Aには接しないため影響しないはず

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const segs = wallAdjacentFloorSegments(faceA, room, graph);

  assert.equal(segs.length, 1, '部分指定が面Aの壁際セルに含まれないためフラットのままのはず');
  assert.equal(segs[0].floorDeltaMm, 0);
  assert.equal(segs[0].loX, 0);
  assert.equal(segs[0].hiX, faceA.run);
});
