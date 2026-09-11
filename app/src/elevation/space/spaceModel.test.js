// space/spaceModel.js（展開図一般化Phase 1）の単体テスト。
// フィクスチャ方針は sectionProbe.test.js と同じ実core.js（Plane/PlanGraph）+
// finish/wallGeneration.js（壁生成）を踏襲する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { buildSpaceIndex } from './spaceModel.js';
import { makeProbeContext } from '../section/sectionProbe.js';
import { PROBE_EPS_MM } from '../elevationStyle.js';

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
