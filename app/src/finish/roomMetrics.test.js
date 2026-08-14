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

// ---- 項目5: 部分指定（referenceRoomIds）のCHは、自身にCH指定が無くfloorLevelが親と異なる
// 場合、天井の絶対高さを親と揃えるよう段差ぶん増減する（部分指定CH = 親CH − (部分FL − 親FL)）----
test('【項目5】roomCeilingHeight: 親よりfloorLevelが高い部分指定（自身にCH指定なし）はCHがその分低くなる', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2400);
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set(), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(300); // 親より300mm高い（小上がり）

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2400 - 300, '親CH(2400)から段差ぶん(300)を引いた値になるはず');
  assert.equal(r.isFallback, false, '親のCHが明示指定(非fallback)なら段差調整後もfalseのはず');
});

test('【項目5】roomCeilingHeight: 親より低い部分指定はCHがその分高くなる', () => {
  const graph = makeGraph();
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2500');
  const child = graph.addRoom(new Set(), '土間', undefined, new Set([parent.id]));
  child.setFloorLevel(-200); // 親より200mm低い

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2500 + 200, '親CH(2500)に段差ぶん(200)を足した値になるはず');
});

// ---- QA E1: 段差が親CH以上（計算結果が0以下）ならgraph.defaultCeilingHeightへフォールバックする ----
test('【QA E1】roomCeilingHeight: 子floorLevelが親CH以上だと計算結果が0以下になるため、graph.defaultCeilingHeightへフォールバックする', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2500);
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set(), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(3000); // 親CH(2400)以上の段差 → 素の計算だと2400-3000=-600（物理的に不可能）

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2500, '計算結果が0以下になるためgraph.defaultCeilingHeightへフォールバックするはず');
  assert.equal(r.isFallback, true);
});

// ---- 失敗系: 明示CH指定がある部分指定は段差調整より優先される ----
test('【失敗系・項目5】roomCeilingHeight: 部分指定に明示CH指定があれば段差調整より優先する', () => {
  const graph = makeGraph();
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set(), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(300);
  child.setOverride('ceilingHeight', '2200'); // 明示指定

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2200, '明示指定は段差調整より優先されるはず');
  assert.equal(r.isFallback, false);
});

// ---- 失敗系: 傾斜天井のレンジ表記（数値化できないが明示指定）も段差調整より優先される ----
test('【失敗系・項目5】roomCeilingHeight: 部分指定に傾斜天井のレンジ表記があれば、数値化できなくても段差調整より優先しrawを保つ', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2400);
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set(), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(300);
  child.setOverride('ceilingHeight', '2300〜3500'); // 数値化できないが明示指定

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.raw, '2300〜3500', 'レンジ表記は段差調整で上書きされず原文のまま保たれるはず');
  assert.equal(r.mm, 2400, 'mmは数値化できないためgraph.defaultCeilingHeightへ（親CH段差調整は適用しない）');
  assert.equal(r.isFallback, true);
});

// ---- 失敗系: floorLevelが親と同じ部分指定は段差調整を行わず、通常どおりdefaultCeilingHeightへ ----
test('【失敗系・項目5】roomCeilingHeight: floorLevelが親と同じ部分指定は段差調整せず通常のfallbackになる', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2450);
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set(), '床材違いエリア', undefined, new Set([parent.id]));
  // child.setFloorLevel未呼び出し = null = 親と同じ実効FL

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2450, 'FL差が無ければ親CHではなくgraph.defaultCeilingHeightへ通常どおりフォールバックするはず');
  assert.equal(r.isFallback, true);
});
