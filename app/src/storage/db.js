/**
 * IndexedDB アクセス層
 *
 * データベース:  strad  (バージョン 4)
 * オブジェクトストア:
 *   floors      — keyPath: planeId — フロアごとの FlatBuffers バイナリ（セッション作業領域）
 *   projects    — keyPath: projectId — 通り芯（全階共通）の FlatBuffers バイナリ
 *   savedFloors — keyPath: planeId — 明示保存された floors のスナップショット（保存ドキュメント本体）
 *
 * 公開 API:
 *   saveFloor(planeId, bytes)       → Promise<void>
 *   loadFloor(planeId)              → Promise<Uint8Array | null>
 *   deleteFloor(planeId)            → Promise<void>
 *   listFloorIds()                  → Promise<string[]>
 *   saveProject(projectId, bytes)   → Promise<void>
 *   loadProject(projectId)          → Promise<Uint8Array | null>
 *   savePlanesMeta(projectId, bytes) → Promise<void>   （projects ストアの別レコード。キー: `${projectId}:planes`）
 *   loadPlanesMeta(projectId)        → Promise<Uint8Array | null>
 *   seedFloorsFromDocument()         → Promise<void>   （floorsをclear→savedFloors全件をfloorsへput）
 *   commitFloorsToDocument(planeIds) → Promise<void>   （planeIds分をsavedFloorsへ反映＋含まれない分を削除）
 *   clearAllStores()                → Promise<void>
 */

import { computeSavedFloorDiff } from './floorDocumentDiff.js';

const DB_NAME    = 'strad';
const DB_VERSION = 4;
const STORE_FLOORS       = 'floors';
const STORE_PROJECTS     = 'projects';
const STORE_SAVED_FLOORS = 'savedFloors';

// ----------------------------------------------------------------
// openDB: Promise をキャッシュして並列呼び出しでも 1 回だけ開く
// ----------------------------------------------------------------
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_FLOORS)) {
        db.createObjectStore(STORE_FLOORS, { keyPath: 'planeId' });
      }
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_SAVED_FLOORS)) {
        db.createObjectStore(STORE_SAVED_FLOORS, { keyPath: 'planeId' });
      }
      // migration: savedFloors 新設以前（バージョン1〜3）からのアップグレード時、
      // その時点の floors の内容を savedFloors へコピーする。v3 でも deactivate（階切替の
      // スワップアウト）は複数階を無条件に floors へ書いていたため「常に1階分のみ」ではない
      // ——参照されなくなった孤児レコードもここでは区別せず一旦コピーされるが、初回の明示保存
      // （commitFloorsToDocument が project.planeMap に無い分を削除する）で掃除される。
      if (e.oldVersion >= 1 && e.oldVersion < 4) {
        const tx = e.target.transaction;
        const floorsStore = tx.objectStore(STORE_FLOORS);
        const savedStore  = tx.objectStore(STORE_SAVED_FLOORS);
        floorsStore.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          savedStore.put(cursor.value);
          cursor.continue();
        };
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);

    req.onerror = (e) => {
      _dbPromise = null; // 次回リトライできるよう解除
      reject(e.target.error);
    };

    req.onblocked = () => {
      // 古いタブが DB を掴んでいる場合に発生。ユーザーに対応を促す場合はここに通知を追加する。
      console.warn('[IDB] open blocked — close other tabs using this app');
    };
  });

  return _dbPromise;
}

// ----------------------------------------------------------------
// floors ストア
// ----------------------------------------------------------------

export async function saveFloor(planeId, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FLOORS, 'readwrite');
    const req = tx.objectStore(STORE_FLOORS).put({ planeId, bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function loadFloor(planeId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FLOORS, 'readonly');
    const req = tx.objectStore(STORE_FLOORS).get(planeId);
    req.onsuccess = (e) => resolve(e.target.result?.bytes ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function deleteFloor(planeId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FLOORS, 'readwrite');
    const req = tx.objectStore(STORE_FLOORS).delete(planeId);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function listFloorIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FLOORS, 'readonly');
    const req = tx.objectStore(STORE_FLOORS).getAllKeys();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ----------------------------------------------------------------
// projects ストア — 通り芯（全階共通）の永続化
// ----------------------------------------------------------------

export async function saveProject(projectId, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROJECTS, 'readwrite');
    const req = tx.objectStore(STORE_PROJECTS).put({ projectId, bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function clearAllStores() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FLOORS, STORE_PROJECTS, STORE_SAVED_FLOORS], 'readwrite');
    tx.objectStore(STORE_FLOORS).clear();
    tx.objectStore(STORE_PROJECTS).clear();
    tx.objectStore(STORE_SAVED_FLOORS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

export async function loadProject(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // ストアが存在しない場合（アップグレード不完全）は null を返してグレースフルに動作する
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      resolve(null);
      return;
    }
    const tx  = db.transaction(STORE_PROJECTS, 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).get(projectId);
    req.onsuccess = (e) => resolve(e.target.result?.bytes ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ----------------------------------------------------------------
// plane一覧（全階・検討・屋根平面のメタデータ）— projects ストアの別レコード
// 内部キーは projectId とは衝突しない `${projectId}:planes` を使う（同一ストア・別レコード）。
// ----------------------------------------------------------------

function planesKey(projectId) {
  return `${projectId}:planes`;
}

export async function savePlanesMeta(projectId, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROJECTS, 'readwrite');
    const req = tx.objectStore(STORE_PROJECTS).put({ projectId: planesKey(projectId), bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function loadPlanesMeta(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      resolve(null);
      return;
    }
    const tx  = db.transaction(STORE_PROJECTS, 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).get(planesKey(projectId));
    req.onsuccess = (e) => resolve(e.target.result?.bytes ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ----------------------------------------------------------------
// savedFloors ストア — 明示保存された floors のスナップショット（保存ドキュメント本体）
//
// floors は「セッション作業領域」——階切替のスワップアウト（deactivate）が明示保存の
// 有無に関わらず無条件に書き込む。savedFloors は「保存ドキュメント」——明示保存
// （saveToIDB）でのみ更新される。起動時は必ず savedFloors から floors を作り直すため、
// 未保存の編集が階切替を経由して次回起動に持ち越されることがない
// （設計意図は .claude/persistence-idb.md 参照）。
// ----------------------------------------------------------------

/** floors を savedFloors の内容で作り直す（起動時、明示保存済みプロジェクトの復元用）。 */
export async function seedFloorsFromDocument() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_SAVED_FLOORS)) {
      resolve();
      return;
    }
    const tx = db.transaction([STORE_FLOORS, STORE_SAVED_FLOORS], 'readwrite');
    const floorsStore = tx.objectStore(STORE_FLOORS);
    const savedStore  = tx.objectStore(STORE_SAVED_FLOORS);

    floorsStore.clear();
    const req = savedStore.getAll();
    req.onsuccess = (e) => {
      for (const record of e.target.result) floorsStore.put(record);
    };

    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/**
 * planeIds に含まれる floors の現在値を savedFloors へ反映し（保存の確定）、
 * planeIds に含まれない savedFloors レコードを削除する（保存後に削除された階が
 * ゴーストとして savedFloors に残り続けるのを防ぐ）。
 * 差分（コピー対象／削除対象）の計算は純関数 computeSavedFloorDiff に委譲する
 * （floorDocumentDiff.test.js でIndexedDB非依存にテストできるようにするため）。
 */
export async function commitFloorsToDocument(planeIds) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_SAVED_FLOORS)) {
      resolve();
      return;
    }
    const tx = db.transaction([STORE_FLOORS, STORE_SAVED_FLOORS], 'readwrite');
    const floorsStore = tx.objectStore(STORE_FLOORS);
    const savedStore  = tx.objectStore(STORE_SAVED_FLOORS);

    const keysReq = savedStore.getAllKeys();
    keysReq.onsuccess = (e) => {
      const { toCopy, toDelete } = computeSavedFloorDiff(e.target.result, planeIds);
      for (const planeId of toCopy) {
        const req = floorsStore.get(planeId);
        req.onsuccess = (ev) => {
          const record = ev.target.result;
          if (record) savedStore.put(record);
        };
      }
      for (const key of toDelete) savedStore.delete(key);
    };

    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}
