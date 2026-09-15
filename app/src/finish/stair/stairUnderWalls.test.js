// 階段下部屋（2a）の壁生成のうち、壁の**向き**の規約に関するテスト。
//
// 2a壁は帯（オーナー壁＋仕上げのみの薄壁）を軸CLに対して非対称に置く偏芯壁で、
// 薄壁の仕上げ面がどちら側を向くかは axisOffset の符号からは導けない場合がある
// （Wall.faceDirOr の既定は sign(axisOffset)）。向きが逆になると面線と内側線が
// 入れ替わり、取り合い（renderer/wallJunctionResolve.js パス2）が帯の外形線を
// 内側線として扱ってしまう。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { LANE_CLEARANCE, laneStairSideThinProps } from './stairUnderWalls.js';
import { cellsBeyondBreak } from './stairGeometry.js';
import { regenerateWalls, loadMaterialMap } from '../wallRegeneration.js';

function makeWall(axisOffset, props) {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const axisCL = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clA = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clB = g.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  return g.addWall(axisCL, axisOffset, true, clA, 0, clB, 0, { isRoomWall: true, ...props });
}

for (const sign of [1, -1]) {
  test(`ルール6の階段側仕上げ薄壁(sign=${sign}): 帯は [CL+sign*50, CL+sign*(50+f_st)]・仕上げ面は階段側(CL寄り)を向く`, () => {
    const stFinish = 12.5;
    const { axisOffset, ...props } = laneStairSideThinProps(sign, stFinish);
    const w = makeWall(axisOffset, props);

    const near = sign * LANE_CLEARANCE;               // CL寄りの端＝階段側の仕上げ面
    const far  = sign * (LANE_CLEARANCE + stFinish);  // 部屋側の端＝下地と接する内側線
    assert.deepEqual(w.materialRange,
      { lo: Math.min(near, far), hi: Math.max(near, far) },
      '材の帯は逃げ量50mmの外側に仕上げ厚ぶんだけ載るはず');
    assert.equal(w.axisValue, near, '仕上げ面は帯のCL寄りの端（階段側）にあるはず');
    assert.equal(w.faceDir, -sign, '仕上げ面は階段側（部屋と逆向き）を向くはず');
    assert.equal(w.axisValue - w.faceDir * w.wallFinish, far,
      '内側線（仕上げ／下地の境界）は帯の部屋寄りの端にあるはず');
  });
}

// ---- 冪等性: finish/wallRegeneration.js の regenerateWalls を連続で呼んでも壁が変化しない ----
// フィクスチャは elevation/elevationStair.test.js の makeHiddenWallStairFixture と同一構成
// （SWITCHBACK・L字部屋＋returnKeyが階段下部屋（2a）。同じ構成の実績があるため流用）。
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
  return { graph, room, stair, under };
}

// axisCLId・axisOffset・startOffset・endOffset・backingDepth・finishSide を全壁（2a壁含む）
// 分ソートして比較する。claim（stairUnderClaimedEdges）の安定性はここに直接現れないが、
// claimが変われば underEdges（開口辺フィルタ）経由で隣室壁・2a壁いずれかの形状が変わる
// ため、全壁ダイジェストの一致が claim を含めた再生成手順全体の冪等性を裏付ける。
function wallDigest(graph) {
  return graph.walls
    .map(w => ({
      axisCLId: w.axisCL.id, axisOffset: w.axisOffset,
      startOffset: w.startOffset, endOffset: w.endOffset,
      backingDepth: w.backingDepth, finishSide: w.finishSide,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('regenerateWalls: 階段下部屋(2a)を含む構成で連続2回呼び出しても壁の帯（axisCLId・axisOffset・startOffset・endOffset・backingDepth）は変化しない（冪等）', async () => {
  const { graph, stair, under } = makeStairUnderFixture();
  const materialMap = await loadMaterialMap();
  const stairUnderEntries = [{ stair, room: under, splitCLIds: new Set() }];

  const first = await regenerateWalls(graph, { materialMap, stairUnderEntries });
  assert.equal(first.regenerated, true, '前提: materialMapありなのでregenerated:true');
  assert.ok(first.undoFns.length > 0, '前提: 1回目で壁が生成される（undoFnsが積まれる）');
  const digest1 = wallDigest(graph);
  assert.ok(digest1.length > 0, '前提: 壁が1本以上生成されている');

  await regenerateWalls(graph, { materialMap, stairUnderEntries });
  const digest2 = wallDigest(graph);

  assert.deepEqual(digest2, digest1);
});

// ステップ3裁定「案B」（2026-09-15）: 2a壁の「一度生成したら不変」を撤廃し、他の壁と同じく
// 脱出のたびに全削除→再生成へ参加させる（専用なのは生成手順＝偏芯・委譲・claim・既存壁との
// 重なりスキップ・後追いトリム・生成順 2a→隣室壁→外壁・描画クリップだけ）。
// 旧テスト「再脱出では2a壁のidが保持される（作り直されない）」はここで期待を反転する:
// 再脱出のたびに2a壁は作り直され wall id は変わるが、生成手順自体は不変のため
// (axisCLId, axisOffset, startOffset, endOffset, backingDepth, finishSide) の
// ソート済みダイジェスト（全壁対象。claimの安定性も間接的に裏付ける）は一致する（冪等）。
test('【ステップ3裁定】regenerateWalls: 再脱出では2a壁のwall idが作り直される（保持されない）が、壁のダイジェストは一致する（冪等）', async () => {
  const { graph, stair, under } = makeStairUnderFixture();
  const materialMap = await loadMaterialMap();
  const stairUnderEntries = [{ stair, room: under, splitCLIds: new Set() }];

  await regenerateWalls(graph, { materialMap, stairUnderEntries });
  const idsAfterFirst = [...under.generatedWallIds].sort();
  assert.ok(idsAfterFirst.length > 0, '前提: 1回目で2a壁が生成されている');
  const digestAfterFirst = wallDigest(graph);

  await regenerateWalls(graph, { materialMap, stairUnderEntries });
  const idsAfterSecond = [...under.generatedWallIds].sort();
  const digestAfterSecond = wallDigest(graph);

  assert.notDeepEqual(idsAfterSecond, idsAfterFirst,
    '再脱出のたびに2a壁は作り直され、wall idは変わる（保持されない）');
  assert.equal(idsAfterSecond.length, idsAfterFirst.length, '2a壁の本数は変わらない');
  assert.deepEqual(digestAfterSecond, digestAfterFirst,
    'idは変わっても壁の帯（形状）は再脱出前後で一致する（冪等）');
});

// ---- 退化構成: 同一Roomの beyond セルへ2つのStairが掛かる（stairUnderEntriesが同じroomを2件返す）----
// makeStairUnderFixture と同じ SWITCHBACK/L字部屋/2a部屋（under）に加えて、cellsを持たない
// 別のStair（stairB。STRAIGHT・cells:空）をもう1件同じ under に対して登録する。stairBは
// buildUTurnContext（SWITCHBACK/WINDING限定）の対象外のため、stairAが担う「ルール6:
// レーン間中心線」の委譲判定に加わらない別経路（isDelegatedEdgeの通常判定）でunderの境界を
// 扱う——結果としてstairAのみの場合と壁本数が変わる（後述のfailure pathで固定）。
function makeDegenerateTwoStairFixture() {
  const { graph, room, stair: stairA, under } = makeStairUnderFixture();
  const stairB = graph.addStair({ type: StairType.STRAIGHT, cells: new Set(), roomId: null, totalSteps: 12 });
  return { graph, room, stairA, stairB, under };
}

test('【退化構成】regenerateWalls: 同一Roomの beyond セルへ2つのStairが掛かる構成でも連続2回呼び出しは冪等（壁ダイジェスト一致）', async () => {
  const { graph, stairA, stairB, under } = makeDegenerateTwoStairFixture();
  const materialMap = await loadMaterialMap();
  const stairUnderEntries = [
    { stair: stairA, room: under, splitCLIds: new Set() },
    { stair: stairB, room: under, splitCLIds: new Set() },
  ];

  await regenerateWalls(graph, { materialMap, stairUnderEntries });
  const digest1 = wallDigest(graph);
  assert.ok(digest1.length > 0, '前提: 壁が生成されている');

  await regenerateWalls(graph, { materialMap, stairUnderEntries });
  const digest2 = wallDigest(graph);

  assert.deepEqual(digest2, digest1, '同一roomを2件返す退化構成でも連続呼び出しで壁の帯は変化しない（冪等）');
});

test('【退化構成・現行順序の固定】regenerateWalls: [stairA,stairB]の順で処理すると壁13本（under側6本）になる（先に処理されたstairのclaimが勝つ現行実装の値の固定）', async () => {
  const { graph, stairA, stairB, under } = makeDegenerateTwoStairFixture();
  const materialMap = await loadMaterialMap();
  const stairUnderEntries = [
    { stair: stairA, room: under, splitCLIds: new Set() },
    { stair: stairB, room: under, splitCLIds: new Set() },
  ];

  await regenerateWalls(graph, { materialMap, stairUnderEntries });

  assert.equal(graph.walls.length, 13, '現行実装での壁本数の固定値（変わったらこのテストが検知する）');
  assert.equal(under.generatedWallIds.size, 6, '現行実装でのunder側の壁本数の固定値');
});

// 失敗系（トートロジー回避）: stairBを削除して同じフィクスチャで再実行すると壁本数が変わる
// ——上のテストが「stairBの有無に関わらずたまたま同じ値になる」トートロジーでないことを示す。
test('【失敗系・トートロジー回避】regenerateWalls: 退化構成からstairBを除くと壁本数が変わる（12本・under側4本）', async () => {
  const { graph, stair: stairA, under } = makeStairUnderFixture(); // stairBを含まないA単独の同一フィクスチャ
  const materialMap = await loadMaterialMap();
  const stairUnderEntries = [{ stair: stairA, room: under, splitCLIds: new Set() }];

  await regenerateWalls(graph, { materialMap, stairUnderEntries });

  assert.equal(graph.walls.length, 12, 'stairBを除くと壁本数は13ではなく12になる');
  assert.equal(under.generatedWallIds.size, 4, 'stairBを除くとunder側は6ではなく4本になる');
});

// ---- QA U1: stairUnderClaimedEdges廃止後もclaim（generateStairUnderWallsの戻り値claimedEdges）が
// 隣室（階段ペアRoom）の壁生成に正しく反映されることの固定 ----
// 上の【退化構成】は同一roomを2件返す特殊ケースだったが、ここは独立した2組の
// SWITCHBACK＋2a部屋（互いに重ならない座標）を1つのgraphに持つ、より一般的な「2a部屋2件」構成。
function addSwitchbackGroup(graph, xOffset, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, xOffset + 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, xOffset + 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, xOffset + 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const stairCells = new Set([landingKey, outboundKey, returnKey]);
  const roomCells  = new Set([landingKey, outboundKey]);
  const room = graph.addRoom(roomCells, `階段${name}`);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
  const under = graph.addRoom(new Set(beyond), `階段下${name}`);
  return { room, stair, under };
}

test('【QA U1】regenerateWalls: 独立した2a部屋2件の構成で、claim（generateStairUnderWallsの戻り値）が隣室（階段ペアRoom）の壁本数に正しく反映される（固定値・冪等）', async () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const g1 = addSwitchbackGroup(graph, 0, 'A');
  const g2 = addSwitchbackGroup(graph, 3000, 'B');
  const materialMap = await loadMaterialMap();
  const stairUnderEntries = [
    { stair: g1.stair, room: g1.under, splitCLIds: new Set() },
    { stair: g2.stair, room: g2.under, splitCLIds: new Set() },
  ];

  await regenerateWalls(graph, { materialMap, stairUnderEntries });

  assert.equal(graph.walls.length, 26, '壁本数の固定値（変わったらこのテストが検知する）');
  assert.equal(g1.under.generatedWallIds.size, 4);
  assert.equal(g2.under.generatedWallIds.size, 4);
  assert.equal(g1.room.generatedWallIds.size, 4, '隣室（階段ペアRoom）の壁本数。claimがこの値を左右する（観測可能な指標）');
  assert.equal(g2.room.generatedWallIds.size, 4, '隣室（階段ペアRoom）の壁本数。claimがこの値を左右する（観測可能な指標）');

  const digest1 = wallDigest(graph);
  await regenerateWalls(graph, { materialMap, stairUnderEntries });
  assert.deepEqual(wallDigest(graph), digest1, '連続呼び出しでも壁の帯は変化しない（冪等）');
});

test('【失敗系・QA U1・トートロジー回避】regenerateWalls: 片方の2a部屋をstairUnderEntriesから外す（通常部屋に戻す）とclaimが働かなくなり、隣室・総壁本数が変わる', async () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const g1 = addSwitchbackGroup(graph, 0, 'A');
  const g2 = addSwitchbackGroup(graph, 3000, 'B');
  const materialMap = await loadMaterialMap();
  // g2.under を stairUnderEntries から外す＝2a指定を解除し、ステップ2（通常の対称壁）の対象に回す。
  const stairUnderEntries = [{ stair: g1.stair, room: g1.under, splitCLIds: new Set() }];

  await regenerateWalls(graph, { materialMap, stairUnderEntries });

  assert.equal(graph.walls.length, 27, '2a指定を外すと総壁本数は26ではなく27になる');
  assert.equal(g2.under.generatedWallIds.size, 3, '通常部屋化したunder2はステップ2の対称壁本数になる（2aの4本とは異なる）');
  assert.equal(g2.room.generatedWallIds.size, 6, 'claimが働かなくなり隣室（階段ペアRoom）の壁本数が4本→6本に変わる');
});
