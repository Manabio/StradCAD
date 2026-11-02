// 壁面上の床の段差の縦線（riser の CUT）の、床の段差の部位図（floorStep）の輪郭への差し替え
// （elevation/elevationJunction.js applyFloorStepSectionSwap。部分詳細図 S8b-3）。実グラフ（3 列×1 行・右列が部分指定の子）の
// 上辺の面（A）の床区間から layout を作って固定する。倍率ゲート（junctionSectionSwap）は band 側＝modes/ElevationModeState.floorStep.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DETAIL_SECTION_SWAP_MIN_DIFF_MM, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { applyFloorStepSectionSwap } from './elevationJunction.js';
import { buildRoomFaces } from './elevationFaces.js';
import { wallAdjacentFloorSegments, drawnRiserX } from './elevationFloorProfile.js';
import { halfWallThicknessMm } from './section/floorProfileMath.js';
import { line } from './elevationPrimitives.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { stepNoseFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_STEP } = DetailSlot;
const CUT = 'thick';

test.afterEach(() => clearOverlays());

// childFL: 子（右列）の床。assign: floorStep を持たせる部屋 'parent'|'child'|null
function setup(childFL, assign, figure = stepNoseFigure('k')) {
  setOverlay(DF, { user: [figure] });
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([cellKey(2, 3)]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  if (assign === 'parent') room.setDetailRefs({ [FLOOR_STEP]: 'k' });
  if (assign === 'child') child.setDetailRefs({ [FLOOR_STEP]: 'k' });
  const face = buildRoomFaces(room, graph).find(f => f.letter === 'A');
  const segs = wallAdjacentFloorSegments(face, room, graph);
  const riserX = segs.length > 1 ? drawnRiserX(segs, 0, halfWallThicknessMm(face)) : null;
  const layout = { faceRuns: [{ face, xCursor: 100, floorSegments: segs }] };
  const x = riserX === null ? null : 100 + riserX;
  const lo = Math.min(...segs.map(s => -s.floorDeltaMm));
  const hi = Math.max(...segs.map(s => -s.floorDeltaMm));
  const prims = () => (x === null ? [] : [line(100, hi, x, hi, { weight: CUT }), line(x, lo, x, hi, { weight: CUT })]);
  return { graph, room, child, face, segs, layout, x, lo, hi, prims, opts: { graph, room } };
}
const run = (s, over = {}) => {
  const primitives = s.prims();
  applyFloorStepSectionSwap(primitives, s.layout, { ...s.opts, ...over });
  return primitives;
};
const detail = prims => prims.filter(p => p.source === DETAIL_PRIM_SOURCE);

test('子が高い（+300）: riser が段鼻の輪郭（高い側の床起点・低い側＝左へ）に置き換わり、riser の縦線は残らない。輪郭の x は riser の描画 x を原点にする', () => {
  const s = setup(300, 'child');
  assert.equal(s.segs.length, 2);
  const out = run(s);
  const poly = detail(out);
  assert.equal(poly.length, 1);
  assert.equal(poly[0].type, 'polyline');
  assert.equal(poly[0].weight, CUT);
  const { x } = s;
  const hi = -300; // 高い側（子）の床
  assert.deepEqual(poly[0].points, [[x, hi], [x - 120, hi], [x - 120, hi + 40], [x - 30, hi + 40], [x - 30, hi + 70], [x, hi + 70], [x, 0]]);
  assert.deepEqual(out.filter(p => p.type === 'line' && p.x1 === x && p.x2 === x), [], '単純断面の riser は残らない');
  assert.equal(out.filter(p => p.type === 'line').length, 1, '床線（水平）は触らない');
});

test('親が高い（子 −300）: 低い側は右（+x）。輪郭の原点は親の床（y=0）で、段差高は 300', () => {
  const s = setup(-300, 'parent');
  const poly = detail(run(s));
  assert.equal(poly.length, 1);
  const { x } = s;
  assert.deepEqual(poly[0].points, [[x, 0], [x + 120, 0], [x + 120, 40], [x + 30, 40], [x + 30, 70], [x, 70], [x, 300]]);
});

test('形状差の閾値: 出 100 では差し替えず（> 100）、101 では差し替える。段差高が変われば輪郭の下端が追従する', () => {
  assert.equal(DETAIL_SECTION_SWAP_MIN_DIFF_MM, 100);
  const at100 = setup(300, 'child', stepNoseFigure('k', { overhang: 100 }));
  assert.deepEqual(run(at100), at100.prims(), '出 100 は単純断面のまま');
  const at101 = setup(300, 'child', stepNoseFigure('k', { overhang: 101 }));
  assert.equal(detail(run(at101)).length, 1);
  const tall = setup(450, 'child');
  assert.equal(detail(run(tall))[0].points.at(-1)[1], 0, '低い側の床まで');
  assert.equal(detail(run(tall))[0].points[0][1], -450);
});

test('【失敗系】差し替えない: 床の段差なし（区間 1 つ・同じ床高の境）・高い側でない部屋への割当て・割当て無し・参照切れ・段差高に合わない図・除外された面・段差見付け面', () => {
  const flat = setup(0, 'child');
  assert.equal(flat.segs.length, 1);
  assert.deepEqual(run(flat), [], '区間 1 つ');
  // 同じ床高の 2 区間（合成）
  const same = setup(300, 'child');
  same.layout.faceRuns[0].floorSegments = same.segs.map(s => ({ ...s, floorDeltaMm: 0 }));
  assert.deepEqual(run(same), same.prims(), '床が同じ高さの境には何も出ない');
  for (const [childFL, assign] of [[300, 'parent'], [-300, 'child'], [300, null]]) {
    const s = setup(childFL, assign);
    assert.deepEqual(run(s), s.prims(), `${childFL}/${assign}`);
  }
  const gone = setup(300, 'child');
  gone.child.setDetailRefs({ [FLOOR_STEP]: 'df-gone' });
  assert.deepEqual(run(gone), gone.prims(), '参照切れ');
  const tight = setup(60, 'child'); // 固定寸法の和（70）以下の段差高
  assert.deepEqual(run(tight), tight.prims());
  const ok = setup(300, 'child');
  assert.deepEqual(run(ok, { includeFace: () => false }), ok.prims(), '除外された面');
  ok.layout.faceRuns[0].face = { ...ok.face, kind: 'step' };
  assert.deepEqual(run(ok), ok.prims(), '段差見付け面自身の端は対象外');
  assert.doesNotThrow(() => applyFloorStepSectionSwap([], { faceRuns: [] }, { graph: null, room: null }));
});

// 高い側に同じ床高（+300）の部分指定の子が 2 つ並ぶ（B＝riser に接する・A＝遠い側）。連結された 1 区間の所有者は riser 側の子
function setupTwoHigh(letter, assign) {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const near = graph.addRoom(new Set([cellKey(1, 2)]), 'B', undefined, new Set([room.id]));
  const far = graph.addRoom(new Set([cellKey(2, 3)]), 'A', undefined, new Set([room.id]));
  near.setFloorLevel(300);
  far.setFloorLevel(300);
  ({ near, far })[assign]?.setDetailRefs({ [FLOOR_STEP]: 'k' });
  const face = buildRoomFaces(room, graph).find(f => f.letter === letter);
  const segs = wallAdjacentFloorSegments(face, room, graph);
  const x = 100 + drawnRiserX(segs, 0, halfWallThicknessMm(face));
  const prims = () => [line(x, -300, x, 0, { weight: CUT })];
  return { face, segs, layout: { faceRuns: [{ face, xCursor: 100, floorSegments: segs }] }, graph, room, prims };
}

test('高い側に同じ床高の部屋が 2 つ（riser 側が B・遠い側が A）: riser に接する B の割当てで差し替え、遠い A だけの割当てでは差し替えない（面 A・面 C）', () => {
  for (const letter of ['A', 'C']) {
    const none = setupTwoHigh(letter, null);
    assert.equal(none.segs.length, 2, `${letter}: 前提: 同じ床高の B・A の区間は連結されて 2 区間`);
    assert.equal(none.segs.filter(s => s.floorDeltaMm !== 0).length, 1);
    for (const [assign, swaps] of [['near', true], ['far', false]]) {
      const s = setupTwoHigh(letter, assign);
      const primitives = s.prims();
      applyFloorStepSectionSwap(primitives, s.layout, { graph: s.graph, room: s.room });
      assert.equal(detail(primitives).length, swaps ? 1 : 0, `${letter}/${assign}`);
    }
  }
  assert.deepEqual([setupTwoHigh('A', null).face.dirSign, setupTwoHigh('C', null).face.dirSign].sort(), [-1, 1], '面 A・C は dirSign が逆');
});

test('階段帯のレーン区間（flatLineSpanX を持つ区間）の境は riser を引かないので差し替えない', () => {
  const s = setup(300, 'child');
  s.layout.faceRuns[0].floorSegments = s.segs.map((seg, i) => (i === 0 ? { ...seg, flatLineSpanX: { lo: 0, hi: 100 } } : seg));
  assert.deepEqual(run(s), s.prims());
});
