// sectionStair.js（WP-E3: stairContribution / stairPrimitivesForCut）の単体テスト。
// §9「WP-E3のみ階段fixture経由可」に従い、elevationStairSequence.test.jsと同じ折返し階段
// フィクスチャ（makeSwitchbackFixture）を再利用する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { stairContribution, stairPrimitivesForCut, clipStringerToAnchors, landingFramePrimitives, stairWallGapZones } from './sectionStair.js';

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

// ==== QA実機フィードバック修正（ラウンド2）====
// 根本原因: 旧stairContributionはoutbound/inboundのacrossLo/acrossHiをroomBounds(x1/x2等)から
// 直接求めており、stair.flip===trueがmakeFrameのacrossAt(s)で行うs反転(ss=1-s)を反映していな
// かった——実機データがflip===trueだと往路の梯子・ジグザグが幅方向で本来と逆の半分に描かれる。
test('【QA修正・実機フィードバックR2】stairContribution: flip===trueでも往路(outbound)はmakeFrameのs=0側(flip反映済み)の半分になる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  stair.setField('flip', true);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c);
  assert.ok(c.flights[0].acrossLo >= 1000 - 1e-6,
    `flip=trueなら往路はacrossHi側(x>=1000)のはず（実際acrossLo=${c.flights[0].acrossLo}）`);
  assert.ok(c.flights[1].acrossHi <= 1000 + 1e-6,
    `flip=trueなら復路はacrossLo側(x<=1000)のはず（実際acrossHi=${c.flights[1].acrossHi}）`);
});

test('【失敗系・QA修正・実機フィードバックR2】stairContribution: flip===false(既定)は往路がacrossLo側のまま(従来どおりの挙動を維持)', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c.flights[0].acrossHi <= 1000 + 1e-6, 'flip=falseなら往路はacrossLo側のまま(既存挙動)のはず');
  assert.ok(c.flights[1].acrossLo >= 1000 - 1e-6, 'flip=falseなら復路はacrossHi側のまま(既存挙動)のはず');
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
  // 最終段の踏面は次区間（踊り場）の床が兼ねるため出さない。蹴上は蹴込ぶん傾いた斜線1本
  // なので、蹴込の有無に関わらず 起点1+蹴上6+踏面5。
  assert.equal(prims[0].points.length, 1 + 6 + 5,
    '往路の段数(6)ぶんの蹴上6点＋踏面5点＋起点があるはず');
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

// ---- 実機フィードバック第3弾C: CUT断面（踊り場床CUT線）はbaseFloorZより下でも降格しない ----
test('【実機フィードバック第3弾C】stairPrimitivesForCut: 踊り場床CUT線はcut.baseFloorZより下でも太線実線のまま（neverDowngrade）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const landingZ = c.landings[0].z;
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 },
    baseFloorZ: landingZ + 1, // 踊り場床より上を基準床にする＝踊り場床線は「向こう側」になる
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 1);
  assert.equal(prims[0].weight, 'thick',
    'baseFloorZより下でもCUT断面(踊り場床線)は太線実線のまま降格しないはず');
  assert.equal(prims[0].dash, undefined, 'dashは付かないはず');
});

// ---- 実機フィードバック第3弾C: CUT断面（ささら正面視矩形）もbaseFloorZより下で降格しない ----
test('【実機フィードバック第3弾C】stairPrimitivesForCut: ささら正面視矩形(CUT)はbaseFloorZより下でも太線実線のまま（neverDowngrade）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 },
    baseFloorZ: 3000, // 全高より高いbaseFloorZにして、ささら矩形を強制的に「向こう側」にする
  };
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  assert.equal(cutLines.length, 8, 'baseFloorZより下でも8本ともCUT(thick)のまま降格しないはず');
  for (const p of cutLines) assert.equal(p.dash, undefined, 'dashは付かないはず');
});

// ---- ユーザー実機指摘2026-08「6」: 面の描画範囲の外に断面矩形を出さない ----
// 実機ではささら・踊り場桁枠の12×300矩形が、面が0..2885なのに x=-57.5..-45.5 や
// x=2942.5..2954.5（半壁厚ぶん外）に、seq2では x=3500..3512（run=3442.5の外）に出ていた。
// 梁の断面と同じ規則（sectionTypes.jsのcutDrawRange）でstringerRectLinesの入口で落とす。
test('【実機指摘】stairPrimitivesForCut: 面の描画範囲の外にある断面矩形は描かない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] }];
  const base = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const inRange = stairPrimitivesForCut(c, base, columns)
    .filter(p => p.type === 'line' && p.weight === 'thick');
  assert.ok(inRange.length > 0, '前提: 通常の範囲では断面矩形が出る');
  for (const p of inRange) {
    assert.ok(Math.min(p.x1, p.x2) <= 2000 + 1e-6 && Math.max(p.x1, p.x2) >= -1e-6,
      `断面矩形が描画範囲(0..2000)の外にある: x=${p.x1}..${p.x2}`);
  }

  // 描画範囲をレーンの外（world 5000..6000）へずらすと、断面矩形は1本も出ない。
  const outside = { ...base, line: { ...base.line, lo: 5000, hi: 6000 } };
  const outLines = stairPrimitivesForCut(c, outside, columns)
    .filter(p => p.type === 'line' && p.weight === 'thick');
  assert.equal(outLines.length, 0, '描画範囲の外の断面矩形は1本も出ないはず');
});

// ---- ささらはSTEELのみ（失敗系WOODで0本） ----
// 期待値更新（ユーザー実機フィードバック2026-08-23。switchbackCuts.jsの切断線再定義で
// 切断線が実際に往路/復路レーンの中を縦断するようになったため）: 「段部はササラの横に付く
// （横付け）なので側面視ではジグザグ本体を隠す」という旧仕様（WP-E3〜E5b）は撤回した——
// 切断線が踏面を文字通り縦断する以上、踏面自体をCUT（太線）として描き、切断面の向こう側に
// あるこのレーン自身のささらの輪郭(DETAIL)を重ねて描く（DWD立面図でも踏板は断面として
// 描かれている）。よって「ジグザグ(CUT)+ささら(DETAIL)=2本」になる。
test('【WP-E3】stairPrimitivesForCut: structure=STEELならレーン縦断（側面視）は踏面をCUTで描き、切断面の向こう側のささら(DETAIL polyline)を重ねる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 2, '踏面のCUT(1本)＋切断面の向こう側のささらDETAIL(1本)=2本のはず');
  const zigzag = prims.find(p => p.weight === 'thick');
  const stringer = prims.find(p => p.weight === 'thin');
  assert.ok(zigzag, '踏面はCUT(thick)のpolylineのはず');
  assert.equal(zigzag.type, 'polyline');
  assert.ok(stringer, 'ささらの見えがかりはDETAIL(thin)のはず');
  assert.equal(stringer.type, 'polyline');
});

// ---- 実機フィードバック第3弾B: DETAILのささら見えがかり（stringerPrimitives経由）はflight自身のFL(baseZ/baseZ+steps*riser)を超えて突き出さない ----
test('【実機フィードバック第3弾B】stairPrimitivesForCut: 側面視のささら見えがかり(DETAIL)はflightのFL範囲(baseZ〜baseZ+steps*riser)を超えて突き出さない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const outbound = c.flights[0];
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const stringer = prims.find(p => p.weight === 'thin');
  assert.ok(stringer, 'ささらの見えがかり(DETAIL)が見つからない');
  const yHi = outbound.baseZ === 0 ? 0 : -outbound.baseZ;
  const yLo = -(outbound.baseZ + outbound.steps * outbound.riserMm);
  const ys = stringer.points.map(p => p[1]);
  assert.ok(Math.max(...ys) <= yHi + 1e-6,
    `ささらの見えがかりはFL上端(y=${yHi})を超えて突き出さないはず（実際max=${Math.max(...ys)}）`);
  assert.ok(Math.min(...ys) >= yLo - 1e-6,
    `ささらの見えがかりはFL下端(y=${yLo})を下回らないはず（実際min=${Math.min(...ys)}）`);
});

// ---- ささら正面視（レーンを横切る切断）: 両側に12mm厚×せい300mmのCUT矩形 ----
test('【WP-E3】stairPrimitivesForCut: structure=STEELならレーンを横切る切断（正面視）は両側にささらのCUT矩形(太線)を追加する', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const cutLines = prims.filter(p => p.weight === 'thick');
  // 往路レーンの両側（acrossLo側・acrossHi側）にそれぞれ矩形(4辺)ぶんのCUT線があるはず。
  assert.equal(cutLines.length, 8, '両側×矩形4辺=8本のCUT線があるはず');
  for (const p of cutLines) {
    assert.equal(p.type, 'line');
    const w = Math.abs(p.x1 - p.x2);
    const h = Math.abs(p.y1 - p.y2);
    // 矩形の辺は幅=12mm(縦辺)か幅=0(横辺。幅は列範囲依存)のいずれか——せい(高さ)方向の辺は
    // 縦線(x1===x2)でSTEEL_STRINGER_DEPTH_MM=300ぶんの高さになるはず。
    if (p.x1 === p.x2) assert.ok(Math.abs(h - 300) < 1e-6, `せいは300mmのはず（実際:${h}）`);
    else assert.ok(w >= 0);
  }
});

// ---- 実機フィードバック第3弾E: 踊り場より下まで達するレーンの端面（縦の細破線） ----
test('【実機フィードバック第3弾E】stairPrimitivesForCut: 踊り場より下まで達する往路レーンはacrossLo/acrossHiに縦の細破線(ささらの端面)が出る', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const landingAbs = 1200; // n1=6・riser=200(=2400/12)の往路総上り＝踊り場高さ
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: landingAbs,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const dashedThin = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.x1 === p.x2);
  assert.equal(dashedThin.length, 2, '往路レーンのacrossLo/acrossHiに縦の細破線2本があるはず');
  const xs = [...new Set(dashedThin.map(p => p.x1))].sort((a, b) => a - b);
  assert.equal(xs.length, 2, '2本は異なるx位置(acrossLo/acrossHi)にあるはず');
  for (const p of dashedThin) {
    assert.ok(Math.abs(Math.min(p.y1, p.y2) - (-landingAbs)) < 1e-6, `上端はz=landingAbs(y=-${landingAbs})のはず`);
    assert.ok(Math.abs(Math.max(p.y1, p.y2) - 0) < 1e-6, '下端はz=0(y=0)のはず');
  }
});

test('【失敗系・実機フィードバック第3弾E】stairPrimitivesForCut: cut.baseFloorZ=0（踊り場より下が存在しない）なら端面の破線は出ない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const dashedThin = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.x1 === p.x2);
  assert.equal(dashedThin.length, 0,
    'flight.baseZ(0)がcut.baseFloorZ(0)未満でない（踊り場より下が無い）ため端面の破線は出ないはず');
});

test('【失敗系・実機フィードバック第3弾E】stairPrimitivesForCut: WOOD(木造)はささら自体が無いため端面の破線も出ない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // 既定=WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const dashedThin = prims.filter(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.x1 === p.x2);
  assert.equal(dashedThin.length, 0, 'WOODはささら自体が無いため端面の破線も出ないはず');
});

// ---- ささら正面視矩形もLANE_GAP(100mm)ぶん往路・復路間にあきができる（梯子と同じ横幅を使う） ----
test('【WP-E3】stairPrimitivesForCut: STEEL(鉄骨)のささら正面視矩形はLANE_GAP(100mm)ぶん往路・復路間にあきができる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  // 部屋全幅(x:0-2000。往路[0,1000]・復路[1000,2000])をカバーする単一列。
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const cutLines = prims.filter(p => p.weight === 'thick' && p.type === 'line');
  const xs = cutLines.flatMap(p => [p.x1, p.x2]);
  const outboundInnerXs = xs.filter(x => x > 900 && x <= 1000);
  const inboundInnerXs = xs.filter(x => x >= 1000 && x < 1100);
  assert.ok(outboundInnerXs.length > 0 && inboundInnerXs.length > 0,
    '往路・復路それぞれのレーン境界側(内側)のささら矩形があるはず');
  assert.ok(Math.max(...outboundInnerXs) <= 950 + 1e-6,
    `往路の内側ささらはレーン境界(1000)より50mm手前(950)までのはず（実際:${Math.max(...outboundInnerXs)}）`);
  assert.ok(Math.min(...inboundInnerXs) >= 1050 - 1e-6,
    `復路の内側ささらはレーン境界(1000)より50mm先(1050)からのはず（実際:${Math.min(...inboundInnerXs)}）`);
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

// ---- 失敗系: WOODは正面視（レーンを横切る切断）でもささらの断面矩形(CUT)を出さない ----
test('【失敗系・WP-E3】stairPrimitivesForCut: structure=WOOD(既定)はレーンを横切る切断でもささらの断面矩形(CUT)を出さない（梯子のみ）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // 既定=WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const cutLines = prims.filter(p => p.weight === 'thick');
  assert.equal(cutLines.length, 0, 'WOODはささら断面(CUT/太線)を出さないはず（DETAILの梯子のみ）');
  assert.ok(prims.every(p => p.weight === 'thin'), 'WOODのcrossing出力はDETAIL(梯子)のみのはず');
});

// ---- 失敗系: contribution=null ----
test('【失敗系・WP-E3】stairPrimitivesForCut: contribution=nullは例外を投げず空配列を返す', () => {
  const cut = {
    seqNo: '1', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  assert.deepEqual(stairPrimitivesForCut(null, cut, []), []);
});

// ==== QA実機フィードバック修正: 鉄骨ささら階段は平面同様、往路・復路間にLANE_GAP(100mm)の
// 空きを設ける（正面視の梯子の横幅のみ。ジグザグ・isLengthwiseCut判定は不変） ====
test('【QA修正・実機フィードバック】stairPrimitivesForCut: STEEL(鉄骨)は往路・復路間の梯子にLANE_GAP(100mm)の空きができる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  // 部屋全幅(x:0-2000。往路[0,1000]・復路[1000,2000])をカバーする単一列。
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const lines = prims.filter(p => p.type === 'line');
  const outboundRightXs = lines.map(p => Math.max(p.x1, p.x2)).filter(x => x <= 1000);
  const inboundLeftXs   = lines.map(p => Math.min(p.x1, p.x2)).filter(x => x >= 1000);
  assert.ok(outboundRightXs.length > 0 && inboundLeftXs.length > 0, '往路・復路それぞれの梯子があるはず');
  assert.ok(Math.max(...outboundRightXs) <= 950 + 1e-6,
    `往路の梯子はレーン境界(1000)より50mm手前(950)までのはず（実際:${Math.max(...outboundRightXs)}）`);
  assert.ok(Math.min(...inboundLeftXs) >= 1050 - 1e-6,
    `復路の梯子はレーン境界(1000)より50mm先(1050)からのはず（実際:${Math.min(...inboundLeftXs)}）`);
});

test('【失敗系・QA修正・実機フィードバック】stairPrimitivesForCut: WOOD(木造・既定)は往路・復路間の梯子に空きを作らない（レーン境界でぴったり接する）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.WOOD);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const lines = prims.filter(p => p.type === 'line');
  const outboundRightXs = lines.map(p => Math.max(p.x1, p.x2)).filter(x => x <= 1000);
  const inboundLeftXs   = lines.map(p => Math.min(p.x1, p.x2)).filter(x => x >= 1000);
  assert.ok(Math.max(...outboundRightXs) >= 1000 - 1e-6, '木造は往路の梯子がレーン境界(1000)まで届くはず(空き無し)');
  assert.ok(Math.min(...inboundLeftXs) <= 1000 + 1e-6, '木造は復路の梯子がレーン境界(1000)から始まるはず(空き無し)');
});

// ==== WP-A2: 1層1ユニット化（unit・landing.frame.edges・landingFramePrimitives・
// clipStringerToAnchors）====

test('【WP-A2】stairContribution: unitフィールドが板厚・桁成・アンカー高さを持つ', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.ok(c.unit);
  assert.equal(c.unit.structure, StructuralMaterialType.STEEL);
  assert.equal(c.unit.stringerThicknessMm, 12);
  assert.equal(c.unit.stringerDepthMm, 300);
  assert.equal(c.unit.landingFrameDepthMm, 300);
  // anchorZs = [0, floorHeight] + 踊り場z（riser=floorHeight/totalSteps=2400/12=200、
  // landingZ=n1*riser=6*200=1200）。昇順・重複なし。
  assert.deepEqual(c.unit.anchorZs, [0, 1200, 2400]);
});

test('【WP-A2】stairContribution: landing.frame.edgesは4辺（front/back各1・side2）で構成され、' +
  'frontはレーン(outbound/inbound)に接する側(y=1500)・backは反対側(y=0)になる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const edges = c.landings[0].frame.edges;
  assert.equal(edges.length, 4);
  const front = edges.find(e => e.kind === 'front');
  const back = edges.find(e => e.kind === 'back');
  const sides = edges.filter(e => e.kind === 'side');
  assert.equal(sides.length, 2);
  assert.equal(front.axisWorld, 1500, 'frontはoutbound/inboundのrunLo(=踊り場との境界y=1500)のはず');
  assert.equal(back.axisWorld, 0, 'backは反対側(y=0)のはず');
  assert.equal(front.isVertical, false);
  assert.equal(back.isVertical, false);
  assert.deepEqual(sides.map(e => e.axisWorld).sort((a, b) => a - b), [0, 2000]);
  for (const s of sides) assert.equal(s.isVertical, true);
});

test('【失敗系・WP-A2】clipStringerToAnchors: 実フィクスチャの往路ジグザグは既にFL(baseZ・baseZ+総上り)ちょうどで' +
  '始終するため出力は入力と一致する（挙動不変の裏付け）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const outbound = c.flights[0];
  // outbound: baseZ=0, riserMm=200, steps=6 → y=0スタート、y=-1200で終わる想定。
  const points = [[0, 0]];
  let y = 0;
  for (let i = 0; i < outbound.steps; i++) { y -= outbound.riserMm; points.push([points.at(-1)[0], y]); points.push([points.at(-1)[0] + 500, y]); }
  const clipped = clipStringerToAnchors(points, c.unit, outbound);
  assert.deepEqual(clipped, points);
});

test('【WP-A2】clipStringerToAnchors: baseZ・baseZ+steps×riserMmを超える点はクランプされ、端点はちょうど揃う', () => {
  const flight = { baseZ: 100, riserMm: 200, steps: 3 }; // z範囲=[100,700] → y範囲=[-700,-100]
  const overshoot = [[0, 50], [10, -50], [20, -900], [30, -50]]; // y=50(z=-50,範囲外)・y=-900(z=900,範囲外)を含む
  const clipped = clipStringerToAnchors(overshoot, {}, flight);
  assert.equal(clipped[0][1], -100, '始点はyHi=-baseZ=-100ちょうどへ強制されるはず');
  assert.equal(clipped.at(-1)[1], -700, '終点はyLo=-(baseZ+steps*riserMm)=-700ちょうどへ強制されるはず');
  assert.ok(clipped.every(([, y]) => y <= -100 + 1e-9 && y >= -700 - 1e-9), '全ての点がy範囲[-700,-100]内へクランプされるはず');
  // xはクランプの影響を受けない。
  assert.deepEqual(clipped.map(p => p[0]), overshoot.map(p => p[0]));
});

test('【失敗系・WP-A2】clipStringerToAnchors: 点が1つ以下・flightがnullでも例外を投げず入力をそのまま返す', () => {
  assert.deepEqual(clipStringerToAnchors([], {}, { baseZ: 0, riserMm: 200, steps: 3 }), []);
  assert.deepEqual(clipStringerToAnchors([[0, 0]], {}, { baseZ: 0, riserMm: 200, steps: 3 }), [[0, 0]]);
  assert.deepEqual(clipStringerToAnchors(null, {}, { baseZ: 0, riserMm: 200, steps: 3 }), []);
  assert.deepEqual(clipStringerToAnchors([[0, 0], [1, -1]], {}, null), [[0, 0], [1, -1]]);
});

test('【WP-A2・ユーザー実機フィードバック2026-08-23】landingFramePrimitives: 側面視(踊り場を縦断する切断)はside桁が' +
  'DETAIL(上端=床断面線+巾木高さ・下端=上端-300・片端縦線のみ)・front/back桁がCUT断面矩形になる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const landing = c.landings[0];
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];
  const prims = landingFramePrimitives(landing, cut, columns, c.unit);

  const detail = prims.filter(p => p.weight === 'thin');
  const cutLines = prims.filter(p => p.weight === 'thick');
  assert.equal(cutLines.length, 8, 'front/back桁2本×矩形4辺=8本のCUTのはず');
  // side桁: 上端(1)+下端(1)+片端縦線(1、front側は続き扱いで出さない)=3本×2辺=6本。
  assert.equal(detail.length, 6, 'side桁2本×(上端1+下端1+片端縦線1)=6本のDETAILのはず');
  // 巾木未設定のfixtureはDEFAULT_BASEBOARD_HEIGHT('h=60')へフォールバックするはず（ASSUMED既定値。報告参照）。
  assert.equal(c.unit.baseboardHeightMm, 60, '巾木未設定時の既定値は60mmのはず（ASSUMED）');
  const expectedTop = landing.z + c.unit.baseboardHeightMm; // = 1200+60 = 1260
  const expectedBot = expectedTop - c.unit.landingFrameDepthMm; // = 1260-300 = 960
  const horizontalLines = detail.filter(p => p.type === 'line' && p.y1 === p.y2);
  assert.ok(horizontalLines.some(p => Math.abs(p.y1 - (-expectedTop)) < 1e-6), '上端(踊り場床断面線+巾木高さ)の水平線があるはず');
  assert.ok(horizontalLines.some(p => Math.abs(p.y1 - (-expectedBot)) < 1e-6), '下端(上端-300)の水平線があるはず');
  const verticalLines = detail.filter(p => p.type === 'line' && p.x1 === p.x2);
  assert.equal(verticalLines.length, 2, 'side桁2辺×片端縦線1本=2本のはず（front側は続き扱いで出さない）');
});

test('【失敗系・WP-A2・ユーザー実機フィードバック2026-08-23】landingFramePrimitives: 巾木が"h=<数値>"で明示解釈できる' +
  'Roomでは既定値ではなくその値を使う', () => {
  const graph = makeGraph();
  const { stair, room } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  room.finish.setField('baseboardHeight', 'h=45');
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  assert.equal(c.unit.baseboardHeightMm, 45, '明示解釈できる巾木高さがあればそれを使うはず');
});

test('【WP-A2】landingFramePrimitives: 正面視(踊り場を横切る切断)はside桁がCUT断面矩形・' +
  'front/back桁がDETAIL帯輪郭になる（側面視と役割が入れ替わる）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const landing = c.landings[0];
  const cut = {
    seqNo: 'landingFront', line: { isVertical: false, axisValue: 700, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = landingFramePrimitives(landing, cut, columns, c.unit);

  const detail = prims.filter(p => p.weight === 'thin');
  const cutLines = prims.filter(p => p.weight === 'thick');
  assert.equal(detail.length, 4, 'front/back桁2本×(上端+下端)=4本のDETAILのはず');
  assert.equal(cutLines.length, 8, 'side桁2本×矩形4辺=8本のCUTのはず');
});

test('【失敗系・WP-A2】landingFramePrimitives: WOOD(木造)は桁枠なし・RC(鉄筋コンクリート造)はあり' +
  '（ユーザー裁定2026-08-23: 踊り場桁枠の生成対象はSTEEL限定からSTEEL・RCへ拡張。' +
  'ささら本体はSTEEL限定のまま変更しないためWOODと同じ扱い＝ここではlandingFramePrimitives単体の' +
  '生成可否のみ検証する）', () => {
  const graph = makeGraph();
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];

  const { stair: woodStair } = makeSwitchbackFixture(graph, StructuralMaterialType.WOOD);
  const wood = stairContribution(woodStair, graph, FLOOR_HEIGHT);
  assert.deepEqual(landingFramePrimitives(wood.landings[0], cut, columns, wood.unit), [],
    'WOODは桁枠なしのはず');

  const graphRC = makeGraph('p2');
  const { stair: rcStair } = makeSwitchbackFixture(graphRC, StructuralMaterialType.RC);
  const rc = stairContribution(rcStair, graphRC, FLOOR_HEIGHT);
  const rcPrims = landingFramePrimitives(rc.landings[0], cut, columns, rc.unit);
  assert.ok(rcPrims.length > 0, 'RCは桁枠(コンクリートの踊り場受け桁)ありのはず');
});

test('【失敗系・WP-A2】landingFramePrimitives: landing.frameが無い・cutが踊り場と無関係でも例外を投げず空配列', () => {
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 99999, lo: 0, hi: 10 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  assert.deepEqual(landingFramePrimitives({ runLo: 0, runHi: 1500, acrossLo: 0, acrossHi: 2000, z: 1200 }, cut, [], { structure: StructuralMaterialType.STEEL }), []);
  assert.deepEqual(landingFramePrimitives(null, cut, [], { structure: StructuralMaterialType.STEEL }), []);
});

test('【WP-A2】stairPrimitivesForCut: STEELは踊り場を縦断する切断で桁枠プリミティブが加わる（従来の床CUT線1本+桁枠14本=15本）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 1 + 14, '床CUT線1本＋side桁DETAIL6本＋front/back桁CUT8本のはず');
});

test('【失敗系・WP-A2】stairPrimitivesForCut: WOOD(木造)は同じ切断でも桁枠プリミティブが加わらない（従来どおり床CUT線1本のみ）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // 既定=WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  assert.equal(prims.length, 1, '木造は従来どおり床CUT線1本のみのはず');
});

test('【WP-A2】stairPrimitivesForCut: RC(鉄筋コンクリート造)も踊り場桁枠プリミティブが加わるが、' +
  'ささら本体(STEEL限定)は加わらない（ユーザー裁定2026-08-23）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.RC);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 0, hi: 1500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  // 床CUT線1本＋side桁DETAIL6本＋front/back桁CUT8本=15本（STEELと同数。桁枠自体はSTEEL/RC同型）。
  assert.equal(prims.length, 1 + 14, 'RCもSTEELと同じ15本（踊り場桁枠あり）のはず');
  // ささら本体（stringerPrimitivesのDETAIL輪郭）はSTEEL限定のまま——RCの往路ジグザグは
  // WOOD同様、段部そのもの(SILHOUETTEのpolyline)が描かれるはず（isSteel限定分岐に入らない）。
  const zigzagCut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const zigzagColumns = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  const zigzagPrims = stairPrimitivesForCut(c, zigzagCut, zigzagColumns);
  assert.ok(zigzagPrims.some(p => p.type === 'polyline' && p.weight === 'medium'),
    'RCは段部のジグザグ本体(SILHOUETTE)がそのまま描かれる（ささら横付け隠しはSTEEL限定）のはず');
});

// ---- 実機フィードバック第3弾D: stairWallGapZones（壁側の空き検出） ----
function makeFlightD(overrides) {
  return { isVertical: true, runLo: 0, runHi: 3000, travelSign: 1, acrossLo: 0, acrossHi: 1000,
    baseZ: 0, riserMm: 200, steps: 6, lengthMm: 1200, ...overrides };
}

test('【実機フィードバック第3弾D】stairWallGapZones: 復路レーンの外側(壁側)に室の空きがあれば壁までの区間を返す', () => {
  const outbound = makeFlightD({ acrossLo: 0, acrossHi: 1000, baseZ: 0 });
  const inbound = makeFlightD({ acrossLo: 1000, acrossHi: 2000, baseZ: 1200 });
  const contribution = { flights: [outbound, inbound], landings: [], structure: null };
  const cut = { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 2400 }, dirSign: 1 };
  const zones = stairWallGapZones(contribution, cut);
  assert.equal(zones.length, 1, '復路側(x=2000〜2400)だけに壁側の空きがあるはず');
  assert.ok(Math.abs(zones[0].loX - 2000) < 1e-6 && Math.abs(zones[0].hiX - 2400) < 1e-6,
    `zoneはx=2000〜2400のはず（実際:${JSON.stringify(zones[0])}）`);
});

test('【実機フィードバック第3弾D】stairWallGapZones: 両側に壁側の空きがあれば2区間返す', () => {
  const outbound = makeFlightD({ acrossLo: 0, acrossHi: 1000, baseZ: 0 });
  const inbound = makeFlightD({ acrossLo: 1000, acrossHi: 2000, baseZ: 1200 });
  const contribution = { flights: [outbound, inbound], landings: [], structure: null };
  const cut = { line: { isVertical: false, axisValue: 1500, lo: -400, hi: 2400 }, dirSign: 1 };
  const zones = stairWallGapZones(contribution, cut);
  assert.equal(zones.length, 2, '往路側(x=-400〜0)・復路側(x=2000〜2400)の2区間があるはず');
});

test('【失敗系・実機フィードバック第3弾D】stairWallGapZones: 壁厚のズレ相当(150mm未満)の差は空きとみなさない', () => {
  const outbound = makeFlightD({ acrossLo: 0, acrossHi: 1000, baseZ: 0 });
  const inbound = makeFlightD({ acrossLo: 1000, acrossHi: 2000, baseZ: 1200 });
  const contribution = { flights: [outbound, inbound], landings: [], structure: null };
  // 壁面は半壁厚(57.5mm)ぶんだけ内側——WALL_GAP_MIN_MM(150)未満のため空き扱いしない。
  const cut = { line: { isVertical: false, axisValue: 1500, lo: 57.5, hi: 1942.5 }, dirSign: 1 };
  const zones = stairWallGapZones(contribution, cut);
  assert.equal(zones.length, 0, '半壁厚程度のズレは空きとみなさないはず');
});

test('【失敗系・実機フィードバック第3弾D】stairWallGapZones: WOOD(isSteel=false)でもレーン同士の内側境界は壁側と誤判定しない（回帰）', () => {
  // isSteel=false（structure未指定）はladderAcrossRangeを適用しないため、往路flightの
  // acrossHi(=1000。復路との内側境界)をそのまま使う——これを誤って壁側(cut.line.hi)と
  // 比較すると、内側境界〜壁までの区間を誤検出してしまう不具合があった（実装時に発見・修正）。
  const outbound = makeFlightD({ acrossLo: 0, acrossHi: 1000, baseZ: 0 });
  const inbound = makeFlightD({ acrossLo: 1000, acrossHi: 2000, baseZ: 1200 });
  const contribution = { flights: [outbound, inbound], landings: [], structure: null }; // WOOD相当
  const cut = { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 2000 }, dirSign: 1 }; // 壁=室の真の外縁とちょうど一致
  const zones = stairWallGapZones(contribution, cut);
  assert.equal(zones.length, 0, '内側境界(x=1000)を壁側と誤判定して空きを作らないはず');
});

test('【失敗系・実機フィードバック第3弾D】stairWallGapZones: contribution=nullは例外を投げず空配列', () => {
  const cut = { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 2000 }, dirSign: 1 };
  assert.deepEqual(stairWallGapZones(null, cut), []);
});
