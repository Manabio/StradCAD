import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph } from '@core';
import { undoManager } from '../../undoManager.js';
import { commitRoofSpecField, roofSpecFieldChanges } from './roofSpecCommit.js';

const freshGraph = () => new PlanGraph(new Plane('p1', 0, '1階', 1, 1));

test('commitRoofSpecField: 有効な新しい値は確定して true。undo 1エントリで、undo で戻り redo でやり直せる', () => {
  const graph = freshGraph();
  const before = graph.mainRoofSpec.soffitNote;
  const stack = undoManager._undoStack.length;
  assert.equal(commitRoofSpecField(graph, graph.mainRoofSpec, 'soffitNote', '目透かし貼り'), true);
  assert.equal(graph.mainRoofSpec.soffitNote, '目透かし貼り');
  assert.equal(undoManager._undoStack.length, stack + 1, 'undo は1エントリ');
  undoManager.undo();
  assert.equal(graph.mainRoofSpec.soffitNote, before);
  undoManager.redo();
  assert.equal(graph.mainRoofSpec.soffitNote, '目透かし貼り');
});

test('【失敗系】commitRoofSpecField: 無変更は false（undo を積まない）', () => {
  const graph = freshGraph();
  const stack = undoManager._undoStack.length;
  assert.equal(commitRoofSpecField(graph, graph.mainRoofSpec, 'soffitNote', graph.mainRoofSpec.soffitNote), false);
  assert.equal(undoManager._undoStack.length, stack);
});

test('【失敗系】commitRoofSpecField: 不正な値（向きに未知の文字列）は false で値も undo も変わらない', () => {
  const graph = freshGraph();
  const stack = undoManager._undoStack.length;
  assert.equal(commitRoofSpecField(graph, graph.mainRoofSpec, 'soffitOrientation', 'diagonal'), false);
  assert.equal(graph.mainRoofSpec.soffitOrientation, null);
  assert.equal(undoManager._undoStack.length, stack);
});

test('【失敗系】commitRoofSpecField: spec が null/undefined は false（例外にしない）', () => {
  const graph = freshGraph();
  assert.equal(commitRoofSpecField(graph, null, 'slope', 5), false);
  assert.equal(commitRoofSpecField(graph, undefined, 'slope', 5), false);
});

test('roofSpecFieldChanges: 検証・無変更判定だけで書かない（構造モードの外部タブが onStructureChanged の閉包で書く前に使う）', () => {
  const graph = freshGraph();
  const spec = graph.mainRoofSpec;
  const stack = undoManager._undoStack.length;
  assert.equal(roofSpecFieldChanges(spec, 'soffitNote', '目透かし貼り'), true);
  assert.equal(spec.soffitNote, '', '判定だけで値は書かない');
  assert.equal(undoManager._undoStack.length, stack, 'undo も積まない');
  assert.equal(roofSpecFieldChanges(spec, 'soffitNote', spec.soffitNote), false, '無変更');
  assert.equal(roofSpecFieldChanges(spec, 'soffitOrientation', 'diagonal'), false, '不正な値');
  assert.equal(roofSpecFieldChanges(null, 'slope', 5), false);
  assert.equal(roofSpecFieldChanges(undefined, 'slope', 5), false);
});
