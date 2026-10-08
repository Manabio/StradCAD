import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, DEFAULT_PLAN_CUT_HEIGHT_MM, planCutHeightMmOf } from './plane.js';
import { Project } from './project.js';

test('DEFAULT_PLAN_CUT_HEIGHT_MM は 1500（従来の PLAN_CUT_HEIGHT と同値）', () => {
  assert.equal(DEFAULT_PLAN_CUT_HEIGHT_MM, 1500);
});

test('new Plane: 切断高の既定は 1500、指定すればその値', () => {
  assert.equal(new Plane('p', 0).planCutHeightMm, 1500);
  assert.equal(new Plane('p', 0, '', 1, 1, false, null, 0, false, null, 1100).planCutHeightMm, 1100);
});

test('Project.addPlane: 第11引数の切断高が Plane に入る。未指定・undefined は既定 1500', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p', 1, 1, false, null, 0, false, null, 1100);
  project.addPlane(3000, '2階', 'q', 2, 1);
  project.addPlane(6000, '3階', 'r', 3, 1, false, null, 0, false, null, undefined);
  assert.equal(project.planeMap.get('p').planCutHeightMm, 1100);
  assert.equal(project.planeMap.get('q').planCutHeightMm, 1500);
  assert.equal(project.planeMap.get('r').planCutHeightMm, 1500);
});

test('planCutHeightMmOf: 明示された有限の正数はそのまま返す', () => {
  assert.equal(planCutHeightMmOf({ planCutHeightMm: 1200 }), 1200);
  assert.equal(planCutHeightMmOf(new Plane('p', 0, '', 1, 1, false, null, 0, false, null, 900.5)), 900.5);
});

test('【失敗系】planCutHeightMmOf: 0・負・NaN・Infinity・null・undefined・文字列・plane 無しは既定値', () => {
  for (const bad of [0, -1, NaN, Infinity, null, undefined, '1200']) {
    assert.equal(planCutHeightMmOf({ planCutHeightMm: bad }), 1500, `値 ${String(bad)}`);
  }
  assert.equal(planCutHeightMmOf(null), 1500);
  assert.equal(planCutHeightMmOf(undefined), 1500);
  assert.equal(planCutHeightMmOf({}), 1500);
});
