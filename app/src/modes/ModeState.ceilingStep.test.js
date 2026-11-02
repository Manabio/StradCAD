// 天井の段差（CeilingZone／Room.detailRefs の ceilingStep。部分詳細図 S8b-4a）の仕上げモード init・展開モード init の通知と、展開の差し替え（倍率ゲート）。
// 実グラフ（3 列×1 行の部屋・右列が低い天井の区画）で FinishModeState.init／ElevationModeState.init を通す。新 golden は作らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, CeilingZone } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { ElevationModeState } from './ElevationModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { takeUnresolvedCodes, clearDocumentAliases } from '../catalog/codeNormalization.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { DetailSlot, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { ceilingNoseFigure } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { CEILING_STEP } = DetailSlot;

test.afterEach(() => { clearOverlays(); clearDocumentAliases(); takeUnresolvedCodes(); });

// 3 列（0-2000-4000-6000）×1 行（0-3000）。右列が区画（高さ rightH）。assign＝区画に割り当てる図のキー（null は割当て無し）
function graphWithCeilingStep(rightH, assign, key = 'k') {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  room.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, room).map(w => w.id));
  room.setOverride('ceilingHeight', '2400');
  const { zones, zoneId } = createZone(graph, room, [cellKey(2, 3)], { heightMm: rightH, shape: 'flat', dims: [] });
  room.setCeilingZones(zones.map(z => (z.id === zoneId && assign ? new CeilingZone({ ...z.toData(), detailRefs: { [CEILING_STEP]: key } }) : z)));
  return { graph, room, zoneId };
}

// ---- 仕上げモード init ----

test('仕上げ init: 天井の段差の図が段差高に合わない区画は detail-fit-failed の行 1 行（stepHeightMm 付き・主語は「部屋「X」の区画n」）。合う段差高は行を作らない', async () => {
  setOverlay(DF, { user: [ceilingNoseFigure('df-cs')] });
  const tight = graphWithCeilingStep(2400 - 60, true, 'df-cs'); // 固定寸法の和（70）以下
  const rows = (await new FinishModeState(tight.graph, null).init()).catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'detail-fit-failed');
  assert.ok(rows[0].message.includes('部屋「LDK」の区画1') && rows[0].message.includes('の天井の段差に合わせられません'), rows[0].message);
  const ok = graphWithCeilingStep(2100, true, 'df-cs');
  assert.deepEqual((await new FinishModeState(ok.graph, null).init()).catalogResolveRows.filter(r => r.kind === DF), []);
});

test('仕上げ init: 区画の割当ての参照切れは unresolved-code の行（usage は location ceilingZone・roomId・zoneId・slot ceilingStep）。fit 失敗の行は出ない', async () => {
  const { graph, room, zoneId } = graphWithCeilingStep(2100, true, 'df-gone');
  const rows = (await new FinishModeState(graph, null).init()).catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'unresolved-code');
  assert.deepEqual(rows[0].usage.map(u => [u.location, u.roomId, u.zoneId, u.slot]), [['ceilingZone', room.id, zoneId, CEILING_STEP]]);
});

test('仕上げ init: 部屋単位の割当て（Room.detailRefs の ceilingStep）の参照切れも unresolved-code（location room）', async () => {
  const { graph, room } = graphWithCeilingStep(2100, false);
  room.setDetailRefs({ [CEILING_STEP]: 'df-gone' });
  const rows = (await new FinishModeState(graph, null).init()).catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].usage.map(u => [u.location, u.roomId, u.slot]), [['room', room.id, CEILING_STEP]]);
});

test('_collectReferencedCodes: 区画の割当ての図の material 束縛の材コードが推移して載る（割当て無し・参照切れなら載らない）', () => {
  const MAT = '101000000001';
  const fig = ceilingNoseFigure('df-mat');
  fig.strokes[0].moves[1] = { dir: 'U', len: { mm: 40, mode: 'material', code: MAT, field: 'thickness' } };
  setOverlay(DF, { user: [fig] });
  const { graph, room, zoneId } = graphWithCeilingStep(2100, false);
  const state = new FinishModeState(graph, null);
  assert.equal(state._collectReferencedCodes().has(MAT), false, '前提: 割当て無しなら載らない');
  const assignTo = key => room.setCeilingZones(room.ceilingZones.map(z => (z.id === zoneId ? new CeilingZone({ ...z.toData(), detailRefs: { [CEILING_STEP]: key } }) : z)));
  assignTo('df-mat');
  assert.equal(state._collectReferencedCodes().has(MAT), true);
  assignTo('df-gone');
  assert.equal(state._collectReferencedCodes().has(MAT), false, '参照切れの図は材を載せない（例外にしない）');
});

// ---- 展開モード init ----

const BIG = { width: 1600, height: 1200 };   // 倍率が詳細（分母 ≤ 60）になる大きさ
const TINY = { width: 700, height: 500 };    // 倍率が小さい
async function build(viewSize, rightH, assign, key) {
  const { graph } = graphWithCeilingStep(rightH, assign, key);
  const state = new ElevationModeState(graph, null, viewSize);
  const result = await state.init();
  return { state, result, prims: state.bands.flatMap(b => b.primitives) };
}
const detailPolys = prims => prims.filter(p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thick');

test('展開 init: 倍率が詳細の 2 パス目だけ天井の段差の縦線が見切りの輪郭へ差し替わる（上辺・下辺の 2 面）。小さい倍率・割当て無しは差し替えない', async () => {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const big = await build(BIG, 2100, true);
  assert.equal(big.result.ok, true);
  assert.equal(big.state.materialError, null);
  const polys = detailPolys(big.prims);
  assert.equal(polys.length, 2, `輪郭: ${polys.length}`);
  assert.ok(polys.every(p => p.points.length === 7), JSON.stringify(polys[0]?.points));
  assert.equal(detailPolys((await build(TINY, 2100, true)).prims).length, 0, '倍率が小さければ差し替えない');
  const none = await build(BIG, 2100, false);
  assert.equal(detailPolys(none.prims).length, 0, '割当て無し');
  assert.equal(none.state.materialError, null);
});

test('展開 init: 輪郭は高い側（上辺の面では左へ・下辺の面では右へ）へ出る。高い側の区画の割当て（区画が 2700＝高い側）は使わない', async () => {
  setOverlay(DF, { user: [ceilingNoseFigure('k')] });
  const dirs = polys => polys.map(p => {
    const tip = p.points[4]; // (出, −厚) の頂点
    return Math.sign(tip[0] - p.points[0][0]);
  });
  assert.deepEqual(dirs(detailPolys((await build(BIG, 2100, true)).prims)), [-1, 1]);
  const high = await build(BIG, 2700, true);
  assert.equal(detailPolys(high.prims).length, 0, '高い側の区画の割当ては使わない');
});

test('【失敗系】展開 init: 存在しないキーは差し替えず、トーストは 1 回（部屋「LDK」の区画1・天井の段差）', async () => {
  const { prims, result, state } = await build(BIG, 2100, true, 'df-gone');
  assert.equal(detailPolys(prims).length, 0);
  assert.equal(result.ok, true, '通知は ok の判定に含めない');
  assert.ok(state.materialError && state.materialError.includes('部屋「LDK」の区画1') && state.materialError.includes('天井の段差'), String(state.materialError));
  assert.ok(!state.materialError.includes('ほか'), '1 件は「ほか」を付けない');
});

test('【失敗系】展開 init: 段差高に合わない図（固定寸法の和が段差高以上）は出力が割当て無しとバイト一致・通知は 1 回', async () => {
  setOverlay(DF, { user: [ceilingNoseFigure('df-tall', { thickness: 400 })] }); // 厚 400 > 段差高 300
  const base = await build(BIG, 2100, false);
  const fail = await build(BIG, 2100, true, 'df-tall');
  assert.equal(JSON.stringify(fail.prims), JSON.stringify(base.prims));
  assert.ok(fail.state.materialError.includes('の天井の段差に合わせられません'), String(fail.state.materialError));
  assert.equal(base.state.materialError, null);
});
