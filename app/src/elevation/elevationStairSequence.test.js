// elevationStairSequence.js（階段=SWITCHBACKの歩行順面シーケンス。WP-S2）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomFeature, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { measureStairSpans } from '../finish/stair/stairClassify.js';
import { cellsBeyondBreak } from '../finish/stair/stairGeometry.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { letterOf } from './elevationFaces.js';
import { stairFaceSequence, kneeWallCapContent, stairChDimChains } from './elevationStairSequence.js';
import { switchbackCuts } from './section/cuts/switchbackCuts.js';
import { buildFaceFigure } from './elevationFigure.js';
import { buildStairBand } from './elevationStair.js';
import { resolveSwitchbackParams } from './elevationStairSection.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';
import { drawnFloorProfileZAt } from './elevationFloorProfile.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// 折返し階段（SWITCHBACK）の3セル構成: 踊り場(全幅・上端y:[0,1500])＋往路レーン(左列・x:[0,1000])＋
// 復路レーン(右列・x:[1000,2000])、いずれもy:[1500,4500]。全体は単純な矩形(x:[0,2000],y:[0,4500])
// になるため generateRoomWallsFromOutline は通常の4面矩形の壁を生成する。
// upDirection='up'（t=0がy=4500=下端=上り口、t=1がy=0=上端=踊り場）・flip=false
// （s=0が左列=往路、s=1が右列=復路）で makeFrame の走行方向と一致させる。
// withRoomUnder（既定true）: 階段下（破れ線先セル）に部屋を指定する。ユーザー実機確認済みの
// 表現（踊り場が基準床・その下は別室＝向こう側なので細破線）は「下に部屋がある場合」のものなので
// （実機指摘2026-08「現時点の描画は下に部屋がある場合」）、既存テストの前提をフィクスチャ側で
// 明示する。falseにすると「下に部屋がない」＝1FLが基準床の表現になる（専用テストで検証）。
// entryGapMm（既定0＝従来構成）: 上り口側の壁を階段の足元からこの距離だけ離す。部屋だけを
// y:4500..4500+entryGapMm ぶん伸ばし（**階段のセルは3つのまま**）、「階段の足元が面の内側に
// ある」構成を作る。既定の3セル構成では階段の走行部が上り口側の壁までいっぱいに広がるため、
// 階段の足元は常に面の端（またはその外）に来てしまい、「レーンの1FL線ははり出し側にだけ残る」
// （flatLineSpanX.loを付けない）という規約を空スパンと区別できない。
function makeSwitchbackFixture(graph, { withMidWall = false, midWallGraph = null, upperLandingOnly = false, withRoomUnder = true, entryGapMm = 0 } = {}) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  // entryGapMm=0（既定）ではCLを1本も増やさない＝従来のフィクスチャとまったく同じグラフになる。
  const y2 = entryGapMm > 0
    ? graph.addCenterLine(CenterLineType.HORIZONTAL, 4500 + entryGapMm, { labeled: false, discipline: Discipline.ARCH })
    : null;

  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);

  // 部屋は（entryGapMm>0なら）上り口側へ1行ぶん広い矩形。階段のcellsは3つのまま。
  const roomCells = new Set(cells);
  if (y2) {
    roomCells.add(`${x0.id}:${y1.id}:${xm.id}:${y2.id}`);
    roomCells.add(`${xm.id}:${y1.id}:${x1.id}:${y2.id}`);
  }
  const room = graph.addRoom(roomCells, '階段');
  generateRoomWallsFromOutline(graph, room);

  let midWall = null;
  if (withMidWall) {
    // ユーザー実機指示（根本的訂正）: 往復間の壁は2F（upperGraph）の壁——midWallGraph省略時は
    // 従来どおりgraph自身（1F。後方互換fallbackの検証用）に置く。
    if (midWallGraph) {
      // upperGraph側にも同座標のCLを新規に作る（値が同じであればfindMidWall/perpFaceAtの
      // effectiveValue/coord1/coord2比較には十分。オブジェクト同一性は問わない）。
      // WP-E5b: 断面エンジンのレイキャスト（probeOwnerRoom）はupperGraph側にRoomが無いと
      // 「視線方向の所有Room不明」としてそのレイヤの壁候補を丸ごとスキップする（sectionProbe.js
      // 「info.ceilZ==null」ガード）——上階の壁を検出させるにはRoom登録が必須なため、1F同様の
      // 3セル・RoomをupperGraph側にも登録する（現実の建物でも階段上部には床/部屋があるのが通常）。
      const ux0 = midWallGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
      const uxm = midWallGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
      const ux1 = midWallGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
      const uy0 = midWallGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
      const uym = midWallGraph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
      const uy1 = midWallGraph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
      const uLandingKey  = `${ux0.id}:${uy0.id}:${ux1.id}:${uym.id}`;
      const uOutboundKey = `${ux0.id}:${uym.id}:${uxm.id}:${uy1.id}`;
      const uReturnKey   = `${uxm.id}:${uym.id}:${ux1.id}:${uy1.id}`;
      // upperLandingOnly: 2Fは踊り場部分にだけ床がある（往路・復路レーンの上は吹抜け＝
      // 一般的な折返し階段の構成。§5.6「2FLのSILHOUETTE水平線」・アキX（open帯）を実際に
      // 発生させるための構成——両セクションともRoomで覆うと常にslab扱いになりopenが出ない）。
      const cellsAbove = upperLandingOnly ? new Set([uLandingKey]) : new Set([uLandingKey, uOutboundKey, uReturnKey]);
      midWallGraph.addRoom(cellsAbove, '2F');
      midWall = midWallGraph.addWall(uxm, 50, true, uym, 0, uy1, 0, {});
    } else {
      midWall = graph.addWall(xm, 50, true, ym, 0, y1, 0, {}); // 往路・復路の間の壁（x=1000、y:[1500,4500]。WP-E5b: axisOffset=0だとmaterialRange幅が0になり一般規則のcutAlong/cut検出が縮退するため50に変更）
    }
  }

  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  if (withRoomUnder) {
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size > 0) graph.addRoom(new Set(beyond), '階段下');
  }
  return { room, stair, midWall };
}

const OPTS = { floorHeight: 2400, chUpperAbsMm: 4800, chLowerMm: 2400 };

// ---- midWallが無ければ ['1','2','3','4','5'] ----
test('stairFaceSequence: 往路・復路の間に壁が無ければ seqNo は [1,2,3,4,5]', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  assert.ok(entries, 'SWITCHBACK+実測spans+floorHeightありでnullにならないはず');
  assert.deepEqual(entries.map(e => e.seqNo), ['1', '2', '3', '4', '5']);
});

// ---- midWallがあれば ['1','2','2.5','3','4','4.5','5'] ----
test('stairFaceSequence: 往路・復路の間に実壁があれば seqNo は [1,2,2.5,3,4,4.5,5]', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  assert.ok(entries);
  assert.deepEqual(entries.map(e => e.seqNo), ['1', '2', '2.5', '3', '4', '4.5', '5']);
});

// ---- リード裁定バグ修正: buildMidWallFaceがloWorld/hiWorldを未ソートでlo/hiに詰めていたため、
// travelSign<0のfixture（このmakeSwitchbackFixtureの構成。entryWorld>landingStartWorld）で
// seq2.5/4.5のface.runが負値になっていた。elevationFaceList.jsの断片化レシピと同じ
// Math.min/max正規化で修正——run>0、かつ幅が上り口端〜踊り場前縁の実距離に一致することを固定する ----
test('【mutation証跡用】stairFaceSequence: travelSign<0のfixtureでもseq2.5/4.5のface.runは正で、上り口端〜踊り場前縁の実距離に近い', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  const seq25 = entries.find(e => e.seqNo === '2.5');
  const seq45 = entries.find(e => e.seqNo === '4.5');
  assert.ok(seq25 && seq45, 'wall実在時はseq2.5/4.5が存在するはず');

  // seq2（wOut1本体。composeRoomFacesから直接得た実際の壁面）のlaneLenOnFace
  // （上り口端〜踊り場前縁の実距離）を、buildMidWallFace経由のseq2.5/4.5と独立に突き合わせる。
  const expectedWidth = seq2.floorSegments[0].hiX;
  assert.ok(seq25.face.run > 0, `seq2.5のface.runは正のはず（実際:${seq25.face.run}）`);
  assert.ok(seq45.face.run > 0, `seq4.5のface.runは正のはず（実際:${seq45.face.run}）`);
  assert.ok(Math.abs(seq25.face.run - expectedWidth) < 200,
    `seq2.5のface.run(${seq25.face.run})は上り口端〜踊り場前縁の実距離(${expectedWidth})に近いはず`);
  assert.ok(Math.abs(seq45.face.run - expectedWidth) < 200,
    `seq4.5のface.run(${seq45.face.run})は上り口端〜踊り場前縁の実距離(${expectedWidth})に近いはず`);
});

// ---- 勾配天井: seq2のceilingProfileは上り口端=chLower・踊り場端=ceilTop ----
test('stairFaceSequence: seq2のceilingProfileは上り口端でchLowerMm・踊り場端でchUpperAbsMmになる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  assert.ok(Array.isArray(seq2.ceilingProfile), 'seq2はceilingProfileを持つはず');
  const first = seq2.ceilingProfile[0];
  const last = seq2.ceilingProfile[seq2.ceilingProfile.length - 1];
  assert.equal(first[0], 0, '上り口端のローカルxは0のはず');
  assert.equal(first[1], OPTS.chLowerMm, '上り口端はchLowerMmのはず');
  assert.equal(last[1], OPTS.chUpperAbsMm, '踊り場端はchUpperAbsMmのはず');
});

// ---- seq1は往路(dashed)・復路(実線)の梯子状踏面線を含む ----
test('stairFaceSequence: seq1(W_entry)は往路(dashed)・復路(実線)の梯子状踏面線を含む', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const ladderLines = seq1.content.filter(p => p.type === 'line' && p.y1 === p.y2 && p.x1 !== p.x2);
  assert.ok(ladderLines.some(l => l.dash === 'dashed'), '往路(踊り場より下)は破線のはず');
  assert.ok(ladderLines.some(l => l.dash === undefined), '復路(踊り場以上)は実線のはず');
});

// ---- 断面線の外は描画しない（ユーザー明示指示2026-09）: 階段下に部屋があるとき、この帯の床は
// 踊り場（landingAbs）で、そこより下の**壁の断面・見えがかり**は描かない（旧・細破線への降格は
// 廃止）。踊り場より上は従来どおりSILHOUETTE実線のまま ----
test('stairFaceSequence: seq1(W_entry・壁無し)は両端(x=0/run)の壁輪郭縦線が踊り場(landingAbs)より下に無い', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  // 踊り場より上(y:-landingAbs..-chLowerMm)の両端は通常のSILHOUETTE(実線)。
  const aboveSilXs = seq1.content
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.dash === undefined && p.weight === silhouetteWeight &&
      Math.abs(p.y1 - (-landingAbs)) < 1e-9 && Math.abs(p.y2 - (-OPTS.chLowerMm)) < 1e-9)
    .map(l => l.x1).sort((a, b) => a - b);
  assert.equal(aboveSilXs.length, 2, '両端の踊り場より上はSILHOUETTE実線のはず');
  assert.ok(Math.abs(aboveSilXs[0] - 0) < 1e-6 && Math.abs(aboveSilXs[1] - seq1.face.run) < 1e-6,
    `踊り場より上のSILHOUETTEは両端(0, ${seq1.face.run})にあるはず（実際:${aboveSilXs}）`);

  // 同じxに、踊り場より下へ伸びる壁の縁は無い（階段自身の見えがかり＝ささらの端面・破線梯子は
  // 別担当で、そちらは踊り場より下も描く）。
  for (const x of aboveSilXs) {
    const below = seq1.content.find(p => p.type === 'line' && p.x1 === p.x2 &&
      Math.abs(p.x1 - x) < 1e-6 && p.weight === silhouetteWeight && -p.y1 < landingAbs - 1e-6);
    assert.ok(!below, `x=${x}の踊り場より下に壁の縁が描かれているはず無い（${JSON.stringify(below)}）`);
  }
});

// ---- WP-E5b書き換え: 一般規則（emitColumnsの'wall'/'cut' band。§5.6）による厚みの2縁を、
// 座標の完全一致ではなく「保存意味論」レベルで確認する——厚みぶん離れた2本の縦線が
// 踊り場(landingAbs)から1F天井(chLowerMm)まで実線(CUT or SILHOUETTE。塞がれ方は隣接列の
// 実際の見えがかりに依存するため一般規則側に委ねる)で描かれ、踊り場より下(0..landingAbs)は
// 同じ2本のxがDETAIL破線へ降格すること（「往復間の壁=cutAlongで検出・実壁厚materialRange…
// seq1では切断線を横切るcutとして厚みの2縁」「踊り場より下の壁断面=細破線」の保存意味論）。 ----
test('stairFaceSequence: seq1(wall実在時)は厚みぶん離れた2本の壁縁が踊り場〜1F天井は実線・踊り場より下はDETAIL破線になる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  // 踊り場(landingAbs)〜1F天井(chLowerMm)の実線縦線（CUTまたはSILHOUETTE＝壁・面端の縁。
  // 面端(x=0/run)の輪郭も同じ高さ範囲に現れるため、その中から「materialRange幅(50)ちょうど
  // 離れたペア」＝壁自身の2縁だけを選び出す）。
  const aboveEdges = seq1.content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && p.dash === undefined &&
    (p.weight === cutWeight || p.weight === silhouetteWeight) &&
    Math.abs(p.y1 - (-landingAbs)) < 1e-9 && Math.abs(p.y2 - (-OPTS.chLowerMm)) < 1e-9);
  const candidateXs = [...new Set(aboveEdges.map(p => p.x1))].sort((a, b) => a - b);
  let aboveXs = null;
  for (let i = 0; i + 1 < candidateXs.length; i++) {
    if (Math.abs((candidateXs[i + 1] - candidateXs[i]) - 50) < 1e-6) { aboveXs = [candidateXs[i], candidateXs[i + 1]]; break; }
  }
  assert.ok(aboveXs, `踊り場〜1F天井にmaterialRange幅(50)ちょうど離れた壁の2縁があるはず（候補:${candidateXs}）`);

  // 踊り場より下(0..landingAbs)には同じ2本のxの壁の縁を描かない（断面線の外）。
  // QA修正2026-09: 除外条件は「太さがDETAILでない」（＝階段自身の見えがかりを太さで避ける）
  // ではなく`__o`の有無で行う——`__o`（cutEdgeLo/Hi・recessLo/Hi）は断面エンジンが壁の縁に
  // だけ付けるマーカー（sectionEmit.js）で、階段自身の見えがかり（ささらの端面・破線梯子）に
  // は付かない。太さで避けていると、壁の縁がDETAILへ降格した場合まで見逃していた。
  const belowXs = seq1.content
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.__o !== undefined &&
      Math.min(-p.y1, -p.y2) < landingAbs - 1e-6)
    .map(p => p.x1);
  for (const x of aboveXs) {
    assert.ok(!belowXs.some(bx => Math.abs(bx - x) < 1e-6),
      `x=${x}の踊り場より下に壁の縁が描かれているはず無い`);
  }
});

// ---- 実機フィードバック第3弾E: seq1（見返り）で踊り場より下の往路レーンにささらの端面(縦の細破線) ----
// 往路flightのacrossLo/acrossHiのうち外側（部屋の実際の外縁）は面端(x=0/run)の壁輪郭縦線
// （既存の別テストで検証済み・降格して同じ高さ範囲にDETAIL破線で現れる）とx位置が一致しうる
// ため、位置では絞らずSTEEL/WOODの本数差（増分2本）で検証する。
test('【実機フィードバック第3弾E】stairFaceSequence: 鉄骨階段のseq1は木造より踊り場より下のDETAIL破線縦線が2本多い（往路ささらの端面ぶん）', () => {
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
  const countEndCapLikeLines = (structure) => {
    const graph = makeGraph();
    const { room, stair } = makeSwitchbackFixture(graph);
    if (structure) stair.setField('structure', structure);
    const faces = composeRoomFaces(room, graph);
    const entries = stairFaceSequence(stair, faces, graph, OPTS);
    const seq1 = entries.find(e => e.seqNo === '1');
    return seq1.content.filter(p =>
      p.type === 'line' && p.x1 === p.x2 && p.dash === 'dashed' && p.weight === detailWeight &&
      Math.abs(p.y1 - 0) < 1e-9 && Math.abs(p.y2 - (-landingAbs)) < 1e-9).length;
  };
  const woodCount = countEndCapLikeLines(null);
  const steelCount = countEndCapLikeLines(StructuralMaterialType.STEEL);
  assert.equal(steelCount - woodCount, 2,
    `STEELは往路ささらの端面(acrossLo/acrossHi)ぶん2本多いはず（wood=${woodCount}・steel=${steelCount}）`);
});

test('【失敗系・実機フィードバック第3弾E】stairFaceSequence: 木造(既定)のseq1はcut.baseFloorZが0の面(seq2)にはささらの端面の破線を出さない', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setField('structure', StructuralMaterialType.STEEL);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2'); // baseFloorZ:0（踊り場より下という概念自体が無い面）
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
  const anyDashedVertical = seq2.content.some(p =>
    p.type === 'line' && p.x1 === p.x2 && p.dash === 'dashed' && p.weight === detailWeight && p.y1 === 0);
  assert.equal(anyDashedVertical, false,
    'seq2はbaseFloorZ=0のため「踊り場より下」区間が無く、端面の破線(z=0起点)は出ないはず');
});

test('stairFaceSequence: seq1(wall実在時)は壁の見え側に1階天井線(中線)、往路レーン側に2FL(中線)を描く', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  const firstFloorCeilLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-OPTS.chLowerMm)) < 1e-9);
  assert.ok(firstFloorCeilLine, '壁の見え側の1階天井線(中線・水平)が見つからない');

  const secondFlLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-OPTS.floorHeight)) < 1e-9);
  assert.ok(secondFlLine, '往路レーン側の2FL線(中線・水平)が見つからない');
});

// ---- 実機フィードバック第3弾A2で書き換え: WP-E5b時点の一般規則は「見えがかり壁の上端は
// 常に自層(1F階段室)のCHで水平キャップする」実装だったため、above層が実際にはslab
// （非描画・視線を遮る実体なし）であっても、往路・復路レーン上に「1F天井線」と「2FL線
// （above層の床端）」という2本の水平線が別々に現れていた——しかしupperLandingOnly構成
// （2F床=踊り場のみ、レーン上は吹抜け）では、レーン上に立つ壁（entry壁）はそもそも
// 1F天井高さで途切れる理由が無く、物理的には上階天井まで連続しているのが正しい
// （sectionProbe.jsのresolveWallCapZ・根本原因: probeColumnがwall候補の上端をinfo.ceilZ
// ＝自層CHで無条件に切っていた）。修正後は「1F天井高さ(-chLowerMm)ちょうどの水平キャップ線」
// が消え、壁は上階天井(-chUpperAbsMm)まで届く1本の水平キャップになる。
test('【実機フィードバック第3弾A2】stairFaceSequence: seq1の壁は2Fレーン上に床が無ければ1F天井高さで水平キャップされず、上階天井まで連続する', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);
  // floorHeight(2FL)を自室の既定天井高さ(2400)とは別の値にして、両者の取り違えを検知できる
  // ようにする（旧テストのQA指摘を踏襲）。
  const localOpts = { floorHeight: 2600, chUpperAbsMm: 5000, chLowerMm: 2400 };

  const entries = stairFaceSequence(stair, faces, graph, { ...localOpts, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  const wrongCapLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.dash === undefined && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-localOpts.chLowerMm)) < 1e-6);
  assert.equal(wrongCapLine, undefined,
    '上階(レーン)に床が無いため、1F天井高さ(-chLowerMm)ちょうどの誤った水平キャップ線は無いはず');

  // 上階天井そのものには**見えがかりの水平線を描かない**（ユーザー明示指示2026-08「CHの
  // 見えがかりも描画しない」——そこには天井断面線(CUT)が別に描かれるため）。「壁が上階天井まで
  // 続いている」ことは、壁の縁の縦線が上階天井まで達しているかで見る。
  const topReaching = seq1.content.find(p =>
    p.type === 'line' && p.x1 === p.x2 &&
    Math.abs(Math.min(p.y1, p.y2) - (-localOpts.chUpperAbsMm)) < 1e-6);
  assert.ok(topReaching, '壁の縁の縦線は上階天井(-chUpperAbsMm)まで達するはず');
  assert.equal(seq1.content.filter(p => p.type === 'line' && p.y1 === p.y2
    && p.weight === silhouetteWeight
    && Math.abs(p.y1 - (-localOpts.chUpperAbsMm)) < 1e-6).length, 0,
  'CH（上階天井）には見えがかりの水平線を描かない');
});

// ---- 実機フィードバック第3弾A2で書き換え: 「アキのバツ」はabove層に所有Roomが見つからない
// （壁候補も存在しない）z区間にのみ現れる（§5.6・emitOpenGapMarks）。A2修正前は
// entry壁の上端が誤って1F天井高さで打ち切られていたため、レーン上のその先（1F天井〜2F天井）
// が「壁の無いopen区間」に見え、そこにアキXが出ていた。修正後はentry壁自体が上階天井まで
// 連続して見えがかりを塞ぐため、往路・復路レーンいずれの向きにもopen区間が残らず、
// アキXは1本も出ない（壁が実際にその方向の視界を塞いでいる以上、正しい結果）。----
test('【実機フィードバック第3弾A2】stairFaceSequence: seq1は往復レーン上を壁が上階天井まで塞ぐため、その区間にアキXは出ない', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);

  const centerDiagonals = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.weight === detailWeight && p.dash === 'center');
  assert.equal(centerDiagonals.length, 0,
    '壁が上階天井まで連続して塞ぐため、往路・復路レーン上にアキXは出ないはず');
});

// ==== QA最終検証・修正1: sectionProbe.jsのfallbackCeilZ（往復間の壁がupperLandingOnly=true構成
// でも見えるように修正）の回帰テスト2本 ====
// 旧実装は「視線方向に所有Roomが無い層（往路・復路レーン上に2F床が無い＝実機で最も普通の
// 折返し階段の構成）」の壁候補を丸ごと捨てていたため、往復間の壁(midWall)がupperGraphの
// 'above'層にしか存在しない実機構成では、壁の2縁もアキXも“同時には”検証できていなかった
// （壁2縁を検証する既存テストは2F全面Room・アキXを検証する既存テストはkneeDrop無し、と
// 互いに排他的なfixtureだったため、この壁を丸ごと消す不具合を構造的に検出できなかった）。
// 以下2本は「upperLandingOnly=true（2F床=踊り場のみ）」で両方を同一fixtureで同時に固定する。

test('【QA修正1・A2/線種規則2026-08で書き換え】stairFaceSequence: 2Fが踊り場のみ床（実機で最も普通の構成）でも、seq1に往復間の壁の2縁が出る（切断壁の縁はCUT・アキXは無し）', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair, midWall } = makeSwitchbackFixture(
    graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
  const mr = midWall.materialRange;
  const thicknessMm = Math.abs(mr.hi - mr.lo);

  // 壁2縁: 1F天井(-chLowerMm)〜2F天井(-chUpperAbsMm)の全高で、壁厚ぶん離れた縦線2本
  // （面ローカルx座標は世界座標のmaterialRangeそのものではなく`localXOf`変換後の値のため、
  // 具体的なxをハードコードせず「全高の縦線が2本・間隔=壁厚」という構造で検証する）。
  // 旧実装（バグ）ではこの層が丸ごと捨てられるため0本になっていた。
  const fullHeightEdges = seq1.content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 &&
    Math.abs(Math.min(p.y1, p.y2) - (-OPTS.chUpperAbsMm)) < 1e-6 &&
    Math.abs(Math.max(p.y1, p.y2) - (-OPTS.chLowerMm)) < 1e-6);
  const edgeXs = [...new Set(fullHeightEdges.map(p => p.x1))].sort((a, b) => a - b);
  assert.equal(edgeXs.length, 2,
    `1F天井〜2F天井の全高の縦線が2本(壁の両縁)見つからないはず（実際:${JSON.stringify(fullHeightEdges)}）`);
  assert.ok(Math.abs((edgeXs[1] - edgeXs[0]) - thicknessMm) < 1e-6,
    `2本の間隔(${edgeXs[1] - edgeXs[0]})は壁厚(${thicknessMm})に一致するはず`);

  // 両縁とも weight=CUT(thick)（ユーザー明示指示2026-08「切断壁の縁は降格しない／『切断壁の縁は
  // 太線』が正」で規則変更。旧規則「縁が接する側がopenならCUT・塞がれていればSILHOUETTE」は撤回
  // ——断面は隣に何が見えていようと断面であり、線種は隣接列の状態で変わらない）。
  for (const edge of fullHeightEdges) {
    assert.equal(edge.weight, weightForRole(ElevationLineRole.CUT),
      `x=${edge.x1}の縁は切断壁の断面なのでCUT(thick)のはず`);
  }

  // アキX: 実機フィードバック第3弾A2で書き換え。A2修正前はentry壁が1F天井高さで途切れ、
  // その先（レーン上・1F天井〜2F天井）がopen区間に見えていたためアキXが出ていたが、
  // A2修正後はentry壁自体が上階天井まで連続して視界を塞ぐため、往路・復路レーンいずれにも
  // open区間が残らずアキXは出ない。
  const centerDiagonals = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.weight === detailWeight && p.dash === 'center');
  assert.equal(centerDiagonals.length, 0, '壁が上階天井まで連続して塞ぐため、アキXは出ないはず');
});

// 実機フィードバック第3弾Fで書き換え: seq1の腰壁表現は「両端縦線が上端でキャップされる」
// 一般規則ではなく、「上端水平線のみ・両端縦線なし」という専用のkneeWallCapContent表現へ
// 差し替えた（コーディネーター裁定）。旧アサーション（縦線2本がtopHeightでキャップされる）は
// この専用表現の導入前の一般規則をそのまま固定していた回帰値だったため、新しい表現を検証する
// テストへ置き換える。
test('【QA修正1・実機フィードバック第3弾Fで書き換え】stairFaceSequence: 同構成（2F=踊り場のみ床）で腰壁(topHeight=900)指定時、seq1は上端水平線のみで両端縦線は無い', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair, midWall } = makeSwitchbackFixture(
    graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);

  const topHeight = 900;
  upperGraph.setKneeDropWall(
    edgeKey(midWall.axisCL.id, midWall.clStart.id, midWall.clEnd.id),
    { knee: { topHeight } },
  );

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const expectedTopAbs = OPTS.floorHeight + topHeight; // = 2400+900 = 3300
  const mr = midWall.materialRange;
  const thicknessMm = Math.abs(mr.hi - mr.lo);
  const cutWeight = weightForRole(ElevationLineRole.CUT);

  // 上端水平線: z=expectedTopAbsのCUT水平線が1本、幅=壁厚のはず。
  const topLines = seq1.content.filter(p =>
    p.type === 'line' && p.y1 === p.y2 && p.weight === cutWeight &&
    Math.abs(p.y1 - (-expectedTopAbs)) < 1e-6);
  assert.equal(topLines.length, 1, '上端水平線(CUT)が1本あるはず');
  assert.ok(Math.abs(Math.abs(topLines[0].x1 - topLines[0].x2) - thicknessMm) < 1e-6,
    `上端水平線の幅(${Math.abs(topLines[0].x1 - topLines[0].x2)})は壁厚(${thicknessMm})に一致するはず`);

  // 両端縦線: z=floorHeight〜expectedTopAbsちょうどの縦線は無いはず（一般規則の'cut'両端縦線を
  // 上端水平線へ差し替えたため）。
  const wallEdges = seq1.content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 &&
    Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6 &&
    Math.abs(Math.max(p.y1, p.y2) - (-OPTS.floorHeight)) < 1e-6);
  assert.equal(wallEdges.length, 0, '腰壁の両端縦線(floorHeight〜topHeight)は無いはず');
});

// ---- ユーザー実機指示（往路断面=B面=seq2）: 項目4-7 ----
test('stairFaceSequence: seq2は上り口端〜踊り場前縁までの実際の壁面(クリップ廃止)を使い、floorSegments/ceilingProfileが直進部+踊り場の2区間になる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');

  assert.equal(seq2.floorSegments.length, 2, 'floorSegmentsは直進部+踊り場の2区間のはず');
  const [laneSeg, landingSeg] = seq2.floorSegments;
  assert.equal(laneSeg.floorDeltaMm, 0, '直進部区間の床は設置階FL(0)のはず');
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;
  assert.ok(Math.abs(landingSeg.floorDeltaMm - landingAbs) < 1e-9, '踊り場区間の床はlandingAbsのはず');
  assert.equal(laneSeg.hiX, landingSeg.loX, '2区間の境界は連続しているはず');

  assert.equal(seq2.ceilingProfile.length, 3, 'ceilingProfileは勾配(2点)+踊り場の水平(1点)で3点のはず');
  assert.deepEqual(seq2.ceilingProfile[1], [laneSeg.hiX, OPTS.chUpperAbsMm], '中間点は直進部と踊り場の境界でchUpperAbsMmのはず');
});

// ---- 項目7（変異テスト対象）: laneLenOnFace=面自身の実測run-landingLen（実測len1をそのまま
// 使うと面の実位置とズレるため、独立して求めた期待値と一致することを固定する） ----
test('【mutation証跡用】stairFaceSequence: seq2の直進部区間幅(laneLenOnFace)は面自身の実測run-landingLenに一致し、別経路のlen1とは異なる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  const params = resolveSwitchbackParams(stair, graph, OPTS.floorHeight);

  const expectedLaneLenOnFace = seq2.face.run - params.landingLen; // 面自身の実測runから独立算出
  assert.ok(Math.abs(seq2.floorSegments[0].hiX - expectedLaneLenOnFace) < 1e-6,
    `直進部区間幅は面自身の実測run(${seq2.face.run})-landingLen(${params.landingLen})のはず（実際:${seq2.floorSegments[0].hiX}）`);
  // このfixtureではmeasureStairSpansのlen1(cell境界基準)とwOut1.run(壁面基準)が壁厚インセット分
  // ズレるため、expectedLaneLenOnFaceはparams.len1とは異なる値になる（＝実測len1をそのまま使う
  // 実装だと本テストが赤くなる）。
  assert.notEqual(Math.round(expectedLaneLenOnFace), Math.round(params.len1),
    'このfixtureではlaneLenOnFaceとlen1は異なるはず（同値だと本テストの効力が無い）');
});

// ---- WP-E5b書き換え: 「踊り場床断面線」は一般規則ではstairPrimitivesForCutのlandingCut
// primitives（CUT・太線）としてそのまま保存される（座標は面全幅に広がる——一般規則はcolumns
// 単位でしか区間を区別できず、laneLenOnFace..runという壁位置由来の区切りを持たないため、
// これは意図的な差分として報告する）。「壁厚分の断面縦線」「踊り場壁の断面縦線」は、壁が無い
// このfixtureでは一般規則の見えがかり壁(SILHOUETTE)の面端縦線として現れる（旧実装のCUT太線とは
// 重み・高さ範囲が異なる——旧実装は面自身の壁厚から独立算出していたのに対し、一般規則は
// 実際にレイキャストで見つかった壁の輪郭をそのまま描く。CUT/SILHOUETTEどちらの重みで現れるかは
// §9「保存意味論」の対象外——存在と高さ範囲だけを確認する） ----
test('stairFaceSequence: seq2は踊り場床断面線(太線)を含み、面端に壁の縁(輪郭)がある', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;

  const landingFloorLine = seq2.content.find(p =>
    p.type === 'line' && p.weight === cutWeight && p.y1 === p.y2 &&
    Math.abs(p.y1 - (-landingAbs)) < 1e-9);
  assert.ok(landingFloorLine, '踊り場床断面線(太線・水平・-landingAbs)が見つからない');

  // 面端(x=0/run)には見えがかり壁の輪郭(縦線)がある（1F天井=chLowerMmまで）。**下端はその位置の
  // 断面線**（ユーザー明示指示2026-09「断面線の外は描画しない」）——踊り場側(x=run)は踊り場
  // (landingAbs)から、上り口側(x=0)はそこに掛かる階段断面（このfixtureでは最下段の蹴込みが
  // 面の端より外＝壁芯側から始まるため、面端では既に1FLより少し上）から立ち上がる。
  // 期待値は輪郭そのもの（entry.floorProfile。contentのクリップと同じ単一情報源）から取る。
  for (const x of [0, seq2.face.run]) {
    const zBottom = drawnFloorProfileZAt(seq2.floorProfile, x);
    const edge = seq2.content.find(p =>
      p.type === 'line' && Math.abs(p.x1 - x) < 1e-6 && Math.abs(p.x2 - x) < 1e-6 &&
      (p.weight === cutWeight || p.weight === silhouetteWeight) &&
      Math.abs(p.y1 - (-zBottom)) < 1e-6 && Math.abs(p.y2 - (-OPTS.chLowerMm)) < 1e-6);
    assert.ok(edge, `面端(x=${x})に壁の縁(${zBottom}..-chLowerMm)が見つからない`);
  }
  // 踊り場側の端は踊り場の高さそのもの（輪郭が壊れて別の高さになっていないことの独立確認）。
  assert.equal(drawnFloorProfileZAt(seq2.floorProfile, seq2.face.run), landingAbs);

  // x=0側も独立に係留する（上のzBottomは製品コードと同じseq2.floorProfileから引いているため、
  // それだけでは輪郭がまるごとズレても気付けない）。輪郭とは別の情報源＝contentの階段断面
  // ジグザグから同じ値を組み立てる。ジグザグの点列はx昇順に並べ替えると輪郭と同じ折れ線に
  // なるが、**足元側の頭は面の範囲へクランプされている**（sectionStair.jsの
  // computeFlightZigzagPoints）ためx=0を直接引くと同じxに2点＝値が定まらない。ジグザグは
  // (踏面ピッチ, 蹴上)ぶん平行移動すると自分自身に重なるので、1ピッチ右の値から蹴上1つを
  // 引いてx=0の値にする。
  const zigzag = seq2.content.find(p => p.type === 'polyline' && p.weight === silhouetteWeight);
  assert.ok(zigzag, 'seq2に階段断面のジグザグ(polyline)があるはず');
  const sorted = zigzag.points.map(([x, y]) => [x, -y]).sort((a, b) => a[0] - b[0]);
  const pitch = sorted[4][0] - sorted[2][0]; // 段2つ先の対応点までのx＝踏面ピッチ
  const zAtSorted = (pts, x) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      if (x >= x1 && x <= x2) return x2 === x1 ? z2 : z1 + ((x - x1) / (x2 - x1)) * (z2 - z1);
    }
    return NaN;
  };
  const zZigzagAtX0 = zAtSorted(sorted, pitch) - riser;
  assert.ok(Math.abs(drawnFloorProfileZAt(seq2.floorProfile, 0) - zZigzagAtX0) < 1e-6,
    `x=0の輪郭(${drawnFloorProfileZAt(seq2.floorProfile, 0)})は階段断面のジグザグから求めた値` +
    `(${zZigzagAtX0})と一致するはず（ピッチ:${pitch}・蹴上:${riser}）`);
});

// ---- seq2/2.5は断面プロファイル(polyline)を含み、鋼構造は踏面がCUTでその向こうにささらが重なる ----
// 期待値更新（ユーザー実機フィードバック2026-08-23。switchbackCuts.jsの切断線再定義で切断線が
// 実際に往路レーンの中を縦断するようになったため、「段部はササラの横に付く（横付け）なので
// 側面視では隠す」という旧仕様（WP-E3〜E5b）は撤回した）: 側面視(seq2)では踏面のジグザグ自体を
// CUT（太線）として描き、切断面の向こう側にあるこのレーン自身のささらの輪郭(DETAIL)を重ねて
// 描く。makeSwitchbackFixtureは往復間に壁を作らない（withMidWall省略時）ため、「往路と復路の
// 間に壁が無ければ復路直進部のささらが見える」も同時に成立し、復路(他レーン)の近い側のささら
// のDETAILも重なる——「踏面CUT(1本)＋自レーンささらDETAIL(1本)＋他レーンささらDETAIL(1本)
// =3本」になる（他レーンの可視判定はstairFaceSequence: 鉄骨階段は往復間に壁が無ければ...の
// 専用テストで別途固定する）。
test('stairFaceSequence: 鉄骨階段(structure=STEEL)はseq2の踏面ジグザグがCUTで描かれ、その向こうのささら(DETAIL polyline)が重なる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setField('structure', StructuralMaterialType.STEEL);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  const polylines = seq2.content.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 3, '踏面のCUT(1本)＋自レーンささらDETAIL(1本)＋他レーンささらDETAIL(1本)=3本のはず');
  const zigzag = polylines.find(p => p.weight === weightForRole(ElevationLineRole.CUT));
  const stringers = polylines.filter(p => p.weight === weightForRole(ElevationLineRole.DETAIL));
  assert.ok(zigzag, '踏面のジグザグはCUTのはず');
  assert.equal(stringers.length, 2, 'ささらの見えがかりはDETAILが2本(自レーン＋他レーン)のはず');
});

// ---- ユーザー実機フィードバック2026-08-23: 「1」Bでは、往路と復路の間に壁はないので、
// 復路直進部のささらが見える／壁があれば遮る ----
test('stairFaceSequence: 鉄骨階段は往復間に壁が無ければseq2に他レーン(復路)のささらが見え、壁があれば見えない', () => {
  // withMidWall:true・midWallGraph省略は1F(graph自身)に壁を置くフォールバック経路
  // （makeSwitchbackFixture冒頭のコメント参照）——ささらの高さ範囲(z<STRINGER_VISIBILITY_
  // Z_HI_MM)を実際に塞ぐ壁が要るため、2F(upperGraph)側の壁ではなくこちらを使う
  // （2F側の壁はfloorHeight=2400以上の高さにしか存在せず、1F階段の見えがかりは塞がない）。
  const makeEntries = (withMidWall) => {
    const graph = makeGraph();
    const { room, stair } = makeSwitchbackFixture(graph, withMidWall ? { withMidWall: true } : {});
    stair.setField('structure', StructuralMaterialType.STEEL);
    const faces = composeRoomFaces(room, graph);
    return stairFaceSequence(stair, faces, graph, OPTS);
  };

  const withoutWall = makeEntries(false).find(e => e.seqNo === '2');
  const withWall = makeEntries(true).find(e => e.seqNo === '2');
  const detailPolylineCount = (entry) =>
    entry.content.filter(p => p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.DETAIL)).length;

  assert.equal(detailPolylineCount(withoutWall), 2, '壁が無ければ自レーン＋他レーンのささらDETAILが2本見えるはず');
  assert.equal(detailPolylineCount(withWall), 1, '壁があれば他レーンのささらは遮られ自レーンの1本だけのはず');
});

test('【失敗系】stairFaceSequence: 木造(既定)はseq2にささらを含まない(polylineは1本)', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  assert.equal(seq2.content.filter(p => p.type === 'polyline').length, 1);
});

// ---- WP-E6でstraightCuts.jsへディスパッチされるようになったため書き換え（理由は下記コメント）----
// 旧仕様「STRAIGHT階段はnullを返す（フォールバック）」はWP-E6で終了した。straightCuts.js
// （§6.2）がSTRAIGHT/STRAIGHT_LANDINGをエンジン経由でカバーするようになったため、この
// フィクスチャ（switchback用の3セル室だが、type上書き後はclassifyFaces経由で普通の矩形室として
// 解決できる単純な四角い部屋）でも配列が返るのが新仕様（設計書§9「困る=保存、それ以外は廃棄可」
// の判定基準どおり——「STRAIGHTは常にnull」という契約自体がWP-E6の対象外仕様だったため、
// ここでは意味論アサーション（seq数・断面が返る）へ差し替える）。
test('stairFaceSequence: STRAIGHT階段はnullを返さずseq[1,2,3,4]の配列を返す（WP-E6でstraightCuts経由に変更）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setField('type', StairType.STRAIGHT);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  assert.ok(entries, 'STRAIGHTはstraightCuts経由でnullにならないはず');
  assert.deepEqual(entries.map(e => e.seqNo), ['1', '2', '3', '4']);
});

// ---- 失敗系: cells空はnull ----
test('【失敗系】stairFaceSequence: stair.cellsが空はnullを返す', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setCells(new Set());
  const faces = composeRoomFaces(room, graph);

  assert.equal(stairFaceSequence(stair, faces, graph, OPTS), null);
});

// ---- 失敗系: floorHeight未確定(null)はnull ----
test('【失敗系】stairFaceSequence: opts.floorHeightがnullはnullを返す', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  assert.equal(stairFaceSequence(stair, faces, graph, { ...OPTS, floorHeight: null }), null);
});

// ---- 失敗系: stairがnullはnull ----
test('【失敗系】stairFaceSequence: stairがnullはnullを返す', () => {
  const graph = makeGraph();
  const { room } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  assert.equal(stairFaceSequence(null, faces, graph, OPTS), null);
});

// ---- 【mutation証跡用】踊り場レベルの床offset(landingAbs=n1*riser)が違うと床yがずれる ----
test('【mutation証跡用】stairFaceSequence: seq3(W_landing)の床yはlandingAbs(n1*riser)ぶん設置階FLより高い', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq3 = entries.find(e => e.seqNo === '3');
  const n1 = 6, riser = OPTS.floorHeight / 12; // sections=[6,1,6] → totalSteps=12
  const landingAbs = n1 * riser;
  assert.ok(Math.abs(seq3.floorSegments[0].floorDeltaMm - landingAbs) < 1e-9,
    `seq3のfloorDeltaMmはlandingAbs(${landingAbs})のはず（実際:${seq3.floorSegments[0].floorDeltaMm}）`);
});

// ---- ユーザー実機指示第2弾（根本的訂正）: 往復間の壁は1F(graph)ではなく2F(upperGraph)の壁 ----
test('stairFaceSequence: 往復間の壁がupperGraphのみにある場合、opts.upperGraph経由で検出されseq2.5/4.5が出る', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph });
  const faces = composeRoomFaces(room, graph);

  // graph.walls自体には往復間の壁が無いことを確認（1F壁検出だけなら見つからないはず）。
  const graphHasMid = graph.walls.some(w => w.isVertical && Math.abs(w.axisCL.effectiveValue - 1000) < 1);
  assert.equal(graphHasMid, false, 'graph.wallsには往復間の壁が無いはず（upperGraph限定の配置）');

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  assert.deepEqual(entries.map(e => e.seqNo), ['1', '2', '2.5', '3', '4', '4.5', '5'],
    'upperGraph.walls経由でmidWallが検出され、seq2.5/4.5が出るはず');
});

// ---- 失敗系: opts.upperGraph未指定時は従来どおりgraph.walls（1F）で検出する（後方互換フォールバック） ----
test('【失敗系】stairFaceSequence: opts.upperGraph未指定なら従来どおりgraph.walls(1F)で往復間の壁を検出する', () => {
  const graph = makeGraph('p1');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true }); // graph自身に壁
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS); // upperGraph未指定
  assert.deepEqual(entries.map(e => e.seqNo), ['1', '2', '2.5', '3', '4', '4.5', '5']);
});

// ---- ユーザー実機指示第2弾: 腰壁（knee）の実高さがseq1の壁エッジ・seq2の壁断面に反映される ----
// ---- WP-E5b書き換え: エンジン化により腰壁は「切断壁(cutAlong)のz存在範囲」として一般規則に
// 反映される（kneeDropZRangeAt。sectionProbe.js）——seq1では見えがかり壁(wall)の上端が
// floorHeight+topHeightでキャップされる ----
// ---- ユーザー実機フィードバック2026-08-23での書き換え: seq2の切断線を「レーン境界(往復間の
// 壁の位置)」から「往路レーン中央」へ移した結果、往復間の壁はもはやcutAlong（切断線と壁が
// 同一直線上）ではなく、通常の見えがかり壁（'wall'。sectionProbe.jsのisSightlineShape）に
// なった——cutAlong専用の「上端CUT水平線＋両端CUT縦線（旧type:'rect'相当の3線輪郭）」は
// 発生せず、'wall'kind共通の「上端・下端SILHOUETTE水平線＋（凹み境界があれば）SILHOUETTE
// 縦線」になる。knee-dropの高さキャップ自体はcutAlong/wall両kindに共通で適用される
// （sectionProbe.js probeColumn内、kneeDropZRangeAtの呼び出し箇所を参照）ため、
// 「壁の上端がfloorHeight+topHeightでキャップされる」という意味論はseq1・seq2とも維持される
// （線種と輪郭の組み方だけがcutAlong→wallへ変わる）。 ----
// 実機フィードバック第3弾Fで書き換え: seq1側のアサーションのみ「上端水平線のみ・両端縦線
// なし」の専用表現へ更新する（seq2側は一般規則のままのため不変）。
test('stairFaceSequence: 腰壁(knee.topHeight)を指定すると、seq1は上端水平線のみ・seq2は壁上端がfloorHeight+topHeightでキャップされる（seq2は今はwall=SILHOUETTEの帯。cutAlongではない）', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair, midWall } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph });
  const faces = composeRoomFaces(room, graph);

  const topHeight = 900; // 2F床から900mmの腰壁
  upperGraph.setKneeDropWall(
    edgeKey(midWall.axisCL.id, midWall.clStart.id, midWall.clEnd.id),
    { knee: { topHeight } },
  );

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const expectedTopAbs = OPTS.floorHeight + topHeight; // = 2400+900 = 3300（chUpperAbsMm=4800より低い）

  const cappedTopLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.weight === cutWeight &&
    Math.abs(p.y1 - (-expectedTopAbs)) < 1e-6);
  assert.ok(cappedTopLine, `seq1に上端水平CUT線(-${expectedTopAbs})があるはず`);
  const cappedEdge = seq1.content.find(p =>
    p.type === 'line' && p.x1 === p.x2 &&
    Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6 &&
    Math.abs(Math.max(p.y1, p.y2) - (-OPTS.floorHeight)) < 1e-6);
  assert.equal(cappedEdge, undefined, 'seq1は両端縦線(floorHeight〜topHeight)を持たないはず');

  // seq2は今はcutAlongではなく通常の見えがかり壁（'wall'。SILHOUETTE=中線）——上端の水平線が
  // knee高さでキャップされ、1F天井(chLowerMm)〜キャップ高さのSILHOUETTE縦線が出る。
  const seq2 = entries.find(e => e.seqNo === '2');
  const topLine = seq2.content.find(p =>
    p.type === 'line' && p.weight === silhouetteWeight && p.y1 === p.y2 && Math.abs(p.y1 - (-expectedTopAbs)) < 1e-6);
  assert.ok(topLine, `seq2に上端の水平SILHOUETTE線(-${expectedTopAbs})が見つからない`);
  const sideVerticals = seq2.content.filter(p =>
    p.type === 'line' && p.weight === silhouetteWeight && p.x1 === p.x2 &&
    Math.abs(Math.max(p.y1, p.y2) - (-OPTS.chLowerMm)) < 1e-6 && Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6);
  assert.ok(sideVerticals.length >= 1, '腰壁時、seq2に1F天井〜キャップ高さのSILHOUETTE縦線が少なくとも1本あるはず');
  // cutAlong時代の「上端線と両端縦線が同じx範囲を持つ矩形輪郭」という保証は無い
  // （'wall'kindの縦線は輪郭の実端ではなく列間の凹み境界に出るため）。壁の存在自体と
  // 高さキャップが正しく効いていることのみを固定する。
});

// ---- QA指摘: wallThicknessMmのmaterialRange経路が実測厚みに追従することを固定する
// （materialRangeはcomputed getterで常に非nullのため、旧「axisOffsetフォールバック」分岐は
// 到達不能の死コードだった。QAは`const r = null;`相当の変異で全緑を素通りすることを実証済み） ----
// ---- ユーザー実機フィードバック2026-08-23での書き換え: seq2はcutAlongではなくなった
// （壁から離れた往路レーン中央から見えがかりで見る）ため、seq2側の「上端線幅=materialRange」
// というcutAlong特有の断言は削除し、materialRangeの検証はseq1側（壁を横切る視線=cutWallの
// 縁。今回のcutLine変更の影響を受けない）に一本化する。seq2側は「壁が見えがかりとして
// 検出され、knee高さのキャップが効く」ことだけを確認する ----
test('【mutation証跡用】stairFaceSequence: 壁厚(materialRange幅)=200のとき、seq1の2縁のx間隔=200になる（seq2はcutAlong対象外になったためmaterialRange幅の直接検証はseq1のみ）', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  // makeSwitchbackFixtureのmidWallGraph経路と同じCL構成だが、axisOffset=200を明示して
  // materialRange幅(=|axisOffset|。backingDepth未指定の既定式)を200に固定する。2F側は
  // upperLandingOnlyではない（全面カバー）構成——wall検出には2F側にRoomが必要なため。
  const { room, stair } = makeSwitchbackFixture(graph);
  const ux0 = upperGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const uxm = upperGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const ux1 = upperGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const uy0 = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const uym = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const uy1 = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const uLandingKey  = `${ux0.id}:${uy0.id}:${ux1.id}:${uym.id}`;
  const uOutboundKey = `${ux0.id}:${uym.id}:${uxm.id}:${uy1.id}`;
  const uReturnKey   = `${uxm.id}:${uym.id}:${ux1.id}:${uy1.id}`;
  upperGraph.addRoom(new Set([uLandingKey, uOutboundKey, uReturnKey]), '2F');
  const midWall = upperGraph.addWall(uxm, 200, true, uym, 0, uy1, 0, {});
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  // 壁は2F(upperGraph)側にあるため、壁の2縁は1F天井〜2F天井(-chLowerMm..-chUpperAbsMm)の
  // 縦線として現れ、x間隔=materialRange幅（近傍の面端縦線と区別するため、200ちょうど離れた
  // ペアを探す）。
  const edges = seq1.content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && (p.weight === cutWeight || p.weight === silhouetteWeight) &&
    Math.abs(p.y1 - (-OPTS.chLowerMm)) < 1e-6 && Math.abs(p.y2 - (-OPTS.chUpperAbsMm)) < 1e-6);
  const edgeXs = [...new Set(edges.map(p => p.x1))].sort((a, b) => a - b);
  let pair = null;
  for (let i = 0; i + 1 < edgeXs.length; i++) {
    if (Math.abs((edgeXs[i + 1] - edgeXs[i]) - 200) < 1e-6) { pair = [edgeXs[i], edgeXs[i + 1]]; break; }
  }
  assert.ok(pair, `壁の2縁のx間隔はmaterialRange幅(200)のはず（候補:${edgeXs}）`);

  // 腰壁指定時、seq2にもknee高さでキャップされたSILHOUETTE壁面が現れる（cutAlongではないため
  // materialRange幅そのものの検証はしない。存在とz範囲だけを確認する）。
  upperGraph.setKneeDropWall(
    edgeKey(midWall.axisCL.id, midWall.clStart.id, midWall.clEnd.id),
    { knee: { topHeight: 900 } },
  );
  const entriesWithKnee = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq2 = entriesWithKnee.find(e => e.seqNo === '2');
  const expectedTopAbs = OPTS.floorHeight + 900;
  const topLine = seq2.content.find(p =>
    p.type === 'line' && p.weight === silhouetteWeight && p.y1 === p.y2 && Math.abs(p.y1 - (-expectedTopAbs)) < 1e-6);
  assert.ok(topLine, 'seq2の上端SILHOUETTE線(knee高さ)が見つからない');
});

// ---- 失敗系: 腰壁・垂れ壁指定が無ければ従来どおり全高の壁面のまま ----
// ---- ユーザー実機フィードバック2026-08-23での書き換え: seq2はcutAlongではなくなったため
// 「縦線(line)のまま」の意味をcutAlong(CUT)からwall(SILHOUETTE)へ更新する。全高
// （1F天井chLowerMm〜2F天井chUpperAbsMm）で壁面が続くこと自体は不変——rectを持たないことも
// 引き続き確認する。 ----
test('【失敗系】stairFaceSequence: 腰壁・垂れ壁指定が無ければseq2の2階中心2壁断面は従来どおり全高の壁面(SILHOUETTE)のまま', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq2 = entries.find(e => e.seqNo === '2');
  assert.equal(seq2.content.filter(p => p.type === 'rect').length, 0, '腰壁・垂れ壁指定が無ければrectは出ないはず');
  const silhouetteLines = seq2.content.filter(p => p.type === 'line' && p.weight === weightForRole(ElevationLineRole.SILHOUETTE) && p.x1 === p.x2);
  assert.ok(silhouetteLines.some(p => Math.abs(Math.min(p.y1, p.y2) - (-OPTS.chUpperAbsMm)) < 1e-6 && Math.abs(Math.max(p.y1, p.y2) - (-OPTS.chLowerMm)) < 1e-6),
    '全高（既定）は1F天井〜2F天井のSILHOUETTE縦線を含むはず（cutAlongではなくなったためCUTではない）');
});

// ---- ユーザー実機指示第2弾: seq4はseq2の鏡像構成（左=踊り場1000相当・右=直進部2500相当） ----
test('【mutation証跡用】stairFaceSequence: seq4はseq2の鏡像構成で、floorSegmentsが左=踊り場・右=直進部になり、踊り場壁の断面縦線は左端(x=0)にある', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq4 = entries.find(e => e.seqNo === '4');

  assert.equal(seq4.floorSegments.length, 2, 'seq4のfloorSegmentsも2区間のはず');
  const [landingSeg4, laneSeg4] = seq4.floorSegments;
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;
  assert.ok(Math.abs(landingSeg4.floorDeltaMm - landingAbs) < 1e-9, 'seq4の左区間(踊り場)はfloorDeltaMm=landingAbsのはず（seq2は右区間がこれ＝鏡像）');
  assert.equal(laneSeg4.floorDeltaMm, 0, 'seq4の右区間(直進部)はfloorDeltaMm=0のはず（seq2は左区間がこれ＝鏡像）');
  const params = resolveSwitchbackParams(stair, graph, OPTS.floorHeight);
  assert.ok(Math.abs(landingSeg4.hiX - params.landingLen) < 1e-6,
    `seq4の踊り場区間幅(左区間)は実測landingLen(${params.landingLen})に一致するはず（実際:${landingSeg4.hiX}）`);

  // WP-E5b書き換え: 壁が無いこのfixtureでは「踊り場壁の断面縦線」に相当する専用の縦線は
  // 無く（旧実装が独立算出していた面自身の壁厚由来のCUT縦線は、一般規則では見えがかり壁の
  // 輪郭に統合される）、seq2と同じ構造（踊り場床の水平CUT線＋面端の輪郭）がseq4にも
  // 現れることを保存意味論（「seq2とseq4の鏡像関係」）として確認する。
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const landingFloorLine = seq4.content.find(p =>
    p.type === 'line' && p.weight === cutWeight && p.y1 === p.y2 && Math.abs(p.y1 - (-landingAbs)) < 1e-9);
  assert.ok(landingFloorLine, 'seq4にも踊り場床の水平CUT線(-landingAbs)があるはず（seq2と同じ構造）');
  // seq4はbaseFloorZ=landingAbsのため、面端の縁は「landingAbsより上=通常のSILHOUETTE」
  // 「landingAbsより下=DETAIL破線へ降格」の2本に分かれる（seq1と同じ§5.6降格規則）。
  for (const x of [0, seq4.face.run]) {
    const aboveEdge = seq4.content.find(p =>
      p.type === 'line' && p.x1 === x && p.x2 === x && p.weight === silhouetteWeight &&
      Math.abs(p.y1 - (-landingAbs)) < 1e-6 && Math.abs(p.y2 - (-OPTS.chLowerMm)) < 1e-6);
    assert.ok(aboveEdge, `seq4の面端(x=${x})にlandingAbs〜chLowerMmのSILHOUETTE縁があるはず（seq2と同じ構造）`);
  }

  // 断面ジグザグ(polyline)のx範囲が、seq2は上り口側(x=0寄り)・seq4は上り口側(x=run寄り)に
  // 接することを確認する（dirSignが逆＝「seq2とseq4の鏡像関係」の直接証跡。座標そのものでは
  // なく「どちら側の面端に接するか」で固定する）。
  const seq2 = entries.find(e => e.seqNo === '2');
  const zig2 = seq2.content.find(p => p.type === 'polyline');
  const zig4 = seq4.content.find(p => p.type === 'polyline');
  const zig2Xs = zig2.points.map(p => p[0]);
  const zig4Xs = zig4.points.map(p => p[0]);
  assert.ok(Math.min(...zig2Xs) <= 1e-6, 'seq2の断面ジグザグはx=0(上り口側)に接するはず');
  assert.ok(Math.max(...zig4Xs) >= seq4.face.run - 1e-6, 'seq4の断面ジグザグはx=run(上り口側)に接するはず（seq2とは逆側＝鏡像）');
});

// ---- QA指摘: laneLenOnFaceが負になりうる（spans=null＋浅い階段室。measureStairSpansが
// 失敗し合成フォールバックのlandingLen=MIN_LANDING(1200)が使われる一方、実測face.runがそれより
// 小さい場合）→ floorSegmentsのloX>hiX・ceilingProfileの非昇順が生じるバグの再現テスト ----
test('【回帰】stairFaceSequence: 浅い階段室(spans=null)でもseq2/4のfloorSegmentsは全区間hiX>loX、ceilingProfileは昇順のまま', () => {
  const graph = makeGraph();
  const depth = 900; // QAが再現に使った深さ
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,     { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, depth, { labeled: false, discipline: Discipline.ARCH });
  // 踊り場区画を独立させず、2列（左右半幅）×全高のみ——detectUTurnの「landingFull(frac>=0.9)」
  // 判定に該当するセルが無いため、measureStairSpansはnullを返す（合成フォールバックの検証用）。
  const leftKey  = `${x0.id}:${y0.id}:${xm.id}:${y1.id}`;
  const rightKey = `${xm.id}:${y0.id}:${x1.id}:${y1.id}`;
  const cells = new Set([leftKey, rightKey]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false, tread: 250,
  });

  // 前提確認: このfixtureで実際にspans=null（合成フォールバック経路）になっていること。
  assert.equal(measureStairSpans(stair, graph), null, '前提: このfixtureはmeasureStairSpansがnullを返すはず');

  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  assert.ok(entries, 'SWITCHBACK+cellsありでnullにならないはず');

  for (const seqNo of ['2', '4']) {
    const entry = entries.find(e => e.seqNo === seqNo);
    for (const seg of entry.floorSegments) {
      assert.ok(seg.hiX > seg.loX, `seq${seqNo}のfloorSegmentsは全区間hiX>loXのはず（実際: loX=${seg.loX}, hiX=${seg.hiX}）`);
    }
    if (Array.isArray(entry.ceilingProfile)) {
      for (let i = 0; i + 1 < entry.ceilingProfile.length; i++) {
        assert.ok(entry.ceilingProfile[i][0] <= entry.ceilingProfile[i + 1][0],
          `seq${seqNo}のceilingProfileは昇順のはず（実際: ${JSON.stringify(entry.ceilingProfile)}）`);
      }
    }
    // laneLenOnFace(4)自体が負のまま使われると、床線・rect等のx座標が面のローカル範囲[0,run]の
    // 外（負またはrunを超える）へはみ出す——floorSegmentsのガード（laneLenOnFace>0等）だけでは
    // 検知できないため、content側の座標範囲も直接確認する（Math.max(0,...)クランプ自体の効力確認）。
    for (const p of entry.content) {
      const xs = p.type === 'rect' ? [p.x, p.x + p.w] : p.type === 'polyline' ? p.points.map(pt => pt[0]) : [p.x1, p.x2];
      for (const x of xs) {
        assert.ok(x >= -1e-6 && x <= entry.face.run + 1e-6,
          `seq${seqNo}のcontentのx座標(${x})は面のローカル範囲[0,${entry.face.run}]内のはず`);
      }
    }
  }
});

// ==== QA実機フィードバック修正: 「1」の梯子左右逆・「2」「4」の左右/上る下る逆 ====
// 実機（幅1500+1500・走行部2500+踊り場1000）で確認された不具合の再現・回帰テスト。
// switchbackCuts.test.jsのmakeUserDimsFixtureと同一構成（往路レーンx:0-1500・復路レーンx:1500-3000、
// upDirection='up'）。
function makeUserDimsFixture(graph, upDirection = 'up', flip = false) {
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
    sections: [10, 1, 10], riser: null, upDirection, flip,
  });
  { const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size > 0) graph.addRoom(new Set(beyond), '階段下'); } // 実機確認済みの表現は「下に部屋がある場合」
  return { room, stair };
}

test('【QA修正・実機フィードバック】stairFaceSequence: seq1の梯子は左=往路(FL→踊り場・破線)・右=復路(踊り場→2FL・実線)になる', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');

  // 踏面梯子(横線・両端x異なる・面全幅は除外——全幅の水平線は壁バンド縁が降格した別物で
  // 踏面梯子ではない)を破線/実線に分けてx範囲を比較する。
  const rungs = seq1.content.filter(p =>
    p.type === 'line' && p.y1 === p.y2 && p.x1 !== p.x2 && p.weight === 'thin' &&
    !(Math.min(p.x1, p.x2) <= 1e-6 && Math.max(p.x1, p.x2) >= seq1.face.run - 1e-6));
  const dashedXs = rungs.filter(p => p.dash === 'dashed').map(p => Math.max(p.x1, p.x2));
  const solidXs  = rungs.filter(p => p.dash === undefined).map(p => Math.min(p.x1, p.x2));
  assert.ok(dashedXs.length > 0 && solidXs.length > 0, '破線・実線の踏面梯子が両方あるはず');
  const dashedMaxX = Math.max(...dashedXs);
  const solidMinX  = Math.min(...solidXs);
  assert.ok(dashedMaxX <= solidMinX + 1e-6,
    `破線(往路)は左側・実線(復路)は右側のはず（破線最大x=${dashedMaxX}, 実線最小x=${solidMinX}）`);
});

test('【QA修正・実機フィードバック】stairFaceSequence: seq2は左=上り口(floorDeltaMm:0)・右=踊り場(floorDeltaMm:landingAbs)で、左から右へ上る', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');

  assert.equal(seq2.floorSegments.length, 2, '踊り場ぶんの床段差で2区間のはず');
  const sorted = [...seq2.floorSegments].sort((a, b) => a.loX - b.loX);
  assert.equal(sorted[0].loX, 0, '左端区間はloX=0のはず');
  assert.equal(sorted[0].floorDeltaMm, 0, '左側(上り口)はfloorDeltaMm=0のはず');
  assert.ok(sorted[1].floorDeltaMm > 0, '右側(踊り場)はfloorDeltaMm>0(landingAbs)のはず');
});

test('【QA修正・実機フィードバック】stairFaceSequence: seq4は左=踊り場(floorDeltaMm:landingAbs)・右=上り口(floorDeltaMm:0)で、左から右へ下る（seq2の鏡像・往路を反対側から見た図）', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq4 = entries.find(e => e.seqNo === '4');

  assert.equal(seq4.floorSegments.length, 2);
  const sorted = [...seq4.floorSegments].sort((a, b) => a.loX - b.loX);
  assert.equal(sorted[0].loX, 0, '左端区間はloX=0のはず');
  assert.ok(sorted[0].floorDeltaMm > 0, '左側(踊り場)はfloorDeltaMm>0(landingAbs)のはず');
  assert.equal(sorted[1].floorDeltaMm, 0, '右側(上り口)はfloorDeltaMm=0のはず');

  // 断面ジグザグ(SILHOUETTE polyline)のz(y)は、左(踊り場側)で高く(landingAbsに近い)・
  // 右(上り口側)で低い(0に近い)はず（左から右へ下る）——往路(outbound)の鏡像であることの確認。
  const zigzag = seq4.content.find(p => p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.SILHOUETTE));
  assert.ok(zigzag, '断面ジグザグのpolylineがあるはず');
  // 点列は「歩く順」で並ぶため必ずしもx昇順ではない——x最小点・x最大点をそれぞれ探して比較する。
  const minXPt = zigzag.points.reduce((a, b) => (b[0] < a[0] ? b : a));
  const maxXPt = zigzag.points.reduce((a, b) => (b[0] > a[0] ? b : a));
  assert.ok(minXPt[1] <= maxXPt[1],
    `左(x最小・踊り場側)のyは右(x最大・上り口側)のyより低い＝高さは高い(y上向き負)はず` +
    `（左=${JSON.stringify(minXPt)}, 右=${JSON.stringify(maxXPt)}）`);
});

test('stairFaceSequence: seq2/seq4のレーン区間床線(FL)は「階段断面に出会ったら終点」＝上り口側だけに残る（flatLineSpanX）', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);

  // seq2は上り口が左（localX小）・seq4はその鏡像で上り口が右。1FL線は上り口の外側
  // （壁のない端部のはり出し）にだけ残り、レーンの中＝階段断面の下へは入らない。
  // 終点は**ジグザグの足元x（断面ジグザグが1FLに接する点）**——旧テストは「上り口端＋段鼻の出」
  // という算術で期待値を書いていたが、これは「階段の足元がちょうど面の端にある」ことを暗に
  // 仮定した式で、このfixtureのように最下段の蹴込みが面の端より外（壁芯側）から始まる構成では
  // 成り立たない（輪郭方式への移行で判明。実機「6」D1では従来どおり上り口端＋段鼻の出になる）。
  for (const seqNo of ['2', '4']) {
    const entry = entries.find(e => e.seqNo === seqNo);
    const laneSegs = entry.floorSegments.filter(s => s.floorDeltaMm === 0);
    assert.ok(laneSegs.length > 0, `seq${seqNo}にfloorDeltaMm:0(レーン)区間があるはず`);
    for (const seg of laneSegs) {
      assert.ok(seg.flatLineSpanX,
        `seq${seqNo}のレーン区間はflatLineSpanXで切り詰められるはず（階段断面が境界を表すため）`);
    }
    // ジグザグ（断面プロファイルのpolyline）がレーンの床(z=0)に接するx。
    const zigzag = entry.content.find(p =>
      p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.SILHOUETTE));
    const footX = zigzag.points.reduce((a, b) => (b[1] > a[1] ? b : a))[0]; // yが最大＝zが最小＝足元
    if (seqNo === '2') {
      const first = laneSegs[0];
      assert.ok(first.flatLineSpanX.hi <= footX + 1e-6,
        `seq2のレーン床線はジグザグの足元x(${footX})より先へ伸びてはいけない（実際:${first.flatLineSpanX.hi}）`);
    } else {
      const last = laneSegs[laneSegs.length - 1];
      assert.ok(last.flatLineSpanX.lo >= footX - 1e-6,
        `seq4のレーン床線はジグザグの足元x(${footX})より手前から始まってはいけない（実際:${last.flatLineSpanX.lo}）`);
    }
    const landingSeg = entry.floorSegments.find(s => s.floorDeltaMm > 0);
    assert.ok(!landingSeg.flatLineSpanX, `seq${seqNo}の踊り場区間は通常どおり床線を描くはず`);
  }
});

// ---- D1の番人（QA修正2026-09）: 上のテストは片側の不等式しか見ておらず、可視範囲が**空**
// （flatLineSpanX={lo:hiX, hi:loX}）でも緑になってしまう——上の2つのフィクスチャは階段の足元が
// 面の端（またはその外）にあり、1FL線が残る「はり出し」がそもそも存在しないため。
// entryGapMmで上り口側の壁を階段の足元から離し、**はり出しが実在する**構成で
// 「はり出し側は切らない（lo/hiの片方がundefined）」「可視範囲は空でない」「終点は
// ジグザグの足元x」の3点を固定する（ユーザー実機「6」D1「1FLのはり出しは残す」）。 ----
test('stairFaceSequence: 階段の足元が面の内側にあるとき、seq2のレーン1FL線ははり出し側に残る（D1）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withRoomUnder: true, entryGapMm: 1000 });
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);

  for (const seqNo of ['2', '4']) {
    const entry = entries.find(e => e.seqNo === seqNo);
    const laneSegs = entry.floorSegments.filter(s => s.floorDeltaMm === 0);
    assert.ok(laneSegs.length > 0, `seq${seqNo}にfloorDeltaMm:0(レーン)区間があるはず`);
    // ジグザグ（階段断面のpolyline）の最下点x＝階段の足元。ここが面の内側にあることが前提。
    const zigzag = entry.content.find(p =>
      p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.SILHOUETTE));
    const footX = zigzag.points.reduce((a, b) => (b[1] > a[1] ? b : a))[0];

    // seq2は上り口が左（＝はり出しはloX側）、seq4はその鏡像。
    const seg = seqNo === '2' ? laneSegs[0] : laneSegs[laneSegs.length - 1];
    const span = seg.flatLineSpanX;
    assert.ok(span, `seq${seqNo}のレーン区間はflatLineSpanXで切り詰められるはず`);
    if (seqNo === '2') {
      assert.ok(footX > seg.loX + 1e-6 && footX < seg.hiX - 1e-6,
        `前提: seq2の階段の足元(${footX})は区間(${seg.loX}..${seg.hiX})の内側にあるはず`);
      assert.equal(span.lo, undefined, 'はり出し側(loX側)は切らない＝loは付かないはず');
      assert.ok(span.hi > seg.loX + 1e-6,
        `可視範囲が空（{lo:hiX,hi:loX}）になっている（実際:${JSON.stringify(span)}）`);
      assert.ok(Math.abs(span.hi - footX) < 1e-6,
        `1FL線の終点(${span.hi})は階段断面の足元x(${footX})と一致するはず`);
    } else {
      assert.ok(footX > seg.loX + 1e-6 && footX < seg.hiX - 1e-6,
        `前提: seq4の階段の足元(${footX})は区間(${seg.loX}..${seg.hiX})の内側にあるはず`);
      assert.equal(span.hi, undefined, 'はり出し側(hiX側)は切らない＝hiは付かないはず');
      assert.ok(span.lo < seg.hiX - 1e-6,
        `可視範囲が空（{lo:hiX,hi:loX}）になっている（実際:${JSON.stringify(span)}）`);
      assert.ok(Math.abs(span.lo - footX) < 1e-6,
        `1FL線の始点(${span.lo})は階段断面の足元x(${footX})と一致するはず`);
    }
  }
});

// ==== QA実機フィードバック再修正（ラウンド2）====
// 根本原因: sectionStair.js の stairContribution が outbound/inbound の acrossLo/acrossHi を
// roomBounds(bounds.x1/x2 等)から直接求めており、stair.flip===true時にmakeFrameのacrossAt(s)が
// 行うs反転（ss=1-s）を反映していなかった——実機データがflip===trueだと、往路(outbound)の
// 梯子・ジグザグが幅方向で本来と逆の半分（acrossLo側に固定）に描かれてしまう。
// stairContributionをf.pt(0,s)（switchbackCuts.jsのacrossCoordAtと同じ導出）ベースへ修正した。
// 「往路レーンが常に図の左」を upDirection(4方向) × flip(2値) の全8通りで固定する。
test('【QA修正・実機フィードバックR2】stairFaceSequence: upDirection×flipの全8通りで、seq1の破線梯子(往路)は常に実線梯子(復路)より左になる', () => {
  for (const upDirection of ['up', 'down', 'left', 'right']) {
    for (const flip of [false, true]) {
      const graph = makeGraph();
      const { room, stair } = makeUserDimsFixture(graph, upDirection, flip);
      const faces = composeRoomFaces(room, graph);
      const entries = stairFaceSequence(stair, faces, graph, OPTS);
      const seq1 = entries.find(e => e.seqNo === '1');
      const rungs = seq1.content.filter(p =>
        p.type === 'line' && p.y1 === p.y2 && p.x1 !== p.x2 && p.weight === 'thin' &&
        !(Math.min(p.x1, p.x2) <= 1e-6 && Math.max(p.x1, p.x2) >= seq1.face.run - 1e-6));
      const dashedXs = rungs.filter(p => p.dash === 'dashed').map(p => Math.max(p.x1, p.x2));
      const solidXs  = rungs.filter(p => p.dash === undefined).map(p => Math.min(p.x1, p.x2));
      assert.ok(dashedXs.length > 0 && solidXs.length > 0,
        `upDirection=${upDirection},flip=${flip}: 破線・実線の踏面梯子が両方あるはず`);
      const dashedMaxX = Math.max(...dashedXs), solidMinX = Math.min(...solidXs);
      assert.ok(dashedMaxX <= solidMinX + 1e-6,
        `upDirection=${upDirection},flip=${flip}: 破線(往路)は左側・実線(復路)は右側のはず` +
        `（破線最大x=${dashedMaxX}, 実線最小x=${solidMinX}）`);
    }
  }
});

// ---- QA実機フィードバックR2: 設置階FL線が階段断面の下を貫通する不具合の追加発生源 ----
// hideFlatLine（floorSegments側）とは別に、emitColumnsが一般規則で描く「見えがかり壁の
// z=0(設置階FL)の輪郭線」（レーンの向こうに実際に見える部屋自身の壁の縁。壁が無い実機構成で
// 顕在化）が、階段の断面ジグザグが占めるx範囲にも重なって全幅に描かれていた——階段自体
// （段板・ささら）に隠れて見えないはずのため、ジグザグのx範囲と重なるz=0の壁縁線を取り除く
// （elevationStairSequence.jsのclipWallFloorEdgeUnderZigzag）。
test('【QA修正・実機フィードバックR2】stairFaceSequence: seq2/seq4のcontentに、階段の断面ジグザグの向こうに見える壁のz=0(設置階FL)の輪郭線が残らない', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  for (const seqNo of ['2', '4']) {
    const entry = entries.find(e => e.seqNo === seqNo);
    const zeroLines = entry.content.filter(p => p.type === 'line' && p.y1 === 0 && p.y2 === 0);
    assert.equal(zeroLines.length, 0,
      `seq${seqNo}のcontentにz=0(y=0)の線が残っているはず無い（実際:${JSON.stringify(zeroLines)}）`);
  }
});

// ---- WP-C: 構造梁（踊り場受け梁）の展開図への加算寄与（contentForCutへの配線） ----
// 踊り場back辺（y0。x0-x1に渡る水平梁）を手動でgraphへ追加し（本テストの関心はcontentForCutへの
// 配線自体——自動生成autoFillStairLandingBeamsはstructural/structuralAutoFill.test.jsで検証済み）、
// seq2/4/5（踊り場のback辺を横切る側面視の切断）に断面矩形(CUT太線4本)が追加されることを確認する。
test('【WP-C】stairFaceSequence: 踊り場back辺に置いたrole:landing梁の断面矩形(4本)がseq2/4/5に現れ、seq1/3には現れない', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const before = stairFaceSequence(stair, faces, graph, OPTS);
  const beforeLens = Object.fromEntries(before.map(e => [e.seqNo, e.content.length]));

  // 踊り場back辺（y0）に沿う水平梁（isVertical=false）。x0(=0)〜x1(=2000)。levelOffset=890は
  // WP-B2の既定式（landingZ(1200)-300-10）と同じ値——ここでは配線確認が目的のため定数のまま使う。
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const y0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 0);
  graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', y0, false, x0, x1, { role: 'landing', levelOffset: 890 });

  const after = stairFaceSequence(stair, faces, graph, OPTS);
  const afterBySeq = Object.fromEntries(after.map(e => [e.seqNo, e]));

  // seq2はbaseFloorZ=0（topZ890はそれより上）のためCUT(太線)のまま、seq4/5はbaseFloorZ=1200
  // （topZ890はそれより下）のため既存フィルタでDETAIL(細線)+破線へ降格する——梁の位置は
  // 同じでも切断ごとのbaseFloorZが異なるため見え方が変わるのは既存仕様どおり（新規判定は
  // 追加していない）。ここでは「4本増える」ことと降格の有無だけを検証し、増分の絶対的な
  // weightは断定しない。
  // 期待値更新（ユーザー実機指摘2026-08「断面形状を指定構造材に合わせて」）: STEEL-H200x100は
  // H形鋼なので断面輪郭は12辺（矩形4辺ではない）。
  for (const seqNo of ['2', '4', '5']) {
    const grew = afterBySeq[seqNo].content.length - beforeLens[seqNo];
    assert.equal(grew, 12, `seq${seqNo}はH形鋼の断面輪郭12本ぶん増えるはず`);
  }
  const seq2Added = afterBySeq['2'].content.filter(p => p.weight === 'thick' && p.type === 'line');
  assert.ok(seq2Added.length >= 12, 'seq2はbaseFloorZ(0)より梁が上のためCUT(太線)のままのはず');

  assert.equal(afterBySeq['1'].content.length, beforeLens['1'], 'seq1（正面視・back辺と平行でない）は変化しないはず');
  // 期待値更新（ユーザー実機指摘2026-08「6」A「材が空中に横断しているので、『A』に中線で
  // 鋼材の天地に線を描画」）: seq3（踊り場の壁を見る面）は、切断線と平行で室内を横切る梁の
  // 天地2本をSILHOUETTE（中線）で描くようになった。
  const seq3Grew = afterBySeq['3'].content.length - beforeLens['3'];
  assert.equal(seq3Grew, 2, 'seq3は空中を横断する梁の天地2本ぶん増えるはず');
  // 線種は§5.6の最終フィルタに従う——このfixtureの梁(topZ=890)はseq3のbaseFloorZ(踊り場)より
  // 下にあるため中線ではなく細破線へ降格する。ここで固定したいのは「天地の2本が出ること」なので
  // 位置(z)で確認する（中線のまま出るのは梁がbaseFloorZより上にある実機構成。emitLineの契約）。
  const horizAt = (entry, z) => entry.content.filter(p =>
    p.type === 'line' && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - z) < 1e-6).length;
  const seq3Before = before.find(e => e.seqNo === '3');
  for (const z of [890, 690]) { // 梁の天(topZ=levelOffset)と地(topZ-成200)
    assert.equal(horizAt(seq3Before, z), 0, `前提: 梁を置く前はz=${z}に線が無い`);
    assert.equal(horizAt(afterBySeq['3'], z), 1, `z=${z}に鋼材の天地の線が1本出るはず`);
  }
});

test('【失敗系・WP-C】stairFaceSequence: 構造梁が無い階段は従来どおり（contentForCutへの配線があっても出力が変わらない）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  assert.deepEqual(entries.map(e => e.seqNo), ['1', '2', '3', '4', '5']);
  for (const e of entries) assert.ok(Array.isArray(e.content));
});

// ==== ユーザー実機フィードバック2026-08-23第3弾・項目A ====
// 階段室の上が吹抜け（上階に床が無い）区間は1F天井線・2F床線を描かない（天井断面は上階天井まで
// 一気に抜ける）。原因: 旧実装はseq2/4のfloorSegments/ceilingProfileを「レーン区間=chMm:
// ceilLowAbs固定／踊り場区間=ceilTopAbs固定」というlaneLenOnFace基準の決め打ちで構築しており、
// 上階に実際にRoomがあるか一切確認していなかった（しかも実際には物理的に逆——upperLandingOnly
// 構成では踊り場の真上にこそ2F実床があるため1F天井高さで止まるべきで、レーン側が吹抜けで
// 上階天井まで抜けるべきだった）。buildLaneFloorAndCeilingがaboveLayerの実Room有無で判定する。
test('stairFaceSequence: 上階(2F)の実Roomが踊り場のみ(upperLandingOnly)のとき、seq2/4のレーン区間ceilingProfileは' +
  '上階天井(chUpperAbsMm)まで抜け、踊り場区間は1F天井(chLowerMm)で止まる', () => {
  const graph = makeGraph();
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq2 = entries.find(e => e.seqNo === '2');
  const seq4 = entries.find(e => e.seqNo === '4');

  // seq2: レーン(floorDeltaMm:0)は吹抜け→上階天井(chUpperAbsMm)まで抜けるはず。
  const laneSeg2 = seq2.floorSegments.find(s => s.floorDeltaMm === 0);
  assert.ok(laneSeg2, 'seq2にレーン区間(floorDeltaMm:0)があるはず');
  assert.equal(laneSeg2.floorDeltaMm + laneSeg2.chMm, OPTS.chUpperAbsMm,
    'レーン区間（上階に床が無い＝吹抜け）は上階天井まで抜けるはず');
  // 踊り場の面端（x=face.run側）は実Room有り→1F天井高さ(chLowerMm)で止まるはず。
  const landingEdgeSeg2 = seq2.floorSegments.find(s => Math.abs(s.hiX - seq2.face.run) < 1e-6);
  assert.equal(landingEdgeSeg2.floorDeltaMm + landingEdgeSeg2.chMm, OPTS.chLowerMm,
    '踊り場区間（上階に実Room有り）は1F天井高さで止まるはず');

  assert.equal(seq2.ceilingProfile[0][1], OPTS.chUpperAbsMm, 'ceilingProfile冒頭(レーン側)は上階天井のはず');
  assert.equal(seq2.ceilingProfile[seq2.ceilingProfile.length - 1][1], OPTS.chLowerMm,
    'ceilingProfile末尾(踊り場側)は1F天井のはず');

  // seq4はseq2の鏡像（踊り場が左=x=0側、レーンが右）。
  assert.equal(seq4.ceilingProfile[0][1], OPTS.chLowerMm, 'seq4冒頭(踊り場側)は1F天井のはず');
  assert.equal(seq4.ceilingProfile[seq4.ceilingProfile.length - 1][1], OPTS.chUpperAbsMm,
    'seq4末尾(レーン側)は上階天井のはず');
});

test('【失敗系・ユーザー実機フィードバック2026-08-23第3弾・項目A】stairFaceSequence: 上階(2F)にRoomが無い(upperGraph自体無指定)' +
  '場合は例外を投げず、既存のlaneLenOnFace基準フォールバックのまま動く', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS); // upperGraph未指定
  const seq2 = entries.find(e => e.seqNo === '2');
  assert.ok(Array.isArray(seq2.ceilingProfile) && seq2.ceilingProfile.length >= 2, '例外を投げず既存の形のceilingProfileを返すはず');
});

// ---- 実機フィードバック第3弾D: seq1で「復路ささらの外側(壁側)〜壁」×「z=0〜1F天井」にアキX ----
// stair.cellsが室の全幅をカバーしない構成（stairwell内に階段以外の空きがある実機構成）を
// 独自フィクスチャで再現する: 室(room)はx:[0,2600]の単純矩形（踊り場列・復路列とも
// x=2000〜2600ぶん幅を追加）だが、stair.cells自体は従来どおりx:[0,2000]の3セルのまま
// （階段の構造は室の右端まで届かない＝復路レーンの外側と壁の間に600mmの空きができる）。
test('【実機フィードバック第3弾D】stairFaceSequence: 室が階段の構造(stair.cells)より広ければseq1の壁側にアキXが出る（踊り場線で上=一点鎖線・下=破線に分割）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 2600, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });

  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const landingExtraKey = `${x1.id}:${y0.id}:${x2.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const returnExtraKey = `${x1.id}:${ym.id}:${x2.id}:${y1.id}`;

  const stairCells = new Set([landingKey, outboundKey, returnKey]);
  const roomCells = new Set([landingKey, landingExtraKey, outboundKey, returnKey, returnExtraKey]);
  const room = graph.addRoom(roomCells, '階段');
  generateRoomWallsFromOutline(graph, room);

  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false, structure: StructuralMaterialType.STEEL,
  });
  { // 実機確認済みの表現は「階段下に部屋がある場合」（実機指摘2026-08）。前提を明示する
    // ——この検証（踊り場線でアキXが上=一点鎖線・下=破線に分かれる）は踊り場が基準床の表現。
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size > 0) graph.addRoom(new Set(beyond), '階段下');
  }

  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;

  const centerDiagonals = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.dash === 'center');
  const dashedDiagonals = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.dash === 'dashed');
  assert.equal(centerDiagonals.length, 2, '踊り場線より上(landingAbs〜1F天井)に一点鎖線のXが1組(2本)出るはず');
  assert.equal(dashedDiagonals.length, 2, '踊り場線より下(0〜landingAbs)に破線のXが1組(2本)出るはず');
  for (const p of [...centerDiagonals, ...dashedDiagonals]) {
    assert.ok(Math.abs(p.x1 - seq1.face.run) < 1e-6 || Math.abs(p.x2 - seq1.face.run) < 1e-6,
      'Xの一端は面端(壁の位置。x=face.run)にあるはず');
  }
  for (const p of centerDiagonals) {
    assert.ok(Math.max(-p.y1, -p.y2) <= OPTS.chLowerMm + 1e-6 && Math.min(-p.y1, -p.y2) >= landingAbs - 1e-6,
      '一点鎖線のXはlandingAbs〜chLowerMmの範囲のはず');
  }
});

test('【失敗系・実機フィードバック第3弾D】stairFaceSequence: 室の全幅が階段の構造とちょうど一致するfixtureはseq1に壁側のアキXが出ない（回帰）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setField('structure', StructuralMaterialType.STEEL);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const wallGapDiagonals = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 &&
    (Math.abs(p.x1 - seq1.face.run) < 1e-6 || Math.abs(p.x2 - seq1.face.run) < 1e-6 ||
     Math.abs(p.x1 - 0) < 1e-6 || Math.abs(p.x2 - 0) < 1e-6));
  assert.equal(wallGapDiagonals.length, 0, '室が階段の構造ちょうどに収まるfixtureでは壁側のアキXは出ないはず');
});

// ---- 実機フィードバック第3弾F: kneeWallCapContent（2F腰壁の上端水平線+L字アキ合成） ----
const F_CUT = { seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000 }, viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: 4800 }, baseFloorZ: 0 };
const F_FLOOR_HEIGHT = 2400, F_TOP_HEIGHT = 900, F_CEIL_TOP_ABS = 4800;
const F_KNEE_DROP = { knee: { topHeight: F_TOP_HEIGHT } };

test('【失敗系・実機フィードバック第3弾F】kneeWallCapContent: kneeDropが無ければcontentをそのまま返す', () => {
  const content = [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'thick' }];
  assert.deepEqual(kneeWallCapContent(content, F_CUT, null, F_FLOOR_HEIGHT, F_CEIL_TOP_ABS), content);
});

test('【実機フィードバック第3弾F→2026-08で天端の担当を移管】kneeWallCapContent: 壁の両端縦線を除去する（天端の水平線はemitColumns側が描く。隣接するアキが無ければ壁自身の範囲だけでX）', () => {
  const wallEdge1 = { type: 'line', x1: 1000, y1: -2400, x2: 1000, y2: -3300, weight: 'medium' };
  const wallEdge2 = { type: 'line', x1: 1050, y1: -2400, x2: 1050, y2: -3300, weight: 'thick' };
  const other = { type: 'line', x1: 0, y1: 0, x2: 500, y2: 0, weight: 'thick' };
  const content = [other, wallEdge1, wallEdge2];
  const result = kneeWallCapContent(content, F_CUT, F_KNEE_DROP, F_FLOOR_HEIGHT, F_CEIL_TOP_ABS);

  assert.ok(result.includes(other), '無関係な線はそのまま残るはず');
  assert.equal(result.includes(wallEdge1) || result.includes(wallEdge2), false, '壁の両端縦線は除去されるはず');

  // 天端のCUT水平線はemitColumnsの`cutWallTopEdges`（cut帯から壁ごとに1本）が描くようになったため、
  // 本関数は描かない——両方で描くと同じ線が2本になる（seq1の統合テストで検出される）。
  const topLine = result.find(p => p.type === 'line' && p.y1 === p.y2 && Math.abs(p.y1 - (-3300)) < 1e-6);
  assert.equal(topLine, undefined, '上端水平線はここでは描かない（emitColumns側の担当）');

  const centerDiagonals = result.filter(p => p.dash === 'center');
  assert.equal(centerDiagonals.length, 2, 'X(2本)が1組あるはず');
  const xs = centerDiagonals.flatMap(p => [p.x1, p.x2]);
  assert.ok(Math.min(...xs) >= 1000 - 1e-6 && Math.max(...xs) <= 1050 + 1e-6,
    '隣接するアキが無ければXは壁自身のx範囲(1000〜1050)のままのはず');
});

test('【実機フィードバック第3弾F】kneeWallCapContent: 隣接する既存のアキX(dash:center)を壁の上のXと合成し、1組の大きなXにする', () => {
  const wallEdge1 = { type: 'line', x1: 1000, y1: -2400, x2: 1000, y2: -3300, weight: 'medium' };
  const wallEdge2 = { type: 'line', x1: 1050, y1: -2400, x2: 1050, y2: -3300, weight: 'thick' };
  // 隣接するアキX（壁のhiX=1050にちょうど接し、z範囲もtopZ(3300)〜ceilTopAbs(4800)と一致）。
  const adjX1 = { type: 'line', x1: 1050, y1: -3300, x2: 1400, y2: -4800, weight: 'thin', dash: 'center' };
  const adjX2 = { type: 'line', x1: 1050, y1: -4800, x2: 1400, y2: -3300, weight: 'thin', dash: 'center' };
  const content = [wallEdge1, wallEdge2, adjX1, adjX2];
  const result = kneeWallCapContent(content, F_CUT, F_KNEE_DROP, F_FLOOR_HEIGHT, F_CEIL_TOP_ABS);

  const centerDiagonals = result.filter(p => p.dash === 'center');
  assert.equal(centerDiagonals.length, 2, '合成後もX(2本)は1組のはず（隣接する別のXにはならない）');
  const xs = centerDiagonals.flatMap(p => [p.x1, p.x2]);
  assert.ok(Math.abs(Math.min(...xs) - 1000) < 1e-6 && Math.abs(Math.max(...xs) - 1400) < 1e-6,
    `合成後のXはx=1000〜1400（壁+隣接アキの結合範囲）のはず（実際:${JSON.stringify(centerDiagonals)}）`);
});

test('【失敗系・実機フィードバック第3弾F】kneeWallCapContent: 該当する壁の両端縦線が見つからなければcontentをそのまま返す', () => {
  const content = [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'thick' }];
  const result = kneeWallCapContent(content, F_CUT, F_KNEE_DROP, F_FLOOR_HEIGHT, F_CEIL_TOP_ABS);
  assert.deepEqual(result, content);
});

// ---- 実機フィードバック第3弾B・再現確認: 実機相当（幅1500+1500・直進2500・踊り場1000・
// sections=[11,1,11]・STEEL）でupDirection×flipの4通り×self/secondaryをパラメトリックに検証する。
// stringerPrimitivesのzBoundsクリップ（実機フィードバック第3弾B）が、seq2/seq4のthin(DETAIL)
// polylineの各点のy範囲を必ず[-(baseZ+steps*riser), -baseZ]（flightZBoundsと同じ規約）に
// 収めることを固定する——自flight(self)・他レーンの見えがかり(secondary)の両方が対象。 ----
function makeRealisticSwitchbackFixture(upDirection, flip) {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [11, 1, 11], riser: null, upDirection, flip, structure: StructuralMaterialType.STEEL,
  });
  { // 実機確認済みの表現は「階段下に部屋がある場合」（実機指摘2026-08）。前提を明示する。
    const beyond = cellsBeyondBreak(graph.stairs[0], graph, stair.riser ?? null);
    if (beyond.size > 0) graph.addRoom(new Set(beyond), '階段下');
  }
  const faces = composeRoomFaces(room, graph);
  return { graph, stair, faces };
}

for (const upDirection of ['up', 'down']) {
  for (const flip of [false, true]) {
    test(`【実機フィードバック第3弾B・再現確認】stairFaceSequence: 実機相当fixture(upDirection=${upDirection}・flip=${flip})でseq2/seq4のthin(DETAIL)ポリラインはself/secondaryともflightのFL範囲を超えて突き出さない`, () => {
      const REAL_OPTS = { floorHeight: 3000, chUpperAbsMm: 5400, chLowerMm: 2400 };
      const { stair, faces, graph } = makeRealisticSwitchbackFixture(upDirection, flip);
      const entries = stairFaceSequence(stair, faces, graph, REAL_OPTS);
      assert.ok(entries, 'entriesがnullにならないはず');
      const contribution = { outbound: { baseZ: 0, steps: 11, riserMm: REAL_OPTS.floorHeight / 22 },
        inbound: { baseZ: 11 * (REAL_OPTS.floorHeight / 22), steps: 11, riserMm: REAL_OPTS.floorHeight / 22 } };
      const bounds = (f) => ({ yLo: -(f.baseZ + f.steps * f.riserMm), yHi: f.baseZ === 0 ? 0 : -f.baseZ });
      const outboundB = bounds(contribution.outbound), inboundB = bounds(contribution.inbound);

      let checked = 0;
      for (const seqNo of ['2', '4']) {
        const entry = entries.find(e => e.seqNo === seqNo);
        if (!entry) continue;
        const thinPolylines = entry.content.filter(p => p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.DETAIL));
        for (const poly of thinPolylines) {
          const ys = poly.points.map(p => p[1]);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          // このpolylineがself(outbound)由来かsecondary(inbound)由来かをyの位置で判定し、
          // 対応するflightのFL範囲(yLo〜yHi)を超えていないことを確認する。
          // 突き出しの許容は**踊り場側の端だけ**（ユーザー明示指示2026-08その14「ささら上同士、
          // ささら下同士トリム」: 踊り場桁枠と取り合うため、ささらはその端で踊り場側へ食い込む。
          // 上限は桁枠のせい=300）。FL側は従来どおり厳格に見る——第3弾Bで塞いだ「法線オフセット
          // ぶんの突き出し」はFL側で起きるため、この形なら再発を見逃さない。
          const landingY = -(contribution.outbound.steps * contribution.outbound.riserMm);
          const MITRE_TOL = 300 + 1e-6, STRICT = 1e-6;
          const within = b => maxY <= b.yHi + (Math.abs(b.yHi - landingY) < 1e-6 ? MITRE_TOL : STRICT)
            && minY >= b.yLo - (Math.abs(b.yLo - landingY) < 1e-6 ? MITRE_TOL : STRICT);
          const inOutboundRange = within(outboundB);
          const inInboundRange = within(inboundB);
          assert.ok(inOutboundRange || inInboundRange,
            `seq${seqNo}のthin polyline(y=${minY.toFixed(2)}〜${maxY.toFixed(2)})はoutbound範囲` +
            `(${outboundB.yLo}〜${outboundB.yHi})にもinbound範囲(${inboundB.yLo}〜${inboundB.yHi})にも収まらず突き出しているはず`);
          checked++;
        }
      }
      assert.ok(checked > 0, `seq2/seq4に少なくとも1本はthin(DETAIL)ポリラインがあるはず（STEEL鉄骨階段のため。実際:${checked}本）`);
    });
  }
}

// ---- 実機フィードバック第3弾（続報）: 上階がSTAIR_VOID（最上階の階段footprintに自動指定される
// 無名Room。elevationStair.jsのfindOverlappingVoidRoomと同じ判定対象）なら、seq1/seq2に
// y=-(1F天井=chLowerMm)の水平CUT線（「上階に実Roomがある」ときにのみ出るべき壁キャップ線）が
// 出ないことを固定する——isRealRoom（A2のresolveWallCapZ・Gのslab/open判定と共有）がVOIDだけで
// なくSTAIR_VOIDも正しく除外できているかの確認。 ----
test('【実機フィードバック第3弾・続報】stairFaceSequence: 上階がSTAIR_VOID（最上階の自動配置Room）ならseq1に1F天井高さの水平キャップ線は出ない', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph);
  // stair.cellsと同じ全幅footprintを覆うSTAIR_VOID Roomを上階に置く（findOverlappingVoidRoomと
  // 同じ「stairRoomのfootprintと重なるVOID/STAIR_VOID Room」の構図）。
  const ux0 = upperGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ux1 = upperGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const uy0 = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const uy1 = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const uKey = `${ux0.id}:${uy0.id}:${ux1.id}:${uy1.id}`;
  const stairVoidRoom = upperGraph.addRoom(new Set([uKey]), '階段吹抜け');
  stairVoidRoom.setFeature(RoomFeature.STAIR_VOID);

  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const seq2 = entries.find(e => e.seqNo === '2');
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  for (const [label, entry] of [['seq1', seq1], ['seq2', seq2]]) {
    const wrongCapLine = entry.content.find(p =>
      p.type === 'line' && p.y1 === p.y2 && p.dash === undefined && p.weight === silhouetteWeight &&
      Math.abs(p.y1 - (-OPTS.chLowerMm)) < 1e-6);
    assert.equal(wrongCapLine, undefined,
      `${label}: 上階がSTAIR_VOID(実床なし)のため1F天井高さ(-${OPTS.chLowerMm})の水平キャップ線は出ないはず`);
  }
});

test('【失敗系・実機フィードバック第3弾・続報】stairFaceSequence: 上階に実Room(feature未設定)があればseq1に1F天井高さの水平キャップ線が出る（回帰ガード）', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph);
  const ux0 = upperGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ux1 = upperGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const uy0 = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const uy1 = upperGraph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const uKey = `${ux0.id}:${uy0.id}:${ux1.id}:${uy1.id}`;
  upperGraph.addRoom(new Set([uKey]), '洋室'); // feature未設定=実Room

  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');

  // 線種は奥行きで決まる（ユーザー明示指示2026-08「直近を中線、それ以外を細線」）ため、この
  // キャップ線がSILHOUETTE(medium)かDETAIL(thin)かはその切断で何が最も手前かに依る——本テストの
  // 主張は「上階に実Roomがあればキャップ線が**出る**」ことなので、線種は実線であることだけ見る。
  const capLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.dash === undefined &&
    (p.weight === weightForRole(ElevationLineRole.SILHOUETTE)
      || p.weight === weightForRole(ElevationLineRole.DETAIL)) &&
    Math.abs(p.y1 - (-OPTS.chLowerMm)) < 1e-6);
  assert.ok(capLine, '上階に実Roomがあれば1F天井高さの水平キャップ線が出るはず');
});

// ---- ユーザー実機指摘2026-08「6」D2: seq5の面がレーン区間に切り詰められていた ----
// seq5は「復路レーンの中を切って外側の壁(wOut2)を見る」面。旧実装はwOut2をレーン区間だけに
// 切り詰めていたため踊り場ぶんがfigureに入らず、「踊場断面は図の右側・階段断面は左側」という
// 構図にならなかった。面はwOut2の全長で、向きはseq2側（踊り場が右）に揃える。
test('【実機指摘】stairFaceSequence: seq5の面はwOut2の全長で、seq4とは逆向き（seq2と同じ向き）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  assert.ok(table);
  const seq5 = table.cuts.find(c => c.seqNo === '5');
  const seq4 = table.cuts.find(c => c.seqNo === '4');
  const seq2 = table.cuts.find(c => c.seqNo === '2');
  assert.ok(seq5 && seq4 && seq2);

  assert.ok(Math.abs(seq5.face.run - table.wOut2.run) < 1e-6,
    `seq5の面はwOut2の全長(${table.wOut2.run})のはず（実際:${seq5.face.run}）`);
  assert.equal(seq5.dirSign, seq2.dirSign, 'seq5の向きはseq2側（踊り場が右）のはず');
  assert.equal(seq5.dirSign, -seq4.dirSign, 'seq5はseq4とは逆向きのはず');
  assert.ok((seq5.stairCut?.landings ?? []).length > 0,
    'seq5は踊り場の断面も描くため踊り場を含む寄与を受け取るはず');
  assert.equal(seq5.stairCut.flights.length, 1, '段は復路の1本だけのはず');
});

// ---- 実機指摘2026-08（展開記号）: 記号は「切断の視線の向き」だけで決まる ----
// 症状「左手に登り口・右が踊り場＝9時方向を見ている図なのに記号がB（3時）」「「6」B2はDが正解」。
// 展開記号A/B/C/Dは視線の向きで決まるので、不変条件は `DIR_SIGN[letter] === -cut.viewSign`。
// **`face.dirSign`ではない**——dirSignは歩行方向で決まる作図順であって視線ではなく、実機では
// seq2とseq5が同じ向きを見ている（どちらもD）のにdirSignが違う。旧版はこの不変条件を
// `=== face.dirSign` と書いており、記号を視線基準へ直した時点で前提が失効した。
test('【実機指摘】stairFaceSequence: 展開記号は切断の視線の向き(-viewSign)で決まる（歩行方向のdirSignではない）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  assert.ok(entries && table);
  // 実装の式をそのまま写経しても契約の検証にならないので、ユーザーの言葉どおりの性質で見る:
  // 「同じ世界方向を見ている切断どうしは同じ記号」「向きが違えば違う記号」。
  // 歩行方向のdirSignで決めていた旧実装はこれを満たせなかった（seq2とseq5は同じ向きを見るのに
  // dirSignが違うため別記号になっていた＝実機指摘の症状そのもの）。
  const letterByView = new Map();
  let checked = 0;
  for (const e of entries) {
    const cut = table.cuts.find(c => c.seqNo === e.seqNo);
    if (!cut?.line) continue;
    checked++;
    const key = `${cut.line.isVertical}|${cut.viewSign}`;
    if (!letterByView.has(key)) letterByView.set(key, e.face.letter);
    assert.equal(e.face.letter, letterByView.get(key),
      `seq${e.seqNo}: 同じ視線(${key})なら同じ記号のはず（実際は${e.face.letter}）`);
    assert.equal(cut.line.isVertical, e.face.letter === 'B' || e.face.letter === 'D',
      `seq${e.seqNo}: 記号${e.face.letter}は切断線の軸向き(isVertical=${cut.line.isVertical})と整合しないはず`);
  }
  assert.ok(checked > 0, '検証対象のcutが1つも無いのはおかしい');
  assert.equal(new Set(letterByView.values()).size, letterByView.size,
    '視線の向きが違えば記号も違うはず');
});

// ---- 実機指摘2026-08: 展開記号は歩行順に採番し直す（部屋のコンパス順の連番を持ち込まない） ----
test('【実機指摘】stairFaceSequence: 展開記号のラベルは歩行順に採番される（同記号は出現順に連番）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const labels = entries.map(e => e.face.label);
  assert.equal(labels.length, new Set(labels).size, `ラベルは重複しないはず（実際:${labels}）`);
  // letterごとに、出現順で 1,2,3... の連番（単独ならletterのみ）になっている。
  const seen = new Map();
  for (const e of entries) {
    const n = (seen.get(e.face.letter) ?? 0) + 1;
    seen.set(e.face.letter, n);
    const total = entries.filter(x => x.face.letter === e.face.letter).length;
    assert.equal(e.face.label, total > 1 ? `${e.face.letter}${n}` : e.face.letter);
  }
});

// ---- 実機指摘2026-08: 階段・踊り場下の描画は「下に部屋がある/ない」で異なる ----
// 「階段下に部屋がない場合は、1FL断面線を描画／左右の壁断面線を1FLまで延長」。
// 下に部屋があるとき（既定fixture）は従来どおり踊り場が基準床。
test('【実機指摘】stairFaceSequence: 階段下に部屋が無ければ帯の床・基準床が1FL(0)になる', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withRoomUnder: false });
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const seq3 = entries.find(e => e.seqNo === '3');
  for (const [no, e] of [['1', seq1], ['3', seq3]]) {
    assert.equal(e.floorSegments.length, 1, `seq${no}は全幅1区間のはず`);
    assert.equal(e.floorSegments[0].floorDeltaMm, 0, `seq${no}の床は1FL(0)のはず`);
  }
});

test('【実機指摘】stairFaceSequence: 階段下に部屋があれば従来どおり踊り場が帯の床（回帰）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph); // withRoomUnder既定true
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  assert.ok(seq1.floorSegments[0].floorDeltaMm > 0, '踊り場の高さが帯の床になるはず');
});

// 「左右の壁断面線を1FLまで延長」: 面端の縦線が床(=1FL)まで届く。
test('【実機指摘】stairFaceSequence: 階段下に部屋が無ければseq1の面端縦線が1FLまで延びる', () => {
  const graph = makeGraph();
  const withUnder = makeGraph('pU');
  const a = makeSwitchbackFixture(graph, { withRoomUnder: false });
  const b = makeSwitchbackFixture(withUnder); // 下に部屋あり
  const seqOf = (g, f) => stairFaceSequence(f.stair, composeRoomFaces(f.room, g), g, OPTS)
    .find(e => e.seqNo === '1');
  const bottomOf = (g, f) => {
    const e = seqOf(g, f);
    const prims = buildFaceFigure(e.face, {
      graph: g, project: { openingNumberIndex: new Map() }, room: f.room, ceilingHeight: 2400,
      materialMap: null, gridCLs: [], floorSegments: e.floorSegments,
      skipBaseboard: true, skipWallLabel: true,
    });
    const verts = prims.filter(p => p.type === 'line' && p.x1 === p.x2 && p.weight !== 'thin');
    return Math.max(...verts.map(p => Math.max(p.y1, p.y2))); // yは上向き負。最大=最も下
  };
  assert.equal(bottomOf(graph, a), 0, '部屋が無ければ面端縦線は1FL(y=0)まで届くはず');
  assert.ok(bottomOf(withUnder, b) < 0, '部屋があれば従来どおり踊り場で止まるはず');
});


// ---- ユーザー明示指示2026-08その11: 面は「その切断が見ている面」 ----
// 「A,B,C,Dの抽出と、順番決めロジックがごっちゃになっている」「展開の向きは絶対。後から順番」
// 「D1を東向きと解釈するロジックに間違いがある」。
// 旧実装は、切断（cut）が towardS1（＝往復レーンの境界側）を見ているのに、面には視線の**背後**の
// 壁（wOut1）を結び付けていた。図の向き（D＝西向き）と面の幾何（東向きの壁）が食い違うため、
// 面由来の寸法・向こう側判定が反対側を向き、実機「6」D1が「向こうに壁が無いはずの面」で
// 1500+2000に割れていた。面と切断の向きが一致していることを不変条件として固定する。
test('【明示指示】stairFaceSequence: 各面の幾何(inward)は、その切断の視線(-viewSign)と一致する', () => {
  for (const withMidWall of [false, true]) {
    const graph = makeGraph();
    const { room, stair } = makeSwitchbackFixture(graph, { withMidWall });
    const faces = composeRoomFaces(room, graph);
    const entries = stairFaceSequence(stair, faces, graph, OPTS);
    const table = switchbackCuts(stair, faces, graph, OPTS);
    assert.ok(entries && table);
    let checked = 0;
    for (const e of entries) {
      const cut = table.cuts.find(c => c.seqNo === e.seqNo);
      if (!cut?.line) continue;
      checked++;
      assert.equal(letterOf(e.face.isVertical, e.face.inward), letterOf(cut.line.isVertical, -cut.viewSign),
        `withMidWall=${withMidWall} seq${e.seqNo}: 面の向きと切断の視線が一致するはず（記号${e.face.label}）`);
    }
    assert.ok(checked > 0);
  }
});

test('【明示指示】stairFaceSequence: seq2は往復レーンの境界を見る面・seq4は往路外側の壁を見る面', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: false });
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const table = switchbackCuts(stair, faces, graph, OPTS);
  const axisOf = e => entries.find(x => x.seqNo === e).face.axisCL.effectiveValue;
  const laneBoundary = (table.wOut1.axisCL.effectiveValue + table.wOut2.axisCL.effectiveValue) / 2;

  assert.equal(axisOf('2'), laneBoundary,
    'seq2は往路レーンから往復境界（中心1）を見る面のはず（往路外側の壁ではない）');
  assert.equal(axisOf('4'), table.wOut1.axisCL.effectiveValue,
    'seq4は往路外側の壁を復路側から見る面のはず');
  assert.equal(axisOf('5'), table.wOut2.axisCL.effectiveValue,
    'seq5は復路外側の壁を見る面のはず（従来どおり）');
  // 中心1に実壁が無くても面は作られる（壁の有無はhasRealWallで表す）。
  assert.equal(entries.find(e => e.seqNo === '2').face.hasRealWall, false);
});


// ---- 階段の高さ寸法記入ルール（ユーザー明示指示2026-08その12） ----
// 「床断面、踊り場断面、天井断面いずれかの断面から断面までの寸法記入」
// 「前の展開断面と高さが変わる場合、新たな断面間寸法を記入」
// 実機「6」の指定（1FL=0・踊り場=1500・1F天井=2400・2FL=3000・2F天井=5400、階段下に部屋なし）:
//   C:左に[1FL→踊り場][踊り場→2F天井]、右なし ／ D1:左に[1FL→1F天井][2FL→2F天井]、右に踊り場側
//   A:なし ／ B:左なし・右に通常断面 ／ D2:左なし・右に踊り場側
test('【明示指示】stairChDimChains: 実機「6」の高さ寸法が指定どおりの左右・本数になる', () => {
  const entries = ['1', '2', '3', '4', '5'].map(seqNo => ({ seqNo }));
  const chains = stairChDimChains(entries, {
    landingAbs: 1500, hasRoomUnder: false, chLowerMm: 2400, floorHeight: 3000, chUpperAbsMm: 5400,
  });
  const P = [[0, 1500], [1500, 5400]];  // 踊り場側の端
  const Q = [[0, 2400], [3000, 5400]];  // 踊り場が切れない端（壁の向こうの通常断面）
  assert.deepEqual(chains, [
    { left: P,    right: null }, // C
    { left: Q,    right: P },    // D1
    { left: null, right: null }, // A
    { left: null, right: Q },    // B
    { left: null, right: P },    // D2
  ]);
});

test('stairChDimChains: 階段下に部屋があれば踊り場側は[踊り場→2FL][2FL→2F天井]になる', () => {
  const chains = stairChDimChains([{ seqNo: '1' }], {
    landingAbs: 1200, hasRoomUnder: true, chLowerMm: 2400, floorHeight: 2400, chUpperAbsMm: 4800,
  });
  // 踊り場より下は別室のため帯の床が踊り場になる（既存の受け入れ済み挙動を保つ）。
  assert.deepEqual(chains[0].left, [[1200, 2400], [2400, 4800]]);
});

test('【失敗系】stairChDimChains: 退化した区間（高さ0）は寸法にしない', () => {
  // 踊り場が2F天井と同じ高さ（=上の区間が0）になる退化ケース。
  const chains = stairChDimChains([{ seqNo: '2' }], {
    landingAbs: 3000, hasRoomUnder: false, chLowerMm: 2400, floorHeight: 3000, chUpperAbsMm: 3000,
  });
  assert.deepEqual(chains[0].right, [[0, 3000]], '高さ0の区間は落ちるはず');
});


// ---- 見えがかりのレイキャスト: 手前のささらによる遮蔽（ユーザー明示指示2026-08その16） ----
// 「「6」D1: 復路ささら下、踊り場側は、往路ささら上まで／復路ささらは、往路ささらより奥にある」。
// 切断は往路レーンの中を通るので、視線の手前には往路レーンのささらがある。その上端より下は
// ささら本体（せい300）とその先の踊り場桁枠に隠れ、奥の復路のささらは見えない。
// 旧実装は往復間の壁の有無（isBlockedByWall）しか見ておらず、復路のささら下端が往路ささらを
// 突き抜けて踊り場まで描かれていた。
test('【明示指示】stairFaceSequence: seq2の復路ささら見えがかりは、手前（往路）のささら上端より下へ出ない', () => {
  const REAL_OPTS = { floorHeight: 3000, chUpperAbsMm: 5400, chLowerMm: 2400 };
  const { stair, faces, graph } = makeRealisticSwitchbackFixture('up', false);
  const entries = stairFaceSequence(stair, faces, graph, REAL_OPTS);
  const entry = entries.find(e => e.seqNo === '2');
  assert.ok(entry, '前提: seq2がある');
  const thin = entry.content.filter(p => p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.DETAIL));
  // 手前=往路（FL0〜踊り場）・奥=復路（踊り場〜2FL）。yは上向き負なので、最も下（yが大）に
  // 届くのが往路側。
  const landingY = -(11 * (REAL_OPTS.floorHeight / 22)); // -1500
  // 往路はFL(y=0)に接し、復路は2FL(y=-floorHeight)に接する——この2点で確実に見分ける。
  const self = thin.find(p => p.points.some(q => Math.abs(q[1]) < 1));
  const secondary = thin.find(p => p !== self && p.points.some(q => Math.abs(q[1] + REAL_OPTS.floorHeight) < 1));
  assert.ok(self && secondary, `前提: 往路・復路のささらが両方描かれる（実際:${thin.length}本）`);

  // 往路ささらの上端線＝開いた輪郭の最後の1辺（端の縦線を落としたため、末尾が上端で終わる）。
  const pts = self.points;
  const seg = [pts[pts.length - 2], pts[pts.length - 1]];
  const yAt = x => {
    const [[ax, ay], [bx, by]] = seg;
    const [loX, loY, hiX, hiY] = ax <= bx ? [ax, ay, bx, by] : [bx, by, ax, ay];
    if (x <= loX) return loY;
    if (x >= hiX) return hiY;
    return loY + (x - loX) * (hiY - loY) / (hiX - loX);
  };
  for (const [x, y] of secondary.points) {
    assert.ok(y <= yAt(x) + 1e-6,
      `復路のささらは往路ささらの上端(${Math.round(yAt(x))})より下(${Math.round(y)})へ出ないはず（x=${Math.round(x)}）`);
  }
  // 旧挙動（踊り場桁枠の下端まで突き抜ける）に戻っていないこと。
  const frameBot = landingY + 300 - 60; // 踊り場床+巾木-せい = 桁枠の下端
  assert.ok(Math.max(...secondary.points.map(q => q[1])) < frameBot - 1,
    '復路のささらが踊り場桁枠の下端まで達してはいけない');
});


// ---- 断面線の外は描画しない（ユーザー明示指示2026-09「展開図では、断面線の外は描画しない」
// 「階段下に部屋がある場合、断面下は描画しない」「階段下に部屋がない場合、…階段下の設置階の
// 床断面…まで描画」）。分岐は階段下部屋の有無ひとつ ----
test('stairFaceSequence: 階段下に部屋があると、壁の縦線はどの面でもその位置の床断面線より下に無い', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph); // 既定 withRoomUnder:true
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, OPTS);
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);

  for (const e of entries) {
    const floorAt = (x) => {
      const segs = e.floorSegments;
      const hit = segs.find(s => x >= s.loX - 1 && x <= s.hiX + 1);
      return (hit ?? (x < segs[0].loX ? segs[0] : segs[segs.length - 1])).floorDeltaMm ?? 0;
    };
    for (const p of e.content) {
      if (p.type !== 'line' || Math.abs(p.x1 - p.x2) > 1e-6) continue;
      if (p.weight === detailWeight) continue; // 階段自身の見えがかり（ささらの端面・破線梯子）は別担当
      const floor = floorAt(p.x1);
      assert.ok(Math.min(-p.y1, -p.y2) >= floor - 1e-6,
        `seq${e.seqNo}: x=${p.x1}の縦線が床断面(${floor})より下へ伸びている（${-p.y1}..${-p.y2}）`);
    }
  }
});

test('【失敗系】stairFaceSequence: 階段下に部屋が無ければ壁の縦線は設置階FL(0)まで描く（クリップしない）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withRoomUnder: false });
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, OPTS);

  for (const e of entries) {
    assert.ok(e.floorSegments.every(s => (s.floorDeltaMm ?? 0) === 0),
      `seq${e.seqNo}: 階段下に部屋が無ければ帯の床は設置階FL(0)のはず`);
    const toFloor = e.content.some(p => p.type === 'line' && Math.abs(p.x1 - p.x2) < 1e-6 &&
      Math.abs(Math.min(-p.y1, -p.y2)) < 1e-6);
    assert.ok(toFloor, `seq${e.seqNo}: 設置階FL(0)まで届く縦線があるはず`);
  }
});


// ---- 断面線は折れ線（ユーザー実機指摘2026-09「6」D2）: 2FL断面→復路の階段断面→踊り場断面→
// 壁断面で閉じた輪郭ができ、その下は描かない。踊り場の床線も階段断面と取り合う点で終わる ----
test('stairFaceSequence: seq5の踊り場の床線は階段断面（ジグザグ）の最下点で終わる（flatLineSpanX）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, OPTS);
  const seq5 = entries.find(e => e.seqNo === '5');

  // 復路の断面ジグザグ（CUT/SILHOUETTEのpolyline）の最下点＝踊り場側の段鼻。座標は決め打ちせず
  // 出力から取る（面の幾何が変わっても「断面線と床線が同じ点で出会う」という関係だけを見る）。
  const zigzag = seq5.content.find(p => p.type === 'polyline' && p.points?.length > 1 &&
    (p.weight === weightForRole(ElevationLineRole.CUT) || p.weight === weightForRole(ElevationLineRole.SILHOUETTE)));
  assert.ok(zigzag, 'seq5に復路の断面ジグザグがあるはず');
  const footX = zigzag.points.reduce((a, b) => (b[1] > a[1] ? b : a))[0]; // yが最大＝zが最小＝最下点

  const landingSeg = seq5.floorSegments.find(s => footX >= s.loX - 1e-6 && footX <= s.hiX + 1e-6)
    ?? seq5.floorSegments[0];
  assert.ok(landingSeg.flatLineSpanX, 'seq5の踊り場区間はflatLineSpanXで切り詰められるはず');
  assert.ok(Math.abs(landingSeg.flatLineSpanX.lo - footX) < 1e-6,
    `踊り場の床線の始点はジグザグの最下点x(${footX})のはず（実際:${landingSeg.flatLineSpanX.lo}）`);
});

test('stairFaceSequence: seq5は断面線（ジグザグ）より下に壁contentを描かず、階段自身の断面は残る', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const entries = stairFaceSequence(stair, composeRoomFaces(room, graph), graph, OPTS);
  const seq5 = entries.find(e => e.seqNo === '5');
  const landingAbs = 6 * (OPTS.floorHeight / 12); // n1=6段・riser=階高/12

  // 壁の断面・見えがかり（DETAIL＝階段自身の見えがかり以外）の縦線は、その位置の**断面線**より
  // 下に無い——踊り場の高さではなく輪郭で判定する（seq5の輪郭は踊り場から2FLへ上る階段断面で、
  // 上り口側では踊り場よりずっと高い。クリップを外すと面端の縦線が踊り場まで降りてくる）。
  const below = seq5.content.filter(p =>
    p.type === 'line' && Math.abs(p.x1 - p.x2) < 1e-6 &&
    p.weight !== weightForRole(ElevationLineRole.DETAIL) &&
    Math.min(-p.y1, -p.y2) < drawnFloorProfileZAt(seq5.floorProfile, p.x1) - 1e-6);
  assert.equal(below.length, 0,
    `断面線より下の壁の縦線は描かないはず（実際:${JSON.stringify(below)}）`);
  // 上り口側の面端の縦線は、踊り場ではなく階段断面（＝踊り場より高い位置）から立ち上がる。
  const atX0 = seq5.content.find(p => p.type === 'line' &&
    Math.abs(p.x1) < 1e-6 && Math.abs(p.x2) < 1e-6 && p.weight !== weightForRole(ElevationLineRole.DETAIL));
  assert.ok(atX0, 'seq5の上り口側(x=0)に壁の縦線があるはず');
  assert.ok(Math.min(-atX0.y1, -atX0.y2) > landingAbs + 1e-6,
    `x=0の壁の縦線の下端は踊り場(${landingAbs})より上のはず（実際:${Math.min(-atX0.y1, -atX0.y2)}）`);

  // 階段自身の断面（ジグザグ）は踊り場から2FLまで残る（クリップの巻き添えにしない）。
  const zigzag = seq5.content.find(p => p.type === 'polyline' && p.points?.length > 1);
  assert.ok(zigzag, 'seq5の階段断面（ジグザグ）は残るはず');
  const zs = zigzag.points.map(([, y]) => -y);
  assert.ok(Math.abs(Math.min(...zs) - landingAbs) < 1e-6, `ジグザグの下端は踊り場(${landingAbs})のはず`);
  assert.ok(Math.abs(Math.max(...zs) - OPTS.floorHeight) < 1e-6, 'ジグザグの上端は2FLのはず');
});

// ---- ユーザー裁定2026-09「「6」C 左端X3外側の2階腰壁断面は、2FL断面まで下りて外側に向かって
// 張り出して終了、が正解」: はり出しの外端に**切断壁**（上階の壁の断面）が立つ端では、上階FLの
// 断面線をその壁の**向こう側の面**から外へwallLessEndExtendModelMmぶん張り出して終える
// （壁の下＝面の端〜向こう側の面には引かない）。判定材料はcontentの列で、
// `section/sectionContent.js`の`upperFloorCutWallEndsOf`が唯一の情報源。 ----

// 上階（2F）に「面の端に立つ切断壁」と「その通りに続く壁」を作る:
//   ・2Fの部屋は階段室と同じ矩形（x:[0,2000] y:[0,4500]）。
//   ・cornerFarHalf … 面の端のCL(x=2000)の**外側**半分の壁（隣室ぶん）。これで隅の壁の
//     材が1942.5..2057.5になり、向こう側の面が2057.5になる。
//   ・planeSpan … 面の通り(y=4500)の2F壁を、その隅の壁の向こう側の面(2057.5)まで通す。
//     これではり出し量（planeOverhangForFace）が隅の壁厚ぶん＝115になる。
//   ・beyondFeature … CL(x=2000)の**向こう側**（x:[2000,4000]）の2F部屋のfeature。
//     実データ「6」C（X3の東に2階の実部屋がある）に合わせた既定は null＝実Room。
//     RoomFeature.VOID にすると「吹抜けが続く先に腰壁だけが立つ」構成になり、
//     上階FL断面線のgate（elevationFaces.jsのupperFloorEndsOf）がその端を落とす。
//     壁は生成しない——gateが見るのはセルの所有Roomだけで、壁を足すとはり出し量が変わる。
function makeUpperForOverhang(graph,
  { cornerFarHalf = true, planeSpan = true, beyondFeature = null } = {}) {
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const ux0 = cl(CenterLineType.VERTICAL, 0), ux1 = cl(CenterLineType.VERTICAL, 2000);
  const uy0 = cl(CenterLineType.HORIZONTAL, 0), uy1 = cl(CenterLineType.HORIZONTAL, 4500);
  const roomUp = graph.addRoom(new Set([`${ux0.id}:${uy0.id}:${ux1.id}:${uy1.id}`]), '2F');
  generateRoomWallsFromOutline(graph, roomUp);
  const ux2 = cl(CenterLineType.VERTICAL, 4000);
  const beyond = graph.addRoom(new Set([`${ux1.id}:${uy0.id}:${ux2.id}:${uy1.id}`]), '2F隣室');
  if (beyondFeature) beyond.setFeature(beyondFeature);
  if (cornerFarHalf) graph.addWall(ux1, 57.5, true, uy0, 0, uy1, 0, {});
  if (planeSpan) {
    for (const w of [...graph.walls]) {
      if (w.isVertical || Math.abs(w.axisCL.effectiveValue - 4500) > 1) continue;
      if (w.coord2 > w.coord1) w.endOffset = 57.5; else w.startOffset = 57.5;
    }
  }
  return roomUp;
}

// seq1（踊り場前縁の見返り＝面C）の図を組んで、上階FL(=floorHeight)の水平線だけを返す。
// ctxは**elevationStair.jsのfaceOverrideと同じ集合**を渡す（upperFloorEndsを落とすと
// 本番では出ない線がテストでだけ出る）。
function seq1UpperFloorLines(graph, upperGraph, { room, stair }) {
  const e = stairFaceSequence(stair, composeRoomFaces(room, graph), graph,
    { ...OPTS, upperGraph, wallLessEndExtendModelMm: 150 }).find(x => x.seqNo === '1');
  const prims = buildFaceFigure(e.face, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: OPTS.chLowerMm,
    materialMap: null, gridCLs: [], wallLessEndExtendModelMm: 150,
    floorSegments: e.floorSegments, floorProfile: e.floorProfile, ceilingProfile: e.ceilingProfile,
    upperOverhang: e.upperOverhang, upperFloorZ: e.upperFloorZ,
    upperFloorCutEnds: e.upperFloorCutEnds, upperFloorEnds: e.upperFloorEnds,
    skipBaseboard: true, skipWallLabel: true,
  });
  return { entry: e, run: e.face.run,
    lines: prims.filter(p => p.type === 'line'
      && p.y1 === -OPTS.floorHeight && p.y2 === -OPTS.floorHeight) };
}

test('stairFaceSequence: はり出し外端に上階の切断壁が立つseq1は、壁の向こう側の面から外へ2FL線を張り出す', () => {
  const graph = makeGraph();
  const fixture = makeSwitchbackFixture(graph);
  const upperGraph = makeGraph('p2');
  makeUpperForOverhang(upperGraph);

  const { entry, run, lines } = seq1UpperFloorLines(graph, upperGraph, fixture);
  assert.deepEqual(entry.upperOverhang, { lo: 0, hi: 115 },
    '隅の壁厚ぶん（115）だけ上階の平面が面の端より外へ続く');
  assert.deepEqual(entry.upperFloorCutEnds, { lo: null, hi: run + 115 },
    'はり出し外端(run+115)に切断壁が立つ＝その向こう側の面が2FL線の起点');
  assert.equal(lines.length, 1, '2FL線は切断壁の立つ側だけ1本');
  assert.deepEqual([lines[0].x1, lines[0].x2], [run + 115, run + 115 + 150],
    '壁の向こう側の面から外へwallLessEndExtendModelMm(150)ぶん');
  assert.equal(lines[0].weight, weightForRole(ElevationLineRole.CUT), '床の断面線はCUT（太線）');
  assert.ok(!lines.some(p => Math.min(p.x1, p.x2) < run + 115 - 1e-6),
    '壁の下（面の端〜向こう側の面）には引かない＝切断壁の断面の中を通さない');
});

test('【失敗系】stairFaceSequence: はり出し外端の壁が切断されない構成では2FL線は従来どおりはり出しの中で終わる', () => {
  const graph = makeGraph();
  const fixture = makeSwitchbackFixture(graph);
  const upperGraph = makeGraph('p2');
  // 隅のCLの外側半分の壁を置かない＝面の端に立つ壁の材が仮想断面の外に届かず、外端の列は
  // 切断壁にならない（実データ「6」D2の「外端は全高の見えがかり壁」に相当する側）。
  makeUpperForOverhang(upperGraph, { cornerFarHalf: false });

  const { entry, lines } = seq1UpperFloorLines(graph, upperGraph, fixture);
  assert.deepEqual(entry.upperOverhang, { lo: 0, hi: 115 }, 'はり出し自体は同じ');
  assert.deepEqual(entry.upperFloorCutEnds, { lo: null, hi: null }, '外端に切断壁は立たない');
  // 切断壁が無ければ判断は従来どおり断面線（floorProfile）任せ——seq1の断面線は踊り場の高さで
  // 平らなので上階FLに届かず、1本も引かない（＝実データ「6」Cの修正前の姿）。
  assert.equal(lines.length, 0,
    '外端に切断壁が立たない端では、断面線が上階FLに届かないかぎり引かない');
});

test('【失敗系】stairFaceSequence: 上階の平面が面の端より外へ続かなければ2FL線も切断壁の判定も出ない', () => {
  const graph = makeGraph();
  const fixture = makeSwitchbackFixture(graph);
  const upperGraph = makeGraph('p2');
  makeUpperForOverhang(upperGraph, { planeSpan: false });

  const { entry, lines } = seq1UpperFloorLines(graph, upperGraph, fixture);
  assert.equal(entry.upperOverhang, undefined, 'はり出しが無い＝2FL線を引く区間そのものが無い');
  assert.equal(entry.upperFloorCutEnds, undefined);
  assert.equal(entry.upperFloorEnds, undefined, 'はり出しが無い端はgateも問わない');
  assert.equal(lines.length, 0);
});

// ---- 上階FL断面線のgate（`elevationFaces.js`の`upperFloorEndsOf`）を階段帯にも通す:
// はり出し量は上階の**壁**の伸びしか見ないため、上階が吹抜けのまま境界に腰壁だけが立つ端では
// 床の無い位置に2FL線が出る。上部吹抜けを持つ部屋帯と**同じ1つの関数**で落とす。 ----

test('stairFaceSequence: はり出しの先が上階の吹抜け（床が無い）なら、外端に切断壁が立っても2FL線を引かない', () => {
  const graph = makeGraph();
  const fixture = makeSwitchbackFixture(graph);
  const upperGraph = makeGraph('p2');
  // CL(x=2000)の向こうはVOID＝床が無く、境界には腰壁（cornerFarHalf）だけが立つ構成。
  makeUpperForOverhang(upperGraph, { beyondFeature: RoomFeature.VOID });

  const { entry, run, lines } = seq1UpperFloorLines(graph, upperGraph, fixture);
  assert.deepEqual(entry.upperOverhang, { lo: 0, hi: 115 },
    'はり出し自体（天井断面線・壁エッジ）は実部屋のときと同じ＝上階の壁は実在する');
  assert.deepEqual(entry.upperFloorCutEnds, { lo: null, hi: run + 115 },
    '切断壁の判定も同じ＝落とすのはgateであって列の解釈ではない');
  assert.equal(entry.upperFloorEnds?.hi, false, 'はり出しの向こうに上階の床が無い端');
  assert.equal(lines.length, 0, '床の無い位置に2FL線を引かない');
});

test('【失敗系】stairFaceSequence: はり出しの先が上階の実部屋（feature未設定）なら2FL線は従来どおり出る', () => {
  const graph = makeGraph();
  const fixture = makeSwitchbackFixture(graph);
  const upperGraph = makeGraph('p2');
  makeUpperForOverhang(upperGraph); // beyondFeature=null＝実Room（実データ「6」Cと同じ）

  const { entry, run, lines } = seq1UpperFloorLines(graph, upperGraph, fixture);
  assert.equal(entry.upperFloorEnds?.hi, true, 'はり出しの向こうに上階の実部屋がある端');
  assert.equal(lines.length, 1, 'gateは通り、2FL線は1本出る');
  assert.deepEqual([lines[0].x1, lines[0].x2], [run + 115, run + 115 + 150],
    '壁の向こう側の面から外へwallLessEndExtendModelMm(150)ぶん');
});

// 帯まるごと（buildStairBand→faceOverride→buildFaceFigure）でも同じ結果になるか——上の3件は
// buildFaceFigureを直接呼ぶため、elevationStair.jsのfaceOverrideの配線そのものは通らない。
// 2FL(y=-floorHeight)の太線だけを取り出して2構成を差分で比べる（帯のxCursorに依存しない）。
function bandUpperFloorLines(graph, upperGraph, room) {
  const band = buildStairBand(room, graph, upperGraph,
    { floorHeight: OPTS.floorHeight, wallLessEndExtendModelMm: 150 });
  return band.primitives.filter(p => p.type === 'line'
    && p.weight === weightForRole(ElevationLineRole.CUT)
    && p.y1 === -OPTS.floorHeight && p.y2 === -OPTS.floorHeight)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)].join('..')).sort();
}

test('buildStairBand: 上階FL断面線のgateは帯の組み立て（faceOverride）まで届く——吹抜けの先の1本だけが消える', () => {
  const real = makeGraph(), voided = makeGraph();
  const realUp = makeGraph('p2'), voidedUp = makeGraph('p2');
  const realFix = makeSwitchbackFixture(real), voidFix = makeSwitchbackFixture(voided);
  makeUpperForOverhang(realUp);
  makeUpperForOverhang(voidedUp, { beyondFeature: RoomFeature.VOID });

  const withFloor = bandUpperFloorLines(real, realUp, realFix.room);
  const withVoid  = bandUpperFloorLines(voided, voidedUp, voidFix.room);
  const dropped = withFloor.filter(s => !withVoid.includes(s));
  assert.deepEqual(withVoid, withFloor.filter(s => !dropped.includes(s)),
    'gateで消えるのははり出しの2FL線だけ（他の2FL線は両構成で同じ）');
  assert.equal(dropped.length, 1, `消えるのは1本だけ（実際:${JSON.stringify(dropped)}）`);
  const [lo, hi] = dropped[0].split('..').map(Number);
  assert.ok(Math.abs((hi - lo) - 150) < 1e-6,
    `消えた線ははり出し外の張り出し（wallLessEndExtendModelMm=150）のはず（実際:${hi - lo}）`);
});

test('【失敗系】stairFaceSequence: はり出しの先が上階のSTAIR_VOID（最上階の自動配置Room）でも2FL線を引かない', () => {
  const graph = makeGraph();
  const fixture = makeSwitchbackFixture(graph);
  const upperGraph = makeGraph('p2');
  makeUpperForOverhang(upperGraph, { beyondFeature: RoomFeature.STAIR_VOID });

  const { entry, lines } = seq1UpperFloorLines(graph, upperGraph, fixture);
  assert.equal(entry.upperFloorEnds?.hi, false,
    'STAIR_VOIDも実床が無い（isRealRoomの判定は全モジュール共通）');
  assert.equal(lines.length, 0);
});
