// buildRoomBand の基本挙動テスト。実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で
// 壁を生成した部屋に対して帯を組み立てる（elevationFaces.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand } from './elevationBand.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { layoutBands, bandContentOriginMm } from './elevationLayout.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { BAND_TOP_MARGIN_MM, BAND_GAP_MM } from './elevationStyle.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
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

test('buildRoomBand: 矩形部屋は4面ぶんのfaceCountを持つ', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const band = buildRoomBand(room, graph);
  assert.equal(band.faceCount, 4);
  assert.equal(band.roomId, room.id);
  assert.equal(band.roomName, 'LDK');
});

test('buildRoomBand: 天井高寸法(縦dim)は先頭面ぶん1本だけ出る', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const band = buildRoomBand(room, graph);
  const chDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v');
  assert.equal(chDims.length, 1);
  assert.equal(chDims[0].dot, true);
});

// ---- 壁芯間寸法（横dim。ROW1）は面ごとに1本出る ----
test('buildRoomBand: 壁芯間寸法(横dim)は面の数ぶん出る', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const band = buildRoomBand(room, graph);
  const wallDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'h');
  assert.equal(wallDims.length, band.faceCount);
});

test('buildRoomBand: 部屋名テキストと引出線の留め三角(miterTriangle)が出る', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'キッチン');

  const band = buildRoomBand(room, graph);
  assert.ok(band.primitives.some(p => p.type === 'text' && p.text === 'キッチン'));
  assert.ok(band.primitives.some(p => p.type === 'miterTriangle'));
});

// ---- 面間ギャップは壁中心線(faceBoundaryLocalX)同士がgapModelMmになるよう配置する（ユーザー仕様） ----
test('buildRoomBand: 隣接面は壁中心線同士がctx.gapModelMmだけ離れて配置される', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const gapModelMm = 321;

  const band = buildRoomBand(room, graph, { gapModelMm });
  const faces = buildRoomFaces(room, graph);
  // CUT(太)の縦線(両端)から各面のローカルx範囲(帯内座標)を復元する。
  // xs = [面0.lo(=0), 面0.hi(=run0), 面1.lo(=xCursor1), 面1.hi(=xCursor1+run1), ...]
  const cutVerticals = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2);
  const xs = [...new Set(cutVerticals.map(p => p.x1))].sort((a, b) => a - b);
  assert.equal(xs[0], 0, '先頭面の左端は0');

  const boundary0 = faceBoundaryLocalX(faces[0], graph);
  const boundary1 = faceBoundaryLocalX(faces[1], graph);
  const xCursor1 = xs[2]; // 面1のローカルx=0が帯内で来る位置
  const face0HiAbs = boundary0.hi;         // 面0の壁中心線(hi)の帯内絶対x（面0のxCursorは0）
  const face1LoAbs = xCursor1 + boundary1.lo; // 面1の壁中心線(lo)の帯内絶対x
  assert.ok(Math.abs(face1LoAbs - (face0HiAbs + gapModelMm)) < 1e-6,
    `面1の壁中心線(lo=${face1LoAbs})は面0の壁中心線(hi=${face0HiAbs})+gapModelMm(${gapModelMm})のはず`);
});

// ---- 失敗系: セルの無い部屋は面0・帯は空のまま例外を投げない ----
test('【失敗系】buildRoomBand: セルが無い部屋はfaceCount=0・部屋名枠も出さない', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(), '空室');

  const band = buildRoomBand(room, graph);
  assert.equal(band.faceCount, 0);
  assert.equal(band.primitives.length, 0);
});

// ---- QA G5: ctx.nameGapModelMmが部屋名枠の上余白（帯の下端=bounds.maxY）に効く ----
test('buildRoomBand: ctx.nameGapModelMmを変えるとbounds.maxYがその差分だけ変わる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const bandSmall = buildRoomBand(room, graph, { nameGapModelMm: 100 });
  const bandLarge = buildRoomBand(room, graph, { nameGapModelMm: 999 });
  assert.ok(Math.abs((bandLarge.bounds.maxY - bandSmall.bounds.maxY) - (999 - 100)) < 1e-6,
    `nameGapModelMmの差分(899)だけbounds.maxYが変わるはず（実際差:${bandLarge.bounds.maxY - bandSmall.bounds.maxY}）`);
});

// ---- 項目9: 左三角＝天井高寸法線の外側にtriangleOffsetModelMm、右三角＝一番右の壁中心線の
// 外側にtriangleOffsetModelMm ----
test('【項目9】buildRoomBand: 留め三角はleftAnchorX=CH寸法線-offset、rightAnchorX=最右壁中心線+offsetに置かれる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const triangleOffsetModelMm = 234;

  const band = buildRoomBand(room, graph, { triangleOffsetModelMm });
  const chDim = band.primitives.find(p => p.type === 'dim' && p.dir === 'v');
  assert.ok(chDim, '天井高寸法(縦dim)が見つからない');

  const leftTriangle  = band.primitives.find(p => p.type === 'miterTriangle' && p.dir === 1);
  const rightTriangle = band.primitives.find(p => p.type === 'miterTriangle' && p.dir === -1);
  assert.ok(leftTriangle && rightTriangle);

  assert.ok(Math.abs(leftTriangle.x - (chDim.at - triangleOffsetModelMm)) < 1e-6,
    `左三角は天井高寸法線(at=${chDim.at})の外側にtriangleOffsetModelMm(${triangleOffsetModelMm})のはず（実際:${leftTriangle.x}）`);

  // 一番右の壁中心線＝最終面の境界hi（faceBoundaryLocalXをband内絶対座標へ直したもの）。
  const faces = buildRoomFaces(room, graph);
  const lastFace = faces[faces.length - 1];
  const lastBoundary = faceBoundaryLocalX(lastFace, graph);
  const cutVerticals = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2);
  const lastFaceLocalMaxX = Math.max(...cutVerticals.map(p => p.x1)); // 最終面のrun側(hi)のCUT縦線x
  const rightAnchorExpected = (lastFaceLocalMaxX - lastFace.run + lastBoundary.hi) + triangleOffsetModelMm;
  assert.ok(Math.abs(rightTriangle.x - rightAnchorExpected) < 1e-6,
    `右三角は一番右の壁中心線の外側にtriangleOffsetModelMm(${triangleOffsetModelMm})のはず（期待:${rightAnchorExpected}, 実際:${rightTriangle.x}）`);
});

// ---- 項目10: band.leftAnchorXが左三角の位置と一致する（帯の水平初期位置の既定値に使う） ----
test('【項目10】buildRoomBand: band.leftAnchorXは左の留め三角のxと一致する', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const band = buildRoomBand(room, graph, { triangleOffsetModelMm: 111 });
  const leftTriangle = band.primitives.find(p => p.type === 'miterTriangle' && p.dir === 1);
  assert.ok(leftTriangle);
  assert.equal(band.leftAnchorX, leftTriangle.x);
});

// ---- 失敗系: 面が無い部屋はleftAnchorXがnull（例外にならない） ----
test('【失敗系・項目10】buildRoomBand: 面が無い部屋はleftAnchorXがnull', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(), '空室');
  const band = buildRoomBand(room, graph);
  assert.equal(band.leftAnchorX, null);
});

// ---- 調整項目4: 帯の描画範囲の上端にBAND_TOP_MARGIN_MMぶんの余白を確保する ----
test('【調整項目4】buildRoomBand: bounds.minYは実描画内容の最小yよりBAND_TOP_MARGIN_MMだけ上（さらに負）になる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const band = buildRoomBand(room, graph);

  // primitivesの実際の最小y（マージンを含まない、素の描画内容の最上端）を、代表的な
  // 天井線(CUT・水平線)から求める（figureBoundsを使わず独立に検算する）。
  const cutHorizontals = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2);
  const contentMinY = Math.min(...cutHorizontals.map(p => p.y1));
  assert.ok(Math.abs(band.bounds.minY - (contentMinY - BAND_TOP_MARGIN_MM)) < 1e-6,
    `bounds.minY(${band.bounds.minY})は実描画内容の最小y(${contentMinY})よりBAND_TOP_MARGIN_MM(${BAND_TOP_MARGIN_MM})だけ上のはず`);
});

// ---- 調整項目6: 仕上げモードのFL高さ(room.floorLevel)が帯の床線の見た目位置に反映される ----
test('【調整項目6】buildRoomBand: room.floorLevel（FL高さ）が床線の見た目位置(bounds.minYからの相対y)に反映される', () => {
  const graphA = makeGraph();
  const roomA = makeRectRoom(graphA, 0, 0, 4000, 3000, 'A');
  const graphB = makeGraph();
  const roomB = makeRectRoom(graphB, 0, 0, 4000, 3000, 'B');
  roomB.setFloorLevel(200); // FLが基準より200mm高い部屋

  const bandA = buildRoomBand(roomA, graphA);
  const bandB = buildRoomBand(roomB, graphB);

  // 床線(CUT・水平線のうちy=0に最も近い=値が最大のもの)の帯内座標を取る。
  const floorY = (band) => {
    const cutHorizontals = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2);
    return Math.max(...cutHorizontals.map(p => p.y1));
  };
  // 画面上の見た目位置に直結するのは「床線yからbounds.minYまでの距離」（帯スロット内での
  // 床線の下がり量。elevationLayout.jsのbandContentOriginMmが帯ごとにbounds.minYを
  // スロット上端へ再アンカーするため、見た目位置の比較にはこの相対値を使う必要がある）。
  const relA = floorY(bandA) - bandA.bounds.minY;
  const relB = floorY(bandB) - bandB.bounds.minY;
  assert.ok(Math.abs((relA - relB) - 200) < 1e-6,
    `FLが200mm高い部屋(B)は床線が200mm上（帯スロット内での下がり量が200mm小さく）見えるはず` +
    `（相対位置差: ${relA - relB}）`);
});

// ---- QA A2/B2: floorLevel差がBAND_GAP_MMを超えても、隣接帯の実描画範囲は重ならない ----
// 2つ目の帯(B)がfloorLevelで大きく持ち上がる方向が最も危険（Bの内容がAへせり出す側になる。
// bandContentOriginMmはbounds.minYを再アンカーするだけでtopMarginMmまでは打ち消せないため、
// layoutBandsのtopMarginMm(帯を置く前に追加で空ける量)がここで効いているかを検証する）。
// QA B2: 「上へせり出す(floorOffset>0)」方向はA-B間の実すき間が縮む危険があるため、
// ちょうどBAND_GAP_MM+BAND_TOP_MARGIN_MM(750)に固定されることを厳密等値で確認する
// （以前は>=だけの緩い確認だったが、後続のB2修正で正確に750になることを保証できるようになった）。
function realGap(originUpper, rangeUpper, originLower, rangeLower) {
  return (originLower + rangeLower.minY) - (originUpper + rangeUpper.maxY);
}

test('【QA A2/B2】buildRoomBand+layoutBands: floorLevel差がBAND_GAP_MM(600)を超える2帯でも実描画範囲は重ならず、すき間はちょうど750mmになる', () => {
  const graphA = makeGraph();
  const roomA = makeRectRoom(graphA, 0, 0, 4000, 3000, 'A');
  const graphB = makeGraph();
  const roomB = makeRectRoom(graphB, 0, 0, 4000, 3000, 'B');
  roomB.setFloorLevel(700); // BAND_GAP_MM(600)を超えるFL差（QA実測の指摘値。Bが上へせり出す方向）

  const bandA = buildRoomBand(roomA, graphA);
  const bandB = buildRoomBand(roomB, graphB);
  const layout = layoutBands([bandA, bandB]);

  const originA = bandContentOriginMm(layout.placements[0], bandA);
  const originB = bandContentOriginMm(layout.placements[1], bandB);
  // 実際に画面へ出る範囲は、floorOffset適用後(=shifted済み)のband.primitivesそのものから求める
  // （band.boundsはitem6のためfloorOffset非依存の基準値であり、実描画範囲そのものではない）。
  const rangeA = figureBounds(bandA.primitives);
  const rangeB = figureBounds(bandB.primitives);
  const gap = realGap(originA, rangeA, originB, rangeB);

  assert.ok(Math.abs(gap - (BAND_GAP_MM + BAND_TOP_MARGIN_MM)) < 1e-6,
    `Bが上へせり出す方向(floorLevel=+700)では実すき間はちょうど${BAND_GAP_MM + BAND_TOP_MARGIN_MM}mmに固定されるはず（実際:${gap}）`);
});

// ---- QA B2: 「下へせり出す(floorOffset<0)」方向は、次の帯(このケースではC)との実すき間を
// ちょうど750mmに保つのが正しい修正であり、直前の帯(A)との実すき間は逆に自然と広がってよい
// （Bが上へは動いていないためA側は元々危険が無い方向。ここを750に固定しようとすると
// 数式上不可能——.claude/elevation-model.md参照。旧実装はこの「安全な側」にも無駄にMath.abs分の
// 余白を積んでいたため、reviewer実測どおりA-B間が2150mmまで無駄に広がっていた。修正後は
// 自然な間隔(BAND_GAP_MM+BAND_TOP_MARGIN_MM+700=1450)になり、過剰予約が無いことを確認する）----
test('【QA B2】buildRoomBand+layoutBands: floorLevel=-700（Bが下へせり出す）では、Aとの実すき間は無駄な過剰予約なしの1450mmになる', () => {
  const graphA = makeGraph();
  const roomA = makeRectRoom(graphA, 0, 0, 4000, 3000, 'A');
  const graphB = makeGraph();
  const roomB = makeRectRoom(graphB, 0, 0, 4000, 3000, 'B');
  roomB.setFloorLevel(-700);

  const bandA = buildRoomBand(roomA, graphA);
  const bandB = buildRoomBand(roomB, graphB);
  const layout = layoutBands([bandA, bandB]);

  const originA = bandContentOriginMm(layout.placements[0], bandA);
  const originB = bandContentOriginMm(layout.placements[1], bandB);
  const rangeA = figureBounds(bandA.primitives);
  const rangeB = figureBounds(bandB.primitives);
  const gap = realGap(originA, rangeA, originB, rangeB);
  const expected = BAND_GAP_MM + BAND_TOP_MARGIN_MM + 700;

  assert.ok(Math.abs(gap - expected) < 1e-6,
    `Bが下へせり出す方向(floorLevel=-700)ではA-B間は無駄な余白を含まない自然な間隔(${expected}mm)になるはず` +
    `（実際:${gap}。旧実装のバグでは2150mmまで無駄に広がっていた）`);
});

// ---- QA B2: 「下へせり出す」方向で本来守るべきなのは"次"の帯(C)とのすき間。ちょうど750mmになる ----
test('【QA B2】buildRoomBand+layoutBands: floorLevel=-700（Bが下へせり出す）でも、次の帯(C)との実すき間はちょうど750mmを維持する', () => {
  const graphB = makeGraph();
  const roomB = makeRectRoom(graphB, 0, 0, 4000, 3000, 'B');
  roomB.setFloorLevel(-700);
  const graphC = makeGraph();
  const roomC = makeRectRoom(graphC, 0, 0, 4000, 3000, 'C');

  const bandB = buildRoomBand(roomB, graphB);
  const bandC = buildRoomBand(roomC, graphC);
  const layout = layoutBands([bandB, bandC]);

  const originB = bandContentOriginMm(layout.placements[0], bandB);
  const originC = bandContentOriginMm(layout.placements[1], bandC);
  const rangeB = figureBounds(bandB.primitives);
  const rangeC = figureBounds(bandC.primitives);
  const gap = realGap(originB, rangeB, originC, rangeC);

  assert.ok(Math.abs(gap - (BAND_GAP_MM + BAND_TOP_MARGIN_MM)) < 1e-6,
    `Bが下へせり出す方向(floorLevel=-700)ではB-C間の実すき間がちょうど${BAND_GAP_MM + BAND_TOP_MARGIN_MM}mmに固定されるはず（実際:${gap}）`);
});

// ---- 失敗系: floorLevel=0同士（差が無い）なら従来どおりBAND_GAP_MM+BAND_TOP_MARGIN_MMちょうど ----
test('【失敗系・QA A2】buildRoomBand+layoutBands: floorLevel差が無ければ実描画間隔はBAND_GAP_MM+BAND_TOP_MARGIN_MMちょうど', () => {
  const graphA = makeGraph();
  const roomA = makeRectRoom(graphA, 0, 0, 4000, 3000, 'A');
  const graphB = makeGraph();
  const roomB = makeRectRoom(graphB, 0, 0, 4000, 3000, 'B');

  const bandA = buildRoomBand(roomA, graphA);
  const bandB = buildRoomBand(roomB, graphB);
  const layout = layoutBands([bandA, bandB]);

  const originA = bandContentOriginMm(layout.placements[0], bandA);
  const originB = bandContentOriginMm(layout.placements[1], bandB);
  const rangeA = figureBounds(bandA.primitives);
  const rangeB = figureBounds(bandB.primitives);
  const gap = (originB + rangeB.minY) - (originA + rangeA.maxY);

  assert.ok(Math.abs(gap - (BAND_GAP_MM + BAND_TOP_MARGIN_MM)) < 1e-6,
    `floorLevel差が無ければ余分な余白は乗らないはず（期待:${BAND_GAP_MM + BAND_TOP_MARGIN_MM}, 実際:${gap}）`);
});
