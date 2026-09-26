import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  shouldShowPlanFigure, shouldShowStairStepNumbers, shouldShowIntersectionMarkers, shouldShowColumnOriginMarks,
} from './planFigureVisibility.js';

// 行コメントを落としてから照合する（コメント中の言及を「コード上の参照」と誤検知しないため。
// StructuralLayer.invariants.test.js の codeLines と同じ簡易化方針。QA指摘Minor-6・2026-09-27）。
function codeLines(src) {
  return src.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '')).join('\n');
}

test('shouldShowPlanFigure: 平面・建具・仕上げ・敷地は平面図一式を描く', () => {
  for (const mode of ['floorplan', 'opening', 'finish', 'site']) {
    assert.equal(shouldShowPlanFigure(mode), true, mode);
  }
});

test('shouldShowPlanFigure: 伏図（構造）と展開図は描かない', () => {
  assert.equal(shouldShowPlanFigure('structure'), false);
  assert.equal(shouldShowPlanFigure('elevation'), false);
});

test('shouldShowIntersectionMarkers: 通り芯交点の青丸は平面・建具・仕上げ・展開で描き、敷地と構造（伏図。主構造によらず）では描かない', () => {
  for (const mode of ['floorplan', 'opening', 'finish', 'elevation']) assert.equal(shouldShowIntersectionMarkers(mode), true, mode);
  for (const mode of ['site', 'structure']) assert.equal(shouldShowIntersectionMarkers(mode), false, mode);
});

test('【不変条件】SceneLayers.jsx: IntersectionMarkers の表示は shouldShowIntersectionMarkers(appMode) でゲートする（appMode 直書き禁止）', () => {
  const src = codeLines(fs.readFileSync(path.resolve(import.meta.dirname, 'SceneLayers.jsx'), 'utf8'));
  assert.ok(/\{shouldShowIntersectionMarkers\(appMode\) && <IntersectionMarkers /.test(src), 'IntersectionMarkers が述語でゲートされていない');
  assert.ok(!/appMode !== 'site' && <IntersectionMarkers/.test(src), '旧の appMode 直書きゲートが残っている');
});

test('shouldShowStairStepNumbers: 段数字（注記）は平面モードのみ', () => {
  assert.equal(shouldShowStairStepNumbers('floorplan'), true);
  for (const mode of ['opening', 'finish', 'site', 'structure', 'elevation']) {
    assert.equal(shouldShowStairStepNumbers(mode), false, mode);
  }
});

test('shouldShowColumnOriginMarks: 柱の由来×は平面モードのみ（伏図は全黒のまま・柱の由来別色分け ステップ3）', () => {
  assert.equal(shouldShowColumnOriginMarks('floorplan'), true);
  for (const mode of ['opening', 'finish', 'site', 'structure', 'elevation']) {
    assert.equal(shouldShowColumnOriginMarks(mode), false, mode);
  }
});

test('【不変条件】SceneLayers.jsx: ColumnsLayer の originMarks は shouldShowColumnOriginMarks(appMode) でゲートする（appMode 直書き禁止）', () => {
  const src = codeLines(fs.readFileSync(path.resolve(import.meta.dirname, 'SceneLayers.jsx'), 'utf8'));
  assert.ok(/<ColumnsLayer graph=\{graph\} viewport=\{viewport\} finishWrap originMarks=\{shouldShowColumnOriginMarks\(appMode\)\} \/>/.test(src),
    'ColumnsLayer の originMarks が shouldShowColumnOriginMarks(appMode) でゲートされていない');
});
