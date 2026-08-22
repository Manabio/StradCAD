// switchbackCuts.js（WP-E5）の単体テスト。elevationStairSequence.test.jsと同じフィクスチャ方針。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../../../finish/wallGeneration.js';
import { composeRoomFaces } from '../../elevationFaceList.js';
import { switchbackCuts } from './switchbackCuts.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// elevationStairSequence.test.jsのmakeSwitchbackFixtureと同一構成。
function makeSwitchbackFixture(graph, { withMidWall = false, midWallGraph = null } = {}) {
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

  let midWall = null;
  if (withMidWall) {
    if (midWallGraph) {
      // WP-E5b: 断面エンジンのレイキャストはupperGraph側にRoomが無いとその層の壁候補を
      // 丸ごとスキップするため（sectionProbe.js）、1F同様の3セル・RoomをupperGraphにも登録する。
      const ux0 = midWallGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
      const uxm = midWallGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
      const ux1 = midWallGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
      const uy0 = midWallGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
      const uym = midWallGraph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
      const uy1 = midWallGraph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
      const uLandingKey  = `${ux0.id}:${uy0.id}:${ux1.id}:${uym.id}`;
      const uOutboundKey = `${ux0.id}:${uym.id}:${uxm.id}:${uy1.id}`;
      const uReturnKey   = `${uxm.id}:${uym.id}:${ux1.id}:${uy1.id}`;
      midWallGraph.addRoom(new Set([uLandingKey, uOutboundKey, uReturnKey]), '2F');
      midWall = midWallGraph.addWall(uxm, 50, true, uym, 0, uy1, 0, {});
    } else {
      midWall = graph.addWall(xm, 50, true, ym, 0, y1, 0, {}); // axisOffset=0だとmaterialRange幅が0になるため50
    }
  }

  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  return { room, stair, midWall };
}

const OPTS = { floorHeight: 2400, chUpperAbsMm: 4800, chLowerMm: 2400 };

test('【WP-E5】switchbackCuts: 往復間の壁が無ければcuts=[1,2,3,4,5]', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const result = switchbackCuts(stair, faces, graph, OPTS);
  assert.ok(result);
  assert.deepEqual(result.cuts.map(c => c.seqNo), ['1', '2', '3', '4', '5']);
});

test('【WP-E5】switchbackCuts: 往復間の壁があればcuts=[1,2,2.5,3,4,4.5,5]', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);
  const result = switchbackCuts(stair, faces, graph, OPTS);
  assert.ok(result);
  assert.deepEqual(result.cuts.map(c => c.seqNo), ['1', '2', '2.5', '3', '4', '4.5', '5']);
});

test('【WP-E5】switchbackCuts: 各cutのbaseFloorZ/zRangeが§6.1表どおり', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const result = switchbackCuts(stair, faces, graph, OPTS);
  const byNo = Object.fromEntries(result.cuts.map(c => [c.seqNo, c]));
  assert.equal(byNo['1'].baseFloorZ, result.landingAbs);
  assert.equal(byNo['2'].baseFloorZ, 0);
  assert.equal(byNo['3'].baseFloorZ, result.landingAbs);
  assert.equal(byNo['4'].baseFloorZ, result.landingAbs);
  assert.equal(byNo['5'].baseFloorZ, result.landingAbs);
  for (const c of result.cuts) assert.equal(c.zRange.hiZ, OPTS.chUpperAbsMm);
});

test('【WP-E5】switchbackCuts: upperGraph経由でmidWallが検出されればcuts=2.5/4.5を含む', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph });
  const faces = composeRoomFaces(room, graph);
  const result = switchbackCuts(stair, faces, graph, { ...OPTS, upperGraph });
  assert.ok(result.wall, 'upperGraph.walls経由でmidWallが見つかるはず');
  assert.deepEqual(result.cuts.map(c => c.seqNo), ['1', '2', '2.5', '3', '4', '4.5', '5']);
});

test('【WP-E5】switchbackCuts: 腰壁指定はkneeDropが解決される', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair, midWall } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph });
  const faces = composeRoomFaces(room, graph);
  upperGraph.setKneeDropWall(
    edgeKey(midWall.axisCL.id, midWall.clStart.id, midWall.clEnd.id),
    { knee: { topHeight: 900 } },
  );
  const result = switchbackCuts(stair, faces, graph, { ...OPTS, upperGraph });
  assert.ok(result.kneeDrop?.knee);
  assert.equal(result.kneeDrop.knee.topHeight, 900);
});

// ---- 失敗系 ----
test('【失敗系・WP-E5】switchbackCuts: SWITCHBACK以外はnull', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setField('type', StairType.STRAIGHT);
  const faces = composeRoomFaces(room, graph);
  assert.equal(switchbackCuts(stair, faces, graph, OPTS), null);
});

test('【失敗系・WP-E5】switchbackCuts: floorHeight未確定(null)はnull', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  assert.equal(switchbackCuts(stair, faces, graph, { ...OPTS, floorHeight: null }), null);
});

test('【失敗系・WP-E5】switchbackCuts: stair.cellsが空はnull', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setCells(new Set());
  const faces = composeRoomFaces(room, graph);
  assert.equal(switchbackCuts(stair, faces, graph, OPTS), null);
});

test('【失敗系・WP-E5】switchbackCuts: stairがnullはnull', () => {
  const graph = makeGraph();
  const { room } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  assert.equal(switchbackCuts(null, faces, graph, OPTS), null);
});
