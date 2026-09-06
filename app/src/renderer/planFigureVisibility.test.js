import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowPlanFigure, shouldShowStairStepNumbers } from './planFigureVisibility.js';

test('shouldShowPlanFigure: 平面・建具・仕上げ・敷地は平面図一式を描く', () => {
  for (const mode of ['floorplan', 'opening', 'finish', 'site']) {
    assert.equal(shouldShowPlanFigure(mode), true, mode);
  }
});

test('shouldShowPlanFigure: 伏図（構造）と展開図は描かない', () => {
  assert.equal(shouldShowPlanFigure('structure'), false);
  assert.equal(shouldShowPlanFigure('elevation'), false);
});

test('shouldShowStairStepNumbers: 段数字（注記）は平面モードのみ', () => {
  assert.equal(shouldShowStairStepNumbers('floorplan'), true);
  for (const mode of ['opening', 'finish', 'site', 'structure', 'elevation']) {
    assert.equal(shouldShowStairStepNumbers(mode), false, mode);
  }
});
