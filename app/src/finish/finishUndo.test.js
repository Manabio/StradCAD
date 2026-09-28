// withFinishUndo が per-floor 設定（PER_FLOOR_SETTERS）を before/after スナップショットの
// 対象に含めているかのテスト。含まれていないと undo しても値が戻らない
// （§昇降路 壁仕上げ材／防音材 ステップ2b の PER_FLOOR_SETTERS 追加分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, ShaftSoundproof } from '../core.js';
import { undoManager } from '../undoManager.js';
import { withFinishUndo } from './finishUndo.js';

function freshGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

test('shaftWallMaterial を withFinishUndo 経由で変えて undo すると元の値に戻る', () => {
  const graph = freshGraph();
  const before = graph.shaftWallMaterial;
  const after  = '301000000005';
  assert.notEqual(before, after, '前提: 変更後の値は既定値と異なる');

  withFinishUndo(graph, () => graph.setShaftWallMaterial(after));
  assert.equal(graph.shaftWallMaterial, after);

  undoManager.undo();
  assert.equal(graph.shaftWallMaterial, before, 'undo で既定値に戻らない');

  undoManager.redo();
  assert.equal(graph.shaftWallMaterial, after, 'redo で変更後の値に戻らない');
});

test('shaftSoundproof を withFinishUndo 経由で変えて undo すると元の値に戻る', () => {
  const graph = freshGraph();
  const before = graph.shaftSoundproof;
  assert.equal(before, ShaftSoundproof.NONE, '前提: 既定値は none');

  withFinishUndo(graph, () => graph.setShaftSoundproof(ShaftSoundproof.INSULATION));
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.INSULATION);

  undoManager.undo();
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.NONE, 'undo で既定値に戻らない');

  undoManager.redo();
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.INSULATION, 'redo で変更後の値に戻らない');
});
