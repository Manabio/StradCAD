// buildRoomBand の基本挙動テスト。実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で
// 壁を生成した部屋に対して帯を組み立てる（elevationFaces.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand, layoutBandFaces, finalizeBand } from './elevationBand.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { layoutBands, bandContentOriginMm } from './elevationLayout.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { BAND_TOP_MARGIN_MM, BAND_GAP_MM, CH_DIM_OFFSET_MM } from './elevationStyle.js';

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
  // 面端(両端)の縦線から各面のローカルx範囲(帯内座標)を復元する。QA修正(5a): 出隅の縦線は
  // SILHOUETTE(中線)で描くため、CUT(太)限定ではなくCUT/SILHOUETTE(太・中線)の縦線で拾う
  // （DETAIL=中心線一点鎖線のdash付き縦線は除外する）。
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
  // QA修正(5a): 出隅の縦線はSILHOUETTE(中線)のため、CUT(太)限定ではなく縦線一般で拾う。
  const endVerticals = band.primitives.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && (p.weight === 'thick' || p.weight === 'medium'));
  const lastFaceLocalMaxX = Math.max(...endVerticals.map(p => p.x1)); // 最終面のrun側(hi)の縦線x
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

  // primitivesの実際の最小y（マージンを含まない、素の描画内容の最上端）。項目4で壁中心線も
  // 通り芯線と同じ高さまで突き出すようになったため、天井線(CUT)を代表点にする従来の検算方法は
  // 使えない（壁中心線の方がさらに上まで伸びる）——figureBoundsで独立に検算する
  // （floorLevel未設定=floorOffset0のこの部屋ではband.primitivesがrawBoundsと同じ座標系のまま）。
  const contentMinY = figureBounds(band.primitives).minY;
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

// ---- 項目3(結合): buildRoomBandがprevFace/nextFaceを実際に配線し、隅の建具が隣接面の端に断面で出る ----
test('【項目3・結合】buildRoomBand: D面隅の建具はA面(prevFace=D)のx=0側に枠2断面＋扉1枚の断面として出る', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  // D面（x=0の壁）上、A面(y=0)との隅ぎりぎり（refOffset=100・width=800）に建具を置く。
  graph.addOpening(x0, 1, true, y0, 100, 800, OpeningCategory.FITTING, 'singleSwing', {});

  const band = buildRoomBand(room, graph, { project: { openingNumberIndex: new Map() } });
  const strip = band.primitives.filter(p => p.type === 'rect' && p.x >= 0 && p.x + p.w <= 120 && p.weight != null);
  assert.equal(strip.length, 3, 'A面のx=0側に枠2断面＋扉1枚＝3本のrectが出るはず');
  assert.deepEqual(strip.map(r => r.weight).sort(), ['medium', 'thick', 'thick'].sort());
});

// ---- 項目4(結合): buildRoomBandがwallAdjacentFloorSegmentsを実際に配線し、部分指定の壁際に
// 段差付きの床線が出る ----
test('【項目4・結合】buildRoomBand: 部分指定（floorLevel+300）が右半分を占める面Aの床線は段差付きになる', () => {
  const graph = makeGraph();
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xMid.id}:${y1.id}`;
  const rightKey = `${xMid.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const band = buildRoomBand(room, graph, { project: { openingNumberIndex: new Map() } });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const cutHorizontals = band.primitives.filter(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.x1 >= 0 && p.x2 <= faceA.run);
  const floorHorizontals = cutHorizontals.filter(l => l.y1 !== -2400); // 天井線(y=-CH)を除外
  assert.equal(floorHorizontals.length, 2, '面Aの床の水平CUT線は段差で2本に分かれるはず');
  assert.ok(floorHorizontals.some(l => l.y1 === -300), '右区間の床線はy=-300にあるはず');
  assert.ok(floorHorizontals.some(l => l.y1 === 0), '左区間の床線はy=0のままのはず');
});

// ---- 項目6(結合): 段差で右CH寸法が付く面は、その寸法込みの右端を基準に次の面とのギャップになる ----
test('【項目6】buildRoomBand: 段差で右CH寸法が付く面Aは、寸法込みの右端を基準に面BとのギャップがgapModelMmになる', () => {
  const graph = makeGraph();
  // x0-xa-xb-x1(3列) × y0-y1(1行)。中央列だけを部分指定にすると、面A(上)・面C(下)だけが
  // 3区間の段差を持ち、面B(右)・面D(左)は段差の影響を受けない（中央列はB/Dのどちらにも接しない）
  // ため、面A→面Bのギャップだけを段差の影響下で単純に検証できる。
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 2500, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xa.id}:${y1.id}`;
  const midKey   = `${xa.id}:${y0.id}:${xb.id}:${y1.id}`;
  const rightKey = `${xb.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, midKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([midKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const gapModelMm = 321;
  const band = buildRoomBand(room, graph, { gapModelMm });
  const faces = buildRoomFaces(room, graph);
  const faceA = faces.find(f => f.label === 'A');
  const faceB = faces.find(f => f.label === 'B');
  const boundaryA = faceBoundaryLocalX(faceA, graph);
  const boundaryB = faceBoundaryLocalX(faceB, graph);

  // ROW1寸法(dir:'h', dot:true)は帯内でband-space順に並ぶため、fromの昇順で先頭が面Aのものになる
  // （面Aは先頭面=xCursor0のため、boundaryA.loそのものになるはず）。新仕様「ROW1寸法のCL分割」
  // により面A自身が段差CLで分割され複数本のdimを持ちうるため、「面Bの最初のdim」は単純な
  // rowDims[1]ではなく、面AのROW1鎖の終端(boundaryA.hi)以降で最小のfromを持つものを探す。
  const rowDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'h' && p.dot === true)
    .sort((a, b) => a.from - b.from);
  assert.ok(Math.abs(rowDims[0].from - boundaryA.lo) < 1e-6, '前提: 先頭のROW1寸法は面Aのものであるはず');
  const faceBFirstDim = rowDims.find(d => d.from >= boundaryA.hi - 1e-6);
  assert.ok(faceBFirstDim, '面BのROW1寸法が見つかるはず');
  const xCursorB = faceBFirstDim.from - boundaryB.lo;

  // 面Aの右CH寸法（項目5。dir:'v'のうち、左CH寸法(foot:0固定)ではない方=foot!==0で識別できる）。
  const rightChDimA = band.primitives.find(p => p.type === 'dim' && p.dir === 'v' && p.foot !== 0);
  assert.ok(rightChDimA, '面Aに右CH寸法（項目5）が付いているはず');

  const expectedXCursorB = rightChDimA.at + gapModelMm - boundaryB.lo;
  assert.ok(Math.abs(xCursorB - expectedXCursorB) < 1e-6,
    `面Bのxカーソル(${xCursorB})は、面Aの右CH寸法込みの右端(${rightChDimA.at})基準のギャップ(${gapModelMm})から求まる値(${expectedXCursorB})と一致するはず`);

  // 対比: 旧方式（壁中心線=boundaryA.hi基準）だったら、CH_DIM_OFFSET_MMぶん左（狭い側）に
  // なっていたはず——実際はそれより右にあり、寸法込みの間隔が確保されていることを確認する。
  const oldStyleXCursorB = boundaryA.hi + gapModelMm - boundaryB.lo;
  assert.ok(Math.abs(xCursorB - oldStyleXCursorB - CH_DIM_OFFSET_MM) < 1e-6,
    '新方式は旧方式(壁中心線基準)よりちょうどCH_DIM_OFFSET_MMぶん右にずれるはず');
});

// ---- QA G2（実グラフでのblack-box確認）: 壁のない端部（上り口辺）を挟む面同士でも、
// buildRoomBandが実際にwallLessEndExtendModelMmぶんxカーソルを押し出すことを確認する ----
// A面（上辺）の壁生成をstairOpenings指定でスキップした部屋と、そうでない通常の部屋とで
// buildRoomBandの出力を比較する（同一ジオメトリ・同一ctx。壁生成の有無だけが違う）。
// A⇔B隅がA面の実壁欠如でhasWallAtLocal0=false（B面）になるはずなので、面BのxカーソルはA面の
// 通常時よりwallLessEndExtendModelMmぶん右へ押し出されるはず（buildRoomBand自体の配線=
// faceWallLessExtents呼び出しを経由しないと再現しないため、内部の純関数呼び出しに依存しない
// 完全なblack-boxテストになる）。
function makeGraphAndRectRoom(wallLessTopEdge) {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'R');
  const stairOpenings = wallLessTopEdge
    ? [{ isVertical: false, value: y0.effectiveValue, lo: x0.effectiveValue - 1, hi: x1.effectiveValue + 1 }]
    : [];
  generateRoomWallsFromOutline(graph, room, {}, stairOpenings);
  return { graph, room };
}

test('【QA G2・実グラフ】buildRoomBand: 上り口辺（壁生成スキップ）を挟む面Bのxカーソルは、通常時よりwallLessEndExtendModelMmぶん押し出される', () => {
  const gapModelMm = 900, wallLessEndExtendModelMm = 150;
  const normal   = makeGraphAndRectRoom(false);
  const wallLess = makeGraphAndRectRoom(true);

  const bandNormal   = buildRoomBand(normal.room,   normal.graph,   { gapModelMm, wallLessEndExtendModelMm });
  const bandWallLess = buildRoomBand(wallLess.room, wallLess.graph, { gapModelMm, wallLessEndExtendModelMm });

  // ROW1寸法(dir:'h', dot:true)は面ごとに1本、fromの昇順で面A→B→C→D。2番目=面Bのfromを比較する
  // （面Bの寸法は常に描かれる=hasWallAtLocal0の影響を受けない。壁なしによる位置ズレだけを見る）。
  const rowDimsNormal   = bandNormal.primitives.filter(p => p.type === 'dim' && p.dir === 'h' && p.dot === true)
    .sort((a, b) => a.from - b.from);
  const rowDimsWallLess = bandWallLess.primitives.filter(p => p.type === 'dim' && p.dir === 'h' && p.dot === true)
    .sort((a, b) => a.from - b.from);
  assert.equal(rowDimsNormal.length, 4);
  assert.equal(rowDimsWallLess.length, 4);

  const diff = rowDimsWallLess[1].from - rowDimsNormal[1].from;
  assert.equal(diff, wallLessEndExtendModelMm,
    `壁なし辺を挟む面Bのxカーソルは、通常時よりちょうどwallLessEndExtendModelMm(${wallLessEndExtendModelMm})ぶん右にずれるはず（実際の差: ${diff}）`);
});

// ---- 問題修正2026-08(QA F1): 左CH寸法は先頭面の左端区間の実際の床〜天井に追従する ----
// 右CH寸法（buildFaceFigure側）だけを区間追従にすると、左端区間に明示CHの部分指定がある帯で
// 左右のCH寸法が別基準になり、左は天井線に届かない線＋食い違う値になる——左も同じ基準に揃える。
test('【問題修正2026-08】buildRoomBand: 先頭面の左端区間に明示CHの部分指定があるとき、左CH寸法はその区間の実際の天井まで届き値も一致する', () => {
  const graph = makeGraph();
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xMid.id}:${y1.id}`;
  const rightKey = `${xMid.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([leftKey]), '天井高エリア', undefined, new Set([room.id]));
  child.setOverride('ceilingHeight', '2600'); // FLは親と同じ・天井だけ明示指定（先頭面Aの左端区間）

  const band = buildRoomBand(room, graph);
  // 左CH寸法＝縦dimのうち最も左（atが最小）のもの（右CH寸法は各面のboundary.hiより右に出る）。
  const vDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v');
  const leftChDim = vDims.reduce((a, b) => (a.at <= b.at ? a : b));
  assert.equal(leftChDim.from, -2600, '左CH寸法は左端区間（明示CH2600）の実際の天井まで届くはず');
  assert.equal(leftChDim.label, 2600, '値も左端区間の実際のCH(2600)のはず');
  assert.equal(leftChDim.to, 0, 'FLは親と同じため床は0のまま');
});

// ---- 失敗系: 左端区間が帯自身（親と同じ床・天井）なら従来どおりchInfo.raw（原文ラベル）を保つ ----
test('【失敗系・問題修正2026-08】buildRoomBand: 左端区間が帯自身ならレンジ表記等の原文ラベルを保つ', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  room.setOverride('ceilingHeight', '2300〜3500'); // 傾斜天井のレンジ表記（defaultCeilingHeightで作図）

  const band = buildRoomBand(room, graph);
  const vDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v');
  assert.equal(vDims.length, 1);
  assert.equal(vDims[0].label, '2300〜3500', '原文ラベルのまま保たれるはず');
  assert.equal(vDims[0].from, -graph.defaultCeilingHeight, '作図はdefaultCeilingHeightのはず');
});

// ---- 問題修正2026-08その5: 破線は「壁の向こう側に部分指定関係のある部屋がある展開図」のみ ----
// 1列×2行・全セルを親が登録し下段を子が上書きする部屋では、どの外周面も壁の向こう側は部屋外
// ＝部分指定関係のある部屋は無い → 破線は一切出ない。旧・全セル投影方式は「部屋内の別エリアが
// run座標上で重なるだけ」でA1/B1/D2相当の面にも破線を出していた——その門番。
test('【問題修正2026-08その5】buildRoomBand: 外周壁の向こう側に部分指定関係の部屋が無ければ、部屋内に別天井のエリアがあっても破線は出ない', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const topKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const botKey = `${x0.id}:${yMid.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([topKey, botKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([botKey]), '土間', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400'); // 天井絶対高さ2300（部屋内の別エリア）

  const band = buildRoomBand(room, graph);
  const dashedHoriz = band.primitives.filter(p =>
    p.type === 'line' && p.dash === 'dashed' && p.weight === 'thin' && p.y1 === p.y2);
  // 問題修正2026-08その6: 段差見付け面（子/親境界の見付けそのもの＝「またぐ面」）には
  // 高い側（親）の天井の破線が出る——外周面（A/B/C/D）には出ない、が本テストの主眼。
  assert.equal(dashedHoriz.length, 1,
    `破線は段差見付け面の1本だけで、外周面には出ないはず（実際:${JSON.stringify(dashedHoriz)}）`);
  assert.equal(dashedHoriz[0].y1, -2400, '見付け面の破線は高い側（親）の天井(-2400)＝天井断面(-2300)の上+100のはず');
});

// ---- 問題修正2026-08その5: 壁の向こう側に部分指定の子がある面には、その天井の破線が出る ----
// 親の登録セルを上段だけにし、下段を「親を参照する子」が所有する構成——上段の南側の壁の
// 向こう側（下段）に部分指定関係の部屋（子。天井絶対高さ100+2400=2500 > 親CH2400）がある。
// 面Cは開放スパン（far側=ファミリー）扱いになり、far天井線として天井断面(-2400)より上の
// -2500に細線の破線が出る。他の面（向こう側=部屋外）には出ない。
test('【問題修正2026-08その5】buildRoomBand: 壁の向こう側に部分指定関係の子がある面だけに、その天井の破線が出る', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const topKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const botKey = `${x0.id}:${yMid.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([topKey]), 'LDK'); // 親は上段のみ
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([botKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(100);
  child.setOverride('ceilingHeight', '2400'); // 天井絶対高さ100+2400=2500（親より100高い）

  const band = buildRoomBand(room, graph);
  const dashedHoriz = band.primitives.filter(p =>
    p.type === 'line' && p.dash === 'dashed' && p.weight === 'thin' && p.y1 === p.y2);
  assert.ok(dashedHoriz.length >= 1, `向こう側=子の面に破線が出るはず（実際:${JSON.stringify(dashedHoriz)}）`);
  assert.ok(dashedHoriz.every(l => l.y1 === -2500),
    `破線はすべて子の天井の高さ(-2500)＝天井断面(-2400)の上+100のはず（実際:${JSON.stringify(dashedHoriz)}）`);
});

// ---- 問題修正2026-08その4改・その6: 床の起点高さが直前の面から変わる面の左側にCH寸法 ----
// ユーザーの平面（3'のB1右=+100→C1左=+0→A2左=+100）に対応する「張り出し（アルコーブ）型の
// 部分指定」フィクスチャ: 親の1行（x0..x1×y0..ym）の南へ、中央（xa..xb）だけ張り出した
// 部分指定の子（FL−100・明示CH2400＝床+100・天井2300）。
// QA K2訂正: 壁面同士の継ぎ目は隅のセルを共有して床が連続するため発火しない——実際に
// 発火するのは「段差見付け面（kind='step'）の前後」: 直前の壁面（親・床0）→見付け面
// （低い側=子・床+100・天井2300）で1本目（from=-2300,to=100,label=2400）、見付け面→
// 次の壁面（親・床0）で2本目（from=-2400,to=0）が出る（実機のB1→C1→A2と同じ構図）。
// 注: 張り出しの両脇CLは張り出し範囲へextent制限（実データ同様）——貫通CLだと開放スパン
// 延長の面結合で構成が変わる（QA J1）。
test('【問題修正2026-08その4改】buildRoomBand: 床の起点高さが直前の面から変わる継ぎ目の面の左側にCH寸法が出る', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH, extentLo: 1500, extentHi: 3000 });
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH, extentLo: 1500, extentHi: 3000 });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const main   = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;   // 本体1行（xa/xbはextent制限で本体を分割しない）
  const alcove = `${xa.id}:${ym.id}:${xb.id}:${y1.id}`;   // 南への張り出し
  const room = graph.addRoom(new Set([main, alcove]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([alcove]), '土間', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400'); // 床+100（ローカル）・天井2300

  const band = buildRoomBand(room, graph);
  // 左側配置の縦寸法＝at<foot（右CH寸法はat>foot）。帯先頭の左CH寸法＋継ぎ目の左CH寸法2本。
  const leftDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v' && p.at < p.foot);
  assert.equal(leftDims.length, 3,
    `帯先頭1本＋継ぎ目2本（親→子・子→親）の計3本のはず（実際:${JSON.stringify(band.primitives.filter(p => p.type === 'dim' && p.dir === 'v'))}）`);
  const intoChild = leftDims.filter(d => d.from === -2300 && d.to === 100 && d.label === 2400);
  assert.equal(intoChild.length, 1, '親→子の継ぎ目（アルコーブ東壁の左側）にfrom=-2300,to=100,label=2400が1本のはず');
  const backToParent = leftDims.filter(d => d.from === -2400 && d.to === 0);
  assert.equal(backToParent.length, 2, '帯先頭＋子→親の継ぎ目の計2本（from=-2400,to=0）のはず');
});

// ---- 矩形＋下段の子: 壁面同士の継ぎ目では床の起点が連続し左CH寸法は出ない。
// 出るのは段差見付け面（床=低い側0abs・天井=低い側の天井）の左だけ（問題修正2026-08その6）。
// 縦寸法=帯の左CH寸法1本＋段差面（B/D）の右CH寸法2本＋見付け面の左CH寸法1本の計4本。
test('【問題修正2026-08その4改・その6】buildRoomBand: 壁面同士の継ぎ目では左CH寸法が出ず、床の起点が変わる段差見付け面の左にだけ出る', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const topKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const botKey = `${x0.id}:${yMid.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([topKey, botKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set([botKey]), '土間', undefined, new Set([room.id]));
  child.setFloorLevel(-100);
  child.setOverride('ceilingHeight', '2400');

  const band = buildRoomBand(room, graph);
  const vDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v');
  assert.equal(vDims.length, 4,
    `帯の左1本＋右CH寸法2本(B/D)＋見付け面の左1本の計4本のはず（実際:${JSON.stringify(vDims)}）`);
  // 壁面同士の継ぎ目由来の左寸法は無く、追加の左寸法は見付け面の1本だけ
  // （床=低い側+100・天井=低い側の天井-2300・値=低い側の実効CH2400）。
  const leftDims = vDims.filter(d => d.at < d.foot);
  assert.equal(leftDims.length, 2, '左配置は帯先頭＋見付け面の2本のはず');
  const stepLeft = leftDims.find(d => d.from === -2300 && d.to === 100);
  assert.ok(stepLeft, '見付け面の左CH寸法(from=-2300,to=100)が見つかるはず');
  assert.equal(stepLeft.label, 2400, '値は低い側エリアの実効CH(2400)のはず');
});

// ==== WP-1: layoutBandFaces の ctx.faceOverride フック ====

// ---- faceOverride未指定はprimitivesが従来と完全一致する ----
test('【WP-1】buildRoomBand: ctx.faceOverride未指定と、常にnullを返すfaceOverride指定は完全に同じprimitivesになる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const withoutOverride = buildRoomBand(room, graph);
  const withNoopOverride = buildRoomBand(room, graph, { faceOverride: () => null });
  assert.deepEqual(withNoopOverride.primitives, withoutOverride.primitives,
    'faceOverrideがnullを返す場合は現行と完全同一のprimitivesになるはず（未指定時に現行出力と完全一致する要件）');
});

// ---- faceOverrideでfloorSegmentsを差し替えると床線が変わる ----
test('【WP-1】buildRoomBand: ctx.faceOverrideでfloorSegmentsを差し替えると、その面の床線が段差付きになる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const withoutOverride = buildRoomBand(room, graph);
  const withOverride = buildRoomBand(room, graph, {
    faceOverride: (face, i, defaults) => {
      if (face.label !== 'A') return null; // 面Aだけ差し替える
      const run = defaults.floorSegments[0].hiX; // defaults＝override前のwallAdjacentFloorSegments結果
      return {
        floorSegments: [
          { loX: 0, hiX: run / 2, floorDeltaMm: 0 },
          { loX: run / 2, hiX: run, floorDeltaMm: 300 },
        ],
      };
    },
  });

  const floorLineYs = (band) => band.primitives
    .filter(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 !== -2400)
    .map(p => p.y1);
  assert.deepEqual(floorLineYs(withoutOverride), [0, 0, 0, 0], '未指定時は4面とも床y=0のフラット床線のはず');
  assert.ok(floorLineYs(withOverride).includes(-300),
    'faceOverrideで差し替えた区間の床線y=-300が現れるはず（現行と異なる出力になる）');
});

// ---- 失敗系: faceOverrideが例外相当（undefined）を返しても現行のまま ----
test('【失敗系・WP-1】buildRoomBand: faceOverrideがundefinedを返す面は現行どおりに描画される', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const withoutOverride = buildRoomBand(room, graph);
  const withUndefinedOverride = buildRoomBand(room, graph, { faceOverride: () => undefined });
  assert.deepEqual(withUndefinedOverride.primitives, withoutOverride.primitives);
});

// ---- QA修正3: faceOverrideはhasLeftChDim判定（継ぎ目の左CH寸法）より前に適用される不変条件
// （layoutBandFacesのJSDoc「floorSegments/beyondCeilingsを計算した直後・hasLeftChDimの継ぎ目判定
// より前に呼ばれる」）。適用位置を後ろへずらすと、override面の左に継ぎ目CH寸法が出なくなり
// このテストが赤くなる ----
test('【QA修正3】layoutBandFaces: faceOverrideはhasLeftChDim判定より前に適用され、override面の左にCH寸法（to=override後の床高さ）が現れる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const withoutOverride = buildRoomBand(room, graph);
  const overrideFloorDeltaMm = 250;
  const withOverride = buildRoomBand(room, graph, {
    faceOverride: (face, i) => {
      if (i !== 1) return null; // 2枚目の面(index=1)だけ床の起点高さを変える
      return { floorSegments: [{ loX: 0, hiX: face.run, floorDeltaMm: overrideFloorDeltaMm }] };
    },
  });

  const leftChDims = band => band.primitives.filter(p => p.type === 'dim' && p.dir === 'v' && p.at < p.foot);
  assert.equal(leftChDims(withoutOverride).length, 1, 'override無しは帯先頭面の左CH寸法1本だけのはず');
  assert.ok(leftChDims(withoutOverride).every(d => Math.abs(d.to - (-overrideFloorDeltaMm)) > 1e-9),
    'override無しにはoverride後の床高さに一致する寸法は無いはず');

  // override面(i=1)の床が変わることで、直前面(i=0)との継ぎ目・直後面(i=2)との継ぎ目の
  // 両方が不一致になる——帯先頭(常時1本)＋override面自身の左(i=1)＋その次の面の左(i=2)＝3本。
  const overriddenLeftDims = leftChDims(withOverride);
  assert.equal(overriddenLeftDims.length, 3,
    'override有りは帯先頭＋override面(i=1)の左＋次の面(i=2)の左＝計3本の左CH寸法になるはず（faceOverrideがhasLeftChDim判定より前に効いている証拠）');
  const stepDim = overriddenLeftDims.find(d => Math.abs(d.to - (-overrideFloorDeltaMm)) < 1e-9);
  assert.ok(stepDim, `override面(i=1)の左CH寸法のtoはoverride後の床高さ(${-overrideFloorDeltaMm})と一致するはず`);
});

// ---- ユーザー明示指示（階段帯「2FL 寸法線はここで分ける」）: faceOverrideがchDimSplitAbsYs
// （分割する絶対高さの配列。床基準・正=床上）を返すと、帯先頭面(i===0)の左CH寸法が
// [床,...chDimSplitAbsYs,天井]の隣接ペアごとに複数本へ分割される ----
test('【階段帯・2FL分割】layoutBandFaces: faceOverrideがchDimSplitAbsYsを返すと、帯先頭面の左CH寸法が指定高さで複数本に分割される', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const CH = 2400; // DEFAULT_ROOM_CEILING_HEIGHT（明示指定なしの既定値）
  const splitAbsY = 1500; // 床(0)〜天井(CH)の間の分割点

  const band = buildRoomBand(room, graph, {
    faceOverride: (face, i) => (i === 0 ? { chDimSplitAbsYs: [splitAbsY] } : null),
  });

  const leftChDims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'v' && p.at < p.foot);
  assert.equal(leftChDims.length, 2, 'chDimSplitAbsYs指定時は左CH寸法が[床→分割点][分割点→天井]の2本になるはず');

  const lower = leftChDims.find(d => d.to === 0);
  assert.ok(lower, '下側の寸法(床→分割点。to=0)が見つからない');
  assert.equal(lower.from, -splitAbsY, '下側の寸法のfromは-分割点のはず');
  assert.equal(lower.label, splitAbsY, '下側の寸法のlabelは実距離(splitAbsY-0)のはず');

  const upper = leftChDims.find(d => d.from === -CH);
  assert.ok(upper, '上側の寸法(分割点→天井。from=-CH)が見つからない');
  assert.equal(upper.to, -splitAbsY, '上側の寸法のtoは-分割点のはず');
  assert.equal(upper.label, CH - splitAbsY, '上側の寸法のlabelは実距離(CH-splitAbsY)のはず');
});

// ---- 失敗系: chDimSplitAbsYs未指定（既定）は現行どおり1本のまま（既存挙動完全不変） ----
test('【失敗系・階段帯2FL分割】layoutBandFaces: chDimSplitAbsYs未指定はfaceOverride指定なしと完全に同じprimitivesになる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const withoutOverride = buildRoomBand(room, graph);
  const withNoopChDimSplit = buildRoomBand(room, graph, {
    faceOverride: (face, i) => (i === 0 ? { chDimSplitAbsYs: undefined } : null),
  });
  assert.deepEqual(withNoopChDimSplit.primitives, withoutOverride.primitives,
    'chDimSplitAbsYs未指定はfaceOverride省略時と完全同一のprimitivesになるはず（既存挙動不変の要件）');
});

// ==== WP-0: finalizeBand の heightUnits/unitHeightMm ====

test('【WP-0】buildRoomBand: heightUnits省略時（既定1）はunitHeightMm===bounds.height', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const band = buildRoomBand(room, graph);
  assert.equal(band.heightUnits, 1);
  assert.equal(band.unitHeightMm, band.bounds.height);
});

test('【WP-0】finalizeBand: heightUnits指定時はunitHeightMm=bounds.height/heightUnitsで、bounds/heightMmは変わらない', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);
  const faces = buildRoomFaces(room, graph);
  const { primitives, chDimX, prevBoundaryHi } = layoutBandFaces(room, graph, faces);

  const band1 = finalizeBand(room, graph, [...primitives], { faceCount: faces.length, chDimX, prevBoundaryHi });
  const band2 = finalizeBand(room, graph, [...primitives], {
    faceCount: faces.length, chDimX, prevBoundaryHi, heightUnits: 2,
  });

  assert.equal(band2.heightUnits, 2);
  assert.ok(Math.abs(band2.unitHeightMm - band1.bounds.height / 2) < 1e-9,
    'unitHeightMmはbounds.height/heightUnitsのはず');
  assert.deepEqual(band2.bounds, band1.bounds, 'boundsはheightUnits指定に関わらず不変のはず');
  assert.equal(band2.heightMm, band1.heightMm, 'heightMmもheightUnits指定に関わらず不変のはず（WP-0は既存の意味を変えない）');
});
