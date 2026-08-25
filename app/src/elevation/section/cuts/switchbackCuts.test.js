// switchbackCuts.js（WP-E5）の単体テスト。elevationStairSequence.test.jsと同じフィクスチャ方針。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../../../finish/wallGeneration.js';
import { composeRoomFaces } from '../../elevationFaceList.js';
import { switchbackCuts } from './switchbackCuts.js';
import { cellsBeyondBreak } from '../../../finish/stair/stairGeometry.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// elevationStairSequence.test.jsのmakeSwitchbackFixtureと同一構成。
function makeSwitchbackFixture(graph, { withMidWall = false, midWallGraph = null, withRoomUnder = true } = {}) {
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
  // withRoomUnder（既定true）: 実機確認済みの表現（踊り場が基準床）は「階段下に部屋がある場合」。
  if (withRoomUnder) {
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size > 0) graph.addRoom(new Set(beyond), '階段下');
  }
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

// ==== QA実機フィードバック修正: dirSignは部屋のコンパス向き（letterOf基準）ではなく階段自身の
// 歩行方向（往路(s=0)→復路(s=1)・上り口(t=0)→踊り場(t=tRun)）から独立に導出する（reorientFace）。
// 既存のmakeSwitchbackFixture（x:0-2000,y:0-4500）はseq2/seq4側はたまたま部屋の向きと歩行方向が
// 一致し不具合が顕在化しないため、実機の間取り（幅1500+1500・走行部2500+踊り場1000）を模した
// 別fixtureで検証する（実機スクリーンショットで確認された不具合の再現条件）。====
function makeUserDimsFixture(graph, upDirection = 'up') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`; // 往路レーン x:0-1500
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`; // 復路レーン x:1500-3000
  const cells = new Set([landingKey, outboundKey, returnKey]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [10, 1, 10], riser: null, upDirection, flip: false,
  });
  return { room, stair };
}

test('【QA修正・実機フィードバック】switchbackCuts: seq2の面は上り口(entryWorld)がローカルx=0側になる（部屋のコンパス向きに関わらず）', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  assert.ok(table);
  // entryWorldがwOut1のローカルx=0側（originWorldに一致する側）にあるはず。
  const { wOut1, entryWorld, landingStartWorld } = table;
  const localXOfEntry = (entryWorld - wOut1.originWorld) * wOut1.dirSign;
  const localXOfLanding = (landingStartWorld - wOut1.originWorld) * wOut1.dirSign;
  assert.ok(Math.abs(localXOfEntry) < localXOfLanding,
    `entryWorldがlocalX=0側(上り口=左)のはず（entry局所x=${localXOfEntry}, landing局所x=${localXOfLanding}）`);
});

// upDirection='up'のmakeUserDimsFixtureは(seq2/seq4の走行方向の)コンパスdirSignがたまたま
// 望む向きと一致するため、そのままではreorientFaceが無変化(no-op)になり、値そのものが
// 修正されたことの検証にならない（widthDirSignだけがミスマッチする）。upDirection='down'
// （同じ部屋形状で歩行方向のみ反転）はコンパスdirSignと望む向きが実際に食い違うため、
// このfixtureでreorientFaceが値を反転させたことを直接検証できる。
test('【QA修正・実機フィードバック】switchbackCuts: seq2のdirSignは部屋のコンパス向きが逆でも上り口が左になるよう補正される(upDirection=down)', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph, 'down');
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  assert.ok(table);
  const { wOut1, entryWorld, landingStartWorld } = table;
  const localXOfEntry = (entryWorld - wOut1.originWorld) * wOut1.dirSign;
  const localXOfLanding = (landingStartWorld - wOut1.originWorld) * wOut1.dirSign;
  assert.ok(Math.abs(localXOfEntry) < localXOfLanding,
    `upDirection=down（コンパスdirSignと望む向きが食い違う構成）でもentryWorldがlocalX=0側のはず` +
    `（entry局所x=${localXOfEntry}, landing局所x=${localXOfLanding}）`);
});

test('【QA修正・実機フィードバック】switchbackCuts: seq4の面は踊り場(landingStartWorld)がローカルx=0側になる（seq2の鏡像）', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  const { wOut2, entryWorld, landingStartWorld } = table;
  const localXOfEntry = (entryWorld - wOut2.originWorld) * wOut2.dirSign;
  const localXOfLanding = (landingStartWorld - wOut2.originWorld) * wOut2.dirSign;
  assert.ok(Math.abs(localXOfLanding) < localXOfEntry,
    `landingStartWorldがlocalX=0側(踊り場=左)のはず（entry局所x=${localXOfEntry}, landing局所x=${localXOfLanding}）`);
  assert.equal(wOut2.dirSign, -table.wOut1.dirSign, 'seq4の面はseq2の面と反対のdirSign(鏡像)のはず');
});

test('【QA修正・実機フィードバック】switchbackCuts: seq4のstairCutは往路(outbound=flights[0])——復路(inbound)ではない', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  const seq4 = table.cuts.find(c => c.seqNo === '4');
  assert.ok(seq4.stairCut, 'seq4はstairCutを持つはず');
  assert.equal(seq4.stairCut.flights.length, 1);
  assert.equal(seq4.stairCut.flights[0], table.contribution.flights[0],
    'seq4のFlightはcontribution.flights[0](往路)と同一オブジェクトのはず');
  assert.notEqual(seq4.stairCut.flights[0], table.contribution.flights[1],
    'seq4のFlightはcontribution.flights[1](復路)ではないはず');
});

test('【失敗系・QA修正・実機フィードバック】switchbackCuts: seq5のdirSignはface自身のdirSignに一致する（floorSegments側と食い違わない）', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  const seq5 = table.cuts.find(c => c.seqNo === '5');
  assert.equal(seq5.dirSign, seq5.face.dirSign,
    'cut.dirSignとface.dirSignが一致しないと、content(cut基準)とfloorSegments(face基準)が左右で食い違う');
});

// ==== ユーザー実機フィードバック2026-08-23: 切断線の位置・視線方向の再定義 ====
test('【ユーザー実機フィードバック2026-08-23】switchbackCuts: seq2/2.5/4/4.5の切断線は往路レーン中央(acrossCoordAt(0.25)=500)を共有し、' +
  'seq2/2.5はtowardS1(復路向き=+1)・seq4/4.5はtowardS0(往路外側向き=-1)になる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  const bySeq = Object.fromEntries(table.cuts.map(c => [c.seqNo, c]));

  // フィクスチャ: x0=0,xm=1000,x1=2000（vertical CL）・upDirection='up'・flip=false
  // → 走行軸vertical・幅方向acrossLo=0/acrossHi=2000・往路レーン中央=0.25*2000=500。
  for (const seqNo of ['2', '2.5', '4', '4.5']) {
    assert.equal(bySeq[seqNo].line.axisValue, 500,
      `${seqNo}の切断線は往路レーン中央(x=500)のはず（実際:${bySeq[seqNo].line.axisValue}）`);
    assert.equal(bySeq[seqNo].line.isVertical, true, `${seqNo}の切断線は縦（走行軸と同じ向き）のはず`);
  }
  assert.equal(bySeq['2'].viewSign, 1, 'seq2は復路側(towardS1=+1)を見るはず');
  assert.equal(bySeq['2.5'].viewSign, 1, 'seq2.5もseq2と同じ向き(towardS1=+1)を見るはず（同じ切断線）');
  assert.equal(bySeq['4'].viewSign, -1, 'seq4は往路外側(towardS0=-1)を見るはず');
  assert.equal(bySeq['4.5'].viewSign, -1, 'seq4.5もseq4と同じ向き(towardS0=-1)を見るはず（同じ切断線）');
  // seq5は復路レーン中央(0.75*2000=1500)。
  assert.equal(bySeq['5'].line.axisValue, 1500, 'seq5の切断線は復路レーン中央(x=1500)のはず');
  assert.equal(bySeq['5'].viewSign, 1, 'seq5はtowardS1(+1)を見るはず（現行の向きを踏襲）');
});

test('【ユーザー実機フィードバック2026-08-23・不具合1修正】switchbackCuts: seq2のstairCut.unitがcontribution.unitと同一オブジェクトで引き継がれる' +
  '（switchbackCuts.js:282-285の再構成でunitが落ちていた欠陥の回帰）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  stair.setField('structure', StructuralMaterialType.STEEL);
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  const bySeq = Object.fromEntries(table.cuts.map(c => [c.seqNo, c]));

  assert.ok(table.contribution.unit, '前提: contribution.unitが存在するはず');
  for (const seqNo of ['2', '2.5', '4', '4.5', '5']) {
    assert.equal(bySeq[seqNo].stairCut.unit, table.contribution.unit,
      `${seqNo}のstairCut.unitはcontribution.unitと同一オブジェクトのはず`);
  }
});
