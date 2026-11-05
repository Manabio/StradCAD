// 姿図の配置（PlanGraph.placedFigures）の仕上げ undo（snapshot の `placedFigures` キー）のテスト。
// finishUndo.roofZones.test.js と同型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, PlacedFigure, PLACED_FIGURE_KEYS, ShaftSoundproof } from '../core.js';
import { undoManager } from '../undoManager.js';
import { withFinishUndo, snapshotFinishState, restoreFinishState } from './finishUndo.js';
import { addPlacedFigure, updatePlacedFigure, removePlacedFigure } from './placedFigure/placedFigureOps.js';

function freshGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

const pf = (id, over = {}) => new PlacedFigure({ id, figureKey: 'df-a', x: 1820, y: -455, rotationDeg: 270, mirror: true, zMm: 850, note: 'n', ...over });

test('不変条件: snapshot の placedFigures は PlacedFigure.toData のキー集合と一致する（配置なしは []）', () => {
  const graph = freshGraph();
  assert.deepEqual(snapshotFinishState(graph).placedFigures, []);
  graph.setPlacedFigures([pf('a')]);
  const snap = snapshotFinishState(graph);
  assert.deepEqual(Object.keys(snap.placedFigures[0]).sort(), [...PLACED_FIGURE_KEYS].sort());
  assert.deepEqual(snap.placedFigures[0], pf('a').toData());
});

test('配置の追加・移動・削除を withFinishUndo で包むと undo/redo で戻る（1エントリずつ）', () => {
  const graph = freshGraph();
  const before = undoManager._undoStack.length;
  withFinishUndo(graph, () => graph.setPlacedFigures(addPlacedFigure(graph.placedFigures, pf('a'))));
  assert.equal(undoManager._undoStack.length, before + 1);
  assert.equal(graph.placedFigures.length, 1);
  undoManager.undo();
  assert.deepEqual(graph.placedFigures, []);
  undoManager.redo();
  assert.deepEqual(graph.placedFigures.map(p => p.toData()), [pf('a').toData()]);

  withFinishUndo(graph, () => graph.setPlacedFigures(updatePlacedFigure(graph.placedFigures, 'a', { x: 5 })));
  assert.equal(graph.placedFigures[0].x, 5);
  undoManager.undo();
  assert.equal(graph.placedFigures[0].x, 1820, '移動の undo で元の座標が戻る');

  withFinishUndo(graph, () => graph.setPlacedFigures(removePlacedFigure(graph.placedFigures, 'a')));
  assert.deepEqual(graph.placedFigures, []);
  undoManager.undo();
  assert.deepEqual(graph.placedFigures.map(p => p.toData()), [pf('a').toData()], '削除の undo で同 id・同値が戻る');
  undoManager.undo();
  undoManager.undo(); // 後始末（積んだ分を戻す）
  assert.deepEqual(graph.placedFigures, []);
});

test('配置を作った後に別の仕上げ操作を挟んで undo/redo しても、配置は初期化されない（列挙漏れ対策）', () => {
  const graph = freshGraph();
  withFinishUndo(graph, () => graph.setPlacedFigures([pf('a')]));
  withFinishUndo(graph, () => graph.setShaftSoundproof(ShaftSoundproof.INSULATION));
  undoManager.undo();
  assert.equal(graph.placedFigures.length, 1, '別操作の undo で配置が失われない');
  undoManager.redo();
  assert.equal(graph.placedFigures.length, 1, '別操作の redo でも保たれる');
  undoManager.undo();
  undoManager.undo();
  assert.deepEqual(graph.placedFigures, []);
});

test('【失敗系】restoreFinishState: placedFigures キー欠落（旧スナップショット）は配置なし、壊れた配置は復元で捨てられる', () => {
  const graph = freshGraph();
  const snap = snapshotFinishState(freshGraph());
  graph.setPlacedFigures([pf('a')]);
  const legacy = { ...snap };
  delete legacy.placedFigures;
  restoreFinishState(graph, legacy);
  assert.deepEqual(graph.placedFigures, []);

  restoreFinishState(graph, {
    ...snap,
    placedFigures: [{ ...pf('bad').toData(), rotationDeg: 45 }, pf('ok').toData()],
  });
  assert.deepEqual(graph.placedFigures.map(p => p.id), ['ok'], '回転 45 の配置は捨てる');
  assert.ok(Object.isFrozen(graph.placedFigures));
});
