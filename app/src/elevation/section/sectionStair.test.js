// sectionStair.js（WP-E3: stairContribution / stairPrimitivesForCut）の単体テスト。
// §9「WP-E3のみ階段fixture経由可」に従い、elevationStairSequence.test.jsと同じ折返し階段
// フィクスチャ（makeSwitchbackFixture）を再利用する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { stairContribution, stairPrimitivesForCut, clipStringerToAnchors, landingFramePrimitives, stairWallGapZones, stairCutFloorProfile, stairFaceHits, stairOccluderRects, stairFaceOccluderRects, stairDrawRange } from './sectionStair.js';
import { localXOf, cutDrawRange } from './sectionTypes.js';

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

// ---- ユーザー実機指摘2026-08「6」C「踊り場断面線を太線に」 ----
// 正面視（踊り場を横切る切断＝踊り場前縁の見返り）でも踊り場の床は切断されている。旧実装は
// レーン縦断のときしか床線を描かず、踊り場桁枠front/back辺の帯の上端（DETAIL細線）が
// 踊り場床の高さに見えているだけだった。x範囲は走行方向ではなくacross（壁から壁までの全幅）。
test('【実機指摘】stairPrimitivesForCut: 正面視でも踊り場の床断面線をCUTで全幅に描く', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const landing = c.landings[0];
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 700, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const fullWidth = landing.acrossHi - landing.acrossLo;
  const thickHoriz = prims.filter(p => p.type === 'line' && p.weight === 'thick'
    && Math.abs(p.y1 - p.y2) < 1e-6);
  const floorLine = thickHoriz.find(p => Math.abs(p.y1 - (-landing.z)) < 1e-6
    && Math.abs(Math.abs(p.x2 - p.x1) - fullWidth) < 1e-6);
  assert.ok(floorLine, '踊り場床の断面線が z=' + landing.z + ' に全幅(' + fullWidth
    + ')のCUT(太線)で出るはず（実際の太線水平: '
    + thickHoriz.map(p => `z${-p.y1}:${p.x1}..${p.x2}`).join(' / ') + '）');
});

// ---- ユーザー実機指摘2026-08「6」C「ささら断面上端高さは、踊り場面+巾木」 ----
// 側面視の裁定「ささらの上端は踏面先端で巾木同寸」と同じ基準を、正面視の断面矩形にも揃える。
test('【実機指摘】stairPrimitivesForCut: ささら正面視の断面矩形の上端は段鼻+巾木高さ', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const f = c.flights[0];
  const axisValue = (f.runLo + f.runHi) / 2;
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue, lo: f.acrossLo, hi: f.acrossHi },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: f.acrossHi - f.acrossLo, worldLo: f.acrossLo, worldHi: f.acrossHi, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const worldStart = f.travelSign > 0 ? f.runLo : f.runHi;
  const worldEnd   = f.travelSign > 0 ? f.runHi : f.runLo;
  const noseZ = f.baseZ + ((axisValue - worldStart) / (worldEnd - worldStart)) * f.steps * f.riserMm;
  const baseboard = c.unit.baseboardHeightMm;
  assert.ok(baseboard > 0, '前提: 巾木高さが0でない');

  const tops = prims.filter(p => p.type === 'line' && p.weight === 'thick' && Math.abs(p.y1 - p.y2) < 1e-6)
    .map(p => -p.y1);
  assert.ok(tops.some(z => Math.abs(z - (noseZ + baseboard)) < 1e-6),
    `ささら断面の上端が段鼻+巾木(${noseZ + baseboard})に無い（実際:${[...new Set(tops)].join(',')}）`);
  assert.ok(!tops.some(z => Math.abs(z - noseZ) < 1e-6),
    '巾木ぶんを足さない段鼻ちょうどの上端は残らないはず');
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

// QA指摘2026-09: clampToDrawRangeは交わりが空のとき「クランプせず元のrangeを返す」＝面の外へ
// 描く、という未文書のフォールバックだった。空なら非描画（null）へ倒す。
test('【失敗系・QA指摘2026-09】stairPrimitivesForCut: 列が面の描画範囲と交わらなければジグザグを描かない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  // 前提: 面の中の列ならジグザグが1本出る（描画範囲はローカル0..3000）。
  const inside = [{ x0: 0, x1: 3000, worldLo: 1500, worldHi: 4500, bands: [] }];
  assert.equal(stairPrimitivesForCut(c, cut, inside).filter(p => p.type === 'polyline').length, 1);

  // 列が丸ごと描画範囲の外（ローカル5000..6000）＝この面には何も描かない。
  const outside = [{ x0: 5000, x1: 6000, worldLo: 6500, worldHi: 7500, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, outside);
  assert.deepEqual(prims.filter(p => p.type === 'polyline'), [],
    '交わりが空のとき元のrangeへ戻すと、面の外にジグザグが描かれてしまう');
});

// ==== 展開図一般化Phase 6b-2「一体設計」（.claude/elevation-redesign.md§5.12）====
// 規則: stairDrawRange(cut, outerBound) = cutDrawRange(cut) を、outerBound（はり出しの外端の
// **面ローカルx絶対値**。増分ではない。QA是正2026-09-12その6）がそれより外のときだけ
// Math.min/maxで広げたもの。階段自身の幾何（踏面CUT・段鼻・ささら）はこの範囲まで生成時に
// クランプし、出口で同じ範囲へクリップする。

// ---- QA是正2026-09-12その6: 壁のない端部(probeExtendLoMm)＋はり出しでも基準が1つ ----
// cutDrawRange自身がすでにprobeExtendLoMm(壁のない端部の体裁延長)ぶん広がっている構成で、
// さらに外側まで続くはり出し(outerBound)を渡したとき、境界は**はり出しの外端の絶対world位置を
// localXOfで直接変換した値**に一致するはず——増分契約（cutDrawRange.lo - ext.lo）へ戻すと、
// この「cutDrawRange.loが既に0でない」構成だけ二重計上（またはbaseLoとのズレ）でズレる。
test('【QA是正2026-09-12その6】stairDrawRange: 壁のない端部(probeExtendLoMm=150)＋はり出しでも境界ははり出しの外端(localXOf)に一致する', () => {
  const cut = {
    dirSign: 1,
    line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500, probeExtendLoMm: 150 },
  };
  // 前提: cutDrawRange.lo は壁のない端部の延長(150)ぶん既に0より外（-150）。
  const draw = cutDrawRange(cut);
  assert.equal(draw.lo, -150, '前提: probeExtendLoMm=150ぶんcutDrawRange.loは-150のはず');

  // はり出しの外端（world=1300。壁のない端部の延長(world1350)よりさらに50mm外）を
  // 面ローカルx絶対値へ変換したものをouterBoundとして渡す。
  const outerWorldEdge = 1300;
  const outerLo = localXOf(cut, outerWorldEdge);
  assert.equal(outerLo, -200, '前提: localXOf(cut,1300)は-200のはず(world1300-origin1500)');

  const range = stairDrawRange(cut, { lo: outerLo });
  assert.equal(range.lo, localXOf(cut, outerWorldEdge),
    `stairDrawRange.loははり出しの外端(world${outerWorldEdge}→local${outerLo})に一致するはず` +
    `（実際${range.lo}）`);
  // 増分契約（cutDrawRange.lo - outerLo）へ戻すと、この構成では -150-(-200)=50 になり、
  // 符号まで反転した全く異なる値になる——cutDrawRange.loが0でない（壁のない端部）ことが
  // ズレを生む根本原因。
  const wrongIncrementContract = draw.lo - outerLo;
  assert.notEqual(wrongIncrementContract, range.lo,
    '失敗系: 増分契約で計算した値は絶対値契約の結果と一致しない（この構成でズレが生じる証拠）');
});

// ---- D2-2: 最終段の蹴込（鼻の出） ----
test('【D2-2】stairPrimitivesForCut: outerBoundを渡すと最終段の蹴込(鼻の出)がstairDrawRangeの外に残る', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  // 列自体も面の外へ広がっている想定（実データのlayerRunWindows同様、描画範囲より広い）——
  // 列がcutDrawRangeちょうどだと、outerBoundを広げても列側のMath.min/maxで頭打ちになり
  // 効果が出ない（fullColumnsXRangeはcolumnsとstairDrawRangeの交わりを取るため）。
  const columns = [{ x0: -100, x1: 3000, worldLo: 1400, worldHi: 4500, bands: [] }];
  const zigzagOf = prims => prims.find(p => p.type === 'polyline' && p.weight === 'thick');

  // 末尾3点: [nose_4(踊り場の1段手前), foot_5(最終段の蹴込の足元), nose_5(最終段=2FL到達点)]。
  const clamped = zigzagOf(stairPrimitivesForCut(c, cut, columns));
  const tail = clamped.points.slice(-3);
  assert.deepEqual(tail.map(p => p[0]), [600, 0, 0],
    '前提: outerBound省略では最終段の鼻の足元(foot_5)がcutDrawRangeの境界(local0)で止まり、' +
    '蹴上が垂直(x不変)・踏面は蹴込ぶん(20)短い600のまま');

  const nosing = stair.nosing; // 既定20mm
  // cutDrawRange.lo(=0)より外（はり出しの外端）は面ローカルx絶対値=-nosingそのもの。
  const extended = zigzagOf(stairPrimitivesForCut(c, cut, columns, { outerBound: { lo: -nosing } }));
  const extTail = extended.points.slice(-3);
  assert.deepEqual(extTail.map(p => p[0]), [600, -nosing, 0],
    `outerBound={lo:${-nosing}}で最終段の蹴込の足元(foot_5)がstairDrawRangeの外(local=${-nosing})まで残るはず`);
  assert.equal(tail[0][0] - extTail[1][0], 600 + nosing, '踏面長は蹴込ぶん伸びてtreadMm+nosingMm(620)になるはず');
  assert.equal(tail[1][0], tail[2][0], '前提: outerBound省略では最終段の蹴上は垂直(foot_5・nose_5が同x)のまま');
  assert.notEqual(extTail[1][0], extTail[2][0],
    'outerBoundありでは最終段の蹴上が斜め(foot_5・nose_5のxが異なる)になるはず');
});

// ---- 失敗系: outerBound省略は従来（cutDrawRangeぴったり）と同じ ----
test('【失敗系】stairPrimitivesForCut: outerBound未指定は従来どおりcutDrawRangeで止まる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: -100, x1: 3000, worldLo: 1400, worldHi: 4500, bands: [] }];
  const zigzagOf = prims => prims.find(p => p.type === 'polyline' && p.weight === 'thick');
  const withoutOpts = zigzagOf(stairPrimitivesForCut(c, cut, columns));
  const withEmptyOpts = zigzagOf(stairPrimitivesForCut(c, cut, columns, {}));
  // cutDrawRangeちょうど(lo=0,hi=3000)を絶対値で明示しても、Math.min/maxなので広がらない
  // （QA是正2026-09-12その6の絶対値契約での「無効化」の書き方。旧{lo:0,hi:0}は増分契約の書き方
  // だったため同じ意味にならない）。
  const withNoOpOuterBound = zigzagOf(stairPrimitivesForCut(c, cut, columns, { outerBound: { lo: 0, hi: 3000 } }));
  assert.deepEqual(withoutOpts.points, withEmptyOpts.points,
    'opts省略とopts={}は同じ結果(既定outerBound=undefined)のはず');
  assert.deepEqual(withoutOpts.points, withNoOpOuterBound.points,
    'outerBound:{lo:0,hi:3000}(=cutDrawRangeそのもの)を明示しても省略時と同じはず');
  const xs = withoutOpts.points.map(p => p[0]);
  assert.ok(Math.min(...xs) >= 0 - 1e-9 && Math.max(...xs) <= 3000 + 1e-9,
    'outerBound未指定の全点はcutDrawRange[0,3000]の内側のはず');
});

// ---- P3: 終端クリップ（stairPrimitivesForCutの出口で1箇所）／QAその1: 旧コメント
// 「cutDrawRangeを超える幾何を生成している箇所が無いため素通り」は事実誤りだった ----
// 壁centerline(グリッドCL)を基準に組まれるstringerEndCapPrimitives/innerStringerSilhouetteは
// 壁の内側面（cutDrawRangeの基準）より半壁厚ぶん外側に出ることがある（実機と同じ構成。
// elevationStairSequence.test.jsの「往路ささらの端面」テスト参照）。
test('【終端】stairPrimitivesForCut: outerBound省略でもcutDrawRangeを超える幾何があれば境界へ寄るか落ちる', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const landingAbs = 1200;
  // cut.lineを往路flightの幅(acrossLo:0,acrossHi:1000)より内側(50..1950)に取り、壁centerlineと
  // 壁内側面の半壁厚ズレを模す——acrossLo(world0)はcutDrawRangeの外(local-50)になる。
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 50, hi: 1950 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: landingAbs,
  };
  const columns = [{ x0: 0, x1: 1900, worldLo: 50, worldHi: 1950, bands: [] }];
  const prims = stairPrimitivesForCut(c, cut, columns);
  const range = { lo: 0, hi: 1900 }; // cutDrawRange(cut)（probeExtend無し）
  for (const p of prims) {
    if (p.type === 'line') {
      assert.ok(Math.min(p.x1, p.x2) >= range.lo - 1e-6 && Math.max(p.x1, p.x2) <= range.hi + 1e-6,
        `line x=${p.x1}..${p.x2}がstairDrawRange[${range.lo},${range.hi}]の外`);
    } else if (p.type === 'polyline') {
      for (const [x] of p.points) {
        assert.ok(x >= range.lo - 1e-6 && x <= range.hi + 1e-6,
          `polyline点 x=${x}がstairDrawRange[${range.lo},${range.hi}]の外`);
      }
    }
  }
  // QA是正（2026-09-12その2）: 往路flightのacrossLo(world0→local-50)はcutDrawRangeの外だが、
  // ささらの端面（stringerEndCapPrimitives）は**削除ではなく境界(local0)へクランプ**されて
  // 残る——壁centerline位置の情報を消さず、描画範囲の端に寄るだけ。
  const dashedAtOuter = prims.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && p.dash === 'dashed' && Math.abs(p.x1 - range.lo) < 1e-6);
  assert.equal(dashedAtOuter.length, 1,
    'stairDrawRangeの外(acrossLo)にあったささらの端面は境界(local0)へクランプされて1本残るはず');
  // 内側(acrossHi。LANE_GAP/2ぶん詰めたworld950→local(950-50)=900)は範囲内なので元のまま残る。
  const dashedAtInner = prims.some(p =>
    p.type === 'line' && p.x1 === p.x2 && p.dash === 'dashed' && Math.abs(p.x1 - 900) < 1e-6);
  assert.ok(dashedAtInner, 'stairDrawRangeの内側(acrossHi)のささらの端面は元の位置のまま残るはず');
});

// ---- P3是正（2026-09-13）: solidRectsOfの矩形を持つcolumnsを渡すと実体矩形の厳密内部で切られ、
// 両断片が別部材と誤認されず残る ----
// 旧`opts.slabBand`+`isLower`（x範囲重複＋meanZ比較で「上下ペア」を推測する特例）は
// 展開図一般化Phase 6b-2 設計(d)の一般ルールへ置き換わった（P3で削除）。新ルールは
// `columns`自身が持つ実体（`slab`∪`cut`∪`cutAlong`。`solidRectsOf`）だけを見て矩形の
// **厳密内部**を切るため、旧実装のような「相手がいなければクリップしない」という
// パートナー依存は無い——secondaryFlights経由のDETAIL polyline（clipPolylineAboveOccluderに
// よる占有形状の切り出しで「面の外へ出た閉じた輪郭」になる。elevationStairSequence.test.jsの
// 同名フィクスチャと同じ組み方）が、実在するslab帯を通れば必ず切られ、切られた両側の断片が
// 別々の部材（例えば元からあった他のpolyline）と混同されずに残ることを固定する。
// QA是正（2026-09-13第2ラウンド）: この判定はプリミティブ単位・無状態（他のpolylineとの
// ペア判定を持たない）なので、x終端クリップとの前後関係は出力に影響しない（実測確認済み）。
// 本テストの主張はあくまで「実体矩形の厳密内部で切られ、両断片が残る」ことであり、
// x終端クリップとの順序ではない。
test('【P3是正】stairPrimitivesForCut: solidRectsOfの矩形を持つcolumnsを渡すと実体矩形の厳密内部で切られ、両断片が別部材と誤認されず残る', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const c2 = { ...c, secondaryFlights: [c.flights[1]] };
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const emptyColumns = [{ x0: -200, x1: 3000, worldLo: 1300, worldHi: 4500, bands: [] }];
  const thinOf = prims => prims.filter(p => p.type === 'polyline' && p.weight === 'thin');

  // band無し（実体が無い＝素通し）での出力から、面の外へ出ていた部材がx=3000(面端)から
  // 面の内側へ伸びる2点のDETAIL polyline（閉じた輪郭の一部）として残ることを確認し、その
  // 両端のzを「まだ分割されていない1本」の証拠として使う。
  const baseline = stairPrimitivesForCut(c2, cut, emptyColumns);
  const unsplit = thinOf(baseline).find(p => p.points.length === 2 && Math.abs(p.points[0][0] - 3000) < 1e-6);
  assert.ok(unsplit, '前提: secondaryFlights経由の2点DETAIL polyline(x=3000起点)が見つかるはず');
  const [zA, zB] = unsplit.points.map(([, y]) => -y);
  assert.ok(Math.abs(zA - zB) > 500, '前提: 両端のzは十分離れている(slab帯を挟める)はず');

  // この部材のz範囲の中間（30%〜60%）に実在するslab帯を置く——columns自体が実体を持つ
  // （旧slabBandのような外部指定ではない）。x範囲は部材の全x域(-200..3000)を覆う。
  const zMin = Math.min(zA, zB), zSpan = Math.abs(zA - zB);
  const zLo = zMin + zSpan * 0.3, zHi = zMin + zSpan * 0.6;
  const slabColumns = [{ x0: -200, x1: 3000, worldLo: 1300, worldHi: 4500,
    bands: [{ kind: 'slab', z0: zLo, z1: zHi }] }];

  const sharePolyline = prims => thinOf(prims).some(p =>
    p.points.some(([, y]) => Math.abs(-y - zA) < 1e-6) &&
    p.points.some(([, y]) => Math.abs(-y - zB) < 1e-6));
  const hasNear = (prims, z) => thinOf(prims).some(p => p.points.some(([, y]) => Math.abs(-y - z) < 1e-6));

  const withSlabColumns = stairPrimitivesForCut(c2, cut, slabColumns);
  assert.ok(!sharePolyline(withSlabColumns),
    'columns自体に実在するslab帯を渡すと、パートナー(isLower相手)の有無に関わらずこの部材は帯の厳密内部で切られ、両端(zA・zB)は同じ1本に残らないはず');
  assert.ok(hasNear(withSlabColumns, zA) && hasNear(withSlabColumns, zB),
    '切られた両側の断片（zA側・zB側）はそれぞれ別のpolylineとして残り、消えたり別部材と混同されたりしないはず');
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
  // 突き出しの許容は**踊り場側の端だけ**（ユーザー明示指示2026-08その14「ささら上同士、
  // ささら下同士トリム」: 踊り場桁枠と取り合うため、ささらはその端で踊り場側へ食い込む。
  // 上限は桁枠のせい=300）。FL側は従来どおり厳格——本テストが塞いだ法線オフセットぶんの
  // 突き出しはFL側で起きるため、この形なら再発を見逃さない。
  const landingY = -(outbound.baseZ + outbound.steps * outbound.riserMm);
  const MITRE_TOL = 300 + 1e-6, STRICT = 1e-6;
  const tolHi = Math.abs(yHi - landingY) < 1e-6 ? MITRE_TOL : STRICT;
  const tolLo = Math.abs(yLo - landingY) < 1e-6 ? MITRE_TOL : STRICT;
  assert.ok(Math.max(...ys) <= yHi + tolHi,
    `ささらの見えがかりはFL上端(y=${yHi})を超えて突き出さないはず（実際max=${Math.max(...ys)}）`);
  assert.ok(Math.min(...ys) >= yLo - tolLo,
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
  // ユーザー明示指示2026-08その15「踊り場と階段取り合い部にささら断面は描画不要」:
  // front辺（踊り場が直進部と取り合う辺）の断面矩形は描かない——折返し階段の内側の踊り場ささらは
  // 往路・復路の間（100）だけにあり、直進部のささらが来るこの位置には踊り場側のささらが無い。
  assert.equal(cutLines.length, 4, 'back桁1本×矩形4辺=4本のCUTのはず（front桁は取り合い部なので描かない）');
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
  // 期待値更新（ユーザー実機指摘2026-08「6」A「上下にささらの見えがかり（横線2本）」）:
  // 桁枠の帯の基準は**踊り場面+巾木**（sideTop）で統一した——踊り場床の断面線(landing.z)は
  // landingCutPrimitivesがCUTで別に描くので、帯の上下2本とは重複しない。
  const sideTop = landing.z + c.unit.baseboardHeightMm;
  const sideBot = sideTop - c.unit.landingFrameDepthMm;
  assert.equal(detail.length, 4, 'front/back桁2本×(上端+下端)=4本のDETAILのはず');
  assert.equal(cutLines.length, 8, 'side桁2本×矩形4辺=8本のCUTのはず');
  for (const p of detail) {
    const z = -p.y1;
    assert.ok(Math.abs(z - sideTop) < 1e-6 || Math.abs(z - sideBot) < 1e-6,
      `DETAILは帯の上端(${sideTop})か下端(${sideBot})のはず（実際:${z}）`);
  }
  for (const p of cutLines) {
    assert.ok(-p.y1 <= sideTop + 1e-6 && -p.y1 >= sideBot - 1e-6,
      `side桁の断面矩形も帯と同じz範囲(${sideBot}..${sideTop})のはず（実際:${-p.y1}）`);
  }
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
  assert.equal(prims.length, 1 + 10, '床CUT線1本＋side桁DETAIL6本＋back桁CUT4本のはず（front桁は取り合い部なので描かない。2026-08その15）');
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
  // 床CUT線1本＋side桁DETAIL6本＋back桁CUT4本=11本（STEELと同数。桁枠自体はSTEEL/RC同型）。
  assert.equal(prims.length, 1 + 10, 'RCもSTEELと同じ11本（踊り場桁枠あり。front桁の断面は描かない）のはず');
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


// ---- 断面線（下側の輪郭）: stairCutFloorProfile（ユーザー明示指示2026-09「展開図では、
// 断面線の外は描画しない」）。切っている（縦断している）寄与だけが断面線に現れる ----
test('stairCutFloorProfile: 縦断するflightだけを拾う（隣レーン＝切っていない側は含まない）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  // 往路レーン(across 0..1000)の中を縦断する切断。踊り場(run 0..1500)とはrunが重ならない。
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const profile = stairCutFloorProfile(c, cut, null);
  assert.ok(profile && profile.length > 2, '往路の輪郭が返るはず');
  const xs = profile.map(([x]) => x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'x昇順のはず');
  const zs = profile.map(([, z]) => z);
  const landingZ = c.landings[0].z;
  assert.equal(Math.min(...zs), 0, '下端は往路の登り口FL(baseZ=0)のはず');
  assert.equal(Math.max(...zs), landingZ,
    `上端は踊り場(${landingZ})のはず——復路(baseZ=踊り場)まで拾うと階高まで伸びてしまう`);
  // 両端は必ずアンカー（登り口FL・踊り場）で閉じる（段鼻の出のぶん1リザー高い点で終わらない）。
  assert.ok(profile[0][1] === 0 || profile[profile.length - 1][1] === 0);
  assert.ok(profile[0][1] === landingZ || profile[profile.length - 1][1] === landingZ);
});

test('stairCutFloorProfile: secondaryFlights（見えがかりの隣レーン）は断面線に含めない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const base = stairCutFloorProfile(c, cut, null);
  const withSecondary = stairCutFloorProfile(
    { ...c, secondaryFlights: [c.flights[1]] }, cut, null);
  assert.deepEqual(withSecondary, base, 'secondaryFlightsを足しても輪郭は変わらないはず');
});

test('【失敗系】stairCutFloorProfile: contribution=null・寄与なしはnull（例外を投げない）', () => {
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  assert.equal(stairCutFloorProfile(null, cut, null), null);
  assert.equal(stairCutFloorProfile({ flights: [], landings: [] }, cut, null), null);
  assert.equal(stairCutFloorProfile({}, cut, null), null);
});

// ================================================================
// stairFaceHits（展開図一般化Phase 6b-1。設計`.claude/elevation-redesign.md`§5.3(b)）
// ================================================================
// stairOccluderRectsと同じ判定・同じ形状（正面視=crossesFlightの段板占有・踊り場桁枠）、
// 内側ささらの見えがかりはinnerStringerGeometry（innerStringerSilhouetteが描画へ変換する
// 直前の幾何と共通の単一情報源）を使う。往路/復路の識別(side)と深度
// (depthNearMm/depthFarMm/atCutPlane)を添える。section/sectionHits.jsのprobeColumnHitsが
// これをkind:'stairFace'のSurfaceHitへ変換する（本Phaseではvisibleの選択には参加しない。
// sectionHits.test.js側で確認）。
//
// QA是正2026-09（要件A）: 内側ささらの条件は本番`innerStringerSilhouette`と同じ`crossesFlight`
// （正面視）でなければならない——旧実装は`isLengthwiseCut`（側面視）を使っており、
// `crossesFlight`とは定義上排他（`cut.line.isVertical !== flight.isVertical`か
// `===`かの違い）のため、本番が線を描く切断（正面視）ではヒットが出ず、本番が描かない切断
// （側面視）でヒットが出るという逆転が起きていた。

test('【Phase6b-1・要件A是正】stairFaceHits: 正面視(crossesFlight)の切断では、往路・復路の段板ヒット＋復路(baseZ=踊り場)の内側ささらヒット＋踊り場桁枠ヒットが出る（STEEL・LANE_GAPで往復間に空き）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  const faces = stairFaceHits(c, cut);

  const outboundTread = faces.find(f => f.side === 'outbound' && f.part === 'tread');
  const inboundTread = faces.find(f => f.side === 'inbound' && f.part === 'tread');
  assert.ok(outboundTread, '往路の段板ヒットがあるはず');
  assert.ok(inboundTread, '復路の段板ヒットがあるはず');
  assert.equal(outboundTread.z0, 0); assert.equal(outboundTread.z1, 1200, '往路はbaseZ(0)〜steps*riser(1200)のはず');
  assert.equal(inboundTread.z0, 1200); assert.equal(inboundTread.z1, 2400, '復路はbaseZ(踊り場1200)〜1200+1200のはず');
  for (const f of [outboundTread, inboundTread]) {
    assert.equal(f.depthNearMm, 0, '正面視は切断平面へ接触する実体として深度near=0のはず（§5.7の測定距離の意味を持たない縮退）');
    assert.equal(f.depthFarMm, 3000, 'depthFar=flightの走り長さ(lengthMm)のはず');
    assert.equal(f.atCutPlane, true);
  }
  assert.ok(outboundTread.xHi <= inboundTread.xLo, 'STEELはLANE_GAPぶん往路(xHi)と復路(xLo)の間に空きがあるはず');
  assert.equal(outboundTread.xHi, 950); assert.equal(inboundTread.xLo, 1050, 'LANE_GAP=100の半分(50)ずつ詰めた境界のはず');

  // 要件A是正の核心: この切断はcrossesFlight=trueの正面視なので、baseZ>=baseFloorZ（端面規則の
  // 対象外）である復路(inbound)にだけ内側ささらのヒットが出る（本番stairPrimitivesForCutが
  // innerStringerSilhouetteを描くのと同じ切断・同じレーン）。往路(outbound)はbaseZ(0)<
  // baseFloorZ(1200)のためstringerEndCapPrimitives側の担当でここには出ない。
  const stringer = faces.find(f => f.part === 'stringer');
  assert.ok(stringer, '正面視のこの切断で復路の内側ささらヒットが出るはず');
  assert.equal(stringer.side, 'inbound');
  assert.equal(stringer.xLo, stringer.xHi, '縦線1本なので幅ゼロのはず');
  assert.equal(stringer.xLo, 1050, '内側(acrossLo側)をLANE_GAP/2ぶん詰めた位置のはず');
  assert.equal(stringer.z0, 1200); assert.equal(stringer.z1, 2400, '復路の全高(baseZ〜baseZ+steps*riser)のはず');
  assert.equal(stringer.depthNearMm, 0, '正面視のstringerも段板と同じくdepthNear=0のはず');
  assert.equal(stringer.depthFarMm, 3000);
  assert.ok(!faces.some(f => f.part === 'stringer' && f.side === 'outbound'), '往路には内側ささらヒットは出ないはず');

  const frame = faces.find(f => f.part === 'landingFrame');
  assert.ok(frame, '踊り場桁枠のヒットがあるはず');
  assert.equal(frame.z0, 900); assert.equal(frame.z1, 1200, '桁枠はlanding.z(1200)からlandingFrameDepthMm(300)下がったz900..1200のはず');
  assert.equal(frame.depthNearMm, 0); assert.equal(frame.depthFarMm, 0); assert.equal(frame.atCutPlane, true);
});

test('【Phase6b-1】stairFaceHits: WOOD(木造)でも正面視の段板ヒットは出る（LANE_GAPは無く境界で接する。ささらは無いのでstringerは出ない）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // 既定WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  const faces = stairFaceHits(c, cut);
  const outbound = faces.find(f => f.side === 'outbound' && f.part === 'tread');
  const inbound = faces.find(f => f.side === 'inbound' && f.part === 'tread');
  assert.equal(outbound.xHi, 1000); assert.equal(inbound.xLo, 1000, 'WOODはLANE_GAPが無いのでレーン境界でぴったり接するはず');
  assert.ok(!faces.some(f => f.part === 'stringer'), 'WOODはささら自体が無いためstringerヒットは出ないはず');
});

test('【失敗系・Phase6b-1・要件A是正】stairFaceHits: 側面視（レーンを縦断する切断）ではstairFaceは一切出ない（段板もstringerも本番はcrossesFlight=正面視でしか描かないため）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const faces = stairFaceHits(c, cut);
  assert.ok(!faces.some(f => f.part === 'tread'), '側面視ではcrossesFlightがfalseなので段板ヒットは出ないはず');
  assert.ok(!faces.some(f => f.part === 'stringer'), '側面視ではinnerStringerGeometryもcrossesFlightで弾かれるためstringerヒットは出ないはず');
  // 踊り場桁枠だけはcut向きに関わらず無条件で出る（stairOccluderRectsと同じ既存挙動）。
  assert.ok(faces.some(f => f.part === 'landingFrame'), '桁枠ヒットは切断の向きに関わらず出るはず');
});

test('【失敗系・Phase6b-1】stairFaceHits: WOOD(木造)の側面視でも桁枠ヒットだけは出る（structure非依存の既存挙動）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // 既定WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const faces = stairFaceHits(c, cut);
  assert.ok(!faces.some(f => f.part === 'stringer'));
  assert.ok(!faces.some(f => f.part === 'tread'));
  assert.ok(faces.some(f => f.part === 'landingFrame'), '桁枠ヒットはstructureに関わらず出るはず（stairOccluderRectsと同じ既存挙動）');
});

test('【失敗系・Phase6b-1】stairFaceHits: contribution=null・cut.lineが無ければ例外を投げず空配列', () => {
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  assert.deepEqual(stairFaceHits(null, cut), []);
  assert.deepEqual(stairFaceHits({ flights: [], landings: [] }, cut), []);
  assert.deepEqual(stairFaceHits({ flights: [{ acrossLo: 0, acrossHi: 1 }], landings: [] }, {}), []);
});

test('【失敗系・Phase6b-1】stairFaceHits: 段板も内側ささらも対象外の切断（正面視でも側面視でもない）は段板・ささらとも出ない', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  // isVertical=falseだが幅方向の範囲(lo/hi)が階段のacross(0..2000)と重ならない位置＝正面視でも
  // レーン縦断でもない（実務上は起こりにくい人工的な構成だが、対象外分岐の確認として使う）。
  const cut = {
    seqNo: 'x', line: { isVertical: false, axisValue: 9000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const faces = stairFaceHits(c, cut);
  assert.ok(!faces.some(f => f.part === 'tread'), 'axisValueが走行範囲(1500..4500)の外なので段板ヒットは出ないはず');
  assert.ok(!faces.some(f => f.part === 'stringer'));
});

// ================================================================
// 突き合わせテスト（QA是正2026-09・要件B。S6単一情報源）:
// stairFaceHitsが生成する形状は、本番の描画関数`innerStringerSilhouette`と参照実装
// `stairOccluderRects`が生成する形状と食い違ってはいけない——両者が別々の判定を持つ
// （＝S6違反）とドリフトが起きうるため、突き合わせを固定する。
// ================================================================

// stairFaceHitsのtread/landingFrameパーツをstairOccluderRectsと同じ{xLo,xHi,zLo,zHi}形へ正規化
// （比較しやすいようside/part/depth*は落とし、z0/z1→zLo/zHiへ改名）。
function toOccluderRectShape(faces) {
  return faces
    .filter(f => f.part === 'tread' || f.part === 'landingFrame')
    .map(f => ({ xLo: f.xLo, xHi: f.xHi, zLo: f.z0, zHi: f.z1 }))
    .sort((a, b) => a.xLo - b.xLo || a.zLo - b.zLo);
}
function sortRects(rects) {
  return [...rects].sort((a, b) => a.xLo - b.xLo || a.zLo - b.zLo);
}

test('【突き合わせ・Phase6b-1要件B】stairFaceHits(tread+landingFrame)の矩形集合はstairOccluderRectsの矩形集合と一致する（正面視・STEEL）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  assert.deepEqual(toOccluderRectShape(stairFaceHits(c, cut)), sortRects(stairOccluderRects(c, cut)));
});

test('【突き合わせ・Phase6b-1要件B】stairFaceHits(tread+landingFrame)の矩形集合はstairOccluderRectsの矩形集合と一致する（側面視・WOOD。両方とも桁枠1件のみ）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const occluder = sortRects(stairOccluderRects(c, cut));
  assert.equal(occluder.length, 1, '前提: 側面視では踊り場桁枠1件だけのはず（段板はcrossesFlightで対象外）');
  assert.deepEqual(toOccluderRectShape(stairFaceHits(c, cut)), occluder);
});

// 展開図一般化Phase 6b-2 段A（遮蔽チャネルの正式化）: stairFaceOccluderRects自体
// （stairFaceHitsからstringerを除いて組み立てる本番の遮蔽矩形）がstairOccluderRectsと
// 一致することを直接固定する（上の2件はstairFaceHitsの生の形状の突き合わせ、これは
// elevationStairSequence.jsが実際に呼ぶ関数の突き合わせ）。
test('【Phase6b-2段A】stairFaceOccluderRectsはstairOccluderRectsと同じ矩形集合を返す（正面視・STEEL）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  assert.deepEqual(sortRects(stairFaceOccluderRects(c, cut)), sortRects(stairOccluderRects(c, cut)));
});

// 6b-1からの持ち越し（QA是正2026-09・D）: 側面視・WOOD（踊り場桁枠1件のみ）でも本番の消費者
// （elevationStairSequence.jsが呼ぶstairFaceOccluderRects）とstairOccluderRectsが一致することを
// 固定する——正面視・STEELの1構成だけでは、桁枠オンリーのcut（側面視）や非STEEL（段板そのものが
// stairFaceHitsに出ない構成）での突き合わせが未検証のままだった。
test('【Phase6b-2段A】stairFaceOccluderRectsはstairOccluderRectsと同じ矩形集合を返す（側面視・WOOD。踊り場桁枠1件のみ）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph); // WOOD
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '2', line: { isVertical: true, axisValue: 500, lo: 1500, hi: 4500 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const expected = sortRects(stairOccluderRects(c, cut));
  assert.equal(expected.length, 1, '前提: 側面視では踊り場桁枠1件だけのはず');
  assert.deepEqual(sortRects(stairFaceOccluderRects(c, cut)), expected);
});

test('【Phase6b-2段A】stairFaceOccluderRectsはcontributionが無い（cut.stairCut===null。階段帯以外）とき空配列を返す', () => {
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1200,
  };
  assert.deepEqual(stairFaceOccluderRects(null, cut), []);
});

// stairPrimitivesForCutが実際に描く「内側ささらの見えがかり」線のx座標（ローカル）を取り出す
// 薄いヘルパー。DETAIL(thin)・垂直（x1===x2）・neverDowngradeで太さは変わらないので線種では
// 区別できないため、baseFloorZ=0（stringerEndCapPrimitivesの担当条件`baseZ<baseFloorZ`が
// どちらのflightにも成立しない構成）にして、対象になりうる垂直DETAIL細線をinnerStringerSilhouette
// 由来だけに絞る（テスト側の前提はassert.equalで固定し、崩れたら気づける形にする）。
function innerStringerXs(contribution, cut, columns) {
  const prims = stairPrimitivesForCut(contribution, cut, columns);
  return prims
    .filter(p => p.type === 'line' && p.weight === 'thin' && Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.y1 - p.y2) > 1e-6)
    .map(p => p.x1)
    .sort((a, b) => a - b);
}

test('【突き合わせ・Phase6b-1要件B】part:stringerのヒットが出る切断＝stairPrimitivesForCutが内側ささらの縦線を描く切断（x位置も一致。正面視・STEEL・baseFloorZ=0でstringerEndCapと非曖昧）', () => {
  const graph = makeGraph();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const c = stairContribution(stair, graph, FLOOR_HEIGHT);
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2000 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const columns = [{ x0: 0, x1: 2000, worldLo: 0, worldHi: 2000, bands: [] }];
  // 前提: baseFloorZ=0ではどちらのflightもbaseZ(0・1200)<baseFloorZ(0)を満たさないため
  // stringerEndCapPrimitivesは1本も出ない（垂直DETAIL細線の出処をinnerStringerSilhouetteに限定できる）。
  assert.ok(!stairPrimitivesForCut(c, cut, columns).some(p =>
    p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && Math.abs(p.x1 - p.x2) < 1e-6),
  '前提: この構成ではstringerEndCapPrimitives(端面の破線)は出ないはず');

  const renderedXs = innerStringerXs(c, cut, columns);
  const hitXs = stairFaceHits(c, cut).filter(f => f.part === 'stringer').map(f => f.xLo).sort((a, b) => a - b);
  assert.deepEqual(hitXs, renderedXs, 'stairFaceHitsのstringerヒットのx集合は、本番が描く内側ささら線のx集合と一致するはず');
  assert.deepEqual(hitXs, [950, 1050], '往路(outbound)は内側=acrossHi側(1000-50)・復路(inbound)は内側=acrossLo側(1000+50)のはず');
});

// 13.stq「6」面C相当（switchbackCuts seqNo '1'・往路0〜1392.5・復路の内側ささら1492.5・
// baseFloorZ=1500=n1*riser）のfixture。makeSwitchbackFixtureを介さず、実測値と同じ縮尺の
// contributionリテラルを直接構成する（S6: 判定はinnerStringerGeometry・crossesFlight・
// ladderAcrossRangeという単一情報源から導くため、fixtureの作り方に依らず同じ結果になることの
// 確認でもある）。
function stairSixCFixtureContribution() {
  return {
    structure: StructuralMaterialType.STEEL,
    flights: [
      { isVertical: true, runLo: 1500, runHi: 4500, acrossLo: 0, acrossHi: 1442.5,
        baseZ: 0, riserMm: 250, steps: 6, lengthMm: 3000 }, // outbound: rise=1500
      { isVertical: true, runLo: 1500, runHi: 4500, acrossLo: 1442.5, acrossHi: 2985,
        baseZ: 1500, riserMm: 250, steps: 6, lengthMm: 3000 }, // inbound: rise=1500
    ],
    landings: [{ runLo: 0, runHi: 1500, acrossLo: 0, acrossHi: 2985, z: 1500 }],
    unit: { landingFrameDepthMm: 300 },
  };
}

test('【固定値・Phase6b-1要件B・13.stq「6」面C相当】stairFaceHits: 復路の内側ささらヒットがx=1492.5（面ローカル）に出る（往路の段板はx0〜1392.5）', () => {
  const c = stairSixCFixtureContribution();
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2985 },
    dirSign: 1, viewSign: 1, layers: [], zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1500,
  };
  const faces = stairFaceHits(c, cut);

  const outboundTread = faces.find(f => f.side === 'outbound' && f.part === 'tread');
  assert.ok(outboundTread);
  assert.equal(outboundTread.xLo, 0); assert.equal(outboundTread.xHi, 1392.5,
    '往路の段板はLANE_GAP/2(50)ぶん内側へ詰めた1392.5までのはず（ユーザー裁定の実測値と同じ縮尺）');

  const stringer = faces.find(f => f.part === 'stringer');
  assert.ok(stringer, '復路(baseZ=baseFloorZ=1500)の内側ささらヒットが出るはず');
  assert.equal(stringer.side, 'inbound');
  assert.equal(stringer.xLo, 1492.5, 'ユーザー裁定「復路ささら x=1492.5」と同じ値のはず');
  assert.equal(stringer.z0, 1500); assert.equal(stringer.z1, 3000);
  assert.ok(!faces.some(f => f.part === 'stringer' && f.side === 'outbound'),
    '往路(baseZ=0<baseFloorZ=1500)はstringerEndCapPrimitivesの担当域なのでここには出ない');

  // 本番の描画（stairPrimitivesForCut）と突き合わせる。
  const columns = [{ x0: 0, x1: 2985, worldLo: 0, worldHi: 2985, bands: [] }];
  const renderedXs = innerStringerXsExcludingEndCap(c, cut, columns);
  assert.deepEqual(renderedXs, [1492.5]);
});

// baseFloorZ=1500（stringerEndCapPrimitivesが往路側だけ発火しうる構成）でも内側ささらの
// x集合だけを取り出すヘルパー——端面の破線は`dash:'dashed'`が付く（emitLineがbaseFloorZ以下を
// 自動降格させるため）のに対し、innerStringerSilhouetteはneverDowngrade:trueで`dash`なしの
// まま太さthinを保つ、という線属性の違いで区別する（S6: 本番のemitLine降格規則をそのまま使う）。
function innerStringerXsExcludingEndCap(contribution, cut, columns) {
  const prims = stairPrimitivesForCut(contribution, cut, columns);
  return prims
    .filter(p => p.type === 'line' && p.weight === 'thin' && !p.dash
      && Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.y1 - p.y2) > 1e-6)
    .map(p => p.x1)
    .sort((a, b) => a - b);
}
