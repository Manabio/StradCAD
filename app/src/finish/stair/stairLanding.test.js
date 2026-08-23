// stairLanding.js（WP-A1: landingRect / landingEdgeCLsの単一情報源化）の単体テスト。
// フィクスチャは elevation/section/sectionStair.test.js の makeSwitchbackFixture と同一構成
// （移設対象の式が同じ計算をするか突き合わせるため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { generateRoomWallsFromOutline } from '../wallGeneration.js';
import { landingRect, landingEdgeCLs, landingZ } from './stairLanding.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// elevation/section/sectionStair.test.jsのmakeSwitchbackFixtureと同一構成（コメントも参照）。
// landingKey(x:0-2000,y:0-1500)＝踊り場、outboundKey/returnKey(y:1500-4500)＝往路・復路レーン。
function makeSwitchbackFixture(graph) {
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
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  return { room, stair, ids: { x0, xm, x1, y0, ym, y1 } };
}

test('【WP-A1】landingRect: SWITCHBACKフィクスチャの踊り場矩形はlandingKeyのcellBounds(x:0-2000,y:0-1500)と一致する', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const rect = landingRect(stair, graph);
  assert.ok(rect);
  assert.deepEqual(rect, { x1: 0, y1: 0, x2: 2000, y2: 1500 });
});

test('【失敗系・WP-A1】landingRect: SWITCHBACK以外はnull', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.setField('type', StairType.STRAIGHT);
  assert.equal(landingRect(stair, graph), null);
});

test('【失敗系・WP-A1】landingRect: stair.cellsが空はnull（roomBoundsが非有限になり例外を投げない）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.setCells(new Set());
  assert.equal(landingRect(stair, graph), null);
});

test('【WP-A1】landingEdgeCLs: 4辺のうちレーン(outbound/return)に接する側(ym)がfront・反対側(y0)がback・残り2辺(x0/x1)がside', () => {
  const graph = makeGraph();
  const { stair, ids } = makeSwitchbackFixture(graph);
  const edges = landingEdgeCLs(stair, graph);
  assert.ok(edges);
  assert.equal(edges.length, 4);

  const front = edges.find(e => e.kind === 'front');
  const back = edges.find(e => e.kind === 'back');
  const sides = edges.filter(e => e.kind === 'side');
  assert.ok(front && back, 'front/backが1辺ずつあるはず');
  assert.equal(sides.length, 2, 'side辺が2つあるはず');

  assert.equal(front.axisCL, String(ids.ym.id), 'frontはレーンとの境界(ym)のはず');
  assert.equal(back.axisCL, String(ids.y0.id), 'backは反対側(y0)のはず');
  assert.equal(front.isVertical, false, 'front/backは走行軸に直交＝水平CL(isVertical=false)のはず');
  assert.equal(back.isVertical, false);

  const sideAxisIds = sides.map(e => e.axisCL).sort();
  assert.deepEqual(sideAxisIds, [String(ids.x0.id), String(ids.x1.id)].sort(),
    'side辺2本のaxisCLは x0/x1（幅方向の外周）のはず');
  for (const s of sides) assert.equal(s.isVertical, true, 'side辺は走行軸に平行＝垂直CL(isVertical=true)のはず');
});

test('【WP-A1】landingEdgeCLs: front/back辺のclStart/clEndは幅方向の外周(x0/x1)、side辺のclStart/clEndは走行方向の外周(y0/ym)', () => {
  const graph = makeGraph();
  const { stair, ids } = makeSwitchbackFixture(graph);
  const edges = landingEdgeCLs(stair, graph);
  const front = edges.find(e => e.kind === 'front');
  const back = edges.find(e => e.kind === 'back');
  for (const e of [front, back]) {
    assert.deepEqual([e.clStart, e.clEnd].sort(), [String(ids.x0.id), String(ids.x1.id)].sort());
  }
  const sides = edges.filter(e => e.kind === 'side');
  for (const e of sides) {
    assert.deepEqual([e.clStart, e.clEnd].sort(), [String(ids.y0.id), String(ids.ym.id)].sort());
  }
});

test('【失敗系・WP-A1】landingEdgeCLs: SWITCHBACK以外はnull', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.setField('type', StairType.WINDING);
  assert.equal(landingEdgeCLs(stair, graph), null);
});

test('【失敗系・WP-A1】landingEdgeCLs: stairがnullでも例外を投げずnull', () => {
  const graph = makeGraph();
  assert.equal(landingEdgeCLs(null, graph), null);
});

// ---- landingZ（WP-B2: 踊り場受け梁の既定天端レベル算出）----
// フィクスチャはsections:[6,1,6]（n1=6・totalSteps=12）。floorHeight=2400なら
// riser=2400/12=200、landingZ=n1*riser=6*200=1200（elevation/section/sectionStair.test.jsの
// FLOOR_HEIGHT=2400と揃えた既知値。同フィクスチャのanchorZs検証コメント参照）。
test('【WP-B2】landingZ: floorHeight=2400・sections=[6,1,6]ならn1(6)×riser(200)=1200', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  assert.equal(landingZ(stair, graph, 2400), 1200);
});

test('【WP-B2】landingZ: stair.riserが明示指定されていればfloorHeightより優先する', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.setField('riser', 180);
  assert.equal(landingZ(stair, graph, 2400), 6 * 180);
});

test('【失敗系・WP-B2】landingZ: SWITCHBACK以外はnull', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.setField('type', StairType.STRAIGHT);
  assert.equal(landingZ(stair, graph, 2400), null);
});

test('【失敗系・WP-B2】landingZ: floorHeightがnullかつstair.riser未指定ならriserが求まらずnull', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  assert.equal(landingZ(stair, graph, null), null);
});
