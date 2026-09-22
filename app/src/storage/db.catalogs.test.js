// カタログ束の永続化（ステップ4）: projects ストアの `${projectId}:catalogs:<kind>`（文書同梱・
// 範囲取得）と、専用ストア catalogs（ユーザーライブラリ・keyPath 'key'）の検証。
// db.js は openDB() の結果をモジュールスコープにキャッシュするため、db.test.js /
// floorWriteGeneration.db.test.js / db.catalogUpgrade.test.js とは別の専用テストファイルにする
// （fake-indexeddb 等の新規npm依存を追加せず、db.js が使う最小限のIDB APIだけを模す自前シム。
// floorWriteGeneration.db.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveDocumentCatalog, loadDocumentCatalogs, deleteDocumentCatalogs,
  saveUserCatalog, loadUserCatalogs, clearAllStores,
} from './db.js';

class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }

class FakeStore {
  constructor(keyPath) { this.keyPath = keyPath; this.data = new Map(); }
  clear() { this.data.clear(); }
  get(key) {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
    return req;
  }
  getAll() {
    const req = new FakeRequest();
    const result = [...this.data.values()];
    queueMicrotask(() => req.onsuccess?.({ target: { result } }));
    return req;
  }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value[this.keyPath], value);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  openCursor(range) {
    const req = new FakeRequest();
    const keys = [...this.data.keys()]
      .filter(k => !range || (k >= range.lower && k <= range.upper))
      .sort();
    let i = 0;
    const emit = () => {
      if (i >= keys.length) { req.onsuccess?.({ target: { result: null } }); return; }
      const key = keys[i];
      const cursor = {
        value: this.data.get(key),
        delete: () => this.data.delete(key),
        continue: () => { i++; queueMicrotask(emit); },
      };
      req.onsuccess?.({ target: { result: cursor } });
    };
    queueMicrotask(emit);
    return req;
  }
}

globalThis.IDBKeyRange = {
  bound(lower, upper) { return { lower, upper }; },
};

const fakeFloorsStore      = new FakeStore('planeId');
const fakeProjectsStore    = new FakeStore('projectId');
const fakeSavedFloorsStore = new FakeStore('planeId');
const fakeCatalogsStore    = new FakeStore('key');
const fakeStores = {
  floors: fakeFloorsStore, projects: fakeProjectsStore, savedFloors: fakeSavedFloorsStore, catalogs: fakeCatalogsStore,
};
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

// ---- saveDocumentCatalog/loadDocumentCatalogs（文書同梱。projectsストアの範囲取得）----

test('saveDocumentCatalog→loadDocumentCatalogs: 保存した種別ごとのバイト列がラウンドトリップする', async () => {
  await saveDocumentCatalog('proj-a', 'material', new Uint8Array([1, 2, 3]));
  await saveDocumentCatalog('proj-a', 'section', new Uint8Array([4, 5]));
  const loaded = await loadDocumentCatalogs('proj-a');
  const byKind = Object.fromEntries(loaded.map(r => [r.kind, r.bytes]));
  assert.deepEqual(byKind.material, new Uint8Array([1, 2, 3]));
  assert.deepEqual(byKind.section, new Uint8Array([4, 5]));
});

test('loadDocumentCatalogs: 範囲取得なのでlistKinds()に無い未知の種別も取りこぼさない', async () => {
  await saveDocumentCatalog('proj-unknown-kind', '将来の種別', new Uint8Array([9]));
  const loaded = await loadDocumentCatalogs('proj-unknown-kind');
  assert.deepEqual(loaded, [{ kind: '将来の種別', bytes: new Uint8Array([9]) }]);
});

test('loadDocumentCatalogs: 他projectIdのレコードは混ざらない（プレフィックスの前方一致だけを見る）', async () => {
  await saveDocumentCatalog('proj-b', 'material', new Uint8Array([1]));
  await saveDocumentCatalog('proj-bcdef', 'material', new Uint8Array([2])); // "proj-b"を前方一致で含む別プロジェクト
  const loadedB = await loadDocumentCatalogs('proj-b');
  assert.equal(loadedB.length, 1);
  assert.deepEqual(loadedB[0].bytes, new Uint8Array([1]));
});

test('loadDocumentCatalogs: 文書同梱が無いprojectIdは空配列', async () => {
  assert.deepEqual(await loadDocumentCatalogs('proj-none'), []);
});

test('deleteDocumentCatalogs: そのprojectIdの文書同梱を全種別削除する（他projectIdは残る）', async () => {
  await saveDocumentCatalog('proj-del', 'material', new Uint8Array([1]));
  await saveDocumentCatalog('proj-del', 'section', new Uint8Array([2]));
  await saveDocumentCatalog('proj-keep', 'material', new Uint8Array([3]));
  await deleteDocumentCatalogs('proj-del');
  assert.deepEqual(await loadDocumentCatalogs('proj-del'), []);
  const kept = await loadDocumentCatalogs('proj-keep');
  assert.equal(kept.length, 1);
});

// ---- saveUserCatalog/loadUserCatalogs（ユーザーライブラリ。catalogsストア）----

test('saveUserCatalog→loadUserCatalogs: 種別ごとのバイト列がラウンドトリップする', async () => {
  await saveUserCatalog('material', new Uint8Array([7, 8]));
  await saveUserCatalog('section', new Uint8Array([9]));
  const loaded = await loadUserCatalogs();
  const byKind = Object.fromEntries(loaded.map(r => [r.kind, r.bytes]));
  assert.deepEqual(byKind.material, new Uint8Array([7, 8]));
  assert.deepEqual(byKind.section, new Uint8Array([9]));
});

// ---- clearAllStores: 文書同梱(projectsストア)は消える。ユーザーライブラリ(catalogsストア)は残る ----

test('clearAllStores: projectsストア内の文書同梱カタログは消える', async () => {
  await saveDocumentCatalog('proj-clear', 'material', new Uint8Array([1]));
  await clearAllStores();
  assert.deepEqual(await loadDocumentCatalogs('proj-clear'), []);
});

test('clearAllStores: catalogsストア（ユーザーライブラリ）は対象外——消えずに残る', async () => {
  await saveUserCatalog('material', new Uint8Array([42]));
  await clearAllStores();
  const loaded = await loadUserCatalogs();
  const material = loaded.find(r => r.kind === 'material');
  assert.deepEqual(material?.bytes, new Uint8Array([42]));
});
