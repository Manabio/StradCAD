// 下屋の平面表示の図形（finish/roof/roofPlanFigure.js。ステップ1＝線だけ）のテスト。
// 期待値は手計算（y は下向き正）。構造ゲートは見ない（graph だけから作る）ので project は要らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';
import {
  roofPlanFigure as roofPlanFigureAll, visibleRoofPlanPrimitives, roofSlopeText, roofSlopeLabelPrimitives,
  ROOF_LABEL_FONT_MM, ROOF_LABEL_ARROW_MM, ROOF_LABEL_GAP_MM, ROOF_LABEL_HEAD_MM,
} from './roofPlanFigure.js';
import { chevronPoints } from '../../renderer/chevron.js';
import { leanToPlanRegions } from '../../structural/roofFramingRegions.js';
import { roofFramingLines } from '../../structural/roofFramingGeometry.js';
import { createLeanToRoofSpec } from './roofDefaults.js';
import { LodLevel } from '../../viewport.js';
import { planSolidsLayerPrimitives, visiblePlanPrimitives } from '../../plan/planSolidsLayerFilter.js';
import { roofLineDiffs, labelKeys } from '../../plan/roofPlanCompare.js';
import { wallConcealRange } from '../columnWrap.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

/** 線（kind:'line'）だけ。ステップ1以来のテストは線の図形を見る（傾斜ラベルは roofPlanFigureAll で別に見る）。 */
const roofPlanFigure = graph => roofPlanFigureAll(graph).filter(p => p.kind === 'line');

/** 格子 xs × ys の階。interior・roof は [i, j] セルの配列から部屋を作る。 */
function makeGrid(xs, ys) {
  const graph = new PlanGraph(new Plane('p2', 0, '2階', 2, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  const interior = cells => graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '居間');
  const roof = (cells, shape = null) => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '屋根');
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
    if (shape) room.roofSpec.setField('shape', shape);
    return room;
  };
  return { graph, interior, roof, cx, cy };
}

const countByRole = prims => {
  const out = { outline: 0, ridge: 0, hip: 0, valley: 0 };
  for (const p of prims) out[p.role]++;
  return out;
};
const ALL_LODS = [LodLevel.SCHEMATIC, LodLevel.STANDARD, LodLevel.DETAIL];

test('roofPlanFigure: 片流れ（矩形）は外形線だけ。線は細い実線1本の primitive（kind:line・detailOnly:false）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  g.roof([[0, 1], [1, 1]]); // 4000×1500（短手 1500 ≦ 3640 → 自動で片流れ）
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 0, hip: 0, valley: 0 });
  assert.deepEqual(prims[0], {
    kind: 'line', key: prims[0].key, role: 'outline', points: [4455, 1045, 4455, 3455, -455, 3455, -455, 1045],
    closed: true, detailOnly: false,
  });
  assert.ok(prims.every(p => p.kind === 'line' && p.detailOnly === false));
});

test('roofPlanFigure: 切妻は外形線1・棟木1。棟木はけらばの外形線まで（けらばの出幅 455 ぶん）延びる', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.roof([[0, 0], [1, 0], [0, 1], [1, 1]]); // 8000×8000 → 自動で切妻・棟は横（y=4000）
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 1, hip: 0, valley: 0 });
  assert.deepEqual(prims.find(p => p.role === 'ridge').points, [-455, 4000, 8455, 4000]);
  assert.equal(prims.find(p => p.role === 'ridge').closed, false);
});

test('roofPlanFigure: 寄棟（矩形）は外形線1・棟木1・隅木4。棟木は延ばさず、隅木は軒の角（外形線の角）まで', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.roof([[0, 0], [1, 0]], RoofShape.HIP); // 8000×4000
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 1, hip: 4, valley: 0 });
  assert.deepEqual(prims.find(p => p.role === 'ridge').points, [2000, 2000, 6000, 2000], '寄棟の棟木は延びない');
  const hips = prims.filter(p => p.role === 'hip').map(p => p.points);
  assert.deepEqual(hips[0], [-455, -455, 2000, 2000], '隅木は軒の角 (-455,-455) から上端 (2000,2000) まで');
  assert.equal(hips.length, 4);
});

test('roofPlanFigure: 寄棟の L字は棟木2・隅木5・谷木1。谷木は平面だけ外形線の入隅の角まで延びる', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.roof([[0, 0], [1, 0], [0, 1]], RoofShape.HIP); // L字（上の行は全幅・左の列は全高）。入隅は (4000,4000)
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 2, hip: 5, valley: 1 });
  const valley = prims.find(p => p.role === 'valley');
  assert.deepEqual(valley.points.slice(0, 2), [4455, 4455], '谷木の軒側の端は外形線の入隅の角（4000+455）');
  assert.deepEqual(valley.points.slice(2), [2000, 2000], '上端は変わらない（翼の棟木の交点）');
});

test('roofPlanFigure: L字の片流れは外形線＋継ぎ目の隅木（棟木は無い）。屋内に接する2辺（出隅の回り込み）は外形線から除く', () => {
  const g = makeGrid([0, 3640, 5460], [0, 3640, 5460]);
  g.interior([[0, 0]]);
  g.roof([[0, 1], [1, 1], [1, 0]]); // 屋内（左上）を下・右から回り込む L字の片流れ（自動）
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 0, hip: 1, valley: 0 });
  const outline = prims.find(p => p.role === 'outline');
  assert.equal(outline.closed, false, '屋内に接する2辺を除いた開いた折れ線');
  // 両端は建物の出隅（右上の翼の左上 (3640,0)・左下の翼の左上 (0,3640)＝屋内の右上・左下の角）。そこで軒先の線は建物の外壁の線まで
  // 回り込む（軒の出 455 ぶん V の先へ延ばして直角に戻る）。壁が無いので通り芯の線 y=0・x=0 まで
  assert.deepEqual(outline.points, [3185, 0, 3185, -455, 5915, -455, 5915, 5915, -455, 5915, -455, 3185, 0, 3185], '屋内に接する2辺（通り芯＝壁の中）の外側だけ。両端は建物の出隅を回り込んで外壁の線で止まる');
});

test('roofPlanFigure: U字の片流れ（向かい合う水下）は棟木が出て、伏図（roofFramingLines の ridges）と同じ線。隅木は2本・谷木なし', () => {
  const g = makeGrid([0, 1820, 3640, 5460], [0, 3640, 7280]);
  g.interior([[1, 0]]); // 屋内（x1820..3640・y0..3640）の左・下・右を回る U字
  g.roof([[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]], RoofShape.MONO);
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 1, hip: 2, valley: 0 });
  const [region] = leanToPlanRegions(g.graph);
  assert.ok(region.leanToDrains.length === 3, '前提: 水下は左・下・右の3本');
  const { ridges } = roofFramingLines({
    rect: null, rects: region.rects, shape: region.shape, leanToDrains: region.leanToDrains, leanToPurlinDepthMm: region.leanToPurlinDepthMm,
    purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: 0.5,
  });
  assert.deepEqual(ridges.map(l => [l.isVertical, l.coord, l.lo, l.hi]), [[true, 2730, 3640, 4550]], '前提: 棟木は x=2730 の y 3640..4550');
  assert.deepEqual(prims.find(p => p.role === 'ridge').points, [2730, 3640, 2730, 4550], '平面の棟木は伏図と同じ（けらばの外形線へは延びない端）');
});

// 旧（〜2026-10-05）: 水下が段違いの L字の片流れは、水下への L∞ 距離の場の継ぎ目として隅木1・谷木1が出た。
// 新（2026-10-05 裁定「規則どおりの屋根が存在しない形は軒先の線だけ」）: 水下だけが進む屋根面は、段違いの水下の段の角で
// 到達時刻が崖になる（連続しない）ので作れない形＝外形線だけ（棟木・隅木・谷木・傾斜ラベルを出さない）
test('roofPlanFigure: L字の片流れ（屋内に接しない。両翼が同じ壁で水下が段違い）は規則で作れない形＝軒先の線だけ。隅木・谷木・傾斜ラベルを出さない', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[1, 1], [2, 1], [1, 2]]);
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 0, hip: 0, valley: 0 });
  const [region] = leanToPlanRegions(g.graph);
  assert.equal(region.outlineOnly, true, '水下が段違い＝region は外形線だけの補完 region');
  assert.deepEqual(region.planDrains, [], 'ラベルの水下も無い');
  assert.equal(arrowsOf(roofPlanFigureAll(g.graph)).length, 0, '傾斜ラベルも出ない');
});


test('roofPlanFigure: 切妻の L字は腕ごとに棟木（自動で切妻・明示の切妻）。棟木はけらばの外形線まで延び、隅木・谷木は軒先の角から', () => {
  const big = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  big.roof([[0, 0], [1, 0], [0, 1]]); // 自動で切妻になる L字（幅 4000 の腕2本。右端の辺・下端の辺がけらば）
  const prims = roofPlanFigure(big.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 2, hip: 1, valley: 1 });
  assert.deepEqual(prims.filter(p => p.role === 'ridge').map(p => p.points), [[2000, 2000, 8455, 2000], [2000, 2000, 2000, 8455]], '棟木は腕の幅の中心。けらば（右端・下端）の外形線まで 455 延びる');
  assert.deepEqual(prims.find(p => p.role === 'hip').points, [-455, -455, 2000, 2000]);
  assert.deepEqual(prims.find(p => p.role === 'valley').points, [4455, 4455, 2000, 2000]);
  const explicit = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  explicit.roof([[1, 1], [2, 1], [1, 2]], RoofShape.GABLE); // 明示の切妻（短手が 3640 以下でも切妻）
  const ep = roofPlanFigure(explicit.graph);
  assert.deepEqual(countByRole(ep), { outline: 1, ridge: 2, hip: 2, valley: 1 }, '明示の切妻の L字');
  assert.deepEqual(ep.filter(p => p.role === 'ridge').map(p => p.points), [[3250, 2250, 6455, 2250], [3000, 2500, 3000, 4955]]);
  for (const shape of [RoofShape.STAGGERED, RoofShape.FLAT]) {
    const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
    g.roof([[1, 1], [2, 1], [1, 2]], shape);
    assert.deepEqual(countByRole(roofPlanFigure(g.graph)), { outline: 1, ridge: 0, hip: 0, valley: 0 }, `L字・明示の ${shape}（外形線だけ）`);
  }
  for (const shape of [RoofShape.STAGGERED, RoofShape.FLAT]) {
    const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
    g.roof([[0, 0], [1, 0], [0, 1], [1, 1]], shape);
    assert.deepEqual(countByRole(roofPlanFigure(g.graph)), { outline: 1, ridge: 0, hip: 0, valley: 0 }, `矩形・${shape}`);
  }
});

test('roofPlanFigure: 屋内に接する辺は外形線から除く（開いた折れ線）。壁の中に重なる線を描かない', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]);
  g.interior([[0, 1]]); // 屋根（x 2000..6000・y 1500..3000）の左の辺に接する
  g.roof([[1, 1], [2, 1]]);
  const [outline] = roofPlanFigure(g.graph);
  assert.equal(outline.role, 'outline');
  assert.equal(outline.closed, false);
  // 屋根の上下の辺は屋内（左）の上下の辺と同じ線上（面一）で、屋内の右上・右下の角が建物の出隅。両端はそこで軒の出 455 ぶん
  // 建物側へ回り込んで外壁の線（y=1500・y=3000）まで戻る（壁が無いので通り芯の線）
  assert.deepEqual(outline.points, [1545, 1500, 1545, 1045, 6455, 1045, 6455, 3455, 1545, 3455, 1545, 3000]);
});

test('roofPlanFigure: key は region の key と通し番号で一意。屋根が複数なら部屋ごとの線が並ぶ', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.roof([[0, 0]], RoofShape.HIP);
  g.roof([[1, 1]], RoofShape.GABLE);
  const prims = roofPlanFigure(g.graph);
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
  assert.equal(prims.filter(p => p.role === 'outline').length, 2);
});

test('【失敗系】roofPlanFigure: graph 無し・屋根の無い階・屋根でない部屋・範囲が不正な屋根は空', () => {
  assert.deepEqual(roofPlanFigure(null), []);
  assert.deepEqual(roofPlanFigure(undefined), []);
  const none = makeGrid([0, 4000], [0, 3000]);
  none.interior([[0, 0]]);
  assert.deepEqual(roofPlanFigure(none.graph), []);
  const bad = makeGrid([0, 4000], [0, 3000]);
  const room = bad.roof([[0, 0]]);
  room.cells.clear();
  room.cells.add('no:such:cell:key');
  assert.deepEqual(roofPlanFigure(bad.graph), []);
});

test('visibleRoofPlanPrimitives: 線は全 LOD で同数。詳細だけの図形（detailOnly）は詳細（DETAIL）のときだけ', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.roof([[0, 0], [1, 0]], RoofShape.HIP);
  const prims = roofPlanFigure(g.graph);
  assert.ok(prims.length > 0);
  for (const lod of ALL_LODS) assert.equal(visibleRoofPlanPrimitives(prims, lod).length, prims.length, `線は ${lod} でも出る`);
  const mixed = [{ key: 'a', detailOnly: false }, { key: 'b', detailOnly: true }];
  assert.deepEqual(visibleRoofPlanPrimitives(mixed, LodLevel.DETAIL).map(p => p.key), ['a', 'b']);
  assert.deepEqual(visibleRoofPlanPrimitives(mixed, LodLevel.STANDARD).map(p => p.key), ['a']);
  assert.deepEqual(visibleRoofPlanPrimitives(mixed, LodLevel.SCHEMATIC).map(p => p.key), ['a']);
  assert.deepEqual(visibleRoofPlanPrimitives([], LodLevel.DETAIL), []);
});

// ---- 壁に当たる端を外壁面で止める（roofPlanWallTrim.js）。壁は本番の graph.addWall（製品の外壁と同じ形: 軸CL＋偏芯の対称壁） ----

/** 軸 CL（isVertical なら縦）上の壁（from〜to の CL の間）。axisOffset だけ偏芯した壁面＝材は軸〜壁面（外壁と同じ対称壁）。 */
const addWallOn = (graph, axisCL, axisOffset, isVertical, from, to) =>
  graph.addWall(axisCL, axisOffset, isVertical, from, 0, to, 0, { wallFinish: 12.5 });

test('壁あり: 片流れの外形線の端は通り芯でなく外壁面（壁の屋根側の外端）で止まる。壁が無ければ通り芯のまま', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]);
  g.interior([[0, 1]]); // 屋根（x 2000..6000・y 1500..3000）の左の辺 x=2000 に接する。上下の辺は屋内の上下の辺と面一
  g.roof([[1, 1], [2, 1]]);
  const [bare] = roofPlanFigure(g.graph);
  // 屋内の右上・右下の角が建物の出隅。軒先の線は両端で建物側へ回り込んで外壁の線（y=1500・y=3000）まで戻る
  assert.deepEqual(bare.points, [1545, 1500, 1545, 1045, 6455, 1045, 6455, 3455, 1545, 3455, 1545, 3000], '前提: 壁が無ければ通り芯の線まで');
  // 建物の上下の外壁（x 0..2000）。外面は北の壁が y=1425・南の壁が y=3075
  const north = addWallOn(g.graph, g.cy[1], -75, false, g.cx[0], g.cx[1]);
  const south = addWallOn(g.graph, g.cy[2], 75, false, g.cx[0], g.cx[1]);
  assert.deepEqual(north.materialRange, { lo: 1425, hi: 1500 }, '前提: 材は軸〜壁面');
  assert.deepEqual(south.materialRange, { lo: 3000, hi: 3075 }, '前提: 材は軸〜壁面');
  const [trimmed] = roofPlanFigure(g.graph);
  assert.equal(trimmed.role, 'outline');
  assert.equal(trimmed.closed, false);
  assert.deepEqual(trimmed.points, [1545, 1425, 1545, 1045, 6455, 1045, 6455, 3455, 1545, 3455, 1545, 3075], '折り返しの両端（壁に当たる端）だけ外壁の外面へ。軒先・けらばの角は不変');
  assert.equal(trimmed.key, bare.key, 'key は変わらない');
});

// 旧（〜2026-10-05）: 8000×4000 の寄棟の上辺が壁で、壁の角から出る隅木2本を含む4本の隅木の壁側の端を外壁面まで戻していた。
// 壁へ下る面を作らない裁定で、壁に接する寄棟は壁を除いた3辺（左・右・下）が水下＝隅木は下の2隅から壁へ向かう2本になった。
// 壁に当たるのはその隅木の上端なので、同じ「45°に線に沿って戻す」を上端で確かめる（12000×4000。上端は壁 y=4000 の (4000,4000)・(8000,4000)）。
test('壁あり: 寄棟の下屋は壁に当たる隅木の端（上端）を外壁面まで戻す（45°に線に沿って）。壁に当たらない端は変えない', () => {
  const g = makeGrid([0, 4000, 8000, 12000], [0, 4000, 8000]);
  g.interior([[0, 0], [1, 0], [2, 0]]); // 屋根（y 4000..8000）の上辺 y=4000 に接する
  g.roof([[0, 1], [1, 1], [2, 1]], RoofShape.HIP);
  const before = roofPlanFigure(g.graph);
  const hipsBefore = before.filter(p => p.role === 'hip').map(p => p.points);
  assert.deepEqual(hipsBefore, [[-455, 8455, 4000, 4000], [12455, 8455, 8000, 4000]], '前提: 隅木は下の2隅から壁 y=4000 の (4000,4000)・(8000,4000) へ。壁の角から出る隅木は無い');
  addWallOn(g.graph, g.cy[1], 75, false, g.cx[0], g.cx[3]); // y=4000 の壁。屋根側（+y）の外端は 4075
  // 屋根の左右の辺は屋内の左右の辺と面一（建物の出隅）で、外形線の両端は建物側へ回り込む。回り込みの端が当たる左右の外壁（x=0・x=12000）
  addWallOn(g.graph, g.cx[0], -75, true, g.cy[0], g.cy[1]);
  addWallOn(g.graph, g.cx[3], 75, true, g.cy[0], g.cy[1]);
  const after = roofPlanFigure(g.graph);
  assert.equal(after.length, before.length, '線の数は変わらない');
  const moved = after.filter((p, i) => JSON.stringify(p.points) !== JSON.stringify(before[i].points));
  assert.deepEqual(moved.map(p => p.role).sort(), ['hip', 'hip', 'outline'], '変わるのは壁に当たる隅木2本の上端と、外形線の壁に当たる端だけ');
  const hipsAfter = after.filter(p => p.role === 'hip').map(p => p.points);
  assert.deepEqual(hipsAfter, [[-455, 8455, 3925, 4075], [12455, 8455, 8075, 4075]], '上端は 45° に 75 だけ軒側へ戻って外壁面 y=4075。軒側の端は変えない');
});

test('壁あり: 壁に当たらない端・壁から離れた（reach の外の）壁は変えない', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]);
  g.interior([[0, 1]]);
  g.roof([[1, 1], [2, 1]]);
  const [bare] = roofPlanFigure(g.graph);
  addWallOn(g.graph, g.cx[0], 75, true, g.cy[1], g.cy[2]); // x=0 の壁（屋根の端の直線 x=2000 ではない）
  addWallOn(g.graph, g.cx[3], 75, true, g.cy[0], g.cy[1]); // x=6000 の壁だが屋根の辺（y 1500..3000）から離れている
  const [after] = roofPlanFigure(g.graph);
  assert.deepEqual(after.points, bare.points);
});

/** roof-test8 型の切妻の L字（屋内 x3640..7280 × y-9884..-3640 の下・右を回る。横の腕 幅 3640・縦の腕 幅 1820）。cx・cy は通り芯。 */
function makeGableL() {
  const g = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]);
  g.interior([[0, 0]]);
  g.roof([[0, 1], [1, 1], [1, 0]], RoofShape.GABLE);
  return g;
}

// 旧（〜2026-10-05）: 棟木2（腕ごと）・隅木2・谷木1・水下4（壁へ下る2面を含む）。壁（屋内に接する辺）は水下にしない裁定で、
// 水下は下辺・右辺の2本になり、棟木・谷木は出ず、隅木は下辺・右辺の軒先の出隅から壁 y=-3640 の (5460,-3640) へ1本（roof-test1＝L字の片流れと同じ線）
test('roofPlanFigure: 切妻の L字（roof-test8 型）は水下が下辺・右辺だけ＝棟木0・隅木1・谷木0。隅木は軒先の出隅から壁 y=-3640 へ（壁へ下る面を作らない）', () => {
  const g = makeGableL();
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 0, hip: 1, valley: 0 });
  assert.deepEqual(prims.filter(p => p.role === 'hip').map(p => p.points), [
    [9555, 455, 5460, -3640], // 下辺・右辺の軒先の出隅 (9100,0) から外へ 455。上端は壁 y=-3640 の上（x=5460。D が下辺＝右辺の距離で等しい点）
  ]);
  const same = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]); // 同じ範囲の L字の片流れ（roof-test1 型）と線が同じ
  same.interior([[0, 0]]);
  same.roof([[0, 1], [1, 1], [1, 0]], RoofShape.MONO);
  assert.deepEqual(prims.map(p => [p.role, p.points]), roofPlanFigure(same.graph).map(p => [p.role, p.points]), '切妻の L字（壁を除くと腕の内側が壁）と L字の片流れで線が同じ');
  const outline = prims.find(p => p.role === 'outline');
  assert.equal(outline.closed, false, '屋内に接する2辺を除いた開いた折れ線');
  assert.deepEqual(outline.points, [6825, -9884, 6825, -10339, 9555, -10339, 9555, 455, 3185, 455, 3185, -4095, 3640, -4095], '両端は建物の出隅（(7280,-9884)・(3640,-3640)）を回り込んで外壁の線で止まる（33505af の規則が切妻の L字でも効く）');
});

// 旧: 4面（壁へ下る2面を含む）。壁へ下る面は作らない裁定で、右・下の2面だけ
test('roofPlanFigure: 切妻の L字の傾斜ラベルは水下ごと＝2面（右・下）。壁 y=-3640・壁 x=7280 へ向かう矢印は出ない', () => {
  const g = makeGableL();
  const arrows = arrowsOf(roofPlanFigureAll(g.graph));
  assert.equal(arrows.length, 2);
  const dir = a => [Math.sign(a.points[2] - a.points[0]), Math.sign(a.points[3] - a.points[1])].join(',');
  assert.deepEqual(arrows.map(dir).sort(), ['0,1', '1,0'], '右（+x）・下（+y）だけ。壁の向き（左向き・上向き）の矢印は無い');
});

// 旧: 谷木の入隅の端・外形線の両端が動き、棟木・隅木は変わらない。壁を水下から除いた結果、谷木・棟木が無く、動くのは壁 y=-3640 に当たる
// 隅木の上端と外形線の両端
test('roofPlanFigure: 切妻の L字で壁あり: 壁に当たる端（隅木の上端・外形線の両端）だけ外壁面で止まる', () => {
  const g = makeGableL();
  const bare = roofPlanFigure(g.graph);
  // 壁 y=-3640（屋根側 +y の外端 -3565）・壁 x=7280（外端 7355）・建物の左の外壁 x=3640（外端 3565）・上の外壁 y=-9884（外端 -9959）
  addWallOn(g.graph, g.cy[1], 75, false, g.cx[0], g.cx[1]);
  addWallOn(g.graph, g.cx[1], 75, true, g.cy[0], g.cy[1]);
  addWallOn(g.graph, g.cx[0], -75, true, g.cy[0], g.cy[1]);
  addWallOn(g.graph, g.cy[0], -75, false, g.cx[0], g.cx[1]);
  const after = roofPlanFigure(g.graph);
  assert.equal(after.length, bare.length, '線の数は変わらない');
  const moved = after.filter((p, i) => JSON.stringify(p.points) !== JSON.stringify(bare[i].points));
  assert.deepEqual(moved.map(p => p.role).sort(), ['hip', 'outline']);
  assert.deepEqual(after.find(p => p.role === 'hip').points, [9555, 455, 5535, -3565], '隅木の上端は壁 y=-3640 の外面 y=-3565 へ（45° に 75 戻る）。軒先の端は変えない');
  assert.deepEqual(after.find(p => p.role === 'outline').points, [6825, -9959, 6825, -10339, 9555, -10339, 9555, 455, 3185, 455, 3185, -4095, 3565, -4095], '回り込みの両端だけ外壁の外面へ');
});

test('roofPlanFigure: 切妻の L字・十字で、腕の突き出しが幅より短い形でも、ラベルの数＝水下の数（描いた面の数）・棟木は腕ごと（入隅に接する辺は軒）', () => {
  const build = (xs, ys, cells, interiorCells = null) => {
    const g = makeGrid(xs, ys);
    if (interiorCells) g.interior(interiorCells);
    g.roof(cells, RoofShape.GABLE);
    return g.graph;
  };
  const cases = [
    // 旧: faces 4・ridges 2。屋内に接する2辺（壁）は水下にしない裁定で、水下は右・下の2本＝棟木なし
    { name: 'roof-test8 の横の腕を x=4550 始まり（突き出し 2730 ＜ 幅 3640）。腕の内側が壁', graph: build([4550, 7280, 9100], [-9884, -3640, 0], [[0, 1], [1, 1], [1, 0]], [[0, 0]]), faces: 2, ridges: 0 },
    { name: '明示切妻の L字（x2000..6000×y1500..3000＋x2000..4000×y3000..4500）', graph: build([0, 2000, 4000, 6000], [0, 1500, 3000, 4500], [[1, 1], [2, 1], [1, 2]]), faces: 4, ridges: 2 },
    { name: '本体＋突起', graph: build([0, 2730, 7280], [0, 5460, 6370], [[0, 0], [1, 0], [0, 1]]), faces: 4, ridges: 2 },
    { name: '十字', graph: build([0, 3640, 5460, 9100], [0, 3640, 7280, 10920], [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]), faces: 8, ridges: 3 },
  ];
  for (const c of cases) {
    const [region] = leanToPlanRegions(c.graph);
    assert.equal(region.planDrains.length, c.faces, `${c.name}: 水下（面）の数`);
    const prims = roofPlanFigureAll(c.graph);
    assert.equal(arrowsOf(prims).length, c.faces, `${c.name}: ラベル（矢印）の数＝描いた面の数`);
    assert.equal(countByRole(prims.filter(p => p.kind === 'line')).ridge, c.ridges, `${c.name}: 棟木`);
  }
});

// ---- 傾斜ラベル（詳細 LOD の「屋根」・水下向きの矢印・「（傾斜N/10）」） ----

const labelsOf = prims => prims.filter(p => p.kind !== 'line');
const arrowsOf = prims => prims.filter(p => p.kind === 'arrow');
/** 文字の推定幅（半角 ASCII 0.5・それ以外 1.0 × 200）。テスト側の独立な計算。 */
const widthOf = text => [...text].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 0.5 : 1) * 200, 0);

test('roofSlopeText: 「（傾斜N/10）」。0.5 刻みは「2.5」。有限でない・0・負・未指定は既定の傾斜（3）', () => {
  assert.equal(roofSlopeText(3), '（傾斜3/10）');
  assert.equal(roofSlopeText(4), '（傾斜4/10）');
  assert.equal(roofSlopeText(2.5), '（傾斜2.5/10）');
  for (const bad of [NaN, 0, -1, Infinity, -Infinity, undefined, null, '3']) assert.equal(roofSlopeText(bad), '（傾斜3/10）', String(bad));
});

test('roofSlopeLabelPrimitives: 縦の矢印（上下）は文字を左右から挟む（左「屋根」・右「（傾斜N/10）」）。矢印の中点が基準点・先端が水下側', () => {
  assert.deepEqual([ROOF_LABEL_FONT_MM, ROOF_LABEL_ARROW_MM, ROOF_LABEL_GAP_MM, ROOF_LABEL_HEAD_MM], [200, 900, 100, 150]);
  const a = { x: 1000, y: 2000 };
  const wName = widthOf('屋根');
  const wSlope = widthOf('（傾斜3/10）');
  assert.equal(wName, 400);
  assert.equal(wSlope, 1200);
  for (const flow of ['down', 'up']) {
    const prims = roofSlopeLabelPrimitives({ key: 'k', anchors: [{ drainIndex: 0, anchor: a, flow }], slope: 3 });
    assert.deepEqual(prims.map(p => p.kind), ['arrow', 'text', 'text']);
    assert.ok(prims.every(p => p.detailOnly === true));
    const [arrow, name, slope] = prims;
    const [tx, ty, hx, hy] = arrow.points;
    assert.equal(tx, 1000, `${flow}: 縦の矢印`);
    assert.equal(hx, 1000);
    assert.equal(Math.abs(hy - ty), 900, '長さ 900');
    assert.equal((ty + hy) / 2, 2000, '中点が基準点');
    assert.equal(flow === 'down' ? hy > ty : hy < ty, true, `${flow}: 先端が水下側（down は +y・up は -y）`);
    assert.deepEqual(arrow.head, chevronPoints(arrow.points, 150), '矢じりは chevronPoints（長さ 150）');
    assert.equal(name.text, '屋根');
    assert.equal(slope.text, '（傾斜3/10）');
    assert.equal(name.fontSizeMm, 200);
    assert.ok(name.x + wName < 1000 && 1000 < slope.x, `${flow}: 「屋根」の右端 ${name.x + wName} < 矢印の x < 傾斜の文字の左端 ${slope.x}`);
    assert.equal(name.x + wName, 1000 - 100, '「屋根」の右端は矢印から 100');
    assert.equal(slope.x, 1000 + 100);
    assert.equal(name.y + 200 / 2, 2000, '文字の縦位置は基準点が中心');
    assert.equal(slope.y + 200 / 2, 2000);
  }
});

test('roofSlopeLabelPrimitives: 横の矢印（左右）は文字を上下から挟む（上「屋根」・下「（傾斜N/10）」）。文字の横位置は基準点が中心', () => {
  const a = { x: 1000, y: 2000 };
  const wName = widthOf('屋根');
  const wSlope = widthOf('（傾斜3/10）');
  for (const flow of ['right', 'left']) {
    const prims = roofSlopeLabelPrimitives({ key: 'k', anchors: [{ drainIndex: 0, anchor: a, flow }], slope: 3 });
    const [arrow, name, slope] = prims;
    const [tx, ty, hx, hy] = arrow.points;
    assert.equal(ty, 2000, `${flow}: 横の矢印`);
    assert.equal(hy, 2000);
    assert.equal(Math.abs(hx - tx), 900);
    assert.equal((tx + hx) / 2, 1000);
    assert.equal(flow === 'right' ? hx > tx : hx < tx, true, `${flow}: 先端が水下側（right は +x・left は -x）`);
    assert.deepEqual(arrow.head, chevronPoints(arrow.points, 150));
    assert.ok(name.y + 200 < 2000 && 2000 < slope.y, `${flow}: 「屋根」の下端 ${name.y + 200} < 矢印の y < 傾斜の文字の上端 ${slope.y}`);
    assert.equal(name.y + 200, 2000 - 100);
    assert.equal(slope.y, 2000 + 100);
    assert.equal(name.x + wName / 2, 1000, '「屋根」の横位置は基準点が中心');
    assert.equal(slope.x + wSlope / 2, 1000, '傾斜の文字も');
  }
});

test('roofSlopeLabelPrimitives: 面ごとに key が一意。傾斜が 2.5 なら「（傾斜2.5/10）」・不正なら既定。面が無ければ空', () => {
  const anchors = [{ drainIndex: 0, anchor: { x: 0, y: 0 }, flow: 'down' }, { drainIndex: 1, anchor: { x: 5000, y: 0 }, flow: 'up' }];
  const prims = roofSlopeLabelPrimitives({ key: 'lean:r1', anchors, slope: 2.5 });
  assert.equal(prims.length, 6);
  assert.equal(new Set(prims.map(p => p.key)).size, 6);
  assert.ok(prims.filter(p => p.kind === 'text' && p.text !== '屋根').every(p => p.text === '（傾斜2.5/10）'));
  const bad = roofSlopeLabelPrimitives({ key: 'k', anchors, slope: NaN });
  assert.ok(bad.filter(p => p.kind === 'text' && p.text !== '屋根').every(p => p.text === '（傾斜3/10）'));
  assert.deepEqual(roofSlopeLabelPrimitives({ key: 'k', anchors: [], slope: 3 }), []);
});

test('roofPlanFigure: 傾斜面の数（形状ごと）。片流れ1・切妻2・寄棟4・L字の寄棟6・L字の片流れ2・L字の切妻4（軒の辺ごと）。陸屋根・棟違いは 0', () => {
  const count = (cells, shape, grid = [[0, 4000, 8000], [0, 4000, 8000]], setup = null) => {
    const g = makeGrid(...grid);
    if (setup) setup(g);
    g.roof(cells, shape);
    return arrowsOf(roofPlanFigureAll(g.graph)).length;
  };
  assert.equal(count([[0, 0], [1, 0]], null, [[0, 4000, 8000], [0, 3000]]), 1, '片流れ（短手3000・高い側は既定）');
  assert.equal(count([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.GABLE), 2, '切妻');
  assert.equal(count([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.HIP), 4, '寄棟');
  assert.equal(count([[0, 0], [1, 0], [0, 1]], RoofShape.HIP), 6, 'L字の寄棟（外周6辺）');
  assert.equal(count([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.FLAT), 0, '陸屋根');
  assert.equal(count([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.STAGGERED), 0, '棟違い');
  assert.equal(count([[0, 0], [1, 0], [0, 1]], RoofShape.GABLE), 4, 'L字の切妻（軒の4辺が水下＝4面。けらばの2辺は面を持たない）');
  assert.equal(count([[0, 0], [1, 0], [0, 1]], RoofShape.FLAT), 0, '陸屋根の L字');
  // roof-test1 型の L字の片流れ: 屋内（上の左）に接し、水下が右と下の2面
  const l = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]);
  l.interior([[0, 0]]);
  l.roof([[1, 0], [1, 1], [0, 1]]);
  const prims = roofPlanFigureAll(l.graph);
  assert.equal(arrowsOf(prims).length, 2);
  assert.ok(labelsOf(prims).length === 6 && labelsOf(prims).every(p => p.detailOnly === true));
});

// 旧（〜2026-10-05）: 「傾斜面1つにつき1つ。壁へ向かって下る面にもラベルを出す（寄棟 4 面）」。壁へ下る面は作らない裁定で、
// 屋内に接する辺（壁）は水下でない＝壁へ向かう矢印の面は出ない。一部だけ壁に接する辺は、壁でない部分が水下として残る
test('roofPlanFigure: 壁に接する寄棟（roof-test6 型）は棟木1・隅木2（下の2隅から）・面3。L字の寄棟（roof-test9 型）は棟木1・隅木3・面4。壁の線上の角から出る隅木・谷木は無い', () => {
  // roof-test6: 矩形 x3640..9100 × y-3640..0。上辺 y=-3640 が屋内（上）に接する
  const a = makeGrid([3640, 9100], [-7280, -3640, 0]);
  a.interior([[0, 0]]);
  a.roof([[0, 1]], RoofShape.HIP);
  const pa = roofPlanFigureAll(a.graph);
  const la = pa.filter(p => p.kind === 'line');
  assert.deepEqual(countByRole(la), { outline: 1, ridge: 1, hip: 2, valley: 0 });
  assert.deepEqual(la.find(p => p.role === 'ridge').points, [6370, -3640, 6370, -2730], '棟木は壁側の端から頂点 (6370,-2730) まで（寄棟の棟木は延ばさない）');
  assert.deepEqual(la.filter(p => p.role === 'hip').map(p => p.points), [[3185, 455, 6370, -2730], [9555, 455, 6370, -2730]], '隅木は下の2隅（軒先の角まで）から頂点へ');
  assert.equal(arrowsOf(pa).length, 3, '面は左・右・下の3つ');
  // roof-test9: L字（屋内 x3640..7280 × y-9884..-3640 の下・右を回る）の寄棟
  const b = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]);
  b.interior([[0, 0]]);
  b.roof([[0, 1], [1, 1], [1, 0]], RoofShape.HIP);
  const pb = roofPlanFigureAll(b.graph);
  const lb = pb.filter(p => p.kind === 'line');
  assert.deepEqual(countByRole(lb), { outline: 1, ridge: 1, hip: 3, valley: 0 });
  assert.deepEqual(lb.find(p => p.role === 'ridge').points, [6370, -3640, 6370, -2730]);
  assert.deepEqual(lb.filter(p => p.role === 'hip').map(p => p.points), [[3185, 455, 6370, -2730], [9555, -10339, 7280, -8064], [9555, 455, 6370, -2730]]);
  assert.equal(arrowsOf(pb).length, 4, '面は上・右・下・左の4つ（壁へ下る面は無い）');
});

test('T3: 上が全部壁の切妻は、同じ壁配置で高い側＝上を指定した片流れと、region・線・ラベルが完全一致。下の左半分も壁（辺の途中で壁になる水下）なら規則で作れない形＝どちらも軒先の線だけ', () => {
  const build = (shape, bottomHalfWall) => {
    const g = makeGrid([0, 4000, 8000], [0, 4000, 8000, 12000]);
    g.interior([[0, 0], [1, 0]]); // 屋根（y4000..8000）の上辺 y=4000 の全体が屋内
    if (bottomHalfWall) g.interior([[0, 2]]); // 下辺 y=8000 の左半分（x0..4000）が屋内
    const room = g.roof([[0, 1], [1, 1]], shape);
    if (shape === RoofShape.MONO) room.roofSpec.setField('highSide', 'top');
    return g.graph;
  };
  const strip = prims => prims.map(p => ({ ...p, key: undefined }));
  // 上だけが壁: 下の辺は壁に接さない＝矩形の片流れ（rect の経路）。切妻は壁を水上にした片流れと同じ
  const gable = build(RoofShape.GABLE, false);
  const mono = build(RoofShape.MONO, false);
  const [rg] = leanToPlanRegions(gable);
  const [rm] = leanToPlanRegions(mono);
  assert.equal(rg.shape, 'mono');
  assert.deepEqual({ ...rg, key: 0 }, { ...rm, key: 0 }, 'region（水下・外形線）が一致');
  const fg = roofPlanFigureAll(gable);
  assert.ok(arrowsOf(fg).length > 0 && fg.some(p => p.role === 'outline'), '前提: 線とラベルがある');
  assert.deepEqual(strip(fg), strip(roofPlanFigureAll(mono)), '線・ラベルが一致');
  // 下辺の左半分も壁: 低い側（下の辺）の途中で壁になる水下＝水下だけが進む屋根面が連続しない。切妻でも片流れでも軒先の線だけ
  for (const shape of [RoofShape.GABLE, RoofShape.MONO]) {
    const g = build(shape, true);
    const [region] = leanToPlanRegions(g);
    assert.equal(region.outlineOnly, true, `${shape}: 外形線だけの region`);
    const figure = roofPlanFigureAll(g);
    const counts = countByRole(figure.filter(p => p.kind === 'line'));
    assert.ok(counts.outline >= 1 && counts.ridge === 0 && counts.hip === 0 && counts.valley === 0, `${shape}: 線は外形線だけ（壁の部分で分かれて複数本）: ${JSON.stringify(counts)}`);
    assert.equal(arrowsOf(figure).length, 0, `${shape}: ラベルなし`);
  }
});

test('roofPlanFigure: 壁（屋内に接する辺）へ向かう矢印は出ない。全形状・壁の4方向で、壁の外向きと同じ向きの矢印が0。寄棟は壁を除く3面。一部だけ壁の辺（辺の途中で壁になる水下）は規則で作れない形＝ラベルなし', () => {
  const dirOf = a => [Math.sign(a.points[2] - a.points[0]), Math.sign(a.points[3] - a.points[1])].join(',');
  // 屋根（8000×4000 か 4000×8000）の1辺の全体が屋内に接する。壁へ向かう向き＝その辺の外向き
  const sides = {
    top: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[0, 1], [1, 1]], interior: [[0, 0], [1, 0]], toward: '0,-1' },
    bottom: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[0, 0], [1, 0]], interior: [[0, 1], [1, 1]], toward: '0,1' },
    left: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[1, 0], [1, 1]], interior: [[0, 0], [0, 1]], toward: '-1,0' },
    right: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[0, 0], [0, 1]], interior: [[1, 0], [1, 1]], toward: '1,0' },
  };
  const faceCounts = { null: 1, [RoofShape.GABLE]: 1, [RoofShape.HIP]: 3 };
  for (const [side, f] of Object.entries(sides)) {
    for (const shape of [null, RoofShape.GABLE, RoofShape.HIP]) {
      const g = makeGrid(...f.grid);
      g.interior(f.interior);
      g.roof(f.roof, shape);
      const arrows = arrowsOf(roofPlanFigureAll(g.graph));
      assert.equal(arrows.filter(a => dirOf(a) === f.toward).length, 0, `${side}の壁・${shape ?? '片流れ（自動）'}: 壁へ向かう矢印が無い`);
      assert.equal(arrows.length, faceCounts[shape], `${side}の壁・${shape ?? '片流れ（自動）'}: 面の数（片流れ・壁と平行な切妻は壁を水上にした1面・寄棟は壁を除く3面）`);
    }
  }
  // 旧: 一部だけ接する辺は壁でない部分（x 4000..8000）が水下として残り4面。新: 辺の途中で壁になる水下は、水下だけが進む屋根面の
  // 到達時刻が連続しない（崖）ので規則で作れない形＝軒先の線だけ（ラベルなし）
  const part = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  part.interior([[0, 0]]); // 上の辺の半分（x 0..4000）だけ屋内に接する
  part.roof([[0, 1], [1, 1]], RoofShape.HIP);
  assert.equal(arrowsOf(roofPlanFigureAll(part.graph)).length, 0, '一部だけ接する辺（辺の途中で壁になる水下）は規則で作れない形＝ラベルなし');
  const none = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  none.roof([[0, 1], [1, 1]], RoofShape.HIP);
  assert.equal(arrowsOf(roofPlanFigureAll(none.graph)).length, 4, '壁に接しない寄棟は4面（今までどおり）');
});

test('roofPlanFigure: 外壁面どまり（線の端止め）はラベルを動かさない。壁ありでも arrow・text の座標は壁なしと同じ（線だけが変わる）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.interior([[0, 0], [1, 0]]);
  g.roof([[0, 1], [1, 1]], RoofShape.HIP);
  const bare = roofPlanFigureAll(g.graph);
  assert.ok(labelsOf(bare).length > 0, '前提: ラベルがある');
  addWallOn(g.graph, g.cy[1], 75, false, g.cx[0], g.cx[2]); // y=4000 の壁。屋根側の外端は 4075
  const walled = roofPlanFigureAll(g.graph);
  assert.deepEqual(labelsOf(walled), labelsOf(bare), 'ラベルは不変');
  const lineChanged = walled.filter(p => p.kind === 'line').some((p, i) => JSON.stringify(p.points) !== JSON.stringify(bare.filter(q => q.kind === 'line')[i].points));
  assert.ok(lineChanged, '前提: 線は壁の面まで止まって変わっている（trim が効いている）');
});

test('roofPlanFigure: 傾斜は roofSpec.slope の値。全 primitive の key は一意。ラベルは線の後に並ぶ', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const room = g.roof([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.HIP);
  room.roofSpec.setField('slope', 4.5);
  const prims = roofPlanFigureAll(g.graph);
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
  const firstLabel = prims.findIndex(p => p.kind !== 'line');
  assert.ok(firstLabel > 0 && prims.slice(firstLabel).every(p => p.kind !== 'line'), '線→ラベルの順');
  assert.ok(prims.filter(p => p.kind === 'text' && p.text !== '屋根').every(p => p.text === '（傾斜4.5/10）'));
});

test('visibleRoofPlanPrimitives: 矢印・文字は詳細（DETAIL）だけ。SCHEMATIC・STANDARD は 0 件。線は3つの LOD で同数', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.roof([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.HIP);
  const prims = roofPlanFigureAll(g.graph);
  const lineCount = prims.filter(p => p.kind === 'line').length;
  assert.ok(lineCount > 0 && labelsOf(prims).length > 0, '前提: 線もラベルもある');
  for (const lod of [LodLevel.SCHEMATIC, LodLevel.STANDARD]) {
    const shown = visibleRoofPlanPrimitives(prims, lod);
    assert.equal(shown.filter(p => p.kind === 'arrow' || p.kind === 'text').length, 0, `${lod}: ラベル 0 件`);
    assert.equal(shown.filter(p => p.kind === 'line').length, lineCount, `${lod}: 線は同数`);
  }
  const detail = visibleRoofPlanPrimitives(prims, LodLevel.DETAIL);
  assert.equal(detail.length, prims.length, 'DETAIL は全部');
  assert.equal(detail.filter(p => p.kind === 'line').length, lineCount);
});

test('T-C2 奥行の違う L字（水下の中点がセルの境目に乗る）: 文字の箱（推定幅×200）・矢印・矢じりが屋内のセルに重ならない', () => {
  const interiorBox = { x1: 0, y1: 0, x2: 3640, y2: 3640 }; // どちらの形も左上の屋内セル
  const overlapsInterior = (x1, y1, x2, y2) => x1 < interiorBox.x2 && x2 > interiorBox.x1 && y1 < interiorBox.y2 && y2 > interiorBox.y1;
  const forms = {
    '右の腕が浅い': { xs: [0, 3640, 5460], ys: [0, 3640, 7280], roof: [[1, 0], [0, 1], [1, 1]] },
    '左右を入れ替えた形': { xs: [0, 3640, 7280], ys: [0, 3640, 5460], roof: [[0, 1], [1, 0], [1, 1]] },
  };
  for (const [label, f] of Object.entries(forms)) {
    const g = makeGrid(f.xs, f.ys);
    g.interior([[0, 0]]);
    g.roof(f.roof);
    const prims = roofPlanFigureAll(g.graph);
    assert.equal(arrowsOf(prims).length, 2, `${label}: 前提: 面が2つ`);
    for (const p of prims) {
      if (p.kind === 'text') {
        assert.ok(!overlapsInterior(p.x, p.y, p.x + widthOf(p.text), p.y + 200), `${label}: 文字「${p.text}」の箱 (${p.x},${p.y}) が屋内に重ならない`);
      } else if (p.kind === 'arrow') {
        const pts = [...p.points, ...p.head];
        for (let i = 0; i < pts.length; i += 2) assert.ok(!overlapsInterior(pts[i] - 1, pts[i + 1] - 1, pts[i] + 1, pts[i + 1] + 1), `${label}: 矢印の点 (${pts[i]},${pts[i + 1]}) が屋内にある`);
        const [tx, ty, hx, hy] = p.points; // 本体の線分（縦か横）
        assert.ok(!overlapsInterior(Math.min(tx, hx) - 1, Math.min(ty, hy) - 1, Math.max(tx, hx) + 1, Math.max(ty, hy) + 1), `${label}: 矢印の線分が屋内を通らない`);
      }
    }
  }
});

// ================================================================ 新経路（S5: 屋根立体＋解決器）との一致
// 旧 roofPlanFigure（端止め trim 済み）と、PlanSolidsLayer が描く新経路（planSolidsLayerPrimitives の roof の線・ラベル。
// 外壁面どまりは壁立体の遮蔽が導く）が、線として（折れ線→線分→重なりを結合した区間で）同じで、ラベルは座標・文字まで同じ。

const CUT_Z = 1500;
const newPath = graph => planSolidsLayerPrimitives({ graph, cutZ: CUT_Z });
const fmtDiff = diffs => diffs.map(d => `${d.cls}:${d.roles.join('/')}:${d.points.join(',')}`).join(' | ');

/** 旧と新が一致することを確かめる。比較が空振りしないよう、旧の線が1本以上あることも確かめる。 */
function assertSameAsOld(graph, label, { expectLines = true } = {}) {
  const oldPrims = roofPlanFigureAll(graph);
  const newPrims = newPath(graph);
  if (expectLines) assert.ok(oldPrims.some(p => p.kind === 'line'), `${label}: 前提: 旧の線がある`);
  assert.equal(fmtDiff(roofLineDiffs(oldPrims, newPrims)), '', `${label}: 線の差分`);
  assert.deepEqual(labelKeys(newPrims), labelKeys(oldPrims), `${label}: ラベルは座標・文字まで同じ`);
}

test('新経路との一致: 壁なしの各形（片流れ・切妻・寄棟・L字・U字・段違い・陸屋根）で線とラベルが旧と同じ', () => {
  const cases = {
    '片流れ（矩形）': () => { const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]); g.roof([[0, 1], [1, 1]]); return g.graph; },
    '切妻のけらば延長': () => { const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]); g.roof([[0, 0], [1, 0], [0, 1], [1, 1]]); return g.graph; },
    '寄棟（矩形）': () => { const g = makeGrid([0, 4000, 8000], [0, 4000]); g.roof([[0, 0], [1, 0]], RoofShape.HIP); return g.graph; },
    'L字の寄棟（谷木）': () => { const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]); g.roof([[0, 0], [1, 0], [0, 1]], RoofShape.HIP); return g.graph; },
    'L字の片流れ（屋内に接する2辺の回り込み）': () => { const g = makeGrid([0, 3640, 5460], [0, 3640, 5460]); g.interior([[0, 0]]); g.roof([[0, 1], [1, 1], [1, 0]]); return g.graph; },
    'U字の片流れ（向かい合う水下の棟木）': () => { const g = makeGrid([0, 1820, 3640, 5460], [0, 3640, 7280]); g.interior([[1, 0]]); g.roof([[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]], RoofShape.MONO); return g.graph; },
    '切妻のL字（腕ごとの棟木）': () => { const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]); g.roof([[0, 0], [1, 0], [0, 1]]); return g.graph; },
    '明示切妻のL字': () => { const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]); g.roof([[1, 1], [2, 1], [1, 2]], RoofShape.GABLE); return g.graph; },
    '屋内辺を除く': () => { const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]); g.interior([[0, 1]]); g.roof([[1, 1], [2, 1]]); return g.graph; },
    '切妻のL字 roof-test8 型': () => makeGableL().graph,
    '壁に接する寄棟 roof-test6 型': () => { const g = makeGrid([3640, 9100], [-7280, -3640, 0]); g.interior([[0, 0]]); g.roof([[0, 1]], RoofShape.HIP); return g.graph; },
    'L字の寄棟 roof-test9 型': () => { const g = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]); g.interior([[0, 0]]); g.roof([[0, 1], [1, 1], [1, 0]], RoofShape.HIP); return g.graph; },
    '屋根が複数（離れている）': () => { const g = makeGrid([0, 4000, 8000, 12000], [0, 4000, 8000, 12000]); g.roof([[0, 0]], RoofShape.HIP); g.roof([[2, 2]], RoofShape.GABLE); return g.graph; },
  };
  for (const [label, build] of Object.entries(cases)) assertSameAsOld(build(), label);
  // 外形線だけの region（段違い・棟違い・陸屋根）: 線は外形線だけ・ラベルなし
  for (const [label, build] of Object.entries({
    '段違いの L字の片流れ': () => { const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]); g.roof([[1, 1], [2, 1], [1, 2]]); return g.graph; },
    '陸屋根': () => { const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]); g.roof([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.FLAT); return g.graph; },
    '棟違い': () => { const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]); g.roof([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.STAGGERED); return g.graph; },
  })) {
    const g = build();
    assertSameAsOld(g, label);
    assert.equal(newPath(g).filter(p => p.kind !== 'line').length, 0, `${label}: ラベルなし`);
    assert.ok(newPath(g).every(p => p.source.role === 'outline'), `${label}: 外形線だけ`);
  }
});

test('新経路との一致: 壁あり＝外壁面どまり（片流れの外形線の端・寄棟の隅木の上端・切妻のL字）を壁立体の遮蔽が導き、旧の端止めと同じ線になる', () => {
  // 片流れ: 外形線の折り返しの両端が外壁の外面（y=1425・3075）で止まる
  const a = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]);
  a.interior([[0, 1]]);
  a.roof([[1, 1], [2, 1]]);
  addWallOn(a.graph, a.cy[1], -75, false, a.cx[0], a.cx[1]);
  addWallOn(a.graph, a.cy[2], 75, false, a.cx[0], a.cx[1]);
  assertSameAsOld(a.graph, '片流れ・壁あり');
  const outline = newPath(a.graph).filter(p => p.source.role === 'outline');
  assert.ok(outline.some(p => p.points.includes(1425)) && outline.some(p => p.points.includes(3075)), '新経路の外形線が外壁面 y=1425・3075 で止まる');
  // 寄棟: 壁に当たる隅木の上端が 45° に外壁面まで戻る
  const b = makeGrid([0, 4000, 8000, 12000], [0, 4000, 8000]);
  b.interior([[0, 0], [1, 0], [2, 0]]);
  b.roof([[0, 1], [1, 1], [2, 1]], RoofShape.HIP);
  addWallOn(b.graph, b.cy[1], 75, false, b.cx[0], b.cx[3]);
  addWallOn(b.graph, b.cx[0], -75, true, b.cy[0], b.cy[1]);
  addWallOn(b.graph, b.cx[3], 75, true, b.cy[0], b.cy[1]);
  assertSameAsOld(b.graph, '寄棟・壁あり');
  // 切妻のL字（roof-test8 型）
  const c = makeGableL();
  addWallOn(c.graph, c.cy[1], 75, false, c.cx[0], c.cx[1]);
  addWallOn(c.graph, c.cx[1], 75, true, c.cy[0], c.cy[1]);
  addWallOn(c.graph, c.cx[0], -75, true, c.cy[0], c.cy[1]);
  addWallOn(c.graph, c.cy[0], -75, false, c.cx[0], c.cx[1]);
  assertSameAsOld(c.graph, '切妻のL字・壁あり');
  // 壁なしとの比較: 壁の有無で新経路の線が変わる（遮蔽が効いている）
  const bare = makeGableL();
  assert.notEqual(JSON.stringify(newPath(c.graph).map(p => p.points)), JSON.stringify(newPath(bare.graph).map(p => p.points)), '壁ありでは端が外壁面まで戻る');
});

test('新経路との一致: 壁に当たらない端・離れた壁・T3（上が全部壁の切妻と片流れ）・壁の4方向×形状・ラベル不動', () => {
  // 壁に当たらない端・reach の外の壁は変えない
  const a = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000]);
  a.interior([[0, 1]]);
  a.roof([[1, 1], [2, 1]]);
  addWallOn(a.graph, a.cx[0], 75, true, a.cy[1], a.cy[2]);
  const far = addWallOn(a.graph, a.cx[3], 75, true, a.cy[0], a.cy[1]);
  // 差分は1つだけ: 屋根の辺（y 1500..3000）から離れた壁 x=6000 が、上の軒先の線 y=1045 を横切る所（壁の覆い）。旧は端止めの対象でないので
  // 線を引き続け、新は壁の中に線を描かない（壁立体の遮蔽。許す差分 (a)）。端の止まり方（壁に当たらない端）は旧と同じ
  const diffs = roofLineDiffs(roofPlanFigureAll(a.graph), newPath(a.graph));
  const cover = wallConcealRange(far);
  assert.deepEqual(diffs.map(d => [d.cls, d.roles.join(), d.points[1], d.points[3], d.points[0], d.points[2]]),
    [['old', 'outline', 1045, 1045, cover.lo, cover.hi]], '壁の覆いの区間だけが旧のみ');
  assert.deepEqual(labelKeys(newPath(a.graph)), labelKeys(roofPlanFigureAll(a.graph)));
  // T3
  for (const [shape, bottomHalf] of [[RoofShape.GABLE, false], [RoofShape.MONO, false], [RoofShape.GABLE, true], [RoofShape.MONO, true]]) {
    const g = makeGrid([0, 4000, 8000], [0, 4000, 8000, 12000]);
    g.interior([[0, 0], [1, 0]]);
    if (bottomHalf) g.interior([[0, 2]]);
    const room = g.roof([[0, 1], [1, 1]], shape);
    if (shape === RoofShape.MONO) room.roofSpec.setField('highSide', 'top');
    assertSameAsOld(g.graph, `T3 ${shape} 下辺の左半分${bottomHalf ? 'も壁' : 'は壁でない'}`);
  }
  // 壁の4方向 × 形状
  const sides = {
    top: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[0, 1], [1, 1]], interior: [[0, 0], [1, 0]] },
    bottom: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[0, 0], [1, 0]], interior: [[0, 1], [1, 1]] },
    left: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[1, 0], [1, 1]], interior: [[0, 0], [0, 1]] },
    right: { grid: [[0, 4000, 8000], [0, 4000, 8000]], roof: [[0, 0], [0, 1]], interior: [[1, 0], [1, 1]] },
  };
  for (const [side, f] of Object.entries(sides)) {
    for (const shape of [null, RoofShape.GABLE, RoofShape.HIP]) {
      const g = makeGrid(...f.grid);
      g.interior(f.interior);
      g.roof(f.roof, shape);
      assertSameAsOld(g.graph, `${side}の壁・${shape ?? '片流れ'}`);
    }
  }
  // 一部だけ接する辺（規則で作れない形）と壁に接しない寄棟
  const part = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  part.interior([[0, 0]]);
  part.roof([[0, 1], [1, 1]], RoofShape.HIP);
  assertSameAsOld(part.graph, '一部だけ壁の辺（外形線だけ）');
  // ラベル不動: 壁ありでもラベルの座標は壁なしと同じ
  const w = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  w.interior([[0, 0], [1, 0]]);
  w.roof([[0, 1], [1, 1]], RoofShape.HIP);
  const labelsBare = labelKeys(newPath(w.graph));
  addWallOn(w.graph, w.cy[1], 75, false, w.cx[0], w.cx[2]);
  assert.ok(labelsBare.length > 0, '前提: ラベルがある');
  assert.deepEqual(labelKeys(newPath(w.graph)), labelsBare, '新経路でもラベルは壁の有無で動かない');
  assertSameAsOld(w.graph, 'ラベル不動・壁あり');
});

test('新経路との一致: 奥行の違う L字・十字・本体＋突起（ラベルの数＝水下の数。位置は旧と同じ）', () => {
  const build = (xs, ys, cells, interiorCells = null) => {
    const g = makeGrid(xs, ys);
    if (interiorCells) g.interior(interiorCells);
    g.roof(cells, RoofShape.GABLE);
    return g.graph;
  };
  assertSameAsOld(build([4550, 7280, 9100], [-9884, -3640, 0], [[0, 1], [1, 1], [1, 0]], [[0, 0]]), 'roof-test8 の横の腕を x=4550 始まり');
  assertSameAsOld(build([0, 2730, 7280], [0, 5460, 6370], [[0, 0], [1, 0], [0, 1]]), '本体＋突起');
  assertSameAsOld(build([0, 3640, 5460, 9100], [0, 3640, 7280, 10920], [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]), '十字');
  for (const [label, f] of Object.entries({
    '右の腕が浅い': { xs: [0, 3640, 5460], ys: [0, 3640, 7280], roof: [[1, 0], [0, 1], [1, 1]] },
    '左右を入れ替えた形': { xs: [0, 3640, 7280], ys: [0, 3640, 5460], roof: [[0, 1], [1, 0], [1, 1]] },
  })) {
    const g = makeGrid(f.xs, f.ys);
    g.interior([[0, 0]]);
    g.roof(f.roof);
    assertSameAsOld(g.graph, label);
  }
});

test('新経路との差分（許す差分 (c)）: 角で接する別々の下屋の軒の重なりは、旧は両方の線を描き、新は他方の屋根面の内側の線を隠す（旧のみ・他の屋根の内側だけ。新のみは無い）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.roof([[0, 0]], RoofShape.HIP);
  g.roof([[1, 1]], RoofShape.GABLE);
  const diffs = roofLineDiffs(roofPlanFigureAll(g.graph), newPath(g.graph));
  assert.ok(diffs.length > 0, '前提: 差分がある（軒の重なり x,y 3545..4455）');
  assert.ok(diffs.every(d => d.cls === 'old'), '新のみの線は無い');
  assert.ok(diffs.every(d => d.points.every(v => v >= 3545 - 0.1 && v <= 4455 + 0.1)), '差分は軒の重なりの正方形の中だけ');
  assert.deepEqual(labelKeys(newPath(g.graph)), labelKeys(roofPlanFigureAll(g.graph)), 'ラベルは同じ');
});

test('新経路: 傾斜は roofSpec.slope の値（ラベルの文字）。LOD の絞りは visiblePlanPrimitives（DETAIL 以外はラベルを落とし、線は同数）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const room = g.roof([[0, 0], [1, 0], [0, 1], [1, 1]], RoofShape.HIP);
  room.roofSpec.setField('slope', 4.5);
  const prims = newPath(g.graph);
  assert.ok(prims.filter(p => p.kind === 'text' && p.text !== '屋根').every(p => p.text === '（傾斜4.5/10）'));
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
  const lineCount = prims.filter(p => p.kind === 'line').length;
  assert.ok(lineCount > 0 && prims.some(p => p.kind !== 'line'), '前提: 線もラベルもある');
  for (const lod of [LodLevel.SCHEMATIC, LodLevel.STANDARD]) {
    const shown = visiblePlanPrimitives(prims, lod);
    assert.equal(shown.filter(p => p.kind === 'arrow' || p.kind === 'text').length, 0, `${lod}: ラベル 0 件`);
    assert.equal(shown.filter(p => p.kind === 'line').length, lineCount, `${lod}: 線は同数`);
  }
  assert.equal(visiblePlanPrimitives(prims, LodLevel.DETAIL).length, prims.length, 'DETAIL は全部');
});

test('【失敗系】新経路: graph 無し・屋根の無い階・屋根でない部屋・範囲が不正な屋根は roof の線もラベルも出ない', () => {
  assert.deepEqual(planSolidsLayerPrimitives({ graph: null, cutZ: CUT_Z }), []);
  const none = makeGrid([0, 4000], [0, 3000]);
  none.interior([[0, 0]]);
  assert.deepEqual(newPath(none.graph).filter(p => p.source.kind === 'roof'), []);
  const bad = makeGrid([0, 4000], [0, 3000]);
  const room = bad.roof([[0, 0]]);
  room.cells.clear();
  room.cells.add('no:such:cell:key');
  assert.deepEqual(newPath(bad.graph).filter(p => p.source.kind === 'roof'), []);
});
