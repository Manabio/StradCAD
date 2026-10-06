// 階削除で floorIo を省いた（本番の既定）ときの他階の peek・保存の経路を通す専用テストファイル。
//
// 本物の floorSwapManager.peek（loadFloor 経由）と saveFloor を、fake IndexedDB へ向けて通す。
// stairsBelowRemoval が直下階の階段を removeStairOnFloor で消して保存し、stairVoidReconcile が続けて
// 孤児の吹抜けを整合することを、IDB に保存されたバイト列を復号して確かめる。
// なぜ別ファイルか: storage/db.js の openDB() は接続をモジュールスコープにキャッシュし、以後の
// globalThis.indexedDB の差し替えを無視する（前例: finish/roof/mainRoofCarry.pipeline.test.js。
// node:test はファイル単位で別プロセス）。fake IDB はこのファイルのモジュールレベルで1個だけ作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { StairType, RoomFeature } from '@core';
import { PlanGraph } from '../../core.js';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { saveFloor, loadFloor } from '../../storage/db.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../../floorOrderChange.js';
import { makeStorePeek, makeStoreSave } from '../equipment/equipmentTestFixtures.js';
import { syncUpperFloors } from './stairFloorSync.js';
import { setupProject, addPerFloorV, placeStair, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';

// ---- module-level fake IndexedDB（このファイルで1個だけ）----
class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
const putLog = []; // floors ストアへの保存の記録（planeId）
class FakeStore {
  constructor(isFloors) { this.data = new Map(); this.isFloors = isFloors; }
  put(value) {
    const req = new FakeRequest();
    const key = value.planeId ?? value.projectId;
    this.data.set(key, value);
    if (this.isFloors) putLog.push(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
}
const fakeStores = { floors: new FakeStore(true), projects: new FakeStore(false), savedFloors: new FakeStore(false) };
const fakeDb = {
  objectStoreNames: { contains: (n) => n in fakeStores },
  transaction(name) { const store = fakeStores[name]; return { objectStore: () => store }; },
};
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
    return req;
  },
};

const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };
const followers = floorOrderFollowers.filter(f => f.name === 'stairsBelowRemoval' || f.name === 'stairVoidReconcile');

// 1階に階段・2階にユーザー指定の階段（ペア部屋あり）・3階にその吹抜け。アクティブ階は1階。全階を fake IDB へ保存済み。
async function setupChainInIdb() {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const [g1, g2] = graphs;
  placeStair(project, g1);
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const sync = (g) => syncUpperFloors(project, g, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  await sync(g1);
  restoreGraph(g2, store.get('p2'));
  g2.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g2, LEFT_HALF[0])]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  store.set('p2', serializeGraph(g2));
  await sync(g1); // 吹抜けがペア部屋へ転用される
  restoreGraph(g2, store.get('p2'));
  runInAction(() => { project.activePlaneId = 'p2'; });
  await sync(g2); // 3階に吹抜け
  runInAction(() => { project.activePlaneId = 'p1'; });
  g1.removeStair(g1.stairs[0].id); // 1階には階段を残さない（2階の階段の削除後に吹抜けが再生されない構成にする）
  store.set('p1', serializeGraph(g1));
  store.set('p2', serializeGraph(g2));
  for (const [id, bytes] of store) await saveFloor(id, bytes);
  return { project, g1, g2 };
}

async function loadGraph(project, id) {
  const g = new PlanGraph(project.planeMap.get(id));
  g._structGraph = project.structGraph;
  restoreGraph(g, await loadFloor(id));
  return g;
}

test('階削除（floorIo なし）: 本番の peek／saveFloor で直下階の階段が消えてペア部屋が未定義化されたまま保存される', async () => {
  const { project, g2 } = await setupChainInIdb();
  assert.ok(g2.stairs[0].roomId, '前提: 2階の階段にペア部屋がある');
  assert.equal((await loadGraph(project, 'p2')).stairs.length, 1, '前提: IDB の2階に階段がある');

  putLog.length = 0;
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates: [],
    removePlane: async () => { project.removePlane('p3'); },
    removedPlane: project.planeMap.get('p3'),
    below: project.planeMap.get('p2'),
    ui,
  }, followers); // floorIo を渡さない

  assert.ok(putLog.includes('p2'), '直下階（2階）が本番の saveFloor で保存された');
  const p2 = await loadGraph(project, 'p2');
  assert.equal(p2.stairs.length, 0, '階段が消えている');
  assert.equal(p2.rooms.filter(r => r.feature === RoomFeature.STAIR).length, 0, 'ペア部屋（STAIR）は残っていない');
  assert.equal(p2.rooms.filter(r => r.feature === RoomFeature.UNDEFINED).length, 1, `ペア部屋は未定義化されている（rooms=${p2.rooms.map(r => r.feature).join(',')}）`);
});
