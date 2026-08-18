// 段差見付け面（stepRiserSegments/buildStepFaces/insertStepFaces）のテスト。
// 実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で壁を生成した部屋に対して検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import { stepRiserSegments, buildStepFaces, insertStepFaces } from './elevationStepFace.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// 3列(0-2000-4000-6000)×1行(0-3000)の部屋。右列だけ部分指定の子（FLは呼び出し側が設定）。
function makeThreeColumnRoom(graph, childFL) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const midKey   = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;
  const rightKey = `${x2.id}:${y0.id}:${x3.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, midKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return { room, x0, x1, x2, x3, y0, y1 };
}

test('stepRiserSegments: 部屋内部（壁のない境界）で子が親より高いとき、子側の外形からその境界の区間を抽出する', () => {
  const graph = makeGraph();
  const { room, x2 } = makeThreeColumnRoom(graph, 100);

  const segs = stepRiserSegments(room, graph);
  assert.equal(segs.length, 1, '内部境界1本ぶん、1区間のはず');
  const s = segs[0];
  assert.equal(s.isVertical, true, '境界は縦方向の中心線(x=4000)のはず');
  assert.equal(s.value, x2.value, '境界の位置は内部の仕切りCL(x=4000)のはず');
  assert.equal(s.highFL, 100, '自グループ(子)のFLが高い側のはず');
  assert.equal(s.lowFL, 0, '相手(親)のFLが低い側のはず');
  assert.equal(s.inward, -1, 'inwardは低い側(親=左)へ向かう符号のはず');
});

// ---- 失敗系: 子が親より低い場合は「低い側」からは生成されない（重複排除） ----
test('【失敗系】stepRiserSegments: 子が親より低いFLのときは子側からは見付け面を生成しない（親側だけが生成する）', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, -50);

  const segs = stepRiserSegments(room, graph);
  assert.equal(segs.length, 1, '低い側(子)ではなく高い側(親)グループから1区間生成されるはず');
  assert.equal(segs[0].highFL, 0, '親(左右2列合算)のFLが高い側のはず');
  assert.equal(segs[0].lowFL, -50, '子のFLが低い側のはず');
});

// ---- 失敗系: 親と子のFLが同じなら段差そのものが生じない ----
test('【失敗系】stepRiserSegments: 親と子のFLが同じなら区間は生成されない', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 0);
  assert.equal(stepRiserSegments(room, graph).length, 0);
});

test('buildStepFaces: lo/hiは両端の直交壁面のfaceValueへ詰められ、letter/dirSignは通常面と同じ規則になる', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 100);
  const wallFaces = buildRoomFaces(room, graph);
  const seg = stepRiserSegments(room, graph)[0];
  const parentFL = graph.effectiveFloorLevel(room);

  const face = buildStepFaces(seg, wallFaces, graph, parentFL);
  assert.equal(face.kind, 'step');
  assert.equal(face.letter, 'B', 'isVertical=true・inward=-1はletterOf規則でBのはず');
  assert.equal(face.dirSign, 1, 'DIR_SIGN.B===1のはず');
  // 両端(y=0とy=3000)の直交壁面(A/C)のfaceValueへ詰められる（壁厚ぶんCL値より内側になる）。
  const faceA = wallFaces.find(f => f.letter === 'A');
  const faceC = wallFaces.find(f => f.letter === 'C');
  assert.equal(face.lo, faceA.faceValue, 'lo(小さい方=y=0側)はA面のfaceValueへ詰められるはず');
  assert.equal(face.hi, faceC.faceValue, 'hi(大きい方=y=3000側)はC面のfaceValueへ詰められるはず');
  assert.equal(face.baseFloorDeltaMm, 0, '低い側(親)基準の相対値のはず');
  assert.equal(face.stepHeightMm, 100);
});

// ---- 失敗系: 対応する直交壁面が無い（CORNER_TOL_MM超）場合はCL値のままになる ----
test('【失敗系】buildStepFaces: 対応する直交壁面が見つからなければlo/hiはCL値のまま', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 100);
  const seg = stepRiserSegments(room, graph)[0];
  const parentFL = graph.effectiveFloorLevel(room);
  const face = buildStepFaces(seg, [], graph, parentFL); // wallFaces=空なので直交壁面が見つからない
  assert.equal(face.lo, seg.lo);
  assert.equal(face.hi, seg.hi);
});

test('insertStepFaces: 見付け面の始点を含む壁面の直後に挿入され、以降の同letter面は繰り下がる', () => {
  const graph = makeGraph();
  const { room } = makeThreeColumnRoom(graph, 100);
  const wallFaces = buildRoomFaces(room, graph); // A,B,C,D（矩形なので単独letter）
  const before = wallFaces.map(f => f.label);
  assert.deepEqual(before, ['A', 'B', 'C', 'D'], '前提: 段差挿入前はA/B/C/Dの4面のはず');

  const out = insertStepFaces(wallFaces, room, graph);
  assert.equal(out.length, 5, '段差見付け面が1枚増えて5面になるはず');
  const stepIdx = out.findIndex(f => f.kind === 'step');
  const bIdx = out.findIndex(f => f.label === 'B' && f.kind !== 'step');
  assert.equal(stepIdx, 1, '見付け面はA(idx0)の直後(idx1)に挿入されるはず');
  assert.equal(bIdx, 2, '既存Bはidx2へ繰り下がるはず（この時点ではまだ再採番前のためlabelはB）');
});

// ---- 失敗系: 段差が無い部屋はfacesをそのまま返す ----
test('【失敗系】insertStepFaces: 段差が無ければfacesをそのまま返す', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const faces = buildRoomFaces(room, graph);
  assert.equal(insertStepFaces(faces, room, graph), faces, '同じ配列参照がそのまま返るはず');
});
