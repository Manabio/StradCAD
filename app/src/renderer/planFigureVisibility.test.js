import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  shouldShowPlanFigure, shouldShowStairFigure, shouldShowStairStepNumbers, shouldShowIntersectionMarkers, shouldShowColumnOriginMarks,
  shouldShowEquipmentSymbols, shouldShowPlacedFigures, planSectionDirection, shouldShowSiteBoundaryOverlay,
} from './planFigureVisibility.js';

// 行コメントを落としてから照合する（コメント中の言及を「コード上の参照」と誤検知しないため。
// StructuralLayer.invariants.test.js の codeLines と同じ簡易化方針。QA指摘Minor-6・2026-09-27）。
function codeLines(src) {
  return src.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '')).join('\n');
}

test('shouldShowPlanFigure: 平面・建具・仕上げは平面図一式を描く', () => {
  for (const mode of ['floorplan', 'opening', 'finish']) {
    assert.equal(shouldShowPlanFigure(mode), true, mode);
  }
});

test('shouldShowPlanFigure: 敷地は配置図の表示・非表示に関わらず平面図一式を描かない（ユーザー指示2026-11-09）。派生の述語も false', () => {
  assert.equal(shouldShowPlanFigure('site'), false);
  assert.equal(shouldShowStairFigure('site'), false);
  assert.equal(shouldShowPlacedFigures('site'), false);
});

test('planSectionDirection: 天伏（ceiling）は見上げ（up）、他のモードは見下げ（down）。未知・欠落のモードも down', () => {
  assert.equal(planSectionDirection('ceiling'), 'up');
  for (const mode of ['floorplan', 'opening', 'finish', 'site', 'structure', 'elevation', 'unknown', '', 'Ceiling', undefined, null]) {
    assert.equal(planSectionDirection(mode), 'down', String(mode));
  }
});

test('shouldShowPlanFigure: 天伏（ceiling）も平面図一式を描く（見上げの向きだけが違う）', () => {
  assert.equal(shouldShowPlanFigure('ceiling'), true);
});

test('shouldShowStairFigure: 階段の図は平面・建具・仕上げで描き、天伏（上階の裏面で表す）・伏図・展開図・敷地では描かない。未知のモードは shouldShowPlanFigure と同じく描く', () => {
  for (const mode of ['floorplan', 'finish', 'opening']) assert.equal(shouldShowStairFigure(mode), true, mode);
  for (const mode of ['ceiling', 'structure', 'elevation', 'site']) assert.equal(shouldShowStairFigure(mode), false, mode);
  assert.equal(shouldShowStairFigure('ceiling'), false);
  assert.equal(shouldShowStairFigure('foo'), true, '未知のモードは除外列挙（ceiling・structure・elevation・site）に無いので描く');
  assert.equal(shouldShowPlanFigure('ceiling'), true, '壁・建具・柱は天伏でも描く（階段だけ別の述語）');
});

test('shouldShowPlanFigure: 伏図（構造）と展開図・立面図は描かない', () => {
  assert.equal(shouldShowPlanFigure('structure'), false);
  assert.equal(shouldShowPlanFigure('elevation'), false);
  assert.equal(shouldShowPlanFigure('facade'), false);
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

test('shouldShowPlacedFigures: 姿図の配置は平面図一式と同じモード（天伏も含む）で描き、伏図・展開・立面では描かない', () => {
  for (const mode of ['floorplan', 'finish', 'ceiling', 'opening']) assert.equal(shouldShowPlacedFigures(mode), true, mode);
  for (const mode of ['structure', 'elevation', 'facade', 'site']) assert.equal(shouldShowPlacedFigures(mode), false, mode);
});

test('shouldShowSiteBoundaryOverlay: 敷地の境界線の重ねは 平面・仕上げ・天伏・構造 だけ（敷地・展開・立面・建具・未知は偽）', () => {
  for (const mode of ['floorplan', 'finish', 'ceiling', 'structure']) assert.equal(shouldShowSiteBoundaryOverlay(mode), true, mode);
  for (const mode of ['site', 'elevation', 'facade', 'opening', 'unknown', undefined]) assert.equal(shouldShowSiteBoundaryOverlay(mode), false, String(mode));
});

test('shouldShowEquipmentSymbols: 昇降機器具の図中記号は室名が出るモード（floorplan・finish）でのみ描く', () => {
  for (const mode of ['floorplan', 'finish']) assert.equal(shouldShowEquipmentSymbols(mode), true, mode);
  for (const mode of ['opening', 'site', 'structure', 'elevation']) assert.equal(shouldShowEquipmentSymbols(mode), false, mode);
});
