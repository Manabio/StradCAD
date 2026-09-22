// saveDocumentCatalogs（ステップ7c QA指摘Major-1対応）の atomicity 専用テストファイル。
// db.js は openDB() の結果をモジュールスコープにキャッシュするため（db.catalogs.test.js 冒頭
// コメントと同じ方針）、このファイルだけの専用フェイクIndexedDBを使う——他の db.*.test.js の
// 単純化されたフェイク（put即時反映。実IDBのロールバックを再現しない）とは別に、ここでは
// 「トランザクション内のputは全て成功して初めてコミットされ、1つでも失敗すれば1件もコミット
// されない」という実IndexedDBのトランザクションatomicityを最小限で模す自前シムを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveDocumentCatalogs } from './db.js';

class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }

// committed: 実際に「コミットされた」レコードだけが入る（put時点では入らない）。
const committed = new Map();
// このテストファイル内で共有する「n件目のputを失敗させる」設定（各testで設定し直す）。
let failOnNth = null;
// put の通し番号は**トランザクションをまたいで**数える（各testの冒頭で0に戻す）。
// トランザクション単位で数えると、種別ごとに別トランザクションを張る退行実装では
// 各 tx の1件目しか数えられず failOnNth に当たらない＝失敗が再現されず「部分保存」の
// assert に到達できない（2026-09-23 QA Minor-A）。
let putCallCount = 0;

globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.({
      target: {
        result: {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const pendingWrites = [];
            let aborted = false;
            let settled = false;
            const tx = { oncomplete: null, onerror: null };
            const store = {
              put(value) {
                putCallCount++;
                const myIndex = putCallCount;
                const req2 = new FakeRequest();
                const isFailure = myIndex === failOnNth;
                if (isFailure) aborted = true;
                else pendingWrites.push(value);
                // put()はこの関数の中で同期的に呼ばれる（saveDocumentCatalogsのforループに
                // awaitは無い）ため、いずれのputのqueueMicrotaskコールバックが走る時点でも
                // putCallCount・abortedは既に最終値になっている。最初にここへ来たmicrotaskで
                // トランザクションの成否を確定する（settledガードで一度だけ）。
                queueMicrotask(() => {
                  if (isFailure) {
                    const err = new Error('put失敗（テスト用）');
                    req2.onerror?.({ target: { error: err } });
                  } else {
                    req2.onsuccess?.({ target: { result: undefined } });
                  }
                  if (!settled) {
                    settled = true;
                    if (aborted) {
                      tx.onerror?.({ target: { error: new Error('put失敗（テスト用）') } });
                    } else {
                      for (const v of pendingWrites) committed.set(v.projectId, v);
                      tx.oncomplete?.();
                    }
                  }
                });
                return req2;
              },
            };
            tx.objectStore = () => store;
            return tx;
          },
        },
      },
    }));
    return req;
  },
};

test('saveDocumentCatalogs: 3件putの途中（2件目）で失敗したら1件もコミットされない（単一トランザクションのatomicity）', async () => {
  failOnNth = 2;
  putCallCount = 0;
  committed.clear();
  const bytesByKind = new Map([
    ['material', new Uint8Array([1])],
    ['interiorMaster', new Uint8Array([2])],
    ['boundaryMaster', new Uint8Array([3])],
  ]);
  await assert.rejects(
    () => saveDocumentCatalogs('proj-atomic', bytesByKind),
    /put失敗/,
    'put失敗時にPromiseがrejectされない',
  );
  assert.equal(committed.size, 0, '2件目のputが失敗したのに、1件目や3件目がコミットされている（部分保存）');
});

test('saveDocumentCatalogs: 全件成功すれば3件とも1トランザクションでコミットされる', async () => {
  failOnNth = null;
  putCallCount = 0;
  committed.clear();
  const bytesByKind = new Map([
    ['material', new Uint8Array([1])],
    ['interiorMaster', new Uint8Array([2])],
    ['boundaryMaster', new Uint8Array([3])],
  ]);
  await saveDocumentCatalogs('proj-atomic-ok', bytesByKind);
  const keys = [...committed.keys()].filter(k => k.startsWith('proj-atomic-ok:catalogs:'));
  assert.equal(keys.length, 3, '全件成功したのに3件コミットされていない');
});
