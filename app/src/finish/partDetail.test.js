// 腰壁・垂れ壁の部位（記録の detailRefs の kneeTop・dropBottom。部分詳細図 S8b-1）の基準供給・包絡線の定義域・組込み天板・
// 解決/fit/鏡像・通知の集計（finish/partDetail.js・finish/roomDetailTargets.js partTargets）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import {
  PenDir, DetailSlot, DetailDatumRole, DetailDatumKind, DetailAxis, DetailParam, DetailMaterialField, KneeDropFrontSide,
} from '../core/constants.js';
import { fitLocal, computeEnvelope, EnvelopeWeight } from '../detail/detailPlacement.js';
import detailBuiltins, { KNEE_CAP_20_KEY } from '../detail/detailBuiltins.js';
import { validateDetailFigure, isSupportedDetailFigure } from '../detail/detailModel.js';
import { partTargets, junctionTargets, RoomDetailError } from './roomDetailTargets.js';
import {
  resolveKneeDropDetailFigure, fitKneeDropPart, mirrorStrokesAcrossWall, kneeDropPartEnvelope, collectKneeDropPartFailures,
} from './partDetail.js';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_PART, detailOwnerKneeDrop, KNEE_DROP_DETAIL_TEXT } from '../error.js';
import {
  partFigure, frontOnlyCapFigure, baseboardFigure, move, fixedLen, materialLen, paramLen,
} from './roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { KNEE_TOP, DROP_BOTTOM, FLOOR_WALL } = DetailSlot;
const KNEE_CAP = detailBuiltins.find(f => f.key === KNEE_CAP_20_KEY);

test.afterEach(() => clearOverlays());

test('partTargets: s は表の側の仕上げ面 origin 0・end −壁厚。t は kneeTop が WALL_TOP・dropBottom が WALL_BOTTOM の origin 0。param wallThickness＝壁厚', () => {
  const k = partTargets(KNEE_CAP, { slot: KNEE_TOP, wallThicknessMm: 120 });
  assert.deepEqual(k.targets.datums, { ds0: 0, dt0: 0 });
  assert.deepEqual(k.targets.params, { [DetailParam.WALL_THICKNESS]: 120 });
  assert.deepEqual(k.targets.materials, {});
  const dropFig = partFigure('df-d', DROP_BOTTOM, [move(PenDir.UP, fixedLen(20)), move(PenDir.RIGHT, fixedLen(10))]);
  const d = partTargets(dropFig, { slot: DROP_BOTTOM, wallThicknessMm: 100 });
  assert.deepEqual(d.targets.datums, { ds0: 0, dt0: 0 });
  // end の s 基準は −壁厚
  const withEnd = { ...dropFig, datums: [...dropFig.datums, { id: 'ds1', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.S, kind: DetailDatumKind.END, offsetMm: 0 }] };
  assert.equal(partTargets(withEnd, { slot: DROP_BOTTOM, wallThicknessMm: 100 }).targets.datums.ds1, -100);
});

test('【失敗系】partTargets: 他の slot の t 基準（WALL_BOTTOM を kneeTop・WALL_TOP を dropBottom・FL）・供給できない組は UNSUPPORTED_DATUM。部位でない slot は UNSUPPORTED_SLOT。junctionTargets は WALL_TOP を供給しない', () => {
  const kneeFig = partFigure('df-k', KNEE_TOP, [move(PenDir.DOWN, fixedLen(20)), move(PenDir.LEFT, fixedLen(10))]);
  const bottomFig = partFigure('df-b', DROP_BOTTOM, [move(PenDir.UP, fixedLen(20)), move(PenDir.LEFT, fixedLen(10))]);
  const wrongT = partTargets(bottomFig, { slot: KNEE_TOP, wallThicknessMm: 100 });
  assert.equal(wrongT.error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(wrongT.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('dt0', `${DetailDatumRole.WALL_BOTTOM}・${DetailAxis.T}・${DetailDatumKind.ORIGIN}`, DETAIL_TARGET_PART));
  assert.equal(partTargets(kneeFig, { slot: DROP_BOTTOM, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(partTargets(baseboardFigure('df-fl'), { slot: KNEE_TOP, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_DATUM, 'FL の図は腰壁に使えない');
  assert.equal(partTargets(kneeFig, { slot: FLOOR_WALL, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_SLOT);
  assert.equal(partTargets(kneeFig, { slot: 'wall', wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_SLOT);
  assert.equal(junctionTargets(kneeFig, { slot: FLOOR_WALL, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.doesNotThrow(() => partTargets(null, { slot: KNEE_TOP, wallThicknessMm: 100 }));
});

test('包絡線の定義域: kneeTop は t>0（腰壁の天端より下）・dropBottom は t<0（垂れ壁の下端より上）。反対側の線は定義域の外', () => {
  const solid = { weightRole: 'medium', dashRole: 'solid' };
  const rect = (t0, t1) => ({ id: 'x', points: [[0, t0], [12, t0], [12, t1], [0, t1]].map(([s, t]) => ({ s, t })), closed: true, line: solid });
  const below = computeEnvelope([rect(0, 20)], KNEE_TOP);
  assert.deepEqual(below.steps, [{ t: 20, weight: EnvelopeWeight.AUTO }]);
  assert.equal(below.maxDeviationMm, 12);
  assert.deepEqual(computeEnvelope([rect(-20, 0)], KNEE_TOP).steps, [], '天端より上（t<0）の矩形は kneeTop の定義域の外');
  const above = computeEnvelope([rect(-20, 0)], DROP_BOTTOM);
  assert.deepEqual(above.steps, [{ t: -20, weight: EnvelopeWeight.AUTO }]);
  assert.deepEqual(computeEnvelope([rect(0, 20)], DROP_BOTTOM).steps, [], '下端より下（t>0）の矩形は dropBottom の定義域の外');
  // 既存 slot の結果は不変（wallCeiling は kneeTop と同じ定義域・floorWall は dropBottom と同じ）
  assert.deepEqual(computeEnvelope([rect(0, 20)], DetailSlot.WALL_CEILING), below);
  assert.deepEqual(computeEnvelope([rect(-20, 0)], FLOOR_WALL), above);
  assert.deepEqual(computeEnvelope([rect(0, 20)], 'zzz').steps, [], '【失敗系】未知の slot は空');
});

test('組込み「天板 厚 20×（12＋壁厚＋12）」: 登録できる図で、壁厚 120 → 幅 144・t 0..20・包絡線の段差は t=20 の auto 1 本', () => {
  assert.equal(validateDetailFigure(KNEE_CAP).ok, true, JSON.stringify(validateDetailFigure(KNEE_CAP).errors));
  assert.equal(isSupportedDetailFigure(KNEE_CAP), true);
  assert.equal(KNEE_CAP.label, '天板 厚 20×（12＋壁厚＋12）');
  const t = partTargets(KNEE_CAP, { slot: KNEE_TOP, wallThicknessMm: 120 });
  const fitted = fitLocal(KNEE_CAP, t.targets);
  assert.equal(fitted.error, undefined);
  const pts = fitted.strokes[0].points.map(p => [p.s, p.t]);
  assert.deepEqual(pts, [[12, 0], [12, 20], [0, 20], [-120, 20], [-132, 20], [-132, 0]], '表の天端角 (12,0) から D20→L12→L壁厚→L12→U20');
  const widths = pts.map(p => p[0]);
  assert.equal(Math.max(...widths) - Math.min(...widths), 144, '幅＝12＋120＋12');
  assert.equal(fitted.strokes[0].closed, true);
  assert.deepEqual(computeEnvelope(fitted.strokes, KNEE_TOP).steps, [{ t: 20, weight: EnvelopeWeight.AUTO }]);
  // 壁厚を変えると幅が追従する（param）
  const t2 = fitLocal(KNEE_CAP, partTargets(KNEE_CAP, { slot: KNEE_TOP, wallThicknessMm: 200 }).targets);
  assert.equal(t2.strokes[0].points[3].s, -200);
});

test('resolveKneeDropDetailFigure: 割当て無しは null・参照切れは entry=null・カタログにあれば entry', () => {
  setOverlay(DF, { user: [KNEE_CAP] });
  const rec = { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY, [DROP_BOTTOM]: 'df-gone' } };
  assert.equal(resolveKneeDropDetailFigure({ rec: { knee: { topHeight: 800 }, drop: null }, slot: KNEE_TOP }), null);
  assert.equal(resolveKneeDropDetailFigure({ rec: null, slot: KNEE_TOP }), null);
  assert.equal(resolveKneeDropDetailFigure({ rec, slot: KNEE_TOP }).entry.key, KNEE_CAP_20_KEY);
  assert.deepEqual(resolveKneeDropDetailFigure({ rec, slot: DROP_BOTTOM }), { key: 'df-gone', slot: DROP_BOTTOM, entry: null });
});

test('fitKneeDropPart: 壁厚で fit する。同じ図・slot・壁厚はメモを共有（同一オブジェクト）。図が無ければ error', () => {
  setOverlay(DF, { user: [KNEE_CAP] });
  const a = fitKneeDropPart({ figureKey: KNEE_CAP_20_KEY, slot: KNEE_TOP, wallThicknessMm: 100 });
  assert.equal(a.error, undefined);
  assert.equal(fitKneeDropPart({ figureKey: KNEE_CAP_20_KEY, slot: KNEE_TOP, wallThicknessMm: 100 }), a);
  assert.notEqual(fitKneeDropPart({ figureKey: KNEE_CAP_20_KEY, slot: KNEE_TOP, wallThicknessMm: 110 }), a);
  assert.ok(fitKneeDropPart({ figureKey: 'df-gone', slot: KNEE_TOP, wallThicknessMm: 100 }).error);
});

test('mirrorStrokesAcrossWall: s を壁の中心で映す（s → −(s+壁厚)）。t・並び・元は変えない', () => {
  const strokes = [{ id: 'a', closed: true, line: {}, points: [{ s: 12, t: 0 }, { s: -100, t: 20 }], edgeMarks: ['air'] }];
  const m = mirrorStrokesAcrossWall(strokes, 100);
  assert.deepEqual(m[0].points, [{ s: -112, t: 0 }, { s: 0, t: 20 }]);
  assert.deepEqual(m[0].edgeMarks, ['air'], '印は辺の番号のまま');
  assert.deepEqual(strokes[0].points[0], { s: 12, t: 0 });
});

// ---- 実グラフ（LDK 0..4000×0..3000 ／ 和室 同幅×3000..6000。y=3000 の間仕切り）----
const V = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const H = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
function twoRooms(rec) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = V(graph, 0), x1 = V(graph, 4000), y0 = H(graph, 0), ym = H(graph, 3000), y1 = H(graph, 6000);
  const ldk = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, ldk);
  const wa = graph.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '和室');
  generateRoomWallsFromOutline(graph, wa);
  const key = edgeKey(ym.id, x0.id, x1.id);
  if (rec) graph.setKneeDropWall(key, rec);
  return { graph, ldk, wa, key };
}
const wallOnPartition = graph => graph.walls.find(w => w.axisCL.effectiveValue === 3000 && !w.isVertical);

test('kneeDropPartEnvelope: 表の側から見ると天板の段差 t=20。反対側から見ると（鏡像で）出る部分が無く null ではなく段差 0 件', () => {
  setOverlay(DF, { user: [frontOnlyCapFigure('df-cap')] });
  const rec = { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-cap' } };
  const { graph } = twoRooms(rec);
  const wall = wallOnPartition(graph);
  const front = kneeDropPartEnvelope({ graph, wall, rec, slot: KNEE_TOP, viewedSide: KneeDropFrontSide.ROOM_NEG });
  assert.deepEqual(front.steps, [{ t: 20, weight: EnvelopeWeight.AUTO }]);
  const back = kneeDropPartEnvelope({ graph, wall, rec, slot: KNEE_TOP, viewedSide: KneeDropFrontSide.ROOM_POS });
  assert.deepEqual(back.steps, [], '裏の面は鏡像: 天板の出幅は表の側にだけある');
  // 表の側を roomPos にすると逆になる
  const flipped = { ...rec, frontSide: KneeDropFrontSide.ROOM_POS };
  assert.deepEqual(kneeDropPartEnvelope({ graph, wall, rec: flipped, slot: KNEE_TOP, viewedSide: KneeDropFrontSide.ROOM_POS }).steps, [{ t: 20, weight: EnvelopeWeight.AUTO }]);
  assert.deepEqual(kneeDropPartEnvelope({ graph, wall, rec: flipped, slot: KNEE_TOP, viewedSide: KneeDropFrontSide.ROOM_NEG }).steps, []);
});

test('【失敗系】kneeDropPartEnvelope: 割当て無し・参照切れ・fit 失敗（材未解決）・壁厚が引けない壁は null（例外にしない）', () => {
  const MAT = '101000000001';
  const matFig = partFigure('df-mat', KNEE_TOP, [
    move(PenDir.DOWN, materialLen(MAT, DetailMaterialField.THICKNESS, 20)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
    move(PenDir.UP, fixedLen(5)),
  ]);
  setOverlay(DF, { user: [matFig, KNEE_CAP] });
  const { graph } = twoRooms(null);
  const wall = wallOnPartition(graph);
  const args = { graph, wall, slot: KNEE_TOP, viewedSide: KneeDropFrontSide.ROOM_NEG };
  assert.equal(kneeDropPartEnvelope({ ...args, rec: { knee: { topHeight: 800 }, drop: null } }), null);
  assert.equal(kneeDropPartEnvelope({ ...args, rec: { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-gone' } } }), null);
  assert.equal(kneeDropPartEnvelope({ ...args, rec: { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-mat' } } }), null, '材マップ無し＝UNRESOLVED_MATERIAL');
  const noThickness = { axisCL: wall.axisCL, coord1: 0, coord2: 4000, materialRange: null, backingRange: null };
  assert.equal(kneeDropPartEnvelope({ ...args, graph: { walls: [] }, wall: noThickness, rec: { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } } }), null);
});

test('collectKneeDropPartFailures: 参照切れ・fit 失敗を記録ごとに集める。主語は腰壁・垂れ壁（部屋名）。収まる図・割当て無しは行を作らない。seen で重複を省く', () => {
  const MAT = '101000000001';
  const matFig = partFigure('df-mat', KNEE_TOP, [
    move(PenDir.DOWN, materialLen(MAT, DetailMaterialField.THICKNESS, 20)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
    move(PenDir.UP, fixedLen(5)),
  ]);
  setOverlay(DF, { user: [matFig, KNEE_CAP] });
  const rec = { knee: { topHeight: 800 }, drop: { bottomHeight: 400 }, detailRefs: { [KNEE_TOP]: 'df-mat', [DROP_BOTTOM]: 'df-gone' } };
  const { graph, key } = twoRooms(rec);
  const owner = detailOwnerKneeDrop(['LDK', '和室']);
  assert.equal(owner, '腰壁・垂れ壁（LDK／和室の間）');
  const seen = new Set();
  const rows = collectKneeDropPartFailures(graph, seen);
  const notFound = rows.find(r => r.slot === DROP_BOTTOM);
  const fitFailed = rows.find(r => r.slot === KNEE_TOP);
  assert.equal(rows.length, 2, JSON.stringify(rows.map(r => r.message)));
  assert.equal(notFound.wallThickness, undefined, '参照切れは壁厚を持たない（detail-fit-failed の行にしない）');
  assert.ok(notFound.message.includes(owner) && notFound.message.includes('垂れ壁の下端'), notFound.message);
  assert.ok(fitFailed.wallThickness > 0 && fitFailed.message.includes(owner) && fitFailed.message.includes('腰壁の天端に合わせられません'), fitFailed.message);
  assert.equal(fitFailed.kneeDropKey, key);
  assert.deepEqual(collectKneeDropPartFailures(graph, seen), [], '同じ seen では再掲しない');
  // 収まる図・割当て無し
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } });
  assert.deepEqual(collectKneeDropPartFailures(graph), []);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: null });
  assert.deepEqual(collectKneeDropPartFailures(graph), []);
  assert.deepEqual(collectKneeDropPartFailures(null), []);
  assert.equal(detailOwnerKneeDrop(['LDK']), '腰壁・垂れ壁（LDK）');
  assert.equal(detailOwnerKneeDrop([null, '']), '腰壁・垂れ壁（部屋なし）');
  assert.equal(KNEE_DROP_DETAIL_TEXT.none, 'なし');
});
