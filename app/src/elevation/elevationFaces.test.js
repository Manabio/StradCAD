// buildRoomFaces / openingsOnFace の不変条件テスト（.claude/elevation-model.md §3.3 I1〜I5）。
// 実 core.js（Plane/PlanGraph）+ 実 finish/wallGeneration.js で壁を生成し、実際の仕上げ面位置を使う
// （openingRoomLabel.test.js と同じ方針。ダックタイピングでは面座標の実挙動を再現できない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces, openingsOnFace } from './elevationFaces.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addCL(graph, type, value) {
  return graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}

// 矩形部屋（x0..x1, y0..y1）を1セルで作り、外周壁を自動生成する。
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = addCL(graph, CenterLineType.VERTICAL, x0v);
  const x1 = addCL(graph, CenterLineType.VERTICAL, x1v);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, y0v);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, y1v);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return { room, x0, x1, y0, y1 };
}

// ---- I1: 矩形部屋で ['A','B','C','D'] 順・12/3/6/9時に対応 ----
test('buildRoomFaces: 矩形部屋はA(上/北)→B(右/東)→C(下/南)→D(左/西)の順で並ぶ', () => {
  const graph = makeGraph();
  const { room } = makeRectRoom(graph, 0, 0, 4000, 3000);

  const faces = buildRoomFaces(room, graph);
  assert.deepEqual(faces.map(f => f.label), ['A', 'B', 'C', 'D']);
  assert.equal(faces[0].isVertical, false, 'A(上端)は水平壁');
  assert.equal(faces[1].isVertical, true,  'B(右端)は垂直壁');
  assert.equal(faces[2].isVertical, false, 'C(下端)は水平壁');
  assert.equal(faces[3].isVertical, true,  'D(左端)は垂直壁');
  // A(上)の面座標(y)はC(下)の面座標より小さい、B(右)の面座標(x)はD(左)より大きい
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));
  assert.ok(byLabel.A.faceValue < byLabel.C.faceValue, 'Aの面はCの面より上(y小)');
  assert.ok(byLabel.B.faceValue > byLabel.D.faceValue, 'Bの面はDの面より右(x大)');
});

// ---- I2（本命）: 隣接面の終端隅＝次面の始端隅が世界座標で一致 ----
function worldAt(face, localAlong) {
  const along = face.originWorld + face.dirSign * localAlong;
  return face.isVertical ? { x: face.faceValue, y: along } : { x: along, y: face.faceValue };
}
function endCorner(face)   { return worldAt(face, face.run); }
function startCorner(face) { return worldAt(face, 0); }

function assertCornersMatch(faces, label) {
  for (let i = 0; i < faces.length; i++) {
    const cur  = faces[i];
    const next = faces[(i + 1) % faces.length];
    const e = endCorner(cur), s = startCorner(next);
    assert.ok(Math.abs(e.x - s.x) < 1e-6 && Math.abs(e.y - s.y) < 1e-6,
      `${label}: ${cur.label}の終端(${e.x},${e.y})と${next.label}の始端(${s.x},${s.y})が一致しない`);
  }
}

test('buildRoomFaces: 矩形部屋の隣接面の隅が世界座標で一致する', () => {
  const graph = makeGraph();
  const { room } = makeRectRoom(graph, 0, 0, 4000, 3000);
  assertCornersMatch(buildRoomFaces(room, graph), '矩形');
});

test('buildRoomFaces: L字部屋の隣接面の隅が世界座標で一致する', () => {
  const graph = makeGraph();
  // L字: 大矩形(0,0)-(6000,4000)から右上(3000,0)-(6000,2000)の角を欠いた形。
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 3000);
  const x2 = addCL(graph, CenterLineType.VERTICAL, 6000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 4000);
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y2.id}`, // 左列全体
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`, // 右下
  ]);
  const room = graph.addRoom(cells, 'L字室');
  generateRoomWallsFromOutline(graph, room);

  assertCornersMatch(buildRoomFaces(room, graph), 'L字');
});

// ---- I3: 対向2面の run の和 < 芯々寸法×2（faceValueでなくeffectiveValueを使うと赤） ----
test('buildRoomFaces: 対向2面のrunの和は芯々寸法×2より小さい（壁厚ぶん有効長が短くなる）', () => {
  const graph = makeGraph();
  const { room, x0, x1, y0, y1 } = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  const byLabel = Object.fromEntries(faces.map(f => [f.label, f]));

  const spanX = x1.effectiveValue - x0.effectiveValue;
  const spanY = y1.effectiveValue - y0.effectiveValue;
  assert.ok(byLabel.A.run + byLabel.C.run < 2 * spanX, 'A+Cのrun和はX芯々寸法×2未満');
  assert.ok(byLabel.B.run + byLabel.D.run < 2 * spanY, 'B+Dのrun和はY芯々寸法×2未満');
});

// ---- I4: L字で同letter2本・label B1/B2（群内ソート順） ----
test('buildRoomFaces: L字部屋は同letterが複数面に分かれB1/B2のラベルが付く', () => {
  const graph = makeGraph();
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 3000);
  const x2 = addCL(graph, CenterLineType.VERTICAL, 6000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 4000);
  const cells = new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y2.id}`,
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`,
  ]);
  const room = graph.addRoom(cells, 'L字室');
  generateRoomWallsFromOutline(graph, room);

  const faces = buildRoomFaces(room, graph);
  const bFaces = faces.filter(f => f.letter === 'B');
  assert.equal(bFaces.length, 2, 'B(右向き)の壁は2面に分かれる');
  assert.deepEqual(bFaces.map(f => f.label), ['B1', 'B2']);
  // B群はy昇順（dirSign=+1）
  assert.ok(bFaces[0].lo < bFaces[1].lo, 'B1はB2より上(y小)側');
});

// ---- I5: 開口が対向2面に二重に出ない（wallSide符号判定を外すと赤） ----
test('openingsOnFace: 隣接2部屋が共有する壁の開口は片方の面にしか出ない', () => {
  const graph = makeGraph();
  // 上室(0,0)-(4000,2000) と 下室(0,2000)-(4000,5000) が y=2000 のCLを共有する。
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);

  const upperKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const upperRoom = graph.addRoom(new Set([upperKey]), '上室');
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, upperRoom);
  generateRoomWallsFromOutline(graph, lowerRoom);

  // 共有CL(yMid)の上室側(下端=C, wallSide=-1)に開口を1つ置く。
  const opening = graph.addOpening(yMid, -1, false, x0, 1500, 900, OpeningCategory.FITTING, 'singleSwing', {});

  const upperFaces = buildRoomFaces(upperRoom, graph);
  const lowerFaces = buildRoomFaces(lowerRoom, graph);
  const upperC = upperFaces.find(f => f.letter === 'C');
  const lowerA = lowerFaces.find(f => f.letter === 'A');
  assert.ok(upperC && lowerA, '前提: 共有壁は上室C面・下室A面として存在する');

  assert.equal(openingsOnFace(upperC, graph).length, 1, '上室C面にはこの開口が乗る');
  assert.equal(openingsOnFace(lowerA, graph).length, 0, '下室A面には乗らない（wallSideが逆）');
  assert.equal(openingsOnFace(upperC, graph)[0].id, opening.id);
});

// ---- QA F4テスト4: wallSide===0 の開口は対向2面の両方に出る（CL偏芯の仕上げ面合わせ等） ----
test('【QA】openingsOnFace: wallSide===0の開口は共有壁の両側の面に出る', () => {
  const graph = makeGraph();
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);

  const upperKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const upperRoom = graph.addRoom(new Set([upperKey]), '上室');
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, upperRoom);
  generateRoomWallsFromOutline(graph, lowerRoom);

  const opening = graph.addOpening(yMid, 0, false, x0, 1500, 900, OpeningCategory.FITTING, 'singleSwing', {});

  const upperC = buildRoomFaces(upperRoom, graph).find(f => f.letter === 'C');
  const lowerA = buildRoomFaces(lowerRoom, graph).find(f => f.letter === 'A');

  assert.equal(openingsOnFace(upperC, graph).length, 1, '上室C面にも乗る');
  assert.equal(openingsOnFace(lowerA, graph).length, 1, '下室A面にも乗る');
  assert.equal(openingsOnFace(upperC, graph)[0].id, opening.id);
  assert.equal(openingsOnFace(lowerA, graph)[0].id, opening.id);
});

// ---- 失敗系: 部屋にセルが無い（cells空） → 面リストは空配列（例外を投げない） ----
test('【失敗系】buildRoomFaces: セルが無い部屋は空配列を返す', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(), '空室');
  assert.deepEqual(buildRoomFaces(room, graph), []);
});

// ---- 失敗系: selectElevationRooms は STAIR_VOID/VOID/UNDEFINED/屋外/無名を除外する ----
test('【失敗系】selectElevationRooms: 屋外・無名・STAIR_VOID等は対象外', async () => {
  const { RoomKind, RoomFeature } = await import('@core');
  const { selectElevationRooms } = await import('./elevationFaces.js');
  const graph = makeGraph();
  const named = graph.addRoom(new Set(), 'LDK');
  const unnamed = graph.addRoom(new Set(), '');
  const exterior = graph.addRoom(new Set(), 'テラス');
  exterior.setKind(RoomKind.EXTERIOR);
  const stairVoid = graph.addRoom(new Set(), '階段吹抜け');
  stairVoid.setFeature(RoomFeature.STAIR_VOID);
  const stair = graph.addRoom(new Set(), '階段');
  stair.setFeature(RoomFeature.STAIR);

  const result = selectElevationRooms(graph);
  assert.deepEqual(result.map(r => r.id), [named.id, stair.id]);
  void unnamed;
});
