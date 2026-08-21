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

// ---- 失敗系: 循環参照（A→B→A・双方CH指定なし・FL同一）でも無限再帰せずdefaultへ落ちる ----
// 問題修正2026-08でFL差条件を撤廃し、部分指定の親参照の再帰が常時走るようになったため、
// _depth<8の循環ガードは実装の前提条件——テストで固定する（QA F7）。
test('【失敗系】roomCeilingHeight: 循環参照（A⇔B・双方CH指定なし）でも無限再帰せずdefaultCeilingHeightへフォールバックする', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2450);
  const a = graph.addRoom(new Set(), 'A');
  const b = graph.addRoom(new Set(), 'B', undefined, new Set([a.id]));
  a.referenceRoomIds.add(b.id); // 循環を作る

  const r = roomCeilingHeight(graph, a);
  assert.equal(r.mm, 2450, '循環は_depth上限で打ち切られdefaultへ落ちるはず');
  assert.equal(r.isFallback, true);
});

// ---- 親も部分指定の2世代チェーン（FL同一）は祖父の明示CHへ遡って揃う ----
test('roomCeilingHeight: 親も部分指定の2世代チェーン（FL同一・中間にCH指定なし）は祖父の明示CHへ揃う', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2450);
  const grand = graph.addRoom(new Set(), 'LDK');
  grand.setOverride('ceilingHeight', '2400');
  const parent = graph.addRoom(new Set(), '中間エリア', undefined, new Set([grand.id]));
  const child = graph.addRoom(new Set(), '孫エリア', undefined, new Set([parent.id]));

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2400, '中間を再帰的に解決し祖父の明示CH(2400)へ揃うはず');
  assert.equal(r.isFallback, false);
});

// ---- 問題修正2026-08: floorLevelが親と同じ部分指定（自CH指定なし）も親CHへ揃える ----
// 旧仕様はFL差がある場合しか段差調整せず、FL同一の部分指定がdefaultCeilingHeight(2450)へ落ちて
// 親(2400)と異なるCHになっていた——展開図の区間別天井描画（区間のchMmに追従）で、床材違い
// エリア等に偽の天井段差(50mm)が生じる原因のため、自CH指定が無ければ常に親の天井へ揃える。
test('【問題修正2026-08】roomCeilingHeight: floorLevelが親と同じ部分指定（自CH指定なし）はdefaultではなく親CHへ揃える', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2450);
  const parent = graph.addRoom(new Set(), 'LDK');
  parent.setOverride('ceilingHeight', '2400');
  const child = graph.addRoom(new Set(), '床材違いエリア', undefined, new Set([parent.id]));
  // child.setFloorLevel未呼び出し = null = 親と同じ実効FL

  const r = roomCeilingHeight(graph, child);
  assert.equal(r.mm, 2400, 'FL差が無くても親CHへ揃える（defaultへ落とすと展開図に偽の天井段差が出る）');
  assert.equal(r.isFallback, false, '親のCHが明示指定なのでfallbackではないはず');
});
