// 天井の段差見付け面（face.ceilingSteps）に引く天井の段差の部位図（ceilingStep）の派生線（elevation/elevationJunction.js ceilingStepLineSpecs と
// elevationFigure.js appendStepFace の配線。部分詳細図 S8b-4b-2）。合成 fixture（持ち主のスタブ）と、実グラフの面（composeRoomFaces）で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DetailEdgeMark, PenDir, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { ceilingNoseFigure, ceilingStepFigure, stepNoseFigure, move, fixedLen, stretchLen } from '../finish/roomDetailTestFixtures.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { ceilingStepLineSpecs } from './elevationJunction.js';
import { buildFaceFigure } from './elevationFigure.js';
import { ElevationLineRole } from './elevationStyle.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { CEILING_STEP, FLOOR_STEP } = DetailSlot;
const BASE_CH = 2400;

test.afterEach(() => clearOverlays());

const install = (...figs) => setOverlay(DF, { user: figs });
const D = ElevationLineRole.DETAIL;

// ---- 合成（持ち主のスタブ） ----
const holder = (id, key, extra = {}) => ({ id, detailRefs: key ? { [CEILING_STEP]: key } : null, ceilingZones: [], ...extra });
const entry = (over = {}) => ({
  loX: 0, hiX: 1200, lowCeilAbsMm: 2100, ceilStepHeightMm: 300, beyondFloorDeltaMm: 0, lowSurface: { roomId: 'r', zoneId: null }, ...over,
});
const face = { kind: 'step' };

test('部屋の割当て: 段差 t（−40・−70）が低い側の天井から上向きの細線になる。縮尺 1/60 は実寸・分母未指定（100）は最小描画幅 50 へ調整（−40→−50）', () => {
  install(ceilingNoseFigure('k'));
  const graph = { rooms: [holder('r', 'k')] };
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), { graph, scaleDenom: 60 }), [{ t: -70, role: D }, { t: -40, role: D }]);
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), { graph }).map(s => s.t), [-70, -50]);
});

test('最小描画幅: 分母 300（最小 150）で −40・−70 は −150 の 1 本。調整後に |t|≥段差高 なら引かない', () => {
  install(ceilingNoseFigure('k'));
  const graph = { rooms: [holder('r', 'k')] };
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), { graph, scaleDenom: 300 }).map(s => s.t), [-150]);
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ ceilStepHeightMm: 150 }), { graph, scaleDenom: 300 }), [], '−150 は高い側の天井に重なる');
});

test('区画の割当て: 区画の ceilingStep を使う。区画に無く部屋にあるときは線を出さない（区画→部屋の継承なし）', () => {
  install(ceilingNoseFigure('k'));
  const zoned = (zoneKey, roomKey) => ({ rooms: [holder('r', roomKey, { ceilingZones: [holder('z', zoneKey)] })] });
  const lowSurface = { roomId: 'r', zoneId: 'z' };
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ lowSurface }), { graph: zoned('k', null), scaleDenom: 60 }).map(s => s.t), [-70, -40]);
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ lowSurface }), { graph: zoned(null, 'k'), scaleDenom: 60 }), []);
});

test('【失敗系】段差見付け面でない・持ち主が無い・区画が無い・割当て無し・参照切れ・段差高に合わない図は空。例外にしない', () => {
  install(ceilingNoseFigure('k'));
  const graph = { rooms: [holder('r', 'k')] };
  assert.deepEqual(ceilingStepLineSpecs({ kind: undefined }, entry(), { graph }), []);
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ lowSurface: undefined }), { graph }), []);
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ lowSurface: { roomId: 'x', zoneId: null } }), { graph }), [], '部屋が無い');
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ lowSurface: { roomId: 'r', zoneId: 'nozone' } }), { graph }), [], '区画が無い（部屋へ落とさない）');
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), { graph: { rooms: [holder('r', null)] } }), [], '割当て無し');
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), { graph: { rooms: [holder('r', 'df-gone')] } }), [], '参照切れ');
  assert.deepEqual(ceilingStepLineSpecs(face, entry({ ceilStepHeightMm: 60 }), { graph, scaleDenom: 60 }), [], '固定寸法の和（70）以下の段差高');
  assert.deepEqual(ceilingStepLineSpecs(null, entry(), { graph }), []);
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), {}), [], 'graph 無し');
});

test('空気との境目の印（air）の辺の端点は中線（SILHOUETTE）。印の無い段差は細線のまま', () => {
  const moves = [
    move(PenDir.RIGHT, fixedLen(120)), { ...move(PenDir.UP, fixedLen(40)), edge: DetailEdgeMark.AIR }, move(PenDir.LEFT, fixedLen(90)),
    move(PenDir.UP, fixedLen(30)), move(PenDir.LEFT, fixedLen(30)), move(PenDir.UP, stretchLen(100)),
  ];
  install(ceilingStepFigure('k', moves));
  const graph = { rooms: [holder('r', 'k')] };
  assert.deepEqual(ceilingStepLineSpecs(face, entry(), { graph, scaleDenom: 60 }), [
    { t: -70, role: D }, { t: -40, role: ElevationLineRole.SILHOUETTE },
  ]);
});

test('【失敗系】段差高が 0・負・NaN・Infinity なら空。例外にしない', () => {
  install(ceilingNoseFigure('k'));
  const graph = { rooms: [holder('r', 'k')] };
  for (const ceilStepHeightMm of [0, -300, NaN, Infinity]) {
    assert.deepEqual(ceilingStepLineSpecs(face, entry({ ceilStepHeightMm }), { graph, scaleDenom: 60 }), [], `段差高 ${ceilStepHeightMm}`);
  }
});

// ---- 実グラフ ----
/** 3 列×1 行の部屋 LDK。右列（x 4000〜6000）が低い天井: via 'zone'＝区画／'child'＝部分指定の子（床 childFL・CH rightCH）。 */
function setup({ via = 'zone', rightCH = 2100, childFL = 0, assign = null, floorAssign = false } = {}) {
  install(ceilingNoseFigure('k'), stepNoseFigure('f'));
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
    const { zones, zoneId } = createZone(graph, room, [cellKey(2, 3)], { heightMm: rightCH, shape: 'flat', dims: [] });
    room.setCeilingZones(zones);
    zone = zones.find(z => z.id === zoneId);
    if (assign === 'zone') room.setCeilingZones(room.ceilingZones.map(z => (z.id === zone.id
      ? new (z.constructor)({ ...z.toData(), detailRefs: { [CEILING_STEP]: 'k' } }) : z)));
  } else {
    child = graph.addRoom(new Set([cellKey(2, 3)]), '下がり天井', undefined, new Set([room.id]));
    child.setOverride('ceilingHeight', String(rightCH));
    if (childFL) child.setFloorLevel(childFL);
    if (assign === 'child') child.setDetailRefs({ [CEILING_STEP]: 'k' });
  }
  if (assign === 'room') room.setDetailRefs({ [CEILING_STEP]: 'k' });
  if (floorAssign) (child ?? room).setDetailRefs({ ...(child ?? room).detailRefs, [FLOOR_STEP]: 'f' });
  const steps = composeRoomFaces(room, graph).filter(f => f.kind === 'step');
  return { graph, room, child, zone, steps };
}
const ctxOf = (graph, scaleDenom) => ({
  graph: { openings: [], kneeDropWalls: new Map(), shapeMap: new Map(), rooms: graph.rooms }, scaleDenom,
  project: { openingNumberIndex: new Map() }, room: { getFinishInfo: () => ({}), finish: null },
  ceilingHeight: BASE_CH, materialMap: new Map(), gridCLs: [],
});
const detailLines = prims => prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE);

test('実グラフ（区画が低い側）: 区画に割当てがあると見付け下端 −2100 の 40・70 上に区間 [loX, hiX] の source=detail の水平線が出る', () => {
  const { graph, steps } = setup({ assign: 'zone' });
  assert.equal(steps.length, 1);
  const [f] = steps;
  const cs = f.ceilingSteps[0];
  const ls = detailLines(buildFaceFigure(f, ctxOf(graph, 60)));
  assert.deepEqual(ls.map(l => [l.x1, l.x2, l.y1, l.y2]).sort((a, b) => b[2] - a[2]), [
    [cs.loX, cs.hiX, -2140, -2140], [cs.loX, cs.hiX, -2170, -2170],
  ]);
  assert.ok(ls.every(l => l.weight === 'thin'), '自動の段差は細線');
  assert.ok(!ls.some(l => l.y1 === -2100 || l.y1 === -2400), 't≈0 と t≈−段差高 の線は無い');
});

test('実グラフ（部分指定の子＝小上がり＋下がり天井）: 床の面に合流した面で、床の派生線と天井の派生線が両方出る', () => {
  const { graph, steps } = setup({ via: 'child', childFL: 300, rightCH: 1800, assign: 'child', floorAssign: true });
  assert.equal(steps.length, 1);
  const [f] = steps;
  assert.equal(f.stepHeightMm, 300);
  assert.equal(f.ceilingSteps.length, 1);
  const ys = detailLines(buildFaceFigure(f, ctxOf(graph, 60))).map(l => l.y1).sort((a, b) => a - b);
  // 床: 高い側の床 y=−300 から下へ 40・70 ＝ −260・−230／天井: 見付け下端 −2100 から上へ 40・70 ＝ −2140・−2170
  assert.deepEqual(ys, [-2170, -2140, -260, -230]);
});

test('区間が面の一部（壁の無い端の島など）なら、線も区間 [loX, hiX] だけ。見付け下端の外（断面の天井以上）の区間には線を出さない', () => {
  install(ceilingNoseFigure('k'));
  const graph = { rooms: [holder('r', 'k')] };
  const stub = (over = {}) => ({
    axisCL: { id: 'axisY0', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 },
    isVertical: false, inward: 1, faceValue: 0, lo: 0, hi: 1200, run: 1200, dirSign: 1, originWorld: 0,
    startCLId: 'x0', endCLId: 'x1', label: 'C1', kind: 'step', baseFloorDeltaMm: 0, stepHeightMm: 0, ceilAbsMm: 2400, ...over,
  });
  const ctx = ctxOf({ rooms: graph.rooms }, 60);
  const ls = detailLines(buildFaceFigure(stub({ ceilingSteps: [entry({ loX: 300, hiX: 900 })] }), ctx));
  assert.deepEqual(ls.map(l => [l.x1, l.x2, l.y1]).sort((a, b) => b[2] - a[2]), [[300, 900, -2140], [300, 900, -2170]]);
  assert.deepEqual(detailLines(buildFaceFigure(stub({ ceilingSteps: [entry({ lowCeilAbsMm: 2400 })] }), ctx)), []);
});

test('実グラフ（区画に割当て無し・部屋だけ割当て）: 区画のセルの段差には線が出ない（継承なし）。出力は割当て無しと同じ', () => {
  const inherited = setup({ assign: 'room' });
  const none = setup({ assign: null });
  const out = s => buildFaceFigure(s.steps[0], ctxOf(s.graph, 60));
  assert.deepEqual(detailLines(out(inherited)), []);
  assert.deepEqual(out(inherited), out(none), '割当て無しの面は 8b-4b-1 の出力のまま');
});

test('実グラフ（参照切れ・段差高に合わない図）: 割当てがあっても出力は割当て無しと同じ', () => {
  const none = setup({ assign: null });
  const base = buildFaceFigure(none.steps[0], ctxOf(none.graph, 60));
  const gone = setup({ assign: 'zone' });
  clearOverlays();
  assert.deepEqual(buildFaceFigure(gone.steps[0], ctxOf(gone.graph, 60)), base, '参照切れ');
  const tooLow = setup({ assign: 'zone', rightCH: 2350 }); // 段差高 50（固定寸法の和 70 以下）
  const noneLow = setup({ assign: null, rightCH: 2350 });
  assert.deepEqual(buildFaceFigure(tooLow.steps[0], ctxOf(tooLow.graph, 60)), buildFaceFigure(noneLow.steps[0], ctxOf(noneLow.graph, 60)), '段差高に合わない');
});
