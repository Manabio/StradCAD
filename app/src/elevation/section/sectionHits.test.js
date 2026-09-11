// sectionHits.js（展開図一般化Phase 2）の単体テスト。
// フィクスチャ方針は sectionProbe.test.js を踏襲する（実core.js（Plane/PlanGraph）+
// finish/wallGeneration.jsで壁を生成し、手書きのSectionCutリテラルで探査する）。
//
// このテストの目的は「visibleBandsOf(probeColumnHits(cut,mid,ctx).hits, cut, opts) が
// probeColumn と同じ値を返す」ことを**リテラルな期待値**（sectionProbe.test.jsの確認済み挙動）に
// 対して確認すること。probeColumn自体が今はこの合成の薄いラッパなので、単に両者を突き合わせる
// だけだと同じコードを2回呼ぶだけのトートロジーになる——ここでは各ケースでリテラルな期待値
// （kind/z0/z1/distMm等）を直接アサートする。
//
// QA是正（2026-09）: probeColumnHitsは`{hits, layerStack, unexploredBelowZ}`を返す
// （以前はhits配列へ`layerStack`等を追加プロパティとして載せていたが、`[...hits]`のような
// 配列コピーで失われる実害があったため）。visibleBandsOfはopts.layerStackを必須にした。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext, probeColumn } from './sectionProbe.js';
import { probeColumnHits, visibleBandsOf } from './sectionHits.js';

const CH = 2400; // DEFAULT_ROOM_CEILING_HEIGHT（core/constants.js）明示指定なしの既定値

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

function frontCut(graph, overrides = {}) {
  return {
    seqNo: '1',
    line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1,
    dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH },
    baseFloorZ: 0,
    ...overrides,
  };
}

function farWallOf(graph) {
  return graph.walls.find(w => !w.isVertical && w.axisCL.effectiveValue === 3000);
}

// ================================================================
// (1) visibleBandsOf(probeColumnHits(...).hits, ...) が probeColumn の既存期待値と一致（代表3ケース）
// ================================================================

test('【代表ケース1・見えがかり壁】visibleBandsOf: 矩形室で正面の壁だけなら[wall]（全高）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].kind, 'wall');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, CH);
  assert.equal(bands[0].distMm, 3000, '正面の壁までの距離は3000mmのはず');
  // probeColumn（同じ合成を内部で行う）と完全一致すること。
  assert.deepEqual(bands, probeColumn(cut, 2000, probeCtx));
});

test('【代表ケース2・切断壁】visibleBandsOf: 室内の間仕切り壁を横切る位置では[cut]（全高）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(yMid, 100, false, x0, 0, x1, 0, { isRoomWall: false, isExteriorWall: false });

  const cut = {
    seqNo: '2',
    line: { isVertical: true, axisValue: 2000, lo: 0, hi: 3000 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);

  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 1500, probeCtx);
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].kind, 'cut');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, CH);
  assert.deepEqual(bands, probeColumn(cut, 1500, probeCtx));
});

test('【代表ケース3・開口の通し】visibleBandsOf: 見えがかり壁に重なる開口はopeningPassThrough:trueで分離される', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  graph.addOpening(wall.axisCL, 1, false, x0, 2000, 900, OpeningCategory.WINDOW, 'casement',
    { sillHeight: 1900, height: 500 });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.equal(bands.length, 2);
  assert.equal(bands[0].kind, 'wall'); assert.equal(bands[0].z1, 1900);
  assert.equal(bands[0].openingPassThrough, undefined);
  assert.equal(bands[1].kind, 'wall'); assert.equal(bands[1].z0, 1900); assert.equal(bands[1].z1, CH);
  assert.equal(bands[1].openingPassThrough, true);
  assert.deepEqual(bands, probeColumn(cut, 2000, probeCtx));
});

// ================================================================
// (2) ヒット列は深度昇順・第2ヒット以降も保持される（腰壁の向こうに別の壁がある fixture）
// ================================================================

test('【ヒット列】probeColumnHits: 腰壁(900)の手前壁と全高の奥壁がある列では、2件のヒットが深度昇順(近い→遠い)で保持される', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK'); // 奥壁(y=3000)は全高・距離3000
  // 手前に腰壁(topHeight=900)指定の間仕切り壁(y=1500・距離1500)を追加。
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const nearWall = graph.addWall(yMid, 100, false, x0, 0, x1, 0, { isRoomWall: false, isExteriorWall: false });
  graph.setKneeDropWall(edgeKey(nearWall.axisCL.id, nearWall.clStart.id, nearWall.clEnd.id), { knee: { topHeight: 900 } });

  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);

  assert.ok(hits.length >= 2, `手前・奥の2件は少なくとも保持されるはず（実際:${hits.length}件）`);
  // 深度昇順（手前=近い=distMm小さい方が先）。
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].distMm <= hits[i].distMm, '深度昇順のはず');
  const near = hits.find(h => h.wall === nearWall);
  const far = hits.find(h => h.wall === farWallOf(graph));
  assert.ok(near, '手前の腰壁ヒットがあるはず');
  assert.ok(far, '奥の全高壁ヒットも（手前に隠れず）保持されるはず');
  assert.equal(near.distMm, 1500); assert.equal(near.z1, 900, '腰壁は900までしか実在しない');
  assert.equal(far.distMm, 3000); assert.equal(far.z1, CH, '奥壁は全高');
  assert.ok(hits.indexOf(near) < hits.indexOf(far), '手前(近い)が先に来るはず');

  // 選択後（visibleBandsOf）は900より下=手前の腰壁、900より上=奥壁が見える、という従来どおりの結果。
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const lower = bands.find(b => b.z0 === 0);
  const upper = bands.find(b => b.z1 === CH);
  assert.equal(lower.distMm, 1500, '900までは手前の腰壁(距離1500)が選ばれるはず');
  assert.equal(upper.distMm, 3000, '900より上は奥壁(距離3000)が選ばれるはず（手前の腰壁は900までしか無いため）');
});

// ================================================================
// (2') QA指摘G: 同深度(distMm=0)のcut/cutAlongはcutが先（ヒット列レベルで固定）
// ================================================================

// 室内をX=2000で縦断する壁（isVertical:true。cut.lineと同じ向き・同じaxisValue＝coincident）を
// Y:[500,2500]の部分スパンで置く（sectionProbe.test.jsのaddCoincidentWallと同型）。
function addCoincidentWall(graph) {
  const y500  = graph.addCenterLine(CenterLineType.HORIZONTAL, 500,  { labeled: false, discipline: Discipline.ARCH });
  const y2500 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2500, { labeled: false, discipline: Discipline.ARCH });
  const x2000 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(x2000, 50, true, y500, 0, y2500, 0, { isRoomWall: false, isExteriorWall: false });
}

function verticalCoincidentCut(graph) {
  return {
    seqNo: '2',
    line: { isVertical: true, axisValue: 2000, lo: 0, hi: 3000 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
}

test('【QA指摘G・ヒット列】probeColumnHits: 同一列にcutとcutAlongの候補が両方あれば、ヒット列ではcutが先(index比較)', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addCoincidentWall(graph); // cutAlong候補(X=2000, Y:[500,2500]。distMm=0)
  // cut候補: X=2000を横切る水平壁(isVertical:false)をY=1500に追加（isCutWallの直交条件を満たす）。
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x4000 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const y1500 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(y1500, 100, false, x0, 0, x4000, 0, { isRoomWall: false, isExteriorWall: false });

  const cut = verticalCoincidentCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits } = probeColumnHits(cut, 1500, probeCtx);

  const cutIdx = hits.findIndex(h => h.kind === 'cut');
  const cutAlongIdx = hits.findIndex(h => h.kind === 'cutAlong');
  assert.ok(cutIdx >= 0, '前提: cut候補があるはず');
  assert.ok(cutAlongIdx >= 0, '前提: cutAlong候補があるはず');
  assert.ok(cutIdx < cutAlongIdx, '同深度(distMm=0)ではcutがcutAlongより先(index比較)のはず');
});

// ================================================================
// (3) 失敗経路
// ================================================================

test('【失敗系】probeColumnHits: cut.layers=[]でも例外を投げずhits=[]を返す', () => {
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  assert.deepEqual(hits, []);
  assert.deepEqual(visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ }), [{ kind: 'open', z0: 0, z1: CH }]);
});

test('【失敗系】probeColumnHits: worldMidがNaNでも例外を投げずbands・hitsを返す（zRangeが隙間なく覆われる）', () => {
  // 注意: NaNは`v < lo`/`v > hi`のようなガード比較を常にfalseにすり抜けるため、既存probeColumn
  // でも「境界チェックなしで候補に採用される」のが元々の挙動（本テストはそれを変えない・
  // 例外を投げず・visibleBandsOfの出力がzRangeを隙間なく覆うことだけを確認する）。
  // assert.deepEqualを空配列などの不一致な期待値に対して使うと、壁がgraphへの循環参照を
  // 持つため差分表示が巨大化し「Array buffer allocation failed」で固まる
  // （spaceModel.jsのSpaceCellコメントと同根の既知の罠。QA指摘）——ここでは.lengthと
  // 個々のプリミティブ値だけを見る。
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, NaN, probeCtx);
  assert.ok(Array.isArray(hits), '例外を投げず配列を返すはず');

  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.ok(bands.length >= 1, '例外を投げずbandsを返すはず');
  assert.equal(bands[0].z0, 0, 'zRange下端から始まるはず');
  assert.equal(bands[bands.length - 1].z1, CH, 'zRange上端まで覆うはず');
  for (let i = 1; i < bands.length; i++) {
    assert.ok(Math.abs(bands[i - 1].z1 - bands[i].z0) < 1e-6, '隙間なく連続するはず');
  }
});

// ================================================================
// (3') QA指摘C: hitsをコピーしても同じbands／layerStack欠落はTypeError
// ================================================================

test('【QA指摘C・失敗系是正】visibleBandsOf: hits配列をスプレッドコピーしても（[...hits]）同じbandsを返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  graph.addOpening(wall.axisCL, 1, false, x0, 2000, 900, OpeningCategory.WINDOW, 'casement',
    { sillHeight: 1900, height: 500 });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const original = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const copied = visibleBandsOf([...hits], cut, { layerStack, unexploredBelowZ });
  assert.deepEqual(copied, original,
    'hits配列をスプレッドコピーしても、layerStackをoptsで明示していれば結果は同じはず');
  // 前提: このfixtureはslab帯を含まない単純ケースなので念のためopen区間が無いことも確認
  // （壊れていればopenへ化ける）。
  assert.ok(!original.some(b => b.kind === 'open'), '前提: このfixtureにopen帯は無いはず');
});

test('【QA指摘C・失敗系】visibleBandsOf: opts.layerStackが無ければTypeErrorを投げる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits } = probeColumnHits(cut, 2000, probeCtx);

  assert.throws(() => visibleBandsOf(hits, cut), TypeError,
    'opts省略（layerStack無し）はTypeErrorのはず（黙ってslabがopenへ化けるのを防ぐ）');
  assert.throws(() => visibleBandsOf(hits, cut, {}), TypeError,
    'opts.layerStackが無ければTypeErrorのはず');
});

// ================================================================
// (4) 変異テスト用の土台: 「深度最小だけ残す」が壊れたら赤くなること
// ================================================================
// 変異手順（報告に貼る）: visibleBandsOfのwallMatchソートを
// `.sort((a, b) => a.distMm - b.distMm || ...)` → `.sort((a, b) => b.distMm - a.distMm || ...)`
// （最遠を選ぶ）へ変えると、下のテストが赤くなることを確認する。
test('【変異テスト用の土台】visibleBandsOf: 複数の見えがかり壁候補がある列では最も近い壁(距離最小)が選ばれる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(yMid, 0, false, x0, 0, x1, 0, { isRoomWall: false, isExteriorWall: false });

  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  assert.equal(hits.length, 2, '前提: 手前・奥の2件のヒットがあるはず');
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].distMm, 1500, '手前の壁(距離1500)が奥の壁(距離3000)より優先されるはず');
});
