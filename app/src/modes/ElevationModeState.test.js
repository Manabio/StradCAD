// ElevationModeState.init() の失敗系（QA F4）。mobx以外はDOM/IndexedDBに依存しないため
// node:testから直接importできる（storage/FloorSwapManager.js のIndexedDB呼び出しはopenDB()内部の
// 遅延実行のため、project=null経由でpeekへ到達しない本テストでは発火しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { ElevationModeState } from './ElevationModeState.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

test('ElevationModeState.init: project=null（直上階なし）でも帯を構築しloading=falseになる', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });

  const result = await state.init();
  assert.equal(result.ok, true);
  assert.equal(state.loading, false);
  assert.equal(state.materialError, null);
  assert.equal(state.bands.length, 1);
});

// ---- 失敗系（QA F4）: 1部屋の帯構築が例外を投げても、モードはloading=falseで生成され
// materialErrorが非nullになり、他の部屋の帯は残る ----
test('【失敗系・QA F4】ElevationModeState.init: 1部屋の帯構築が失敗してもモードは生成されloading=false・materialError非null', async () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const broken = makeRectRoom(graph, 0, 5000, 4000, 8000, '故障室');
  // getFinishInfo をインスタンス側で壊し、buildFaceFigure内の呼び出しで例外を発生させる
  // （Roomクラスのプロトタイプメソッドを上書き。1部屋だけの異常をシミュレート）。
  broken.getFinishInfo = () => { throw new Error('boom'); };

  const state = new ElevationModeState(graph, null, { width: 1000, height: 800 });
  const result = await state.init();

  assert.equal(result.ok, false);
  assert.equal(state.loading, false);
  assert.ok(state.materialError, 'materialErrorが設定されるはず');
  assert.ok(state.materialError.includes('故障室'), `失敗した部屋名を含むはず（実際:${state.materialError}）`);
  assert.equal(state.bands.length, 1, '正常な部屋(LDK)の帯だけは残るはず');
  assert.equal(state.bands[0].roomName, 'LDK');
});
