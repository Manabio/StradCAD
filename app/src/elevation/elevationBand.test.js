// buildRoomBand の基本挙動テスト。実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で
// 壁を生成した部屋に対して帯を組み立てる（elevationFaces.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand } from './elevationBand.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';

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
