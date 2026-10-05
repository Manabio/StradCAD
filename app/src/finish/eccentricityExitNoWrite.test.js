// 仕上げ脱出境界（ステップ4c: 連動先への偏芯の再伝播）が、無編集の2回目では他の平面の
// ストアへ書かないことの固定。IDB は最小の fake を globalThis に置く（node:test はファイルごとに
// 別プロセスのため他のテストへ漏れない）。他階は本番の floorSwapManager.peek（fake IDB から復元）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomFeature } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph } from '../graphSnapshot.js';
import { saveFloor } from '../storage/db.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { applyCLEccentricity } from './clEccentricity.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const putLog = []; // floors ストアへの put の planeId
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor(name) { this.name = name; this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      if (this.name === 'floors') putLog.push(value.planeId);
      this.data.set(value.planeId ?? value.projectId ?? value.key, value);
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
    get(key) { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } })); return req; }
    getAll() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: [...this.data.values()] } })); return req; }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors', 'catalogs']) this.stores.set(name, new FakeStore(name));
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  globalThis.indexedDB = { open() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } })); return req; } };
}
installFakeIndexedDB();

test('(h) 連動する偏芯レコードの在る階で無編集の脱出を2回続けると、2回目は他の平面のストアへ書かない', async () => {
  const project = new Project('proj', 'test');
  const gs = [1, 2].map(i => project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`).graph);
  project.activePlaneId = 'p2';
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => gs.find(g => g.plane.id === plane.id);
  const yms = [];
  try {
    for (const g of gs) {
      const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
      const x1 = g.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
      const y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
      const ym = g.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
      const y1 = g.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
      g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), '階段').setFeature(RoomFeature.STAIR);
      g.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '部屋B');
      g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
      await runFinishEntryBoundary(g, project);
      yms.push(ym);
    }
  } finally {
    floorSwapManager.peek = orig;
  }
  const materialMap = await loadMaterialMap();
  const active = gs[1];
  active.setCLEccentricity(yms[1].id, { mode: 'face', value: 0, side: 1, backing: '' });
  applyCLEccentricity(active, yms[1].id, { materialMap });
  // 他階（1階）は保存済みの状態として fake IDB へ置く（以後の peek は本番の floorSwapManager.peek が復元する）
  await saveFloor('p1', serializeGraph(gs[0]));

  const fmode = { materialMap, stairUnderRooms: () => [] };
  putLog.length = 0;
  await runFinishExitBoundary(active, project, fmode, { goingToStructure: false });
  const firstOthers = putLog.filter(id => id !== 'p2').length;
  assert.ok(firstOthers >= 1, '1回目の脱出は連動先（1階）へ偏芯を保存する（空振り防止）');

  await runFinishEntryBoundary(active, project);
  putLog.length = 0;
  await runFinishExitBoundary(active, project, fmode, { goingToStructure: false });
  assert.deepEqual(putLog.filter(id => id !== 'p2'), [], '2回目（無編集）は他の平面へ書かない');
});
