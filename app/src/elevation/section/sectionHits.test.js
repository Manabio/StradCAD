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
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, OpeningCategory, StructuralMaterialType, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext, probeColumn } from './sectionProbe.js';
import { buildColumns } from './sectionEngine.js';
import { buildCutContent } from './sectionContent.js';
import { emitOpenGapMarks } from './sectionEmit.js';
import { probeColumnHits, visibleBandsOf, isHiddenWall, buildLayerStack, nearMembersOf } from './sectionHits.js';
import { makeGrid } from '../../plan/planTestFixtures.js';
import { createZone } from '../../ceiling/ceilingZones.js';

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

// ---- 天伏の平面区画（buildLayerStackの天井は探査点の区画の高さ） ----
test('【buildLayerStackのceilZは探査点の区画】区画の列は区画の高さ・区画外の列は部屋のCH', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  const cut = frontCut(g.graph, { line: { isVertical: false, axisValue: 0, lo: 0, hi: 5000 } });
  const probeCtx = makeProbeContext(cut.layers);
  assert.equal(buildLayerStack(cut, 3500, probeCtx)[0].ceilZ, 3000, '区画の列');
  assert.equal(buildLayerStack(cut, 1000, probeCtx)[0].ceilZ, 2500, '区画の無い列は部屋のCH');
});

test('【失敗系】簡易probeCtx（cellAtがceilZを持たない）ではchOfへ落ちる', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]], { walls: true });
  const cut = frontCut(g.graph, { line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000 } });
  const probeCtx = {
    cellAt: () => ({ room }), floorZOf: () => 0, chOf: () => 2300,
  };
  assert.equal(buildLayerStack(cut, 1000, probeCtx)[0].ceilZ, 2300);
});

// ---- E3b-4: 傾斜の隣室を覗く列（ceilProfile 無し＝階段帯）の層スタックの ceilZ は列の幅での最大 ----
// 部屋 x0..4000・y0..3000、傾斜 底 2400・ライズ 800（+x）＝x=0 で 2400・x=2000 で 2800・x=4000 で 3200。
function slopeFrontCut(extra = {}) {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [800, 0] }).zones);
  const cut = frontCut(g.graph, { line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 }, zRange: { loZ: 0, hiZ: 3200 }, ...extra });
  return { g, cut, probeCtx: makeProbeContext(cut.layers) };
}

test('【傾斜の隣室を覗く列の層スタック ceilZ は列の幅での最大】ceilProfile 無しの列 [0,2000] は 2800・[2000,4000] は 3200（最高点 3200 ではない）', () => {
  const { cut, probeCtx } = slopeFrontCut();
  assert.equal(probeColumnHits(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 }).layerStack[0].ceilZ, 2800);
  assert.equal(probeColumnHits(cut, 3000, probeCtx, { worldLo: 2000, worldHi: 4000 }).layerStack[0].ceilZ, 3200);
  assert.equal(buildLayerStack(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 })[0].ceilZ, 2800, 'buildLayerStack に直接 span を渡しても同じ');
});

test('【自室の帯では出力不変】cut.ceilProfile を持つ切断は span があっても従来どおり面の最高点（エンジンが ceilEdge で打ち切るため）', () => {
  const { cut, probeCtx } = slopeFrontCut({ ceilProfile: [{ loX: 0, hiX: 4000, ceilZ: 2400, ceilZHi: 3200 }] });
  assert.equal(probeColumnHits(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 }).layerStack[0].ceilZ, 3200);
});

test('【ceilClip ありでも帯の性格判定（cellAt の span 分岐）は ceilProfile 無しの挙動のまま】ceilClip だけの切断は列の幅での最大 2800（最高点 3200 にしない）', () => {
  const { cut, probeCtx } = slopeFrontCut({ ceilClip: [{ loX: 0, hiX: 4000, ceilZ: 2400, ceilZHi: 3200 }] });
  assert.equal(probeColumnHits(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 }).layerStack[0].ceilZ, 2800);
  const slab = probeColumn(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 }).find(b => b.kind === 'slab');
  assert.deepEqual([slab?.z0, slab?.z1], [2800, 3200], 'slab/open の分かれも ceilProfile 無しと同じ');
});

test('【ceilProfile 無しの帯で傾斜の列は実高さで slab/open が分かれる】列 [0,2000] は 2800 の上に天井懐の slab（3200 まで）・ceilProfile ありは slab なし', () => {
  const { cut, probeCtx } = slopeFrontCut();
  const bands = probeColumn(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 });
  const slab = bands.find(b => b.kind === 'slab');
  assert.ok(slab, '2800 より上は slab');
  assert.deepEqual([slab.z0, slab.z1], [2800, 3200]);
  const withProf = slopeFrontCut({ ceilProfile: [{ loX: 0, hiX: 4000, ceilZ: 2400, ceilZHi: 3200 }] });
  assert.ok(!probeColumn(withProf.cut, 1000, withProf.probeCtx, { worldLo: 0, worldHi: 2000 }).some(b => b.kind === 'slab'),
    'ceilProfile ありは従来どおり最高点まで空気');
});

test('【flat・区画なしは不変】span を渡しても flat の区画は区画の高さ・区画なしは部屋の CH（span なしと同値）', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  const cut = frontCut(g.graph, { line: { isVertical: false, axisValue: 0, lo: 0, hi: 5000 } });
  const probeCtx = makeProbeContext(cut.layers);
  for (const [mid, lo, hi] of [[3500, 2000, 5000], [1000, 0, 2000]]) {
    assert.equal(buildLayerStack(cut, mid, probeCtx, { worldLo: lo, worldHi: hi })[0].ceilZ, buildLayerStack(cut, mid, probeCtx)[0].ceilZ);
  }
});

test('【縦の切断（isVertical:true）で走りが y の傾斜】底 2400・ライズ 800（+y）の列 y[0,2000] は 2800・[2000,4000] は 3200（x/y の取り違えで赤）', () => {
  const g = makeGrid([0, 3000], [0, 4000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [800, 90] }).zones);
  const cut = frontCut(g.graph, { line: { isVertical: true, axisValue: 0, lo: 0, hi: 4000 }, zRange: { loZ: 0, hiZ: 3200 } });
  const probeCtx = makeProbeContext(cut.layers);
  assert.equal(buildLayerStack(cut, 1000, probeCtx, { worldLo: 0, worldHi: 2000 })[0].ceilZ, 2800);
  assert.equal(buildLayerStack(cut, 3000, probeCtx, { worldLo: 2000, worldHi: 4000 })[0].ceilZ, 3200);
});

test('【失敗系】span の世界座標が非有限でも例外を投げず面の最高点に落ちる', () => {
  const { cut, probeCtx } = slopeFrontCut();
  assert.equal(buildLayerStack(cut, 1000, probeCtx, { worldLo: NaN, worldHi: NaN })[0].ceilZ, 3200);
});

// ---- E3b-3: 視線の先の部屋に天井の面が複数あるとき、手前の面が近側の天井より上で隠れても奥の低い面の ceilFace が選ばれる ----
test('【手前の区画が近側の天井より上で隠れるとき奥の低い区画の ceilFace が選ばれる】近側 A の天井 3000・視線の先の B は手前 3500（隠れる）→奥 2200: ceilFace は 2 件（3500@50・2200@2050）で open 帯の farCeilZ は 2200', () => {
  const g = makeGrid([0, 4000], [0, 4000, 6000, 8000]);
  const roomA = g.interior([[0, 0]]); // 壁なし＝A と B の間は open
  roomA.setOverride('ceilingHeight', '3000');
  const roomB = g.interior([[0, 1], [0, 2]]);
  roomB.setCeilingZones(createZone(g.graph, roomB, [g.cell(0, 1)], { heightMm: 3500, shape: 'flat', dims: [] }).zones);
  roomB.setCeilingZones(createZone(g.graph, roomB, [g.cell(0, 2)], { heightMm: 2200, shape: 'flat', dims: [] }).zones);
  const cut = frontCut(g.graph, { line: { isVertical: false, axisValue: 3950, lo: 0, hi: 4000 }, zRange: { loZ: 0, hiZ: 3000 }, bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 4000 } });
  const probeCtx = makeProbeContext(cut.layers);
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, 2000, probeCtx);
  assert.deepEqual(hits.filter(h => h.kind === 'ceilFace' && h.room === roomB).map(h => [h.z0, h.distMm]), [[3500, 50], [2200, 2050]]);
  const open = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ }).find(b => b.kind === 'open');
  assert.ok(open, 'open 帯があるはず');
  assert.equal(open.farCeilZ, 2200, '3500 は近側の天井 3000 以上＝対象外・奥の 2200 が選ばれる');
  assert.equal(open.farCeilDepthMm, 2050);
});

// ================================================================
// 梁・柱の候補（U1b B1。memberCut / memberFace。選択には参加しない）
// ================================================================
const { VERTICAL: V_CL, HORIZONTAL: H_CL } = CenterLineType;
const { STEEL: STEEL_MAT, WOOD: WOOD_MAT } = StructuralMaterialType;

// 同じ値の通り芯があればそれ、無ければ追加する（部屋の通り芯と梁の端を共有する）。
function clAt(graph, type, value) {
  return graph.centerLines.find(cl => cl.centerLineType === type && cl.value === value)
    ?? graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.STRUCT });
}
// 水平梁（isVertical=false）: 通り芯 y に沿って x lo〜hi。STEEL-H200x100（幅100・成200）。天＝levelOffset（層の床 0 基準）。
function addBeamH(graph, y, lo, hi, levelOffset, props = {}) {
  return graph.addBeam(STEEL_MAT, 'STEEL-H200x100', clAt(graph, H_CL, y), false, clAt(graph, V_CL, lo), clAt(graph, V_CL, hi),
    { role: 'primary', levelOffset, ...props });
}
// 鉛直梁（isVertical=true）: 通り芯 x に沿って y lo〜hi。
function addBeamV(graph, x, lo, hi, levelOffset, props = {}) {
  return graph.addBeam(STEEL_MAT, 'STEEL-H200x100', clAt(graph, V_CL, x), true, clAt(graph, H_CL, lo), clAt(graph, H_CL, hi),
    { role: 'primary', levelOffset, ...props });
}
const memberHitsOf = (hits, kind) => hits.filter(h => h.kind === kind);
function probeMembers(cut, worldMid) {
  const probeCtx = makeProbeContext(cut.layers);
  const res = probeColumnHits(cut, worldMid, probeCtx);
  return { ...res, probeCtx, bands: visibleBandsOf(res.hits, cut, res) };
}
// 水平の切断線 y=axis（viewSign=1＝+y 側を見る）。部屋は 0..4000 × 0..3000。
const cutAtY = (graph, axis, over = {}) => frontCut(graph, { line: { isVertical: false, axisValue: axis, lo: 0, hi: 4000 }, ...over });

test('【梁の候補・直交】切断位置がスパンに入り worldMid が芯±半幅の梁は memberCut（distMm 0・z は天−成〜天）。柱は梁の外の列には積まれない', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamV(graph, 2000, 500, 2500, 2300); // x=2000・y 500..2500・天 2300 → z 2100..2300
  const cut = cutAtY(graph, 1500);
  const on = probeMembers(cut, 2000).hits;
  const mc = memberHitsOf(on, 'memberCut');
  assert.equal(mc.length, 1);
  assert.equal(mc[0].memberType, 'beam');
  assert.equal(mc[0].distMm, 0);
  assert.deepEqual([mc[0].z0, mc[0].z1], [2100, 2300]);
  assert.equal(mc[0].member.axisWorld, 2000);
  assert.equal(mc[0].layer, cut.layers[0], 'layer は部材の属する層（cut.layers の自階）');
  assert.ok(mc[0].section, 'カタログ断面（beamDepthMm の出どころ）が付く');
  assert.equal(memberHitsOf(probeMembers(cut, 1000).hits, 'memberCut').length, 0, '芯±半幅の外の列には積まない');
  // 切断位置がスパンの外（y=200）なら直交していても切られない
  assert.equal(memberHitsOf(probeMembers(cutAtY(graph, 200), 2000).hits, 'memberCut').length, 0, 'スパン外の切断');
});

test('【梁・柱の候補・視線側】平行な梁は memberFace（distMm＝芯の距離）。視線の反対側の梁は積まない。柱は視線側なら memberFace・切断線が通れば memberCut', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamH(graph, 2000, 0, 4000, 2300); // 切断線 y=1500 の視線側（+y）500
  addBeamH(graph, 1000, 0, 4000, 2300); // 視線の反対側（-y）
  graph.addColumn(STEEL_MAT, 'STEEL-SQ200x200x9.0', clAt(graph, V_CL, 3000), clAt(graph, H_CL, 2500), {});
  const cut = cutAtY(graph, 1500);
  const { hits } = probeMembers(cut, 3000);
  const faces = memberHitsOf(hits, 'memberFace');
  const beamFaces = faces.filter(h => h.memberType === 'beam');
  assert.deepEqual(beamFaces.map(h => [h.distMm, h.z0, h.z1]), [[500, 2100, 2300]], '視線側の梁だけ・distMm は |芯−切断線|');
  const colFace = faces.find(h => h.memberType === 'column');
  assert.ok(colFace, '視線側の柱は memberFace');
  const c = colFace.member;
  assert.equal(colFace.distMm, Math.abs((c.yLo + c.yHi) / 2 - 1500), '柱の distMm は柱の中心の距離');
  assert.deepEqual([colFace.z0, colFace.z1], [0, CH], '柱は床〜天井');
  assert.ok(colFace.depthNearMm > 0 && colFace.depthNearMm < colFace.distMm, '手前の縁までの距離を添える');
  assert.equal(memberHitsOf(hits, 'memberCut').length, 0);
  // 切断線が柱の中を通る（y=2500）と memberCut（distMm 0）
  const cutCol = memberHitsOf(probeMembers(cutAtY(graph, 2500), 3000).hits, 'memberCut');
  assert.deepEqual(cutCol.map(h => [h.memberType, h.distMm, h.z0, h.z1]), [['column', 0, 0, CH]]);
  // 梁の下の列でない（柱の走り方向の外）なら柱は積まれない
  assert.equal(memberHitsOf(probeMembers(cut, 1000).hits, 'memberFace').filter(h => h.memberType === 'column').length, 0);
});

test('【梁の候補・切断線が帯を通る平行梁】|芯−切断線| ≤ 半幅（幅 100: 芯 1470・1500・1530）は memberCut・distMm 0・along。半幅の外（芯 1560）は memberFace', () => {
  const run = (axis) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    addBeamH(graph, axis, 0, 4000, 2300);
    return probeMembers(cutAtY(graph, 1500), 2000).hits.filter(h => h.kind === 'memberCut' || h.kind === 'memberFace');
  };
  for (const axis of [1470, 1500, 1530]) {
    const hs = run(axis);
    assert.deepEqual(hs.map(h => [h.kind, h.distMm, h.along, h.z0, h.z1]), [['memberCut', 0, true, 2100, 2300]], `芯 ${axis}`);
  }
  assert.deepEqual(run(1560).map(h => [h.kind, h.distMm, h.along]), [['memberFace', 60, undefined]], '帯の外');
  assert.deepEqual(run(1440).map(h => h.kind), [], '背後で帯にも掛からない');
});

test('【失敗系・埋没した梁】壁の材厚に収まりスパンを覆われた梁は積まない。壁より太い梁・壁がスパンの半分だけの梁の覆われていない列は積む', () => {
  const run = (wallThickness, wallHi, mid) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    const axis = clAt(graph, H_CL, 1500);
    graph.addWall(axis, wallThickness, false, clAt(graph, V_CL, 0), 0, clAt(graph, V_CL, wallHi), 0, {});
    graph.addBeam(WOOD_MAT, 'WOOD-105x105', axis, false, clAt(graph, V_CL, 0), clAt(graph, V_CL, 4000),
      { role: 'primary', levelOffset: 2300, eccentricity: 100 }); // 芯 y=1600・幅 105
    return memberHitsOf(probeMembers(cutAtY(graph, 0), mid).hits, 'memberFace');
  };
  assert.equal(run(200, 4000, 2000).length, 0, '壁（厚 200）の中に全スパン収まる梁は積まない');
  assert.equal(run(60, 4000, 2000).length, 1, '対照: 壁（厚 60）より太い梁は一部が見えるので積む');
  assert.equal(run(200, 2000, 1000).length, 0, '壁がスパンの半分（0..2000）: 壁の足元の列（x=1000）は積まない');
  const open = run(200, 2000, 3000);
  assert.deepEqual(open.map(h => h.distMm), [1600], '壁に覆われていない列（x=3000）は積む');
});

test('【失敗系・埋没した梁（直交）】切断位置が壁の足元に入る直交梁の memberCut は積まない。壁の足元の外で切れば積む', () => {
  const run = (cutY) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    const axis = clAt(graph, V_CL, 2000);
    graph.addWall(axis, 200, true, clAt(graph, H_CL, 0), 0, clAt(graph, H_CL, 1500), 0, {}); // 壁は y 0..1500 だけ
    graph.addBeam(WOOD_MAT, 'WOOD-105x105', axis, true, clAt(graph, H_CL, 0), clAt(graph, H_CL, 3000),
      { role: 'primary', levelOffset: 2300, eccentricity: 100 }); // 芯 x=2100・幅 105・y 0..3000
    return memberHitsOf(probeMembers(cutAtY(graph, cutY), 2100).hits, 'memberCut');
  };
  assert.equal(run(500).length, 0, '切断位置 y=500 は壁の足元（0..1500）の中');
  assert.equal(run(2000).length, 1, '対照: y=2000 は壁の足元の外');
});

test('【失敗系・z のクランプ】天井裏の梁・床以下の梁は積まない。天井をまたぐ梁は天井では切らず（部屋帯は帯の天井断面で切る）、床をまたぐ梁は床で切る', () => {
  const zOf = (levelOffset) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    addBeamH(graph, 2000, 0, 4000, levelOffset);
    return memberHitsOf(probeMembers(cutAtY(graph, 1500), 2000).hits, 'memberFace').map(h => [h.z0, h.z1]);
  };
  assert.deepEqual(zOf(2300), [[2100, 2300]], '前提: 天井（2400）の下にある梁は切らない');
  assert.deepEqual(zOf(2800), [], '下端 2600 ≥ 天井 2400（天井裏）。切断の描画範囲（0..2400）に掛からないので帯にできず edgeDropped（加算で描く）');
  assert.deepEqual(zOf(2500), [[2300, 2500]], '天井 2400 をまたぐ梁は天井では切らない（B3-2。階段帯の天井裏は memberCeilZAt、部屋帯は帯の天井断面 clipBandsToVisible が切る）');
  assert.deepEqual(zOf(100), [[0, 100]], '床（0）をまたぐ梁（-100..100）は床で切る');
  assert.deepEqual(zOf(0), [], '天が床ちょうど（床の下の梁）は積まない');
  assert.deepEqual(zOf(-300), [], '床より下の梁');
});

test('【梁の断面は天井で切らない】memberCut: 天井裏の梁の断面も積む（現行の断面は天井裏でも描き emit が降格する）。床以下は切る', () => {
  const zOf = (levelOffset, over = {}) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    addBeamV(graph, 2000, 500, 2500, levelOffset);
    return memberHitsOf(probeMembers(cutAtY(graph, 1500, over), 2000).hits, 'memberCut').map(h => [h.z0, h.z1]);
  };
  const tall = { zRange: { loZ: 0, hiZ: 5400 } }; // 切断の描画 z 範囲が天井より上まで（階段帯）
  assert.deepEqual(zOf(2800, tall), [[2600, 2800]], '下端 2600 ≥ 天井 2400 でも積む（天井では切らない）');
  assert.deepEqual(zOf(100), [[0, 100]], '床（0）をまたぐ断面は床で切る');
  assert.deepEqual(zOf(0), [], '天が床ちょうどの断面は積まない');
  // 切断の描画 z 範囲（既定は 0..CH）に全く掛からない梁は帯にできない＝積まず edgeDropped（加算で描く）
  assert.deepEqual(zOf(2800), [], '範囲（0..2400）の上の梁は積まない');
});

test('【B3-1】z 範囲に掛からない梁は edgeDropped に入る（帯にできないので加算で描く）。掛かる梁は入らない', () => {
  const droppedCount = (levelOffset) => {
    const graph = makeGraph();
    makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
    addBeamV(graph, 2000, 500, 2500, levelOffset);
    const cut = cutAtY(graph, 1500);
    const near = nearMembersOf(cut);
    near.cutStateOf(near.beams[0].solid);
    return near.edgeDropped.size;
  };
  assert.equal(droppedCount(2800), 1, '天井より上（z 範囲の外）');
  assert.equal(droppedCount(-300), 1, '床より下（z 範囲の外）');
  assert.equal(droppedCount(2300), 0, '範囲の中');
});

test('【B3-1】探査の範囲の外で壁の半厚の許容の中の梁（面の端の壁芯に載る梁）は edgeDropped（列が無いので加算で描く）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  // 切断線は x 0..4000。梁は x=4100（幅 100: 4050..4150 は範囲の外・許容 57.5〔4057.5〕の中）
  addBeamV(graph, 4100, 500, 2500, 2300);
  const face = { axisCL: { effectiveValue: 0 }, faceValue: 57.5 };
  const cut = cutAtY(graph, 1500, { face });
  const near = nearMembersOf(cut);
  assert.equal(near.beams.length, 1, '許容の中なので候補に入る');
  assert.equal(near.edgeDropped.size, 1, '探査の範囲の外＝edgeDropped');
  // 許容の外（x=4300）は候補にも入らない
  const g2 = makeGraph();
  makeRectRoom(g2, 0, 0, 4000, 3000, 'LDK');
  addBeamV(g2, 4300, 500, 2500, 2300);
  assert.equal(nearMembersOf(cutAtY(g2, 1500, { face })).beams.length, 0);
});

test('【床の穴】自階が吹抜け（実床なし）の列: 梁は積むが床で下を切らない', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  room.setFeature(RoomFeature.VOID);
  addBeamH(graph, 2000, 0, 4000, 100); // 天 100・成 200 → z -100..100（床 0 をまたぐ）
  const cut = cutAtY(graph, 1500);
  assert.deepEqual(memberHitsOf(probeMembers(cut, 2000).hits, 'memberFace').map(h => [h.z0, h.z1]), [[-100, 100]],
    '穴では床で切らない（現行の床の遮蔽の floorlessRanges と同じ）');
});

test('【失敗系・床の無い列】自階に部屋の無い列（部屋の外）には積まない', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamH(graph, 2000, 0, 6000, 2300); // 部屋の外（x 4000..6000）まで続く梁
  const cut = cutAtY(graph, 1500, { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 6000 } });
  assert.equal(memberHitsOf(probeMembers(cut, 2000).hits, 'memberFace').length, 1, '前提: 部屋の中の列には積む');
  // （length で比べる: 失敗時に hits の deepEqual 差分が graph まで辿って数分かかるため）
  assert.equal(memberHitsOf(probeMembers(cut, 5000).hits, 'memberFace').length, 0, '部屋の外の列（実床なし）');
});

test('【選択・B3-1/B3-2】矩形室: 直交する梁の memberCut も、壁より手前の平行な梁の memberFace も帯になる（後ろの壁の種類 behind）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamV(graph, 2000, 500, 2500, 2300); // 直交（memberCut）z 2100..2300
  addBeamH(graph, 2000, 0, 4000, 1500); // 平行（memberFace・空中）z 1300..1500・切断線から 500（奥の壁は 3000）
  const cut = cutAtY(graph, 1500);
  const { hits, layerStack, unexploredBelowZ, bands } = probeMembers(cut, 2000);
  assert.equal(memberHitsOf(hits, 'memberCut').length + memberHitsOf(hits, 'memberFace').length, 2, '前提: 2 件積まれている');
  assert.deepEqual(bands.map(b => [b.kind, b.z0, b.z1]),
    [['wall', 0, 1300], ['member', 1300, 1500], ['wall', 1500, 2100], ['memberCut', 2100, 2300], ['wall', 2300, 2400]],
    '梁の高さだけ奥の壁に代わる');
  const mc = bands[3];
  assert.equal(mc.memberType, 'beam');
  assert.equal(mc.behind, 'wall', '梁が無かったら選ばれていた帯＝奥の壁');
  assert.ok(!mc.along);
  const mf = bands[1];
  assert.equal(mf.memberClass, 'airborne', '切断線から離れた梁＝空中');
  assert.equal(mf.behind, 'wall');
  assert.equal(mf.distMm, 450, '距離は手前の面までの奥行き nearMm（芯 500−半幅 50）');
  // 梁を外した候補で選べば奥の壁 1 枚（検出力: 帯が割れているのは memberCut・memberFace の効果）
  const without = hits.filter(h => h.kind !== 'memberCut' && h.kind !== 'memberFace');
  assert.deepEqual(visibleBandsOf(without, cut, { layerStack, unexploredBelowZ }).map(b => b.kind), ['wall']);
});

test('【選択・B3-1】壁の断面（cut）と同じ高さの列では壁の断面が勝つ（順位 cut → cutAlong → memberCut）。壁に重ならない高さの梁は memberCut', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  // 切断線 y=1500 を横切る壁（x=2000 の鉛直壁・y 1000..2000）と、同じ x に直交する梁（天 2300・成 200）
  const axis = clAt(graph, V_CL, 2000);
  graph.addWall(axis, 100, true, clAt(graph, H_CL, 1000), 0, clAt(graph, H_CL, 2000), 0, {});
  addBeamV(graph, 2000, 500, 2500, 2300);
  const { bands } = probeMembers(cutAtY(graph, 1500), 2000);
  assert.ok(bands.some(b => b.kind === 'cut'), '前提: 壁の断面の帯がある');
  assert.ok(!bands.some(b => b.kind === 'memberCut'), '壁の断面（全高）と重なる高さでは梁の断面は選ばれない');
});

test('【B3-1・QA】FL −50 の隣室の列でも、部屋帯（memberFromRoomSide）の梁の断面は自階 FL より下を描かない。階段帯は列の床で切る（対照）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const room2 = makeRectRoom(graph, 4000, 0, 8000, 3000, '隣室');
  room2.setFloorLevel(-50);
  addBeamV(graph, 6000, 500, 2500, 50); // 天 50・成 200 → z −150..50（隣室の列）
  const zOf = (over) => memberHitsOf(probeMembers(cutAtY(graph, 1500, { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 8000 }, ...over }), 6000).hits, 'memberCut')
    .map(h => [h.z0, h.z1]);
  assert.deepEqual(zOf({ memberFromRoomSide: true }), [[0, 50]], '部屋帯: 自階 FL（0）で切る');
  assert.deepEqual(zOf({}), [[-50, 50]], '対照: 指定が無ければ列の床（隣室 FL −50）で切る');
});

test('【B3-1・QA】奥の天井が深度上限内にある open の中を横切る梁の断面は、遠側の面の向こう（farVoid）の高さでは後ろがアキではない＝アキの標記を出さない', () => {
  // 部屋 C（y 8000〜）の天井だけ 2200（遠側の天井面 2200 が open 帯に付く）。切断線 y=7500 からは C まで 500。
  // 手前の壁（y=7800・x 0..1000）が「最も手前の面」の基準になり、遠側の面は深度上限内に入る
  const build = (levelOffset) => {
    const graph = openWithFarCeilFixture();
    graph.addWall(clAt(graph, H_CL, 7800), 100, false, clAt(graph, V_CL, 0), 0, clAt(graph, V_CL, 1000), 0, {});
    addBeamV(graph, 2000, 7000, 9000, levelOffset); // 直交する梁
    const cut = frontCut(graph, { line: { isVertical: false, axisValue: 7500, lo: 0, hi: 4000 }, bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 12000 } });
    return { cut, cols: buildColumns(cut, makeProbeContext(cut.layers)) };
  };
  const { cut, cols } = build(2350); // z 2150..2350（遠側の天井 2200 をまたぐ）
  const mc = cols.flatMap(c => c.bands).filter(b => b.kind === 'memberCut');
  assert.ok(mc.length > 0, '前提: 梁の断面の帯がある');
  assert.ok(mc.every(b => b.behind === 'farVoid'), `後ろは farVoid（実際 ${mc.map(b => b.behind)}）`);
  assert.equal(emitOpenGapMarks(cols, cut, { ceilZ: CH }).filter(p => p.type === 'text' && p.x >= 1950 && p.x <= 2050 && -p.y >= 2150 && -p.y <= 2350).length, 0, '梁の断面の矩形の中に「ア キ」を出さない');
  // 実データ型（ceiling-zone-far-test 1階 売場）: 梁の高さが遠側の天井（2200）の上だけ（z 2200..2400）でも、
  // 遠側の天井は梁の高さの外にあるが、梁が無かったときの帯の範囲で判定する＝後ろは farVoid（アキの標記なし）
  const above = build(2400).cols.flatMap(c => c.bands).filter(b => b.kind === 'memberCut');
  assert.ok(above.length > 0 && above.every(b => b.behind === 'farVoid'), `遠側の天井より上だけの梁の後ろも farVoid（実際 ${above.map(b => b.behind)}）`);
  // 対照: 梁の高さが遠側の天井より下だけなら後ろは open のまま
  const mc2 = build(2150).cols.flatMap(c => c.bands).filter(b => b.kind === 'memberCut');
  assert.ok(mc2.length > 0 && mc2.every(b => b.behind === 'open'), '対照: 遠側の天井より下の梁の後ろは open');
});

test('【選択・B3-1】別の候補の z の端（奥の壁の窓の下端 1900）で zBreaks が割っても、同じ梁の帯は 1 本に併合される', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  graph.addOpening(wall.axisCL, 1, false, x0, 2000, 900, OpeningCategory.WINDOW, 'casement', { sillHeight: 1900, height: 500 }); // 窓 z 1900..2400
  // 直交する梁（H600x200・天 2300・成 600 → z 1700..2300）。窓の下端 1900 が梁の高さの途中に入る
  graph.addBeam(STEEL_MAT, 'STEEL-H600x200', clAt(graph, V_CL, 2000), true, clAt(graph, H_CL, 500), clAt(graph, H_CL, 2500), { role: 'primary', levelOffset: 2300 });
  const bands = probeMembers(cutAtY(graph, 1500), 2000).bands;
  assert.deepEqual(bands.map(b => [b.kind, b.z0, b.z1, b.behind ?? null]), [['wall', 0, 1700, null], ['memberCut', 1700, 2300, 'wall'], ['wall', 2300, 2400, null]],
    '梁の帯は 1700..2300 の 1 本（1900 で割れない）');
});

test('【選択・B3-1】同じ梁が z で続く帯は 1 本に併合される（層の天井で zBreaks が割っても）。along は別の帯', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamV(graph, 2000, 500, 2500, 2300); // 直交 z 2100..2300
  addBeamH(graph, 1500, 0, 4000, 2300); // 切断線 y=1500 の帯の中を通る平行梁（along）z 2100..2300
  const cut = cutAtY(graph, 1500);
  const mcs = probeMembers(cut, 2000).bands.filter(b => b.kind === 'memberCut');
  // 直交の梁（x=2000）と平行の梁は同じ高さ・同じ列だが、どちらか 1 つが選ばれ、帯は 1 本（z が 2 区間に割れない）
  assert.equal(mcs.length, 1);
  assert.deepEqual([mcs[0].z0, mcs[0].z1], [2100, 2300]);
  const alongOnly = probeMembers(cut, 1000).bands.filter(b => b.kind === 'memberCut');
  assert.deepEqual(alongOnly.map(b => [!!b.along, b.z0, b.z1]), [[true, 2100, 2300]], '梁の列の外では along だけ');
});

test('【選択・B3-1】床構造・天井懐（slab）の中の梁は slab の帯を割らず members に添える', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamV(graph, 2000, 500, 2500, 2800); // 天 2800・成 200 → z 2600..2800（天井 2400 より上）
  const cut = cutAtY(graph, 1500, { zRange: { loZ: 0, hiZ: 5400 } });
  const bands = probeMembers(cut, 2000).bands;
  assert.ok(!bands.some(b => b.kind === 'memberCut'), 'slab の中は memberCut の帯にしない');
  const slab = bands.find(b => b.kind === 'slab');
  assert.ok(slab, '前提: 天井より上は slab');
  assert.deepEqual((slab.members ?? []).map(m => [m.kind, m.z0, m.z1, m.behind]), [['memberCut', 2600, 2800, 'slab']]);
});

test('【失敗系・B3-1】列の端を捨てた梁（edgeDropped）は memberCut を積まない。帯の外の梁・section なしの梁でも例外にならない', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamV(graph, 2000, 500, 2500, 2300);
  const cut = cutAtY(graph, 1500);
  const probeCtx = makeProbeContext(cut.layers);
  const near = nearMembersOf(cut);
  assert.equal(near.beams.length, 1);
  near.edgeDropped.add(near.beams[0].solid);
  const res = probeColumnHits(cut, 2000, probeCtx);
  assert.equal(memberHitsOf(res.hits, 'memberCut').length, 0, 'edgeDropped の梁は積まない（加算で描く）');
  assert.deepEqual(visibleBandsOf(res.hits, cut, res).map(b => b.kind), ['wall']);
  // 断面形状（カタログ）が無い梁: section null でも memberCut の帯になる（描画側は矩形に落とす）
  const g2 = makeGraph();
  makeRectRoom(g2, 0, 0, 4000, 3000, 'LDK');
  g2.addBeam(STEEL_MAT, 'NO-SUCH-SECTION', clAt(g2, V_CL, 2000), true, clAt(g2, H_CL, 500), clAt(g2, H_CL, 2500), { role: 'primary', levelOffset: 2300 });
  const bands2 = probeMembers(cutAtY(g2, 1500), 2000).bands.filter(b => b.kind === 'memberCut');
  assert.ok(bands2.length <= 1, '例外にならない');
  for (const b of bands2) assert.equal(b.section, null);
});

test('【選択・B3-1】梁の無い切断・memberLayers が空の切断は従来と同じ帯（部材 0 件→現行と同一）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamV(graph, 2000, 500, 2500, 2300);
  const withBeam = probeMembers(cutAtY(graph, 1500), 2000).bands.map(b => b.kind);
  assert.deepEqual(withBeam, ['wall', 'memberCut', 'wall']);
  const none = probeMembers(cutAtY(graph, 1500, { memberLayers: [] }), 2000).bands.map(b => b.kind);
  assert.deepEqual(none, ['wall'], '梁なし＝奥の壁 1 枚');
});

// 帯の z の境が増えると open 帯の far 付帯（区間の内部にある最も近い ceilFace）が区間ごとに変わり、併合されず帯が割れる。
// 柱の見え掛かり（memberFace。B3-3 まで選択に入らない）の z が帯の境にならないことを、その割れで検出する（部屋 B・C は壁なしで続き、C の天井だけ 2200）。
function openWithFarCeilFixture() {
  const g = makeGrid([0, 4000], [0, 4000, 8000, 12000]);
  g.interior([[0, 0]]);
  g.interior([[0, 1]]);
  const roomC = g.interior([[0, 2]]);
  roomC.setOverride('ceilingHeight', '2200');
  return g.graph;
}
// memberCut は B3-1 から帯になる（z の境が増える）ので、ここは選択に入らない memberFace だけを検証する。
test('【B3-2・遠側の天井】open の中の空中の梁（memberFace）の帯は、梁が無かったときの open 帯の範囲と遠側の天井（behindFar）を持つ。梁の外の高さの open 帯は梁が無いときと同じ', () => {
  const graph = openWithFarCeilFixture();
  addBeamH(graph, 5000, 0, 4000, 2350); // 梁 z 2150..2350（遠側の天井 2200 をまたぐ）
  const cut = frontCut(graph, { line: { isVertical: false, axisValue: 3950, lo: 0, hi: 4000 }, bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 12000 } });
  const { hits, layerStack, unexploredBelowZ } = probeMembers(cut, 2000);
  assert.equal(memberHitsOf(hits, 'memberFace').length, 1, '前提: 空中の梁が 1 件積まれている');
  const without = hits.filter(h => h.kind !== 'memberCut' && h.kind !== 'memberFace');
  const plain = visibleBandsOf(without, cut, { layerStack, unexploredBelowZ });
  const bands = visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
  const mf = bands.find(b => b.kind === 'member');
  assert.ok(mf, '梁の帯がある');
  assert.equal(mf.behind, 'open');
  const under = plain.find(b => b.kind === 'open' && mf.z0 >= b.z0 - 1e-6 && mf.z1 <= b.z1 + 1e-6);
  assert.ok(under?.farCeilZ === 2200, '前提: 梁が無いときの open 帯に遠側の天井 2200 が付く');
  assert.deepEqual([mf.behindFar.spanZ0, mf.behindFar.spanZ1, mf.behindFar.farCeilZ], [under.z0, under.z1, 2200],
    '梁が無いときの open 帯の範囲と遠側の天井を持つ（梁の高さだけで求めると範囲の外の遠側の天井を拾えない）');
  assert.deepEqual(bands.filter(b => b.kind !== 'member').map(b => [b.kind, b.z0, b.z1]), [['open', 0, mf.z0], ['open', mf.z1, 2400]],
    '梁の外の高さは梁が無いときの open 帯（0..2400）の残り');
  assert.deepEqual(plain.map(b => [b.kind, b.z0, b.z1]), [['open', 0, 2400]], '前提: 梁が無ければ open 1 枚');
});

test('【memberLayers】cut.memberLayers があればそれを、無ければ cut.layers から立体を作る。空配列でも memberLayers が優先する', () => {
  const roomGraph = makeGraph();
  makeRectRoom(roomGraph, 0, 0, 4000, 3000, 'LDK'); // 壁の層（梁なし）
  const beamGraph = makeGraph('p2');
  addBeamV(beamGraph, 2000, 500, 2500, 2300); // 梁だけの層
  const countCut = (over) => memberHitsOf(probeMembers(cutAtY(roomGraph, 1500, over), 2000).hits, 'memberCut').length;
  assert.equal(countCut({}), 0, 'layers に梁が無ければ積まない');
  assert.equal(countCut({ memberLayers: [{ graph: beamGraph, floorZMm: 0, role: 'self' }] }), 1, 'memberLayers の梁を積む');
  assert.equal(countCut({ memberLayers: [] }), 0, '空配列は「梁なし」（layers へ戻らない）');
  // memberLayers なしでは cut.layers の梁を使う
  const withBeam = makeGraph();
  makeRectRoom(withBeam, 0, 0, 4000, 3000, 'LDK');
  addBeamV(withBeam, 2000, 500, 2500, 2300);
  assert.equal(memberHitsOf(probeMembers(cutAtY(withBeam, 1500), 2000).hits, 'memberCut').length, 1, 'cut.layers フォールバック');
});

// ---- 梁の見え掛かり（memberFace。U1b B3-2）----
// 矩形室 0..4000×0..3000・切断線 y=1500（奥の壁 y=3000）に、平行な梁 y=2000（H200x100＝幅 100・成 200）。
const faceRoom = (levelOffset = 1500, over = {}) => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addBeamH(graph, 2000, 0, 4000, levelOffset);
  return { graph, cut: cutAtY(graph, 1500, over) };
};
const faceHitsOf = (cut) => memberHitsOf(probeMembers(cut, 2000).hits, 'memberFace');

test('【B3-2・選択】梁の見え掛かりは手前の面までの奥行き nearMm で壁と競う。梁が手前なら帯・同じ奥行きは壁が勝つ・梁が奥なら壁', () => {
  const { cut } = faceRoom();
  const { hits, layerStack, unexploredBelowZ } = probeMembers(cut, 2000);
  const wall = hits.find(h => h.kind === 'wallFace');
  const member = hits.find(h => h.kind === 'memberFace');
  assert.ok(Number.isFinite(wall.nearMm) && member.nearMm === 450, '前提: 壁は材の手前の縁・梁は 500−50 の nearMm を持つ');
  const kindsWith = (nearMm) => visibleBandsOf(hits.map(h => (h === member ? { ...h, nearMm } : h)), cut, { layerStack, unexploredBelowZ })
    .filter(b => b.z0 < 1400 && b.z1 > 1400).map(b => b.kind);
  assert.deepEqual(kindsWith(wall.nearMm - 10), ['member'], '梁のほうが手前＝梁の帯');
  assert.deepEqual(kindsWith(wall.nearMm), ['wall'], '同じ奥行きは壁が先');
  assert.deepEqual(kindsWith(wall.nearMm + 10), ['wall'], '梁のほうが奥＝壁');
});

test('【B3-2・選択】壁どうしの比較は従来どおり芯の距離 distMm（nearMm で逆転しない）。nearMm が非有限の比較は distMm→壁が先へ戻る', () => {
  const { cut } = faceRoom();
  const { hits, layerStack, unexploredBelowZ } = probeMembers(cut, 2000);
  const wall = hits.find(h => h.kind === 'wallFace');
  // 芯は遠いが材の手前の縁は近い壁を足しても、壁どうしは distMm の小さいほうが勝つ（出力を変えない）
  const farBySpine = { ...wall, wall: { ...wall.wall }, distMm: wall.distMm + 100, nearMm: wall.nearMm - 500 };
  const only = visibleBandsOf([wall, farBySpine], cut, { layerStack, unexploredBelowZ }).find(b => b.kind === 'wall');
  assert.equal(only.distMm, wall.distMm, '壁どうしは distMm（芯の距離）で選ぶ');
  // nearMm 非有限（梁・壁のどちらか）は nearMm で比べられない＝distMm→種類（壁が先）で決める
  const member = hits.find(h => h.kind === 'memberFace');
  const bandsAt = (m) => visibleBandsOf([wall, m], cut, { layerStack, unexploredBelowZ }).filter(b => b.z0 < 1400 && b.z1 > 1400).map(b => b.kind);
  assert.deepEqual(bandsAt({ ...member, nearMm: NaN, distMm: wall.distMm - 1 }), ['member'], 'nearMm 非有限は distMm（梁が手前）で決める');
  assert.deepEqual(bandsAt({ ...member, nearMm: NaN, distMm: wall.distMm }), ['wall'], '同点は壁が先');
});

test('【B3-2・memberClass】面の軸が梁の幅の帯の中なら facePlane・それ以外の視線側の平行な梁は airborne。切断線が幅の帯を通る梁は along（memberCut）', () => {
  const classOf = (over) => faceHitsOf(faceRoom(1500, over).cut).map(h => h.memberClass);
  assert.deepEqual(classOf({}), ['airborne'], '面なし＝空中');
  assert.deepEqual(classOf({ face: { axisCL: { effectiveValue: 2000 }, isVertical: false } }), ['facePlane'], '面の軸が梁の芯の上＝面の通り');
  assert.deepEqual(classOf({ face: { axisCL: { effectiveValue: 2400 }, isVertical: false } }), ['airborne'], '面の軸が梁の幅の外');
  // 切断線が梁の幅の帯を通る（y=2000 を切る）→ memberCut の along。memberFace にはならない
  const { graph } = faceRoom();
  const along = probeMembers(cutAtY(graph, 2000), 2000).hits;
  assert.equal(memberHitsOf(along, 'memberFace').length, 0);
  assert.ok(memberHitsOf(along, 'memberCut').some(h => h.along === true), 'along の memberCut');
  // 面の軸が梁の幅の帯の中なら、切断線が帯を通っても facePlane（along ではない）
  const both = probeMembers(cutAtY(graph, 2000, { face: { axisCL: { effectiveValue: 2000 }, isVertical: false } }), 2000).hits;
  assert.deepEqual(memberHitsOf(both, 'memberFace').map(h => h.memberClass), ['facePlane']);
});

test('【B3-2・フィルタ】候補段階の入口条件: 帯の部屋の外の空中の梁・天井裏（memberCeilZAt）・断面線より下に浮く面の通りの梁・面の範囲の外の梁は積まない', () => {
  // 帯の部屋の外（bandRoomBounds の y 範囲に芯 2000 が入らない）の空中の梁は積まない。面の通りの梁には掛けない
  assert.equal(faceHitsOf(faceRoom(1500, { bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 1800 } }).cut).length, 0, 'withinBandRoom（空中のみ）');
  assert.equal(faceHitsOf(faceRoom(1500, { bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 1800 },
    face: { axisCL: { effectiveValue: 2000 }, isVertical: false } }).cut).length, 1, '面の通りの梁には掛けない');
  // 階段帯: その位置の天井（階段室の裏面）より梁の下端が上＝天井裏
  assert.equal(faceHitsOf(faceRoom(1500, { memberCeilZAt: () => 1000 }).cut).length, 0, '下端 1300 ≥ 天井 1000');
  assert.equal(faceHitsOf(faceRoom(1500, { memberCeilZAt: () => 1400 }).cut).length, 1, '下端 1300 < 天井 1400 は積む');
  assert.equal(faceHitsOf(faceRoom(1500, { memberCeilZAt: () => null }).cut).length, 1, '天井が取れない点は見える側');
  // 面の通りの梁が断面線（階段帯）より梁成以上下に浮いている
  const floated = { face: { axisCL: { effectiveValue: 2000 }, isVertical: false }, memberFloorProfile: [[0, 3000], [4000, 3000]] };
  assert.equal(faceHitsOf(faceRoom(1500, floated).cut).length, 0, 'belowProfile（面の通りの梁）');
  assert.equal(faceHitsOf(faceRoom(1500, { memberFloorProfile: [[0, 3000], [4000, 3000]] }).cut).length, 1, '空中の梁には掛けない');
  // 梁のスパンが面（line.lo/hi。探査の延長 probeExtend を含まない）に掛からない: 延長の中にだけある梁は積まない
  assert.equal(faceHitsOf(faceRoom(1500, { line: { isVertical: false, axisValue: 1500, lo: 4100, hi: 5000 } }).cut).length, 0);
  const outside = makeGraph();
  makeRectRoom(outside, 0, 0, 4000, 3000, 'LDK');
  addBeamH(outside, 2000, 2000, 4000, 1500); // スパン 2000..4000
  const ext = { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 1000, probeExtendHiMm: 3000 } }; // 面は 0..1000・延長で 4000 まで探査
  assert.equal(memberHitsOf(probeMembers(frontCut(outside, ext), 2500).hits, 'memberFace').length, 0, '面の外（延長の中）だけの梁は積まない');
  const onFace = { line: { isVertical: false, axisValue: 1500, lo: 0, hi: 2500, probeExtendHiMm: 1500 } };
  assert.equal(memberHitsOf(probeMembers(frontCut(outside, onFace), 2500).hits, 'memberFace').length, 1, '面に掛かる梁は積む');
});

test('【B3-2・配線】buildCutContent 経由の gapPass: 階段帯（memberSplitsGaps:false）は梁の見え掛かりの帯に gapPass が付きアキのセルを割らない（1 つ）。部屋帯は割る（2 つ）', () => {
  const run = (opts) => {
    const graph = openWithFarCeilFixture();
    addBeamH(graph, 5000, 0, 4000, 1400); // 梁 z 1200..1400（遠側の天井 2200 より下＝後ろは open）
    const cut = frontCut(graph, { line: { isVertical: false, axisValue: 3950, lo: 0, hi: 4000 }, bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 12000 } });
    const r = buildCutContent(cut, makeProbeContext(cut.layers), opts);
    const members = r.columns.flatMap(c => c.bands).filter(b => b.kind === 'member');
    return { members, texts: r.gapMarks.filter(p => p.type === 'text').length };
  };
  const room = run({});
  assert.ok(room.members.length > 0 && room.members.every(b => b.behind === 'open' && b.gapPass === undefined), '前提: 後ろが open の梁の帯・gapPass なし');
  assert.equal(room.texts, 2, '部屋帯: 梁がアキのセルを割る');
  const stair = run({ memberSplitsGaps: false });
  assert.ok(stair.members.length > 0 && stair.members.every(b => b.gapPass === true), '階段帯: gapPass が付く');
  assert.equal(stair.texts, 1, '階段帯: アキのセルを割らない（R5）');
});

test('【B3-2・規則 A】切断線と梁の間に立つ全高の壁が覆う区間は member の候補にならない（壁が探査の候補に無くても効く）。壁の外の列・腰壁なら隠さない（失敗系）', () => {
  const build = (knee) => {
    const { graph, cut } = faceRoom(1500); // 梁 y=2000（切断線 y=1500 から 500・nearMm 450）
    const a = clAt(graph, H_CL, 1800), s = clAt(graph, V_CL, 0), e = clAt(graph, V_CL, 1000);
    graph.addWall(a, 0, false, s, 0, e, 0, {}); // 切断線と梁の間 y=1800・x 0..1000
    if (knee) graph.kneeDropWalls.set(`${a.id}:${s.id}:${e.id}`, { knee: { topHeight: 900 } });
    return cut;
  };
  const countAt = (cut, x) => memberHitsOf(probeMembers(cut, x).hits, 'memberFace').length;
  const full = build(false);
  assert.equal(countAt(full, 500), 0, '壁（x 0..1000）が覆う列には積まない');
  assert.equal(countAt(full, 2000), 1, '壁の外の列には積む');
  assert.equal(countAt(build(true), 500), 1, '腰壁は全高とみなさず隠さない');
});

test('【B3-2・フィルタ】床の無い区間（階段の穴。cut.memberFloorlessRanges）では床で梁を切らない。その外は床（0）で切る', () => {
  const zOf = (over) => faceHitsOf(faceRoom(100, over).cut).map(h => [h.z0, h.z1]); // 梁 z -100..100（床 0 をまたぐ）
  assert.deepEqual(zOf({}), [[0, 100]], '既定は床で切る');
  assert.deepEqual(zOf({ memberFloorlessRanges: [{ lo: 1500, hi: 2500 }] }), [[-100, 100]], '床なし区間（列 x=2000 を含む）は切らない');
  assert.deepEqual(zOf({ memberFloorlessRanges: [{ lo: 2500, hi: 3500 }] }), [[0, 100]], '床なし区間の外の列は床で切る');
});

test('【B3-2・加算で描く部材】切断の描画 z 範囲に掛からない空中の梁は帯にできず edgeDropped（droppedMemberKeysOf が拾う）。範囲内の梁は拾わない', () => {
  const dropped = (levelOffset) => {
    const { cut } = faceRoom(levelOffset);
    const near = nearMembersOf(cut);
    probeMembers(cut, 2000);
    return near.edgeDropped.size;
  };
  assert.equal(dropped(1500), 0, '範囲内の梁は帯が持つ');
  assert.equal(dropped(2800), 1, '天井（描画範囲の上）より上の梁は加算で描く');
  assert.equal(dropped(-300), 1, '床より下の梁は加算で描く');
});

test('【B3-2・slab】床構造・天井懐（slab）の中の梁の見え掛かりは slab の帯を割らず members の片（kind:member）になる。連続する片は 1 つに畳まれる', () => {
  const tall = { zRange: { loZ: 0, hiZ: 5400 } };
  const { cut } = faceRoom(2700, tall); // 梁 z 2500..2700（天井 2400 の上＝懐）
  const { bands } = probeMembers(cut, 2000);
  assert.ok(!bands.some(b => b.kind === 'member'), '帯としては割らない');
  const slab = bands.find(b => b.kind === 'slab' && (b.members ?? []).some(m => m.kind === 'member'));
  assert.ok(slab, 'slab の帯に片が添う');
  assert.equal(slab.members.filter(m => m.kind === 'member').length, 1, '同じ梁の片は z で続くなら 1 つ');
  assert.deepEqual([slab.members[0].z0, slab.members[0].z1], [2500, 2700]);
  assert.equal(slab.members[0].memberClass, 'airborne');
});

test('【B3-2・深度上限】梁の見え掛かりも壁と同じ上限: 手前の壁から上限以上奥の梁は帯にならずアキへ戻る（slab の中の片は落とす）', () => {
  // 部屋 B・C が壁なしで続く構成。切断線 y=7500 の手前の壁（y=7800・x 0..1000）が最も手前の面の基準。梁は C の奥 y=9000（nearMm 1450）
  const build = (levelOffset, over = {}) => {
    const graph = openWithFarCeilFixture();
    graph.addWall(clAt(graph, H_CL, 7800), 100, false, clAt(graph, V_CL, 0), 0, clAt(graph, V_CL, 1000), 0, {});
    addBeamH(graph, 9000, 0, 4000, levelOffset);
    const cut = frontCut(graph, { line: { isVertical: false, axisValue: 7500, lo: 0, hi: 4000 }, bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 12000 }, ...over });
    return buildColumns(cut, makeProbeContext(cut.layers)).flatMap(c => c.bands);
  };
  const far = build(1500);
  assert.ok(!far.some(b => b.kind === 'member'), '上限以上奥の梁は帯にならない');
  assert.ok(far.some(b => b.kind === 'open' && b.z0 <= 1300 && b.z1 >= 1500), '梁の高さはアキ（梁が無いときの帯）へ戻る');
  const slabFar = build(2500, { zRange: { loZ: 0, hiZ: 5400 } });
  assert.ok(!slabFar.some(b => (b.members ?? []).some(m => m.kind === 'member')), 'slab の中の片も落とす');
  // 対照: 手前（y=7800 のすぐ奥 7900）の梁は帯になる
  const near = (() => {
    const graph = openWithFarCeilFixture();
    graph.addWall(clAt(graph, H_CL, 7800), 100, false, clAt(graph, V_CL, 0), 0, clAt(graph, V_CL, 1000), 0, {});
    addBeamH(graph, 7900, 0, 4000, 1500);
    const cut = frontCut(graph, { line: { isVertical: false, axisValue: 7500, lo: 0, hi: 4000 }, bandRoomBounds: { x1: 0, x2: 4000, y1: 0, y2: 12000 } });
    return buildColumns(cut, makeProbeContext(cut.layers)).flatMap(c => c.bands);
  })();
  assert.ok(near.some(b => b.kind === 'member'), '対照: 上限内の梁は帯になる');
});
