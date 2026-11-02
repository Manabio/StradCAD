// 天井の段差（CeilingZone／Room.detailRefs の ceilingStep。部分詳細図 S8b-4a）の基準供給・包絡線の定義域・解決/fit・通知の集計・段差高の供給
// （finish/roomDetailTargets.js ceilingStepTargets・detail/detailEnvelope.js・finish/partDetail.js・ceiling/ceilingSurfaces.js ceilingStepHeightsByOwner・
// ceiling/ceilingStepRefs.js）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingZone } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { PenDir, DetailSlot, DetailDatumRole, DetailDatumKind, DetailAxis } from '../core/constants.js';
import { fitLocal, computeEnvelope, EnvelopeWeight } from '../detail/detailPlacement.js';
import { ceilingStepTargets, floorStepTargets, RoomDetailError } from './roomDetailTargets.js';
import {
  resolveCeilingStepFigure, fitCeilingStepPart, ceilingStepEnvelope, collectCeilingStepFailures,
} from './partDetail.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_PART_CEILING_STEP, detailOwnerRoom, detailOwnerCeilingZone } from '../error.js';
import { ceilingNoseFigure, ceilingStepFigure, stepNoseFigure, baseboardFigure, move, fixedLen, stretchLen } from './roomDetailTestFixtures.js';
import { ceilingStepHeightsByOwner } from '../ceiling/ceilingSurfaces.js';
import { ceilingStepSelects, isCeilingStepEditable, zonesAfterCeilingStepSelect } from '../ceiling/ceilingStepRefs.js';
import { makeGrid } from '../plan/planTestFixtures.js';
import { createZone, updateZoneSpec } from '../ceiling/ceilingZones.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { CEILING_STEP, FLOOR_STEP } = DetailSlot;
const holder = (extra = {}) => ({ id: 'h', name: '玄関', detailRefs: { [CEILING_STEP]: 'k' }, ...extra });

test.afterEach(() => clearOverlays());

test('ceilingStepTargets: s は STEP_EDGE の origin 0・t は CEILING_FACE の origin 0（低い側）と end＝−段差高（高い側。t は下向き正）。param なし', () => {
  const t = ceilingStepTargets(ceilingNoseFigure('k'), { stepHeightMm: 300 });
  assert.deepEqual(t.targets.datums, { ds0: 0, dt0: 0, dt1: -300 });
  assert.deepEqual(t.targets.params, {});
  assert.equal(ceilingStepTargets(ceilingNoseFigure('k'), { stepHeightMm: 450 }).targets.datums.dt1, -450, '段差高に追従');
});

test('【失敗系】ceilingStepTargets: 供給外の組（FL を使った図・壁の仕上げ面・STEP_EDGE の end・t 軸の STEP_EDGE）は UNSUPPORTED_DATUM。段差高が数値でなければ INVALID_STEP_HEIGHT', () => {
  const fig = ceilingNoseFigure('k');
  const withDatum = d => ({ ...fig, datums: [...fig.datums, d] });
  const wall = ceilingStepTargets(withDatum({ id: 'dx', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.END, offsetMm: 0 }), { stepHeightMm: 300 });
  assert.equal(wall.error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(wall.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('dx', `${DetailDatumRole.WALL_FINISH_FACE}・${DetailAxis.S}・${DetailDatumKind.END}`, DETAIL_TARGET_PART_CEILING_STEP));
  for (const d of [
    { id: 'dx', role: DetailDatumRole.STEP_EDGE, axis: DetailAxis.S, kind: DetailDatumKind.END, offsetMm: 0 },
    { id: 'dx', role: DetailDatumRole.STEP_EDGE, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dx', role: DetailDatumRole.CEILING_FACE, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  ]) {
    assert.equal(ceilingStepTargets(withDatum(d), { stepHeightMm: 300 }).error.code, RoomDetailError.UNSUPPORTED_DATUM, JSON.stringify(d));
  }
  // FL を t の基準にした図（床の段差の図）は天井の段差には使えない。逆も同じ
  const floorFig = stepNoseFigure('kf');
  assert.equal(ceilingStepTargets(floorFig, { stepHeightMm: 300 }).error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(floorStepTargets(fig, { stepHeightMm: 300 }).error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(ceilingStepTargets(baseboardFigure('df-fw'), { stepHeightMm: 300 }).error.code, RoomDetailError.UNSUPPORTED_DATUM);
  for (const bad of [NaN, undefined, '300', Infinity, 0, -300]) {
    assert.equal(ceilingStepTargets(fig, { stepHeightMm: bad }).error.code, RoomDetailError.INVALID_STEP_HEIGHT, String(bad));
  }
  assert.doesNotThrow(() => ceilingStepTargets(null, { stepHeightMm: 300 }));
});

test('包絡線の定義域: ceilingStep は t<0（低い側の天井面より上）。下側（t>0）の線は定義域の外。tMinMm で下限（高い側の天井面）へ切り詰め、他の slot は不変', () => {
  const solid = { weightRole: 'medium', dashRole: 'solid' };
  const rect = (t0, t1, s1) => ({ id: 'x', points: [[0, t0], [s1, t0], [s1, t1], [0, t1]].map(([s, t]) => ({ s, t })), closed: true, line: solid });
  const above = computeEnvelope([rect(-20, 0, 12)], CEILING_STEP);
  assert.deepEqual(above.steps, [{ t: -20, weight: EnvelopeWeight.AUTO }]);
  assert.equal(above.maxDeviationMm, 12);
  assert.deepEqual(computeEnvelope([rect(0, 20, 12)], CEILING_STEP).steps, [], '低い側の天井より下（t>0）は ceilingStep の定義域の外');
  // 既存 slot の結果は不変（ceilingStep は floorWall と同じ定義域）
  assert.deepEqual(computeEnvelope([rect(-20, 0, 12)], DetailSlot.FLOOR_WALL), above);
  assert.deepEqual(computeEnvelope([rect(-20, 0, 12)], CEILING_STEP, { tMinMm: -10 }).steps, [{ t: -10, weight: EnvelopeWeight.AUTO }], 'tMinMm で下限へ切り詰める');
  assert.deepEqual(computeEnvelope([rect(0, 20, 12)], FLOOR_STEP, { tMinMm: -10 }), computeEnvelope([rect(0, 20, 12)], FLOOR_STEP), 'tMinMm は t>0 側の slot には効かない（tMaxMm と対称）');
});

test('tMinMm: 高い側の天井面（−段差高）より上の線は切り詰められ、形状差と輪郭が下限に収まる。tMinMm が無い／不正（0・正・非有限）は下限なし', () => {
  const fig = ceilingStepFigure('k2', [
    move(PenDir.RIGHT, fixedLen(120)), move(PenDir.UP, fixedLen(40)), move(PenDir.LEFT, fixedLen(90)),
    move(PenDir.UP, fixedLen(30)), move(PenDir.LEFT, fixedLen(30)), move(PenDir.UP, stretchLen(100)),
    move(PenDir.RIGHT, fixedLen(300)), move(PenDir.UP, fixedLen(15)),
  ], { closed: false, endVertex: 6 });
  setOverlay(DF, { user: [fig] });
  const fitted = fitCeilingStepPart({ figureKey: 'k2', stepHeightMm: 300 });
  assert.equal(Math.max(...fitted.strokes[0].points.map(p => p.s)), 300, '前提: 図は高い側の天井の上に s=300 の線を持つ');
  assert.equal(Math.min(...fitted.strokes[0].points.map(p => p.t)), -315, '前提: 図は t=−315 まで上がる');
  const env = ceilingStepEnvelope({ room: holder({ detailRefs: { [CEILING_STEP]: 'k2' } }), stepHeightMm: 300 });
  assert.equal(env.maxDeviationMm, 120, '形状差は見切りの出だけ');
  assert.ok(env.outline.every(([, t]) => t >= -300), JSON.stringify(env.outline));
  assert.ok(env.steps.every(({ t }) => t >= -300));
  assert.equal(computeEnvelope(fitted.strokes, CEILING_STEP).maxDeviationMm, 300, 'tMinMm を渡さなければ上限なし');
  assert.equal(computeEnvelope(fitted.strokes, CEILING_STEP, { tMinMm: -300 }).maxDeviationMm, 120);
  for (const bad of [0, 300, NaN, undefined, Infinity]) {
    assert.equal(computeEnvelope(fitted.strokes, CEILING_STEP, { tMinMm: bad }).maxDeviationMm, 300, String(bad));
  }
});

test('fitCeilingStepPart: 段差高に合わせ、メモは図のキー×slot×段差高（床の段差とは別の鍵）。固定寸法の和以下は FIXED_EXCEEDS_TARGET', () => {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const a = fitCeilingStepPart({ figureKey: 'k', stepHeightMm: 300 });
  const b = fitCeilingStepPart({ figureKey: 'k', stepHeightMm: 400 });
  assert.equal(a.strokes[0].points.at(-1).t, -300);
  assert.equal(b.strokes[0].points.at(-1).t, -400);
  assert.equal(fitCeilingStepPart({ figureKey: 'k', stepHeightMm: 300 }), a, '同じ鍵はメモを返す');
  assert.equal(fitCeilingStepPart({ figureKey: 'k', stepHeightMm: 70 }).error.code, 'fixedExceedsTarget');
  assert.equal(fitCeilingStepPart({ figureKey: 'df-gone', stepHeightMm: 300 }).error.code, 'noFigure');
  const direct = fitLocal(ceilingNoseFigure('k'), ceilingStepTargets(ceilingNoseFigure('k'), { stepHeightMm: 300 }).targets);
  assert.deepEqual(a.strokes, direct.strokes);
});

test('resolveCeilingStepFigure: 区画があれば区画の割当て・無ければ部屋。割当て無しは null・参照切れは entry=null。区画が空でも部屋へは継承しない。floorStep の slot は見ない', () => {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const room = holder();
  const zone = { id: 'z1', detailRefs: null };
  assert.equal(resolveCeilingStepFigure({ room: { detailRefs: null } }), null);
  assert.equal(resolveCeilingStepFigure({ room: { detailRefs: { [FLOOR_STEP]: 'k' } } }), null);
  assert.equal(resolveCeilingStepFigure({ room: { detailRefs: { [CEILING_STEP]: 'df-gone' } } }).entry, null);
  const r = resolveCeilingStepFigure({ room });
  assert.deepEqual([r.key, r.slot, r.entry.key], ['k', CEILING_STEP, 'k']);
  assert.equal(resolveCeilingStepFigure({ room, zone }), null, '区画が空なら部屋の割当てを継がない');
  assert.equal(resolveCeilingStepFigure({ room: { detailRefs: null }, zone: { id: 'z2', detailRefs: { [CEILING_STEP]: 'k' } } }).key, 'k');
});

test('ceilingStepEnvelope: 段差の t は −70・−40（auto）。形状差 120。輪郭は上端（−段差高）〜低い側の天井面。参照切れ・fit 失敗・割当て無しは null', () => {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const env = ceilingStepEnvelope({ room: holder(), stepHeightMm: 300 });
  assert.deepEqual(env.steps, [{ t: -70, weight: EnvelopeWeight.AUTO }, { t: -40, weight: EnvelopeWeight.AUTO }]);
  assert.equal(env.maxDeviationMm, 120);
  assert.deepEqual(env.outline[0], [0, -300]);
  assert.deepEqual(env.outline.at(-1), [120, 0]);
  assert.deepEqual(ceilingStepEnvelope({ room: holder(), stepHeightMm: 500 }).outline[0], [0, -500]);
  assert.equal(ceilingStepEnvelope({ room: holder(), stepHeightMm: 60 }), null, '段差高に合わない');
  assert.equal(ceilingStepEnvelope({ room: { detailRefs: { [CEILING_STEP]: 'df-gone' } }, stepHeightMm: 300 }), null, '参照切れ');
  assert.equal(ceilingStepEnvelope({ room: { detailRefs: null }, stepHeightMm: 300 }), null, '割当て無し');
  const zone = { id: 'z1', detailRefs: { [CEILING_STEP]: 'k' } };
  assert.equal(ceilingStepEnvelope({ room: { detailRefs: null }, zone, stepHeightMm: 300 }).maxDeviationMm, 120, '区画の割当て');
});

test('collectCeilingStepFailures: 参照切れは持ち主ごと 1 行・fit 失敗は段差高ごと 1 行（stepHeightMm 付き）・主語は部屋または「部屋「X」の区画n」・重複は seen で畳む。割当て無しは空', () => {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const rooms = [
    { id: 'a', name: '玄関', detailRefs: { [CEILING_STEP]: 'df-gone' }, ceilingZones: [] },
    { id: 'b', name: '居間', detailRefs: null, ceilingZones: [
      { id: 'z1', detailRefs: null },
      { id: 'z2', detailRefs: { [CEILING_STEP]: 'k' } },
      { id: 'z3', detailRefs: { [CEILING_STEP]: 'df-gone' } },
    ] },
    { id: 'c', name: '寝室', detailRefs: null },
  ];
  const graph = { rooms };
  const stepHeightsOf = (room, zone) => (zone?.id === 'z2' ? [60, 300, 70] : [300]);
  const seen = new Set();
  const rows = collectCeilingStepFailures(graph, seen, { stepHeightsOf });
  assert.equal(rows.length, 4);
  const goneRoom = rows.find(r => r.roomId === 'a');
  assert.equal(goneRoom.symbolKey, detailOwnerRoom('玄関'));
  assert.equal(goneRoom.zoneId, null);
  assert.equal(goneRoom.slot, CEILING_STEP);
  assert.equal(goneRoom.stepHeightMm, undefined, '参照切れは fit 失敗の行ではない');
  assert.ok(goneRoom.message.includes('天井の段差') && goneRoom.message.includes('見つかりません'), goneRoom.message);
  const goneZone = rows.find(r => r.zoneId === 'z3');
  assert.equal(goneZone.symbolKey, detailOwnerCeilingZone('居間', 3));
  assert.ok(goneZone.message.includes('部屋「居間」の区画3'), goneZone.message);
  const fits = rows.filter(r => r.zoneId === 'z2');
  assert.deepEqual(fits.map(r => r.stepHeightMm), [60, 70], '300 は合う');
  assert.equal(fits[0].symbolKey, '部屋「居間」の区画2');
  assert.ok(fits[0].message.includes('の天井の段差に合わせられません'), fits[0].message);
  assert.equal(collectCeilingStepFailures(graph, seen, { stepHeightsOf }).length, 0, 'seen が畳む');
  assert.deepEqual(collectCeilingStepFailures({ rooms: [rooms[2]] }), []);
  assert.deepEqual(collectCeilingStepFailures(null), []);
  assert.deepEqual(collectCeilingStepFailures(graph, new Set()).filter(r => r.stepHeightMm !== undefined), [], '段差高の供給が無ければ fit は試さない');
});

// ---- 実グラフ: 段差高の供給元 ----
// 3 列の部屋 LDK（CH 2400）。右列を区画（高さ rightH）にする。
function zonedRoom(rightH, { assign = 'zone' } = {}) {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  room.setOverride('ceilingHeight', '2400');
  const { zones, zoneId } = createZone(g.graph, room, [g.cell(2, 0)], { heightMm: rightH, shape: 'flat', dims: [] });
  const withRefs = zones.map(z => (z.id === zoneId && assign === 'zone' ? new CeilingZone({ ...z.toData(), detailRefs: { [CEILING_STEP]: 'k' } }) : z));
  room.setCeilingZones(withRefs);
  if (assign === 'room') room.setDetailRefs({ [CEILING_STEP]: 'k' });
  return { ...g, room, zone: room.ceilingZones.find(z => z.id === zoneId) };
}

test('ceilingStepHeightsByOwner: 低い側の持ち主（区画／部屋の残り）が受ける段差高（|Δz|）。高い側・割当て無しは空', () => {
  const low = zonedRoom(2100);
  const heights = ceilingStepHeightsByOwner(low.graph);
  assert.deepEqual(heights(low.room, low.zone), [300], '区画が低い');
  assert.deepEqual(heights(low.room), [], '高い側の部屋の残りは空');
  const high = zonedRoom(2700, { assign: 'room' });
  assert.deepEqual(ceilingStepHeightsByOwner(high.graph)(high.room), [300], '残りが低い（部屋単位の持ち主）');
  const highZone = zonedRoom(2700);
  assert.deepEqual(ceilingStepHeightsByOwner(highZone.graph)(highZone.room, highZone.zone), [], '区画が高い側');
  const none = zonedRoom(2100, { assign: null });
  assert.deepEqual(ceilingStepHeightsByOwner(none.graph)(none.room, none.zone), [], '割当て無しは天井面を計算しない');
  assert.deepEqual(ceilingStepHeightsByOwner(null)({ id: 'x' }), []);
});

test('ceilingStepHeightsByOwner: 平らな面どうし・辺を共有するときだけ。傾斜の区画・離れた区画・同じ高さは数えない。親子の部屋・兄弟の部屋の境も数える', () => {
  const g = makeGrid([0, 2000, 4000, 6000, 8000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  room.setOverride('ceilingHeight', '2400');
  // 区画 z1 は col1 が 2100（col0・col2 の残りと辺を共有）／区画 z2 は col3（col2 の残りとだけ辺を共有）で 1800
  let zones = createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 2100, shape: 'flat', dims: [] }).zones;
  zones = createZone(g.graph, Object.assign(room, { ceilingZones: Object.freeze(zones) }), [g.cell(3, 0)], { heightMm: 1800, shape: 'flat', dims: [] }).zones;
  room.setCeilingZones(zones.map(z => new CeilingZone({ ...z.toData(), detailRefs: { [CEILING_STEP]: 'k' } })));
  const [z1, z2] = room.ceilingZones;
  const heights = ceilingStepHeightsByOwner(g.graph);
  assert.deepEqual(heights(room, z1), [300]);
  assert.deepEqual(heights(room, z2), [600]);
  // 傾斜にすると面が平らでないので数えない
  room.setCeilingZones(room.ceilingZones.map(z => (z.id === z2.id ? new CeilingZone({ ...z.toData(), shape: 'slope', dims: [500, 0] }) : z)));
  assert.deepEqual(ceilingStepHeightsByOwner(g.graph)(room, room.ceilingZones[1]), []);
  // 部分指定の子（own CH 2100）が親の残りの隣にある
  const h = makeGrid([0, 2000, 4000], [0, 3000]);
  const parent = h.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = h.graph.addRoom(new Set([h.cell(1, 0)]), '子', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '2100');
  child.setDetailRefs({ [CEILING_STEP]: 'k' });
  assert.deepEqual(ceilingStepHeightsByOwner(h.graph)(child), [300], '親子の境');
  // 兄弟の子どうし（同じ親を参照）の境
  const sib = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const sp = sib.interior([[0, 0], [1, 0], [2, 0]]);
  sp.setOverride('ceilingHeight', '2400');
  const a = sib.graph.addRoom(new Set([sib.cell(1, 0)]), 'A', undefined, new Set([sp.id]));
  const b = sib.graph.addRoom(new Set([sib.cell(2, 0)]), 'B', undefined, new Set([sp.id]));
  a.setOverride('ceilingHeight', '2700');
  b.setOverride('ceilingHeight', '2200');
  b.setDetailRefs({ [CEILING_STEP]: 'k' });
  assert.deepEqual(ceilingStepHeightsByOwner(sib.graph)(b), [500], '兄弟 A との境の 500（親の残りは col0 で B と辺を共有しない）');
});

test('ceilingStepSelects／zonesAfterCeilingStepSelect／isCeilingStepEditable: 区画の select は「なし」＋ part/section/ceiling の図だけ。選ぶ・外すは他の項目を保ち、平面でない区画・未知の区画・別 slot は変えない', () => {
  const figures = [{ ...ceilingNoseFigure('df-cs'), label: '見切りA' }, { ...stepNoseFigure('df-fs'), label: '段鼻' }];
  const { graph, room, zone } = zonedRoom(2100, { assign: null });
  const sels = ceilingStepSelects(zone, figures);
  assert.deepEqual(sels.map(s => [s.slot, s.label, s.value]), [[CEILING_STEP, '天井の段差', '']]);
  assert.deepEqual(sels[0].options, [{ value: '', label: 'なし' }, { value: 'df-cs', label: '見切りA（df-cs）' }]);
  const set = zonesAfterCeilingStepSelect(graph, room, zone.id, CEILING_STEP, 'df-cs');
  const picked = set.find(z => z.id === zone.id);
  assert.deepEqual(picked.detailRefs, { [CEILING_STEP]: 'df-cs' });
  assert.deepEqual([picked.cells, picked.heightMm, picked.shape, picked.dims], [zone.cells, 2100, 'flat', []]);
  room.setCeilingZones(set);
  assert.equal(ceilingStepSelects(room.ceilingZones[0], figures)[0].value, 'df-cs');
  const cleared = zonesAfterCeilingStepSelect(graph, room, zone.id, CEILING_STEP, '');
  assert.equal(cleared.find(z => z.id === zone.id).detailRefs, null);
  // 【失敗系】
  assert.deepEqual(zonesAfterCeilingStepSelect(graph, room, 'no-such', CEILING_STEP, 'df-cs').map(z => z.detailRefs), [{ [CEILING_STEP]: 'df-cs' }], '未知の区画は変えない');
  assert.deepEqual(zonesAfterCeilingStepSelect(graph, room, zone.id, FLOOR_STEP, 'df-fs').map(z => z.detailRefs), [{ [CEILING_STEP]: 'df-cs' }], '別 slot は変えない');
  assert.deepEqual(zonesAfterCeilingStepSelect(graph, null, zone.id, CEILING_STEP, 'df-cs'), []);
  const slope = new CeilingZone({ ...zone.toData(), shape: 'slope', dims: [500, 0], detailRefs: null });
  assert.equal(isCeilingStepEditable(slope), false);
  assert.equal(isCeilingStepEditable(zone), true);
  room.setCeilingZones([slope]);
  assert.equal(zonesAfterCeilingStepSelect(graph, room, slope.id, CEILING_STEP, 'df-cs')[0].detailRefs, null, '傾斜の区画には書かない');
});

test('【M1】updateZoneSpec: 割当て済みの平面の区画を傾斜・円弧・ドームへ変えると ceilingStep が消え、通知（参照切れ・fit 失敗）も出ない。平面のままなら保つ', () => {
  setOverlay(DF, { user: [ceilingNoseFigure('df-cs')] });
  const { graph, room, zone } = zonedRoom(2100, { assign: null });
  room.setCeilingZones(zonesAfterCeilingStepSelect(graph, room, zone.id, CEILING_STEP, 'df-cs'));
  const keep = updateZoneSpec(graph, room, zone.id, { heightMm: 2000, shape: 'flat', dims: [] });
  assert.deepEqual(keep[0].detailRefs, { [CEILING_STEP]: 'df-cs' }, '平面のままなら保つ');
  const slope = updateZoneSpec(graph, room, zone.id, { heightMm: 2100, shape: 'slope', dims: [500, 0] });
  assert.equal(slope[0].shape, 'slope');
  assert.equal(slope[0].detailRefs, null, '傾斜で割当てが消える');
  room.setCeilingZones(slope);
  const stepHeightsOf = () => [60];
  assert.deepEqual(collectCeilingStepFailures({ rooms: [room] }, new Set(), { stepHeightsOf }), [], '通知は出ない');
  // 対照: 割当てが残っていれば出る
  room.setCeilingZones(keep.map(z => new CeilingZone({ ...z.toData(), shape: 'slope', dims: [500, 0] })));
  assert.ok(collectCeilingStepFailures({ rooms: [room] }, new Set(), { stepHeightsOf }).length > 0, '対照');
});
