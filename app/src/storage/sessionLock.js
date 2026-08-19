/**
 * Web Locks API による排他セッションロック（単一ライター、自動昇格なし）
 *
 * 整合の意味論: 「1つの origin に対し、IndexedDB へ触れる編集セッションは常に高々1つ」。
 * 2つ目以降のタブはロックを取得できず、IDB を open すらしない非セッションとして起動する
 * （store.js の bootReady / storage/db.js の openDB() 参照）。
 *
 * 葉モジュール: 他の src を import しない（node:test から単体 import 可能に保つ）。
 */

export const SESSION_LOCK_NAME = 'strad-session';

// 'pending'（未判定）| 'owner'（ロック取得済み）| 'blocked'（他タブが保持中）
let _status = 'pending';

/**
 * セッションロックの取得を試みる。取得できればロックを永久保持し true を返す
 * （タブが閉じる/リロードされるまで解放しない——`lock => new Promise(() => {})` で
 * コールバックの戻り Promise を意図的に解決しない）。
 * Web Locks API 非対応環境（フォールバック）は現行動作のまま常に true。
 *
 * @param {LockManager} [locks]  navigator.locks の代替注入（node:test 用）
 * @returns {Promise<boolean>}
 */
export async function acquireSessionLock(locks = globalThis.navigator?.locks) {
  if (!locks) {
    console.warn('[sessionLock] Web Locks API 非対応環境のためフォールバック（排他制御なし）');
    _status = 'owner';
    return true;
  }

  const acquired = await new Promise(resolve => {
    locks.request(SESSION_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) {
        resolve(false);
        return undefined; // 即座に解決してロックを保持しない
      }
      resolve(true);
      return new Promise(() => {}); // 永久に解決しない = ロックを保持し続ける
    }).catch(e => {
      // request() 自体が SecurityError/InvalidStateError 等で reject し得る。成功パスでは
      // コールバックの戻り Promise が永久未解決のため request() も永久 pending のまま
      // ——.catch はここでしか発火しないので誤発火の心配なく足せる。reject時はフォールバックし、
      // 排他制御なしで動作を継続する（bootReadyの永久pending=白画面を防ぐ）。
      console.warn('[sessionLock] ロック要求が失敗したためフォールバック（排他制御なし）', e);
      resolve(true);
    });
  });

  _status = acquired ? 'owner' : 'blocked';
  return acquired;
}

/**
 * 現在のタブが編集セッションの持ち主かどうか。
 * 'pending'（未判定）は通す——App.jsx の effect（peek 等）が bootReady 解決前に走り得るため。
 * pending の窓は import 時点から acquireSessionLock 呼び出し完了までの短い期間のみ。
 */
export function isSessionOwner() {
  return _status !== 'blocked';
}
