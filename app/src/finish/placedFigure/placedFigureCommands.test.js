// 姿図の配置の命令（placedFigureCommands.js）の単体テスト。戻り値・undo の件数・丸めの規約を固定する。
// 切り出し前後の挙動不変は FinishModeState.placedFigure.test.js（無変更）が守る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacedFigure } from '../../core/placedFigure.js';
import { PLACED_FIGURE_POSITION_STEP_MM, PLACED_FIGURE_ROTATION_STEP_DEG, FULL_TURN_DEG } from '../../core/constants.js';
import { undoManager } from '../../undoManager.js';
import { makeFirstFloorGraph as freshGraph } from '../../graphTestFixtures.js';
import {
  roundPlacedFigurePoint, placeFigure, updatePlacedFigureWithUndo, rotatePlacedFigureWithUndo,
  togglePlacedFigureMirrorWithUndo, removePlacedFigureWithUndo,
} from './placedFigureCommands.js';

const depth = () => undoManager._undoStack.length;
const seeded = () => {
  const graph = freshGraph();
  graph.setPlacedFigures([new PlacedFigure({ id: 'a', figureKey: 'k', x: 100, y: 200, rotationDeg: 0, mirror: false })]);
  return graph;
};
const brief = graph => graph.placedFigures.map(p => [p.id, p.figureKey, p.x, p.y, p.rotationDeg, p.mirror]);

test('roundPlacedFigurePoint: 刻み PLACED_FIGURE_POSITION_STEP_MM の倍数へ丸める（境界は Math.round）', () => {
  const s = PLACED_FIGURE_POSITION_STEP_MM;
  const r = roundPlacedFigurePoint(s * 3 + s * 0.4, -(s * 2 + s * 0.6));
  assert.deepEqual([r.x, r.y], [s * 3, -s * 3]);
  const half = roundPlacedFigurePoint(s * 0.5, -s * 0.5);
  assert.deepEqual([half.x, half.y], [s, -0]);
  const exact = roundPlacedFigurePoint(s * 7, s * 9);
  assert.deepEqual([exact.x, exact.y], [s * 7, s * 9]);
});

test('placeFigure: 丸めた点に 1 件追加し id を返す。undo 1 エントリで undo→redo が往復する', () => {
  const graph = freshGraph();
  const d0 = depth();
  const s = PLACED_FIGURE_POSITION_STEP_MM;
  const id = placeFigure(graph, { id: 'n1', figureKey: 'kk', x: s * 3 + s * 0.4, y: s * 5 + s * 0.6 });
  assert.equal(id, 'n1');
  assert.deepEqual(brief(graph), [['n1', 'kk', s * 3, s * 6, 0, false]]);
  assert.equal(depth(), d0 + 1);
  undoManager.undo();
  assert.equal(graph.placedFigures.length, 0);
  undoManager.redo();
  assert.deepEqual(brief(graph), [['n1', 'kk', s * 3, s * 6, 0, false]]);
  undoManager.undo();
});

test('【失敗系】placeFigure: id 重複は RangeError で、配置も undo も増えない', () => {
  const graph = seeded();
  const d0 = depth();
  assert.throws(() => placeFigure(graph, { id: 'a', figureKey: 'k', x: 0, y: 0 }), RangeError);
  assert.equal(graph.placedFigures.length, 1);
  assert.equal(depth(), d0);
});

test('updatePlacedFigureWithUndo: 項目を直して true・undo 1 エントリ。undo→redo で往復する', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(updatePlacedFigureWithUndo(graph, 'a', { x: 5, y: 6 }), true);
  assert.deepEqual(brief(graph), [['a', 'k', 5, 6, 0, false]]);
  assert.equal(depth(), d0 + 1);
  undoManager.undo();
  assert.deepEqual(brief(graph), [['a', 'k', 100, 200, 0, false]]);
  undoManager.redo();
  assert.equal(graph.placedFigures[0].x, 5);
  undoManager.undo();
});

test('【失敗系】updatePlacedFigureWithUndo: 無い id は false で undo を積まない／不正な値は RangeError で積まない', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(updatePlacedFigureWithUndo(graph, 'zz', { x: 5 }), false);
  assert.equal(depth(), d0);
  assert.throws(() => updatePlacedFigureWithUndo(graph, 'a', { rotationDeg: 45 }), RangeError);
  assert.equal(depth(), d0);
  assert.equal(graph.placedFigures[0].rotationDeg, 0);
});

test('updatePlacedFigureWithUndo: 値が変わらない更新は true だが undo は積まれない（差分なし）', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(updatePlacedFigureWithUndo(graph, 'a', { x: 100 }), true);
  assert.equal(depth(), d0);
});

test('rotatePlacedFigureWithUndo: STEP 度ずつ回り FULL_TURN で 0 に戻る。undo 1 エントリ', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(rotatePlacedFigureWithUndo(graph, 'a'), true);
  assert.equal(graph.placedFigures[0].rotationDeg, PLACED_FIGURE_ROTATION_STEP_DEG % FULL_TURN_DEG);
  assert.equal(depth(), d0 + 1);
  for (let i = 1; i < FULL_TURN_DEG / PLACED_FIGURE_ROTATION_STEP_DEG; i++) rotatePlacedFigureWithUndo(graph, 'a');
  assert.equal(graph.placedFigures[0].rotationDeg, 0);
  while (depth() > d0) undoManager.undo();
  assert.equal(graph.placedFigures[0].rotationDeg, 0);
});

test('【失敗系】rotatePlacedFigureWithUndo／togglePlacedFigureMirrorWithUndo: 無い id は false で undo を積まない', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(rotatePlacedFigureWithUndo(graph, 'zz'), false);
  assert.equal(togglePlacedFigureMirrorWithUndo(graph, 'zz'), false);
  assert.equal(depth(), d0);
});

test('togglePlacedFigureMirrorWithUndo: 反転を切り替え、undo で戻り redo で再適用される', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(togglePlacedFigureMirrorWithUndo(graph, 'a'), true);
  assert.equal(graph.placedFigures[0].mirror, true);
  assert.equal(depth(), d0 + 1);
  undoManager.undo();
  assert.equal(graph.placedFigures[0].mirror, false);
  undoManager.redo();
  assert.equal(graph.placedFigures[0].mirror, true);
  undoManager.undo();
});

test('removePlacedFigureWithUndo: 消して true・undo 1 エントリ。undo で同 id・同値が戻り redo で再び消える', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(removePlacedFigureWithUndo(graph, 'a'), true);
  assert.equal(graph.placedFigures.length, 0);
  assert.equal(depth(), d0 + 1);
  undoManager.undo();
  assert.deepEqual(brief(graph), [['a', 'k', 100, 200, 0, false]]);
  undoManager.redo();
  assert.equal(graph.placedFigures.length, 0);
  undoManager.undo();
});

test('【失敗系】removePlacedFigureWithUndo: 無い id は false で undo を積まない', () => {
  const graph = seeded();
  const d0 = depth();
  assert.equal(removePlacedFigureWithUndo(graph, 'zz'), false);
  assert.equal(graph.placedFigures.length, 1);
  assert.equal(depth(), d0);
});
