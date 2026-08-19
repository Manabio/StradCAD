// FloorSwapManager.test.js と同じ手法の裏返し: node:test 環境では indexedDB が未定義のため、
// indexedDB.open に到達すれば "indexedDB is not defined" で reject する。本テストはそこへ
// 到達する前——openDB() 冒頭のセッションロック判定——で専用エラー（ERR_SESSION_LOCKED）
// により reject することを確認する（＝ indexedDB.open が呼ばれていない証跡）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSessionLock } from './sessionLock.js';
import { saveFloor } from './db.js';

// sessionLock.test.js と同じ順序戦略: sessionLock.js の _status はモジュールスコープの
// 状態で、本ファイル内の複数testで共有される。このtestは必ず先頭（acquireSessionLockを
// 一度も呼んでいない状態）に置くこと——_status の初期値 'pending' を観測できるのは
// このtestだけになる（以降のtestは acquireSessionLock を呼んで 'blocked' に確定させる）。
test('openDB: pending（起動直後の未判定窓、acquireSessionLock未実行）は従来どおり indexedDB へ到達する（isSessionOwner()のpending素通りの証跡）', async () => {
  // 「到達する」ことの証跡として、node:test環境固有の「indexedDB is not defined」で
  // reject することを使う（ERR_SESSION_LOCKEDでは reject しない＝ゲートを素通りした証跡）。
  await assert.rejects(
    saveFloor('p1', new Uint8Array()),
    /indexedDB is not defined/,
    'pending状態はisSessionOwner()がtrueを返すため、openDB()はindexedDB.openまで到達する',
  );
});

test('【失敗系】openDB: セッションロックを保持していない（blocked）タブは indexedDB を open せず専用エラーで reject する', async () => {
  const locks = {
    request(name, options, callback) {
      return Promise.resolve(callback(null));
    },
  };
  const acquired = await acquireSessionLock(locks);
  assert.equal(acquired, false, '前提: このタブはロックを取得できていない');

  await assert.rejects(
    saveFloor('p1', new Uint8Array()),
    /別のタブ/,
    'indexedDB is not defined ではなく専用エラーで落ちる＝openDB()がindexedDB.openへ到達していない証跡',
  );
});
