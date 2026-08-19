// sessionLock.js の _status はモジュールスコープの状態のため、本ファイル内の複数testで
// 共有される。ただし各testは冒頭で必ず acquireSessionLock(fakeLocks) を呼び、その戻り値に
// 応じて _status を決定的に上書きするため、テスト順序に依存しない
// （前のtestの結果を引きずらない。isSessionOwner()の直前に必ずacquireSessionLockを挟む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSessionLock, isSessionOwner, SESSION_LOCK_NAME } from './sessionLock.js';

// navigator.locks の偽物。callback へ渡す lock 値だけを固定し、Web Locks API の
// 「コールバックの戻り Promise が解決するまでロック保持」の形は本物同様に尊重する
// （acquireSessionLock 側の実装がこの形を正しく踏んでいるかも同時に検証できる）。
function makeFakeLocks(lockValue) {
  const calls = [];
  return {
    calls,
    request(name, options, callback) {
      calls.push({ name, options });
      const result = callback(lockValue);
      return Promise.resolve(result);
    },
  };
}

// このtestは必ず本ファイル先頭（他のtestより先）に置くこと: _status の初期値は
// モジュール読み込み時点の 'pending'（acquireSessionLock 未実行）であり、以降のtestは
// すべて acquireSessionLock を呼んで 'owner'/'blocked' に確定させてしまうため、
// pending状態を観測できるのはこのtestだけになる。
test('isSessionOwner: 初期状態（pending、acquireSessionLock未実行）はtrueを返す（bootReady解決前の窓を通す）', () => {
  assert.equal(isSessionOwner(), true, 'pendingはblockedではないため、isSessionOwner()はtrueを返す');
});

test('acquireSessionLock: lockオブジェクトが渡る（取得成功）→ true、isSessionOwner()もtrue', async () => {
  const fakeLock = { name: SESSION_LOCK_NAME };
  const locks = makeFakeLocks(fakeLock);

  const acquired = await acquireSessionLock(locks);

  assert.equal(acquired, true);
  assert.equal(isSessionOwner(), true);
  assert.equal(locks.calls.length, 1);
  assert.equal(locks.calls[0].name, SESSION_LOCK_NAME);
  assert.equal(locks.calls[0].options.mode, 'exclusive');
  assert.equal(locks.calls[0].options.ifAvailable, true, 'ifAvailable:trueで即座に判定する');
});

test('acquireSessionLock: navigator.locks が無い（undefined）→ フォールバックでtrue、isSessionOwner()もtrue', async () => {
  const acquired = await acquireSessionLock(undefined);

  assert.equal(acquired, true, 'Web Locks API 非対応環境は現行動作（排他制御なし）を維持する');
  assert.equal(isSessionOwner(), true);
});

test('【失敗系】acquireSessionLock: locks.requestがreject（SecurityError等）してもハングせずフォールバックする', async () => {
  const locks = {
    request() {
      return Promise.reject(new Error('SecurityError'));
    },
  };

  const acquired = await acquireSessionLock(locks); // 有限時間で解決する（ハングしない）ことの検証

  assert.equal(acquired, true, 'request()自体のrejectはフォールバックしtrueを返す');
  assert.equal(isSessionOwner(), true);
});

// このtestを最後に置く: isSessionOwner()===falseを作る唯一のケース。以降に本ファイル内で
// 他のtestが続かないことを前提にする（node:testは既定でテストファイルごとに独立した
// モジュールインスタンスで実行されるため、他ファイルのtestへは波及しない）。
test('acquireSessionLock: nullが渡る（他タブが保持中）→ false、isSessionOwner()もfalse', async () => {
  const locks = makeFakeLocks(null);

  const acquired = await acquireSessionLock(locks);

  assert.equal(acquired, false);
  assert.equal(isSessionOwner(), false, 'blocked状態ではisSessionOwner()もfalseになる');
});
