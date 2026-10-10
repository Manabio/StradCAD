// CeilingModeState（天伏モード。独立 State）。mobx 以外に依存しないため node:test から直接 import できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun } from 'mobx';
import { CeilingModeState } from './CeilingModeState.js';
import { FinishModeState } from './FinishModeState.js';

test('CeilingModeState: 既定値（選択なし・内部タブ）。graph を持たず、FinishModeState を継承しない', () => {
  const state = new CeilingModeState();
  assert.equal(state.graph, undefined);
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.activeTab, 'interior');
  assert.ok(!(state instanceof FinishModeState));
  state.dispose();
});

test('CeilingModeState: selectRoom は observable に反映し、null・undefined で解除する', () => {
  const state = new CeilingModeState();
  const seen = [];
  const stop = autorun(() => seen.push(state.selectedRoomId));
  state.selectRoom('r1');
  state.selectRoom(undefined);
  stop();
  assert.deepEqual(seen, [null, 'r1', null]);
});

test('CeilingModeState: setActiveTab は interior / stair を切り替える', () => {
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  assert.equal(state.activeTab, 'stair');
  state.setActiveTab('interior');
  assert.equal(state.activeTab, 'interior');
});

test('【失敗系】CeilingModeState: 未知のタブ名は例外で、activeTab は変わらない', () => {
  const state = new CeilingModeState();
  state.setActiveTab('stair');
  assert.throws(() => state.setActiveTab('exterior'), /未知のタブ/);
  assert.equal(state.activeTab, 'stair');
});

test('CeilingModeState: dispose で選択を解除する（タブは保つ）。dispose の二重呼びも例外にならない', () => {
  const state = new CeilingModeState();
  state.selectRoom('r1');
  state.setActiveTab('stair');
  state.dispose();
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.activeTab, 'stair');
  assert.doesNotThrow(() => state.dispose());
});
