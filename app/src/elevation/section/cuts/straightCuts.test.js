// straightCuts.js（WP-E6: STRAIGHT/STRAIGHT_LANDINGの切断定義表）の単体テスト。
// switchbackCuts.test.jsと同じフィクスチャ方針（Plane/PlanGraph+finish/wallGeneration.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { generateRoomWallsFromOutline } from '../../../finish/wallGeneration.js';
import { composeRoomFaces } from '../../elevationFaceList.js';
import { makeProbeContext } from '../sectionProbe.js';
import { buildColumns } from '../sectionEngine.js';
import { stairPrimitivesForCut } from '../sectionStair.js';
import { straightCuts } from './straightCuts.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// 単純な矩形の直進階段室（x:[0,1000], y:[0,3000]）。upDirection='up'（t=0=y=3000(下端=上り口)、
// t=1=y=0(上端=到達端)）。
function makeStraightFixture(graph, { type = StairType.STRAIGHT, sections = null } = {}) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const cells = new Set([key]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type, cells, roomId: room.id, upDirection: 'up', flip: false, sections,
  });
  return { room, stair };
}

const OPTS = { floorHeight: 2400, chUpperAbsMm: 4800 };

// ---- STRAIGHT: seq[1,2,3,4] ----
test('【WP-E6】straightCuts: STRAIGHTはseqNo [1,2,3,4] の4件を返す', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const result = straightCuts(stair, faces, graph, OPTS);
  assert.ok(result, 'STRAIGHT+実測+floorHeightありでnullにならないはず');
  assert.deepEqual(result.cuts.map(c => c.seqNo), ['1', '2', '3', '4']);
});

// ---- STRAIGHT: seq2の断面ジグザグ（SILHOUETTE polyline） ----
test('【WP-E6】straightCuts: seq2(側面プロファイル)は断面ジグザグ(SILHOUETTE polyline)を含む', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const result = straightCuts(stair, faces, graph, OPTS);
  const seq2 = result.cuts.find(c => c.seqNo === '2');
  const probeCtx = makeProbeContext(seq2.layers);
  const columns = buildColumns(seq2, probeCtx);
  const prims = stairPrimitivesForCut(seq2.stairCut, seq2, columns);
  const zigzag = prims.filter(p => p.type === 'polyline' && p.weight === 'medium');
  assert.equal(zigzag.length, 1, '直進1区間の踏面ジグザグが1本出るはず');
  assert.ok(zigzag[0].points.length >= 4, '蹴上・踏面を含む点列のはず');
});

// ---- 2層範囲: zRangeが0〜chUpperAbsMm(=2層分の高さ)を全cutで共有する ----
test('【WP-E6】straightCuts: 全cutのzRangeが0〜chUpperAbsMm(2層分)になる', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const result = straightCuts(stair, faces, graph, OPTS);
  for (const cut of result.cuts) {
    assert.equal(cut.zRange.loZ, 0);
    assert.equal(cut.zRange.hiZ, OPTS.chUpperAbsMm);
  }
});

// ---- STRAIGHT_LANDING: 踊り場壁が無ければseq3(踊り場壁)は挿入されない ----
test('【WP-E6】straightCuts: STRAIGHT_LANDINGは踊り場壁が無ければseqNo [1,2,4,5]になる（3は踊り場壁専用）', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph, { type: StairType.STRAIGHT_LANDING, sections: [12, 1, 2] });
  const faces = composeRoomFaces(room, graph);

  const result = straightCuts(stair, faces, graph, OPTS);
  assert.ok(result);
  assert.deepEqual(result.cuts.map(c => c.seqNo), ['1', '2', '4', '5']);
  assert.equal(result.contribution.landings.length, 1, '踊り場自体(Landing)はcontributionに含まれるはず');
});

// ---- STRAIGHT_LANDING: 踊り場壁が実在すればseq3(踊り場面)が挿入され、踊り場床CUT線が出る ----
test('【WP-E6】straightCuts: 踊り場壁が実在すればseq3(踊り場面)が挿入され、seq2に踊り場床のCUT水平線が出る', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph, { type: StairType.STRAIGHT_LANDING, sections: [12, 1, 2] });
  const faces = composeRoomFaces(room, graph);

  // 1パス目: 踊り場壁なしでcontributionを求め、踊り場の位置(landing.z・straightCuts.jsの
  // landingWorld=W(tRun1,0.5)の世界y座標=upDirection='up'なのでtが進むほどyは減るため
  // landing.runHi側)を確定する（straightCuts自身が導出した値をそのまま使う——ハードコードした
  // 座標だと許容差(300mm)を外れてfindLandingWallが壁を見つけられない）。
  const pass1 = straightCuts(stair, faces, graph, OPTS);
  const landingZ = pass1.contribution.landings[0].z;
  const landingWorldY = pass1.contribution.landings[0].runHi;

  // 2パス目: 踊り場位置に実壁を追加してから再実行する。
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, landingWorldY, { labeled: false, discipline: Discipline.ARCH });
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  graph.addWall(ym, 50, false, x0, 0, x1, 0, { isRoomWall: false, isExteriorWall: false });

  const result = straightCuts(stair, faces, graph, OPTS);
  assert.ok(result);
  assert.deepEqual(result.cuts.map(c => c.seqNo), ['1', '2', '3', '4', '5'],
    `踊り場位置に実壁があればseq3が挿入されるはず（実際:${JSON.stringify(result.cuts.map(c => c.seqNo))}）`);
  const seq3 = result.cuts.find(c => c.seqNo === '3');
  assert.equal(seq3.face.hasRealWall, true, '踊り場面(seq3)は実壁背景のはず');

  // 踊り場床のCUT水平線: seq2(側面プロファイル)のcontentに、z=landingZ(絶対z=-landingZのy)の
  // CUT(太線)水平線が出る（landingCutPrimitives。sectionStair.js。型非依存で既にテスト済みの
  // ロジックをstraightCuts経由の実データで確認する）。
  const seq2 = result.cuts.find(c => c.seqNo === '2');
  const probeCtx = makeProbeContext(seq2.layers);
  const columns = buildColumns(seq2, probeCtx);
  const prims = stairPrimitivesForCut(seq2.stairCut, seq2, columns);
  const landingCut = prims.find(p =>
    p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === -landingZ);
  assert.ok(landingCut, `踊り場床のCUT水平線(y=${-landingZ})があるはず（実際:${JSON.stringify(prims.filter(p => p.type === 'line' && p.weight === 'thick'))}）`);
});

// ---- 失敗系: SWITCHBACK・WINDING等（対象外タイプ）はnull ----
test('【失敗系・WP-E6】straightCuts: WINDING(扇形レーンを持つ回り階段)はnullを返す', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  stair.setField('type', StairType.WINDING);
  const faces = composeRoomFaces(room, graph);

  assert.equal(straightCuts(stair, faces, graph, OPTS), null);
});

test('【失敗系・WP-E6】straightCuts: SWITCHBACKはnullを返す（switchbackCuts.jsの担当）', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  stair.setField('type', StairType.SWITCHBACK);
  const faces = composeRoomFaces(room, graph);

  assert.equal(straightCuts(stair, faces, graph, OPTS), null);
});

// ---- 失敗系: stair.cellsが空・floorHeight未確定はnull ----
test('【失敗系・WP-E6】straightCuts: stair.cellsが空はnullを返す', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  stair.setCells(new Set());
  const faces = composeRoomFaces(room, graph);

  assert.equal(straightCuts(stair, faces, graph, OPTS), null);
});

test('【失敗系・WP-E6】straightCuts: opts.floorHeightがnullはnullを返す', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph);
  const faces = composeRoomFaces(room, graph);

  assert.equal(straightCuts(stair, faces, graph, { chUpperAbsMm: 4800 }), null);
});

// ==== QA実機フィードバック修正: dirSignは部屋のコンパス向き（letterOf基準）ではなく階段自身の
// 歩行方向（上り口(t=0)→到達端(t=1)）から独立に導出する（reorientFace。switchbackCuts.js参照）。
// 既存のmakeStraightFixture（upDirection='up'）はたまたま部屋の向きと歩行方向が一致し不具合が
// 顕在化しないため、upDirection='down'（同じ部屋形状で歩行方向だけ反転）で検証する。====
test('【QA修正・実機フィードバック】straightCuts: seq2の面は上り口(entryWorld)がローカルx=0側になる（部屋のコンパス向きに関わらず）', () => {
  const graph = makeGraph();
  const { room, stair } = makeStraightFixture(graph, { type: StairType.STRAIGHT });
  stair.setField('upDirection', 'down'); // 部屋の向きは変えず歩行方向だけ反転する
  const faces = composeRoomFaces(room, graph);

  const result = straightCuts(stair, faces, graph, OPTS);
  assert.ok(result);
  const seq2 = result.cuts.find(c => c.seqNo === '2');
  const entryWorld = 0;    // upDirection='down'はcoordAt(t)=b.y1+t*(b.y2-b.y1)なのでt=0はb.y1=0
  const arrivalWorld = 3000;
  const localXOfEntry = (entryWorld - seq2.face.originWorld) * seq2.face.dirSign;
  const localXOfArrival = (arrivalWorld - seq2.face.originWorld) * seq2.face.dirSign;
  assert.ok(localXOfEntry < localXOfArrival,
    `上り口がローカルx=0側(左)・到達端が右側のはず（上り口局所x=${localXOfEntry}, 到達端局所x=${localXOfArrival}）`);
});
