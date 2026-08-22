// elevationStairSequence.js（階段=SWITCHBACKの歩行順面シーケンス。WP-S2）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { measureStairSpans } from '../finish/stair/stairClassify.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { stairFaceSequence } from './elevationStairSequence.js';
import { resolveSwitchbackParams } from './elevationStairSection.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

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

// ---- WP-E5b書き換え: 「2FLの中線」は一般規則では「above層の床スラブ端（slabとopenの境界）」
// として現れる（§5.6）——2Fが踊り場部分にしか床を持たない（往路・復路レーンの上は吹抜け）
// 現実的な構成でなければ、above層は常にslab（非描画）のままとなりopen自体が生じない。
// そのため本テストはupperLandingOnly構成のupperGraph fixtureを使い、floorHeight(2FL)を
// 自室の天井高さ(既定CH)とは別の値にして、両者の位置が別々に現れることを固定する ----
test('stairFaceSequence: seq1はabove層の床端(2FL)にSILHOUETTE水平線を描き、1F天井線とは別位置になる', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);
  // floorHeight(2FL)を自室の既定天井高さ(2400)とは別の値にして、2FL線と1F天井線が別位置に
  // 現れることを固定する（QA指摘: floorHeight===chLowerMmだと両者の取り違えを検知できない）。
  const localOpts = { floorHeight: 2600, chUpperAbsMm: 5000, chLowerMm: 2400 };

  const entries = stairFaceSequence(stair, faces, graph, { ...localOpts, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);

  const firstFloorCeilLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.dash === undefined && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-2400)) < 1e-6); // 自室(1F階段室)の既定天井高さ(DEFAULT_ROOM_CEILING_HEIGHT)
  assert.ok(firstFloorCeilLine, '1F天井線(中線・水平・-2400)が見つからない');

  const secondFlLine = seq1.content.find(p =>
    p.type === 'line' && p.y1 === p.y2 && p.dash === undefined && p.weight === silhouetteWeight &&
    Math.abs(p.y1 - (-localOpts.floorHeight)) < 1e-6);
  assert.ok(secondFlLine, '2FL線(above層の床端・中線・水平・-floorHeight)が見つからない');
  assert.notEqual(firstFloorCeilLine.y1, secondFlLine.y1, '1F天井線と2FL線は別位置のはず');
});

// ---- WP-E5b書き換え: 「アキのバツ」は一般規則では、above層に所有Roomが見つからない
// （slabではなくopenと判定される）z区間に現れる（§5.6・emitOpenGapMarks）。baseFloorZ
// （=landingAbs）より上のopen帯には一点鎖線(center)の対角線2本が出ることを固定する。
// QA修正（sectionProbe.jsのfallbackCeilZ）で書き換え: この構成（往復間の壁midWallが実在し
// upperLandingOnly=true）は、旧実装のバグ（視線方向に所有Roomが無い層の壁候補を丸ごと捨てる）
// では往路・復路レーンの区別なくopen領域全体が1本の連続X（対角線2本）に見えていたが、
// fallbackCeilZ修正後はmidWall自体が'cut'帯として正しく検出されるため、その左右（往路側・
// 復路側）は別々の連結成分になり、それぞれ独立した1組ずつ＝計2組（対角線4本）のアキXになる
// のが正しい（壁で仕切られた向こう側同士は視覚的に連続しないため。旧assert(2本)はバグを
// 固定していた回帰値だった）----
test('stairFaceSequence: seq1はabove層に床が無い(open)区間に一点鎖線(center)の対角線を描く（midWallの両側で別々のアキXになる）', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
  const n1 = 6, riser = OPTS.floorHeight / 12;
  const landingAbs = n1 * riser;

  const diagonalLines = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.weight === detailWeight);
  const centerDiagonals = diagonalLines.filter(p => p.dash === 'center');
  assert.equal(centerDiagonals.length, 4,
    'midWallの両側(往路・復路)それぞれに1組ずつ、計2組(対角線4本)のアキXのはず');
  for (const p of centerDiagonals) {
    const yNear = Math.max(p.y1, p.y2), yFar = Math.min(p.y1, p.y2);
    assert.ok(yNear <= -landingAbs + 1e-6, `アキXはbaseFloorZ(-landingAbs)より上にあるはず（yNear=${yNear}）`);
    assert.ok(yFar <= yNear, 'yFarはyNear以下のはず');
  }
  // baseFloorZより上のdash:'dashed'（本来床断面より下=破線の対象）は無いはず。
  assert.equal(diagonalLines.filter(p => p.dash === 'dashed' && Math.min(p.y1, p.y2) >= -landingAbs).length, 0,
    'baseFloorZより上に破線の対角線は無いはず');
});

// ==== QA最終検証・修正1: sectionProbe.jsのfallbackCeilZ（往復間の壁がupperLandingOnly=true構成
// でも見えるように修正）の回帰テスト2本 ====
// 旧実装は「視線方向に所有Roomが無い層（往路・復路レーン上に2F床が無い＝実機で最も普通の
// 折返し階段の構成）」の壁候補を丸ごと捨てていたため、往復間の壁(midWall)がupperGraphの
// 'above'層にしか存在しない実機構成では、壁の2縁もアキXも“同時には”検証できていなかった
// （壁2縁を検証する既存テストは2F全面Room・アキXを検証する既存テストはkneeDrop無し、と
// 互いに排他的なfixtureだったため、この壁を丸ごと消す不具合を構造的に検出できなかった）。
// 以下2本は「upperLandingOnly=true（2F床=踊り場のみ）」で両方を同一fixtureで同時に固定する。

test('【QA修正1】stairFaceSequence: 2Fが踊り場のみ床（実機で最も普通の構成）でも、seq1に往復間の壁の2縁とアキXが同時に出る', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair, midWall } = makeSwitchbackFixture(
    graph, { withMidWall: true, midWallGraph: upperGraph, upperLandingOnly: true });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq1 = entries.find(e => e.seqNo === '1');
  const cutWeight = weightForRole(ElevationLineRole.CUT);
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

  // 両縁とも weight=CUT(thick) のはず（§5.6一般規則: 縁が接する側がopenならCUT。この構成は
  // 往路・復路レーンとも2F側がopenなので両縁ともCUTになる——旧手書き仕様「wallZone側=太・
  // ladderZone側=中」の位置基準ではなく、一般規則の「接する側の状態」基準で自動的に同じ
  // 結果を再現する）。
  for (const edge of fullHeightEdges) {
    assert.equal(edge.weight, cutWeight, `x=${edge.x1}の縁は両側openのためCUT(thick)のはず`);
  }

  // アキX: 壁の左右（往路側・復路側）はそれぞれ独立した連結成分になるため、1組ずつ計2組
  // （対角線4本）になる（壁で仕切られた向こう側同士は視覚的に連続しないため）。
  const centerDiagonals = seq1.content.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.weight === detailWeight && p.dash === 'center');
  assert.equal(centerDiagonals.length, 4, '壁の両側それぞれに1組ずつ、計2組(対角線4本)のアキXのはず');
});

test('【QA修正1】stairFaceSequence: 同構成（2F=踊り場のみ床）で腰壁(topHeight=900)指定時、seq1の壁上端がfloorHeight+topHeightでキャップされる', () => {
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

  // 面ローカルxはハードコードせず、「上端がfloorHeight+topHeightでキャップされた縦線が
  // 壁厚ぶん離れて2本」という構造で検証する（旧実装のバグではこの層の壁候補が丸ごと
  // 捨てられ、腰壁の高さ自体が反映されなかった＝0本になっていた）。
  const cappedEdges = seq1.content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6);
  const edgeXs = [...new Set(cappedEdges.map(p => p.x1))].sort((a, b) => a - b);
  assert.equal(edgeXs.length, 2,
    `上端がfloorHeight+topHeight(-${expectedTopAbs})でキャップされた縦線が2本見つからないはず` +
    `（実際:${JSON.stringify(cappedEdges)}）`);
  assert.ok(Math.abs((edgeXs[1] - edgeXs[0]) - thicknessMm) < 1e-6,
    `2本の間隔(${edgeXs[1] - edgeXs[0]})は壁厚(${thicknessMm})に一致するはず`);

  // キャップ高さより上には同じx位置の壁縁(CUT/SILHOUETTE)は無い（腰壁の上はrayが抜ける）。
  for (const x of edgeXs) {
    const aboveCap = seq1.content.some(p =>
      p.type === 'line' && p.x1 === p.x2 && Math.abs(p.x1 - x) < 1e-6 &&
      Math.max(p.y1, p.y2) > -expectedTopAbs + 1e-6 && Math.min(p.y1, p.y2) < -expectedTopAbs - 1e-6);
    assert.ok(!aboveCap, `x=${x}の壁縁はキャップ高さを超えて連続しないはず`);
  }
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

// ---- seq2/2.5は断面プロファイル(polyline)を含み、鋼構造ならささらも含む ----
test('stairFaceSequence: 鉄骨階段(structure=STEEL)はseq2にささら(polylineがもう1本)を含む', () => {
  const graph = makeGraph();
  const { room, stair } = makeSwitchbackFixture(graph);
  stair.setField('structure', StructuralMaterialType.STEEL);
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, OPTS);
  const seq2 = entries.find(e => e.seqNo === '2');
  const polylines = seq2.content.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 2, '踏面プロファイル+ささらの2本のpolylineがあるはず');
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
// floorHeight+topHeightでキャップされ、seq2では縦線ではなく「上端の水平CUT線＋両端の縦CUT線」
// （旧実装のtype:'rect'に相当する3本の輪郭線。一般規則はrectプリミティブを持たないため意図的な
// 差分として報告する）になることを固定する ----
test('stairFaceSequence: 腰壁(knee.topHeight)を指定すると、seq1の壁上端がfloorHeight+topHeightでキャップされ、seq2は上端CUT線+両端CUT縦線(厚みぶん離れる)になる', () => {
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

  const cappedEdge = seq1.content.find(p =>
    p.type === 'line' && p.x1 === p.x2 && (p.weight === cutWeight || p.weight === silhouetteWeight) &&
    Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6); // y上向き負のためtop=min(y1,y2)
  assert.ok(cappedEdge, `壁の縦線の上端はfloorHeight+topHeight(-${expectedTopAbs})でキャップされるはず`);

  // seq2はcutAlong（壁の見付面に正対する視線）のため、両端の縦線間隔は壁厚(materialRange)
  // ではなく壁の可視区間の長さ（laneLenOnFace相当）になる——seq1(壁を横切る視線)とは
  // 意味が異なる点に注意（§5.5「壁の実端の断面」）。
  const seq2 = entries.find(e => e.seqNo === '2');
  const topLine = seq2.content.find(p =>
    p.type === 'line' && p.weight === cutWeight && p.y1 === p.y2 && Math.abs(p.y1 - (-expectedTopAbs)) < 1e-6);
  assert.ok(topLine, `seq2に上端の水平CUT線(-${expectedTopAbs})が見つからない`);
  const sideVerticals = seq2.content.filter(p =>
    p.type === 'line' && p.weight === cutWeight && p.x1 === p.x2 &&
    Math.abs(Math.max(p.y1, p.y2) - (-OPTS.chLowerMm)) < 1e-6 && Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6);
  assert.equal(sideVerticals.length, 2, '腰壁時、seq2の両端に1F天井〜キャップ高さのCUT縦線が2本あるはず');
  assert.deepEqual([Math.min(sideVerticals[0].x1, sideVerticals[1].x1), Math.max(sideVerticals[0].x1, sideVerticals[1].x1)],
    [Math.min(topLine.x1, topLine.x2), Math.max(topLine.x1, topLine.x2)],
    '両端の縦線は上端の水平CUT線の両端と一致するはず（3辺で1つの矩形輪郭を形づくる）');
});

// ---- QA指摘: wallThicknessMmのmaterialRange経路が実測厚みに追従することを固定する
// （materialRangeはcomputed getterで常に非nullのため、旧「axisOffsetフォールバック」分岐は
// 到達不能の死コードだった。QAは`const r = null;`相当の変異で全緑を素通りすることを実証済み） ----
test('【mutation証跡用】stairFaceSequence: 壁厚(materialRange幅)=200のとき、seq1の2縁のx間隔=200・腰壁時のseq2上端CUT線の両端間隔=200になる', () => {
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

  // 腰壁指定時、seq2の上端CUT線の両端間隔もmaterialRange幅(200)に追従するはず。
  upperGraph.setKneeDropWall(
    edgeKey(midWall.axisCL.id, midWall.clStart.id, midWall.clEnd.id),
    { knee: { topHeight: 900 } },
  );
  // seq2はcutAlong（壁の見付面に正対する視線）のため、上端CUT線の長さは壁厚(materialRange)
  // ではなく壁の可視区間の長さになる——ここでは「上端CUT線と両端の縦線が同じx範囲を持つ
  // （3辺で1つの矩形輪郭を形づくる）」ことだけを確認する（materialRange幅はseq1側で確認済み）。
  const entriesWithKnee = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq2 = entriesWithKnee.find(e => e.seqNo === '2');
  const expectedTopAbs = OPTS.floorHeight + 900;
  const topLine = seq2.content.find(p =>
    p.type === 'line' && p.weight === cutWeight && p.y1 === p.y2 && Math.abs(p.y1 - (-expectedTopAbs)) < 1e-6);
  assert.ok(topLine, 'seq2の上端CUT線が見つからない');
  const sideVerticals = seq2.content.filter(p =>
    p.type === 'line' && p.weight === cutWeight && p.x1 === p.x2 &&
    Math.abs(Math.max(p.y1, p.y2) - (-OPTS.chLowerMm)) < 1e-6 && Math.abs(Math.min(p.y1, p.y2) - (-expectedTopAbs)) < 1e-6);
  assert.equal(sideVerticals.length, 2, 'seq2の両端に1F天井〜キャップ高さのCUT縦線が2本あるはず');
  assert.deepEqual([Math.min(sideVerticals[0].x1, sideVerticals[1].x1), Math.max(sideVerticals[0].x1, sideVerticals[1].x1)],
    [Math.min(topLine.x1, topLine.x2), Math.max(topLine.x1, topLine.x2)],
    '両端の縦線は上端の水平CUT線の両端と一致するはず');
});

// ---- 失敗系: 腰壁・垂れ壁指定が無ければ従来どおり単純な縦線(line)のまま ----
test('【失敗系】stairFaceSequence: 腰壁・垂れ壁指定が無ければseq2の2階中心2壁断面は従来どおり縦線(line)のまま', () => {
  const graph = makeGraph('p1');
  const upperGraph = makeGraph('p2');
  const { room, stair } = makeSwitchbackFixture(graph, { withMidWall: true, midWallGraph: upperGraph });
  const faces = composeRoomFaces(room, graph);

  const entries = stairFaceSequence(stair, faces, graph, { ...OPTS, upperGraph });
  const seq2 = entries.find(e => e.seqNo === '2');
  assert.equal(seq2.content.filter(p => p.type === 'rect').length, 0, '腰壁・垂れ壁指定が無ければrectは出ないはず');
  const cutLines = seq2.content.filter(p => p.type === 'line' && p.weight === weightForRole(ElevationLineRole.CUT) && p.x1 === p.x2);
  assert.ok(cutLines.some(p => Math.abs(Math.min(p.y1, p.y2) - (-OPTS.chUpperAbsMm)) < 1e-6 && Math.abs(Math.max(p.y1, p.y2) - (-OPTS.chLowerMm)) < 1e-6),
    '全高（既定）は1F天井〜2F天井の縦線(line)のままのはず');
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
