// floorTransition.js の単体テスト。mobx（observable.box）のみに依存する葉モジュールのため、
// react-konva/store.js/.jsx を経由せず node:test から直接importできる
// （extracted-module-import-invariant.md の規律と同じ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun } from 'mobx';
import { isFloorTransitioning, runFloorTransition } from './floorTransition.js';

// テスト間でdepthが0に戻っていることを前提にするため、各testの冒頭で確認する
// （モジュールスコープのobservable.boxを共有するため、前testの後始末漏れを検出しやすくする）。
function assertIdleAtStart() {
  assert.equal(isFloorTransitioning(), false, '前提: 前testの後始末が漏れておらずdepthが0に戻っている');
}

test('runFloorTransition: 実行中はisFloorTransitioning()が真になり、完了後に偽へ戻る', async () => {
  assertIdleAtStart();
  let resolveFn;
  const pending = new Promise(r => { resolveFn = r; });

  const runPromise = runFloorTransition(() => pending);
  // runFloorTransitionは呼び出しと同時（fnの最初のawaitより前）に同期で深さを進めるため、
  // pendingをawaitする前のこの時点で既に真になっているはず。
  assert.equal(isFloorTransitioning(), true, '呼び出し直後（同期）に真になっているはず');

  resolveFn('done');
  const result = await runPromise;
  assert.equal(result, 'done', 'fnの戻り値をそのまま返す');
  assert.equal(isFloorTransitioning(), false, '完了後は偽に戻る');
});

test('runFloorTransition: 入れ子呼び出しは深さで数え、内側が終わっても外側が終わるまで真のまま', async () => {
  assertIdleAtStart();
  let resolveOuter, resolveInner;
  const outerPending = new Promise(r => { resolveOuter = r; });
  const innerPending = new Promise(r => { resolveInner = r; });

  const outerPromise = runFloorTransition(async () => {
    const innerPromise = runFloorTransition(() => innerPending);
    resolveInner('inner-done');
    await innerPromise;
    // 内側が終わった直後（外側はまだ終わっていない）でも真のままのはず
    assert.equal(isFloorTransitioning(), true, '内側完了後・外側完了前は真のまま（深さ1で残る）');
    await outerPending;
  });

  resolveOuter('outer-done');
  await outerPromise;
  assert.equal(isFloorTransitioning(), false, '外側も完了すれば偽に戻る');
});

test('【失敗系】runFloorTransition: fnがreject（throw）しても深さを戻し、例外はそのまま伝播する', async () => {
  assertIdleAtStart();
  const boom = new Error('boom');

  await assert.rejects(
    runFloorTransition(() => Promise.reject(boom)),
    boom,
    'fnの例外はそのまま呼び出し元へ伝播するはず',
  );

  assert.equal(isFloorTransitioning(), false, 'finallyで深さが戻り、例外時も偽に戻るはず');
});

test('runFloorTransition: isFloorTransitioning()はmobxのreactionから観測できる（observable）', async () => {
  assertIdleAtStart();
  const observed = [];
  const dispose = autorun(() => { observed.push(isFloorTransitioning()); });

  let resolveFn;
  const pending = new Promise(r => { resolveFn = r; });
  const runPromise = runFloorTransition(() => pending);
  resolveFn();
  await runPromise;

  dispose();
  assert.deepEqual(observed, [false, true, false],
    '初回登録時(false)→開始(true)→終了(false)の3回、autorunが再実行されるはず');
});
