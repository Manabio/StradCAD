// 部屋の取り合い（Room.detailRefs）の断面形への差し替え（elevation/elevationJunction.js applyJunctionSectionSwap と
// elevationPrimitives.js subtractCollinearSpans。部分詳細図 S8a-2）。合成 fixture（面 3 枚の最小 layout）で固定する。新 golden は作らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory, CenterLineType } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, PenDir, DETAIL_SECTION_SWAP_MIN_DIFF_MM, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { applyJunctionSectionSwap } from './elevationJunction.js';
import { subtractCollinearSpans, line } from './elevationPrimitives.js';
import { junctionFigure, fixedLen, move, baseboardFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_WALL, WALL_CEILING } = DetailSlot;
const CUT = 'thick';

test.afterEach(() => clearOverlays());
const install = (...figures) => setOverlay(DF, { user: figures });

const axisH = { id: 'ay0', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 };
const axisL = { id: 'ax0', centerLineType: CenterLineType.VERTICAL, effectiveValue: 0, value: 0 };
const axisR = { id: 'ax4000', centerLineType: CenterLineType.VERTICAL, effectiveValue: 4000, value: 4000 };
const wall = (axisCL, isVertical, c1, c2, thickness) => ({ axisCL, isVertical, coord1: c1, coord2: c2, materialRange: { lo: 0, hi: thickness }, backingRange: null });
const face = (axisCL, isVertical, over = {}) => ({
  axisCL, isVertical, inward: 1, faceValue: 0, lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0, startCLId: 's', endCLId: 'e', ...over,
});
const F = face(axisH, false);
const PL = face(axisL, true, { hi: 3000, run: 3000 });
const PR = face(axisR, true, { hi: 3000, run: 3000 });

function setup({ left = 100, right = 140, kneeDropWalls = new Map(), openings = [], figure = baseboardFigure('k', 150, 60), refs = { [FLOOR_WALL]: 'k' } } = {}) {
  install(figure);
  const graph = {
    openings, kneeDropWalls, shapeMap: new Map(),
    walls: [wall(axisL, true, 0, 3000, left), wall(axisR, true, 0, 3000, right), wall(axisH, false, 0, 4000, 100)],
  };
  const room = { detailRefs: refs };
  // 簡易な単純断面: 床・天井の CUT 線と両端の CUT 縦線
  const prims = () => [
    line(0, 0, 4000, 0, { weight: CUT }), line(0, -2400, 4000, -2400, { weight: CUT }),
    line(0, -2400, 0, 0, { weight: CUT }), line(4000, -2400, 4000, 0, { weight: CUT }),
  ];
  const layout = { faceRuns: [{ face: F, xCursor: 0, floorSegments: [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400 }] }] };
  const opts = { graph, room, segCeilAbsAt: () => 2400, neighborOf: (i, dir) => (dir < 0 ? PL : PR) };
  return { graph, room, prims, layout, opts };
}
const run = (s, over = {}) => {
  const primitives = s.prims();
  applyJunctionSectionSwap(primitives, s.layout, { ...s.opts, ...over });
  return primitives;
};
const detail = prims => prims.filter(p => p.source === DETAIL_PRIM_SOURCE);

test('subtractCollinearSpans: 同じ直線上の線から区間を差し引く（2 片に割れる・端を削る・全部消える・別の位置と斜めと別の線種は触らない）', () => {
  const v = line(0, -100, 0, 0, { weight: CUT });
  assert.deepEqual(subtractCollinearSpans([v], { axis: 'x', at: 0, lo: -60, hi: -40 }).map(p => [p.y1, p.y2]), [[-100, -60], [-40, 0]]);
  assert.deepEqual(subtractCollinearSpans([v], { axis: 'x', at: 0, lo: -60, hi: 0 }).map(p => [p.y1, p.y2]), [[-100, -60]]);
  assert.deepEqual(subtractCollinearSpans([v], { axis: 'x', at: 0, lo: -200, hi: 50 }), []);
  assert.deepEqual(subtractCollinearSpans([v], { axis: 'x', at: 0, lo: 10, hi: 50 }), [v], '区間に重ならなければそのまま');
  assert.deepEqual(subtractCollinearSpans([v], { axis: 'x', at: 5, lo: -60, hi: 0 }), [v], '別の位置の線は触らない');
  assert.deepEqual(subtractCollinearSpans([v], { axis: 'x', at: 0, lo: -60, hi: 0, weight: 'thin' }), [v], '別の線種は触らない');
  const slanted = line(0, -100, 10, 0, { weight: CUT });
  assert.deepEqual(subtractCollinearSpans([slanted], { axis: 'x', at: 0, lo: -100, hi: 0 }), [slanted], '斜めの線は触らない');
  // 向き（y1 > y2）も保つ。水平線は axis y
  const down = line(0, 0, 0, -100, { weight: CUT });
  assert.deepEqual(subtractCollinearSpans([down], { axis: 'x', at: 0, lo: -60, hi: 0 }).map(p => [p.y1, p.y2]), [[-60, -100]]);
  const h = line(0, 0, 400, 0, { weight: CUT });
  assert.deepEqual(subtractCollinearSpans([h], { axis: 'y', at: 0, lo: -10, hi: 150 }).map(p => [p.x1, p.x2]), [[150, 400]]);
});

test('左端・右端: 輪郭が CUT・source=detail の polyline になり、単純断面の縦線と床線の取り合い区間が消える（右端は鏡像）', () => {
  const out = run(setup());
  const poly = detail(out);
  assert.equal(poly.length, 2);
  assert.ok(poly.every(p => p.type === 'polyline' && p.weight === CUT));
  const left = poly.find(p => p.points[0][0] === 0);
  const right = poly.find(p => p.points[0][0] === 4000);
  assert.deepEqual(left.points, [[0, -60], [150, -60], [150, 0]]);
  assert.deepEqual(right.points, [[4000, -60], [3850, -60], [3850, 0]], '右端は x 方向に鏡像');
  const lines = out.filter(p => p.type === 'line');
  // 縦線: 取り合いの高さ [−60, 0] が消えて上側だけ残る（左右とも）
  assert.deepEqual(lines.filter(p => p.x1 === 0 && p.x2 === 0).map(p => [p.y1, p.y2]), [[-2400, -60]]);
  assert.deepEqual(lines.filter(p => p.x1 === 4000 && p.x2 === 4000).map(p => [p.y1, p.y2]), [[-2400, -60]]);
  // 床線: [0,150] と [3850,4000] が消える。天井線は触らない
  assert.deepEqual(lines.filter(p => p.y1 === 0 && p.y2 === 0).map(p => [p.x1, p.x2]), [[150, 3850]]);
  assert.deepEqual(lines.filter(p => p.y1 === -2400 && p.y2 === -2400).map(p => [p.x1, p.x2]), [[0, 4000]]);
});

test('形状差の閾値: D=100 では差し替えず（> 100）、101 では差し替える', () => {
  assert.equal(DETAIL_SECTION_SWAP_MIN_DIFF_MM, 100);
  const at100 = setup({ figure: baseboardFigure('k', 100, 60) });
  assert.deepEqual(run(at100), at100.prims(), 'D=100 は単純断面のまま');
  const at101 = setup({ figure: baseboardFigure('k', 101, 60) });
  assert.equal(detail(run(at101)).length, 2);
});

test('wallCeiling: 天井側の取り合いも差し替える（天井線と縦線の天井側が消え、輪郭は天井面から下へ）', () => {
  const ceilingBulge = junctionFigure('k', WALL_CEILING, [
    move(PenDir.DOWN, fixedLen(60)), move(PenDir.RIGHT, fixedLen(150)), move(PenDir.UP, fixedLen(60)),
  ], { closed: true });
  const s = setup({ figure: ceilingBulge, refs: { [WALL_CEILING]: 'k' } });
  const out = run(s);
  const left = detail(out).find(p => p.points[0][0] === 0 || p.points[p.points.length - 1][0] === 0);
  assert.ok(left);
  assert.deepEqual(left.points, [[150, -2400], [150, -2340], [0, -2340]]);
  const lines = out.filter(p => p.type === 'line');
  assert.deepEqual(lines.filter(p => p.x1 === 0 && p.x2 === 0).map(p => [p.y1, p.y2]), [[-2340, 0]]);
  assert.deepEqual(lines.filter(p => p.y1 === -2400 && p.y2 === -2400).map(p => [p.x1, p.x2]), [[150, 3850]]);
});

test('床段差のある端: 輪郭は端の床（y=−floorDelta）起点で、その高さの床 CUT 線の取り合い区間だけ消える', () => {
  const s = setup();
  s.layout.faceRuns[0].floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 300, chMm: 2400 }];
  const primitives = [
    line(0, -300, 4000, -300, { weight: CUT }), line(0, -2700, 4000, -2700, { weight: CUT }),
    line(0, -2700, 0, -300, { weight: CUT }), line(4000, -2700, 4000, -300, { weight: CUT }),
  ];
  applyJunctionSectionSwap(primitives, s.layout, { ...s.opts, segCeilAbsAt: () => 2700 });
  const left = detail(primitives).find(p => p.points[0][0] === 0);
  assert.deepEqual(left.points, [[0, -360], [150, -360], [150, -300]]);
  const lines = primitives.filter(p => p.type === 'line');
  assert.deepEqual(lines.filter(p => p.y1 === -300 && p.y2 === -300).map(p => [p.x1, p.x2]), [[150, 3850]]);
  assert.deepEqual(lines.filter(p => p.x1 === 0 && p.x2 === 0).map(p => [p.y1, p.y2]), [[-2700, -360]]);
});

test('【失敗系】勾配・円弧・上階天井の端の天井は wallCeiling を差し替えない（水平でない CUT 線は差し引けず二重になる）', () => {
  const ceilingBulge = junctionFigure('k', WALL_CEILING, [
    move(PenDir.DOWN, fixedLen(60)), move(PenDir.RIGHT, fixedLen(150)), move(PenDir.UP, fixedLen(60)),
  ], { closed: true });
  for (const seg of [
    { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2600 },
    { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 2000, chMm: 2800 } },
    { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, ceilFloorZMm: 2700 },
  ]) {
    const s = setup({ figure: ceilingBulge, refs: { [WALL_CEILING]: 'k' } });
    s.layout.faceRuns[0].floorSegments = [seg];
    assert.deepEqual(run(s), s.prims());
  }
  const flat = setup({ figure: ceilingBulge, refs: { [WALL_CEILING]: 'k' } });
  assert.equal(detail(run(flat)).length, 2, '対照: 水平天井は差し替える');
});

test('subtractCollinearSpans: 幅 0 の区間は線を割らず、元の配列を変えずにコピーを返す', () => {
  const v = line(0, -100, 0, 0, { weight: CUT });
  const input = [v];
  const out = subtractCollinearSpans(input, { axis: 'x', at: 0, lo: -50, hi: -50 });
  assert.deepEqual(out, [v]);
  assert.notEqual(out, input);
});

test('差し替えない端: 隅に開口が達する端・隣の面の隅の壁が腰壁・壁の無い端・開放スパンで延長された端', () => {
  const s = setup();
  const base = s.prims();
  // 隣の面 PL の隅（右端 y=3000 付近）に達する戸（PL 上。centerCoord=2800 幅 800 → 終端まで届く）
  const door = { id: 'd', isVertical: true, axisCL: { id: 'ax0' }, centerCoord: 2800, width: 800, height: 2000, sillHeight: 0, category: OpeningCategory.FITTING, subType: 'singleSwing' };
  const withDoor = setup({ openings: [door] });
  const out1 = run(withDoor);
  assert.deepEqual(detail(out1).map(p => p.points[0][0]), [4000], '左端（PL 側）は差し替えず、右端だけ差し替える');
  // PL の隅の壁が腰壁（kneeDropRecordFor 非 null）
  const shapes = new Map([['a', { value: 0 }], ['b', { value: 3000 }]]);
  const knee = setup({ kneeDropWalls: new Map([['ax0:a:b', { knee: { topHeight: 900 }, drop: null }]]) });
  knee.graph.shapeMap = new Map([...shapes, [axisL.id, axisL]]);
  assert.deepEqual(detail(run(knee)).map(p => p.points[0][0]), [4000], '腰壁の隅は差し替えない（左端）');
  // 壁の無い端・延長された端
  const noWall = { ...F, hasWallAtLocal0: false };
  s.layout.faceRuns[0].face = noWall;
  assert.deepEqual(detail(run(s)).map(p => p.points[0][0]), [4000], '壁の無い左端は差し替えない');
  s.layout.faceRuns[0].face = { ...F, extendedAtLocalRun: true };
  assert.deepEqual(detail(run(s)).map(p => p.points[0][0]), [0], '開放スパンで延長された右端は差し替えない');
  s.layout.faceRuns[0].face = F;
  assert.equal(detail(run(s)).length, 2, '対照: 条件を満たせば両端とも差し替える');
  assert.notDeepEqual(run(s), base);
});

test('【失敗系】隣の面の壁厚に合わない図・存在しないキー・割当て無し・neighbor 無し: 何も変えない', () => {
  // 固定 5mm＋伸縮（壁の中）＋室内側の出っ張り 150。壁厚 4 では FIXED_EXCEEDS_TARGET
  const bulgeBacked = junctionFigure('k', FLOOR_WALL, [
    move(PenDir.RIGHT, fixedLen(150)), move(PenDir.UP, fixedLen(60)), move(PenDir.LEFT, fixedLen(150)),
    move(PenDir.LEFT, fixedLen(5)), move(PenDir.LEFT, { mm: 50, mode: 'stretch' }),
  ], { endVertex: 5 });
  const ok = setup({ figure: bulgeBacked, left: 100, right: 4 });
  assert.deepEqual(detail(run(ok)).map(p => p.points[0][0]), [0], '右の隣の面（壁厚 4）は fit できず差し替えない・左は差し替える');
  const gone = setup({ refs: { [FLOOR_WALL]: 'gone' } });
  assert.deepEqual(run(gone), gone.prims());
  const none = setup({ refs: null });
  assert.deepEqual(run(none), none.prims());
  const noNeighbor = setup();
  assert.deepEqual(run(noNeighbor, { neighborOf: () => null }), noNeighbor.prims());
});
