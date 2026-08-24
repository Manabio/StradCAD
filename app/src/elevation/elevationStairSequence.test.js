// elevationStairSequence.js（階段=SWITCHBACKの歩行順面シーケンス。WP-S2）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomFeature, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { measureStairSpans } from '../finish/stair/stairClassify.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { stairFaceSequence, kneeWallCapContent } from './elevationStairSequence.js';
import { resolveSwitchbackParams } from './elevationStairSection.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';
import { DIR_SIGN } from './elevationFaces.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// 折返し階段（SWITCHBACK）の3セル構成: 踊り場(全幅・上端y:[0,1500])＋往路レーン(左列・x:[0,1000])＋
// 復路レーン(右列・x:[1000,2000])、いずれもy:[1500,4500]。全体は単純な矩形(x:[0,2000],y:[0,4500])
// になるため generateRoomWallsFromOutline は通常の4面矩形の壁を生成する。
// upDirection='up'（t=0がy=4500=下端=上り口、t=1がy=0=上端=踊り場）・flip=false
// （s=0が左列=往路、s=1が右列=復路）で makeFrame の走行方向と一致させる。
function makeSwitchbackFixture(graph, { withMidWall = false, midWallGraph = null, upperLandingOnly = false } = {}) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });

  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);

  const room = graph.addRoom(cells, '階段');
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

// ---- WP-E5b書き換え: エンジン化により、seq1の壁断面は「往復間の壁があるかどうか」に関わらず
// 一般規則（見えがかり壁のSILHOUETTE輪郭＋踊り場断面線=baseFloorZより下の降格）で描かれる。
// 壁が無い（往路・復路の間に実壁が無い）このfixtureでは、見えがかりで見える先の壁
// （見返り先の実壁）の輪郭が面全幅の縦線として現れ、踊り場（baseFloorZ=landingAbs）より下は
// DETAIL破線へ降格する——旧実装が個別にpush していた「両端x=0/runのdashed縦線」に相当する
// 保存意味論（「踊り場より下の壁断面=細破線」）を、一般規則の降格結果として確認する ----
test('stairFaceSequence: seq1(W_entry・壁無し)は両端(x=0/run)の壁輪郭縦線が踊り場(landingAbs)より下でDETAIL破線に降格する', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq1 = entries.find(e => e.seqNo === '1');
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  // 踊り場より下(y:0..-landingAbs)の両端(x=0/run)は破線・DETAIL（-0との対消滅を避けるため
  // Math.abs(x1-0)の近さで比較する）。
  const belowDashedXs = seq1.content
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.dash === 'dashed' && p.weight === detailWeight &&
      Math.abs(p.y1 - 0) < 1e-9 && Math.abs(p.y2 - (-landingAbs)) < 1e-9)
    .map(l => l.x1).sort((a, b) => a - b);
  assert.equal(belowDashedXs.length, 2, '両端(x=0とx=wEntry.run)の踊り場より下は破線のはず');
  assert.ok(Math.abs(belowDashedXs[0] - 0) < 1e-6 && Math.abs(belowDashedXs[1] - seq1.face.run) < 1e-6,
    `踊り場より下の破線は両端(0, ${seq1.face.run})にあるはず（実際:${belowDashedXs}）`);

  // 踊り場より上(y:-landingAbs..-chLowerMm)の両端は通常のSILHOUETTE(実線)のまま降格しない。
  const aboveSilXs = seq1.content
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.dash === undefined && p.weight === silhouetteWeight &&
      Math.abs(p.y1 - (-landingAbs)) < 1e-9 && Math.abs(p.y2 - (-OPTS.chLowerMm)) < 1e-9)
    .map(l => l.x1).sort((a, b) => a - b);
  assert.equal(aboveSilXs.length, 2, '両端の踊り場より上はSILHOUETTE実線のままのはず');
  assert.ok(Math.abs(aboveSilXs[0] - 0) < 1e-6 && Math.abs(aboveSilXs[1] - seq1.face.run) < 1e-6,
    `踊り場より上のSILHOUETTEは両端(0, ${seq1.face.run})にあるはず（実際:${aboveSilXs}）`);
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
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
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

  // 踊り場より下(0..landingAbs)は同じ2本のxがDETAIL破線に降格する。
  const belowDashedXs = seq1.content
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.dash === 'dashed' && p.weight === detailWeight &&
      Math.abs(p.y1 - 0) < 1e-9 && Math.abs(p.y2 - (-landingAbs)) < 1e-9)
    .map(p => p.x1);
  for (const x of aboveXs) {
    assert.ok(belowDashedXs.some(bx => Math.abs(bx - x) < 1e-6),
      `x=${x}の踊り場より下はDETAIL破線のはず`);
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

  const topCapLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.dash === undefined && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-localOpts.chUpperAbsMm)) < 1e-6);
  assert.ok(topCapLine, '壁の輪郭は上階天井(-chUpperAbsMm)まで届くはず');
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

test('【QA修正1・実機フィードバック第3弾A2で一部書き換え】stairFaceSequence: 2Fが踊り場のみ床（実機で最も普通の構成）でも、seq1に往復間の壁の2縁が出る（隣接するentry壁が上階天井まで塞ぐためSILHOUETTE・アキXは無し）', () => {
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

  // 両縁とも weight=SILHOUETTE(medium) のはず（§5.6一般規則: 縁が接する側がopenならCUT・
  // 塞がれていればSILHOUETTE。実機フィードバック第3弾A2で書き換え: A2修正前は隣接列
  // （往路・復路のentry壁）が1F天井高さで誤って途切れ「open」に見えていたためCUTだったが、
  // A2修正後はentry壁が上階天井まで連続して見えがかりを塞ぐため、隣接列は「open」ではなく
  // 「wall」——一般規則どおり塞がれた側としてSILHOUETTEになるのが正しい）。
  for (const edge of fullHeightEdges) {
    assert.equal(edge.weight, weightForRole(ElevationLineRole.SILHOUETTE),
      `x=${edge.x1}の縁は両側とも壁で塞がれているためSILHOUETTE(medium)のはず`);
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

  // 面端(x=0/run)には見えがかり壁の輪郭(縦線)がある（1F天井=chLowerMmまで）。
  for (const x of [0, seq2.face.run]) {
    const edge = seq2.content.find(p =>
      p.type === 'line' && p.x1 === x && p.x2 === x &&
      (p.weight === cutWeight || p.weight === silhouetteWeight) &&
      Math.abs(p.y1 - 0) < 1e-6 && Math.abs(p.y2 - (-OPTS.chLowerMm)) < 1e-6);
    assert.ok(edge, `面端(x=${x})に壁の縁(0..-chLowerMm)が見つからない`);
  }
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

test('【QA修正・実機フィードバック】stairFaceSequence: seq2/seq4のレーン区間床線(FL)は「階段断面に出会ったら終点」＝hideFlatLine:trueで貫通しない', () => {
  const graph = makeGraph();
  const { room, stair } = makeUserDimsFixture(graph);
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);

  for (const seqNo of ['2', '4']) {
    const entry = entries.find(e => e.seqNo === seqNo);
    const laneSeg = entry.floorSegments.find(s => s.floorDeltaMm === 0);
    assert.ok(laneSeg, `seq${seqNo}にfloorDeltaMm:0(レーン)区間があるはず`);
    assert.equal(laneSeg.hideFlatLine, true,
      `seq${seqNo}のレーン区間はhideFlatLine:trueのはず（階段断面(ジグザグ)が既に境界を表すため）`);
    const landingSeg = entry.floorSegments.find(s => s.floorDeltaMm > 0);
    assert.ok(!landingSeg.hideFlatLine, `seq${seqNo}の踊り場区間は通常どおり床線を描くはず`);
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
  for (const seqNo of ['2', '4', '5']) {
    const grew = afterBySeq[seqNo].content.length - beforeLens[seqNo];
    assert.equal(grew, 4, `seq${seqNo}は断面矩形4本ぶん増えるはず`);
  }
  const seq2Added = afterBySeq['2'].content.filter(p => p.weight === 'thick' && p.type === 'line');
  assert.ok(seq2Added.length >= 4, 'seq2はbaseFloorZ(0)より梁が上のためCUT(太線)のままのはず');

  assert.equal(afterBySeq['1'].content.length, beforeLens['1'], 'seq1（正面視・back辺と平行でない）は変化しないはず');
  assert.equal(afterBySeq['3'].content.length, beforeLens['3'], 'seq3（踊り場CUT水平線のみ）は変化しないはず');
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

test('【実機フィードバック第3弾F】kneeWallCapContent: 壁の両端縦線を上端水平線(CUT)へ差し替える（隣接するアキが無ければ壁自身の範囲だけでX）', () => {
  const wallEdge1 = { type: 'line', x1: 1000, y1: -2400, x2: 1000, y2: -3300, weight: 'medium' };
  const wallEdge2 = { type: 'line', x1: 1050, y1: -2400, x2: 1050, y2: -3300, weight: 'thick' };
  const other = { type: 'line', x1: 0, y1: 0, x2: 500, y2: 0, weight: 'thick' };
  const content = [other, wallEdge1, wallEdge2];
  const result = kneeWallCapContent(content, F_CUT, F_KNEE_DROP, F_FLOOR_HEIGHT, F_CEIL_TOP_ABS);

  assert.ok(result.includes(other), '無関係な線はそのまま残るはず');
  assert.equal(result.includes(wallEdge1) || result.includes(wallEdge2), false, '壁の両端縦線は除去されるはず');

  const topLine = result.find(p => p.type === 'line' && p.y1 === p.y2 && Math.abs(p.y1 - (-3300)) < 1e-6);
  assert.ok(topLine, '上端水平線(z=3300)があるはず');
  assert.ok(Math.abs(Math.abs(topLine.x1 - topLine.x2) - 50) < 1e-6, '上端水平線の幅は壁厚(50)のはず');

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
          const inOutboundRange = maxY <= outboundB.yHi + 1e-6 && minY >= outboundB.yLo - 1e-6;
          const inInboundRange = maxY <= inboundB.yHi + 1e-6 && minY >= inboundB.yLo - 1e-6;
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
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  const capLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.dash === undefined && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-OPTS.chLowerMm)) < 1e-6);
  assert.ok(capLine, '上階に実Roomがあれば1F天井高さの水平キャップ線が出るはず');
});

// ---- 実機指摘2026-08（展開記号）: 歩行方向へ倒したdirSignとletterが食い違っていた ----
// 症状「左手に登り口・右が踊り場＝9時方向を見ている図なのに記号がB（3時）」。展開記号A/B/C/Dは
// 視線の向き＝図の左→右がどちらの世界方向かで決まるため、`DIR_SIGN[letter] === face.dirSign` は
// 面の不変条件。reorientFaceが歩行方向へdirSignだけ倒してletterを据え置いていたのが原因。
test('【実機指摘】stairFaceSequence: 全エントリでDIR_SIGN[letter]===face.dirSign（展開記号は視線の向きと一致する）', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true });
  const faces = composeRoomFaces(room, graph);
  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  assert.ok(entries);
  for (const e of entries) {
    assert.equal(DIR_SIGN[e.face.letter], e.face.dirSign,
      `seq${e.seqNo}: 記号${e.face.letter}(DIR_SIGN=${DIR_SIGN[e.face.letter]})とdirSign=${e.face.dirSign}が食い違う`);
    assert.equal(e.face.isVertical, e.face.letter === 'B' || e.face.letter === 'D',
      `seq${e.seqNo}: 記号${e.face.letter}は壁の軸向き(isVertical=${e.face.isVertical})と整合しないはず`);
  }
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
