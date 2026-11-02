// 床の段差（Room.detailRefs の floorStep。部分詳細図 S8b-3）の基準供給・包絡線の定義域・解決/fit・通知の集計
// （finish/roomDetailTargets.js floorStepTargets・finish/partDetail.js・elevation/elevationStepFace.js floorStepHeightsByOwner）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { PenDir, DetailSlot, DetailDatumRole, DetailDatumKind, DetailAxis, DETAIL_ENVELOPE_STEP_MIN_MM } from '../core/constants.js';
import { fitLocal, computeEnvelope, EnvelopeWeight } from '../detail/detailPlacement.js';
import { floorStepTargets, partTargets, junctionTargets, RoomDetailError } from './roomDetailTargets.js';
import {
  resolveRoomPartFigure, fitFloorStepPart, floorStepEnvelope, collectFloorStepFailures,
} from './partDetail.js';
import { buildStepFaces, stepRiserSegments, floorStepHeightsByOwner } from '../elevation/elevationStepFace.js';
import { buildRoomFaces } from '../elevation/elevationFaces.js';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_PART_STEP, detailOwnerRoom } from '../error.js';
import { stepNoseFigure, floorStepFigure, baseboardFigure, move, fixedLen, stretchLen } from './roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_STEP, FLOOR_WALL } = DetailSlot;
const STEP_ROOM = Object.freeze({ id: 'r1', name: '小上がり', detailRefs: { [FLOOR_STEP]: 'k' } });

test.afterEach(() => clearOverlays());

test('floorStepTargets: s は STEP_EDGE の origin 0・t は FL の origin 0（高い側）と end＝段差高（低い側）。param なし', () => {
  const t = floorStepTargets(stepNoseFigure('k'), { stepHeightMm: 300 });
  assert.deepEqual(t.targets.datums, { ds0: 0, dt0: 0, dt1: 300 });
  assert.deepEqual(t.targets.params, {});
  assert.deepEqual(t.targets.materials, {});
  assert.equal(floorStepTargets(stepNoseFigure('k'), { stepHeightMm: 450 }).targets.datums.dt1, 450, '段差高に追従');
});

test('【失敗系】floorStepTargets: 供給外の組（壁の仕上げ面・STEP_EDGE の end・t 軸の STEP_EDGE・FL の s 軸）は UNSUPPORTED_DATUM。段差高が数値でなければ error。他の targets は STEP_EDGE を供給しない', () => {
  const fig = stepNoseFigure('k');
  const withDatum = d => ({ ...fig, datums: [...fig.datums, d] });
  const wall = floorStepTargets(withDatum({ id: 'dx', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.END, offsetMm: 0 }), { stepHeightMm: 300 });
  assert.equal(wall.error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(wall.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('dx', `${DetailDatumRole.WALL_FINISH_FACE}・${DetailAxis.S}・${DetailDatumKind.END}`, DETAIL_TARGET_PART_STEP));
  for (const d of [
    { id: 'dx', role: DetailDatumRole.STEP_EDGE, axis: DetailAxis.S, kind: DetailDatumKind.END, offsetMm: 0 },
    { id: 'dx', role: DetailDatumRole.STEP_EDGE, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dx', role: DetailDatumRole.FL, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  ]) {
    assert.equal(floorStepTargets(withDatum(d), { stepHeightMm: 300 }).error.code, RoomDetailError.UNSUPPORTED_DATUM, JSON.stringify(d));
  }
  for (const bad of [NaN, undefined, '300', Infinity, 0, -300]) {
    assert.equal(floorStepTargets(fig, { stepHeightMm: bad }).error.code, RoomDetailError.INVALID_STEP_HEIGHT, String(bad));
  }
  assert.equal(partTargets(fig, { slot: DetailSlot.KNEE_TOP, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_DATUM, '腰壁は STEP_EDGE を供給しない');
  assert.equal(junctionTargets(fig, { slot: FLOOR_WALL, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_DATUM, '取り合いは STEP_EDGE を供給しない');
  assert.equal(floorStepTargets(baseboardFigure('df-fw'), { stepHeightMm: 300 }).error.code, RoomDetailError.UNSUPPORTED_DATUM, '取り合いの図は床の段差に使えない');
  assert.doesNotThrow(() => floorStepTargets(null, { stepHeightMm: 300 }));
});

test('包絡線の定義域: floorStep は t>0（高い側の床より下）。上側（t<0）の線は定義域の外。形状差＝最大の出', () => {
  const solid = { weightRole: 'medium', dashRole: 'solid' };
  const rect = (t0, t1, s1) => ({ id: 'x', points: [[0, t0], [s1, t0], [s1, t1], [0, t1]].map(([s, t]) => ({ s, t })), closed: true, line: solid });
  const below = computeEnvelope([rect(0, 20, 12)], FLOOR_STEP);
  assert.deepEqual(below.steps, [{ t: 20, weight: EnvelopeWeight.AUTO }]);
  assert.equal(below.maxDeviationMm, 12);
  assert.deepEqual(computeEnvelope([rect(-20, 0, 12)], FLOOR_STEP).steps, [], '高い側の床より上（t<0）は floorStep の定義域の外');
  // 既存 slot の結果は不変（floorStep は wallCeiling・kneeTop と同じ定義域）
  assert.deepEqual(computeEnvelope([rect(0, 20, 12)], DetailSlot.WALL_CEILING), below);
  assert.ok(DETAIL_ENVELOPE_STEP_MIN_MM < 20);
});

test('fitFloorStepPart: 段差高に合わせ、メモは図のキー×slot×段差高（段差高が違えば別の結果）。固定寸法の和以下は FIXED_EXCEEDS_TARGET', () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const a = fitFloorStepPart({ figureKey: 'k', stepHeightMm: 300 });
  const b = fitFloorStepPart({ figureKey: 'k', stepHeightMm: 400 });
  assert.equal(a.strokes[0].points.at(-1).t, 300);
  assert.equal(b.strokes[0].points.at(-1).t, 400);
  assert.equal(fitFloorStepPart({ figureKey: 'k', stepHeightMm: 300 }), a, '同じ鍵はメモを返す');
  assert.equal(fitFloorStepPart({ figureKey: 'k', stepHeightMm: 70 }).error.code, 'fixedExceedsTarget');
  assert.equal(fitFloorStepPart({ figureKey: 'df-gone', stepHeightMm: 300 }).error.code, 'noFigure');
  // fitLocal を直接呼んだ結果と一致
  const direct = fitLocal(stepNoseFigure('k'), floorStepTargets(stepNoseFigure('k'), { stepHeightMm: 300 }).targets);
  assert.deepEqual(a.strokes, direct.strokes);
});

test('resolveRoomPartFigure: 割当て無しは null・参照切れは entry=null・解決できれば entry。junction の slot（floorWall）は見ない', () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  assert.equal(resolveRoomPartFigure({ room: { detailRefs: null } }), null);
  assert.equal(resolveRoomPartFigure({ room: { detailRefs: { [FLOOR_WALL]: 'k' } } }), null);
  assert.equal(resolveRoomPartFigure({ room: { detailRefs: { [FLOOR_STEP]: 'df-gone' } } }).entry, null);
  const r = resolveRoomPartFigure({ room: STEP_ROOM });
  assert.equal(r.key, 'k');
  assert.equal(r.slot, FLOOR_STEP);
  assert.equal(r.entry.key, 'k');
});

test('floorStepEnvelope: 段差の t は 40・70（auto）。形状差 120。段差高が違っても同じ形。参照切れ・fit 失敗は null', () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const env = floorStepEnvelope({ room: STEP_ROOM, stepHeightMm: 300 });
  assert.deepEqual(env.steps, [{ t: 40, weight: EnvelopeWeight.AUTO }, { t: 70, weight: EnvelopeWeight.AUTO }]);
  assert.equal(env.maxDeviationMm, 120);
  assert.deepEqual(env.outline.at(-1), [0, 300], '輪郭は低い側の床（段差高）で終わる');
  assert.deepEqual(floorStepEnvelope({ room: STEP_ROOM, stepHeightMm: 500 }).outline.at(-1), [0, 500]);
  assert.equal(floorStepEnvelope({ room: STEP_ROOM, stepHeightMm: 60 }), null, '段差高に合わない');
  assert.equal(floorStepEnvelope({ room: { detailRefs: { [FLOOR_STEP]: 'df-gone' } }, stepHeightMm: 300 }), null, '参照切れ');
  assert.equal(floorStepEnvelope({ room: { detailRefs: null }, stepHeightMm: 300 }), null, '割当て無し');
});

test('floorStepEnvelope: 低い側の床より下（t>段差高）の線は定義域の外。形状差は鼻の出だけ・輪郭は t ≤ 段差高', () => {
  // 段鼻（出 120）の先に、低い側の床（t=300）に沿って s=300 まで伸び、その先で床の下へ 15 下がる開いた線（フローリング 300×15 を想定）を連ねる
  const fig = floorStepFigure('k2', [
    move(PenDir.RIGHT, fixedLen(120)), move(PenDir.DOWN, fixedLen(40)), move(PenDir.LEFT, fixedLen(90)),
    move(PenDir.DOWN, fixedLen(30)), move(PenDir.LEFT, fixedLen(30)), move(PenDir.DOWN, stretchLen(100)),
    move(PenDir.RIGHT, fixedLen(300)), move(PenDir.DOWN, fixedLen(15)),
  ], { closed: false, endVertex: 6 });
  setOverlay(DF, { user: [fig] });
  const fitted = fitFloorStepPart({ figureKey: 'k2', stepHeightMm: 300 });
  assert.equal(Math.max(...fitted.strokes[0].points.map(p => p.s)), 300, '前提: 図は低い側の床の下に s=300 の線を持つ');
  assert.equal(Math.max(...fitted.strokes[0].points.map(p => p.t)), 315, '前提: 図は t=315 まで下がる');
  const env = floorStepEnvelope({ room: { detailRefs: { [FLOOR_STEP]: 'k2' } }, stepHeightMm: 300 });
  assert.equal(env.maxDeviationMm, 120, '形状差は鼻の出だけ');
  assert.ok(env.outline.every(([, t]) => t <= 300), JSON.stringify(env.outline));
  assert.ok(env.steps.every(({ t }) => t <= 300));
  // 既存 slot は上限なしのまま（tMaxMm を渡さなければ従来どおり）
  assert.equal(computeEnvelope(fitted.strokes, FLOOR_STEP).maxDeviationMm, 300);
  assert.equal(computeEnvelope(fitted.strokes, FLOOR_STEP, { tMaxMm: 300 }).maxDeviationMm, 120);
});

test('collectFloorStepFailures: 参照切れは部屋ごと 1 行・fit 失敗は段差高ごと 1 行（stepHeightMm 付き）・重複は seen で畳む。割当て無しは空', () => {
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  const rooms = [
    { id: 'a', name: '小上がり', detailRefs: { [FLOOR_STEP]: 'df-gone' } },
    { id: 'b', name: '畳', detailRefs: { [FLOOR_STEP]: 'k' } },
    { id: 'c', name: '居間', detailRefs: null },
  ];
  const graph = { rooms };
  const stepHeightsOf = room => (room.id === 'b' ? [60, 300, 70] : [300]);
  const seen = new Set();
  const rows = collectFloorStepFailures(graph, seen, { stepHeightsOf });
  assert.equal(rows.length, 3);
  const gone = rows.find(r => r.roomId === 'a');
  assert.equal(gone.symbolKey, detailOwnerRoom('小上がり'));
  assert.equal(gone.slot, FLOOR_STEP);
  assert.equal(gone.stepHeightMm, undefined, '参照切れは fit 失敗の行ではない');
  assert.ok(gone.message.includes('床の段差') && gone.message.includes('見つかりません'), gone.message);
  const fits = rows.filter(r => r.roomId === 'b');
  assert.deepEqual(fits.map(r => r.stepHeightMm), [60, 70], '300 は合う');
  assert.ok(fits[0].message.includes('の床の段差に合わせられません'), fits[0].message);
  assert.equal(collectFloorStepFailures(graph, seen, { stepHeightsOf }).length, 0, 'seen が畳む');
  assert.deepEqual(collectFloorStepFailures({ rooms: [rooms[2]] }), []);
  assert.deepEqual(collectFloorStepFailures(null), []);
  assert.deepEqual(collectFloorStepFailures(graph, new Set()).filter(r => r.stepHeightMm !== undefined), [], '段差高の供給が無ければ fit は試さない');
});

// ---- 実グラフ: 段差高の供給元 ----
function threeColumn(childFL) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([cellKey(2, 3)]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  return { graph, room, child };
}

test('floorStepHeightsByOwner: floorStep を持つ部屋が高い側になる段差の高さ（昇順・重複なし）。低い側・割当て無しは空', () => {
  const high = threeColumn(300);
  high.child.setDetailRefs({ [FLOOR_STEP]: 'k' });
  high.room.setDetailRefs({ [FLOOR_STEP]: 'k' });
  const heightsHigh = floorStepHeightsByOwner(high.graph);
  assert.deepEqual(heightsHigh(high.child), [300]);
  assert.deepEqual(heightsHigh(high.room), [], '親は低い側');
  const low = threeColumn(-250);
  low.room.setDetailRefs({ [FLOOR_STEP]: 'k' });
  assert.deepEqual(floorStepHeightsByOwner(low.graph)(low.room), [250], '子が低ければ親が高い側');
  assert.deepEqual(floorStepHeightsByOwner(low.graph)(low.child), []);
  const none = threeColumn(300);
  assert.deepEqual(floorStepHeightsByOwner(none.graph)(none.child), [], '割当て無しは空（stepRiserSegments も呼ばない）');
  assert.deepEqual(floorStepHeightsByOwner(null)({}), []);
});

test('buildStepFaces: 段差見付け面は高い側の部屋（highOwnerRoom）を持つ', () => {
  const { graph, room, child } = threeColumn(300);
  const seg = stepRiserSegments(room, graph)[0];
  const face = buildStepFaces(seg, buildRoomFaces(room, graph), graph, graph.effectiveFloorLevel(room));
  assert.equal(face.highOwnerRoom, child);
  const low = threeColumn(-100);
  const lowSeg = stepRiserSegments(low.room, low.graph)[0];
  assert.equal(buildStepFaces(lowSeg, buildRoomFaces(low.room, low.graph), low.graph, 0).highOwnerRoom, low.room);
});

test('floorStepFigure（テスト用の組み立て）: 段差高 200 の最小の図でも伸縮が正なら fit できる', () => {
  const fig = floorStepFigure('df-min', [move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, stretchLen(1))], { closed: false });
  const t = floorStepTargets(fig, { stepHeightMm: 200 });
  assert.equal(fitLocal(fig, t.targets).strokes[0].points.at(-1).t, 200);
});
