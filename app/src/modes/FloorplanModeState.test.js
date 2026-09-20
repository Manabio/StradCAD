// FloorplanModeState: 通り芯交点ドラッグ（ストレッチ機構）廃止（2026-09-21ユーザー裁定）の回帰確認。
// 交点を掴んで2本のCLを同時に動かす経路は無い（CLの移動は moveState 系のみ）。stretchState系APIは
// 削除済みで、復活していないことをここで守る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph } from '@core';
import { FloorplanModeState } from './FloorplanModeState.js';

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

// 交点ドラッグの起動判定は React フック（usePointerInteraction.js）側にあり直接は呼べないため、
// ソース本文で不在を守る（通常モードの 8px 超ドラッグは longPress.move() のパン経路だけ）。
test('【不変条件】usePointerInteraction.js: 交点ドラッグの起動判定が無く、通常モードのドラッグは longPress.move() のパン経路へ落ちる', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../interaction/usePointerInteraction.js'), 'utf8');
  assert.doesNotMatch(src, /stretch/i);
  const normal = src.slice(src.indexOf('// ---- 通常モード ----'));
  assert.match(normal, /longPress\.move\(clientX, clientY\)/);
});
