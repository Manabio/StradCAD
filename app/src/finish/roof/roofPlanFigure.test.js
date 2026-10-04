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

test('壁あり: 寄棟の下屋は壁側の隅木の端を外壁面まで戻す（45°に線に沿って）。棟木・壁に当たらない隅木は変えない', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  g.interior([[0, 0], [1, 0]]); // 屋根（y 4000..8000）の上辺 y=4000 に接する
  g.roof([[0, 1], [1, 1]], RoofShape.HIP);
  const before = roofPlanFigure(g.graph);
  const hipsBefore = before.filter(p => p.role === 'hip').map(p => p.points);
  assert.equal(hipsBefore.length, 4, '前提: 隅木4本');
  addWallOn(g.graph, g.cy[1], 75, false, g.cx[0], g.cx[2]); // y=4000 の壁。屋根側（+y）の外端は 4075
  // 屋根の左右の辺は屋内の左右の辺と面一（建物の出隅）で、外形線の両端は建物側へ回り込む。回り込みの端が当たる左右の外壁（x=0・x=8000）
  addWallOn(g.graph, g.cx[0], -75, true, g.cy[0], g.cy[1]);
  addWallOn(g.graph, g.cx[2], 75, true, g.cy[0], g.cy[1]);
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

test('roofPlanFigure: 傾斜面の数（形状ごと）。片流れ1・切妻2・寄棟4・L字の寄棟6・L字の片流れ2。陸屋根・切妻になる L字・棟違いは 0', () => {
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
  assert.equal(count([[0, 0], [1, 0], [0, 1]], RoofShape.GABLE), 0, '切妻になる L字は外形線だけ');
  assert.equal(count([[0, 0], [1, 0], [0, 1]], RoofShape.FLAT), 0, '陸屋根の L字');
  // roof-test1 型の L字の片流れ: 屋内（上の左）に接し、水下が右と下の2面
  const l = makeGrid([3640, 7280, 9100], [-9884, -3640, 0]);
  l.interior([[0, 0]]);
  l.roof([[1, 0], [1, 1], [0, 1]]);
  const prims = roofPlanFigureAll(l.graph);
  assert.equal(arrowsOf(prims).length, 2);
  assert.ok(labelsOf(prims).length === 6 && labelsOf(prims).every(p => p.detailOnly === true));
});

test('roofPlanFigure: 傾斜面1つにつき1つ。屋内に全体が接する水下の面（壁へ向かって下る面）にもラベルを出す。矢印は壁の向き', () => {
  const full = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  full.interior([[0, 0], [1, 0]]); // 上の辺（y=4000）の全体が屋内に接する
  full.roof([[0, 1], [1, 1]], RoofShape.HIP);
  const fullArrows = arrowsOf(roofPlanFigureAll(full.graph));
  assert.equal(fullArrows.length, 4, '描いてある面を省かない（寄棟 4 面）');
  const towardWall = fullArrows.filter(a => a.points[0] === a.points[2] && a.points[3] < a.points[1]);
  assert.equal(towardWall.length, 1, '上の壁へ向かう（先端の y が小さい）縦の矢印が1つ');
  assert.ok(towardWall[0].points[3] > 4000 && towardWall[0].points[1] < 8000, '矢印は屋根範囲（y 4000..8000）の中');
  const part = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  part.interior([[0, 0]]); // 上の辺の半分（x 0..4000）だけ屋内に接する
  part.roof([[0, 1], [1, 1]], RoofShape.HIP);
  assert.equal(arrowsOf(roofPlanFigureAll(part.graph)).length, 4, '一部だけ接する水下の面は出す');
  const none = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  none.roof([[0, 1], [1, 1]], RoofShape.HIP);
  assert.equal(arrowsOf(roofPlanFigureAll(none.graph)).length, 4);
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
