// uiBusy.js の単体テスト。mobx（observable.box）のみに依存する葉モジュールのため、
// react-konva/store.js/.jsxを経由せず node:test から直接importできる
// （extracted-module-import-invariant.md の規律と同じ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun } from 'mobx';
import { isUiBusy, uiBusyLabel, runBusy, whenUiIdle } from './uiBusy.js';

// テスト間でdepthが0に戻っていることを前提にするため、各testの冒頭で確認する
// （モジュールスコープのobservable.boxを共有するため、前testの後始末漏れを検出しやすくする）。
function assertIdleAtStart() {
  assert.equal(isUiBusy(), false, '前提: 前testの後始末が漏れておらずdepthが0に戻っている');
  assert.equal(uiBusyLabel(), null, '前提: 前testの後始末が漏れておらずlabelがnullに戻っている');
}

test('runBusy: 実行中はisUiBusy()が真になり、完了後に偽へ戻る', async () => {
  assertIdleAtStart();
  let resolveFn;
  const pending = new Promise(r => { resolveFn = r; });

  const runPromise = runBusy('階切替', () => pending);
  // runBusyは呼び出しと同時（fnの最初のawaitより前）に同期で深さを進めるため、
  // pendingをawaitする前のこの時点で既に真になっているはず。
  assert.equal(isUiBusy(), true, '呼び出し直後（同期）に真になっているはず');

  resolveFn('done');
  const result = await runPromise;
  assert.equal(result, 'done', 'fnの戻り値をそのまま返す');
  assert.equal(isUiBusy(), false, '完了後は偽に戻る');
});

test('runBusy: 入れ子呼び出しは深さで数え、内側が終わっても外側が終わるまで真のまま', async () => {
  assertIdleAtStart();
  let resolveOuter, resolveInner;
  const outerPending = new Promise(r => { resolveOuter = r; });
  const innerPending = new Promise(r => { resolveInner = r; });

  const outerPromise = runBusy('階切替', async () => {
    const innerPromise = runBusy('モード切替', () => innerPending);
    resolveInner('inner-done');
    await innerPromise;
    // 内側が終わった直後（外側はまだ終わっていない）でも真のままのはず
    assert.equal(isUiBusy(), true, '内側完了後・外側完了前は真のまま（深さ1で残る）');
    await outerPending;
  });

  resolveOuter('outer-done');
  await outerPromise;
  assert.equal(isUiBusy(), false, '外側も完了すれば偽に戻る');
});

test('【失敗系】runBusy: fnがreject（throw）しても深さを戻し、例外はそのまま伝播する', async () => {
  assertIdleAtStart();
  const boom = new Error('boom');

  await assert.rejects(
    runBusy('undo', () => Promise.reject(boom)),
    boom,
    'fnの例外はそのまま呼び出し元へ伝播するはず',
  );

  assert.equal(isUiBusy(), false, 'finallyで深さが戻り、例外時も偽に戻るはず');
});

test('runBusy: isUiBusy()はmobxのreactionから観測できる（observable）', async () => {
  assertIdleAtStart();
  const observed = [];
  const dispose = autorun(() => { observed.push(isUiBusy()); });

  let resolveFn;
  const pending = new Promise(r => { resolveFn = r; });
  const runPromise = runBusy('redo', () => pending);
  resolveFn();
  await runPromise;

  dispose();
  assert.deepEqual(observed, [false, true, false],
    '初回登録時(false)→開始(true)→終了(false)の3回、autorunが再実行されるはず');
});

test('uiBusyLabel: 最外側のlabelだけを返し、入れ子の内側のlabelは反映されず、外側が終わると null に戻る', async () => {
  assertIdleAtStart();
  let resolveOuter, resolveInner;
  const outerPending = new Promise(r => { resolveOuter = r; });
  const innerPending = new Promise(r => { resolveInner = r; });
  const observedInner = [];

  const outerPromise = runBusy('階切替', async () => {
    assert.equal(uiBusyLabel(), '階切替', '外側のlabelが記録されているはず');
    const innerPromise = runBusy('モード切替', () => innerPending);
    // 入れ子の内側のlabelには置き換わらない（最外側のlabelのまま）。
    observedInner.push(uiBusyLabel());
    resolveInner('inner-done');
    await innerPromise;
    assert.equal(uiBusyLabel(), '階切替', '内側完了後も外側のlabelのまま');
    await outerPending;
  });

  resolveOuter('outer-done');
  await outerPromise;
  assert.deepEqual(observedInner, ['階切替'], '入れ子の内側では最外側のlabelのままである必要がある');
  assert.equal(uiBusyLabel(), null, '外側も完了すればlabelはnullに戻る');
});

test('whenUiIdle: busy中はresolveせず、depthが0に戻ってからresolveする', async () => {
  assertIdleAtStart();
  let resolveFn;
  const pending = new Promise(r => { resolveFn = r; });

  const runPromise = runBusy('階切替', () => pending);
  let idleResolved = false;
  const idlePromise = whenUiIdle().then(() => { idleResolved = true; });

  // busy中はまだresolveされていないはず（マイクロタスクを1つ挟んでも変化しないことを確認）。
  await Promise.resolve();
  assert.equal(idleResolved, false, 'busy中はwhenUiIdle()がresolveされていないはず');

  resolveFn('done');
  await runPromise;
  // idlePromise を直接 await すると、resolver を解放しない不具合のときにテストが赤にならず
  // 全体が止まる（QA指摘・2026-09-28）。マイクロタスクを挟んでフラグで判定する。
  await Promise.resolve();
  assert.equal(idleResolved, true, 'depthが0に戻ればwhenUiIdle()がresolveされるはず');
  await idlePromise;
});

test('whenUiIdle: 既にidleなら即resolveする', async () => {
  assertIdleAtStart();
  let resolved = false;
  await whenUiIdle().then(() => { resolved = true; });
  assert.equal(resolved, true, '既にidleなら待たずにresolveされるはず');
});

test('【失敗系】whenUiIdle: fnがrejectして関門を抜けた場合もlabelがnullに戻り、待っていたwhenUiIdle()がresolveされる', async () => {
  assertIdleAtStart();
  const boom = new Error('boom');
  let rejectFn;
  const pending = new Promise((_, reject) => { rejectFn = reject; });

  const runPromise = runBusy('undo', () => pending);
  let idleResolved = false;
  const idlePromise = whenUiIdle().then(() => { idleResolved = true; }); // busy中に登録

  rejectFn(boom);
  await assert.rejects(runPromise, boom);

  // 直接 await せずフラグで判定（resolver 未解放の不具合でハングさせない）。
  await Promise.resolve();
  assert.equal(idleResolved, true, '失敗して関門を抜けても待っていたwhenUiIdle()はresolveされるはず');
  assert.equal(uiBusyLabel(), null, '失敗して関門を抜けてもlabelはnullに戻るはず');
  await idlePromise;
});
