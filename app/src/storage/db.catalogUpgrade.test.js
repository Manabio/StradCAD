// DB_VERSION 6（ユーザーカタログライブラリ専用ストア catalogs の新設）の onupgradeneeded 検証。
// db.js は openDB() の結果（Promise）をモジュールスコープにキャッシュするため、実際に
// indexedDB.open を発火させる検証は他のdb.js系テストと状態を共有しない専用ファイルにする
// （floorWriteGeneration.db.test.js のコメントと同じ方針）。
// 本ファイルは onupgradeneeded を実際に発火させ、v5で存在した既存ストア
// （floors/projects/savedFloors）を再作成しないこと・catalogsストアだけが新設されることを検証する。
//
// 【シムの検証範囲の限界（2026-09-22 再QA指摘Minor-C）】このFakeDbは既存ストア
// （floors/projects/savedFloors）を「名前だけ」持つ空のFakeStoreとして用意しており、
// アップグレード後もそのレコード（データ本体）が生き残ることまでは検証していない——
// 検証しているのは「createObjectStoreが（catalogs以外）呼ばれていないこと」
// （= 既存ストアが再作成されてIDBの実装上再定義されないこと）と、
// 「objectStoreNames.containsが既存ストア名を引き続きtrueで返すこと」だけである。
// 実ブラウザのIndexedDBでは既存ストアはonupgradeneeded中に触れなければレコードごと
// 保持されるため、このシムの検証範囲（createObjectStoreの呼ばれ方）で「再作成しない」契約は
// 十分に固定できるが、「データが実際に生き残る」ことの直接証跡ではない点に注意。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveDocumentCatalog, DB_VERSION } from './db.js';

const EXISTING_STORE_NAMES = ['floors', 'projects', 'savedFloors']; // v5時点で既に存在するストア

class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
class FakeStore {
  constructor(keyPath) { this.keyPath = keyPath; this.data = new Map(); }
  put(value) {
    const req = new FakeRequest();
    this.data.set(value[this.keyPath], value);
    queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
    return req;
  }
  openCursor() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({ target: { result: null } }));
    return req;
  }
}
class FakeObjectStoreNames {
  constructor(names) { this._names = new Set(names); }
  contains(name) { return this._names.has(name); }
}
class FakeDb {
  constructor(existingNames) {
    this.objectStoreNames = new FakeObjectStoreNames(existingNames);
    this.created = []; // createObjectStore呼び出しの記録（本テストの検証対象）
    this.stores = new Map(existingNames.map(name => [name, new FakeStore(name === 'floors' || name === 'savedFloors' ? 'planeId' : 'projectId')]));
  }
  createObjectStore(name, opts) {
    this.objectStoreNames._names.add(name);
    this.created.push({ name, opts });
    this.stores.set(name, new FakeStore(opts?.keyPath));
    return this.stores.get(name);
  }
  transaction(names) {
    const list = Array.isArray(names) ? names : [names];
    return { objectStore: (name) => this.stores.get(name), oncomplete: null, onerror: null, _names: list };
  }
}

let fakeDb;
let openedWithVersion = null; // db.jsが実際にindexedDB.open()へ渡したversion引数（本テストの検証対象）
globalThis.indexedDB = {
  open(name, version) {
    openedWithVersion = version;
    const req = new FakeRequest();
    fakeDb = new FakeDb(EXISTING_STORE_NAMES); // v5相当（catalogsストアが無い状態）
    queueMicrotask(() => {
      req.onupgradeneeded?.({ target: { result: fakeDb, transaction: fakeDb.transaction(EXISTING_STORE_NAMES) }, oldVersion: 5 });
      req.onsuccess?.({ target: { result: fakeDb } });
    });
    return req;
  },
};

test('DB_VERSION6: v5からのアップグレードでcatalogsストアだけが新設され、既存ストアは再作成されない', async () => {
  await saveDocumentCatalog('p1', 'material', new Uint8Array([1]));
  assert.equal(fakeDb.objectStoreNames.contains('catalogs'), true, 'catalogsストアが新設されている');
  assert.deepEqual(fakeDb.created.map(c => c.name), ['catalogs'], '新設されたのはcatalogsストアだけ（floors/projects/savedFloorsは再作成されない）');
  const catalogsCreation = fakeDb.created.find(c => c.name === 'catalogs');
  assert.equal(catalogsCreation.opts.keyPath, 'key');
});

// Minor 1: DB_VERSIONが実際にindexedDB.open()へ渡る値であることを固定する（5に戻す変異で赤）。
test('DB_VERSION: db.jsのDB_VERSIONは6であり、その値がindexedDB.open()へ渡っている', () => {
  assert.equal(DB_VERSION, 6);
  assert.equal(openedWithVersion, 6, 'indexedDB.open()に渡ったversionがDB_VERSIONと一致していない');
  assert.equal(openedWithVersion, DB_VERSION);
});
