/**
 * IndexedDB アクセス層
 *
 * データベース:  strad  (バージョン 6)
 * オブジェクトストア:
 *   floors      — keyPath: planeId — フロアごとの FlatBuffers バイナリ（セッション作業領域）
 *   projects    — keyPath: projectId — 通り芯（全階共通）の FlatBuffers バイナリ。
 *                 別レコード（`${projectId}:planes`/`${projectId}:site`/`${projectId}:info`/
 *                 `${projectId}:catalogs:<kind>`）で plane一覧・敷地・調査計画情報・カタログ文書同梱も
 *                 同ストアに同居する
 *   savedFloors — keyPath: planeId — 明示保存された floors のスナップショット（保存ドキュメント本体）
 *   catalogs    — keyPath: key — ユーザーカタログライブラリ（アプリ単位・プロジェクトをまたぐ。
 *                 キー: `user:<kind>`）。clearAllStores の対象外
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
 *   saveSiteData(projectId, bytes)   → Promise<void>   （projects ストアの別レコード。キー: `${projectId}:site`）
 *   loadSiteData(projectId)          → Promise<Uint8Array | null>
 *   saveProjectInfo(projectId, bytes) → Promise<void>  （projects ストアの別レコード。キー: `${projectId}:info`）
 *   loadProjectInfo(projectId)        → Promise<Uint8Array | null>
 *   saveDocumentCatalog(projectId, kind, bytes) → Promise<void>  （projects ストアの別レコード。
 *                                       キー: `${projectId}:catalogs:<kind>`。種別ごとに1レコード）
 *   loadDocumentCatalogs(projectId)   → Promise<Array<{kind, bytes}>>（範囲取得。未知の種別も取りこぼさない）
 *   deleteDocumentCatalogs(projectId) → Promise<void>  （文書同梱カタログを全種別削除）
 *   saveUserCatalog(kind, bytes)      → Promise<void>  （catalogs ストア。キー: `user:<kind>`）
 *   loadUserCatalogs()                → Promise<Array<{kind, bytes}>>
 *   seedFloorsFromDocument()         → Promise<void>   （floorsをclear→savedFloors全件をfloorsへput）
 *   commitFloorsToDocument(planeIds) → Promise<void>   （planeIds分をsavedFloorsへ反映＋含まれない分を削除）
 *   loadAllSavedFloors()             → Promise<Array<{planeId, bytes}>>（文書ファイル書き出し用）
 *   saveSavedFloor(planeId, bytes)   → Promise<void>   （文書ファイル読み込み用）
 *   clearAllStores()                → Promise<void>   （catalogs ストア＝ユーザーライブラリは対象外）
 */

import { computeSavedFloorDiff } from './floorDocumentDiff.js';
import { isSessionOwner } from './sessionLock.js';
import { ERR_SESSION_LOCKED } from '../error.js';
import { noteFloorWrite, noteAllFloorsWritten } from './floorWriteGeneration.js';

const DB_NAME    = 'strad';
// v6: カタログ束（.stq 同梱／ユーザーライブラリ、catalog/catalogBundle.js）の永続化のため
// ユーザーライブラリ専用ストア catalogs を新設。既存ストア（floors/projects/savedFloors）は
// v5 と同じ判定（!contains のときだけ createObjectStore）のため触れない——ストア欠損の自己修復も
// 同じ仕組みで v6 でも引き続き効く（v5 のコメント参照）。
export const DB_VERSION = 6;
const STORE_FLOORS       = 'floors';
const STORE_PROJECTS     = 'projects';
const STORE_SAVED_FLOORS = 'savedFloors';
const STORE_CATALOGS     = 'catalogs'; // ユーザーカタログライブラリ（keyPath: 'key'。アプリ単位）

// ----------------------------------------------------------------
// openDB: Promise をキャッシュして並列呼び出しでも 1 回だけ開く
// ----------------------------------------------------------------
let _dbPromise = null;

function openDB() {
  // 排他セッションロック（storage/sessionLock.js）を持たないタブは IDB を open しない。
  // isSessionOwner() は pending（起動直後の未判定窓）を通す——この窓に openDB へ到達する
  // 経路が無いことが前提（store.js の bootReady が acquireSessionLock 完了後にしか
  // IDB アクセスを開始しないため）。blocked 確定後は全公開関数がこの openDB() 経由なので
  // この1箇所で読み書きすべて塞がる。
  if (!isSessionOwner()) throw new Error(ERR_SESSION_LOCKED);
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
      const savedFloorsCreated = !db.objectStoreNames.contains(STORE_SAVED_FLOORS);
      if (savedFloorsCreated) {
        db.createObjectStore(STORE_SAVED_FLOORS, { keyPath: 'planeId' });
      }
      if (!db.objectStoreNames.contains(STORE_CATALOGS)) {
        db.createObjectStore(STORE_CATALOGS, { keyPath: 'key' });
      }
      // migration: savedFloors を今回のアップグレードで新設した場合（バージョン1〜3からの
      // アップグレード、およびストア欠損のままバージョンだけ4になっていた修復対象DB）、
      // その時点の floors の内容を savedFloors へコピーする。空の savedFloors のまま起動すると
      // seedFloorsFromDocument が floors を白紙化しデータロスになるため。v3 でも deactivate
      // （階切替のスワップアウト）は複数階を無条件に floors へ書いていたため「常に1階分のみ」
      // ではない——参照されなくなった孤児レコードもここでは区別せず一旦コピーされるが、
      // 初回の明示保存（commitFloorsToDocument が project.planeMap に無い分を削除する）で掃除される。
      if (savedFloorsCreated && e.oldVersion >= 1) {
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
// floors ストアを書く関数は必ず floorWriteGeneration.js の世代を進める（openDB() の await より
// 前——IDB失敗・セッションロックのthrowでも取りこぼさない「書込み前に進める」契約）。
// ----------------------------------------------------------------

export async function saveFloor(planeId, bytes) {
  noteFloorWrite(planeId);
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
  noteFloorWrite(planeId);
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
  noteAllFloorsWritten();
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
// 敷地（project.site）— projects ストアの別レコード
// 内部キーは projectId とは衝突しない `${projectId}:site` を使う（同一ストア・別レコード）。
// ----------------------------------------------------------------

function siteKey(projectId) {
  return `${projectId}:site`;
}

export async function saveSiteData(projectId, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROJECTS, 'readwrite');
    const req = tx.objectStore(STORE_PROJECTS).put({ projectId: siteKey(projectId), bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function loadSiteData(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      resolve(null);
      return;
    }
    const tx  = db.transaction(STORE_PROJECTS, 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).get(siteKey(projectId));
    req.onsuccess = (e) => resolve(e.target.result?.bytes ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ----------------------------------------------------------------
// 調査・計画情報（project.projectInfo）— projects ストアの別レコード
// 内部キーは projectId とは衝突しない `${projectId}:info` を使う（同一ストア・別レコード）。
// ----------------------------------------------------------------

function infoKey(projectId) {
  return `${projectId}:info`;
}

export async function saveProjectInfo(projectId, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROJECTS, 'readwrite');
    const req = tx.objectStore(STORE_PROJECTS).put({ projectId: infoKey(projectId), bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function loadProjectInfo(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      resolve(null);
      return;
    }
    const tx  = db.transaction(STORE_PROJECTS, 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).get(infoKey(projectId));
    req.onsuccess = (e) => resolve(e.target.result?.bytes ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ----------------------------------------------------------------
// カタログ文書同梱（.stq 同梱）— projects ストアの別レコード（種別ごとに1レコード）。
// 内部キーは projectId とは衝突しない `${projectId}:catalogs:<kind>` を使う（同一ストア・別レコード）。
// 範囲取得（IDBKeyRange.bound）で全種別を1回で読む——listKinds() でループしない。未知の種別
// （このビルドの登録表に無い kind）で保存されたレコードも取りこぼさないため（4.5-5）。
// ----------------------------------------------------------------

// prefix範囲取得の上限境界（UTF-16の最大コード単位）。documentCatalogPrefix(projectId) で
// 始まるキーをすべて含む範囲を IDBKeyRange.bound(prefix, prefix + LAST_UNICODE_CHAR) で作る。
const LAST_UNICODE_CHAR = String.fromCharCode(0xffff);

function documentCatalogPrefix(projectId) {
  return `${projectId}:catalogs:`;
}

function documentCatalogKey(projectId, kind) {
  return `${documentCatalogPrefix(projectId)}${kind}`;
}

export async function saveDocumentCatalog(projectId, kind, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROJECTS, 'readwrite');
    const req = tx.objectStore(STORE_PROJECTS).put({ projectId: documentCatalogKey(projectId, kind), bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function loadDocumentCatalogs(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      resolve([]);
      return;
    }
    const prefix = documentCatalogPrefix(projectId);
    const range  = IDBKeyRange.bound(prefix, prefix + LAST_UNICODE_CHAR);
    const tx     = db.transaction(STORE_PROJECTS, 'readonly');
    const req    = tx.objectStore(STORE_PROJECTS).openCursor(range);
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(results); return; }
      results.push({ kind: cursor.value.projectId.slice(prefix.length), bytes: cursor.value.bytes });
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteDocumentCatalogs(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      resolve();
      return;
    }
    const prefix = documentCatalogPrefix(projectId);
    const range  = IDBKeyRange.bound(prefix, prefix + LAST_UNICODE_CHAR);
    const tx     = db.transaction(STORE_PROJECTS, 'readwrite');
    const req    = tx.objectStore(STORE_PROJECTS).openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// ----------------------------------------------------------------
// ユーザーカタログライブラリ — catalogs ストア（keyPath: 'key'。アプリ単位・プロジェクトをまたぐ）。
// 内部キーは `user:<kind>`。clearAllStores の対象外（「新規（全消去）」でも消えない）。
// ----------------------------------------------------------------

function userCatalogKey(kind) {
  return `user:${kind}`;
}

export async function saveUserCatalog(kind, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CATALOGS, 'readwrite');
    const req = tx.objectStore(STORE_CATALOGS).put({ key: userCatalogKey(kind), bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function loadUserCatalogs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_CATALOGS)) {
      resolve([]);
      return;
    }
    const tx  = db.transaction(STORE_CATALOGS, 'readonly');
    const req = tx.objectStore(STORE_CATALOGS).getAll();
    req.onsuccess = (e) => resolve(
      e.target.result.map(r => ({ kind: r.key.slice('user:'.length), bytes: r.bytes })),
    );
    req.onerror = (e) => reject(e.target.error);
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
  noteAllFloorsWritten();
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

/** savedFloors の全レコード（保存ドキュメント本体）を返す。文書ファイル書き出し用。 */
export async function loadAllSavedFloors() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_SAVED_FLOORS)) {
      resolve([]);
      return;
    }
    const tx  = db.transaction(STORE_SAVED_FLOORS, 'readonly');
    const req = tx.objectStore(STORE_SAVED_FLOORS).getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** savedFloors へ1レコード直接書き込む。文書ファイル読み込み（importDocument）専用。 */
export async function saveSavedFloor(planeId, bytes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_SAVED_FLOORS, 'readwrite');
    const req = tx.objectStore(STORE_SAVED_FLOORS).put({ planeId, bytes });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
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
