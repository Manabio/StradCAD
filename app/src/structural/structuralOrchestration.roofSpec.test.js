// 構造パネルの外部タブ（RoofSpecTab.jsx）が屋根の項目の確定を recomputeStructuralComposition の mutate に乗せたときの
// undo/redo と失敗時の巻き戻し（QA 指摘 2026-10-30）。floorSwapManager.peek / flushEditablePeek を差し替えるため
// structuralOrchestration.steelSlab.test.js と同じく専用ファイル（node --test はファイル単位で別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoofZone, RoofSpec } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralComposition } from './structuralOrchestration.js';

const stackLen = () => undoManager._undoStack.length;

// S造・1階/2階（最上階）/屋根専用平面（R。最上階に紐づく）・通り芯 2×2。
function makeProject() {
  const project = new Project('proj-roof-spec', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: gr } = project.addPlane(6000, 'R', 'pr', 1, 1, false, null, 0, true, 'p2');
  project.structuralInfo.setField('mainStructure', 'S造');
  for (const v of [0, 3000]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
  for (const v of [0, 3000]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT });
  return { project, g1, g2, gr };
}

async function withPeek(graphs, fn) {
  const originalPeek = floorSwapManager.peek;
  const originalFlush = floorSwapManager.flushEditablePeek;
  floorSwapManager.peek = async (plane) => graphs[plane.id] ?? null;
  floorSwapManager.flushEditablePeek = async () => {};
  try { return await fn(); } finally {
    floorSwapManager.peek = originalPeek;
    floorSwapManager.flushEditablePeek = originalFlush;
  }
}

test('最上階を subject にして mainRoofSpec を mutate で書くと undo 1件。undo で元の勾配へ戻り redo でやり直せる', async () => {
  const { project, g1, g2 } = makeProject();
  const composition = { graphForCategory: () => g1 };
  await withPeek({ p1: g1, p2: g2 }, async () => {
    await recomputeStructuralComposition(composition, g2, project, {});
    const before = g2.mainRoofSpec.slope;
    assert.notEqual(before, 7, '前提: 既定の勾配は 7 ではない');
    const stack0 = stackLen();
    await recomputeStructuralComposition(composition, g2, project, { mutate: () => g2.mainRoofSpec.setField('slope', 7) });
    assert.equal(g2.mainRoofSpec.slope, 7);
    assert.equal(stackLen(), stack0 + 1, 'undo は1件');
    undoManager.undo();
    assert.equal(g2.mainRoofSpec.slope, before, 'undo で勾配が戻る');
    undoManager.redo();
    assert.equal(g2.mainRoofSpec.slope, 7, 'redo でやり直せる');
  });
});

test('屋根専用平面を subject にして belowGraph（最上階）の mainRoofSpec を mutate で書いても undo で最上階の値が戻る', async () => {
  const { project, g1, g2, gr } = makeProject();
  const composition = { graphForCategory: () => g2 }; // 小屋伏図の columnMap＝最上階
  await withPeek({ p1: g1, p2: g2, pr: gr }, async () => {
    await recomputeStructuralComposition(composition, gr, project, {});
    const before = g2.mainRoofSpec.shape;
    const stack0 = stackLen();
    await recomputeStructuralComposition(composition, gr, project, { mutate: () => g2.mainRoofSpec.setField('shape', 'flat') });
    assert.equal(g2.mainRoofSpec.shape, 'flat');
    assert.equal(stackLen(), stack0 + 1, 'undo は1件');
    undoManager.undo();
    assert.equal(g2.mainRoofSpec.shape, before, 'undo で最上階の形状が戻る（belowGraph の before が採られている）');
  });
});

test('【屋根区画 S2】最上階を subject にして区画の spec を mutate で書くと undo 1件。undo で区画の値が戻り、mainRoofSpec は不変', async () => {
  const { project, g1, g2 } = makeProject();
  const composition = { graphForCategory: () => g1 };
  await withPeek({ p1: g1, p2: g2 }, async () => {
    g2.setRoofZones([new RoofZone({ id: 'z1', cells: ['dummy'], spec: new RoofSpec() })]);
    await recomputeStructuralComposition(composition, g2, project, {});
    const mainBefore = g2.mainRoofSpec.toData();
    const zoneBefore = g2.roofZones[0].spec.slope;
    const stack0 = stackLen();
    await recomputeStructuralComposition(composition, g2, project, { mutate: () => g2.roofZones[0].spec.setField('slope', 7) });
    assert.equal(g2.roofZones[0].spec.slope, 7);
    assert.equal(stackLen(), stack0 + 1, 'undo は1件');
    assert.deepEqual(g2.mainRoofSpec.toData(), mainBefore, '主屋根の値は変わらない');
    undoManager.undo();
    assert.equal(g2.roofZones.length, 1, 'undo 後も区画は残る');
    assert.equal(g2.roofZones[0].spec.slope, zoneBefore, 'undo で区画の勾配が戻る');
    assert.deepEqual(g2.mainRoofSpec.toData(), mainBefore);
  });
});

test('【失敗系】mutate が途中で throw したら reject し、書きかけの勾配は巻き戻り、undo も積まれない', async () => {
  const { project, g1, g2 } = makeProject();
  const composition = { graphForCategory: () => g1 };
  await withPeek({ p1: g1, p2: g2 }, async () => {
    await recomputeStructuralComposition(composition, g2, project, {});
    const before = g2.mainRoofSpec.slope;
    const stack0 = stackLen();
    await assert.rejects(
      recomputeStructuralComposition(composition, g2, project, {
        mutate: () => { g2.mainRoofSpec.setField('slope', 7); g2.mainRoofSpec.setField('noSuchField', 1); },
      }),
      /未知の項目/,
    );
    assert.equal(g2.mainRoofSpec.slope, before, '書きかけの勾配は元へ戻る');
    assert.equal(stackLen(), stack0, 'undo を積まない');
  });
});
