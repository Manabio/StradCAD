// rebuildStructuralBinding（階設定表 S8 の構造モード後始末）: 合成の組み直し（バインディング再構築と編集用 peek の再開）だけを行い、
// undo を積まない。undo/redo の afterApply から呼ばれても redo スタックを消さず、確定直後に呼ばれても OK 1回＝undo 1エントリを崩さない
// （runStructuralModeSetup は変化があると undoManager.push するため、そちらは使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { rebuildStructuralBinding } from './structuralOrchestration.js';

function makeProject() {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.activePlaneId = 'p2';
  return project;
}

async function withStubs(project, fn) {
  const orig = { peek: floorSwapManager.peek, start: floorSwapManager.startEditablePeek, stop: floorSwapManager.stopEditablePeek };
  const log = { peek: [], start: [], stop: 0 };
  floorSwapManager.peek = async (plane) => { log.peek.push(plane.id); return project.graphMap.get(plane.id); };
  floorSwapManager.startEditablePeek = (plane) => { log.start.push(plane.id); };
  floorSwapManager.stopEditablePeek = () => { log.stop++; return Promise.resolve(); };
  try { return await fn(log); } finally {
    floorSwapManager.peek = orig.peek;
    floorSwapManager.startEditablePeek = orig.start;
    floorSwapManager.stopEditablePeek = orig.stop;
  }
}

test('組み直しは下階を読み直し、編集用 peek を止めて再開する。undo は 1 件も積まない', async () => {
  const project = makeProject();
  const before = undoManager._undoStack.length;
  await withStubs(project, async (log) => {
    const comp = await rebuildStructuralBinding(project.activeGraph, project);
    assert.ok(comp.bindings.length >= 1);
    assert.ok(log.stop >= 1, '古い編集用 peek を止める');
    assert.ok(log.peek.includes('p1') && log.start.includes('p1'), `下階を読み直して編集用 peek を再開する: ${JSON.stringify(log)}`);
  });
  assert.equal(undoManager._undoStack.length, before, 'undo エントリは増えない');
});

test('undo の afterApply から呼んでも redo スタックが残る（push していれば消える）', async () => {
  const project = makeProject();
  await withStubs(project, async () => {
    undoManager.push(() => {}, () => {});
    // App.jsx の undoFloorOp と同じ: undo の最中（redo へ移る前後）に非同期で afterApply が走る
    undoManager._undoStack.pop();
    undoManager._undoStack.push({
      undo: () => { pending = rebuildStructuralBinding(project.activeGraph, project); }, redo: () => {}, context: null,
    });
    let pending = null;
    undoManager.undo();
    await pending;
    assert.equal(undoManager.canRedo, true, 'redo スタックが残る');
    undoManager.redo(); // 後始末
  });
});

test('【対照】undoManager.push は redo スタックを消す（作り直しが push してはいけない理由）', () => {
  undoManager.push(() => {}, () => {});
  undoManager.undo();
  assert.equal(undoManager.canRedo, true);
  undoManager.push(() => {}, () => {});
  assert.equal(undoManager.canRedo, false);
  undoManager.undo(); // 後始末
});
