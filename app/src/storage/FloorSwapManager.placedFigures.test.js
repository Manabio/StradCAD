// FloorSwapManager の auto-save（dirty 追跡）が姿図の配置の作成・削除を見ること。
// IDB を経由しない（_startAutoSave は mobx の autorun と dirtyState だけで完結する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph } from '../core.js';
import { PlacedFigure } from '../core/placedFigure.js';
import { FloorSwapManager } from './FloorSwapManager.js';
import { isDirty, clearDirty } from '../dirtyState.js';

const placed = () => new PlacedFigure({ id: 'pf1', figureKey: 'df-a', x: 310, y: 170, rotationDeg: 90, zMm: 850 });

test('姿図の配置の作成・削除（setPlacedFigures）で dirty になる', () => {
  clearDirty();
  const plane = new Plane('p-placedfig', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const mgr = new FloorSwapManager();
  mgr._startAutoSave(plane, graph);
  assert.equal(isDirty(), false, '前提: 開始直後は dirty でない');

  runInAction(() => graph.setPlacedFigures([placed()]));
  assert.equal(isDirty(), true, '配置の作成で dirty');

  clearDirty();
  runInAction(() => graph.setPlacedFigures([]));
  assert.equal(isDirty(), true, '配置の削除で dirty');

  mgr._stopAutoSave(plane.id);
});

test('【失敗系】auto-save 停止後の配置変更では dirty にならない', () => {
  clearDirty();
  const plane = new Plane('p-placedfig2', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const mgr = new FloorSwapManager();
  mgr._startAutoSave(plane, graph);
  mgr._stopAutoSave(plane.id);
  runInAction(() => graph.setPlacedFigures([placed()]));
  assert.equal(isDirty(), false);
});
