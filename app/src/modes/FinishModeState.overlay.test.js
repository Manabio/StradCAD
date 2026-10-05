// FinishModeState.init() の interiorMasters が doc overlay（文書同梱）を反映することの確認
// （2026-09-23 QA指摘Major-2）。setOverlay/clearOverlaysで catalog/catalogRegistry.js の
// モジュールスコープ状態を変えるため、汚染を避けて FinishModeState.test.js とは別ファイルにする
// （catalogRegistry.overlay.test.js・core/room.overlay.test.jsと同じ方針。node:testはファイル
// 単位で別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, overlayGeneration } from '../catalog/catalogRegistry.js';

function makeSingleCellGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  return graph;
}

test.afterEach(() => clearOverlays());

test('FinishModeState.init: doc overlayの内装マスターがgetInteriorMaster()に反映される', async () => {
  setOverlay(CatalogKind.INTERIOR_MASTER, {
    doc: [{
      key: 'LIVING_ROOM', label: '居室（文書同梱で上書き）',
      wallMaterial: '999999999999', wallFinish: '999999999998', ceilingHeight: 3000,
    }],
  });
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  await state.init();

  const master = state.getInteriorMaster('LIVING_ROOM');
  assert.ok(master, 'doc overlayのLIVING_ROOMが取得できるはず');
  assert.equal(master.wallMaterial, '999999999999');
  assert.equal(master.ceilingHeight, 3000);
});

test('FinishModeState.init: doc overlayが無ければbuiltinのINTERIOR_MASTERSどおりの値になる', async () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  await state.init();

  assert.equal(state.getInteriorMaster('LIVING_ROOM').wallMaterial, '301000000002');
  assert.equal(state.getInteriorMaster('LIVING_ROOM').ceilingHeight, 2700);
});

test('FinishModeState.materialOverlayGeneration: init 前は null、init 後は材マスタを作った時点の overlayGeneration()、世代を進めて作り直すと新しい値', async () => {
  const state = new FinishModeState(makeSingleCellGraph(), null);
  assert.equal(state.materialOverlayGeneration, null);
  await state.init();
  assert.equal(state.materialOverlayGeneration, overlayGeneration());

  const before = overlayGeneration();
  clearOverlays();
  assert.ok(overlayGeneration() > before, '前提: カタログ世代が進んだ');
  assert.notEqual(state.materialOverlayGeneration, overlayGeneration(), '旧 state の記録は古い世代のまま');
  const state2 = new FinishModeState(makeSingleCellGraph(), null);
  await state2.init();
  assert.equal(state2.materialOverlayGeneration, overlayGeneration());
});
