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
import { worldToCell } from '../../finish/gridCells.js';

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
