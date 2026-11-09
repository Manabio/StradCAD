// SiteModeState.init（配置の痕跡があれば配置図を開いた状態で突入）のテスト。
// 配置図の読込み自体は SiteModeState.placement.test.js が見る。ここは init の分岐だけ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '@core';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { SiteModeState } from './SiteModeState.js';

const PLACEMENT = {
  rotationDeg: 0, tx: 100, ty: 200,
  input: { v1: { x: 0, y: 0 }, v2: { x: 0, y: 1000 }, centerLineId: 'cl', distance: 1000, rotationFlipped: false, sideFlipped: false },
};

async function withPeek(peek, fn) {
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = peek;
  try { return await fn(); } finally { floorSwapManager.peek = orig; }
}

test('init: placement があれば配置図を開き、読込みの完了まで待つ（placementRoof が入る）', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.activePlaneId = 'p1';
  project.site.setPlacement({ ...PLACEMENT });
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const sm = new SiteModeState(project.site, project);
    assert.equal(sm.showPlacement, false, '前提: 生成直後は非表示');
    await sm.init();
    assert.equal(sm.showPlacement, true);
    assert.equal(sm.placementLoading, false);
    assert.ok(sm.placementRoof, '読込み済み');
    assert.equal(sm.placementView.placed, true, '配置図は保存された配置の変換で組まれる');
    sm.dispose();
  });
});

test('init: placement が無ければ非表示のまま（読込みもしない）', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.activePlaneId = 'p1';
  let peeked = 0;
  await withPeek(async plane => { peeked++; return project.graphMap.get(plane.id); }, async () => {
    const sm = new SiteModeState(project.site, project);
    await sm.init();
    assert.equal(sm.showPlacement, false);
    assert.equal(sm.placementRoof, null);
    assert.equal(peeked, 0);
    sm.dispose();
  });
});

test('【失敗系】init: 他階の peek が例外でも reject せず、配置図は開いたまま readFailed', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.site.setPlacement({ ...PLACEMENT });
  const warn = console.warn, err = console.error;
  console.warn = () => {}; console.error = () => {};
  try {
    await withPeek(async () => { throw new Error('peek 失敗'); }, async () => {
      const sm = new SiteModeState(project.site, project);
      await assert.doesNotReject(sm.init());
      assert.equal(sm.showPlacement, true);
      assert.equal(sm.placementRoof.readFailed, true);
      sm.dispose();
    });
  } finally { console.warn = warn; console.error = err; }
});
