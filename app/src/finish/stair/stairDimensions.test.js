// stairDimensions.js の stairRiserOf（Minor-5是正・QAレビュー・T6）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../core.js';
import { stairRiserOf } from './stairDimensions.js';

function makeTwoFloorProject() {
  const project = new Project('proj1', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  project.addPlane(2400, '2階', 'p2');
  return { project, g1 };
}

test('stairRiserOf: stair.riserの明示指定があればそれを優先する（階高が別値でも無視）', () => {
  const { project, g1 } = makeTwoFloorProject();
  const stair = { riser: 180, totalSteps: 12 };
  assert.equal(stairRiserOf(stair, project, g1.plane), 180);
});

test('stairRiserOf: riser未指定は設置階〜上階の階高(floorHeightAbove)を総段数で割る', () => {
  const { project, g1 } = makeTwoFloorProject();
  const stair = { riser: null, totalSteps: 12 };
  assert.equal(stairRiserOf(stair, project, g1.plane), 2400 / 12);
});

test('【失敗系】stairRiserOf: 最上階（上階が無い＝floorHeightAboveがnull）はriser未指定だとnullを返す', () => {
  const project = new Project('proj2', 'test');
  const { graph: top } = project.addPlane(0, '1階', 'p1');
  const stair = { riser: null, totalSteps: 12 };
  assert.equal(stairRiserOf(stair, project, top.plane), null);
});

test('【失敗系】stairRiserOf: totalSteps が 0 でも0除算にならず例外を投げない（Math.max(1,...)で下限1）', () => {
  const { project, g1 } = makeTwoFloorProject();
  const stair = { riser: null, totalSteps: 0 };
  assert.doesNotThrow(() => stairRiserOf(stair, project, g1.plane));
  assert.equal(stairRiserOf(stair, project, g1.plane), 2400);
});
