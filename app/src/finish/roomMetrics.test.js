import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph } from '@core';
import { roomCeilingHeight } from './roomMetrics.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

test('roomCeilingHeight: 数値のceilingHeightはそのままmm・rawとも同値を返す', () => {
  const graph = makeGraph();
  const room = graph.addRoom(new Set(), '寝室');
  room.setOverride('ceilingHeight', '2450');

  const r = roomCeilingHeight(graph, room);
  assert.equal(r.mm, 2450);
  assert.equal(r.raw, '2450');
  assert.equal(r.isFallback, false);
});

test('roomCeilingHeight: 未指定はgraph.defaultCeilingHeightにフォールバックする', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2500);
  const room = graph.addRoom(new Set(), '寝室');

  const r = roomCeilingHeight(graph, room);
  assert.equal(r.mm, 2500);
  assert.equal(r.isFallback, true);
});

// ---- 失敗系: レンジ表記（数値化できない）はgraph.defaultCeilingHeightで作図しラベルは原文 ----
test('【失敗系】roomCeilingHeight: レンジ表記「2300〜3500」は数値化できないためdefaultCeilingHeightで作図し、rawは原文のまま', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2400);
  const room = graph.addRoom(new Set(), '傾斜天井の部屋');
  room.setOverride('ceilingHeight', '2300〜3500');

  const r = roomCeilingHeight(graph, room);
  assert.equal(r.mm, 2400, '数値化できないためgraph.defaultCeilingHeightで作図する');
  assert.equal(r.raw, '2300〜3500', 'ラベルは原文表示');
  assert.equal(r.isFallback, true);
});
