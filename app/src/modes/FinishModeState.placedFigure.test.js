// FinishModeState._missingUsageForKind（SNAPSHOT_REF_WALKERS を通らない自前ループ）が
// 姿図の配置（graph.placedFigures[].figureKey）の未解決キーを数えることのテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, PlacedFigure } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';

const pf = (id, figureKey) => new PlacedFigure({ id, figureKey, x: 300, y: 100, rotationDeg: 90 });

function makeState() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  return { graph, state: new FinishModeState(graph, null) };
}

test('_missingUsageForKind(DETAIL_FIGURE): カタログに無い figureKey の配置を {location:placedFigure, placedFigureId, slot:null} で数える', () => {
  const { graph, state } = makeState();
  graph.setPlacedFigures([pf('p1', 'df-ok'), pf('p2', 'df-gone'), pf('p3', 'df-gone')]);
  const usage = state._missingUsageForKind(CatalogKind.DETAIL_FIGURE, new Map([['df-ok', {}]]));
  assert.deepEqual(usage, [
    { code: 'df-gone', location: 'placedFigure', placedFigureId: 'p2', slot: null },
    { code: 'df-gone', location: 'placedFigure', placedFigureId: 'p3', slot: null },
  ]);
});

test('【失敗系】_missingUsageForKind(DETAIL_FIGURE): 配置なし／全て解決済みなら空', () => {
  const { graph, state } = makeState();
  assert.deepEqual(state._missingUsageForKind(CatalogKind.DETAIL_FIGURE, new Map()), []);
  graph.setPlacedFigures([pf('p1', 'df-ok')]);
  assert.deepEqual(state._missingUsageForKind(CatalogKind.DETAIL_FIGURE, new Map([['df-ok', {}]])), []);
});
