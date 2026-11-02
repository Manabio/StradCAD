// 腰壁・垂れ壁の記録の部分詳細図（kneeDropWalls の detailRefs。部分詳細図 S8b-1）の通知:
// 仕上げ init＝未解決キーは unresolved-code（location kneeDrop）・壁厚に合わせられない図は detail-fit-failed・材束縛の推移、
// 展開 init＝参照切れ・fit 失敗を 1 回のトーストに合流（腰壁・垂れ壁の主語）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { ERR_DETAIL_FIT_FAILED_MORE } from '../error.js';
import { FinishModeState } from './FinishModeState.js';
import { ElevationModeState } from './ElevationModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { takeUnresolvedCodes, clearDocumentAliases } from '../catalog/codeNormalization.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { DetailSlot, PenDir, DetailParam, DetailMaterialField } from '../core/constants.js';
import detailBuiltins, { KNEE_CAP_20_KEY } from '../detail/detailBuiltins.js';
import { partFigure, move, fixedLen, paramLen, materialLen } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { KNEE_TOP, DROP_BOTTOM } = DetailSlot;
const KNEE_CAP = detailBuiltins.find(f => f.key === KNEE_CAP_20_KEY);
const MAT = '101000000001';

test.afterEach(() => { clearOverlays(); clearDocumentAliases(); takeUnresolvedCodes(); });

const V = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const H = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
function twoRooms(rec) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = V(graph, 0), x1 = V(graph, 4000), y0 = H(graph, 0), ym = H(graph, 3000), y1 = H(graph, 6000);
  const ldk = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), 'LDK');
  ldk.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, ldk).map(w => w.id));
  const wa = graph.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '和室');
  wa.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, wa).map(w => w.id));
  const key = edgeKey(ym.id, x0.id, x1.id);
  if (rec) graph.setKneeDropWall(key, rec);
  return { graph, key, ldk };
}
// 材未解決で fit 失敗する腰壁の図（材マップ無し）／壁厚で必ず収まる組込み天板
const matFig = () => partFigure('df-mat', KNEE_TOP, [
  move(PenDir.DOWN, materialLen(MAT, DetailMaterialField.THICKNESS, 20)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)), move(PenDir.UP, fixedLen(5)),
]);
const KNEE = { knee: { topHeight: 800 }, drop: null };

test('仕上げ init: 割当ての無い記録は部分詳細図の行を作らない。組込み天板は行を作らない', async () => {
  setOverlay(DF, { user: [KNEE_CAP] });
  const none = await new FinishModeState(twoRooms(KNEE).graph, null).init();
  assert.deepEqual(none.catalogResolveRows.filter(r => r.kind === DF), []);
  const ok = await new FinishModeState(twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } }).graph, null).init();
  assert.deepEqual(ok.catalogResolveRows.filter(r => r.kind === DF), []);
});

test('仕上げ init: 記録の detailRefs が指す図がカタログに無いと unresolved-code の行（usage は kneeDrop・区間のキー・slot）', async () => {
  const { graph, key } = twoRooms({ knee: { topHeight: 800 }, drop: { bottomHeight: 400 }, detailRefs: { [KNEE_TOP]: 'df-gone', [DROP_BOTTOM]: 'df-gone' } });
  const rows = (await new FinishModeState(graph, null).init()).catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length, 1, '同じ図は 1 行にまとまる');
  assert.equal(rows[0].scenario, 'unresolved-code');
  assert.equal(rows[0].targetKey, 'df-gone');
  assert.deepEqual(rows[0].usage.map(u => [u.location, u.key, u.slot]), [['kneeDrop', key, DROP_BOTTOM], ['kneeDrop', key, KNEE_TOP]], 'slot 名の昇順（正規化済みの detailRefs の順）');
});

test('仕上げ init: 壁厚に合わせられない図（材未解決）は detail-fit-failed の行。主語は腰壁・垂れ壁（部屋名）', async () => {
  setOverlay(DF, { user: [matFig()] });
  const { graph } = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-mat' } });
  const rows = (await new FinishModeState(graph, null).init()).catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length >= 1, true);
  const fit = rows.filter(r => r.scenario === 'detail-fit-failed');
  assert.ok(fit.length >= 1, JSON.stringify(rows.map(r => r.scenario)));
  assert.ok(fit[0].message.includes('腰壁・垂れ壁（LDK／和室の間）') && fit[0].message.includes('腰壁の天端に合わせられません'), fit[0].message);
});

test('【失敗系】仕上げ init: 検査が例外を投げても仕上げモードに入れる（行は空）', async () => {
  setOverlay(DF, { user: [matFig()] });
  const { graph } = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-mat' } });
  Object.defineProperty(graph, 'kneeDropWalls', { get() { throw new Error('壊れた記録'); } });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const state = new FinishModeState(graph, null);
    assert.deepEqual(state._roomDetailFitFailures(new Map()), []);
  } finally { console.error = orig; }
  assert.equal(errors.length, 1);
});

test('_collectReferencedCodes: 記録の割当てが指す図の material 束縛の材コードが推移して載る（割当て無しなら載らない・参照切れは例外にしない）', () => {
  setOverlay(DF, { user: [matFig()] });
  const { graph, key } = twoRooms(KNEE);
  const state = new FinishModeState(graph, null);
  assert.equal(state._collectReferencedCodes().has(MAT), false, '前提: 割当て無しなら載らない');
  graph.setKneeDropWall(key, { ...KNEE, detailRefs: { [KNEE_TOP]: 'df-mat' } });
  assert.equal(state._collectReferencedCodes().has(MAT), true);
  graph.setKneeDropWall(key, { ...KNEE, detailRefs: { [KNEE_TOP]: 'df-gone' } });
  assert.equal(state._collectReferencedCodes().has(MAT), false);
});

test('展開 init: 参照切れの割当ては展開図のトースト 1 回（腰壁・垂れ壁の主語）。割当て無し・組込み天板は通知なし', async () => {
  const gone = new ElevationModeState(twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-gone' } }).graph, null, { width: 1600, height: 1200 });
  const result = await gone.init();
  assert.equal(result.ok, true, '通知は ok の判定に含めない');
  assert.ok(String(gone.materialError).includes('腰壁・垂れ壁（LDK／和室の間）'), String(gone.materialError));
  assert.ok(!gone.materialError.includes('ほか'), '1 件は「ほか」を付けない');

  setOverlay(DF, { user: [KNEE_CAP] });
  const ok = new ElevationModeState(twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: KNEE_CAP_20_KEY } }).graph, null, { width: 1600, height: 1200 });
  await ok.init();
  assert.equal(ok.materialError, null);
  const plain = new ElevationModeState(twoRooms(KNEE).graph, null, { width: 1600, height: 1200 });
  await plain.init();
  assert.equal(plain.materialError, null);
});

test('展開 init: 部屋の floorWall 参照切れと腰壁 kneeTop 参照切れは 1 回のトーストに合流する（最初の 1 件＋「ほか 1 件」）', async () => {
  const { graph, ldk } = twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-gone-knee' } });
  ldk.setDetailRefs({ [DetailSlot.FLOOR_WALL]: 'df-gone-room' });
  const state = new ElevationModeState(graph, null, { width: 1600, height: 1200 });
  const result = await state.init();
  assert.equal(result.ok, true, '通知は ok の判定に含めない');
  const msg = String(state.materialError);
  assert.equal(msg.split('ほか').length - 1, 1, `トーストは 1 つに合流する（「ほか」は 1 回）: ${msg}`);
  assert.ok(msg.endsWith(ERR_DETAIL_FIT_FAILED_MORE('', 1)), `「（ほか1件）」で終わる: ${msg}`);
  assert.ok(msg.includes('腰壁・垂れ壁（LDK／和室の間）') || msg.includes('LDK'), msg);
});

test('【失敗系】展開 init: 材未解決の図は fit 失敗を通知し、出力は割当て無しとバイト一致（線を出さない）', async () => {
  setOverlay(DF, { user: [matFig()] });
  const withRef = new ElevationModeState(twoRooms({ ...KNEE, detailRefs: { [KNEE_TOP]: 'df-mat' } }).graph, null, { width: 1600, height: 1200 });
  await withRef.init();
  const plain = new ElevationModeState(twoRooms(KNEE).graph, null, { width: 1600, height: 1200 });
  await plain.init();
  assert.ok(String(withRef.materialError).includes('腰壁の天端に合わせられません'), String(withRef.materialError));
  assert.equal(JSON.stringify(withRef.bands.map(b => b.primitives)), JSON.stringify(plain.bands.map(b => b.primitives)));
});
