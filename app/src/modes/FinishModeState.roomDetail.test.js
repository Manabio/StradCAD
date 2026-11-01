// 仕上げモード init の部屋の取り合い（Room.detailRefs。部分詳細図 S8a）の通知: 未解決キーは unresolved-code、
// 壁厚に合わせられない図は detail-fit-failed、材束縛の推移は参照材コードに載る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { takeUnresolvedCodes, clearDocumentAliases } from '../catalog/codeNormalization.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { DetailSlot } from '../core/constants.js';
import { wallBackedFigure, junctionFigure, move, fixedLen, stretchLen, materialLen } from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_WALL, WALL_CEILING } = DetailSlot;

test.afterEach(() => { clearOverlays(); clearDocumentAliases(); takeUnresolvedCodes(); });

function graphWithRoom(name = 'LDK') {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y0, y1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 4000), cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  room.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, room).map(w => w.id));
  return { graph, room };
}

test('catalogResolveKinds に部分詳細図が含まれる（App の行マージが自分の種別だけを置き換える）', () => {
  assert.ok(new FinishModeState(graphWithRoom().graph, null).catalogResolveKinds.includes(DF));
});

test('init: 割当ての無い文書は部分詳細図の行を作らない', async () => {
  const { graph } = graphWithRoom();
  const result = await new FinishModeState(graph, null).init();
  assert.deepEqual(result.catalogResolveRows.filter(r => r.kind === DF), []);
});

test('init: 部屋の detailRefs が指す図がカタログに無いと unresolved-code の行（kind 部分詳細図・usage は room と roomId・slot）', async () => {
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-gone', [WALL_CEILING]: 'df-gone' });
  const result = await new FinishModeState(graph, null).init();
  const rows = result.catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length, 1, '同じ図は 1 行にまとまる');
  assert.equal(rows[0].scenario, 'unresolved-code');
  assert.equal(rows[0].targetKey, 'df-gone');
  assert.deepEqual(rows[0].usage.map(u => [u.location, u.roomId, u.slot]), [['room', room.id, FLOOR_WALL], ['room', room.id, WALL_CEILING]]);
});

test('init: 壁厚に合わせられない図は detail-fit-failed の行（図の参照切れとは別の行）。収まる図は行を作らない', async () => {
  setOverlay(DF, { user: [wallBackedFigure('df-tight', FLOOR_WALL, 5000), wallBackedFigure('df-ok', WALL_CEILING)] });
  const { graph, room } = graphWithRoom('LDK');
  room.setDetailRefs({ [FLOOR_WALL]: 'df-tight', [WALL_CEILING]: 'df-ok' });
  const result = await new FinishModeState(graph, null).init();
  const rows = result.catalogResolveRows.filter(r => r.kind === DF);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'detail-fit-failed');
  assert.ok(rows[0].message.includes('部屋「LDK」') && rows[0].message.includes('の床と壁に合わせられません'), rows[0].message);
  assert.deepEqual(rows[0].allowedActions, ['defer']);
});

test('【失敗系】init: 図の合わせ込み検査が例外を投げても仕上げモードに入れる（行は空）', async () => {
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-x' });
  setOverlay(DF, { user: [wallBackedFigure('df-x')] });
  room.generatedWallIds = { [Symbol.iterator]() { throw new Error('壊れた壁 id 列'); } };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const result = await new FinishModeState(graph, null).init();
    assert.deepEqual(result.catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed'), []);
  } finally { console.error = orig; }
  assert.equal(errors.length, 1);
});

test('_collectReferencedCodes: 部屋の取り合いの図の material 束縛の材コードが推移して載る（12 桁の材コードのみ・割当て無しなら載らない）', () => {
  const MAT = '101000000001';
  const fig = junctionFigure('df-mat', FLOOR_WALL, [
    move('U', materialLen(MAT, 'thickness', 12)), move('L', fixedLen(3)), move('L', stretchLen(50)),
  ], { endVertex: 3 });
  setOverlay(DF, { user: [fig] });
  const { graph, room } = graphWithRoom();
  const state = new FinishModeState(graph, null);
  assert.equal(state._collectReferencedCodes().has(MAT), false, '前提: 割当て無しなら載らない');
  room.setDetailRefs({ [FLOOR_WALL]: 'df-mat' });
  assert.equal(state._collectReferencedCodes().has(MAT), true);
  room.setDetailRefs({ [FLOOR_WALL]: 'df-gone' });
  assert.equal(state._collectReferencedCodes().has(MAT), false, '参照切れの図は材を載せない（例外にしない）');
});
