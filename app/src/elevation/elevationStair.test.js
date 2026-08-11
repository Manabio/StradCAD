// elevationStair.js の基本挙動テスト（.claude/elevation-model.md §3.3 I6 / §11）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import { rotateFacesToStart, stairStartFaceLabel, buildStairBand } from './elevationStair.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

function worldAt(face, localAlong) {
  const along = face.originWorld + face.dirSign * localAlong;
  return face.isVertical ? { x: face.faceValue, y: along } : { x: along, y: face.faceValue };
}
function endCorner(face)   { return worldAt(face, face.run); }
function startCorner(face) { return worldAt(face, 0); }
function assertCornersMatch(faces) {
  for (let i = 0; i < faces.length; i++) {
    const e = endCorner(faces[i]), s = startCorner(faces[(i + 1) % faces.length]);
    assert.ok(Math.abs(e.x - s.x) < 1e-6 && Math.abs(e.y - s.y) < 1e-6,
      `${faces[i].label}の終端(${e.x},${e.y})と次面の始端(${s.x},${s.y})が一致しない`);
  }
}

// ---- I6: 回転後も隣接隅一致（逆回りで赤） ----
test('rotateFacesToStart: どの面を先頭にしても隣接面の隅一致は保たれる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);

  for (const startLabel of ['A', 'B', 'C', 'D']) {
    const rotated = rotateFacesToStart(faces, startLabel);
    assert.equal(rotated[0].label, startLabel);
    assertCornersMatch(rotated);
  }
});

test('【mutation証跡用】rotateFacesToStart: 面の並びを逆順にすると隣接隅一致が崩れる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  const reversed = [...faces].reverse(); // dirSignの向きと矛盾する並びになる

  assert.throws(() => assertCornersMatch(reversed), /一致しない/);
});

test('rotateFacesToStart: 該当ラベルが無ければ元の配列をそのまま返す', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  assert.deepEqual(rotateFacesToStart(faces, 'Z'), faces);
});

// ---- 失敗系: セルの無い階段はstairPortEdgesが空配列 → faces[0]へフォールバック ----
test('【失敗系】stairStartFaceLabel: セルの無い階段はfaces[0]のラベルへフォールバックする', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, '階段');
  const faces = buildRoomFaces(room, graph);
  const stair = graph.addStair({ type: StairType.STRAIGHT, cells: new Set(), roomId: room.id });

  assert.equal(stairStartFaceLabel(stair, faces, graph), faces[0].label);
});

// ---- 失敗系: 上階なし（upperGraph=null）は1層のみ（上階FL線を追加しない） ----
test('【失敗系】buildStairBand: upperGraph=nullは1層のみ返し例外を投げない', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  const band = buildStairBand(room, graph, null);
  assert.equal(band.faceCount, 4);
  assert.ok(band.primitives.length > 0);
});

// ---- QA F3: buildStairBandも部屋名枠（rect+text）＋留め三角（miterTriangle）を出す ----
test('【QA F3】buildStairBand: 部屋名の枠(rect+text)と留め三角(miterTriangle)が出る（以前は階段帯だけ欠落）', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段室');
  const band = buildStairBand(room, graph, null);

  assert.ok(band.primitives.some(p => p.type === 'rect'), '部屋名の枠(rect)が無い');
  assert.ok(band.primitives.some(p => p.type === 'text' && p.text === '階段室'), '部屋名テキストが無い');
  assert.ok(band.primitives.some(p => p.type === 'miterTriangle'), '留め三角(miterTriangle)が無い');
});

// ---- 失敗系: upperGraphはあるが重なるVOID/STAIR_VOID部屋が無い場合も1層のまま ----
test('【失敗系】buildStairBand: 直上階に重なる吹抜けが無ければ上階FL線を追加しない', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 3000;

  const band = buildStairBand(room, graph, upperGraph, { project: { planes: [graph.plane, upperGraph.plane] } });
  assert.equal(band.faceCount, 4);
});

// ---- QA G5: ctx.nameGapModelMmが部屋名枠の上余白（帯の下端=bounds.maxY）に効く（階段帯も同様） ----
test('buildStairBand: ctx.nameGapModelMmを変えるとbounds.maxYがその差分だけ変わる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');

  const bandSmall = buildStairBand(room, graph, null, { nameGapModelMm: 100 });
  const bandLarge = buildStairBand(room, graph, null, { nameGapModelMm: 999 });
  assert.ok(Math.abs((bandLarge.bounds.maxY - bandSmall.bounds.maxY) - (999 - 100)) < 1e-6,
    `nameGapModelMmの差分(899)だけbounds.maxYが変わるはず（実際差:${bandLarge.bounds.maxY - bandSmall.bounds.maxY}）`);
});

// ---- 項目11: 階段帯の描画範囲は床→設置階の階高→さらに設置階上階の階高まで(縦2層分) ----
test('【項目11】buildStairBand: 上階のそのまた階高が確定していれば、両端縦線が2層分(floorHeight+upperFloorHeight)まで延び、2層目のFL線も出る', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 3000; // floorHeight = 3000
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const topPlane = new Plane('p3', 3000 + 2800, 'p3階', 1, 1); // upperFloorHeight = 2800
  const project = { planes: [graph.plane, upperGraph.plane, topPlane] };

  const band = buildStairBand(room, graph, upperGraph, { project });
  const totalStairHeight = 3000 + 2800;

  const extendedVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2 && p.y2 === -totalStairHeight);
  assert.ok(extendedVerticals.length >= 2, `両端縦線がtotalStairHeight(${totalStairHeight})まで延びていない`);

  const secondFlLines = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === -totalStairHeight);
  assert.ok(secondFlLines.length > 0, '2層目のFL線が出ていない');
});

// ---- 失敗系: 3階分の情報が無い(上階のそのまた階高が不明)場合は1層分(floorHeight)までにとどまる ----
test('【失敗系・項目11】buildStairBand: 上階のそのまた階高が不明なら2層目のFL線は出さず、両端縦線もfloorHeightまでで止まる', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 3000; // floorHeight = 3000
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const project = { planes: [graph.plane, upperGraph.plane] }; // 3階目が無い

  const band = buildStairBand(room, graph, upperGraph, { project });

  const secondFlLines = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 < -3000);
  assert.equal(secondFlLines.length, 0, '上階のそのまた階高が不明なら2層目のFL線は出ないはず');

  const extendedVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2 && p.y2 === -3000);
  assert.ok(extendedVerticals.length >= 2, '両端縦線はfloorHeight(3000)までは延びるはず（1層分）');
});

// ---- 項目12: 折返し階段(SWITCHBACK)は断面プロファイル(polyline×2)を帯に含む ----
test('【項目12】buildStairBand: SWITCHBACK階段は断面プロファイル(polyline)を含む', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set(), roomId: room.id,
    totalSteps: 12, tread: 250, riser: null, sections: [6, 1, 6],
  });

  const band = buildStairBand(room, graph, null, { floorHeight: 2400, stair });
  const polylines = band.primitives.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 2, '往路・復路2本の断面プロファイルが出るはず');
});

// ---- 失敗系: STRAIGHT階段は断面プロファイルを含まない ----
test('【失敗系・項目12】buildStairBand: STRAIGHT階段（対応スコープ外）は断面プロファイルを含まない', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  const stair = graph.addStair({
    type: StairType.STRAIGHT, cells: new Set(), roomId: room.id, totalSteps: 12, tread: 250,
  });

  const band = buildStairBand(room, graph, null, { floorHeight: 2400, stair });
  assert.equal(band.primitives.filter(p => p.type === 'polyline').length, 0);
});
