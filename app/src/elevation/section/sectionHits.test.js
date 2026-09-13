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
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, OpeningCategory, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext, probeColumn } from './sectionProbe.js';
import { probeColumnHits, visibleBandsOf, isHiddenWall } from './sectionHits.js';

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

test('【Phase3・出力不変】visibleBandsOf: floorFace/ceilFace/slabFaceヒットの有無でband自体の選択（kind/z0/z1/wall等）は変わらない', () => {
  const { graph, nearWall } = makeKneeWallFixture();
  const cut = kneeFaceCut(graph, nearWall);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);

  const faceKinds = new Set(['floorFace', 'ceilFace', 'slabFace']);
  const withoutFaces = hits.filter(h => !faceKinds.has(h.kind));
  assert.ok(withoutFaces.length < hits.length, '前提: 除外対象の水平面ヒットが実在するはず');

  const bandsWithFaces = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const bandsWithoutFaces = visibleBandsOf(withoutFaces, cut, { layerStack, unexploredBelowZ });
  // Phase 5でfarFaceAnnotationの探索範囲がz0未満（floorFaceの延長ケース）へ広がったため、
  // floorFace/ceilFaceヒットの有無は band.farFloorZ/farCeilZ/farDepthMm には実際に効くように
  // なった（この帯がsectionEngine.jsで`open`へ作り替えられたとき引き継がれる付帯情報。
  // 「11'」A2型）——Phase3が担保するのは**band自体の選択**（kind/z0/z1/wall/room。
  // `frontMatch`/`wallMatch`は元からfloorFace/ceilFaceを見ない）が変わらないことなので、
  // far*系のプロパティを除いて比較する。
  const FAR_KEYS = new Set(['farFloorZ', 'farCeilZ', 'farDepthMm']);
  const stripFar = bands => bands.map(b =>
    Object.fromEntries(Object.entries(b).filter(([k]) => !FAR_KEYS.has(k))));
  assert.deepEqual(stripFar(bandsWithFaces), stripFar(bandsWithoutFaces),
    '水平面ヒットの有無でband自体の選択（far*を除く）は変わらないはず');
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

// ================================================================
// (6) Phase 4: `open`帯へのfarFloorZ/farCeilZ/farDepthMm付帯情報
// ================================================================
// `visibleBandsOf`はここまで（深度上限の適用・アキの縮小）は行わない——付帯情報を載せるだけ
// （sectionEngine.jsの`splitOpenByFarFace`が上限適用・縮小を担当。テストはsectionEngine.test.js側）。
//
// `bandRoomBounds`（部屋Aの包絡矩形。本番は`appendBandCutContent`が設定する`withinViewRoom`の
// 入力）を明示する——省略すると、部屋Bのさらに奥（外周壁。距離約4057.5mm）が見えがかり壁の候補
// として通ってしまい、部屋BのfloorFace/ceilFaceより優先して選ばれる（本番でも同じ壁は`hits`には
// 残るが、`bandRoomBounds`で「部屋Aの外」として除外されている。既存の【Phase3】テストは
// `bandRoomBounds`を付けずに候補収集そのものを確認しているため、この差はそちら側の設計）。
// 部屋Aの天井高も3000へ上書きする（本番knee-drop-test.stqと同じ。既定の2400のままだと部屋A自身の
// 天井が部屋Bの天井2400とたまたま同じ高さになり、「区間が縮むのはPhase4のコードのおかげ」と
// 「区間はもともと2400までしか無かった」を見分けられない）。
const roomABounds = { x1: 0, x2: 4000, y1: 0, y2: 4000 };

test('【Phase4・a】visibleBandsOf: 腰壁面のopen帯へ部屋BのfarCeilZ(2400)が付く（floorはz0(800)より下だが、その下は腰壁本体＝実体があるので対象外でnull）', () => {
  const { graph, roomA, nearWall } = makeKneeWallFixture();
  roomA.setOverride('ceilingHeight', '3000');
  const cut = { ...kneeFaceCut(graph, nearWall), bandRoomBounds: roomABounds };
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);

  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const openBand = bands.find(b => b.kind === 'open');
  assert.ok(openBand, 'open帯があるはず（腰壁の上、z800..3000＝部屋A自身の天井まで）');
  assert.equal(openBand.z0, 800); assert.equal(openBand.z1, 3000);
  assert.equal(openBand.farCeilZ, 2400, '部屋Bの天井2400は区間[800,3000]の内部にあるので付くはず');
  // Phase 5（設計`.claude/elevation-redesign.md`§5.5「残る非対称」の解消）: floorFaceは
  // z0(800)より下（z=0）も候補になりうるが、**それを許すのはz0がこの列自身の探査下限
  // （cut.zRange.loZ）と一致するときだけ**——ここはz0=800で列自身の下限0とは一致しない
  // （0..800は腰壁本体＝実体のある`wall`帯として既に表現済み）ので対象外のまま。
  // 実機「11'」A2型（z0がその列の探査下限そのもの＝下に何も無い）はsectionEngine.test.js
  // 【QA是正A】で別途検証する。
  assert.equal(openBand.farFloorZ, null, '部屋Bの床0はz0(800)より下だが、その下は腰壁本体なので対象外でnullのはず');
  assert.equal(openBand.farDepthMm, 57.5, '腰壁自身と同じ距離（境界CL上のため）のはず');
});

test('【Phase4・d】visibleBandsOf: 垂れ壁面のopen帯(z0..1800)は部屋Cの床(0)も天井(3000)も区間の境界そのものなので付帯情報が付かない（縮まない＝ユーザー受入基準どおり）', () => {
  const { graph, nearWall } = makeDropWallFixture();
  const cut = { ...kneeFaceCut(graph, nearWall), seqNo: 'dropFace', bandRoomBounds: roomABounds };
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);

  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const openBand = bands.find(b => b.kind === 'open' && b.z0 === 0);
  // 垂れ壁の実在範囲はz1800..3000（下端 = 天井3000-bottomHeight1200。kneeDropWall.jsの規約）
  // のため、垂れ壁の下のアキはz0..1800——ユーザー受入基準「Cの床線(0)と垂れ壁下端のあいだが
  // アキ」の区間そのもの。
  assert.ok(openBand, '垂れ壁下端(1800)未満のopen帯(z0..1800)があるはず');
  assert.equal(openBand.z1, 1800);
  assert.equal(openBand.farFloorZ, undefined, '部屋Cの床0は区間の下端(z0=0)ちょうどなので付帯情報は付かない');
  assert.equal(openBand.farCeilZ, undefined, '部屋Cの天井3000は区間の上端(z1=1800)より上（垂れ壁の中）なので付かない');
});

// ---- 失敗系 ----
test('【失敗系・Phase4・e】visibleBandsOf: floorFaceヒットはあってもceilFaceヒットが無い（天井高が解決できない縮退。設計§5.7）なら、open帯にfarFloorZだけ付きfarCeilZは付かない', () => {
  // 実際にceilZ:nullな部屋を作る（getFinishInfo例外の再現）代わりに、addHorizontalFaceHitsが
  // 生成する形（floorFace/ceilFaceは同じ深さの独立したヒット）をそのまま使い、ceilFaceヒットだけを
  // 取り除く——「セグメントのceilZがnullでceilFaceが積まれなかった」のと同じ入力形になる
  // （sectionHits.jsのaddHorizontalFaceHits「if (seg.ceilZ != null)」ガード参照）。
  // 部屋BのfloorFace(z=0)は腰壁面のアキ区間[800,3000]の外（範囲外）で使えないため、区間の内部に
  // 床が来る構成が要る——ここでは合成のfloorFaceヒット（z=1500、部屋Bのfloorヒットの複製で深さも
  // 同じ）を1件加える。
  const { graph, roomA, nearWall } = makeKneeWallFixture();
  roomA.setOverride('ceilingHeight', '3000');
  const cut = { ...kneeFaceCut(graph, nearWall), bandRoomBounds: roomABounds };
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const roomBFloor = hits.find(h => h.kind === 'floorFace');
  assert.ok(roomBFloor, '前提: 部屋BのfloorFaceヒットがあるはず');

  const syntheticHits = hits
    .filter(h => h.kind !== 'ceilFace' && h.kind !== 'floorFace')
    .concat([{ ...roomBFloor, z0: 1500, z1: 1500 }]); // 区間[800,3000]の内部へ床だけ合成

  const bands = visibleBandsOf(syntheticHits, cut, { layerStack, unexploredBelowZ });
  const openBand = bands.find(b => b.kind === 'open');
  assert.ok(openBand);
  assert.equal(openBand.farFloorZ, 1500, 'floorFaceヒットは区間内部にあるので付くはず（床線だけの縮退）');
  assert.equal(openBand.farCeilZ, null, 'ceilFaceヒットが無ければfarCeilZはnull（天井線は出ない）のはず');
});

// QA是正2026-09: sameZBandの'wall'ケースはfarFloorZ/farCeilZ/farDepthMmを比較しない
// （実機「5」voidAbove縦線3本の回帰対応）。回帰テスト——同じ壁・同じ距離(distMm)の隣接z区間は、
// far付帯情報（floorFace/ceilFaceの有無・値）が違っても**1本に畳まれる**ことを固定する。
// hitsは手書き（同じ壁を指す2件のwallFaceヒットをz0..1200/1200..2400へ人為的に分け、
// 下側の区間[0,1200]の内部にだけfloorFaceヒット(z=600)を1件合成する）——sameZBandへ
// far比較を戻す変異（'wall'ケースへfarFloorZ等の比較を足す）で本テストが赤化することを確認済み。
test('【回帰・QA是正2026-09】visibleBandsOf: 同じ壁・同じ距離の隣接wall帯は、far付帯（floorFace/ceilFaceの有無）が違っても1本のwall帯に畳まれる', () => {
  const { graph, nearWall } = makeKneeWallFixture();
  const cut = { ...kneeFaceCut(graph, nearWall), bandRoomBounds: roomABounds };
  const probeCtx = makeProbeContext(cut.layers);
  const { layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const layer = cut.layers[0];

  const syntheticHits = [
    { kind: 'wallFace', wall: nearWall, layer, distMm: 57.5, z0: 0, z1: 1200, isKneeDrop: false },
    { kind: 'wallFace', wall: nearWall, layer, distMm: 57.5, z0: 1200, z1: 2400, isKneeDrop: false },
    // 下側の区間[0,1200]の内部（z=600）にだけfloorFaceを置く——上側[1200,2400]には無い
    // （item③「上側だけにあった付帯情報は失われる」の前提そのもの）。
    { kind: 'floorFace', layer, room: null, distMm: 57.5, z0: 600, z1: 600 },
  ];

  const bands = visibleBandsOf(syntheticHits, cut, { layerStack, unexploredBelowZ });
  const wallBands = bands.filter(b => b.kind === 'wall');
  assert.equal(wallBands.length, 1, '2本のwallFaceヒット（同じ壁・同じ距離）由来のwall帯は畳まれて1本のはず');
  assert.equal(wallBands[0].z0, 0); assert.equal(wallBands[0].z1, 2400,
    '畳まれた帯はz0..2400（元の2区間の和）のはず');
  assert.equal(wallBands[0].farFloorZ, 600,
    '畳んだ結果、残るfar付帯は下側(z0が小さい方)の帯のもの——mergeAdjacentZBandsの注記どおり');
});

// ================================================================
// isHiddenWall（展開図一般化Phase 6。設計§5.4「規則へ吸収」）:
// cut.airRoom/cut.underRoomsによる空気ボリューム判定（旧cut.hiddenWallIdsの置換）。
// フィクスチャは「帯自身の部屋(LDK=airRoom)」「階段下相当の部屋(Under=underRooms)」が
// y=3000で隣接する2室（makeRectRoomが両者ともgenerateRoomWallsFromOutlineで実壁を生成する
// ため、境界には isRoomWall:true の実壁が立つ——実機13.stqの2a壁と同じ性質）。
// ================================================================

// Phase 6b-2 C-1（設計`.claude/elevation-redesign.md`§5.11）: isHiddenWall該当の壁は
// 「候補から消す」のではなく「描かない実体」として候補・選択結果に残る。旧テスト
// 「候補収集(probeColumnHits)・列の分割(collectCutBreaks)の両方から消える」は前提が変わった
// ため、逆向き（残る・hiddenが付く・選択結果がkind:'hidden'になる）へ更新する。
test('【Phase6b-2 C-1】帯自身の部屋と階段下部屋を隔てる実壁は候補から消えず、hidden:trueが付き、選択結果はkind:"hidden"になる（"open"にはならない）', () => {
  const graph = makeGraph();
  const airRoom = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const underRoom = makeRectRoom(graph, 0, 3000, 4000, 6000, 'Under');
  const wall = farWallOf(graph);
  assert.ok(wall, '境界の壁があるはず');
  assert.equal(wall.isRoomWall, true, '前提: 部屋の生成壁(isRoomWall)のはず');

  const cut = frontCut(graph, { airRoom, underRooms: new Set([underRoom]) });
  const probeCtx = makeProbeContext(cut.layers);
  const layer = cut.layers[0];
  assert.equal(isHiddenWall(cut, wall, layer, probeCtx), true,
    '帯自身の空気ボリューム(airRoom)と階段下部屋(underRooms)を隔てる壁は非可視のはず');

  // 候補収集(probeColumnHits)からは消えない——hidden:trueを付けて積む（深度順は不変）。
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const wallHit = hits.find(h => h.wall === wall);
  assert.ok(wallHit, '非可視の壁も候補(hits)には残るはず（Phase 6b-2でcontinueをやめた）');
  assert.equal(wallHit.hidden, true, '非可視の壁のヒットにはhidden:trueが付くはず');

  // 選択結果(visibleBandsOf)は'open'（アキ・バツの対象）ではなく'hidden'（描かない実体）になる。
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.ok(!bands.some(b => b.kind === 'open'),
    'この列にopen帯は無いはず（壁の実体がhiddenとして選ばれ、アキにならない）');
  const hiddenBands = bands.filter(b => b.kind === 'hidden');
  assert.ok(hiddenBands.length > 0, 'kind:"hidden"の帯が選ばれるはず');
  // hidden帯はwall/distMm/openingPassThrough/far付帯を一切持たない（実体の詳細を渡さない宣言）。
  for (const b of hiddenBands) {
    assert.equal(b.wall, undefined, 'hidden帯にwall参照は付かないはず');
    assert.equal(b.distMm, undefined, 'hidden帯にdistMmは付かないはず');
    assert.equal(b.farFloorZ, undefined, 'hidden帯にfarFloorZは付かないはず');
    assert.equal(b.farCeilZ, undefined, 'hidden帯にfarCeilZは付かないはず');
  }
});

test('【失敗系・isHiddenWall】cut.underRoomsが無ければ非隠蔽のまま（従来どおりkind:"wall"の帯になる）', () => {
  const graph = makeGraph();
  const airRoom = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  makeRectRoom(graph, 0, 3000, 4000, 6000, 'Under');
  const wall = farWallOf(graph);

  const cut = frontCut(graph, { airRoom }); // underRooms未指定
  const probeCtx = makeProbeContext(cut.layers);
  assert.equal(isHiddenWall(cut, wall, cut.layers[0], probeCtx), false,
    'underRooms未指定なら判定対象外（非隠蔽）のはず');
  // 選択結果も従来どおりkind:'wall'（hiddenにならない）。
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.ok(bands.some(b => b.kind === 'wall' && b.wall === wall),
    'underRoomsが無ければ従来どおりkind:"wall"の帯として選ばれるはず');
  assert.ok(!bands.some(b => b.kind === 'hidden'), 'hidden帯は出ないはず');
});

test('【失敗系・isHiddenWall】isRoomWall=falseの壁（自立した間仕切り等）は、位置が階段下部屋の境界と重なっても非隠蔽のまま', () => {
  const graph = makeGraph();
  const airRoom = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const underRoom = makeRectRoom(graph, 0, 3000, 4000, 6000, 'Under');
  // 境界(y=3000)と同じ位置に、isRoomWall:falseの自立した壁を別途置く（例:
  // switchbackCuts.jsのfindMidWallが見つける往復間の壁）——wall.coord1/coord2/materialRangeは
  // クラスのgetter（非enumerable）なのでオブジェクトスプライドでは複製できず、実際に
  // graph.addWallで生成した壁でなければ意味のある検証にならない。
  const y3000 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.effectiveValue === 3000);
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.effectiveValue === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.effectiveValue === 4000);
  const freestandingWall = graph.addWall(y3000, 0, false, x0, 0, x1, 0, { isRoomWall: false });
  assert.equal(freestandingWall.isRoomWall, false, '前提: isRoomWall=falseの壁のはず');

  const cut = frontCut(graph, { airRoom, underRooms: new Set([underRoom]) });
  const probeCtx = makeProbeContext(cut.layers);
  assert.equal(isHiddenWall(cut, freestandingWall, cut.layers[0], probeCtx), false,
    'isRoomWall=falseの壁は2a壁ではないため非隠蔽のはず（実測: 13.stqの旧hiddenWallIds4枚は全てisRoomWall:true）');
});

test('【失敗系・isHiddenWall】underRoomsと無関係な第三の部屋を隔てるだけの壁は非隠蔽のまま（無関係な部屋の外壁まで隠さない）', () => {
  const graph = makeGraph();
  const airRoom = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  makeRectRoom(graph, 0, 3000, 4000, 6000, 'Under'); // underRoomsに入れない＝この部屋とは無関係
  makeRectRoom(graph, 4000, 0, 8000, 3000, 'Other'); // airRoomの東隣（無関係な別室9相当。隙間なく隣接）
  const eastWall = graph.walls.find(w => w.isVertical && w.axisCL.effectiveValue === 4000);
  assert.ok(eastWall, 'airRoomとOtherの間の壁があるはず');

  // underRoomsは実際には無関係な"Other"を指す——QA実測の反例（13.stq「6」D面の実壁が
  // 無関係な部屋との境界というだけで誤って非可視化されていたケース）を再現する。
  const otherRoom = [...graph.rooms].find(r => r.name === 'Other');
  const cut = frontCut(graph, { airRoom, underRooms: new Set([otherRoom]) });
  const probeCtx = makeProbeContext(cut.layers);
  assert.equal(isHiddenWall(cut, eastWall, cut.layers[0], probeCtx), true,
    '対照実験: underRoomsに実際に指定されていれば隠れる（判定ロジック自体は機能する）');

  // 今度はunderRoomsを空にする（Otherを含めない）——このときeastWallは隠れないはず。
  const cutNoUnder = frontCut(graph, { airRoom, underRooms: new Set() });
  assert.equal(isHiddenWall(cutNoUnder, eastWall, cutNoUnder.layers[0], probeCtx), false,
    'underRoomsに含まれない部屋との境界というだけでは非可視にしないはず');
});

// QA指摘（コミット前レビュー）: isHiddenWallの中心規則「反対側が帯自身の空気ボリュームと
// 連結しているか」（`probeCtx.componentOf(layer, otherRoom) === airComponent`）がノーガード
// だった——このregionを常にtrueへ変異させても既存テストは全緑のままだった（このテストが無いと
// 判定ロジックの半分が検証されずに通る）。13.stq「13」⇔「1」（階段下部屋と、階段室とは
// 連結していない別室が隣接する境界）の実際の構成を再現する: airRoom(階段室)—underRoom(階段下
// 部屋)—isolatedRoom(階段室と全高壁で仕切られた無関係な別室)の3室を一列に並べ、
// underRoomとisolatedRoomの境界壁を検証する。
test('【isHiddenWall】階段下部屋の反対側が階段室の空気ボリュームと非連結の部屋なら非隠蔽のまま（13.stq「13」⇔「1」相当）', () => {
  const graph = makeGraph();
  const airRoom = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');       // 階段室
  const underRoom = makeRectRoom(graph, 0, 3000, 4000, 6000, 'Under'); // 階段下部屋
  const isolatedRoom = makeRectRoom(graph, 0, 6000, 4000, 9000, 'Isolated'); // 階段室と無関係な別室
  const wall = graph.walls.find(w => !w.isVertical && w.axisCL.effectiveValue === 6000);
  assert.ok(wall, 'Under⇔Isolatedの境界壁があるはず');
  assert.equal(wall.isRoomWall, true, '前提: 部屋の生成壁のはず');

  const cut = frontCut(graph, { airRoom, underRooms: new Set([underRoom]) });
  const probeCtx = makeProbeContext(cut.layers);
  // 前提確認: airRoomとisolatedRoomは全高の壁（airRoom⇔underRoom・underRoom⇔isolatedRoom
  // それぞれの境界壁）で仕切られており、別の連結成分のはず。
  assert.notEqual(
    probeCtx.componentOf(cut.layers[0], airRoom), probeCtx.componentOf(cut.layers[0], isolatedRoom),
    '前提: airRoomとisolatedRoomは非連結のはず');

  assert.equal(isHiddenWall(cut, wall, cut.layers[0], probeCtx), false,
    'Under側は階段下部屋だが、反対側(Isolated)が階段室の空気ボリュームと非連結なので非隠蔽のはず');
});

// ================================================================
// (7) Phase 6b-1: 階段の占有面（stairFace。設計`.claude/elevation-redesign.md`§5.3(b)）
// ================================================================
// 13.stq「6」面C相当（switchbackCuts seqNo '1'・正面視・踊り場から上り口Y2へ見下ろす向き）の
// フィクスチャ。ユーザー裁定の実測値と同じ縮尺（往路0〜1392.5・復路の内側ささら1492.5・
// baseFloorZ=1500=n1*riser）を使う——`sectionStair.test.js`の`stairSixCFixtureContribution`と
// 同じ幾何（QA是正2026-09・要件B「x=1492.5に出ることを固定」）。ここでは`probeColumnHits`/
// `visibleBandsOf`への配線だけを確認する（stairFaceHits自体の判定はsectionStair.test.js側）。
function stairContributionFixture() {
  return {
    structure: StructuralMaterialType.STEEL,
    flights: [
      { isVertical: true, runLo: 1500, runHi: 4500, acrossLo: 0, acrossHi: 1442.5,
        baseZ: 0, riserMm: 250, steps: 6, lengthMm: 3000 },
      { isVertical: true, runLo: 1500, runHi: 4500, acrossLo: 1442.5, acrossHi: 2985,
        baseZ: 1500, riserMm: 250, steps: 6, lengthMm: 3000 },
    ],
    landings: [{ runLo: 0, runHi: 1500, acrossLo: 0, acrossHi: 2985, z: 1500 }],
    unit: { landingFrameDepthMm: 300 },
  };
}

// 正面視の切断（seq1相当）。room自体は階段室の平面ではなく、南に壁を1枚持つだけの単純な矩形室
// ——stairFaceの深度(0)と見えがかり壁の深度(3000)を比べるための「奥の壁」を1枚用意するのが目的。
function stairFrontCut(graph, overrides = {}) {
  return {
    seqNo: '1',
    line: { isVertical: false, axisValue: 3000, lo: 0, hi: 2985 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 1500,
    stairCut: stairContributionFixture(),
    ...overrides,
  };
}

test('【Phase6b-1・(a)・QA是正】probeColumnHits: 「6」面C相当の列（x=700/1492.5/2000）で、段板・内側ささらのstairFaceヒットが深度0で、奥の壁(distMm=3000)より手前に並ぶ', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 6000, 'STAIRWELL'); // 南壁(y=6000)までの距離=3000（axisValue=3000から）
  const cut = stairFrontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  // x=700: 往路(outbound)の段板のみ（0〜1392.5の内側。復路の内側ささらはx=1492.5でここには無い）。
  const at700 = probeColumnHits(cut, 700, probeCtx).hits;
  const stairHit700 = at700.find(h => h.kind === 'stairFace');
  assert.ok(stairHit700, 'x=700の列にstairFaceヒットがあるはず（往路の段板の占有範囲0..1392.5の内側）');
  assert.equal(stairHit700.side, 'outbound'); assert.equal(stairHit700.part, 'tread');
  assert.equal(stairHit700.z0, 0); assert.equal(stairHit700.z1, 1500);
  assert.equal(stairHit700.distMm, 0, '正面視の段板は切断平面上にある実体として深度0のはず');
  assert.equal(stairHit700.depthNearMm, 0); assert.equal(stairHit700.depthFarMm, 3000);
  assert.equal(stairHit700.atCutPlane, true);

  // x=1492.5: 復路(inbound)の内側ささら（ユーザー裁定の実測値そのもの）と、復路の段板の両方が
  // 同じ列に乗る（段板のx範囲1492.5..2985がstringerのx=1492.5をちょうど含むため）。
  const at1492 = probeColumnHits(cut, 1492.5, probeCtx).hits;
  const stringerHit = at1492.find(h => h.kind === 'stairFace' && h.part === 'stringer');
  assert.ok(stringerHit, 'x=1492.5の列に復路の内側ささらヒットがあるはず（ユーザー裁定の実測値）');
  assert.equal(stringerHit.side, 'inbound');
  assert.equal(stringerHit.z0, 1500); assert.equal(stringerHit.z1, 3000);
  assert.equal(stringerHit.distMm, 0); assert.equal(stringerHit.atCutPlane, true);
  const treadHit1492 = at1492.find(h => h.kind === 'stairFace' && h.part === 'tread' && h.side === 'inbound');
  assert.ok(treadHit1492, 'x=1492.5は復路の段板の占有範囲(1492.5..2985)の左端でもあるはず');

  // x=2000: 復路(inbound)の段板のみ（内側ささらはx=1492.5だけの縦線なのでここには無い）。
  const at2000 = probeColumnHits(cut, 2000, probeCtx).hits;
  const stairHit2000 = at2000.filter(h => h.kind === 'stairFace');
  assert.ok(stairHit2000.some(h => h.part === 'tread' && h.side === 'inbound'), 'x=2000は復路の段板の範囲内のはず');
  assert.ok(!stairHit2000.some(h => h.part === 'stringer'), 'x=2000には内側ささら(x=1492.5限定)のヒットは無いはず');

  const wallHit = at700.find(h => h.kind === 'wallFace');
  assert.ok(wallHit, '南壁の見えがかりヒットがあるはず');
  assert.equal(wallHit.distMm, 3000);
  assert.ok(stairHit700.distMm < wallHit.distMm, '段板は奥の壁より手前(深度が小さい)のはず');
  assert.ok(at700.indexOf(stairHit700) < at700.indexOf(wallHit),
    'hits配列は深度昇順のはずなので、段板ヒットが壁ヒットより先に並ぶ');
});

test('【Phase6b-1・(b)・出力不変】visibleBandsOf: stairFaceヒットの有無でband自体の選択（kind/z0/z1/wall等）は変わらない', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 6000, 'STAIRWELL');
  const cut = stairFrontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 700, probeCtx);

  assert.ok(hits.some(h => h.kind === 'stairFace'), '前提: stairFaceヒットが実在するはず');
  const withoutStairFace = hits.filter(h => h.kind !== 'stairFace');

  const bandsWithStairFace = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const bandsWithoutStairFace = visibleBandsOf(withoutStairFace, cut, { layerStack, unexploredBelowZ });
  assert.deepEqual(bandsWithStairFace, bandsWithoutStairFace,
    'stairFaceヒットの有無でbandの選択は変わらないはず（Phase 6b-1は載せるだけ・選択には参加しない）');
});

test('【Phase6b-1・(c)・失敗系】probeColumnHits: cut.stairCutが無ければstairFaceヒットは0件（階段帯以外への影響が無いこと）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 6000, 'STAIRWELL');
  const cut = stairFrontCut(graph, { stairCut: null });
  const probeCtx = makeProbeContext(cut.layers);
  const { hits } = probeColumnHits(cut, 700, probeCtx);
  assert.ok(!hits.some(h => h.kind === 'stairFace'));
});

test('【Phase6b-1・(c)・失敗系】probeColumnHits: worldMidがNaNでも例外を投げず、bandsはzRangeを隙間なく覆う', () => {
  // 上の「worldMidがNaNでも例外を投げずbands・hitsを返す」と同じ既知の挙動（NaNはガード比較を
  // 常にfalseにすり抜けるため、stairFaceヒットも「境界チェックなしで候補に採用される」）を
  // stairFace経路でも変えないことだけを確認する——visibleBandsOfはstairFaceを選択対象から
  // 除外するため、混入してもbands自体には影響しない。
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 6000, 'STAIRWELL');
  const cut = stairFrontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, NaN, probeCtx);
  assert.ok(Array.isArray(hits), '例外を投げず配列を返すはず');

  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  assert.ok(bands.length >= 1, '例外を投げずbandsを返すはず');
  assert.equal(bands[0].z0, 0, 'zRange下端から始まるはず');
  assert.equal(bands[bands.length - 1].z1, 3000, 'zRange上端まで覆うはず');
});

// 変異手順（報告に貼る。実行して確認済み）:
// (1) coverableHitsの除外リストから'stairFace'を外すだけでは、この単体フィクスチャでは
//     【(b)・出力不変】は赤くならない（実測）——floorFace/ceilFace/slabFaceのときと同じ
//     二重の安全策（上のコメント「変異手順その1」参照）がここにも働く: stairFaceの
//     z0/z1はzBreaksへ混入しband分割は起きるが、frontMatch/wallMatchのkindホワイトリストに
//     元から'stairFace'が無いため選択結果（kind/wall/distMm）自体は変わらず、分割された
//     隣接bandはmergeAdjacentZBandsが1本に畳み戻す。除外を外したうえで**さらに**
//     `wallMatch`の`.filter(c => c.kind === 'wallFace')`を`|| c.kind === 'stairFace'`へ
//     広げる（stairFaceのdistMm=0が実際の壁(distMm=3000)より優先して選ばれるようになる）と
//     初めて【(b)・出力不変】が赤くなることを確認した——コード側の安全策はkindホワイトリスト
//     （選択に混ざらない）が主、coverableHitsの除外（zBreaksを汚さない）は副次的な一貫性。
// (2) sectionStair.jsのstairFaceHitsで正面視(tread)のdepthMmを`0`から`-1`（符号を反転した値）へ
//     変えると→上の【(a)】の`stairHit.distMm < wallHit.distMm`は通ってしまう(-1<3000)ため、
//     `assert.equal(stairHit.distMm, 0, ...)`の等値チェックが赤くなる。
