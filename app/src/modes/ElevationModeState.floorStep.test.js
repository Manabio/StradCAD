// 展開モード init の床の段差（Room.detailRefs の floorStep。部分詳細図 S8b-3）: 段差見付け面の派生線・壁面上の riser の差し替え（倍率ゲート）・通知。
// 実グラフ（3 列×1 行の部屋の右列が部分指定の子）で ElevationModeState.init を通す。新 golden は作らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { ElevationModeState } from './ElevationModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { DetailSlot, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { stepNoseFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_STEP } = DetailSlot;

test.afterEach(() => clearOverlays());

// 3 列（0-2000-4000-6000）×1 行（0-3000）。右列が部分指定の子（床 childFL）。assign＝'parent'|'child'|null（floorStep を持たせる部屋）
function graphWithStep(childFL, assign, key = 'k') {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  room.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, room).map(w => w.id));
  const child = graph.addRoom(new Set([cellKey(2, 3)]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  if (assign === 'parent') room.setDetailRefs({ [FLOOR_STEP]: key });
  if (assign === 'child') child.setDetailRefs({ [FLOOR_STEP]: key });
  return { graph, room, child };
}
const BIG = { width: 1600, height: 1200 };   // 倍率が詳細（分母 ≤ 60）になる大きさ
const TINY = { width: 700, height: 500 };    // 倍率が小さい（分母 > 60 で、最小描画幅がまだ段差高より小さい）
async function build(viewSize, childFL, assign, key) {
  const { graph } = graphWithStep(childFL, assign, key);
  const state = new ElevationModeState(graph, null, viewSize);
  const result = await state.init();
  return { state, result, prims: state.bands.flatMap(b => b.primitives) };
}
const detailPolys = prims => prims.filter(p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thick');
const detailLines = prims => prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE);

test('子が高い（+300・子が高い側）: 倍率が詳細の 2 パス目だけ riser が段鼻の輪郭へ差し替わり、段差見付け面の派生線は倍率に依らず引かれる', async () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const big = await build(BIG, 300, 'child');
  assert.equal(big.result.ok, true);
  assert.equal(big.state.materialError, null);
  // 壁面（上辺・下辺の 2 面）の riser が輪郭の polyline（段鼻: 頂部が riser 面に付かないので riser 上端から始まる 7 点）
  const polys = detailPolys(big.prims);
  assert.equal(polys.length, 2, `riser の輪郭: ${polys.length}`);
  assert.ok(polys.every(p => p.points.length === 7), JSON.stringify(polys[0]?.points));
  // 段差見付け面の派生線（細線・水平・全幅）
  const lines = detailLines(big.prims);
  assert.ok(lines.length >= 2 && lines.every(l => l.y1 === l.y2), '段差見付け面の水平線');
  const tiny = await build(TINY, 300, 'child');  assert.equal(detailPolys(tiny.prims).length, 0, '倍率が小さければ差し替えない');
  assert.ok(detailLines(tiny.prims).length >= 2, '派生線は倍率に依らない');
});

test('riser の縦線（CUT）は差し替えで消え（輪郭が riser の下部を含む）、割当て無しは全長 [−300, 0] のまま', async () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const riserX = 3885; // 上辺の面の riser の描画 x（上のテストの輪郭の起点）
  const rangesAt = prims => prims.filter(p => p.type === 'line' && p.weight === 'thick' && p.x1 === riserX && p.x2 === riserX)
    .map(p => [Math.min(p.y1, p.y2), Math.max(p.y1, p.y2)]);
  assert.deepEqual(rangesAt((await build(BIG, 300, null)).prims), [[-300, 0]]);
  const swapped = await build(BIG, 300, 'child');
  assert.deepEqual(rangesAt(swapped.prims), [], '単純断面の riser は残らない（二重にならない）');
  assert.deepEqual(detailPolys(swapped.prims)[0].points.slice(-2), [[riserX, -230], [riserX, 0]], '輪郭の末尾が riser の下部（見切りの下〜低い側の床）');
});

test('段差高に追従する（FL の end＝低い側の床）: 段差高 400 でも輪郭は高い側の床〜低い側の床の全長を覆う', async () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const { prims } = await build(BIG, 400, 'child');
  const p = detailPolys(prims)[0];
  assert.deepEqual(p.points.slice(-1)[0][1], 0, '輪郭の下端は低い側の床（y=0）');
  assert.equal(p.points[0][1], -400, '起点は高い側の床');
});

test('割当て無しの文書は出力が変わらない（source=detail の線も輪郭も無い）', async () => {
  const none = await build(BIG, 300, null);
  assert.equal(detailPolys(none.prims).length + detailLines(none.prims).length, 0);
  assert.equal(none.state.materialError, null);
});

// 輪郭が riser から出る向き（帯の x 方向。+1＝右）。壁面は上辺（左→右）・下辺（右→左）の順に並ぶので、世界の低い側（子＝右列 or 親＝左側）に対し向きが面ごとに反転する
const nosesDirs = prims => detailPolys(prims).map(p => {
  const [x0, y0] = p.points[0];
  const tip = p.points[1];
  assert.equal(tip[1], y0, '頂部は高い側の床の高さ');
  assert.equal(Math.abs(Math.round(tip[0] - x0)), 120, '出は 120');
  return Math.sign(tip[0] - x0);
});

test('輪郭は低い側へ出る（sx）: 子が高いと上辺の面は左へ・下辺の面は右へ、親が高い（子 −300）と逆。親の割当てでも差し替わる', async () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  assert.deepEqual(nosesDirs((await build(BIG, 300, 'child')).prims), [-1, 1], '子が高い: 低い側（親＝世界の左）');
  assert.deepEqual(nosesDirs((await build(BIG, -300, 'parent')).prims), [1, -1], '親が高い: 低い側（子＝世界の右）');
});

test('【失敗系】高い側でない部屋の割当ては使わない（子が高いのに親へ割当て・親が高いのに子へ割当て）: 差し替えも派生線も出ない', async () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  for (const [childFL, assign] of [[300, 'parent'], [-300, 'child']]) {
    const { prims, state } = await build(BIG, childFL, assign);
    assert.equal(detailPolys(prims).length + detailLines(prims).length, 0, `${childFL}/${assign}`);
    assert.equal(state.materialError, null);
  }
});

test('【失敗系】存在しないキー: 線も差し替えも出さず、トーストは 1 回（部屋主語・床の段差）', async () => {
  const { prims, result, state } = await build(BIG, 300, 'child', 'df-gone');
  assert.equal(detailPolys(prims).length + detailLines(prims).length, 0);
  assert.equal(result.ok, true, '通知は ok の判定に含めない');
  assert.ok(state.materialError && state.materialError.includes('部屋「小上がり」') && state.materialError.includes('床の段差'), String(state.materialError));
  assert.ok(!state.materialError.includes('ほか'), '1 件は「ほか」を付けない');
});

test('【失敗系】段差高に合わない図（固定寸法の和が段差高以上）: 出力は割当て無しとバイト一致・通知は 1 回', async () => {
  setOverlay(DF, { user: [stepNoseFigure('df-tall', { thickness: 400 })] }); // 厚 400 > 段差高 300
  const base = await build(BIG, 300, null);
  const fail = await build(BIG, 300, 'child', 'df-tall');
  assert.equal(JSON.stringify(fail.prims), JSON.stringify(base.prims));
  assert.ok(fail.state.materialError.includes('の床の段差に合わせられません'), String(fail.state.materialError));
  assert.equal(base.state.materialError, null);
});
