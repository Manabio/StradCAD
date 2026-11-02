// 壁面上の天井の段差の縦線の、天井の段差の部位図（ceilingStep）の輪郭への差し替え
// （elevation/elevationJunction.js applyCeilingStepSectionSwap。部分詳細図 S8b-4a）。実グラフ（3 列×1 行の部屋・右列が区画か部分指定の子）の
// 上辺の面（A）の床区間から layout を作って固定する。倍率ゲート（junctionSectionSwap）は band 側＝modes/ElevationModeState.ceilingStep.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DETAIL_SECTION_SWAP_MIN_DIFF_MM, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { applyCeilingStepSectionSwap } from './elevationJunction.js';
import { buildRoomFaces } from './elevationFaces.js';
import { wallAdjacentFloorSegments, drawnCeilingRiserX } from './elevationFloorProfile.js';
import { halfWallThicknessMm } from './section/floorProfileMath.js';
import { line } from './elevationPrimitives.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { ceilingNoseFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { CEILING_STEP } = DetailSlot;
const CUT = 'thick';
const BASE_CH = 2400;

test.afterEach(() => clearOverlays());

const segCeilAbsAt = s => (s.floorDeltaMm ?? 0) + s.chMm;

/**
 * 3 列×1 行（0-2000-4000-6000 × 0-3000）の部屋 LDK（CH 2400）。右列（x 4000〜6000）の天井:
 *   via 'zone'  … 区画（高さ rightCH・形状 shape）。assign: 'zone'＝区画に割当て／'room'＝部屋（残り）に割当て／null
 *   via 'child' … 部分指定の子（CH rightCH）。assign: 'child'／'room'／null。wall＝子との境界の CL（x=4000）に壁を立てる
 */
function setup({ via = 'zone', rightCH = 2100, assign = 'zone', figure = ceilingNoseFigure('k'), shape = 'flat', wall = false } = {}) {
  setOverlay(DF, { user: [figure] });
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', String(BASE_CH));
  let child = null;
  let zone = null;
  if (via === 'zone') {
    const dims = shape === 'slope' ? [500, 0] : [];
    const { zones, zoneId } = createZone(graph, room, [cellKey(2, 3)], { heightMm: rightCH, shape, dims });
    room.setCeilingZones(zones);
    zone = zones.find(z => z.id === zoneId);
  } else {
    child = graph.addRoom(new Set([cellKey(2, 3)]), '下がり天井', undefined, new Set([room.id]));
    child.setOverride('ceilingHeight', String(rightCH));
  }
  if (wall) {
    graph.addWall(xs[2], 0, true, y0, 0, y1, 0, { isRoomWall: false, isExteriorWall: false });
    if (typeof wall === 'object') graph.setKneeDropWall(edgeKey(xs[2].id, y0.id, y1.id), wall);
  }
  const set = (holder, on) => on && holder.setDetailRefs({ [CEILING_STEP]: 'k' });
  if (assign === 'zone' && zone) room.setCeilingZones(room.ceilingZones.map(z => (z.id === zone.id
    ? new (z.constructor)({ ...z.toData(), detailRefs: { [CEILING_STEP]: 'k' } }) : z)));
  set(room, assign === 'room');
  set(child ?? room, assign === 'child');
  const face = buildRoomFaces(room, graph).find(f => f.letter === 'A');
  const segs = wallAdjacentFloorSegments(face, room, graph);
  const layout = { faceRuns: [{ face, xCursor: 100, floorSegments: segs }] };
  const x = segs.length > 1 ? 100 + drawnCeilingRiserX(segs, 0, halfWallThicknessMm(face)) : null;
  const ys = segs.map(s => -segCeilAbsAt(s));
  const prims = () => (x === null ? [] : [line(x, Math.min(...ys), x, Math.max(...ys), { weight: CUT }), line(100, ys[0], x, ys[0], { weight: CUT })]);
  return { graph, room, child, zone, face, segs, layout, x, ys, prims, opts: { graph, room, segCeilAbsAt } };
}
const run = (s, over = {}) => {
  const primitives = s.prims();
  applyCeilingStepSectionSwap(primitives, s.layout, { ...s.opts, ...over });
  return primitives;
};
const detail = prims => prims.filter(p => p.source === DETAIL_PRIM_SOURCE);
// 既定の見切り（出 120・厚 40・見切り 30×30）を段差高 300 で fit した輪郭: 高い側（天井）の端 → 低い側の天井面。s 方向 sx を掛ける
const noseAt = (x, y, sx, H = 300) => [[x, y - H], [x, y - 70], [x + 30 * sx, y - 70], [x + 30 * sx, y - 40], [x + 120 * sx, y - 40], [x + 120 * sx, y], [x, y]];

test('区画が低い側（右列 2100・高い側は左の 2400）: 縦線が見切りの輪郭（高い側＝左へ出る・低い側の天井で面の続きを補う）に置き換わり、縦線は残らない。区画の境界はずらさない', () => {
  const s = setup();
  assert.equal(s.segs.length, 2);
  assert.equal(s.segs[0].zoneCeilEdgeHi, true, '前提: 区画の境界');
  assert.equal(s.x, 100 + s.segs[0].hiX, '区画の境界は壁が無いので描画 x をずらさない');
  const out = run(s);
  const poly = detail(out);
  assert.equal(poly.length, 1);
  assert.equal(poly[0].type, 'polyline');
  assert.equal(poly[0].weight, CUT);
  assert.deepEqual(poly[0].points, noseAt(s.x, -2100, -1));
  assert.deepEqual(out.filter(p => p.type === 'line' && p.x1 === s.x && p.x2 === s.x), [], '単純断面の縦線は残らない');
  assert.equal(out.filter(p => p.type === 'line').length, 1, '天井線（水平）は触らない');
});

test('部屋の残りが低い側（区画は右列 2700＝高い側が右）: 部屋の割当てで差し替わり、輪郭は右（高い側）へ出る', () => {
  const s = setup({ rightCH: 2700, assign: 'room' });
  const poly = detail(run(s));
  assert.equal(poly.length, 1);
  assert.deepEqual(poly[0].points, noseAt(s.x, -2400, 1));
});

test('部分指定の子が低い側（天井 2100）: 子の割当てで差し替わる。境界の描画 x は高い側へ半壁厚ずれる（drawnCeilingRiserX）', () => {
  const s = setup({ via: 'child', assign: 'child' });
  assert.equal(s.segs[0].zoneCeilEdgeHi, undefined);
  assert.equal(s.x, 100 + s.segs[0].hiX - halfWallThicknessMm(s.face), '高い側（左）へ半壁厚');
  const poly = detail(run(s));
  assert.equal(poly.length, 1);
  assert.deepEqual(poly[0].points, noseAt(s.x, -2100, -1));
});

test('形状差の閾値: 出 100 では差し替えず（> 100）、101 では差し替える。段差高が変われば輪郭の上端が追従する', () => {
  assert.equal(DETAIL_SECTION_SWAP_MIN_DIFF_MM, 100);
  const at100 = setup({ figure: ceilingNoseFigure('k', { overhang: 100 }) });
  assert.deepEqual(run(at100), at100.prims(), '出 100 は単純断面のまま');
  assert.equal(detail(run(setup({ figure: ceilingNoseFigure('k', { overhang: 101 }) }))).length, 1);
  const tall = setup({ rightCH: 1900 });
  const poly = detail(run(tall))[0];
  assert.equal(poly.points[0][1], -2400, '上端は高い側の天井');
  assert.equal(poly.points.at(-1)[1], -1900, '低い側の天井まで');
});

test('【失敗系】区画から部屋へ継承しない: 部屋にだけ割当てがあり区画（低い側）に無い／高い側の区画にだけ割当てがある場合は差し替えない', () => {
  const inherit = setup({ assign: 'room' }); // 低い側は区画（2100）。割当ては部屋（残り＝高い側）にだけ
  assert.deepEqual(run(inherit), inherit.prims(), '低い側の区画が空なら、部屋の割当てを継がない');
  const high = setup({ rightCH: 2700, assign: 'zone' }); // 区画は高い側。割当ては高い側の区画だけ
  assert.deepEqual(run(high), high.prims(), '高い側の持ち主の割当ては使わない');
  const none = setup({ assign: null });
  assert.deepEqual(run(none), none.prims(), '割当て無し');
});

test('【失敗系】G1 傾斜の区画は差し替えない（面が平面でない）。G3 低い側の chMm が持ち主の天井高と違う合成区間（階段の裏面等）も差し替えない', () => {
  const slope = setup({ shape: 'slope' });
  assert.deepEqual(run(slope), slope.prims());
  const synth = setup();
  synth.layout.faceRuns[0].floorSegments = synth.segs.map((seg, i) => (i === 1 ? { ...seg, chMm: 2000 } : seg));
  const primitives = synth.prims();
  applyCeilingStepSectionSwap(primitives, synth.layout, synth.opts);
  assert.deepEqual(primitives, synth.prims(), '区画の高さ 2100 と違う 2000 の区間');
  const tilted = setup();
  tilted.layout.faceRuns[0].floorSegments = tilted.segs.map((seg, i) => (i === 1 ? { ...seg, chHiMm: 2300 } : seg));
  const p2 = tilted.prims();
  applyCeilingStepSectionSwap(p2, tilted.layout, tilted.opts);
  assert.deepEqual(p2, tilted.prims(), '区間が傾いている');
  const upper = setup();
  upper.layout.faceRuns[0].floorSegments = upper.segs.map((seg, i) => (i === 1 ? { ...seg, ceilFloorZMm: 2700 } : seg));
  const p3 = upper.prims();
  applyCeilingStepSectionSwap(p3, upper.layout, upper.opts);
  assert.deepEqual(p3, upper.prims(), '上階の天井（多層書き）');
});

test('【失敗系】G2 区画の境界でない縦線で、境界の CL の上に壁が立てば差し替えない（垂れ壁等の管轄）。壁が無ければ差し替える', () => {
  const walled = setup({ via: 'child', assign: 'child', wall: true });
  assert.deepEqual(run(walled), walled.prims());
  const open = setup({ via: 'child', assign: 'child', wall: false });
  assert.equal(detail(run(open)).length, 1, '対照: 壁が無ければ差し替わる');
});

test('【失敗系】L1 区画の境界が CL と一致しその CL に全高の壁が立つなら差し替えない（垂れ壁等の管轄）。壁が無ければ差し替える', () => {
  const walled = setup({ wall: true });
  assert.equal(walled.segs[0].zoneCeilEdgeHi, true, '前提: 区画の境界');
  assert.deepEqual(run(walled), walled.prims());
  assert.equal(detail(run(setup({ wall: false }))).length, 1, '対照: 壁が無ければ差し替わる');
});

test('【失敗系】L2 腰壁だけの壁（垂れ壁なし）は天井まで届かないので壁とみなさず差し替える。垂れ壁のある壁は差し替えない', () => {
  const kneeOnly = setup({ via: 'child', assign: 'child', wall: { knee: { topHeight: 900 }, drop: null } });
  assert.equal(detail(run(kneeOnly)).length, 1, '腰壁だけ＝差し替える');
  const drop = setup({ via: 'child', assign: 'child', wall: { knee: null, drop: { bottomHeight: 400 } } });
  assert.deepEqual(run(drop), drop.prims(), '垂れ壁あり＝管轄外');
});

// 低い側に同じ天井高（2100）の部分指定の子が 2 つ並ぶ（near＝縦線に接する・far＝遠い側）。連結された 1 区間の持ち主は縦線に接する near
function setupTwoLow(assign) {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000, 8000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3), cellKey(3, 4)]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', String(BASE_CH));
  const near = graph.addRoom(new Set([cellKey(2, 3)]), 'near', undefined, new Set([room.id]));
  const far = graph.addRoom(new Set([cellKey(3, 4)]), 'far', undefined, new Set([room.id]));
  for (const r of [near, far]) r.setOverride('ceilingHeight', '2100');
  ({ near, far })[assign]?.setDetailRefs({ [CEILING_STEP]: 'k' });
  const face = buildRoomFaces(room, graph).find(f => f.letter === 'A');
  const segs = wallAdjacentFloorSegments(face, room, graph);
  const x = 100 + drawnCeilingRiserX(segs, 0, halfWallThicknessMm(face));
  const prims = () => [line(x, -2400, x, -2100, { weight: CUT })];
  return { segs, layout: { faceRuns: [{ face, xCursor: 100, floorSegments: segs }] }, graph, room, prims };
}

test('低い側に同じ天井高の子が 2 つ（縦線に接する near・遠い far）: near の割当てで差し替え、far だけの割当てでは差し替えない（探査点は縦線側の端）', () => {
  const none = setupTwoLow(null);
  assert.equal(none.segs.length, 2, '前提: 同じ天井高の near・far の区間は連結されて 2 区間');
  for (const [assign, swaps] of [['near', true], ['far', false]]) {
    const s = setupTwoLow(assign);
    const primitives = s.prims();
    applyCeilingStepSectionSwap(primitives, s.layout, { graph: s.graph, room: s.room, segCeilAbsAt });
    assert.equal(detail(primitives).length, swaps ? 1 : 0, assign);
  }
});

test('【失敗系】差し替えない: 天井の段差なし（区間 1 つ・同じ高さ）・参照切れ・段差高に合わない図・除外された面・段差見付け面・graph/room null', () => {
  const flat = setup({ rightCH: BASE_CH });
  assert.equal(flat.segs.length, 1);
  assert.deepEqual(run(flat), [], '区画の高さが部屋と同じなら区間 1 つ');
  const gone = setup();
  gone.room.setCeilingZones(gone.room.ceilingZones.map(z => new (z.constructor)({ ...z.toData(), detailRefs: { [CEILING_STEP]: 'df-gone' } })));
  assert.deepEqual(run(gone), gone.prims(), '参照切れ');
  const tight = setup({ rightCH: 2400 - 60 }); // 固定寸法の和（70）以下の段差高
  assert.deepEqual(run(tight), tight.prims());
  const ok = setup();
  assert.deepEqual(run(ok, { includeFace: () => false }), ok.prims(), '除外された面');
  ok.layout.faceRuns[0].face = { ...ok.face, kind: 'step' };
  assert.deepEqual(run(ok), ok.prims(), '段差見付け面自身の端は対象外');
  assert.doesNotThrow(() => applyCeilingStepSectionSwap([], { faceRuns: [] }, { graph: null, room: null, segCeilAbsAt }));
});
