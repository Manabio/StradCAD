// error.js の純関数のテスト（QA指摘F3・2026-09-27）。error.js自体は他のsrcをimportしない
// 葉モジュールのためnode:testから直接importできる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorTransitionErrorMessage, ERR_FLOOR_SWITCH_UNSTABLE, ERR_FLOOR_SWITCH_FAILED, ERR_CATALOG_DUPLICATE,
} from './error.js';

test('floorTransitionErrorMessage: ERR_FLOOR_SWITCH_UNSTABLEはそのまま見せる', () => {
  const err = new Error(ERR_FLOOR_SWITCH_UNSTABLE);
  assert.equal(floorTransitionErrorMessage(err), ERR_FLOOR_SWITCH_UNSTABLE);
});

test('floorTransitionErrorMessage: err.codeがERR_CATALOG_DUPLICATEなら組み立て済みのmessageをそのまま見せる（丸めない）', () => {
  const err = Object.assign(new Error('材コード0123456789ABが重複しています'), { code: ERR_CATALOG_DUPLICATE });
  assert.equal(floorTransitionErrorMessage(err), '材コード0123456789ABが重複しています');
});

test('【失敗系】floorTransitionErrorMessage: 生の技術的なエラー（.codeを持たない）はERR_FLOOR_SWITCH_FAILEDに丸める', () => {
  const err = new Error('IndexedDB is not defined');
  assert.equal(floorTransitionErrorMessage(err), ERR_FLOOR_SWITCH_FAILED);
});

test('【失敗系】floorTransitionErrorMessage: 未知の.codeを持つエラーもERR_FLOOR_SWITCH_FAILEDに丸める（既知一覧に無いものは生扱い）', () => {
  const err = Object.assign(new Error('何か別のエラー'), { code: 'ERR_SOMETHING_UNKNOWN' });
  assert.equal(floorTransitionErrorMessage(err), ERR_FLOOR_SWITCH_FAILED);
});

test('【失敗系】floorTransitionErrorMessage: Errorインスタンスでない値（文字列やundefined）もERR_FLOOR_SWITCH_FAILEDに丸める', () => {
  assert.equal(floorTransitionErrorMessage('plain string'), ERR_FLOOR_SWITCH_FAILED);
  assert.equal(floorTransitionErrorMessage(undefined), ERR_FLOOR_SWITCH_FAILED);
  assert.equal(floorTransitionErrorMessage(null), ERR_FLOOR_SWITCH_FAILED);
});
