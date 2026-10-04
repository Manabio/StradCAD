// error.js の純関数のテスト（QA指摘F3・2026-09-27）。error.js自体は他のsrcをimportしない
// 葉モジュールのためnode:testから直接importできる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorTransitionErrorMessage, ERR_FLOOR_SWITCH_UNSTABLE, ERR_FLOOR_SWITCH_FAILED, ERR_CATALOG_DUPLICATE,
  ERR_CL_OP_FAILED, ERR_CL_CONVERT_SYNC_FAILED, tagCLOpFailure,
  tagElevatorOpFailure, ERR_ELEVATOR_OP_FAILED, ERR_ELEVATOR_OP_FAILED_MESSAGE,
  ERR_ELEVATOR_REMOVE_FAILED, ERR_ELEVATOR_REMOVE_FAILED_MESSAGE,
  ERR_ELEVATOR_USAGE_FAILED, ERR_ELEVATOR_USAGE_FAILED_MESSAGE,
  ERR_STAIR_DESIGNATE_FAILED, ERR_STAIR_DESIGNATE_FAILED_MESSAGE, ERR_STAIR_DESIGNATE_ABORTED,
  ERR_STAIR_UPPER_CHECK_FAILED, ERR_ELEVATOR_FLOORS_CHANGED,
  ERR_STAIR_DELETE_FAILED, ERR_STAIR_DELETE_FAILED_MESSAGE,
} from './error.js';

test('階段の削除の失敗: tagElevatorOpFailure で包んだ例外は専用文言になり、包んでいない例外は汎用文言のまま', () => {
  const tagged = tagElevatorOpFailure(new Error('boom'), { code: ERR_STAIR_DELETE_FAILED, message: ERR_STAIR_DELETE_FAILED_MESSAGE });
  assert.equal(tagged.code, ERR_STAIR_DELETE_FAILED);
  assert.equal(floorTransitionErrorMessage(tagged), ERR_STAIR_DELETE_FAILED_MESSAGE);
  assert.notEqual(floorTransitionErrorMessage(new Error('boom')), ERR_STAIR_DELETE_FAILED_MESSAGE);
});

test('【B1b】階段の指定の失敗: tagElevatorOpFailure で包んだ例外は floorTransitionErrorMessage で階切替の汎用文言に丸められず専用文言になる', () => {
  const tagged = tagElevatorOpFailure(new Error('boom'), { code: ERR_STAIR_DESIGNATE_FAILED, message: ERR_STAIR_DESIGNATE_FAILED_MESSAGE });
  assert.equal(tagged.code, ERR_STAIR_DESIGNATE_FAILED);
  assert.equal(floorTransitionErrorMessage(tagged), ERR_STAIR_DESIGNATE_FAILED_MESSAGE);
  assert.notEqual(floorTransitionErrorMessage(new Error('boom')), ERR_STAIR_DESIGNATE_FAILED_MESSAGE, '包んでいない例外は従来どおり汎用文言');
});

test('【B1b】階段の指定の中断用の文言は、確認失敗用・昇降機用の文言と別', () => {
  assert.notEqual(ERR_STAIR_DESIGNATE_ABORTED, ERR_STAIR_UPPER_CHECK_FAILED);
  assert.notEqual(ERR_STAIR_DESIGNATE_ABORTED, ERR_ELEVATOR_FLOORS_CHANGED);
});

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

// ---- 昇降機の設置・削除・用途変更（tagElevatorOpFailure・KNOWN_TRANSITION_ERROR_CODES）----
// QA指摘T4・T7（2026-09-30）: floorTransitionErrorMessageの既知コード一覧に削除・用途変更の
// 識別コードが載っていること、かつ削除は削除用の文言・用途変更は用途変更用の文言と一致し、
// 設置の文言（ERR_ELEVATOR_OP_FAILED_MESSAGE）にはならないことを固定する。

test('【QA指摘T4】floorTransitionErrorMessage: err.codeがERR_ELEVATOR_REMOVE_FAILEDなら組み立て済みのmessageをそのまま見せる', () => {
  const err = Object.assign(new Error(ERR_ELEVATOR_REMOVE_FAILED_MESSAGE), { code: ERR_ELEVATOR_REMOVE_FAILED });
  assert.equal(floorTransitionErrorMessage(err), ERR_ELEVATOR_REMOVE_FAILED_MESSAGE);
});

test('【QA指摘T4】floorTransitionErrorMessage: err.codeがERR_ELEVATOR_USAGE_FAILEDなら組み立て済みのmessageをそのまま見せる', () => {
  const err = Object.assign(new Error(ERR_ELEVATOR_USAGE_FAILED_MESSAGE), { code: ERR_ELEVATOR_USAGE_FAILED });
  assert.equal(floorTransitionErrorMessage(err), ERR_ELEVATOR_USAGE_FAILED_MESSAGE);
});

test('【QA指摘T7】tagElevatorOpFailure: 削除の識別で包んだ例外の文言はERR_ELEVATOR_REMOVE_FAILED_MESSAGEと一致し、設置の文言にはならない', () => {
  const tagged = tagElevatorOpFailure(new Error('boom'), { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE });
  assert.equal(tagged.code, ERR_ELEVATOR_REMOVE_FAILED);
  assert.equal(tagged.message, ERR_ELEVATOR_REMOVE_FAILED_MESSAGE);
  assert.notEqual(tagged.message, ERR_ELEVATOR_OP_FAILED_MESSAGE);
});

test('【QA指摘T7】tagElevatorOpFailure: 用途変更の識別で包んだ例外の文言はERR_ELEVATOR_USAGE_FAILED_MESSAGEと一致し、設置の文言にはならない', () => {
  const tagged = tagElevatorOpFailure(new Error('boom'), { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE });
  assert.equal(tagged.code, ERR_ELEVATOR_USAGE_FAILED);
  assert.equal(tagged.message, ERR_ELEVATOR_USAGE_FAILED_MESSAGE);
  assert.notEqual(tagged.message, ERR_ELEVATOR_OP_FAILED_MESSAGE);
});

test('tagElevatorOpFailure: 引数省略時は既定（設置）の識別コード・文言を付ける', () => {
  const tagged = tagElevatorOpFailure(new Error('boom'));
  assert.equal(tagged.code, ERR_ELEVATOR_OP_FAILED);
  assert.equal(tagged.message, ERR_ELEVATOR_OP_FAILED_MESSAGE);
});

test('tagElevatorOpFailure: 既に文字列codeを持つ既知エラーは同じインスタンスのまま上書きしない（二重ラップしない）', () => {
  const err = Object.assign(new Error(ERR_ELEVATOR_REMOVE_FAILED_MESSAGE), { code: ERR_ELEVATOR_REMOVE_FAILED });
  const tagged = tagElevatorOpFailure(err, { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE });
  assert.equal(tagged, err, '既に文字列codeを持つ既知エラーは包まずそのまま返すはず');
  assert.equal(tagged.code, ERR_ELEVATOR_REMOVE_FAILED, '呼び出し側が渡したcodeで上書きしないはず');
});
