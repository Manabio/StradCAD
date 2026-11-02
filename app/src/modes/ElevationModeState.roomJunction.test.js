// 展開モード init の部屋の取り合い（Room.detailRefs の floorWall。部分詳細図 S8a-2）: 派生線・帯の断面形の差し替え（倍率ゲート）・通知。
// 実グラフ（4000×3000 の 1 部屋）で ElevationModeState.init を通す。新 golden は作らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { ElevationModeState } from './ElevationModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { DetailSlot, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { baseboardFigure, wallBackedFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_WALL } = DetailSlot;

test.afterEach(() => clearOverlays());

function graphWithRoom() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y0, y1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 4000), cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  room.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, room).map(w => w.id));
  return { graph, room };
}
const BIG = { width: 1600, height: 1200 };   // 倍率が詳細（分母 ≤ 60）になる大きさ
const TINY = { width: 160, height: 60 };     // 倍率が小さい（分母 > 60）
async function build(viewSize, key = 'k') {
  const { graph, room } = graphWithRoom();
  if (key) room.setDetailRefs({ [FLOOR_WALL]: key });
  const state = new ElevationModeState(graph, null, viewSize);
  const result = await state.init();
  return { state, result, prims: state.bands[0].primitives };
}
const detailPolys = prims => prims.filter(p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thick');
const detailLines = prims => prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE);

test('倍率が詳細（分母 ≤ 60）の 2 パス目だけ、帯の切断面が輪郭（太線・source=detail）へ差し替わる。派生線は倍率に依らず引かれる', async () => {
  setOverlay(DF, { user: [baseboardFigure('k', 150, 60)] });
  const big = await build(BIG);
  assert.equal(big.result.ok, true);
  assert.equal(big.state.materialError, null);
  assert.ok(detailPolys(big.prims).length >= 2, `輪郭の polyline（隅ごと）: ${detailPolys(big.prims).length}`);
  assert.ok(detailLines(big.prims).some(p => p.weight === 'thin'), '派生線（細線）');
  const tiny = await build(TINY);
  assert.equal(detailPolys(tiny.prims).length, 0, '倍率が小さければ差し替えない');
  assert.ok(detailLines(tiny.prims).some(p => p.weight === 'thin'), '派生線は倍率に依らない');
});

test('【失敗系】存在しないキー: 線も差し替えも出さず、展開 init のトーストは 1 回（部屋主語）', async () => {
  const { prims, result, state } = await build(BIG, 'df-gone');
  assert.equal(detailPolys(prims).length + detailLines(prims).length, 0);
  assert.equal(result.ok, true, '通知は ok の判定に含めない');
  assert.ok(state.materialError && state.materialError.includes('部屋「LDK」'), String(state.materialError));
  assert.ok(!state.materialError.includes('ほか'), '1 件は「ほか」を付けない');
});

test('【失敗系】壁厚に合わない図: 出力は割当て無しとバイト一致・通知は 1 回', async () => {
  setOverlay(DF, { user: [wallBackedFigure('df-tight', FLOOR_WALL, 5000)] });
  const base = await build(BIG, null);
  const fail = await build(BIG, 'df-tight');
  assert.equal(JSON.stringify(fail.prims), JSON.stringify(base.prims));
  assert.ok(fail.state.materialError.includes('の床と壁に合わせられません'), String(fail.state.materialError));
  assert.equal(base.state.materialError, null);
});

test('【失敗系】部屋の生成壁が無くても（面の壁を隣室が生成した場合）、描画が壁厚を取る面の壁で fit 失敗を通知する', async () => {
  setOverlay(DF, { user: [wallBackedFigure('df-tight', FLOOR_WALL, 5000)] });
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-tight' });
  room.generatedWallIds = new Set(); // 壁は残るが、この部屋の生成壁ではない
  const state = new ElevationModeState(graph, null, BIG);
  await state.init();
  assert.ok(String(state.materialError).includes('の床と壁に合わせられません'), String(state.materialError));
});
