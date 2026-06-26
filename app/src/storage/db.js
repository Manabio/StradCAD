/**
 * IndexedDB アクセス層
 *
 * データベース:  strad  (バージョン 3)
 * オブジェクトストア:
 *   floors   — keyPath: planeId   — フロアごとの FlatBuffers バイナリ
 *   projects — keyPath: projectId — 通り芯（全階共通）の FlatBuffers バイナリ
 *
 * 公開 API:
 *   saveFloor(planeId, bytes)       → Promise<void>
 *   loadFloor(planeId)              → Promise<Uint8Array | null>
 *   deleteFloor(planeId)            → Promise<void>
 *   listFloorIds()                  → Promise<string[]>
 *   saveProject(projectId, bytes)   → Promise<void>
 *   loadProject(projectId)          → Promise<Uint8Array | null>
 *   clearAllStores()                → Promise<void>
 */

const DB_NAME    = 'strad';
const DB_VERSION = 3;
const STORE_FLOORS   = 'floors';
const STORE_PROJECTS = 'projects';

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
    const tx = db.transaction([STORE_FLOORS, STORE_PROJECTS], 'readwrite');
    tx.objectStore(STORE_FLOORS).clear();
    tx.objectStore(STORE_PROJECTS).clear();
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
