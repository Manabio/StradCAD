// テスト専用。製品コードからは import されない。IndexedDB の代用のうち複数のテストで中身が同じ部品。
// テスト固有の代用（保留・失敗の注入・記録・keyPath つきの FakeStore など）は各テストに残す。
// 非同期の順序に依存するテストが使うので、処理（queueMicrotask の位置・オブジェクトを作る位置）を変えないこと。

// 保存先の名前。製品側（storage/db.js）の定数は import しない（代用が製品の変更に追従して前提が黙って変わるのを避ける）。
const STORE_NAMES = ['floors', 'projects', 'savedFloors', 'catalogs'];
const FLOORS_STORE = 'floors';

export class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }

export class FakeStore {
  constructor() { this.data = new Map(); }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value.planeId ?? value.projectId, value);
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

/** fakeStores（名前→ストア）を見る fakeDb を 1 個だけ作り、globalThis.indexedDB へ置く。戻り値は fakeDb。 */
export function installFakeIndexedDb(fakeStores) {
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
  return fakeDb;
}

/** transaction を呼び出し側の fakeTransaction にする版。result は open の microtask のたびに作る。 */
export function installFakeIndexedDbWithTransaction(fakeStores, fakeTransaction) {
  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({
        target: { result: { transaction: fakeTransaction, objectStoreNames: { contains: (name) => name in fakeStores } } },
      }));
      return req;
    },
  };
}

/** floors ストアへの put の planeId を putLog へ記録する一式の fake IndexedDB を置く。 */
export function installLoggingFakeIndexedDb(putLog) {
  class FakeStore {
    constructor(name) { this.name = name; this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      if (this.name === FLOORS_STORE) putLog.push(value.planeId);
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
      for (const name of STORE_NAMES) this.stores.set(name, new FakeStore(name));
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  globalThis.indexedDB = { open() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } })); return req; } };
}
