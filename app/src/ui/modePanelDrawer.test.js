import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenOnSignal, drawerTransform, HANDLE_WIDTH, HANDLE_HEIGHT } from './modePanelDrawer.js';

test('shouldOpenOnSignal: falsy→truthy・truthy→別の truthy では開く', () => {
  assert.equal(shouldOpenOnSignal(undefined, 'a'), true);
  assert.equal(shouldOpenOnSignal(null, 3), true);
  assert.equal(shouldOpenOnSignal('a', 'b'), true);
  assert.equal(shouldOpenOnSignal(0, 1), true);
});

test('shouldOpenOnSignal: 変化なし・falsy 同士では開かない', () => {
  assert.equal(shouldOpenOnSignal(undefined, undefined), false);
  assert.equal(shouldOpenOnSignal(null, undefined), false);
  assert.equal(shouldOpenOnSignal('a', 'a'), false);
  assert.equal(shouldOpenOnSignal(0, ''), false);
});

test('shouldOpenOnSignal: truthy→falsy では開かない（0・空文字・null も falsy）', () => {
  assert.equal(shouldOpenOnSignal('a', undefined), false);
  assert.equal(shouldOpenOnSignal('a', null), false);
  assert.equal(shouldOpenOnSignal(5, 0), false);
  assert.equal(shouldOpenOnSignal('a', ''), false);
  assert.equal(shouldOpenOnSignal(undefined, 0), false);
  assert.equal(shouldOpenOnSignal(undefined, ''), false);
});

test('drawerTransform: 開＝移動なし／閉＝右へ全幅ぶん', () => {
  assert.equal(drawerTransform(true), 'translateX(0)');
  assert.equal(drawerTransform(false), 'translateX(100%)');
});

test('取っ手の寸法は正の数', () => {
  assert.ok(HANDLE_WIDTH > 0 && HANDLE_HEIGHT > 0);
});
