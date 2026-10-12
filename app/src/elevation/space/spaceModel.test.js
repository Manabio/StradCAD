// space/spaceModel.js（展開図一般化Phase 1）の単体テスト。
// フィクスチャ方針は sectionProbe.test.js と同じ実core.js（Plane/PlanGraph）+
// finish/wallGeneration.js（壁生成）を踏襲する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { buildSpaceIndex } from './spaceModel.js';
import { makeProbeContext } from '../section/sectionProbe.js';
import { PROBE_EPS_MM } from '../elevationStyle.js';
import { worldToCell, CEILING_CELL_GRID } from '../../finish/gridCells.js';
import { makeGrid } from '../../plan/planTestFixtures.js';
import { createZone } from '../../ceiling/ceilingZones.js';
import { setRoomCeilingShape } from '../../ceiling/roomCeilingShape.js';

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

// ---- 基本: 室内の1点は所有Room・floorZ(=layer基準)・ceilZ(=floorZ+CH)を返す ----
test('【Phase1】buildSpaceIndex.cellAt: 室内の点は所有Room・floorZ・ceilZを返す', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const cell = index.cellAt(layer, 2000, 1500);
  assert.ok(cell, 'セルが見つかるはず');
  assert.equal(cell.room, room);
  assert.equal(cell.floorZ, 0, '帯のfloorOffset未指定＝layer.floorZMmそのまま');
  assert.equal(cell.ceilZ, CH, '天井=床+CH（既定値）のはず');
  // SpaceCellはlayerを持たない（QA指摘: layerを抱えるとassert失敗時のnode:assert差分表示が
  // グラフ全体を走査し10秒以上かかる。呼び出し側は自分が渡したlayerを知っているので不要）。
  assert.equal('layer' in cell, false, 'SpaceCellはlayerフィールドを持たないはず');
});

// ---- 失敗系: 室外（格子の外）はnull ----
test('【失敗系・Phase1】buildSpaceIndex.cellAt: 格子の外（セルが1つも無い位置）はnullを返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const cell = index.cellAt(layer, -50000, -50000);
  assert.equal(cell, null);
});

// ---- 失敗系: layerにgraphが無い ----
// 索引の構築時に渡すlayers配列自体にgraph:nullを含めると（cellToRoomForの事前ウォームアップが
// buildCellToRoomへ丸投げする既存の仕様。makeProbeContext移設前から同じ）例外になるため、
// ここでは「索引の構築には含めなかった、graphを持たないlayerオブジェクトでcellAtを呼ぶ」
// ケース（cellAt自身の入力ガード）を確認する。
test('【失敗系・Phase1】buildSpaceIndex.cellAt: graphの無いlayerオブジェクトで呼んでも例外を投げずnullを返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const index = buildSpaceIndex([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(index.cellAt({ graph: null, floorZMm: 0 }, 2000, 1500), null);
  assert.equal(index.cellAt(undefined, 2000, 1500), null);
});

// ---- 失敗系: 不正座標（NaN）でも例外なしでnull ----
test('【失敗系・Phase1】buildSpaceIndex.cellAt: 座標がNaNでも例外を投げずnullを返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  assert.equal(index.cellAt(layer, NaN, NaN), null);
});

// ---- 実効FL≠0（bandFloorOffsetMmが効く。実機「11'」相当）: floorZが従来のfloorZOfと一致 ----
// sectionProbe.test.jsのmakeFloorBasisFixtureと同じ構成（帯の部屋=実効FL100・隣室=1FL=実効FL0）。
function makeFloorBasisFixture() {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, '11d');
  room.setFloorLevel(100);
  const other = makeRectRoom(graph, 0, 3000, 4000, 6000, '11');
  return { graph, room, other };
}

// makeProbeContext.floorZOfは移設後spaceIndex.floorZForの薄いラッパそのもの（同一関数の
// 参照）なので、この突き合わせは自己参照でしかない——主張の根拠はリテラル期待値(0/-100)側で、
// probeCtx.floorZOfとの一致はワイヤリング（ラッパ経路の疎通）確認として添える。
test('【実効FL≠0・ラッパ経路の疎通確認】buildSpaceIndex.cellAt: floorZはリテラル期待値どおり（0/-100）で、makeProbeContext.floorZOf経由でも同じ値が引ける', () => {
  const { graph, room, other } = makeFloorBasisFixture();
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer], { floorOffsetMm: 100 }); // = bandFloorOffsetMm(room, graph)
  const probeCtx = makeProbeContext([layer], { floorOffsetMm: 100 });

  const ownCell = index.cellAt(layer, 2000, 1500); // room自身の内側
  assert.equal(ownCell.room, room);
  assert.equal(ownCell.floorZ, 0, '帯の部屋自身の床はz=0（帯のz原点）のはず');
  assert.equal(probeCtx.floorZOf(room, layer), 0, 'makeProbeContext経由でも同じ値のはず（疎通確認）');

  const otherCell = index.cellAt(layer, 2000, 4500); // 隣室(other)の内側
  assert.equal(otherCell.room, other);
  assert.equal(otherCell.floorZ, -100,
    '1FL(実効FL=0)の隣室の床は帯の部屋から見て100下＝z=-100のはず');
  assert.equal(probeCtx.floorZOf(other, layer), -100, 'makeProbeContext経由でも同じ値のはず（疎通確認）');
});

// ---- probeOwnerRoomの1点クエリ（ownerRoomAtOffset）と同じ入力でcellAtが同じRoomを返す ----
// probeOwnerRoomは「cut.lineからviewSign方向へPROBE_EPS_MMだけ逃げた点」を1点プローブする
// （sectionProbe.js:198-211）。cellAtはその一般形——2室が隣接するcut.line上で、sign(viewSign)の
// 向きを反転させると所有Roomが切り替わることを確認する（同じ点・逃げ方向でRoomが変わるのを
// 見ることで、offsetの向きが実際に効いている＝同じ入力には同じRoomを返す契約の確認になる）。
test('【probeOwnerRoom一般形】buildSpaceIndex.cellAt: cut.lineから±PROBE_EPS_MM逃げた点で隣接する2室を正しく引き分ける', () => {
  const graph = makeGraph();
  const roomA = makeRectRoom(graph, 0, 0, 4000, 3000, 'A'); // x:[0,4000]
  const roomB = makeRectRoom(graph, 4000, 0, 8000, 3000, 'B'); // x:[4000,8000]
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  // cut.line: X=4000で垂直に切る（A/Bの境界の壁の中心線）。viewSign=1（+X方向=B側を見る）。
  const axisValue = 4000;
  const worldMid = 1500; // Y方向の列位置（両室ともY:[0,3000]に収まる）

  // probeOwnerRoom(cut, worldMid, layer, probeCtx, sign) = ownerRoomAtOffset(..., sign*PROBE_EPS_MM)
  // と同じ式: px = axisValue + offset, py = worldMid（cut.line.isVertical=trueのケース）。
  const cellPlus = index.cellAt(layer, axisValue + 1 * PROBE_EPS_MM, worldMid);
  const cellMinus = index.cellAt(layer, axisValue + -1 * PROBE_EPS_MM, worldMid);
  assert.equal(cellPlus.room, roomB, '+PROBE_EPS_MM側（視線方向=B側）はroomBのはず');
  assert.equal(cellMinus.room, roomA, '-PROBE_EPS_MM側（手前=A側）はroomAのはず');
});

// ---- 明示CH指定: ceilZは床+指定CH（既定は+2400、明示2700は+2700） ----
// setOverride('ceilingHeight', ...)の書き方はelevationBand.test.jsの既存CH指定フィクスチャに
// 合わせる（roomCeilingHeightが読む単一情報源＝Room.getFinishInfo().ceilingHeight）。
test('【明示CH指定】buildSpaceIndex.cellAt: 明示CH指定の部屋のceilZは床+指定CH（既定の部屋は+2400、明示2700の部屋は+2700）', () => {
  const graph = makeGraph();
  const defaultRoom = makeRectRoom(graph, 0, 0, 4000, 3000, 'default'); // CH明示指定なし
  const customRoom = makeRectRoom(graph, 0, 3000, 4000, 6000, 'custom');
  customRoom.setOverride('ceilingHeight', '2700');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const defaultCell = index.cellAt(layer, 2000, 1500);
  assert.equal(defaultCell.room, defaultRoom);
  assert.equal(defaultCell.ceilZ, defaultCell.floorZ + CH, `既定は床+${CH}のはず`);

  const customCell = index.cellAt(layer, 2000, 4500);
  assert.equal(customCell.room, customRoom);
  assert.equal(customCell.ceilZ, customCell.floorZ + 2700, '明示CH指定(2700)は床+2700のはず');
});

// ================================================================
// componentOf/componentAt（Phase 2。設計 §5.3(a)）
// ================================================================

// 隣接する2部屋（Y=3000で共有境界）を持つグラフ。名前付き（computeNamedBoundaryEdgesの対象）。
function makeAdjacentRoomsGraph(nameA = 'A', nameB = 'B') {
  const graph = makeGraph();
  const roomA = makeRectRoom(graph, 0, 0, 4000, 3000, nameA);
  const roomB = makeRectRoom(graph, 0, 3000, 4000, 6000, nameB);
  return { graph, roomA, roomB };
}

function sharedWallOf(graph, axisValue) {
  return graph.walls.find(w => !w.isVertical && Math.abs(w.axisCL.effectiveValue - axisValue) < 1);
}

test('【Phase2】componentOf: 全高の壁で仕切られた2室は別成分', () => {
  const { graph, roomA, roomB } = makeAdjacentRoomsGraph();
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const idA = index.componentOf(layer, roomA);
  const idB = index.componentOf(layer, roomB);
  assert.ok(idA != null && idB != null, '両方とも成分idを持つはず');
  assert.notEqual(idA, idB, '全高の壁で仕切られた2室は別成分のはず');
});

test('【Phase2】componentOf: 腰壁で仕切られた2室は同成分（全高でないため連結を切らない）', () => {
  const { graph, roomA, roomB } = makeAdjacentRoomsGraph();
  const wall = sharedWallOf(graph, 3000);
  assert.ok(wall, '共有壁があるはず');
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), { knee: { topHeight: 900 } });
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  assert.equal(index.componentOf(layer, roomA), index.componentOf(layer, roomB),
    '腰壁指定は全高でないため同じ成分のはず');
});

test('【Phase2】componentOf: 垂れ壁で仕切られた2室も同成分', () => {
  const { graph, roomA, roomB } = makeAdjacentRoomsGraph();
  const wall = sharedWallOf(graph, 3000);
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), { drop: { bottomHeight: 700 } });
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  assert.equal(index.componentOf(layer, roomA), index.componentOf(layer, roomB));
});

test('【Phase2】componentOf: 上の層のセルがVOIDなら階またぎで下のセルと同成分', () => {
  const lowerGraph = makeGraph();
  const lowerRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '階段室');
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperVoid = makeRectRoom(upperGraph, 0, 0, 4000, 3000, '吹抜け');
  upperVoid.setFeature(RoomFeature.VOID);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.equal(index.componentOf(lowerLayer, lowerRoom), index.componentOf(upperLayer, upperVoid),
    '上階が吹抜け(VOID)でfootprintが重なれば階またぎで同じ成分のはず');
});

test('【Phase2】componentOf: 上の層が実Room（VOIDでない）なら階またぎで連結しない', () => {
  const lowerGraph = makeGraph();
  const lowerRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '階段室');
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperRoom = makeRectRoom(upperGraph, 0, 0, 4000, 3000, '洋室'); // feature未設定=実Room

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.notEqual(index.componentOf(lowerLayer, lowerRoom), index.componentOf(upperLayer, upperRoom),
    '上階が実Roomなら階またぎで連結しないはず');
});

// ---- QA指摘A: 階またぎ連結は「bboxが重なる下階Room全部」ではなく、VOIDなら親部屋1室・
// STAIR_VOIDなら階段室1室、という単一マッチにだけ絞る ----
test('【QA指摘A・Phase2】componentOf: 上階VOIDのbboxが下階2室（直下の親部屋＋隣の閉じた部屋）にまたがっても、親部屋だけが連結し閉じた部屋は別成分のまま', () => {
  const lowerGraph = makeGraph();
  // 親部屋(x:0-4000)と、全高の壁1枚で仕切られた隣の閉室(x:4000-8000)。どちらもfeature=null。
  const parentRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '親部屋');
  const closedRoom = makeRectRoom(lowerGraph, 4000, 0, 8000, 3000, '閉室');
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  // 上階のVOIDは意図的に下階2室のbbox全体(x:0-8000)を覆う——13.stq「13」混入の再現条件
  // （bboxは非矩形の実形状より広いことがある）。
  const upperVoid = makeRectRoom(upperGraph, 0, 0, 8000, 3000, '吹抜け');
  upperVoid.setFeature(RoomFeature.VOID);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.notEqual(index.componentOf(lowerLayer, parentRoom), index.componentOf(lowerLayer, closedRoom),
    '前提: 親部屋と閉室は全高の壁で仕切られ同一層内では別成分のはず');
  assert.equal(index.componentOf(lowerLayer, parentRoom), index.componentOf(upperLayer, upperVoid),
    '親部屋(1室)だけがVOIDと連結するはず');
  assert.notEqual(index.componentOf(lowerLayer, closedRoom), index.componentOf(upperLayer, upperVoid),
    '隣の閉じた部屋はbboxが重なるだけでは連結しないはず（単一マッチ規約）');
});

test('【QA指摘A・Phase2】componentOf: STAIR_VOIDは直下の階段室(feature STAIR)とだけ連結し、隣の通常室とは連結しない', () => {
  const lowerGraph = makeGraph();
  // QA指摘①: normalRoomを**先に**生成する（graph.rooms/graphListの走査は挿入順）——
  // stairRoomを先に生成すると、述語を`r=>true`へ緩めても「先勝ち」のfindSingleOverlappingRoomが
  // 偶然stairRoomを返してしまい、述語（feature===STAIR）がテストで固定されない
  // （QA実測: 述語をr=>trueに緩めても緑のまま）。normalRoomを先にすれば、述語が正しく
  // feature===STAIRだけを通すことを確認できる（緩めるとnormalRoomが先勝ちしてしまい赤化する）。
  const normalRoom = makeRectRoom(lowerGraph, 4000, 0, 8000, 3000, '洋室'); // feature=null・全高壁で仕切り
  const stairRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '階段');
  stairRoom.setFeature(RoomFeature.STAIR);
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperStairVoid = makeRectRoom(upperGraph, 0, 0, 8000, 3000, '階段吹抜け'); // bboxは両室にまたがる
  upperStairVoid.setFeature(RoomFeature.STAIR_VOID);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.equal(index.componentOf(lowerLayer, stairRoom), index.componentOf(upperLayer, upperStairVoid),
    'STAIR_VOIDは階段室と連結するはず');
  assert.notEqual(index.componentOf(lowerLayer, normalRoom), index.componentOf(upperLayer, upperStairVoid),
    'STAIR_VOIDは隣の通常室とは連結しないはず（階段室以外は対象外）');
});

// ---- 昇降機（実装指示書ステップ1・2026-09-28）: 上層の昇降路は直下層の昇降路とだけ連結する ----
test('【Phase2】componentOf: 上層の昇降路は直下層の昇降路と階またぎで同成分（昇降路は全階同位置で連続する）', () => {
  const lowerGraph = makeGraph();
  const lowerEv = makeRectRoom(lowerGraph, 0, 0, 2000, 2000, 'EV');
  lowerEv.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperEv = makeRectRoom(upperGraph, 0, 0, 2000, 2000, 'EV');
  upperEv.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.equal(index.componentOf(lowerLayer, lowerEv), index.componentOf(upperLayer, upperEv),
    '上層の昇降路と直下層の昇降路はfootprintが重なれば階またぎで同じ成分のはず');
});

test('【失敗系・Phase2】componentOf: 上層の昇降路の下が通常部屋（feature=null）なら階またぎで連結しない（VOIDと異なりfeature==nullへフォールバックしない）', () => {
  const lowerGraph = makeGraph();
  const lowerRoom = makeRectRoom(lowerGraph, 0, 0, 2000, 2000, '洋室'); // feature未設定=実Room
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperEv = makeRectRoom(upperGraph, 0, 0, 2000, 2000, 'EV');
  upperEv.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.notEqual(index.componentOf(lowerLayer, lowerRoom), index.componentOf(upperLayer, upperEv),
    '上層の昇降路の下が通常部屋なら連結しないはず（昇降機はVOIDと異なりfeature==nullへフォールバックしない）');
});

test('【失敗系】componentOf: 上層の昇降路の下がVOID（同じfootprint）なら階またぎで連結しない（feature完全一致のみ連結——昇降機とVOIDは別feature）', () => {
  const lowerGraph = makeGraph();
  const lowerVoid = makeRectRoom(lowerGraph, 0, 0, 2000, 2000, '吹抜け');
  lowerVoid.setFeature(RoomFeature.VOID);
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperEv = makeRectRoom(upperGraph, 0, 0, 2000, 2000, 'EV');
  upperEv.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.notEqual(index.componentOf(lowerLayer, lowerVoid), index.componentOf(upperLayer, upperEv),
    '上層の昇降路の下がVOIDなら連結しないはず（feature完全一致のみ連結——昇降機はVOIDへフォールバックしない）');
});


// ---- ユーザー裁定: VOIDは「重なる吹抜けの最下階の親部屋1室」とだけ連結する（複数階の吹抜けは連鎖） ----
function makeThreeLevelVoidChainGraphs() {
  const l1Graph = makeGraph();
  const room1F = makeRectRoom(l1Graph, 0, 0, 4000, 3000, '1F部屋');
  const l2Graph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const void2F = makeRectRoom(l2Graph, 0, 0, 4000, 3000, '2F吹抜け');
  void2F.setFeature(RoomFeature.VOID);
  const l3Graph = new PlanGraph(new Plane('p3', 5800, '3階', 1, 1));
  const void3F = makeRectRoom(l3Graph, 0, 0, 4000, 3000, '3F吹抜け');
  void3F.setFeature(RoomFeature.VOID);
  return {
    layer1: { graph: l1Graph, floorZMm: 0, role: 'self' }, room1F,
    layer2: { graph: l2Graph, floorZMm: 2900, role: 'above' }, void2F,
    layer3: { graph: l3Graph, floorZMm: 5800, role: 'above' }, void3F,
  };
}

test('【ユーザー裁定・VOID連鎖】componentOf: 3階VOID→2階VOID→1階部屋が連鎖して同一成分になる', () => {
  const { layer1, room1F, layer2, void2F, layer3, void3F } = makeThreeLevelVoidChainGraphs();
  const index = buildSpaceIndex([layer1, layer2, layer3]);

  const id1 = index.componentOf(layer1, room1F);
  const id2 = index.componentOf(layer2, void2F);
  const id3 = index.componentOf(layer3, void3F);
  assert.ok(id1 != null && id2 != null && id3 != null, '3室とも成分idを持つはず');
  assert.equal(id1, id2, '1階部屋と2階VOIDは連結するはず');
  assert.equal(id2, id3, '2階VOIDと3階VOIDは連結するはず（連鎖）');
  assert.equal(id1, id3, '1階部屋と3階VOIDは連鎖の結果として同一成分のはず');
});

test('【ユーザー裁定・VOID連鎖】componentOf: 直下に親部屋しかない場合は従来どおり1段だけ連結する', () => {
  const lowerGraph = makeGraph();
  const lowerRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '1F部屋');
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperVoid = makeRectRoom(upperGraph, 0, 0, 4000, 3000, '2F吹抜け');
  upperVoid.setFeature(RoomFeature.VOID);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.equal(index.componentOf(lowerLayer, lowerRoom), index.componentOf(upperLayer, upperVoid),
    '直下が親部屋のみ（VOIDなし）なら従来どおり親部屋と連結するはず');
});

test('【ユーザー裁定・VOID連鎖】componentOf: 直下にVOIDと通常室の両方が重なる配置ではVOID側を優先して連鎖する', () => {
  const lowerGraph = makeGraph();
  // 親部屋(x:0-4000)とVOID(x:4000-8000)が並んで直下に存在し、どちらも上階VOIDのbboxに重なる。
  // QA指摘①と同じ理由で、先勝ちだけでVOID優先と誤認しないよう親部屋を**先に**生成する。
  const parentRoom = makeRectRoom(lowerGraph, 0, 0, 4000, 3000, '親部屋');
  const lowerVoid = makeRectRoom(lowerGraph, 4000, 0, 8000, 3000, '1F吹抜け');
  lowerVoid.setFeature(RoomFeature.VOID);
  const upperGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const upperVoid = makeRectRoom(upperGraph, 0, 0, 8000, 3000, '2F吹抜け'); // bboxは両方にまたがる
  upperVoid.setFeature(RoomFeature.VOID);

  const lowerLayer = { graph: lowerGraph, floorZMm: 0, role: 'self' };
  const upperLayer = { graph: upperGraph, floorZMm: 2900, role: 'above' };
  const index = buildSpaceIndex([lowerLayer, upperLayer]);

  assert.equal(index.componentOf(upperLayer, upperVoid), index.componentOf(lowerLayer, lowerVoid),
    '直下のVOIDと連結する（連鎖）はず');
  assert.notEqual(index.componentOf(upperLayer, upperVoid), index.componentOf(lowerLayer, parentRoom),
    '親部屋とは直接連結しないはず（直下にVOIDがある間は親部屋を見ない。連結は1F吹抜け経由の別件）');
});

// ---- QA指摘B: 遮断条件はmasterTypeに依存しない（STEP判定でも全高の壁があれば遮断） ----
test('【QA指摘B・Phase2】componentOf: 床レベル差でSTEP判定される境界でも、全高の壁が実在すれば別成分', () => {
  const graph = makeGraph();
  const roomA = makeRectRoom(graph, 0, 0, 4000, 3000, 'A');
  const roomB = makeRectRoom(graph, 0, 3000, 4000, 6000, 'B');
  roomB.setFloorLevel(100); // 床レベル差 → selectBoundaryMasterはSTEPを返す（壁の有無を問わず）
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  assert.notEqual(index.componentOf(layer, roomA), index.componentOf(layer, roomB),
    'STEP判定でも境界に全高の室内壁が実在するため別成分のはず（masterTypeに依らない遮断）');
});

// ---- 失敗系: roomが層に無い ----
test('【失敗系・Phase2】componentOf: roomがnullならnullを返す', () => {
  const { graph, roomA } = makeAdjacentRoomsGraph();
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);
  assert.equal(index.componentOf(layer, null), null);
  assert.ok(index.componentOf(layer, roomA) != null, '対照: 実在のroomはidを持つ');
});

test('【失敗系・Phase2】componentOf: buildSpaceIndexへ渡さなかった層のroomはnullを返す', () => {
  const { graph: g1 } = makeAdjacentRoomsGraph('A1', 'B1');
  const { graph: g2, roomA: foreignRoom } = makeAdjacentRoomsGraph('A2', 'B2'); // 別グラフ・別索引
  const layer1 = { graph: g1, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer1]); // g2は渡していない
  void g2;

  assert.equal(index.componentOf(layer1, foreignRoom), null,
    '索引の構築に含まれないRoomはnullのはず');
});

test('【失敗系・Phase2】componentAt: 格子の外（セルなし）はnullを返す', () => {
  const { graph } = makeAdjacentRoomsGraph();
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);
  assert.equal(index.componentAt(layer, -50000, -50000), null);
});

// ---- 変異ガード用の土台: floorOffsetMm未指定なら従来どおり階のdatum基準のまま ----
test('【不変ゲート】buildSpaceIndex.cellAt: floorOffsetMm未指定なら従来どおり階のdatum基準のまま', () => {
  const { graph, room, other } = makeFloorBasisFixture();
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]); // opts省略＝floorOffsetMm=0
  assert.equal(index.cellAt(layer, 2000, 1500).floorZ, 100, '未指定＝従来の値（datum基準）のはず');
  assert.equal(index.cellAt(layer, 2000, 4500).floorZ, 0);
  assert.equal(index.floorZFor(room, layer), 100);
  assert.equal(index.floorZFor(other, layer), 0);
  assert.equal(index.floorZFor(null, layer), 0);
});

// ================================================================
// cellsAlong（Phase 3。設計§5.3(a)）
// ================================================================

// cellsAlong用の最小cut（line.isVertical=false＝depth軸はY、worldMidはX）。
function faceCut(axisValue, viewSign = 1) {
  return { line: { isVertical: false, axisValue }, viewSign };
}

test('【Phase3】cellsAlong: 1室のみの列では、その室1件だけを深さ0で返す', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const segs = index.cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].room, room);
  assert.equal(segs[0].depthMm, 0, '切断面直後のセルは深さ0のはず');
  assert.equal(segs[0].floorZ, 0);
  assert.equal(segs[0].ceilZ, CH);
});

test('【Phase3】cellsAlong: 2室が並ぶ列では、部屋が変わる境界で区切られた2件を近い順に返す', () => {
  const { graph, roomA, roomB } = makeAdjacentRoomsGraph(); // A: y[0,3000] / B: y[3000,6000]
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const segs = index.cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].room, roomA);
  assert.equal(segs[0].depthMm, 0);
  assert.equal(segs[1].room, roomB);
  assert.equal(segs[1].depthMm, 3000, '2番目の部屋に入る深さ=A-B境界(y=3000)のはず');
  assert.ok(segs[0].depthMm < segs[1].depthMm, '近い順（深度昇順）のはず');
});

// ---- QA指摘①: 「room変化点で区切る」契約は、同一室が視線方向に複数の格子セルへ
// またがる構成でこそ効く（1セル=1室の単純な矩形室だけでは畳み込みの有無が区別できない）。
// 部屋A(y0..4000)の内部に区切りCL(y=2000)を追加し、Aが物理的に2セルへ分かれることを
// worldToCellのキーで確認したうえで、cellsAlongが「A@0, B@4000」の2件（3件ではない）に
// 畳み込むことを固定する。
test('【QA指摘①・Phase3】cellsAlong: 同一室が視線方向に2セルへまたがっても、室が変わる境界だけで区切られた2件になる（畳み込み契約の固定）', () => {
  const graph = makeGraph();
  const roomA = makeRectRoom(graph, 0, 0, 4000, 4000, 'A');
  const roomB = makeRectRoom(graph, 0, 4000, 4000, 8000, 'B');
  // Aの内部だけを分割する区切りCL（部屋境界ではない・単なる格子の刻み）。
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  // 前提: Aの中がy=2000で物理的に2セルへ分かれていること（同室・別セルキー）。
  const cellNear = worldToCell(2000, 1000, graph);
  const cellFar = worldToCell(2000, 3000, graph);
  assert.notEqual(cellNear?.key, cellFar?.key, '前提: Aの内部はy=2000で物理的に2セルへ分かれるはず');

  const segs = index.cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs.length, 2, '同一室(A)の2セルは1件へ畳み込まれ、室が変わるB境界だけで区切られるはず');
  assert.equal(segs[0].room, roomA); assert.equal(segs[0].depthMm, 0);
  assert.equal(segs[1].room, roomB); assert.equal(segs[1].depthMm, 4000);
});

// ---- 回帰ガード（実機QA F4相当）: 視線の先の無関係な部屋のfinish情報が壊れていても、
// 手前の正常な部屋の探査自体は落ちない（ElevationModeState.test.jsの「1部屋の帯構築が失敗
// しても他の部屋の帯は残る」を壊す実装バグを実際に踏んだ。cellsAlongは自室と無関係な、
// 視線の先の部屋のroom.getFinishInfo()まで呼ぶため、素朴な実装だと例外がそのまま伝播していた）。
// QA指摘③是正: 例外が起きた部屋の区間そのものは（床＝floorZは解決できているため）積む。
// ceilZだけnullに落とす——区間ごと消すより「どこで何を諦めたか」の情報の欠落が小さい。----
test('【回帰ガード・Phase3】cellsAlong: 視線の先の部屋のgetFinishInfoが例外を投げても、例外を投げず手前の部屋の区間は返す（先の部屋はceilZ:nullで縮退）', () => {
  const { graph, roomA, roomB } = makeAdjacentRoomsGraph();
  roomB.getFinishInfo = () => { throw new Error('boom'); };
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const segs = index.cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs.length, 2, '例外を投げず、壊れている部屋(B)の区間も（縮退した形で）残るはず');
  assert.equal(segs[0].room, roomA, '手前の正常な部屋(A)の区間は返るはず');
  assert.equal(segs[0].floorZ, 0);
  assert.equal(segs[0].ceilZ, CH);
  assert.equal(segs[1].room, roomB);
  assert.equal(segs[1].floorZ, 0, '床(floorZFor)は例外を投げないため解決できているはず（floor levelは未指定=0）');
  assert.equal(segs[1].ceilZ, null, '天井(chFor)だけgetFinishInfo異常でnullに縮退するはず');
});

test('【回帰ガード・Phase3】cellsAlong: toDepthMm=Infinity（未上限の探査。probeColumnHitsの実呼び出し）でも正しくセルを辿る', () => {
  // Number.isFinite(Infinity)===falseのため、素朴な「全て有限数か」ガードだとInfinityを
  // 非数と誤判定して即座に空配列を返してしまう（実際に踏んだ実装バグ）。toDepthMm=Infinityは
  // section/sectionHits.jsのaddHorizontalFaceHitsが実際に渡す値なので、退行すると本番のhitsに
  // floorFace/ceilFaceが一切載らなくなる。
  const { graph, roomA, roomB } = makeAdjacentRoomsGraph();
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const segs = index.cellsAlong(layer, faceCut(0), 2000, 0, Infinity);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].room, roomA);
  assert.equal(segs[1].room, roomB);
});

test('【失敗系・Phase3】cellsAlong: 範囲外（格子の外）から始めると空配列を返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  const segs = index.cellsAlong(layer, faceCut(0), 2000, 100000, 200000);
  assert.deepEqual(segs, []);
});

test('【失敗系・Phase3】cellsAlong: layerにgraphが無ければ例外を投げず空配列を返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  assert.deepEqual(index.cellsAlong({ graph: null, floorZMm: 0 }, faceCut(0), 2000, 0, 1000), []);
  assert.deepEqual(index.cellsAlong(undefined, faceCut(0), 2000, 0, 1000), []);
});

test('【失敗系・Phase3】cellsAlong: worldMid・fromDepthMm・toDepthMmがNaNでも例外を投げず空配列を返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const layer = { graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);

  assert.deepEqual(index.cellsAlong(layer, faceCut(0), NaN, 0, 1000), []);
  assert.deepEqual(index.cellsAlong(layer, faceCut(0), 2000, NaN, 1000), []);
  assert.deepEqual(index.cellsAlong(layer, faceCut(0), 2000, 0, NaN), []);
  assert.deepEqual(index.cellsAlong(layer, faceCut(0), 2000, 1000, 500), [], 'toDepthMm<=fromDepthMmも空配列');
});

// ---- 天伏の平面区画（展開図が区画の高さに追従。zoneCeiling.js） ----
test('【区画 cellAt】区画内の ceilZ は床＋区画高・区画外（区画の無い残り）は部屋の CH', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);
  assert.equal(index.cellAt(layer, 3500, 1500).ceilZ, 3000, '区画の上');
  assert.equal(index.cellAt(layer, 1000, 1500).ceilZ, 2500, '区画の無い残りは部屋の CH');
  assert.equal(index.chFor(room, g.graph), 2500, 'chFor は不変（部屋の CH）');
  assert.equal(index.chAt(room, g.graph, 3500, 1500), 3000);
});

test('【床段差の二重加算なし】床 +100 の部屋に区画 3000 → ceilZ は datum 基準で 3100（3200 ではない）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setFloorLevel(100);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const cell = buildSpaceIndex([layer]).cellAt(layer, 1000, 1500);
  assert.equal(cell.floorZ, 100);
  assert.equal(cell.ceilZ, 3100);
});

test('【cellAt は傾斜区画の最高点】底 2800・ライズ 600 の傾斜は ceilZ 3400（点の位置によらない）。chAt は平面のみ＝部屋の CH のまま', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2800, shape: 'slope', dims: [600, 0] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const index = buildSpaceIndex([layer]);
  assert.equal(index.cellAt(layer, 100, 1500).ceilZ, 3400, '低い側の点でも最高点');
  assert.equal(index.cellAt(layer, 1900, 1500).ceilZ, 3400);
  assert.equal(index.chAt(room, g.graph, 1900, 1500), CH, 'chAt（遠側 cellsAlong 用）は不変');
});

test('【cellAt は部屋形状の傾斜も最高点・床段差込み】床 +100・部屋の CH 2500・形状 slope[300,+x] → 2500+300+100', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setFloorLevel(100);
  setRoomCeilingShape(room, { shape: 'slope', dims: [300, 0] });
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  assert.equal(buildSpaceIndex([layer]).cellAt(layer, 500, 1500).ceilZ, 2900);
});

test('【失敗系】円弧の区画の上は最高点にならず部屋の CH のまま（E4 まで対象外）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2800, shape: 'arc', dims: [400, 0] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  assert.equal(buildSpaceIndex([layer]).cellAt(layer, 1000, 1500).ceilZ, CH);
});

// ---- E3b-1: 遠側の傾斜（cellsAlong）。切断線 y=0・視線 +y。遠側の部屋は y 2000..4000（奥の端 y=4000）----
test('【cellsAlong・走り方向の傾斜】視線の先の部屋の区画が走り方向（x）の傾斜なら、その片は ceilZ null で floorFace だけ（体裁が斜線 1 本で描く）', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  far.setOverride('ceilingHeight', '2500');
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape: 'slope', dims: [600, 0] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs[1].room, far);
  assert.equal(segs[1].floorZ, 0, '床は積む');
  assert.equal(segs[1].ceilZ, null, '走り方向の傾斜は列ごとの水平線にできない');
});

test('【cellsAlong・奥行き方向の傾斜は奥の端の値】底 3000・ライズ 600・+y 向き → 奥（y=4000）の高さ 3600、-y 向き → 3000。点の位置（走り）によらない', () => {
  for (const [dir, expected] of [[90, 3600], [270, 3000]]) {
    const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
    g.interior([[0, 0]]);
    const far = g.interior([[0, 1]]);
    far.setOverride('ceilingHeight', '2500');
    far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape: 'slope', dims: [600, dir] }).zones);
    const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
    const index = buildSpaceIndex([layer]);
    for (const worldMid of [500, 3500]) {
      const segs = index.cellsAlong(layer, faceCut(0), worldMid, 0, 10000);
      assert.equal(segs[1].room, far);
      assert.equal(segs[1].ceilZ, expected, `dir ${dir} 走り ${worldMid}`);
    }
  }
});

test('【cellsAlong・奥の端に壁】奥の端 y=4000 に壁があれば仕上げ面（4000−57.5）の高さ 3000+600×1942.5/2000＝3582.75', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1]], { walls: true });
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape: 'slope', dims: [600, 90] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs[1].room, far);
  assert.ok(Math.abs(segs[1].ceilZ - 3582.75) < 1e-6, `ceilZ ${segs[1].ceilZ}`);
});

test('【cellsAlong・部屋形状の傾斜】区画なしの部屋形状 slope[300,+y]（部屋の CH 2500）も奥の端の高さ 2500+300', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  far.setOverride('ceilingHeight', '2500');
  setRoomCeilingShape(far, { shape: 'slope', dims: [300, 90] });
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs[1].ceilZ, 2800);
});

test('【失敗系・cellsAlong】円弧・ドームの区画は対象外＝部屋の CH のまま。傾斜の区画の getFinishInfo が例外でも落ちず ceilZ null', () => {
  for (const [shape, dims] of [['arc', [400, 90]], ['dome', [500]]]) {
    const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
    g.interior([[0, 0]]);
    const far = g.interior([[0, 1]]);
    far.setOverride('ceilingHeight', '2500');
    far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape, dims }).zones);
    const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
    assert.equal(buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000)[1].ceilZ, 2500, shape);
  }
  const g = makeGrid([0, 4000], [0, 2000, 4000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape: 'slope', dims: [600, 90] }).zones);
  far.getFinishInfo = () => { throw new Error('boom'); };
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].ceilZ, null);
});

test('【cellsAlong・区画なしは不変】区画も形状も無い部屋の列は従来どおり（部屋の CH 2500・2400）で deepEqual', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  const near = g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  far.setOverride('ceilingHeight', '2500');
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segs, [
    { room: near, floorZ: 0, ceilZ: 2400, depthMm: 0 },
    { room: far, floorZ: 0, ceilZ: 2500, depthMm: 2000 },
    { room: null, floorZ: 0, ceilZ: null, depthMm: 4000 }, // 格子の残り（部屋なし）
  ]);
});

test('【cellsAlong は区画の far 天井】視線の先の部屋の最初のセルが区画なら ceilZ は床＋区画高（区画なしの部屋は CH）', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  const near = g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  far.setOverride('ceilingHeight', '2500');
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs[0].room, near);
  assert.equal(segs[0].ceilZ, CH);
  assert.equal(segs[1].room, far);
  assert.equal(segs[1].ceilZ, 3000);
});

test('【失敗系】区画のある部屋の getFinishInfo が例外でも cellsAlong は落ちず、その区間は ceilZ null で積む', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 3000, shape: 'flat', dims: [] }).zones);
  far.getFinishInfo = () => { throw new Error('boom'); };
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].room, far);
  assert.equal(segs[1].ceilZ, null);
});

// ---- E3b-3: cellsAlong は同じ部屋でも天井の面（区画・形状）が変わる所で割る。切断線 y=0・視線 +y ----
const flatSpec = mm => ({ heightMm: mm, shape: 'flat', dims: [] });

test('【cellsAlong は面が変わる所で割れる】視線の先の 1 部屋に区画 2 つ（手前 y2000..4000＝3000・奥 y4000..6000＝2300）→ 同じ部屋でも 2 片（depthMm 2000・4000）', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  const near = g.interior([[0, 0]]);
  const far = g.interior([[0, 1], [0, 2]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], flatSpec(3000)).zones);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 2)], flatSpec(2300)).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segs, [
    { room: near, floorZ: 0, ceilZ: CH, depthMm: 0 },
    { room: far, floorZ: 0, ceilZ: 3000, depthMm: 2000 },
    { room: far, floorZ: 0, ceilZ: 2300, depthMm: 4000 },
  ]);
});

test('【仕上げのセルの中の面の境界でも割れる】天井芯 y=3000 で割れた天井セル（仕上げのセルは y2000..6000 の 1 つ）の区画 3000／2300 → 片の depthMm は 2000 と 3000', () => {
  const g = makeGrid([0, 4000], [0, 2000, 6000]);
  const near = g.interior([[0, 0]]);
  const far = g.interior([[0, 1]]);
  g.graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.CEILING });
  const cellAt = y => worldToCell(2000, y, g.graph, CEILING_CELL_GRID).key;
  far.setCeilingZones(createZone(g.graph, far, [cellAt(2500)], flatSpec(3000)).zones);
  far.setCeilingZones(createZone(g.graph, far, [cellAt(4500)], flatSpec(2300)).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segs.map(s => [s.room, s.ceilZ, s.depthMm]), [[near, CH, 0], [far, 3000, 2000], [far, 2300, 3000]]);
});

test('【同じ面が続くなら畳む】2 セルにまたがる 1 つの区画（同じ面）・区画の無い部屋の 2 セルは、それぞれ 1 片（面の同一性で割る＝高さが同じでも別の面なら割れる側の対）', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1], [0, 2]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1), g.cell(0, 2)], flatSpec(2700)).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segs.map(s => [s.room === far, s.ceilZ, s.depthMm]), [[false, CH, 0], [true, 2700, 2000]], '同じ区画＝1 片');
  // 区画の無い部屋（field は他の部屋の区画であるので非 null）の 2 セルも 1 片のまま
  const h = makeGrid([0, 4000, 8000], [0, 2000, 4000, 6000]);
  h.interior([[0, 0]]);
  const plain = h.interior([[0, 1], [0, 2]]);
  const other = h.interior([[1, 0]]);
  other.setCeilingZones(createZone(h.graph, other, [h.cell(1, 0)], flatSpec(3000)).zones);
  const layerH = { graph: h.graph, floorZMm: 0, role: 'self' };
  const segsH = buildSpaceIndex([layerH]).cellsAlong(layerH, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segsH.map(s => [s.room === plain, s.ceilZ, s.depthMm]), [[false, CH, 0], [true, CH, 2000]], '区画なしの部屋は 2 セルでも 1 片');
});

test('【走り方向の片は null・奥行き方向は奥の端】片ごと: 手前 y2000..4000 が走り方向（x）の傾斜＝ceilZ null、奥 y4000..6000 が奥行き方向（+y）の傾斜 底 2400・ライズ 600＝奥の端 y=6000 の 3000', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1], [0, 2]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 2)], { heightMm: 2400, shape: 'slope', dims: [600, 90] }).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segs.map(s => [s.ceilZ, s.depthMm]), [[CH, 0], [null, 2000], [3000, 4000]]);
});

test('【失敗系・getFinishInfo 例外】区画のある部屋の getFinishInfo が例外だと天井の面の場が作れず区画なし扱い＝面では割れず、落ちずに ceilZ null の 1 片で積む（床の線は出る）', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1], [0, 2]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], flatSpec(3000)).zones);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 2)], flatSpec(2300)).zones);
  far.getFinishInfo = () => { throw new Error('boom'); };
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.deepEqual(segs.map(s => [s.room === far, s.floorZ, s.ceilZ, s.depthMm]), [[false, 0, CH, 0], [true, 0, null, 2000]]);
});

test('【失敗系・toDepthMm が面の境界より手前】上限 3000 で打ち切ると 2 つ目の片は出ない（境界より奥は探さない）', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1], [0, 2]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], flatSpec(3000)).zones);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 2)], flatSpec(2300)).zones);
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 3000);
  assert.deepEqual(segs.map(s => [s.ceilZ, s.depthMm]), [[CH, 0], [3000, 2000]]);
});

test('【cellsAlong は片の走り範囲で奥の壁を探す】奥の端 y=4000 の壁が隣（x4000..8000）にしか無く出隅だけ片（x0..4000）に掛かっても、列 x=2000 の ceilZ は仕上げ面の値（芯の値 3000 ではない）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 2000, 4000, 6000]);
  g.interior([[0, 0]]);
  const far = g.interior([[0, 1], [0, 2]]);
  far.setCeilingZones(createZone(g.graph, far, [g.cell(0, 1)], { heightMm: 2400, shape: 'slope', dims: [600, 90] }).zones);
  g.interior([[1, 1]], { walls: true }); // 隣の部屋: 奥の端 y=4000 の壁（仕上げ面は −y 側）は x4000..8000 にだけある
  const endWall = g.graph.walls.find(w => !w.isVertical && w.axisCL.value === 4000);
  endWall.startOffset = -72.5; // 出隅の 72.5mm だけ x<4000 へ入れる（片 x0..4000 には掛かるが列 x=2000 の ±10mm には掛からない）
  const layer = { graph: g.graph, floorZMm: 0, role: 'self' };
  const segs = buildSpaceIndex([layer]).cellsAlong(layer, faceCut(0), 2000, 0, 10000);
  assert.equal(segs[1].room, far);
  assert.ok(Math.abs(segs[1].ceilZ - 2982.75) < 1e-6, `ceilZ ${segs[1].ceilZ}`);
});
