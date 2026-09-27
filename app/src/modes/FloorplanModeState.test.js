// FloorplanModeState: 通り芯交点ドラッグ（ストレッチ機構）廃止（2026-09-21ユーザー裁定）の回帰確認。
// 交点を掴んで2本のCLを同時に動かす経路は無い（CLの移動は moveState 系のみ）。stretchState系APIは
// 削除済みで、復活していないことをここで守る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph } from '@core';
import { FloorplanModeState } from './FloorplanModeState.js';
import { isUiBusy } from '../uiBusy.js';
import { ERR_CL_MOVE_LOAD_FAILED } from '../error.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

test('FloorplanModeState: stretchState・startStretch/updateStretch/commitStretch/cancelStretchは存在しない（交点ドラッグ廃止）', () => {
  const graph = makeGraph();
  const state = new FloorplanModeState(graph, null);

  assert.equal('stretchState' in state, false, 'stretchStateフィールドは削除されているはず');
  assert.equal(state.startStretch, undefined);
  assert.equal(state.updateStretch, undefined);
  assert.equal(state.commitStretch, undefined);
  assert.equal(state.cancelStretch, undefined);
  assert.equal(state.isStretching, undefined, 'isStretchingゲッターも削除されているはず');
});

// dispose() は描画途中でも例外なく通り、moveState/drawStateを閉じる
test('FloorplanModeState.dispose: 描画途中でも例外を投げず、moveState/drawStateをnullに戻す', () => {
  const graph = makeGraph();
  const state = new FloorplanModeState(graph, null);
  state.startDraw('diag', { x: 0, y: 0 }, { x: 0, y: 0 });

  assert.doesNotThrow(() => state.dispose());
  assert.equal(state.drawState, null);
  assert.equal(state.moveState, null);
});

// 入力規制ステップ3: startMoveは関門（uiBusy.js runBusy）を自身の内部で開く（App.jsx側は
// beginUiTransitionを呼ばない——interruptCurrentActionのcancelMoveが準備中の移動を壊すため）。
// _pendingPreloadへ直接差し込み、resolveMoveRange（他フロアIDB読み込みを含む）自体はスタブせずに
// 済ませる。
test('FloorplanModeState.startMove: 準備の待ち時間中はisUiBusy()が真、解決後は偽に戻る', async () => {
  const graph = makeGraph();
  const state = new FloorplanModeState(graph, null);
  const cl = { id: 'cl-move-test', value: 0 };
  let resolvePending;
  const pending = new Promise((resolve) => { resolvePending = resolve; });
  state._pendingPreload = { clId: cl.id, promise: pending };

  const startPromise = state.startMove(cl);
  assert.equal(isUiBusy(), true, '準備中はisUiBusy()が真であるはず');

  resolvePending({ range: { min: -100, max: 100 } });
  const err = await startPromise;

  assert.equal(err, null);
  assert.equal(isUiBusy(), false, '解決後はisUiBusy()が偽に戻るはず');
  assert.deepEqual(state.moveState, { cl, originalValue: 0, range: { min: -100, max: 100 } });
});

// 【失敗系】準備のpromiseがrejectしても、関門（isUiBusy）は必ず戻り、moveStateは立たない。
test('【失敗系】FloorplanModeState.startMove: 準備のpromiseがrejectしてもisUiBusy()は戻り、ERR_CL_MOVE_LOAD_FAILEDを返す', async () => {
  const graph = makeGraph();
  const state = new FloorplanModeState(graph, null);
  const cl = { id: 'cl-move-fail', value: 0 };
  let rejectPending;
  const pending = new Promise((_resolve, reject) => { rejectPending = reject; });
  state._pendingPreload = { clId: cl.id, promise: pending };

  const startPromise = state.startMove(cl);
  assert.equal(isUiBusy(), true, '準備中はisUiBusy()が真であるはず');

  rejectPending(new Error('IDB読込失敗'));
  const err = await startPromise;

  assert.equal(err, ERR_CL_MOVE_LOAD_FAILED);
  assert.equal(isUiBusy(), false, '失敗後もisUiBusy()が偽に戻るはず');
  assert.equal(state.moveState, null);
});

// 交点ドラッグの起動判定は React フック（usePointerInteraction.js）側にあり直接は呼べないため、
// ソース本文で不在を守る（通常モードの 8px 超ドラッグは longPress.move() のパン経路だけ）。
test('【不変条件】usePointerInteraction.js: 交点ドラッグの起動判定が無く、通常モードのドラッグは longPress.move() のパン経路へ落ちる', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../interaction/usePointerInteraction.js'), 'utf8');
  assert.doesNotMatch(src, /stretch/i);
  const normal = src.slice(src.indexOf('// ---- 通常モード ----'));
  assert.match(normal, /longPress\.move\(clientX, clientY\)/);
});
