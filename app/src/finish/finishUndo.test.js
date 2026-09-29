// withFinishUndo が per-floor 設定（PER_FLOOR_SETTERS）を before/after スナップショットの
// 対象に含めているかのテスト。含まれていないと undo しても値が戻らない
// （§昇降路 壁仕上げ材／防音材 ステップ2b の PER_FLOOR_SETTERS 追加分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, ShaftSoundproof, ElevatorEquipmentCategory, DEFAULT_EV_USAGE, EvUsage } from '../core.js';
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

test('graph.equipmentRows の追加を withFinishUndo 経由で行い undo/redo すると器具行が消えたり戻ったりする', () => {
  const graph = freshGraph();
  assert.equal(graph.equipmentRows.length, 0, '前提: 変更前は0件');

  withFinishUndo(graph, () => graph.addEquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: DEFAULT_EV_USAGE, no: 1,
    cellKeys: new Set(['a:b:c:d']),
  }));
  assert.equal(graph.equipmentRows.length, 1);
  assert.equal(graph.equipmentRows[0].id, 'eq1');

  undoManager.undo();
  assert.equal(graph.equipmentRows.length, 0, 'undo で器具行が消えない');

  undoManager.redo();
  assert.equal(graph.equipmentRows.length, 1, 'redo で器具行が戻らない');
  assert.equal(graph.equipmentRows[0].id, 'eq1', 'redo後も同じidで復元されていない');
});

test('graph.equipmentRows の usage 変更を withFinishUndo 経由で行い undo すると元の用途に戻る（同id維持）', () => {
  const graph = freshGraph();
  const row = graph.addEquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: EvUsage.PASSENGER, no: 1,
    cellKeys: new Set(['a:b:c:d']),
  });

  withFinishUndo(graph, () => row.setUsage(EvUsage.FREIGHT));
  assert.equal(graph.equipmentRows[0].usage, EvUsage.FREIGHT);

  undoManager.undo();
  assert.equal(graph.equipmentRows[0].usage, EvUsage.PASSENGER, 'undo で用途が戻らない');
  assert.equal(graph.equipmentRows[0].id, 'eq1', 'undo後も同じidのまま');

  undoManager.redo();
  assert.equal(graph.equipmentRows[0].usage, EvUsage.FREIGHT, 'redo で用途が戻らない');
});
