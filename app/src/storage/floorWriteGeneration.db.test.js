// db.js経由（実際にfloorsストアへ書き込む経路）でfloorWriteGeneration.jsが進むことを検証する。
// structuralOrchestration.test.js の withFakeIndexedDB と同じ方針: fake-indexeddb 等の新規npm依存を
// 追加せず、db.js の saveFloor/deleteFloor が使う最小限のIDB APIだけを模す自前シム
// （このテストファイルの外では使わない）。db.test.js（openDB() 冒頭のセッションロック判定を
// blocked状態にする一連のtestを持つ）とはモジュール状態を共有させたくない（node:testはファイル単位で
// 別プロセスに分離されるため、本ファイルの sessionLock._status は初期値 'pending'＝オーナー扱いの
// まま――openDB() が実際に indexedDB.open まで到達できる）。
// db.js の _dbPromise はモジュールスコープでopen成功後キャッシュされ続ける（openDB()参照）ため、
// fakeDBはこのファイル内で1個だけ生成して両方のtestで使い回す（testごとに新しいfakeDBへ差し替えても
// 一度キャッシュされたopenDB()の解決先は変わらず、2個目以降のfakeDBが黙って無視されるため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveFloor, deleteFloor, clearAllStores, seedFloorsFromDocument } from './db.js';
import { floorWriteGeneration } from './floorWriteGeneration.js';

class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
class FakeStore {
  constructor() { this.data = new Map(); }
  clear() { this.data.clear(); }
  getAll() {
    const req = new FakeRequest();
    const result = [...this.data.values()];
    queueMicrotask(() => req.onsuccess?.({ target: { result } }));
    return req;
  }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value.planeId, value);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
}
const fakeFloorsStore = new FakeStore();
const fakeSavedFloorsStore = new FakeStore();
const fakeStores = { floors: fakeFloorsStore, savedFloors: fakeSavedFloorsStore, projects: new FakeStore() };
// トランザクションの完了（oncomplete）は、中のリクエストのonsuccess（マイクロタスク）が
// 流れ終わった後に通知する（seedFloorsFromDocument は getAll の onsuccess で floors へ put する）。
const fakeTransaction = () => {
  const tx = { oncomplete: null, onerror: null, objectStore: (name) => fakeStores[name] };
  setTimeout(() => tx.oncomplete?.(), 0);
  return tx;
};
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({
      target: { result: { transaction: fakeTransaction, objectStoreNames: { contains: (name) => name in fakeStores } } },
    }));
    return req;
  },
};

test('saveFloor: floorsストアへの書込みに成功するとfloorWriteGenerationの世代が進む', async () => {
  const planeId = 'p-save-ok';
  const before = floorWriteGeneration(planeId);
  await saveFloor(planeId, new Uint8Array([1, 2, 3]));
  assert.notEqual(floorWriteGeneration(planeId), before);
  assert.deepEqual(fakeFloorsStore.data.get(planeId).bytes, new Uint8Array([1, 2, 3]), '前提: 実際にfloorsへ書けている');
});

test('deleteFloor: floorsストアからの削除に成功するとfloorWriteGenerationの世代が進む', async () => {
  const planeId = 'p-delete-ok';
  fakeFloorsStore.data.set(planeId, { planeId, bytes: new Uint8Array([9]) });
  const before = floorWriteGeneration(planeId);
  await deleteFloor(planeId);
  assert.notEqual(floorWriteGeneration(planeId), before);
  assert.equal(fakeFloorsStore.data.has(planeId), false, '前提: 実際にfloorsから削除できている');
});

// floors 全体を作り直す操作は、書込み済み・未書込みを問わず全planeの世代を進める
// （保持コピーを全階分捨てさせる根拠。取りこぼすと文書読込み直後に全階が古いコピーのままになる）。
test('clearAllStores: floorsストアを空にすると全planeのfloorWriteGenerationの世代が進む', async () => {
  const written = 'p-clear-written', untouched = 'p-clear-untouched';
  await saveFloor(written, new Uint8Array([1]));
  const before = [floorWriteGeneration(written), floorWriteGeneration(untouched)];
  await clearAllStores();
  assert.equal(fakeFloorsStore.data.size, 0, '前提: 実際にfloorsが空になっている');
  assert.notEqual(floorWriteGeneration(written), before[0]);
  assert.notEqual(floorWriteGeneration(untouched), before[1], '未書込みのplaneも世代が変わる');
});

test('seedFloorsFromDocument: savedFloorsからfloorsを作り直すと全planeのfloorWriteGenerationの世代が進む', async () => {
  const seeded = 'p-seed', untouched = 'p-seed-untouched';
  fakeFloorsStore.data.set('p-stale', { planeId: 'p-stale', bytes: new Uint8Array([0]) });
  fakeSavedFloorsStore.data.set(seeded, { planeId: seeded, bytes: new Uint8Array([7]) });
  const before = [floorWriteGeneration(seeded), floorWriteGeneration(untouched)];
  await seedFloorsFromDocument();
  assert.deepEqual([...fakeFloorsStore.data.keys()], [seeded], '前提: floorsがsavedFloorsの内容で作り直されている');
  assert.notEqual(floorWriteGeneration(seeded), before[0]);
  assert.notEqual(floorWriteGeneration(untouched), before[1], '未書込みのplaneも世代が変わる');
});
