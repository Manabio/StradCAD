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
  // Phase3: hitsには選択対象のwallFace候補2件に加え、選択対象外のslabFace候補（この層自身の
  // floorZ/ceilZ。visibleBandsOfが除外する）も積まれるため、ここでは選択に効く候補だけを数える。
  const wallLikeHits = hits.filter(h => h.kind === 'wallFace' || h.kind === 'cut' || h.kind === 'cutAlong');
  assert.equal(wallLikeHits.length, 2, '前提: 手前・奥の2件のヒットがあるはず');
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].distMm, 1500, '手前の壁(距離1500)が奥の壁(距離3000)より優先されるはず');
});

// ================================================================
// (5) Phase 3: 水平面ヒット（floorFace/ceilFace/slabFace。knee-drop-test.stq相当の構成）
// ================================================================
//
// フィクスチャは knee-drop-test.stq（部屋A 4000×4000・南に部屋B（天井高2400）・共有壁に腰壁800）を
// 単体テスト用に縮約したもの。切断線(cut.line)は**壁自身のmaterialRange.lo**（=室内側の仕上げ面。
// production同様、sectionCutPlane.jsが壁のすぐ室内側へ置く規約に倣う）に置く——
// generateRoomWallsFromOutlineの既定壁厚（DEFAULT_WALL_BASE+DEFAULT_WALL_FINISH*2）では
// 中心線から57.5mmになり、実機13.stq相当の値（QA指摘②で確認済みの実測値）と一致する。
// 腰壁自身のwallFaceヒットと、その先(部屋B)のfloorFace/ceilFaceヒットが**同じ距離(57.5mm)**
// になる——腰壁の軸位置と部屋A/Bの境界CLが同一直線上にあるため。この「同深度」がkindRank
// （QA指摘②）の並び替えを実際に問うケースになる。

function makeKneeWallFixture() {
  const graph = makeGraph();
  const roomA = makeRectRoom(graph, 0, 0, 4000, 4000, 'A');
  const roomB = makeRectRoom(graph, 0, 4000, 4000, 8000, 'B');
  roomB.setOverride('ceilingHeight', '2400');
  // 部屋A自身の南壁（materialRangeがAの室内側=hi===4000）に腰壁(topHeight800)を指定する。
  const nearWall = graph.walls.find(w =>
    !w.isVertical && w.axisCL.effectiveValue === 4000 && w.materialRange.hi === 4000);
  graph.setKneeDropWall(
    edgeKey(nearWall.axisCL.id, nearWall.clStart.id, nearWall.clEnd.id), { knee: { topHeight: 800 } });
  return { graph, roomA, roomB, nearWall };
}

// axisValue=nearWall.materialRange.lo（壁の室内側仕上げ面）——production（sectionCutPlane.js）の
// 「壁の中心線から室内側へ、壁仕上げ面まで下がる」規則と同じ置き方にする。
function kneeFaceCut(graph, nearWall) {
  return {
    seqNo: 'kneeFace',
    line: { isVertical: false, axisValue: nearWall.materialRange.lo, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
}

test('【Phase3・knee-drop-test相当】probeColumnHits: 部屋Aの腰壁面の列では、腰壁のwallFaceヒット(z 0..800)→部屋BのfloorFace/ceilFace→Bの奥の壁wallFaceが深度昇順で並ぶ', () => {
  const { graph, roomB, nearWall } = makeKneeWallFixture();
  const cut = kneeFaceCut(graph, nearWall);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits } = probeColumnHits(cut, 2000, probeCtx);

  const near = hits.find(h => h.wall === nearWall);
  assert.ok(near, '腰壁自身のヒットがあるはず');
  assert.equal(near.kind, 'wallFace');
  assert.equal(near.z0, 0); assert.equal(near.z1, 800, '腰壁の実在範囲はz 0..800のはず');
  assert.equal(near.distMm, 57.5, '既定壁厚（DEFAULT_WALL_BASE+FINISH*2）の半厚。実機13.stqと同じ値');

  const roomBFloor = hits.find(h => h.kind === 'floorFace' && h.room === roomB);
  const roomBCeil = hits.find(h => h.kind === 'ceilFace' && h.room === roomB);
  assert.ok(roomBFloor, '部屋BのfloorFaceヒットがあるはず');
  assert.ok(roomBCeil, '部屋BのceilFaceヒットがあるはず');
  assert.equal(roomBFloor.z0, 0); assert.equal(roomBFloor.z1, 0, '部屋Bの床はz=0相当のはず');
  assert.equal(roomBCeil.z0, 2400); assert.equal(roomBCeil.z1, 2400, '部屋Bの天井はz=2400のはず');
  assert.equal(roomBFloor.distMm, roomBCeil.distMm, '同じセグメントから生成されるため同じ深さのはず');

  const farWall = hits.find(h => h.kind === 'wallFace' && h.wall !== nearWall
    && h.wall.axisCL.effectiveValue === 8000);
  assert.ok(farWall, 'Bの奥の壁のヒットがあるはず');

  // QA指摘②: 腰壁の軸位置と部屋A/Bの境界CLは同一直線上（腰壁は境界に立つ壁）のため、
  // 腰壁のwallFaceヒットと部屋BのfloorFace/ceilFaceヒットは**同じ距離(57.5mm)**になる
  // ——kindRankの「同深度なら垂直面(wallFace)が水平面(floorFace/ceilFace)より先」という
  // 明示規則が無いと、並びが生成順（配列への積み順）に依存してしまう実ケース。
  assert.equal(near.distMm, roomBFloor.distMm, '腰壁と部屋Bの床天井は同じ距離(境界)のはず');
  assert.ok(roomBFloor.distMm < farWall.distMm, '部屋Bの床天井の方がBの奥の壁より近いはず');
  // probeColumnHitsはhits全体をdistMm昇順→kindRank昇順でソート済みであること（配列上の並びでも確認）。
  assert.ok(hits.indexOf(near) < hits.indexOf(roomBFloor),
    '同深度でも垂直面(wallFace)が水平面(floorFace)より先に並ぶはず（kindRank）');
  assert.ok(hits.indexOf(roomBFloor) < hits.indexOf(farWall));
});

// QA指摘⑤: cutPlaneOffsetMm===0（切断線が壁の中心線ちょうど）だとfloorFace/ceilFaceは
// 一切出ない——info.room自体が向こう側の部屋(B)になり、cellsAlongの最初のセグメント(B)が
// info.roomと一致してスキップされるため（addHorizontalFaceHitsのコメント参照）。
test('【QA指摘⑤・Phase3】probeColumnHits: 切断線が壁の中心線ちょうど(offset=0)だとfloorFace/ceilFaceは出ず、向こう側の部屋はslabFace経路だけになる', () => {
  const { graph, roomB, nearWall } = makeKneeWallFixture();
  const cut = {
    seqNo: 'offset0',
    line: { isVertical: false, axisValue: nearWall.axisCL.effectiveValue, lo: 0, hi: 4000 }, // offset=0
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack } = probeColumnHits(cut, 2000, probeCtx);

  assert.equal(layerStack[0].room, roomB, '前提: offset=0では自室の解決が向こう側の部屋(B)になる');
  assert.ok(!hits.some(h => h.kind === 'floorFace'), 'floorFaceヒットは出ないはず');
  assert.ok(!hits.some(h => h.kind === 'ceilFace'), 'ceilFaceヒットは出ないはず');
  assert.ok(hits.some(h => h.kind === 'slabFace' && h.room === roomB),
    '向こう側だったはずの部屋(B)は、自室扱いとしてslabFace経路で表現されるはず');
});

function makeDropWallFixture() {
  const graph = makeGraph();
  const roomD = makeRectRoom(graph, 0, 0, 4000, 4000, 'D');
  roomD.setOverride('ceilingHeight', '3000'); // 天井3000
  const roomC = makeRectRoom(graph, 0, 4000, 4000, 8000, 'C');
  roomC.setOverride('ceilingHeight', '3000');
  const nearWall = graph.walls.find(w =>
    !w.isVertical && w.axisCL.effectiveValue === 4000 && w.materialRange.hi === 4000);
  graph.setKneeDropWall(
    edgeKey(nearWall.axisCL.id, nearWall.clStart.id, nearWall.clEnd.id), { drop: { bottomHeight: 1200 } });
  return { graph, roomD, roomC, nearWall };
}

test('【Phase3・垂れ壁版】probeColumnHits: 垂れ壁(下端1200・天井3000)の列でも部屋CのceilFaceがz=3000で出る', () => {
  const { graph, roomC, nearWall } = makeDropWallFixture();
  const cut = kneeFaceCut(graph, nearWall);
  cut.seqNo = 'dropFace';
  const probeCtx = makeProbeContext(cut.layers);
  const { hits } = probeColumnHits(cut, 2000, probeCtx);

  const near = hits.find(h => h.wall === nearWall);
  assert.ok(near, '垂れ壁自身のヒットがあるはず');
  assert.equal(near.z0, 1800, '垂れ壁の実在範囲の下端は天井3000-下端1200=1800のはず');
  assert.equal(near.z1, 3000);

  const roomCCeil = hits.find(h => h.kind === 'ceilFace' && h.room === roomC);
  assert.ok(roomCCeil, '部屋CのceilFaceヒットがあるはず');
  assert.equal(roomCCeil.z0, 3000); assert.equal(roomCCeil.z1, 3000, '部屋Cの天井はz=3000のはず');
});

test('【Phase3・出力不変】visibleBandsOf: floorFace/ceilFace/slabFaceヒットを含めても含めなくてもbandsは同一', () => {
  const { graph, nearWall } = makeKneeWallFixture();
  const cut = kneeFaceCut(graph, nearWall);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);

  const faceKinds = new Set(['floorFace', 'ceilFace', 'slabFace']);
  const withoutFaces = hits.filter(h => !faceKinds.has(h.kind));
  assert.ok(withoutFaces.length < hits.length, '前提: 除外対象の水平面ヒットが実在するはず');

  const bandsWithFaces = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const bandsWithoutFaces = visibleBandsOf(withoutFaces, cut, { layerStack, unexploredBelowZ });
  assert.deepEqual(bandsWithFaces, bandsWithoutFaces,
    '水平面ヒットの有無でbandsは変わらないはず（出力完全不変）');
});

// 変異手順（報告に貼る。実行して確認済み）: visibleBandsOfの`coverableHits`フィルタを
// `hits`そのものへ戻すだけでは「出力不変」テストは赤くならない——floorFace/ceilFaceは
// z0===z1（厚みゼロ）で登録しており、`covering`のz区間一致判定
// （`zm > c.z0-EPS && zm < c.z1+EPS`）を実質満たせないため、選択（frontMatch/wallMatch。
// 元々kind='wallFace'等しか見ない）に混ざっても無害という二重の安全策になっている。
// coverableHitsの除外が実際に効くことを確認するには、次の3点を**同時に**変更する:
// (1) `coverableHits = hits`（除外フィルタ無効化）、(2) wallMatchの`.filter(c => c.kind
// === 'wallFace')`を`|| c.kind === 'floorFace' || c.kind === 'ceilFace'`へ拡張、
// (3) addHorizontalFaceHitsのfloorFace/ceilFaceのz1を`z0+50`/`z0-50`へ広げて厚みを持たせる
// （Phase 4で実際に厚み・深度上限を持つ形に近づく想定）。この3点を同時に戻すと、
// 「出力不変」テストと上の2本の【Phase3】テストが赤くなることを確認した。
//
// 変異手順その2（報告に貼る）: spaceModel.jsのcellsAlongの`viewSign`の符号を反転する
// （`cut.viewSign === -1 ? -1 : 1` → `cut.viewSign === -1 ? 1 : -1`）と、腰壁の先の
// floorFace/ceilFaceが逆向き（部屋Aの内側）を探査してしまい、上の
// 「腰壁の...深度昇順で並ぶ」テストが赤くなることを確認する。
