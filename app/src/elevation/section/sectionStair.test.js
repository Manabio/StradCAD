// sectionStair.js（WP-E3: stairContribution / stairPrimitivesForCut）の単体テスト。
// §9「WP-E3のみ階段fixture経由可」に従い、elevationStairSequence.test.jsと同じ折返し階段
// フィクスチャ（makeSwitchbackFixture）を再利用する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { stairContribution, stairPrimitivesForCut } from './sectionStair.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// elevationStairSequence.test.jsのmakeSwitchbackFixtureと同一構成（コメントも参照）。
function makeSwitchbackFixture(graph, structure = StructuralMaterialType.WOOD) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });

  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);

  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);

  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false, structure,
  });
  return { room, stair };
}

const FLOOR_HEIGHT = 2400;

test('【WP-E3】stairContribution: SWITCHBACKフィクスチャからflights(2本)・landings(1件)が組み立つ', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c);
  assert.equal(c.flights.length, 2);
  assert.equal(c.landings.length, 1);
  assert.equal(c.flights[0].steps, 6, '往路の段数=sections[0]=6のはず');
  assert.equal(c.flights[1].steps, 6, '復路の段数=sections[2]=6のはず');
});

test('【失敗系・WP-E3】stairContribution: SWITCHBACK以外はnull', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.type = StairType.STRAIGHT; // 型を直接差し替えて非対応タイプを模す
  assert.equal(stairContribution(stair, graph, FLOOR_HEIGHT), null);
});

test('【失敗系・WP-E3】stairContribution: floorHeight未確定(null)はnull', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  assert.equal(stairContribution(stair, graph, null), null);
});

// ---- レーン縦断→ジグザグ ----
test('【WP-E3】stairPrimitivesForCut: 往路レーンを縦断する切断はSILHOUETTEのジグザグpolylineを1本返す', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 1);
  assert.equal(prims[0].type, 'polyline');
  assert.equal(prims[0].weight, 'medium', 'ジグザグはSILHOUETTE(medium)のはず');
  assert.equal(prims[0].points.length, 1 + 2 * 6, '往路の段数(6)ぶんの蹴上・踏面点があるはず');
});

// ---- 横切る→梯子（段数=steps） ----
test('【WP-E3】stairPrimitivesForCut: 往路レーンを横切る切断はDETAILの梯子（steps本）を返す', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 6, '往路の段数(steps=6)ぶんの梯子線のはず');
  for (const p of prims) {
    assert.equal(p.type, 'line');
    assert.equal(p.weight, 'thin', '梯子はDETAIL(thin)のはず');
  }
});

// ---- 踊り場→CUT床線 ----
test('【WP-E3】stairPrimitivesForCut: 踊り場を縦断する切断はCUTの床水平線を1本返す', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 1);
  assert.equal(prims[0].type, 'line');
  assert.equal(prims[0].weight, 'thick', '踊り場の床線はCUT(thick)のはず');
  assert.equal(prims[0].y1, -c.landings[0].z);
  assert.equal(prims[0].y2, -c.landings[0].z);
});

// ---- ささらはSTEELのみ（失敗系WOODで0本） ----
test('【WP-E3】stairPrimitivesForCut: structure=STEELならジグザグに加えてささら(stringer polyline)が1本増える', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 2, 'ジグザグ本体(1) + ささら(1) = 2本のはず');
  const stringer = prims.find(p => p.weight === 'thick');
  assert.ok(stringer, 'ささらはCUT(thick)のpolylineのはず');
  assert.equal(stringer.type, 'polyline');
});

test('【失敗系・WP-E3】stairPrimitivesForCut: structure=WOOD(既定)ならささらは0本', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // 既定=WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 1, 'WOODはジグザグ本体のみのはず（ささら0本）');
});

// ---- 失敗系: contribution=null ----
test('【失敗系・WP-E3】stairPrimitivesForCut: contribution=nullは例外を投げず空配列を返す', () => {
  const cut = {
    seqNo: '1', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  assert.deepEqual(stairPrimitivesForCut(null, cut, []), []);
});
