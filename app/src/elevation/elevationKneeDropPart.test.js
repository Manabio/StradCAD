// 腰壁の天端・垂れ壁の下端の部分詳細図（記録の detailRefs の kneeTop・dropBottom。部分詳細図 S8b-1）の展開図への派生線:
// 実グラフ（LDK 0..4000×0..3000 ／ 和室 同幅×3000..6000。y=3000 の間仕切りに腰壁・垂れ壁の記録）で buildRoomBand の出力を固定する。
// 新 golden は作らない（elevationSectionGolden.test.js の makeTwoRoomsWithKneeSpan と同型の合成 fixture）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DETAIL_PRIM_SOURCE, KneeDropFrontSide } from '../core/constants.js';
import detailBuiltins, { KNEE_CAP_20_KEY } from '../detail/detailBuiltins.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { frontOnlyCapFigure, partFigure, move, fixedLen, paramLen } from '../finish/roomDetailTestFixtures.js';
import { PenDir, DetailParam } from '../core/constants.js';
import { buildRoomBand } from './elevationBand.js';
import { kneeDropPartStepsOf } from './elevationJunction.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { KNEE_TOP, DROP_BOTTOM } = DetailSlot;
const KNEE_CAP = detailBuiltins.find(f => f.key === KNEE_CAP_20_KEY);

test.afterEach(() => clearOverlays());

const V = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const H = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
function twoRooms(rec) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = V(graph, 0), x1 = V(graph, 4000), y0 = H(graph, 0), ym = H(graph, 3000), y1 = H(graph, 6000);
  const ldk = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, ldk);
  const wa = graph.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '和室');
  generateRoomWallsFromOutline(graph, wa);
  graph.setKneeDropWall(edgeKey(ym.id, x0.id, x1.id), rec);
  return { graph, ldk, wa };
}
// 縮尺の分母 20（1/20）では最小描画幅 0.5×20＝10mm が天板厚 20 を下回るので 20 のまま。分母未指定（100）は 50 へ引き上げる（2026-11-02 裁定）
const CTX = { project: { openingNumberIndex: new Map() }, scaleDenom: 20 };
const CTX_DEFAULT = { project: { openingNumberIndex: new Map() } };
const band = (room, graph, ctx = CTX) => buildRoomBand(room, graph, ctx).primitives;
const derived = prims => prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE);
const KNEE = { knee: { topHeight: 800 }, drop: null };

test('厚 30 の天板（1/20）: 腰壁の面（LDK 側＝表の側）に天端から 30 下の細線（source=detail）。既存の天端の下の細線（20）も残る', () => {
  setOverlay(DF, { user: [frontOnlyCapFigure('df-cap30', 30)] });
  const { graph, ldk } = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-cap30' } });
  const prims = band(ldk, graph);
  const d = derived(prims);
  assert.ok(d.length >= 1, '派生線が引かれる');
  assert.ok(d.every(p => p.y1 === -770 && p.y2 === -770 && p.weight === 'thin'), JSON.stringify(d));
  assert.ok(prims.some(p => p.type === 'line' && p.source === undefined && p.y1 === -780 && p.y2 === -780), '既存の kneeCapUnderline（20）は残る（両方引く）');
});

test('厚 30 の天板（分母未指定＝100）: 30 は最小描画幅 50 へ引き上がり、既存の天端の下の細線（50）に重なって派生線は別に残らない', () => {
  setOverlay(DF, { user: [frontOnlyCapFigure('df-cap30', 30)] });
  const { graph, ldk } = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-cap30' } });
  const prims = band(ldk, graph, CTX_DEFAULT);
  assert.equal(prims.filter(p => p.type === 'line' && p.y1 === -770 && p.y2 === -770).length, 0, '調整前の高さ（30 下）には線が無い');
  assert.ok(prims.some(p => p.type === 'line' && p.y1 === -750 && p.y2 === -750 && p.weight === 'thin'), '50 下の細線（既存と重なって 1 本）');
});

test('組込み天板（厚 20）: 分母 100 でも 20 でも既存の天端の下の細線と重なり、割当て無しの帯と同じ出力（線が 1 本に見える）', () => {
  setOverlay(DF, { user: [KNEE_CAP] });
  const none = twoRooms(KNEE);
  const withRef = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } });
  for (const ctx of [CTX, CTX_DEFAULT]) {
    const a = band(withRef.ldk, withRef.graph, ctx).filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.x1 !== p.x2);
    const b = band(none.ldk, none.graph, ctx).filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.x1 !== p.x2);
    assert.deepEqual(a.map(p => [p.y1, p.x1, p.x2]), b.map(p => [p.y1, p.x1, p.x2]), `scaleDenom=${ctx.scaleDenom}`);
  }
});

test('裏の面は鏡像: 天板の出幅が表の側にだけある図は、表の側の部屋（LDK）に段差の線が出て、裏の側（和室）には出ない。表の側を替えると逆になる', () => {
  setOverlay(DF, { user: [frontOnlyCapFigure('df-cap', 60)] });
  const rec = { ...KNEE, detailRefs: { [KNEE_TOP]: 'df-cap' } };
  const a = twoRooms(rec);
  assert.ok(derived(band(a.ldk, a.graph)).length >= 1, 'roomNeg が表（既定）= LDK に出る');
  assert.equal(derived(band(a.wa, a.graph)).length, 0, '裏の側（和室）には出ない');
  const b = twoRooms({ ...rec, frontSide: KneeDropFrontSide.ROOM_POS });
  assert.equal(derived(band(b.ldk, b.graph)).length, 0, '表の側を roomPos（和室）にすると LDK は裏の面');
  assert.ok(derived(band(b.wa, b.graph)).length >= 1);
});

test('垂れ壁の下端: 天井から下端までの寸法 bottomHeight の壁の下端から上へ（床から 2000 の下端 → t=−20 で 2020）', () => {
  const dropFig = partFigure('df-drop', DROP_BOTTOM, [
    move(PenDir.UP, fixedLen(20)), move(PenDir.LEFT, fixedLen(12)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
    move(PenDir.DOWN, fixedLen(20)),
  ], { sVertex: 2, tVertex: 0 });
  setOverlay(DF, { user: [dropFig] });
  const { graph, ldk } = twoRooms({ knee: null, drop: { bottomHeight: 400 }, detailRefs: { [DROP_BOTTOM]: 'df-drop' } });
  const d = derived(band(ldk, graph));
  assert.ok(d.length >= 1, JSON.stringify(d));
  assert.ok(d.every(p => p.y1 === -2020 && p.weight === 'thin'), JSON.stringify(d.map(p => [p.y1, p.weight])));
});

test('垂れ壁の下端（分母未指定＝100）: 派生線の t=−20 は最小描画幅 50 へ引き上がり、下端から 50 上（床から 2050）', () => {
  const dropFig = partFigure('df-drop', DROP_BOTTOM, [
    move(PenDir.UP, fixedLen(20)), move(PenDir.LEFT, fixedLen(12)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
    move(PenDir.DOWN, fixedLen(20)),
  ], { sVertex: 2, tVertex: 0 });
  setOverlay(DF, { user: [dropFig] });
  const { graph, ldk } = twoRooms({ knee: null, drop: { bottomHeight: 400 }, detailRefs: { [DROP_BOTTOM]: 'df-drop' } });
  const d = derived(band(ldk, graph, CTX_DEFAULT));
  assert.ok(d.length >= 1, JSON.stringify(d));
  assert.ok(d.every(p => p.y1 === -2050 && p.weight === 'thin'), JSON.stringify(d.map(p => [p.y1, p.weight])));
});

test('【失敗系】参照切れの割当て・割当て無しの記録・腰壁の値の無い記録の kneeTop: 線を出さず、出力は割当て無しとバイト一致', () => {
  setOverlay(DF, { user: [KNEE_CAP] });
  const none = twoRooms(KNEE);
  const base = JSON.stringify(band(none.ldk, none.graph));
  const gone = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-gone' } });
  assert.equal(JSON.stringify(band(gone.ldk, gone.graph)), base);
  // 垂れ壁だけの記録に kneeTop の割当ては残らない（setKneeDropWall が落とす）＝割当て無しと同じ
  const dropOnly = twoRooms({ knee: null, drop: { bottomHeight: 400 }, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } });
  assert.equal(Object.hasOwn(dropOnly.graph.kneeDropWalls.values().next().value, 'detailRefs'), false);
});

test('kneeDropPartStepsOf: 割当てが 1 つも無い graph は null（関数自体を渡さない）。割当てがあれば関数。自階（self）以外の層の壁・記録に掛からない列は null', () => {
  setOverlay(DF, { user: [KNEE_CAP] });
  const none = twoRooms(KNEE);
  assert.equal(kneeDropPartStepsOf({ graph: none.graph }), null);
  assert.equal(kneeDropPartStepsOf({ graph: null }), null);
  const { graph } = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } });
  const fn = kneeDropPartStepsOf({ graph, scaleDenom: 20 });
  assert.equal(typeof fn, 'function');
  const wall = graph.walls.find(w => w.axisCL.effectiveValue === 3000 && !w.isVertical);
  const col = { worldLo: 1000, worldHi: 2000 };
  const cut = { viewSign: 1 };
  assert.deepEqual(fn({ wall, layerRole: 'self' }, col, cut).kneeTop, [{ t: 20, weight: 'auto' }]);
  assert.deepEqual(kneeDropPartStepsOf({ graph })({ wall, layerRole: 'self' }, col, cut).kneeTop, [{ t: 50, weight: 'auto' }], '分母未指定＝100 は最小描画幅 50');
  assert.equal(fn({ wall, layerRole: 'above' }, col, cut), null, '他階の層の腰壁は先送り');
  assert.equal(fn({ layerRole: 'self' }, col, cut), null, '壁の無い帯');
  assert.equal(fn({ wall, layerRole: 'self' }, { worldLo: 9000, worldHi: 9500 }, cut), null, '記録の区間の外');
});
