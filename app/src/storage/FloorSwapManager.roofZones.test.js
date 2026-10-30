// FloorSwapManager の auto-save（dirty 追跡）が屋根区画の作成・削除を見ること。
// IDB を経由しない（_startAutoSave は mobx の autorun と dirtyState だけで完結する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, RoofZone } from '../core.js';
import { FloorSwapManager } from './FloorSwapManager.js';
import { isDirty, clearDirty } from '../dirtyState.js';

test('屋根区画の作成・削除（setRoofZones）で dirty になる', () => {
  clearDirty();
  const plane = new Plane('p-roofzone', 0, '3階', 3, 1);
  const graph = new PlanGraph(plane);
  const mgr = new FloorSwapManager();
  mgr._startAutoSave(plane, graph);
  assert.equal(isDirty(), false, '前提: 開始直後は dirty でない');

  runInAction(() => graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a'] })]));
  assert.equal(isDirty(), true, '区画の作成で dirty');

  clearDirty();
  runInAction(() => graph.setRoofZones([]));
  assert.equal(isDirty(), true, '区画の削除で dirty');

  mgr._stopAutoSave(plane.id);
});

test('【失敗系】auto-save 停止後の区画変更では dirty にならない', () => {
  clearDirty();
  const plane = new Plane('p-roofzone2', 0, '3階', 3, 1);
  const graph = new PlanGraph(plane);
  const mgr = new FloorSwapManager();
  mgr._startAutoSave(plane, graph);
  mgr._stopAutoSave(plane.id);
  runInAction(() => graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a'] })]));
  assert.equal(isDirty(), false);
});
