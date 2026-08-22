// elevationStair.js の基本挙動テスト（.claude/elevation-model.md §3.3 I6 / §11）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { rotateFacesToStart, stairStartFaceLabel, buildStairBand } from './elevationStair.js';
import { layoutBands, bandContentOriginMm } from './elevationLayout.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { BAND_GAP_MM, BAND_TOP_MARGIN_MM, GRID_LINE_ABOVE_CH_MM } from './elevationStyle.js';

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

// ---- WP-S3（項目11の書き換え。書き換え理由: 旧仕様「上階のそのまた階高まで」を
// 「上階の天井高さ(CH_upper)まで」へ変更したため。旧「2層目のFL線」概念（さらに上の階の
// FL線）は廃止し、3階目の情報が実在しても出ないことを確認する ----
test('【WP-S3・項目11】buildStairBand: 両端縦線はfloorHeight+CH_upper（上階天井高さ）まで延び、3階目の情報があっても「2層目のFL線」は出ない', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 3000; // floorHeight = 3000
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID); // CH明示指定なし → upperGraph.defaultCeilingHeight(2400)

  const topPlane = new Plane('p3', 3000 + 2800, 'p3階', 1, 1); // 3階目の情報があっても無視されるはず
  const project = { planes: [graph.plane, upperGraph.plane, topPlane] };

  const band = buildStairBand(room, graph, upperGraph, { project });
  const chUpperAbsMm = 3000 + upperGraph.defaultCeilingHeight; // 5400

  const extendedVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2 && p.y2 === -chUpperAbsMm);
  assert.ok(extendedVerticals.length >= 2, `両端縦線がfloorHeight+CH_upper(${chUpperAbsMm})まで延びていない`);

  const flLikeLines = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 < -3000);
  assert.equal(flLikeLines.length, 0, '旧「2層目のFL線」概念は廃止——上階天井より上に水平線は出ないはず');
});

// ---- WP-S3（失敗系・項目11の書き換え。書き換え理由: 旧仕様は3階目の情報(project)が
// 無いと1層のみにとどまっていたが、新仕様のCH_upperはproject 3階目に依存しない
// （直上階Room自身の天井高さだけで解決する）ため、3階目の情報が無くても2層目まで延びる ----
test('【WP-S3・失敗系・項目11】buildStairBand: 3階目の情報(project)が無くても、上階Room自身の天井高さまで延びる（旧仕様は1層止まりだった）', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 3000; // floorHeight = 3000
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  voidRoom.setOverride('ceilingHeight', '2600'); // 明示指定（defaultCeilingHeightの2400とは異なる値）

  const project = { planes: [graph.plane, upperGraph.plane] }; // 3階目が無い

  const band = buildStairBand(room, graph, upperGraph, { project });
  const chUpperAbsMm = 3000 + 2600; // 5600（旧仕様なら3階目情報なし=1層止まり=3000までしか延びなかった）

  const extendedVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2 && p.y2 === -chUpperAbsMm);
  assert.ok(extendedVerticals.length >= 2,
    `3階目の情報が無くても両端縦線はfloorHeight+上階Room自身のCH(${chUpperAbsMm})まで延びるはず`);
  assert.equal(band.heightUnits, 2, '直上階の情報が解決できているためheightUnits=2のはず');
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

// ---- WP-S3: SWITCHBACK+直上階解決時はelevationStairSequence.jsの歩行順面シーケンス経路を使い、
// 帯上端はfloorHeight+CH_upperに達し、heightUnits=2になる ----
test('【WP-S3】buildStairBand: SWITCHBACKは歩行順面シーケンス経路を使い、帯上端≈-(floorHeight+CH_upper)・heightUnits=2', () => {
  const graph = makeGraph('p1');
  // 折返し階段の3セル構成（elevationStairSequence.test.jsと同じ形。踊り場(全幅・y:[0,1500])＋
  // 往路レーン(左列・x:[0,1000])＋復路レーン(右列・x:[1000,2000])、いずれもy:[1500,4500]）。
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 2400; // floorHeight = 2400
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4500, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID); // CH明示指定なし → upperGraph.defaultCeilingHeight

  const band = buildStairBand(room, graph, upperGraph, { stair, floorHeight: 2400 });
  const chUpperAbsMm = 2400 + upperGraph.defaultCeilingHeight; // 4800

  assert.equal(band.heightUnits, 2, '直上階が解決できているためheightUnits=2のはず');
  // 注記一点鎖線（壁中心線ROW1）の突き出し上端は「面内最高天井基準+GRID_LINE_ABOVE_CH_MM」
  // （elevation-model.md「注記一点鎖線の突き出し上端」節。既存の帯共通仕様がそのまま効く）。
  const expectedMinY = -chUpperAbsMm - GRID_LINE_ABOVE_CH_MM - BAND_TOP_MARGIN_MM;
  assert.ok(Math.abs(band.bounds.minY - expectedMinY) < 1e-6,
    `帯上端(bounds.minY)は-(floorHeight+CH_upper)-GRID_LINE_ABOVE_CH_MM-BAND_TOP_MARGIN_MM(${expectedMinY})のはず（実際:${band.bounds.minY}）`);
  // 歩行順面シーケンス経路: 断面プロファイル(踏面のジグザグ=SILHOUETTE)がpolylineとして出る。
  assert.ok(band.primitives.some(p => p.type === 'polyline'), '断面プロファイルのpolylineが出るはず');
});

// ---- QA修正1: 往路面(seq2)の勾配天井は本番設定（wallLessEndExtendModelMm未指定=既定150mm付近が
// 常に効く）でもCUT polylineとして描かれる（旧実装は端部延長で描画範囲がceilingProfileの範囲を
// わずかに超え、「範囲を覆っていること」条件が常に偽になり黙ってフラット天井へフォールバックして
// いた——elevationFigure.jsのceilAbsAtX/hasCeilingProfileの修正で解消。既存の
// `some(p=>p.type==='polyline')`だけの確認は踏面ジグザグで常に真になるトートロジーのため、
// このテストで天井polyline自体のy範囲・水平フォールバック不在を実効的に固定する） ----
test('【WP-S3・QA修正1】buildStairBand: 往路面の天井は勾配のCUT polyline（wallLessEndExtendModelMm既定でも描かれる）', () => {
  const graph = makeGraph('p1');
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 2400; // floorHeight = 2400
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4500, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID); // CH明示指定なし → upperGraph.defaultCeilingHeight

  // 3階目ありのproject（isTopFloor=falseにしてupperCeilCappedを発生させない）。
  const topPlane = new Plane('p3', 2400 + 2800, 'p3階', 1, 1);
  const project = { planes: [graph.plane, upperGraph.plane, topPlane] };

  // wallLessEndExtendModelMm は渡さない（buildFaceFigure既定のDEFAULT_WALL_LESS_END_EXTEND_MM
  // ≈150mmが本番同様に常に効く状態を再現する）。
  const band = buildStairBand(room, graph, upperGraph, { stair, floorHeight: 2400, project });
  const chLowerMm = 2400; // stairRoom自身のCH（既定）
  const chUpperAbsMm = 2400 + upperGraph.defaultCeilingHeight; // 4800

  const thickPolylines = band.primitives.filter(p => p.type === 'polyline' && p.weight === 'thick');
  const gradient = thickPolylines.find(p => {
    const ys = p.points.map(pt => pt[1]);
    return Math.abs(Math.min(...ys) - (-chUpperAbsMm)) < 1e-6 && Math.abs(Math.max(...ys) - (-chLowerMm)) < 1e-6;
  });
  assert.ok(gradient, `往路面の勾配天井polyline（y範囲が-chLower(${-chLowerMm})..-chUpperAbs(${-chUpperAbsMm})）が見つからない`);

  const flatCeilAtChLower = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === -chLowerMm);
  assert.equal(flatCeilAtChLower.length, 0,
    'y=-CHの水平CUT線（旧フォールバック時の症状）は出ないはず');
});

// ---- ユーザー明示指示（「2FL 寸法線はここで分ける」）: 階段帯のseq1（帯先頭面）の左CH寸法が
// 2FL(floorHeight)で「踊り場床→2FL」「2FL→2F天井」の2本に分割される ----
test('【階段帯・2FL分割】buildStairBand: seq1(帯先頭面)の左CH寸法が2FL(floorHeight)で2本に分割される', () => {
  const graph = makeGraph('p1');
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 2400; // floorHeight = 2400
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4500, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildStairBand(room, graph, upperGraph, { stair, floorHeight: 2400 });
  const n1 = 6, riser = 2400 / 12;
  const landingAbs = n1 * riser; // 1200
  const chUpperAbsMm = 2400 + upperGraph.defaultCeilingHeight; // 4800
  const floorHeight = 2400;

  // seq1（帯先頭面。xCursor=0）のfoot=0で一意に絞り込む——at<footだけだと、他面（seq2等）の
  // 継ぎ目CH寸法（hasLeftChDim）も含まれてしまう（それらはxCursor>0のためfoot>0で区別できる）。
  const leftChDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v' && p.at < p.foot && p.foot === 0);
  assert.equal(leftChDims.length, 2, 'seq1の左CH寸法は[踊り場床→2FL][2FL→2F天井]の2本になるはず');

  const lower = leftChDims.find(d => Math.abs(d.to - (-landingAbs)) < 1e-6);
  assert.ok(lower, '下側の寸法(踊り場床→2FL。to=-landingAbs)が見つからない');
  assert.ok(Math.abs(lower.from - (-floorHeight)) < 1e-6, '下側の寸法のfromは-2FL(-floorHeight)のはず');

  const upper = leftChDims.find(d => Math.abs(d.from - (-chUpperAbsMm)) < 1e-6);
  assert.ok(upper, '上側の寸法(2FL→2F天井。from=-chUpperAbsMm)が見つからない');
  assert.ok(Math.abs(upper.to - (-floorHeight)) < 1e-6, '上側の寸法のtoは-2FL(-floorHeight)のはず');
});

// ---- WP-S3: SWITCHBACK以外（フォールバック経路）は従来どおりcomposeRoomFaces+
// rotateFacesToStartの面順のまま、2層枠（上階FL線・両端縦線の延長）を描く ----
test('【WP-S3】buildStairBand: フォールバック経路(STRAIGHT)は従来どおりの面順のまま2層枠を描く', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  const stair = graph.addStair({
    type: StairType.STRAIGHT, cells: new Set(), roomId: room.id, totalSteps: 12, tread: 250,
  });

  const upperGraph = makeGraph('p2');
  upperGraph.plane.elevation = 3000; // floorHeight = 3000
  const voidRoom = makeRectRoom(upperGraph, 0, 0, 2000, 4000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const band = buildStairBand(room, graph, upperGraph, { stair, floorHeight: 3000 });
  const chUpperAbsMm = 3000 + upperGraph.defaultCeilingHeight; // 5400

  assert.equal(band.heightUnits, 2);
  const extendedVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2 && p.y2 === -chUpperAbsMm);
  assert.ok(extendedVerticals.length >= 2, 'フォールバック経路でも2層枠の両端縦線が出るはず');
  // STRAIGHT（stairFaceSequence対象外。stair.cellsも空）は断面プロファイル(polyline)を含まない。
  assert.equal(band.primitives.filter(p => p.type === 'polyline').length, 0);
});

// ---- 失敗系: upperGraph=nullはheightUnits=1（1層）のまま ----
test('【失敗系】buildStairBand: upperGraph=nullはheightUnits=1（1層）のまま', () => {
  const graph = makeGraph('p1');
  const room = makeRectRoom(graph, 0, 0, 2000, 4000, '階段');
  const band = buildStairBand(room, graph, null);
  assert.equal(band.heightUnits, 1);
});
