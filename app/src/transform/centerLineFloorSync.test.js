// centerLineOps.test.js と同じ方針: 実 core.js（Plane/PlanGraph/Project）を使う。
// findFloorsWithCounterpartCL は floorSwapManager.peek（IndexedDB経由）に依存するため、
// structural/wallBeamAxes.test.js:197-207 と同じ方式でテスト中だけ差し替える
// （floorSwapManagerはシングルトンインスタンス。try/finallyで必ず復元し、実IDBを経由せずに
// ロジックだけを検証する。IDB不在を理由に断念しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { findFloorsWithCounterpartCL } from './centerLineFloorSync.js';

function makeProjectWithTwoFloors() {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  return { project, activeGraph, otherGraph };
}

// peekをテスト用グラフへ差し替えて呼び出し、必ず元に戻す共通ヘルパ。
async function withPeekOverride(otherGraph, fn) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    return await fn();
  } finally {
    floorSwapManager.peek = originalPeek;
  }
}

test('findFloorsWithCounterpartCL: 他階に同座標・同軸の非labeled CLがあれば該当Planeを返す', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = await withPeekOverride(otherGraph, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 1);
  assert.equal(result[0].id, otherGraph.plane.id);
});

test('findFloorsWithCounterpartCL: 他階に同座標のCLが無ければ空配列', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH }); // 座標が違う
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = await withPeekOverride(otherGraph, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 0);
});

test('findFloorsWithCounterpartCL: 同座標にあるのがlabeledな通り芯だけなら空配列（非labeled限定）', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  // 通り芯は project.structGraph に居るのが実態（otherGraph._structGraph 経由で otherGraph.centerLines に
  // 自動的に混ざる）。非labeledのみを対象にする findFloorsWithCounterpartCL のフィルタを直接検証する。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = await withPeekOverride(otherGraph, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 0);
});
