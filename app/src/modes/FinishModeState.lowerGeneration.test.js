// FinishModeState.lowerGraphGeneration（直下階キャッシュ _lowerGraph を peek した時点の書込み世代）のテスト。
// finish/finishExitStamp.js が「直下階キャッシュが新鮮か」の判定に使う。peek は floorSwapManager.peek を差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../core.js';
import { FinishModeState } from './FinishModeState.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { floorWriteGeneration, noteFloorWrite } from '../storage/floorWriteGeneration.js';

function makeTwoFloors() {
  const project = new Project('proj', 'test');
  const { graph: below } = project.addPlane(0, '1階', 'lg-p1');
  const { graph: above } = project.addPlane(3000, '2階', 'lg-p2');
  project.activePlaneId = 'lg-p2';
  return { project, below, above };
}

async function withPeek(peek, fn) {
  const original = floorSwapManager.peek;
  floorSwapManager.peek = peek;
  try { await fn(); } finally { floorSwapManager.peek = original; }
}

test('init 後、直下階がある階では lowerGraphGeneration === floorWriteGeneration(直下階の id)（_lowerGraph が在る）', async () => {
  const { project, below, above } = makeTwoFloors();
  noteFloorWrite('lg-p1');
  await withPeek(async () => below, async () => {
    const state = new FinishModeState(above, project);
    await state.init();
    assert.equal(state._lowerGraph, below);
    assert.equal(state.lowerGraphGeneration, floorWriteGeneration('lg-p1'));
    assert.notEqual(state.lowerGraphGeneration, null);
    state.dispose();
    assert.equal(state.lowerGraphGeneration, null, 'dispose で破棄される');
  });
});

test('最下階（直下階なし）では _lowerGraph が null で lowerGraphGeneration も null', async () => {
  const { project, below, above } = makeTwoFloors();
  project.activePlaneId = 'lg-p1';
  await withPeek(async () => above, async () => { // 直上階の peek 用
    const state = new FinishModeState(below, project);
    await state.init();
    assert.equal(state._lowerGraph, null);
    assert.equal(state.lowerGraphGeneration, null);
  });
});

test('peek の最中に直下階の世代が進むと lowerGraphGeneration は null（_lowerGraph は在る）', async () => {
  const { project, below, above } = makeTwoFloors();
  await withPeek(async () => { noteFloorWrite('lg-p1'); return below; }, async () => {
    const state = new FinishModeState(above, project);
    await state.init();
    assert.equal(state._lowerGraph, below);
    assert.equal(state.lowerGraphGeneration, null);
  });
});
