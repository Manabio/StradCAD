// finish/stair/stairUnderRooms.js の単体テスト。
// resolveStairUnderEntries（FinishModeState.stairUnderRooms のモード非依存版。1-D）の
// 中間階ガード・riser導出・stairUnderRoomsOf（既存）を対象にする。
// フィクスチャは elevation/elevationStair.test.js の makeHiddenWallStairFixture と同一構成
// （SWITCHBACK・L字部屋＋returnKeyが階段下部屋候補（beyond）。finish/stair/stairUnderWalls.test.js
// と同じ流用元）。SWITCHBACK は riser を一切参照せず beyond セルを決める
// （stairGeometry.js beyondBreakUTurnLike のコメント参照）ため、beyond の中身を変えずに
// riser 導出だけを独立して確認できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { resolveStairUnderEntries, stairUnderRoomsOf } from './stairUnderRooms.js';
import { cellsBeyondBreak } from './stairGeometry.js';
import { cellBoundsList } from '../gridCells.js';

function makeStairUnderFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const stairCells = new Set([landingKey, outboundKey, returnKey]);
  const roomCells  = new Set([landingKey, outboundKey]); // L字。returnKeyは部屋自身に含めない。
  const room = graph.addRoom(roomCells, '階段');
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
  const under = graph.addRoom(new Set(beyond), '階段下');
  return { graph, room, stair, under, beyond };
}

test('resolveStairUnderEntries: 前提フィクスチャは beyond が非空で under 部屋が1件見つかる（対照）', () => {
  const { graph, stair, under } = makeStairUnderFixture();
  const entries = resolveStairUnderEntries(graph);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stair, stair);
  assert.equal(entries[0].room, under);
});

test('resolveStairUnderEntries【中間階ガード】: lowerStairCellBoundsがbeyondセルを覆う場合は対象外（0件）', () => {
  const { graph, beyond } = makeStairUnderFixture();
  const dummyLowerStair = {}; // 判定には使われない（cellBoundsのみ参照）
  const lowerStairCellBounds = [{ stair: dummyLowerStair, cellBounds: cellBoundsList(new Set(beyond), graph) }];
  const entries = resolveStairUnderEntries(graph, { lowerStairCellBounds });
  assert.deepEqual(entries, []);
});

test('resolveStairUnderEntries【中間階ガード】: lowerStairCellBoundsが覆わなければ通常どおり1件返る', () => {
  const { graph } = makeStairUnderFixture();
  // 別の場所（beyondと重ならない座標）を覆う下階階段。中間階ガードに掛からない。
  const lowerStairCellBounds = [{ stair: {}, cellBounds: [{ x1: 100000, y1: 100000, x2: 101000, y2: 101000 }] }];
  const entries = resolveStairUnderEntries(graph, { lowerStairCellBounds });
  assert.equal(entries.length, 1);
});

test('resolveStairUnderEntries: stair.riserがnullでfloorHeight指定時はriser=floorHeight/totalSteps', () => {
  const { graph, stair } = makeStairUnderFixture();
  const floorHeight = 2400;
  const entries = resolveStairUnderEntries(graph, { floorHeight });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].riser, floorHeight / stair.totalSteps);
});

test('resolveStairUnderEntries: stair.riser・floorHeightともに未指定ならriser=null', () => {
  const { graph } = makeStairUnderFixture();
  const entries = resolveStairUnderEntries(graph);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].riser, null);
});

test('resolveStairUnderEntries: stair.riserが明示指定されていればfloorHeightより優先される', () => {
  const { graph, stair } = makeStairUnderFixture();
  stair.setField('riser', 200);
  const entries = resolveStairUnderEntries(graph, { floorHeight: 2400 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].riser, 200);
});

// ---- stairUnderRoomsOf（既存関数）の対照テスト: STAIR/STAIR_VOID/UNDEFINED/stair自身のペアRoomは除外 ----
test('stairUnderRoomsOf: beyondセルに交差する通常のRoomだけを返す', () => {
  const { graph, stair, under, beyond } = makeStairUnderFixture();
  const rooms = stairUnderRoomsOf(stair, graph, beyond);
  assert.deepEqual(rooms, [under]);
});
