// slabOpening.js（上階スラブの開口＝上階に床が無い領域）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { slabOpeningRects, slabOpeningFrames, slabOpeningEdges, trimOpeningEdgesAgainstStair } from './slabOpening.js';

// 2×1マス（x:0-1000-2000, y:0-1500）のグリッドを持つグラフとセルキーを作る。
function makeGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  return {
    graph,
    left:  `${x0.id}:${y0.id}:${xm.id}:${y1.id}`,
    right: `${xm.id}:${y0.id}:${x1.id}:${y1.id}`,
  };
}

test('上階グラフが無い（未解決）なら null を返す＝呼び出し側はクリップしない', () => {
  assert.equal(slabOpeningRects(null), null);
  assert.equal(slabOpeningRects(undefined), null);
});

test('吹抜け・階段吹抜けRoomの占有セルが開口になる', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);
  const rects = slabOpeningRects(graph);
  assert.equal(rects.length, 2);
  // 世界座標がセル矩形（x:0-1000 / 1000-2000, y:0-1500）で返る
  const xs = rects.map(r => [r.x1, r.x2]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(xs, [[0, 1000], [1000, 2000]]);
  assert.ok(rects.every(r => r.y1 === 0 && r.y2 === 1500));
});

test('通常の部屋（床がある）は開口に数えない', () => {
  const { graph, left } = makeGrid();
  graph.addRoom(new Set([left])); // feature 未設定＝通常の部屋
  assert.deepEqual(slabOpeningRects(graph), []);
});

test('階段も吹抜けも無ければ空配列（呼び出し側は安全側で制約なしとして扱う）', () => {
  const { graph } = makeGrid();
  assert.deepEqual(slabOpeningRects(graph), []);
});

test('slabOpeningFrames: 矩形の開口は境界CL矩形と壁面矩形の対を返す（壁が無ければCLへ落ちる）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const frames = slabOpeningFrames(graph);
  assert.equal(frames.length, 1);
  assert.deepEqual(
    { x1: frames[0].cl.x1, y1: frames[0].cl.y1, x2: frames[0].cl.x2, y2: frames[0].cl.y2 },
    { x1: 0, y1: 0, x2: 2000, y2: 1500 },
  );
  // 壁を生成していないので描画位置はCLと同じ
  assert.equal(frames[0].face.x1, 0);
  assert.equal(frames[0].face.y2, 1500);
});

test('slabOpeningFrames: 上階が無ければ null', () => {
  assert.equal(slabOpeningFrames(null), null);
});

test('slabOpeningEdges: 壁が無ければ開口の4辺をそのまま返す', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const edges = slabOpeningEdges(slabOpeningFrames(graph), graph);
  assert.equal(edges.length, 4);
  // 左右は垂直線・上下は水平線
  assert.equal(edges.filter(s => s.x1 === s.x2).length, 2);
  assert.equal(edges.filter(s => s.y1 === s.y2).length, 2);
});

test('slabOpeningEdges: 当該階の壁に覆われた区間は差し引かれる', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const frames = slabOpeningFrames(graph);
  // y=1500（下辺）の全長に壁がある当該階を模す
  const fakeGraph = {
    walls: [{ isVertical: false, axisCL: { value: 1500 }, coord1: 0, coord2: 2000 }],
  };
  const edges = slabOpeningEdges(frames, fakeGraph);
  assert.equal(edges.length, 3); // 下辺が丸ごと消える
  assert.ok(!edges.some(s => s.y1 === 1500 && s.y2 === 1500));
});

test('slabOpeningEdges: frames が空／null なら空配列（描かない）', () => {
  assert.deepEqual(slabOpeningEdges(null, {}), []);
  assert.deepEqual(slabOpeningEdges([], {}), []);
});

test('slabOpeningRects: 矩形の開口は、縁の描画位置と同じ壁面矩形を1枚返す（セル矩形に割らない）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const rects = slabOpeningRects(graph);
  assert.equal(rects.length, 1); // 2セルぶんに割らない
  const face = slabOpeningFrames(graph)[0].face;
  assert.deepEqual(
    [rects[0].x1, rects[0].y1, rects[0].x2, rects[0].y2],
    [face.x1, face.y1, face.x2, face.y2], // 破線を切る範囲＝実際に描く縁と同一
  );
});

// 開口の縁: y=-3557 を x=-2942〜-57。破れ先破線は開口でクリップ済みなので、ささらは
// 縁に端点で接する（x=-1550, y=-3557〜-6000）。破れ先セル＝レーンB x[-3000,-1500] y[-6000,-3500]。
const OPENING_EDGE = [{ x1: -2942, y1: -3557, x2: -57, y2: -3557 }];
const STAIR_SEGS = [{ x1: -1550, y1: -3557, x2: -1550, y2: -6000 }];
const BEYOND = [{ x1: -3000, y1: -6000, x2: -1500, y2: -3500 }];

test('trimOpeningEdgesAgainstStair: 縁に端点で接する直交破線でも交点を拾って切る', () => {
  const out = trimOpeningEdgesAgainstStair(OPENING_EDGE, STAIR_SEGS, BEYOND);
  assert.equal(out.length, 1);
  // レーン間の通り芯 -1500 ではなく、ささら破線の実位置 -1550 で止まる
  assert.deepEqual([out[0].x1, out[0].x2], [-1550, -57]);
  assert.equal(out[0].y1, -3557);
});

test('trimOpeningEdgesAgainstStair: 階段側が縁を担う区間（破れ先セル内）は落とす', () => {
  const out = trimOpeningEdgesAgainstStair(OPENING_EDGE, STAIR_SEGS, BEYOND);
  assert.ok(!out.some(s => Math.min(s.x1, s.x2) < -1550 - 1e-6));
});

test('trimOpeningEdgesAgainstStair: 平行な破線では切らない（直交だけが交点になる）', () => {
  const parallel = [{ x1: -2942, y1: -3500, x2: -1500, y2: -3500 }];
  assert.deepEqual(trimOpeningEdgesAgainstStair(OPENING_EDGE, parallel, BEYOND), OPENING_EDGE);
});

test('trimOpeningEdgesAgainstStair: 縁に届かない・端で接するだけの直交破線では切らない', () => {
  const edges = [{ x1: 0, y1: 0, x2: 1000, y2: 0 }];
  const beyond = [{ x1: -10, y1: -10, x2: 10, y2: 10 }];
  const away = [{ x1: 500, y1: 100, x2: 500, y2: 200 }];
  const atEnd = [{ x1: 0, y1: -50, x2: 0, y2: 50 }];
  for (const segs of [away, atEnd]) {
    assert.deepEqual(trimOpeningEdgesAgainstStair(edges, segs, beyond), edges);
  }
});

test('trimOpeningEdgesAgainstStair: 破れ先セル／階段側の線が無ければ縁をそのまま返す（安全側）', () => {
  assert.deepEqual(trimOpeningEdgesAgainstStair(OPENING_EDGE, STAIR_SEGS, []), OPENING_EDGE);
  assert.deepEqual(trimOpeningEdgesAgainstStair(OPENING_EDGE, [], BEYOND), OPENING_EDGE);
  assert.deepEqual(trimOpeningEdgesAgainstStair([], STAIR_SEGS, BEYOND), []);
});

test('slabOpeningFrames: 上階の吹抜け(VOID)Roomは縁を返さない（VoidLayerの「上部吹抜け」破線と二重描画しない）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.VOID);
  assert.deepEqual(slabOpeningFrames(graph), []);
  assert.deepEqual(slabOpeningEdges(slabOpeningFrames(graph), graph), []);
  // 範囲そのもの（破れ先破線のクリップ用）はVOIDも含めて返り続ける
  assert.equal(slabOpeningRects(graph).length, 1);
});

test('slabOpeningFrames: VOIDとSTAIR_VOIDが混在してもSTAIR_VOID側だけが縁を返す', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);
  const frames = slabOpeningFrames(graph);
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].cl.x1, frames[0].cl.x2], [1000, 2000]); // right（STAIR_VOID）のみ
});
