// 外形線が建物の出隅を回り込む規則（ユーザー指示2026-10-04。roofFramingGeometry.js roofOutline・roofOutlineExposedPaths の interiorRects）のテスト。
// 屋根範囲の出隅 V で、屋内に接する辺 A（出幅 0）と出幅のある辺 B が出会い、V の対角が屋内でない（建物の出隅）なら、B を平行移動した線を
// V の先へ w（A が屋内に接していなければ持つ出幅＝A の種別の出幅）延ばして外壁の線へ直角に戻る。期待値は手計算（y は下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';
import { roofOutline, roofOutlineExposedPaths, eaveBeamCorners } from './roofFramingGeometry.js';
import { leanToFramingRegions, leanToPlanRegions, mainRoofFramingRegion } from './roofFramingRegions.js';
import { roofPlanFigure } from '../finish/roof/roofPlanFigure.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

const R = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const E = (isVertical, coord, lo, hi, outward, overhangMm) => ({ isVertical, coord, lo, hi, outward, overhangMm });
const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 屋根 x 4000..8000・y 0..3000 の切妻（棟は横。軒＝上下 600・けらば＝左右 300）。左の辺 x=4000 が屋内（左の建物）に接する
const ROOF = R(4000, 0, 8000, 3000);
const ZONE = [{ isVertical: true, coord: 4000, lo: 0, hi: 3000, outward: -1 }];
const BUILDING = R(0, 0, 4000, 3000); // 屋根の上下の辺と面一
const args = (extra = {}) => ({
  rects: [ROOF], shape: RoofShape.GABLE, ridgeIsVertical: false, highSide: null, eaveOverhangMm: 600, gableOverhangMm: 300,
  zeroZones: ZONE, kindZones: null, interiorRects: [BUILDING], tolMm: 0.5, ...extra,
});
const outlineOf = a => roofOutline(a).outline.map(l => l.points);
const exposedOf = a => roofOutlineExposedPaths(a).map(p => p.points);
const NO_WRAP_OUTLINE = [[8300, -600, 8300, 3600, 4000, 3600, 4000, -600]]; // 回り込みなし（今までの形）

test('(a) 対角が屋外（建物の出隅）: 両端で回り込む。w は A（屋内に接する辺）の種別の出幅（けらば 300。軒 600 ではない）', () => {
  assert.deepEqual(outlineOf(args({ interiorRects: null })), NO_WRAP_OUTLINE, '前提: 屋内の情報が無ければ今までの形');
  const a = args();
  // V=(4000,0)・(4000,3000)。B（上下の辺・軒 600）を左へ w=300 延ばして x=3700 で折り返し、外壁の線（y=0・y=3000）へ戻る
  assert.deepEqual(outlineOf(a), [[8300, -600, 8300, 3600, 3700, 3600, 3700, 3000, 4000, 3000, 4000, 0, 3700, 0, 3700, -600]]);
  // 平面: 壁の線の上を走る部分（V−w〜V）と屋内に接する辺は描かない。開いた折れ線で、両端は外壁の線の上
  assert.deepEqual(roofOutlineExposedPaths(a).map(p => p.closed), [false]);
  assert.deepEqual(exposedOf(a), [[3700, 0, 3700, -600, 8300, -600, 8300, 3600, 3700, 3600, 3700, 3000]]);
  // 棟を縦にすると A（左の辺）が軒になり、w は軒の出 600
  const v = args({ ridgeIsVertical: true });
  assert.deepEqual(outlineOf(v), [[8600, -300, 8600, 3300, 3400, 3300, 3400, 3000, 4000, 3000, 4000, 0, 3400, 0, 3400, -300]]);
  assert.deepEqual(exposedOf(v), [[3400, 0, 3400, -300, 8600, -300, 8600, 3300, 3400, 3300, 3400, 3000]]);
  // edges（辺の部分ごとの出幅）は回り込みで変わらない
  assert.deepEqual(roofOutline(a).edges.map(e => [e.isVertical, e.coord, e.lo, e.hi, e.outward, e.overhangMm]),
    [[false, 0, 4000, 8000, -1, 600], [true, 8000, 0, 3000, 1, 300], [false, 3000, 4000, 8000, 1, 600], [true, 4000, 0, 3000, -1, 0]]);
  assert.deepEqual(roofOutline(args({ interiorRects: null })).edges, roofOutline(a).edges);
});

test('(b) 対角が屋内（建物が V の先へ続く。壁が続く角）: 回り込まず今のまま', () => {
  const a = args({ interiorRects: [BUILDING, R(0, -3000, 4000, 0)] }); // 上の角 (4000,0) の対角（左上）にも屋内
  // 上の角は今のまま（B の線が x=4000 の壁に当たる）。下の角（建物の出隅）だけ回り込む
  assert.deepEqual(outlineOf(a), [[8300, -600, 8300, 3600, 3700, 3600, 3700, 3000, 4000, 3000, 4000, -600]]);
  assert.deepEqual(exposedOf(a), [[4000, -600, 8300, -600, 8300, 3600, 3700, 3600, 3700, 3000]]);
  const both = args({ interiorRects: [R(0, -3000, 4000, 6000)] }); // 屋根の上下とも建物が続く
  assert.deepEqual(outlineOf(both), NO_WRAP_OUTLINE);
});

test('(c) V の先の外壁が w より短い: 外壁の長さで止まる', () => {
  const a = args({ interiorRects: [R(3800, 0, 4000, 3000)] }); // 建物の幅（B の線に沿った長さ）200
  assert.deepEqual(outlineOf(a), [[8300, -600, 8300, 3600, 3800, 3600, 3800, 3000, 4000, 3000, 4000, 0, 3800, 0, 3800, -600]]);
});

test('(d) 対角側（B の外側の出幅の帯）に屋内が w より手前で現れる: そこまで', () => {
  const a = args({ interiorRects: [BUILDING, R(3000, -300, 3800, 0)] }); // 上の角の先 200 から、帯（y -600..0）に屋内
  // 上: 先 200 で止まる（x=3800）。下は影響なし（w=300）
  assert.deepEqual(outlineOf(a), [[8300, -600, 8300, 3600, 3700, 3600, 3700, 3000, 4000, 3000, 4000, 0, 3800, 0, 3800, -600]]);
});

test('(e) B の出幅 0・A が屋内に接しない（zeroZones なし）・B の外側以外は変わらない', () => {
  const zero = args({ eaveOverhangMm: 0 }); // 上下の辺（B）の出幅 0
  assert.deepEqual(outlineOf(zero), outlineOf({ ...zero, interiorRects: null }), 'B の出幅 0: 回り込みなし');
  const free = args({ zeroZones: [] }); // 屋内に接する区間なし（A の出幅は 300 のまま）
  assert.deepEqual(outlineOf(free), outlineOf({ ...free, interiorRects: null }), 'A が屋内に接しない: 回り込みなし');
  assert.deepEqual(roofOutlineExposedPaths(free).map(p => p.closed), [true]);
});

test('【失敗系】(j) 屋内のセル矩形が空・null・undefined・不正（非有限・逆順・配列でない）なら回り込みなし（今までの形・例外にしない）', () => {
  for (const bad of [[], null, undefined, [R(5, 5, 1, 1)], [{ x1: NaN, y1: 0, x2: 1, y2: 1 }], [null], 'x']) {
    const a = args({ interiorRects: bad });
    assert.doesNotThrow(() => roofOutline(a), JSON.stringify(bad));
    assert.deepEqual(outlineOf(a), NO_WRAP_OUTLINE, JSON.stringify(bad));
    assert.deepEqual(exposedOf(a), [[4000, -600, 8300, -600, 8300, 3600, 4000, 3600]], JSON.stringify(bad));
  }
});

// ---- 実形状（moku2-3 (1) 型の L字の片流れ。graph から） ----

/** 通り芯 X1..X5=0,3640,7280,10920,14560・Y4..Y1=-10010,-7280,-3640,0。2階の建物は X1..X4×Y3..Y1、下屋は上の腕（X3..X5×Y4..Y3）と右の腕（X4..X5×Y3..Y1）。 */
function moku231() {
  const graph = new PlanGraph(new Plane('p2', 0, '2階', 2, 1));
  const cx = [0, 3640, 7280, 10920, 14560].map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `X${i + 1}`));
  const cy = [-10010, -7280, -3640, 0].map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `Y${4 - j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  graph.addRoom(new Set([[0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]].map(([i, j]) => cell(i, j))), '居間');
  const room = graph.addRoom(new Set([[2, 0], [3, 0], [3, 1], [3, 2]].map(([i, j]) => cell(i, j))), '屋根');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.ROOF);
  room.setRoofSpec(createLeanToRoofSpec());
  return { graph, cx, cy, room };
}
const woodProject = () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  return project;
};

test('(g) L字の片流れ（moku2-3 (1) 型）: (X4,Y1) 型の角だけ回り込み、(X3,Y3) 型の角（Y3 の壁が X3 の左へ続く）は今のまま。伏図の外形線（閉じた線）', () => {
  const { graph } = moku231();
  const [region] = leanToFramingRegions(graph, woodProject());
  assert.equal(region.rect, null);
  assert.deepEqual(region.outline, [{ points: [15015, -10465, 15015, 455, 10465, 455, 10465, 0, 10920, 0, 10920, -7280, 6825, -7280, 6825, -10465] }],
    '(X4,Y1)=(10920,0) で軒の出 455 ぶん左へ延ばして Y1 の線へ戻る。(X3,Y3)=(7280,-7280) の先頭 (6825,-7280) は今のまま');
  // edges は変えない（母屋・棟木・隅木・谷木の延長・梁の延長 eaveBeamCorners の入力）
  assert.deepEqual(region.edges, [
    E(false, -10010, 7280, 14560, -1, 455), E(true, 14560, -10010, 0, 1, 455), E(false, 0, 10920, 14560, 1, 455),
    E(true, 10920, -7280, 0, -1, 0), E(false, -7280, 7280, 10920, 1, 0), E(true, 7280, -10010, -7280, -1, 455),
  ]);
  assert.deepEqual(eaveBeamCorners(region, 0.5), [
    { x: 7280, y: -10010, eaveIsVertical: false, extendMm: 455 }, { x: 14560, y: 0, eaveIsVertical: true, extendMm: 455 },
  ], '梁の延長の角は回り込みと無関係（変わらない）');
});

test('主屋根（屋内に接する辺が無い）は回り込みの対象外: 外形線は今までの4頂点の矩形', () => {
  const { graph } = moku231();
  const main = mainRoofFramingRegion(graph, woodProject());
  assert.ok(main, '前提: 主屋根の region がある');
  assert.equal(main.outline.length, 1);
  assert.equal(main.outline[0].points.length, 8, '4頂点（回り込みの点が入らない）');
});

test('(g2) 平面: 外形線の開いた折れ線が (X4,Y1) を回り込む。壁が無ければ通り芯の線 (10465,0)・Y3 の線 (6825,-7280) まで', () => {
  const { graph } = moku231();
  const [plan] = leanToPlanRegions(graph);
  assert.deepEqual(plan.exposedPaths, [{ points: [6825, -7280, 6825, -10465, 15015, -10465, 15015, 455, 10465, 455, 10465, 0], closed: false }]);
  assert.deepEqual(roofPlanFigure(graph).find(p => p.role === 'outline').points, [6825, -7280, 6825, -10465, 15015, -10465, 15015, 455, 10465, 455, 10465, 0], '壁が無ければ通り芯まで');
});

test('(h) 平面: 折り返しの線は Y1 の外壁の外面で止まる（製品の graph.addWall の壁）。(X3,Y3) 側は Y3 の壁の外面で止まる（今のまま）', () => {
  const { graph, cx, cy } = moku231();
  const south = graph.addWall(cy[3], 75, false, cx[0], 0, cx[3], 0, { wallFinish: 12.5 }); // Y1（y=0）の外壁。屋根側（+y）の外面 75
  const north = graph.addWall(cy[1], -75, false, cx[0], 0, cx[3], 0, { wallFinish: 12.5 }); // Y3（y=-7280）の外壁。屋根側（-y）の外面 -7355
  assert.deepEqual(south.materialRange, { lo: 0, hi: 75 }, '前提');
  assert.deepEqual(north.materialRange, { lo: -7355, hi: -7280 }, '前提');
  const outline = roofPlanFigure(graph).find(p => p.role === 'outline');
  assert.deepEqual(outline.points, [6825, -7355, 6825, -10465, 15015, -10465, 15015, 455, 10465, 455, 10465, 75]);
});
