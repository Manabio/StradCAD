// 帯の端の腰壁・垂れ壁の切断面を部位図（kneeTop／dropBottom）の輪郭へ差し替える（elevation/elevationJunction.js applyKneeDropSectionSwap と
// joinPartOutlines。部分詳細図 S8b-2）。合成 fixture（面 1 枚の最小 layout。elevationJunctionSwap.test.js と同じ流儀）で固定する。新 golden は作らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OpeningCategory, CenterLineType, Discipline, Plane, PlanGraph, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand } from './elevationBand.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import {
  DetailSlot, DetailParam, PenDir, KneeDropFrontSide, DETAIL_SECTION_SWAP_MIN_DIFF_MM, DETAIL_PRIM_SOURCE,
} from '../core/constants.js';
import { applyJunctionSectionSwap, applyKneeDropSectionSwap, joinPartOutlines } from './elevationJunction.js';
import { line } from './elevationPrimitives.js';
import { partFigure, paramLen, fixedLen, move, baseboardFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { KNEE_TOP, DROP_BOTTOM, FLOOR_WALL } = DetailSlot;
const CUT = 'thick';
const DETAIL = 'thin';
const MEDIUM = 'medium';

test.afterEach(() => clearOverlays());
const install = (...figures) => setOverlay(DF, { user: figures });

const axisH = { id: 'ay3000', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 3000, value: 3000 };
const axisL = { id: 'ax0', centerLineType: CenterLineType.VERTICAL, effectiveValue: 0, value: 0 };
const axisR = { id: 'ax4000', centerLineType: CenterLineType.VERTICAL, effectiveValue: 4000, value: 4000 };
const wall = (axisCL, isVertical, c1, c2, thickness) => ({ axisCL, isVertical, coord1: c1, coord2: c2, materialRange: { lo: 0, hi: thickness }, backingRange: null });
const face = (axisCL, isVertical, over = {}) => ({
  axisCL, isVertical, inward: 1, faceValue: 0, lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0, startCLId: 's', endCLId: 'e', ...over,
});
// F は y=3000 の通り芯の壁の部屋側（y<3000。仕上げ面 2942.5）。両側の P（x=0・x=4000 の縦の壁）はこの F の端（y=3000）で突き当たる
const F = face(axisH, false, { faceValue: 2942.5, inward: -1 });
const PL = face(axisL, true, { hi: 3000, run: 3000 });
const PR = face(axisR, true, { hi: 3000, run: 3000 });

// 腰壁 800（天端）／垂れ壁 下端 600（天井から）の記録。detailRefs は図のキー 'k'
const kneeRec = (over = {}) => ({ knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'k' }, ...over });
const dropRec = (over = {}) => ({ knee: null, drop: { bottomHeight: 600 }, detailRefs: { [DROP_BOTTOM]: 'k' }, ...over });

/** 表の側へ front・裏の側へ back 出る天板（厚 thick。腰壁の天端）。頂点 (front,0)→(front,thick)→(0,thick)→(−W,thick)→(−W−back,thick)→(−W−back,0)。 */
const capFigure = (front = 150, back = 12, thick = 30) => partFigure('k', KNEE_TOP, [
  move(PenDir.DOWN, fixedLen(thick)), move(PenDir.LEFT, fixedLen(front)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
  move(PenDir.LEFT, fixedLen(back)), move(PenDir.UP, fixedLen(thick)),
], { sVertex: 2, tVertex: 0 });
/** 垂れ壁の下端に垂れる幕板（厚 thick。t は下端から上が負）。頂点 (front,0)→(front,−thick)→(0,−thick)→(−W,−thick)→(−W−back,−thick)→(−W−back,0)。 */
const hangFigure = (front = 150, back = 12, thick = 30) => partFigure('k', DROP_BOTTOM, [
  move(PenDir.UP, fixedLen(thick)), move(PenDir.LEFT, fixedLen(front)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
  move(PenDir.LEFT, fixedLen(back)), move(PenDir.DOWN, fixedLen(thick)),
], { sVertex: 2, tVertex: 0 });

function setup({ left = 100, right = 140, recL = kneeRec(), recR = null, openings = [], figure = capFigure(), extraFigures = [], room = null, wallsL = null } = {}) {
  install(figure, ...extraFigures);
  const kneeDropWalls = new Map();
  if (recL) kneeDropWalls.set('ax0:a:b', recL);
  if (recR) kneeDropWalls.set('ax4000:a:b', recR);
  const graph = {
    openings, kneeDropWalls,
    shapeMap: new Map([['a', { value: 0 }], ['b', { value: 3000 }], [axisL.id, axisL], [axisR.id, axisR]]),
    walls: [...(wallsL ?? [wall(axisL, true, 0, 3000, left)]), wall(axisR, true, 0, 3000, right), wall(axisH, false, 0, 4000, 100)],
  };
  // 簡易な単純断面: 床・天井の CUT 線と両端の CUT 縦線。左右の端の腰壁の断面の列（天端の CUT 水平線と向こう側の面の CUT 縦線）と、
  // 天端の下の細線（kneeCapUnderline＝DETAIL。差し替えても残す）。左端には全高の中線（断面エンジンの recess の SILHOUETTE）も立つ
  const prims = () => [
    line(0, -2400, 0, 0, { weight: MEDIUM }), line(-left, -2400, -left, 0, { weight: MEDIUM }),
    line(0, 0, 4000, 0, { weight: CUT }), line(0, -2400, 4000, -2400, { weight: CUT }),
    line(0, -2400, 0, 0, { weight: CUT }), line(4000, -2400, 4000, 0, { weight: CUT }),
    line(-left, -800, 0, -800, { weight: CUT }), line(-left, -800, -left, 0, { weight: CUT }), line(-left, -750, 0, -750, { weight: DETAIL }),
    line(4000, -800, 4000 + right, -800, { weight: CUT }), line(4000 + right, -800, 4000 + right, 0, { weight: CUT }), line(4000, -750, 4000 + right, -750, { weight: DETAIL }),
  ];
  const layout = { faceRuns: [{ face: F, xCursor: 0, floorSegments: [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400 }] }] };
  const opts = { graph, segCeilAbsAt: () => 2400, neighborOf: (i, dir) => (dir < 0 ? PL : PR) };
  return { graph, room, prims, layout, opts };
}
const run = (s, over = {}) => {
  const primitives = s.prims();
  applyKneeDropSectionSwap(primitives, s.layout, { ...s.opts, ...over });
  return primitives;
};
const polys = prims => prims.filter(p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE);
const linesAt = (prims, x, weight = CUT) => prims.filter(p => p.type === 'line' && p.x1 === x && p.x2 === x && p.weight === weight).map(p => [p.y1, p.y2]).sort((a, b) => a[0] - b[0]);
const hLinesAt = (prims, y, weight = CUT) => prims.filter(p => p.type === 'line' && p.y1 === y && p.y2 === y && p.weight === weight).map(p => [p.x1, p.x2]);

test('左端の腰壁（天端 800・壁厚 100・部屋側出 150／反対側出 12・厚 30）: 輪郭 1 本が CUT・source=detail、天端の水平線と縦線の [770,800] が消える', () => {
  // 左端は P の正側の部屋の側から見る。表の側を ROOM_POS にして部屋側＝表の側（出 150）
  const s = setup({ recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) });
  const out = run(s);
  const ps = polys(out);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].weight, CUT);
  // 部屋側の輪郭を端から（出 150・厚 30）、天端で折り返して壁の向こう側（−壁厚−12）の面へ。端 x=0・y=−800
  assert.deepEqual(ps[0].points, [[0, -770], [150, -770], [150, -800], [-112, -800], [-112, -770], [-100, -770]]);
  assert.deepEqual(linesAt(out, 0), [[-2400, -800], [-770, 0]], '端の縦線: 天端側 [770,800] が消え、下は残る');
  assert.deepEqual(linesAt(out, -100), [[-770, 0]], '向こう側の面の縦線も天端側が消える');
  assert.deepEqual(hLinesAt(out, -800), [[4000, 4140]], '左端の天端の CUT 水平線は輪郭が担う（右端の列は触らない）');
  assert.deepEqual(hLinesAt(out, -750, DETAIL), [[-100, 0], [4000, 4140]], '天端の下の細線（kneeCapUnderline）は両端とも残す');
  assert.deepEqual(linesAt(out, 4000), [[-2400, 0]], '右端は記録が無いので触らない');
});

test('端の全高の中線（SILHOUETTE。断面エンジンの recess）も天端側 [770,800] が割れる（差し替え後に断面の中へ残らない）', () => {
  const out = run(setup({ recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) }));
  assert.deepEqual(linesAt(out, 0, MEDIUM), [[-2400, -800], [-770, 0]]);
  assert.deepEqual(linesAt(out, -100, MEDIUM), [[-2400, -800], [-770, 0]]);
  assert.deepEqual(linesAt(out, 0, DETAIL), [], '細線は元から無い（触らない対象の確認）');
});

test('記録の境目が F の通り芯と同じ位置（隅の一片 2942.5..3057.5 はどちらの記録の構成壁でもない）: F の部屋の側の壁の記録で差し替わる', () => {
  const wallsL = [wall(axisL, true, 0, 2942.5, 100), wall(axisL, true, 2942.5, 3057.5, 100), wall(axisL, true, 3057.5, 6000, 100)];
  const s = setup({ wallsL, recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) });
  const ps = polys(run(s));
  assert.equal(ps.length, 1, '左端だけ（右端の記録は無い）');
  assert.equal(ps[0].points[0][0], 0);
});

test('向こう側の面は向こう側の部屋の床まで CUT の縦線で下ろす（腰壁。向こう側の床が F より低い／高い）', () => {
  const frontPos = { recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) };
  const lower = run(setup(frontPos), { farExtentOf: () => ({ floorDeltaMm: -300, ceilAbsMm: 2100 }) });
  assert.deepEqual(linesAt(lower, -100), [[-770, 300]], '向こう側の面: 天板の下 −770 から向こう側の床 +300 まで');
  const lineOf = lower.find(p => p.type === 'line' && p.x1 === -100 && p.weight === CUT);
  assert.equal(lineOf.source, DETAIL_PRIM_SOURCE);
  const higher = run(setup(frontPos), { farExtentOf: () => ({ floorDeltaMm: 300, ceilAbsMm: 2700 }) });
  assert.deepEqual(linesAt(higher, -100), [[-770, -300], [-300, 0]], '向こう側の床 −300 まで（その下は元の断面の線が残る）');
  assert.deepEqual(linesAt(lower, 0), [[-2400, -800], [-770, 0]], '端の縦線は変えない（向こう側の部屋の床の影響を受けない）');
});

test('向こう側の面は垂れ壁なら向こう側の部屋の天井面まで上げる', () => {
  const s = setup({ recL: dropRec({ frontSide: KneeDropFrontSide.ROOM_POS }), figure: hangFigure() });
  const prims = () => [
    line(0, 0, 4000, 0, { weight: CUT }), line(0, -2400, 4000, -2400, { weight: CUT }),
    line(0, -2400, 0, 0, { weight: CUT }), line(4000, -2400, 4000, 0, { weight: CUT }),
    line(-100, -1800, 0, -1800, { weight: CUT }), line(-100, -2400, -100, -1800, { weight: CUT }),
  ];
  const high = prims();
  applyKneeDropSectionSwap(high, s.layout, { ...s.opts, farExtentOf: () => ({ floorDeltaMm: 0, ceilAbsMm: 2700 }) });
  assert.deepEqual(linesAt(high, -100), [[-2700, -1830]]);
  const low = prims();
  applyKneeDropSectionSwap(low, s.layout, { ...s.opts, farExtentOf: () => ({ floorDeltaMm: 0, ceilAbsMm: 2000 }) });
  assert.deepEqual(linesAt(low, -100), [[-2400, -2000], [-2000, -1830]]);
});

test('右端（鏡像）: 輪郭は x 方向に反転し、向こう側の面は帯の外側（x=4000+壁厚）', () => {
  // 右端は P の負側の部屋の側から見る。既定の表の側（ROOM_NEG）なら部屋側＝表の側
  const s = setup({ recL: null, recR: kneeRec() });
  const out = run(s);
  const ps = polys(out);
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].points, [[4000, -770], [3850, -770], [3850, -800], [4152, -800], [4152, -770], [4140, -770]]);
  assert.deepEqual(linesAt(out, 4000), [[-2400, -800], [-770, 0]]);
  assert.deepEqual(linesAt(out, 4140), [[-770, 0]]);
  assert.deepEqual(hLinesAt(out, -800), [[-100, 0]], '右端の天端の CUT 水平線は消える（左端の列は触らない）');
  assert.deepEqual(hLinesAt(out, -750, DETAIL), [[-100, 0], [4000, 4140]]);
});

test('見る側と表の側が違えば鏡像: 部屋側の出は図の裏の側の 12・反対側が 150', () => {
  // 左端は ROOM_POS 側から見る。表の側が既定（ROOM_NEG）なら部屋側は裏の側（12）、壁の向こうが 150
  const out = run(setup());
  assert.deepEqual(polys(out)[0].points, [[0, -770], [12, -770], [12, -800], [-250, -800], [-250, -770], [-100, -770]]);
});

test('垂れ壁（dropBottom）: 下端（天井 2400−600）の側が差し引かれ、輪郭は下端で折り返す', () => {
  const s = setup({ recL: dropRec({ frontSide: KneeDropFrontSide.ROOM_POS }), figure: hangFigure() });
  const prims = () => [
    line(0, 0, 4000, 0, { weight: CUT }), line(0, -2400, 4000, -2400, { weight: CUT }),
    line(0, -2400, 0, 0, { weight: CUT }), line(4000, -2400, 4000, 0, { weight: CUT }),
    line(-100, -1800, 0, -1800, { weight: CUT }), line(-100, -2400, -100, -1800, { weight: CUT }),
  ];
  const primitives = prims();
  applyKneeDropSectionSwap(primitives, s.layout, s.opts);
  const ps = polys(primitives);
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].points, [[0, -1830], [150, -1830], [150, -1800], [-112, -1800], [-112, -1830], [-100, -1830]]);
  assert.deepEqual(linesAt(primitives, 0), [[-2400, -1830], [-1800, 0]], '下端側 [1800,1830] が消える');
  assert.deepEqual(linesAt(primitives, -100), [[-2400, -1830]]);
  assert.deepEqual(hLinesAt(primitives, -1800), []);
});

test('腰壁・垂れ壁の両方に割当て: 2 本の輪郭が重なって差し引かれる（腰壁は下の天端・垂れ壁は上の下端）', () => {
  const kneeFig = capFigure();
  const dropFig = { ...hangFigure(), key: 'kd' };
  const s = setup({ recL: { knee: { topHeight: 800 }, drop: { bottomHeight: 600 }, detailRefs: { [KNEE_TOP]: 'k', [DROP_BOTTOM]: 'kd' } }, figure: kneeFig, extraFigures: [dropFig] });
  const out = run(s);
  const tops = polys(out).map(p => p.points.map(q => q[1]).sort((a, b) => a - b)[0]).sort((a, b) => a - b);
  assert.deepEqual(tops, [-1830, -800], '垂れ壁の輪郭の最上点 −1830・腰壁の輪郭の最上点 −800');
});

test('形状差の閾値: 両側の大きい方が 100 では差し替えず（> 100）、101 では差し替える', () => {
  assert.equal(DETAIL_SECTION_SWAP_MIN_DIFF_MM, 100);
  const at100 = setup({ figure: capFigure(100, 12) });
  assert.deepEqual(run(at100), at100.prims(), '形状差 100 は単純断面のまま');
  const at101 = setup({ figure: capFigure(101, 12) });
  assert.equal(polys(run(at101)).length, 1);
  // 反対側の大きい方で判定する（部屋側 12・反対側 150 でも差し替わる＝見る側に依らない）
  const farOnly = setup({ figure: capFigure(12, 150), recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) });
  assert.equal(polys(run(farOnly)).length, 1);
});

test('組込み天板相当（出 12・形状差 12）は差し替えない', () => {
  const builtinLike = setup({ figure: capFigure(12, 12, 20) });
  assert.deepEqual(run(builtinLike), builtinLike.prims());
});

test('差し替えない端: 隅に開口が達する端・壁の無い端・開放スパンで延長された端', () => {
  const door = { id: 'd', isVertical: true, axisCL: { id: 'ax0' }, centerCoord: 2800, width: 800, height: 2000, sillHeight: 0, category: OpeningCategory.FITTING, subType: 'singleSwing' };
  const withDoor = setup({ openings: [door] });
  assert.deepEqual(run(withDoor), withDoor.prims(), '左端の隅に戸が達する');
  const s = setup();
  s.layout.faceRuns[0].face = { ...F, hasWallAtLocal0: false };
  assert.deepEqual(run(s), s.prims(), '壁の無い左端');
  s.layout.faceRuns[0].face = { ...F, extendedAtLocal0: true };
  assert.deepEqual(run(s), s.prims(), '開放スパンで延長された左端');
  s.layout.faceRuns[0].face = F;
  assert.equal(polys(run(s)).length, 1, '対照: 条件を満たせば差し替える');
});

test('【失敗系】割当て無し・存在しない図のキー・記録に値が無い・隣の面が無い・記録が隅に無い: 何も変えない', () => {
  const noRefs = setup({ recL: { knee: { topHeight: 800 }, drop: null } });
  assert.deepEqual(run(noRefs), noRefs.prims(), 'detailRefs 無し');
  const gone = setup({ recL: kneeRec({ detailRefs: { [KNEE_TOP]: 'gone' } }) });
  assert.deepEqual(run(gone), gone.prims(), '参照切れ（片側だけ解決できることは無い＝同じ図の fit と鏡像）');
  const noKnee = setup({ recL: { knee: null, drop: { bottomHeight: 600 }, detailRefs: { [KNEE_TOP]: 'k' } } });
  assert.deepEqual(run(noKnee), noKnee.prims(), '腰壁の値が無い記録の kneeTop は引かない');
  const noNeighbor = setup();
  assert.deepEqual(run(noNeighbor, { neighborOf: () => null }), noNeighbor.prims());
  const noRecords = setup({ recL: null });
  assert.deepEqual(run(noRecords), noRecords.prims(), '記録が無ければ junction 側の規則のまま');
  // 記録は壁の別の区間（隅の位置 y=3000 の外）にあるだけ
  const elsewhere = setup();
  elsewhere.graph.shapeMap.set('b', { value: 1000 });
  assert.deepEqual(run(elsewhere), elsewhere.prims(), '隅に掛からない記録');
});

test('隅に掛からない記録（同じ壁の離れた区間）は junction の差し替えを止めない／腰壁の差し替えも出ない', () => {
  const room = { detailRefs: { [FLOOR_WALL]: 'kb' } };
  const s = setup({ extraFigures: [baseboardFigure('kb', 150, 60)], room });
  s.graph.shapeMap.set('b', { value: 1000 }); // 記録は P の壁 0..3000 のうち 0..1000 だけ。隅（3000）は全高
  const primitives = s.prims();
  applyJunctionSectionSwap(primitives, s.layout, { ...s.opts, room });
  const left = polys(primitives).filter(p => p.points[0][0] === 0);
  assert.equal(left.length, 1, '左端は junction の輪郭 1 本');
  assert.deepEqual(left[0].points, [[0, -60], [150, -60], [150, 0]]);
  applyKneeDropSectionSwap(primitives, s.layout, s.opts);
  assert.equal(polys(primitives).filter(p => p.points[0][0] === 0).length, 1, '腰壁の差し替えは足されない');
});

test('向こう側の部屋が引けない（farExtentOf が null）ときは縦線が F の床まで下りる', () => {
  const s = setup({ recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) });
  s.layout.faceRuns[0].floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 300, chMm: 2400 }];
  const primitives = [
    line(0, -2700, 0, -300, { weight: CUT }), line(-100, -1100, 0, -1100, { weight: CUT }), line(-100, -1100, -100, -300, { weight: CUT }),
  ];
  applyKneeDropSectionSwap(primitives, s.layout, { ...s.opts, segCeilAbsAt: () => 2700, farExtentOf: () => null });
  assert.deepEqual(linesAt(primitives, -100), [[-1070, -300]], 'F の床 y=−300 まで');
});

test('垂れ壁は水平でない天井の端では差し替えない（勾配・円弧・上階天井の CUT 線は水平でない）', () => {
  const rec = dropRec({ frontSide: KneeDropFrontSide.ROOM_POS });
  for (const seg of [
    { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2600 },
    { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, ceilArc: { alongX: 2000, chMm: 2800 } },
    { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, ceilFloorZMm: 2700 },
  ]) {
    const s = setup({ recL: rec, figure: hangFigure() });
    s.layout.faceRuns[0].floorSegments = [seg];
    assert.deepEqual(run(s), s.prims());
  }
});

test('床段差のある端: 腰壁の天端は床段差込み（y=−(800+300)）', () => {
  const s = setup({ recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }) });
  s.layout.faceRuns[0].floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 300, chMm: 2400 }];
  const primitives = [
    line(0, -2700, 0, -300, { weight: CUT }), line(-100, -1100, 0, -1100, { weight: CUT }), line(-100, -1100, -100, -300, { weight: CUT }),
  ];
  applyKneeDropSectionSwap(primitives, s.layout, { ...s.opts, segCeilAbsAt: () => 2700 });
  assert.deepEqual(polys(primitives)[0].points[0], [0, -1070]);
  assert.deepEqual(linesAt(primitives, 0), [[-2700, -1100], [-1070, -300]]);
});

test('junction との両立: 腰壁の端は腰壁の差し替え・腰壁でない端は junction の差し替え（同じ端で二重にならない）', () => {
  const room = { detailRefs: { [FLOOR_WALL]: 'kb' } };
  const s = setup({ recL: kneeRec({ frontSide: KneeDropFrontSide.ROOM_POS }), extraFigures: [baseboardFigure('kb', 150, 60)], room });
  const primitives = s.prims();
  applyJunctionSectionSwap(primitives, s.layout, { ...s.opts, room });
  applyKneeDropSectionSwap(primitives, s.layout, s.opts);
  const ps = polys(primitives);
  assert.equal(ps.length, 2);
  const left = ps.find(p => p.points[0][0] === 0);
  const right = ps.find(p => p.points[0][0] === 4000);
  assert.deepEqual(left.points[0], [0, -770], '左端（腰壁）は腰壁の輪郭');
  assert.deepEqual(right.points, [[4000, -60], [3850, -60], [3850, 0]], '右端（腰壁でない）は junction の輪郭');
  // 順序を入れ替えても同じ（junction は腰壁の端を飛ばし、腰壁の差し替えは junction が飛ばす端だけ）
  const reversed = s.prims();
  applyKneeDropSectionSwap(reversed, s.layout, s.opts);
  applyJunctionSectionSwap(reversed, s.layout, { ...s.opts, room });
  assert.equal(polys(reversed).length, 2);
});

test('joinPartOutlines: 腰壁は天端（t=0）で折り返し、厚の違う側は壁の面に沿って最大の t まで延ばす', () => {
  // 部屋側 厚 30（出 150）・反対側 厚 20（出 12）
  const joined = joinPartOutlines([[150, 0], [150, 30], [0, 30]], [[12, 0], [12, 20], [0, 20]], 100, true);
  assert.deepEqual(joined, [[0, 30], [150, 30], [150, 0], [-112, 0], [-112, 20], [-100, 20], [-100, 30]]);
  // 垂れ壁: 下端（t=0）で折り返す（t は上が負）
  const drop = joinPartOutlines([[0, -30], [150, -30], [150, 0]], [[0, -30], [12, -30], [12, 0]], 100, false);
  assert.deepEqual(drop, [[0, -30], [150, -30], [150, 0], [-112, 0], [-112, -30], [-100, -30]]);
});

// 実グラフ: LDK 0..4000×0..3000 ／ 洋室 4000..7000×0..1500 ／ 納戸 同×1500..3000。仕切り壁 x=4000 の y 0..1500 に腰壁（天端 800）の記録
// （区間の境目 1500 は洋室の南面の通り芯と同位置）。洋室の帯の左端（北面・南面の西端）が腰壁の端
function threeRooms({ ldkFloorLevel = null, ldkCeiling = '2700' } = {}) {
  const V = v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = V(0), x1 = V(4000), x2 = V(7000), y0 = H(0), yb = H(1500), y1 = H(3000);
  const ldk = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  const yoshitsu = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${yb.id}`]), '洋室');
  const nando = graph.addRoom(new Set([`${x1.id}:${yb.id}:${x2.id}:${y1.id}`]), '納戸');
  for (const r of [ldk, yoshitsu, nando]) r.setOverride('ceilingHeight', r === ldk ? ldkCeiling : '2400');
  if (ldkFloorLevel !== null) ldk.setFloorLevel(ldkFloorLevel);
  for (const r of [ldk, yoshitsu, nando]) generateRoomWallsFromOutline(graph, r);
  return { graph, yoshitsu, key: edgeKey(x1.id, y0.id, yb.id) };
}
const CTX = { project: { openingNumberIndex: new Map() }, scaleDenom: 20, junctionSectionSwap: true };

test('配線（buildRoomBand）: junctionSectionSwap で端の腰壁が輪郭 polyline 1 本ずつ＋向こう側（LDK）の床まで下ろす縦線になる。割当て無し・2 パス目でなければ出力不変', () => {
  install(capFigure());
  const { graph, yoshitsu, key } = threeRooms({ ldkFloorLevel: -150 });
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'k' }, frontSide: KneeDropFrontSide.ROOM_POS });
  const prims = buildRoomBand(yoshitsu, graph, CTX).primitives;
  const outlines = prims.filter(p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === CUT);
  assert.equal(outlines.length, 2, '洋室の北面の西端・南面の西端');
  // 向こう側（LDK。床が洋室より 150 低い）の縦線: 天板の下（−770）から LDK の床 y=+150 まで。連なる 1 本
  const far = prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE && p.weight === CUT);
  assert.equal(far.length, 2);
  for (const p of far) {
    assert.equal(p.x1, p.x2);
    assert.deepEqual([p.y1, p.y2].sort((a, b) => a - b), [-770, 150]);
  }
  const noSwap = buildRoomBand(yoshitsu, graph, { ...CTX, junctionSectionSwap: false }).primitives;
  assert.equal(noSwap.filter(p => p.source === DETAIL_PRIM_SOURCE && p.weight === CUT).length, 0, '2 パス目でなければ差し替えない');
});

test('配線（実グラフ）: 仕切り壁 x=4000 の y 0..1500 だけに腰壁があるとき、LDK の南面の東端（y=3000。全高）は junction の差し替えが出る', () => {
  install(baseboardFigure('kb', 150, 60));
  const { graph, key } = threeRooms();
  const ldk = [...graph.rooms.values()].find(r => r.name === 'LDK');
  ldk.setDetailRefs({ [FLOOR_WALL]: 'kb' });
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: null });
  const swapped = buildRoomBand(ldk, graph, CTX).primitives.filter(p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === CUT);
  const unswapped = buildRoomBand(ldk, graph, { ...CTX, junctionSectionSwap: false }).primitives.filter(p => p.source === DETAIL_PRIM_SOURCE && p.weight === CUT);
  assert.equal(unswapped.length, 0);
  // 7 本＝全高の端すべて。隅の判定を壁全体の述語（kneeDropRecordFor）に戻すと南面の東端 x=7400 が腰壁扱いになり 6 本に減る（検出力）。
  assert.equal(swapped.length, 7, `全高の端はすべて junction の輪郭（実測 ${swapped.length} 本）`);
  assert.ok(swapped.some(p => p.points[0][0] === 7400), '南面の東端（x=7400。腰壁 500..1400 と同じ壁の一片の隅）も junction の輪郭が出る');
});

test('配線: 垂れ壁の記録なら向こう側（LDK）の天井面（2700）まで上げる', () => {
  install(hangFigure());
  const { graph, yoshitsu, key } = threeRooms();
  graph.setKneeDropWall(key, { knee: null, drop: { bottomHeight: 600 }, detailRefs: { [DROP_BOTTOM]: 'k' }, frontSide: KneeDropFrontSide.ROOM_POS });
  const prims = buildRoomBand(yoshitsu, graph, CTX).primitives;
  const far = prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE && p.weight === CUT);
  assert.ok(far.length >= 1);
  for (const p of far) assert.deepEqual([p.y1, p.y2].sort((a, b) => a - b), [-2700, -1830]);
});

test('配線: 割当ての無い記録は何も変えない（junctionSectionSwap でも出力が同じ）', () => {
  const { graph, yoshitsu, key } = threeRooms();
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: null });
  assert.deepEqual(buildRoomBand(yoshitsu, graph, CTX).primitives, buildRoomBand(yoshitsu, graph, { ...CTX, junctionSectionSwap: false }).primitives);
});

test('配線: 腰壁の差し替えは junction の差し替えと同じ ctx.junctionSectionSwap の中だけで呼ばれる（2 パス目のみ）', () => {
  const src = fs.readFileSync(new URL('./elevationBand.js', import.meta.url), 'utf8');
  const block = src.match(/if \(ctx\.junctionSectionSwap === true\) \{([\s\S]*?)\r?\n {2}\}\r?\n/);
  assert.ok(block, 'ctx.junctionSectionSwap のブロックがある');
  assert.match(block[1], /applyJunctionSectionSwap\(/);
  assert.match(block[1], /applyKneeDropSectionSwap\(/);
  assert.equal((src.match(/applyKneeDropSectionSwap\(/g) ?? []).length, 1, 'ブロックの外では呼ばない');
});
