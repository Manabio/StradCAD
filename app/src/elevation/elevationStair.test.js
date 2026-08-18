// elevationStair.js の基本挙動テスト（.claude/elevation-model.md §3.3 I6 / §11）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { rotateFacesToStart, stairStartFaceLabel, buildStairBand } from './elevationStair.js';
import { layoutBands, bandContentOriginMm } from './elevationLayout.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { BAND_GAP_MM, BAND_TOP_MARGIN_MM } from './elevationStyle.js';

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

// ---- 面間ギャップは壁中心線(faceBoundaryLocalX)同士がgapModelMmになるよう配置する（ユーザー仕様。
// elevationBand.test.jsの同名テストの階段帯版。buildStairBandもlayoutBandFacesを共有するため
// 同じ配置規則になるはず） ----
test('buildStairBand: 隣接面は壁中心線同士がctx.gapModelMmだけ離れて配置される', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  // CH_DIM_OFFSET_MM(=500)等の描画定数と同値だと、ギャップ項と定数項の取り違えを検知できない
  // （elevationBand.test.jsの同名テストが奇数値321を使うのと同じ理由）。非丸めの値にする。
  const gapModelMm = 437;

  const band = buildStairBand(room, graph, null, { gapModelMm });
  const faces = buildRoomFaces(room, graph);
  // 面端(両端)の縦線から各面のローカルx範囲(帯内座標)を復元する（elevationBand.test.jsと同じ
  // CUT/SILHOUETTE(太・中線)の縦線で拾う方針）。
  const endVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && (p.weight === 'thick' || p.weight === 'medium'));
  const xs = [...new Set(endVerticals.map(p => p.x1))].sort((a, b) => a - b);
  assert.equal(xs[0], 0, '先頭面の左端は0');

  const boundary0 = faceBoundaryLocalX(faces[0], graph);
  const boundary1 = faceBoundaryLocalX(faces[1], graph);
  const xCursor1 = xs[2]; // 面1のローカルx=0が帯内で来る位置
  const face0HiAbs = boundary0.hi;         // 面0の壁中心線(hi)の帯内絶対x（面0のxCursorは0）
  const face1LoAbs = xCursor1 + boundary1.lo; // 面1の壁中心線(lo)の帯内絶対x
  assert.ok(Math.abs(face1LoAbs - (face0HiAbs + gapModelMm)) < 1e-6,
    `面1の壁中心線(lo=${face1LoAbs})は面0の壁中心線(hi=${face0HiAbs})+gapModelMm(${gapModelMm})のはず`);
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

// ---- 調整項目6: 階段帯でもroom.floorLevel（FL高さ）が床線の見た目位置に反映される ----
test('【調整項目6】buildStairBand: room.floorLevel（FL高さ）が床線の見た目位置(bounds.minYからの相対y)に反映される', () => {
  const graphA = makeGraph('p1');
  const roomA = makeRectRoom(graphA, 0, 0, 2000, 4000, '階段A');
  const graphB = makeGraph('p1');
  const roomB = makeRectRoom(graphB, 0, 0, 2000, 4000, '階段B');
  roomB.setFloorLevel(150);

  const bandA = buildStairBand(roomA, graphA, null);
  const bandB = buildStairBand(roomB, graphB, null);

  const floorY = (band) => {
    const cutHorizontals = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2);
    return Math.max(...cutHorizontals.map(p => p.y1));
  };
  const relA = floorY(bandA) - bandA.bounds.minY;
  const relB = floorY(bandB) - bandB.bounds.minY;
  assert.ok(Math.abs((relA - relB) - 150) < 1e-6,
    `FLが150mm高い階段部屋(B)は床線が150mm上に見えるはず（相対位置差: ${relA - relB}）`);
});

// ---- QA A2/B2: 階段帯でもfloorLevel差がBAND_GAP_MMを超える2帯で実描画範囲が重ならない ----
// elevationBand.test.jsと同じ理由・同じ3ケース構成（elevationBand.test.jsのコメント参照）。
function realGap(originUpper, rangeUpper, originLower, rangeLower) {
  return (originLower + rangeLower.minY) - (originUpper + rangeUpper.maxY);
}

test('【QA A2/B2】buildStairBand+layoutBands: floorLevel差がBAND_GAP_MM(600)を超える2帯でも実描画範囲は重ならず、すき間はちょうど750mmになる', () => {
  const graphA = makeGraph('p1');
  const roomA = makeRectRoom(graphA, 0, 0, 2000, 4000, '階段A');
  const graphB = makeGraph('p1');
  const roomB = makeRectRoom(graphB, 0, 0, 2000, 4000, '階段B');
  roomB.setFloorLevel(700); // Bが上へせり出す方向

  const bandA = buildStairBand(roomA, graphA, null);
  const bandB = buildStairBand(roomB, graphB, null);
  const layout = layoutBands([bandA, bandB]);

  const originA = bandContentOriginMm(layout.placements[0], bandA);
  const originB = bandContentOriginMm(layout.placements[1], bandB);
  const rangeA = figureBounds(bandA.primitives);
  const rangeB = figureBounds(bandB.primitives);
  const gap = realGap(originA, rangeA, originB, rangeB);

  assert.ok(Math.abs(gap - (BAND_GAP_MM + BAND_TOP_MARGIN_MM)) < 1e-6,
    `Bが上へせり出す方向(floorLevel=+700)では実すき間はちょうど${BAND_GAP_MM + BAND_TOP_MARGIN_MM}mmに固定されるはず（実際:${gap}）`);
});

// ---- QA B2: 「下へせり出す」方向はAとの実すき間を無駄に固定せず自然な間隔にする ----
test('【QA B2】buildStairBand+layoutBands: floorLevel=-700（Bが下へせり出す）では、Aとの実すき間は無駄な過剰予約なしの1450mmになる', () => {
  const graphA = makeGraph('p1');
  const roomA = makeRectRoom(graphA, 0, 0, 2000, 4000, '階段A');
  const graphB = makeGraph('p1');
  const roomB = makeRectRoom(graphB, 0, 0, 2000, 4000, '階段B');
  roomB.setFloorLevel(-700);

  const bandA = buildStairBand(roomA, graphA, null);
  const bandB = buildStairBand(roomB, graphB, null);
  const layout = layoutBands([bandA, bandB]);

  const originA = bandContentOriginMm(layout.placements[0], bandA);
  const originB = bandContentOriginMm(layout.placements[1], bandB);
  const rangeA = figureBounds(bandA.primitives);
  const rangeB = figureBounds(bandB.primitives);
  const gap = realGap(originA, rangeA, originB, rangeB);
  const expected = BAND_GAP_MM + BAND_TOP_MARGIN_MM + 700;

  assert.ok(Math.abs(gap - expected) < 1e-6,
    `Bが下へせり出す方向(floorLevel=-700)ではA-B間は無駄な余白を含まない自然な間隔(${expected}mm)になるはず（実際:${gap}）`);
});

// ---- QA B2: 「下へせり出す」方向で本来守るべきなのは"次"の帯(C)とのすき間。ちょうど750mmになる ----
test('【QA B2】buildStairBand+layoutBands: floorLevel=-700（Bが下へせり出す）でも、次の帯(C)との実すき間はちょうど750mmを維持する', () => {
  const graphB = makeGraph('p1');
  const roomB = makeRectRoom(graphB, 0, 0, 2000, 4000, '階段B');
  roomB.setFloorLevel(-700);
  const graphC = makeGraph('p1');
  const roomC = makeRectRoom(graphC, 0, 0, 2000, 4000, '階段C');

  const bandB = buildStairBand(roomB, graphB, null);
  const bandC = buildStairBand(roomC, graphC, null);
  const layout = layoutBands([bandB, bandC]);

  const originB = bandContentOriginMm(layout.placements[0], bandB);
  const originC = bandContentOriginMm(layout.placements[1], bandC);
  const rangeB = figureBounds(bandB.primitives);
  const rangeC = figureBounds(bandC.primitives);
  const gap = realGap(originB, rangeB, originC, rangeC);

  assert.ok(Math.abs(gap - (BAND_GAP_MM + BAND_TOP_MARGIN_MM)) < 1e-6,
    `Bが下へせり出す方向(floorLevel=-700)ではB-C間の実すき間がちょうど${BAND_GAP_MM + BAND_TOP_MARGIN_MM}mmに固定されるはず（実際:${gap}）`);
});
