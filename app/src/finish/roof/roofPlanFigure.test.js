// 下屋の平面表示の図形（finish/roof/roofPlanFigure.js。ステップ1＝線だけ）のテスト。
// 期待値は手計算（y は下向き正）。構造ゲートは見ない（graph だけから作る）ので project は要らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';
import { roofPlanFigure, visibleRoofPlanPrimitives } from './roofPlanFigure.js';
import { leanToPlanRegions } from '../../structural/roofFramingRegions.js';
import { roofFramingLines } from '../../structural/roofFramingGeometry.js';
import { createLeanToRoofSpec } from './roofDefaults.js';
import { LodLevel } from '../../viewport.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

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
  assert.deepEqual(outline.points, [3640, -455, 5915, -455, 5915, 5915, -455, 5915, -455, 3640], '屋内に接する2辺（通り芯＝壁の中）の外側だけ。両端は出幅 0 の壁の位置で止まる');
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

test('roofPlanFigure: L字の片流れ（屋内に接しない。両翼が同じ壁で水下が段違い）は水下への距離の場の継ぎ目＝深い翼の外の角から隅木・浅い翼の水下の端から谷木', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
  g.roof([[1, 1], [2, 1], [1, 2]]);
  const prims = roofPlanFigure(g.graph);
  assert.deepEqual(countByRole(prims), { outline: 1, ridge: 0, hip: 1, valley: 1 });
  assert.deepEqual(prims.find(p => p.role === 'hip').points, [4455, 4955, 2000, 2500], '外の角 (4000,4500) を軒先の角 (4455,4955) まで');
  assert.deepEqual(prims.find(p => p.role === 'valley').points, [4455, 3455, 2500, 1500], '入隅 (4000,3000) を軒先の入隅の角 (4455,3455) まで（平面は谷木も延ばす）');
});


test('roofPlanFigure: 切妻になる L字・棟違い・陸屋根は暫定で外形線だけ（棟木・隅木なし）', () => {
  const big = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  big.roof([[0, 0], [1, 0], [0, 1]]); // 自動で切妻になる L字
  assert.deepEqual(countByRole(roofPlanFigure(big.graph)), { outline: 1, ridge: 0, hip: 0, valley: 0 });
  for (const shape of [RoofShape.STAGGERED, RoofShape.FLAT, RoofShape.GABLE]) {
    const g = makeGrid([0, 2000, 4000, 6000], [0, 1500, 3000, 4500]);
    g.roof([[1, 1], [2, 1], [1, 2]], shape);
    assert.deepEqual(countByRole(roofPlanFigure(g.graph)), { outline: 1, ridge: 0, hip: 0, valley: 0 }, `L字・明示の ${shape}`);
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
  assert.deepEqual(outline.points, [2000, 1045, 6455, 1045, 6455, 3455, 2000, 3455]);
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
  g.interior([[0, 1]]); // 屋根（x 2000..6000・y 1500..3000）の左の辺 x=2000 に接する
  g.roof([[1, 1], [2, 1]]);
  const [bare] = roofPlanFigure(g.graph);
  assert.deepEqual(bare.points, [2000, 1045, 6455, 1045, 6455, 3455, 2000, 3455], '前提: 壁が無ければ通り芯（今までと同じ）');
  const wall = addWallOn(g.graph, g.cx[1], 75, true, g.cy[1], g.cy[2]); // x=2000 の壁。屋根側（+x）の外端は 2075
  assert.deepEqual(wall.materialRange, { lo: 2000, hi: 2075 }, '前提: 材は軸〜壁面');
  const [trimmed] = roofPlanFigure(g.graph);
  assert.equal(trimmed.role, 'outline');
  assert.equal(trimmed.closed, false);
  assert.deepEqual(trimmed.points, [2075, 1045, 6455, 1045, 6455, 3455, 2075, 3455], '両端（壁に当たる端）だけ x=2075 へ。軒先・けらばの角は不変');
  assert.equal(trimmed.key, bare.key, 'key は変わらない');
});

test('壁あり: 寄棟の下屋は壁側の隅木の端を外壁面まで戻す（45°に線に沿って）。棟木・壁に当たらない隅木は変えない', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.interior([[0, 0], [1, 0]]); // 屋根（y 4000..8000）の上辺 y=4000 に接する
  g.roof([[0, 1], [1, 1]], RoofShape.HIP);
  const before = roofPlanFigure(g.graph);
  const hipsBefore = before.filter(p => p.role === 'hip').map(p => p.points);
  assert.equal(hipsBefore.length, 4, '前提: 隅木4本');
  addWallOn(g.graph, g.cy[1], 75, false, g.cx[0], g.cx[2]); // y=4000 の壁。屋根側（+y）の外端は 4075
  const after = roofPlanFigure(g.graph);
  assert.equal(after.length, before.length, '線の数は変わらない');
  const moved = after.filter((p, i) => JSON.stringify(p.points) !== JSON.stringify(before[i].points));
  assert.deepEqual(moved.map(p => p.role).sort(), ['hip', 'hip', 'outline'], '変わるのは壁側の隅木2本と、外形線の壁に当たる端だけ');
  const hipsAfter = after.filter(p => p.role === 'hip').map(p => p.points);
  const wallSide = hipsBefore.filter(pts => pts.some((v, k) => k % 2 === 1 && v === 4000));
  assert.equal(wallSide.length, 2, '前提: 壁（y=4000）の上に端がある隅木が2本');
  for (const pts of wallSide) {
    const [x1, , x2, y2] = pts;
    const dx = Math.sign(x2 - x1);
    const moved1 = hipsAfter.find(h => Math.abs(h[0] - (x1 + dx * 75)) < 1e-6 && Math.abs(h[1] - 4075) < 1e-6);
    assert.ok(moved1, `隅木 ${pts} は壁側の端が (${x1 + dx * 75}, 4075) へ（45° に 75 戻る）`);
    assert.deepEqual(moved1.slice(2), [x2, y2], '反対側の端は変えない');
  }
  const ridge = after.find(p => p.role === 'ridge');
  assert.deepEqual(ridge.points, before.find(p => p.role === 'ridge').points, '棟木（壁に当たらない）は不変');
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
