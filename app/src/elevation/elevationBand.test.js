// buildRoomBand の基本挙動テスト。実 core.js（Plane/PlanGraph）+ finish/wallGeneration.js で
// 壁を生成した部屋に対して帯を組み立てる（elevationFaces.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand } from './elevationBand.js';
import { FACE_GAP_MM } from './elevationStyle.js';

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

test('buildRoomBand: 天井高寸法(dim)は先頭面ぶん1本だけ出る', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const band = buildRoomBand(room, graph);
  const dims = band.primitives.filter(p => p.type === 'dim');
  assert.equal(dims.length, 1);
  assert.equal(dims[0].dot, true);
});

test('buildRoomBand: 部屋名テキストと引出線の留め三角(polyline)が出る', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'キッチン');

  const band = buildRoomBand(room, graph);
  assert.ok(band.primitives.some(p => p.type === 'text' && p.text === 'キッチン'));
  assert.ok(band.primitives.some(p => p.type === 'polyline' && p.closed));
});

test('buildRoomBand: 2面目以降はxCursor(前面のrun+FACE_GAP_MM)ぶんだけ右へずれる', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000);

  const band = buildRoomBand(room, graph);
  // CUT(太)の縦線(両端)から各面のローカルx範囲を復元する。
  const cutVerticals = band.primitives.filter(p => p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2);
  const xs = [...new Set(cutVerticals.map(p => p.x1))].sort((a, b) => a - b);
  // 面0: [0, run0], 面1(B): [run0+GAP, run0+GAP+run1], ...
  assert.equal(xs[0], 0, '先頭面の左端は0');
  // 面の境目にFACE_GAP_MM分のギャップがあるはず（隣接する2値の差がFACE_GAP_MMと一致する箇所が存在する）
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  assert.ok(gaps.some(g => Math.abs(g - FACE_GAP_MM) < 1e-6), `面間のギャップ${FACE_GAP_MM}が見つからない: ${gaps}`);
});

// ---- 失敗系: セルの無い部屋は面0・帯は空のまま例外を投げない ----
test('【失敗系】buildRoomBand: セルが無い部屋はfaceCount=0・部屋名枠も出さない', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(), '空室');

  const band = buildRoomBand(room, graph);
  assert.equal(band.faceCount, 0);
  assert.equal(band.primitives.length, 0);
});
