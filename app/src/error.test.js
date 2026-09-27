// error.js の純関数のテスト（QA指摘F3・2026-09-27）。error.js自体は他のsrcをimportしない
// 葉モジュールのためnode:testから直接importできる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorTransitionErrorMessage, ERR_FLOOR_SWITCH_UNSTABLE, ERR_FLOOR_SWITCH_FAILED, ERR_CATALOG_DUPLICATE,
  ERR_CL_OP_FAILED, ERR_CL_CONVERT_SYNC_FAILED, tagCLOpFailure,
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

// ---- tagCLOpFailure・ERR_CL_OP_FAILED（入力規制ステップ3・CL操作の入口の関門化）----

test('tagCLOpFailure: codeを持たないErrorはnew Errorで包み、causeに元の例外を残してERR_CL_OP_FAILEDを付ける', () => {
  const err = new Error('IndexedDB is not defined');
  const tagged = tagCLOpFailure(err);
  assert.notEqual(tagged, err, '元のErrorはcodeのgetter専用（DOMException）なこともあり、in-placeで書き換えず包む');
  assert.equal(tagged.code, ERR_CL_OP_FAILED);
  assert.equal(tagged.cause, err);
  assert.equal(tagged.message, err.message);
});

test('tagCLOpFailure: 既に文字列codeを持つ既知エラー（例: ERR_CATALOG_DUPLICATE）は同じインスタンスのまま上書きしない', () => {
  const err = Object.assign(new Error('材コード0123456789ABが重複しています'), { code: ERR_CATALOG_DUPLICATE });
  const tagged = tagCLOpFailure(err);
  assert.equal(tagged, err, '文字列codeを持つ既知エラーは包まずそのまま返す');
  assert.equal(tagged.code, ERR_CATALOG_DUPLICATE);
});

test('【失敗系】tagCLOpFailure: Errorでない値（文字列等）はnew Errorで包みERR_CL_OP_FAILEDを付ける', () => {
  const tagged = tagCLOpFailure('boom');
  assert.ok(tagged instanceof Error);
  assert.equal(tagged.code, ERR_CL_OP_FAILED);
  assert.equal(tagged.cause, 'boom');
  assert.match(tagged.message, /boom/);
});

test('【失敗系】tagCLOpFailure: DOMException（数値code。storage/db.jsのQuotaExceededError等）はcodeのgetterへの再代入で例外にならず、包んでERR_CL_OP_FAILEDを付ける', () => {
  const domErr = new DOMException('Quota exceeded', 'QuotaExceededError');
  assert.equal(typeof domErr.code, 'number', '前提: DOMException.codeは数値（例: QuotaExceededError=22）');
  const tagged = tagCLOpFailure(domErr);
  assert.ok(tagged instanceof Error);
  assert.notEqual(tagged, domErr);
  assert.equal(tagged.code, ERR_CL_OP_FAILED);
  assert.equal(tagged.cause, domErr, 'causeが元のDOMExceptionであるはず');
  assert.equal(tagged.message, domErr.message);
  assert.equal(floorTransitionErrorMessage(tagged), ERR_CL_CONVERT_SYNC_FAILED);
});

test('floorTransitionErrorMessage: err.codeがERR_CL_OP_FAILEDならERR_CL_CONVERT_SYNC_FAILEDの文言を返す（生のmessageは見せない）', () => {
  const err = Object.assign(new Error('IndexedDB is not defined'), { code: ERR_CL_OP_FAILED });
  assert.equal(floorTransitionErrorMessage(err), ERR_CL_CONVERT_SYNC_FAILED);
});
