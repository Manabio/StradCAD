import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalNumpadExpr, applyKeyToNumpadValue, toNumpadKey } from './numpadUtils.js';

test('evalNumpadExpr: 四則演算（×÷含む）を正しく評価する', () => {
  assert.equal(evalNumpadExpr('100+50', { positiveOnly: false }), 150);
  assert.equal(evalNumpadExpr('3×4', { positiveOnly: false }), 12);
  assert.equal(evalNumpadExpr('10÷4', { positiveOnly: false }), 2.5);
});

test('evalNumpadExpr: 空白は演算子まわり・両端のみ許容し、桁の区切りとしては無効文字列（NaN）', () => {
  assert.equal(evalNumpadExpr('100 + 50', { positiveOnly: false }), 150);
  assert.equal(evalNumpadExpr(' 100 ', { positiveOnly: false }), 100);
  assert.ok(Number.isNaN(evalNumpadExpr('100 50', { positiveOnly: false })), '空白区切りの数字列を連結しない');
  assert.ok(Number.isNaN(evalNumpadExpr('1 0 0', { positiveOnly: false })), '空白区切りの数字列を連結しない');
});

test('evalNumpadExpr: 演算子直後の符号付き第2項（"100+-50"等）を評価できる（旧実装からの回帰確認）', () => {
  assert.equal(evalNumpadExpr('100+-50', { positiveOnly: false }), 50);
  assert.equal(evalNumpadExpr('100*-2', { positiveOnly: false }), -200);
  assert.ok(Number.isNaN(evalNumpadExpr('12+', { positiveOnly: false })));
});

test('evalNumpadExpr: 演算子まわりに空白を含む符号付き第2項（"100 - -50"）もデクリメント誤読せず評価できる', () => {
  assert.equal(evalNumpadExpr('100 - -50', { positiveOnly: false }), 150);
});

test('evalNumpadExpr: 指数表記(1e3)・16進(0x10)は意図的に非対応でNaN', () => {
  assert.ok(Number.isNaN(evalNumpadExpr('1e3', { positiveOnly: false })));
  assert.ok(Number.isNaN(evalNumpadExpr('0x10', { positiveOnly: false })));
});

test('evalNumpadExpr: 数字なしの小数点始まり（".5"）も評価できる', () => {
  assert.equal(evalNumpadExpr('.5', { positiveOnly: false }), 0.5);
  assert.equal(evalNumpadExpr('1+.5', { positiveOnly: false }), 1.5);
});

test('evalNumpadExpr: positiveOnly=true（既定）は0以下をNaNにする', () => {
  assert.ok(Number.isNaN(evalNumpadExpr('-100')));
  assert.ok(Number.isNaN(evalNumpadExpr('0')));
  assert.equal(evalNumpadExpr('100'), 100);
});

test('evalNumpadExpr: positiveOnly=falseは負値・0も許容する', () => {
  assert.equal(evalNumpadExpr('-100', { positiveOnly: false }), -100);
  assert.equal(evalNumpadExpr('0', { positiveOnly: false }), 0);
});

// ---- 不正入力（正規表現による事前検証でNaNになる。Function評価前に弾く安全対策） ----
test('evalNumpadExpr: 数式以外の文字列・非数式呼び出しはNaN（副作用が走らない）', () => {
  assert.ok(Number.isNaN(evalNumpadExpr('alert(1)', { positiveOnly: false })));
  assert.ok(Number.isNaN(evalNumpadExpr('(1+2)', { positiveOnly: false })));
});

test('evalNumpadExpr: 末尾演算子・空文字はNaN', () => {
  assert.ok(Number.isNaN(evalNumpadExpr('12+', { positiveOnly: false })));
  assert.ok(Number.isNaN(evalNumpadExpr('', { positiveOnly: false })));
});

test('toNumpadKey: 数字・記号・Backspaceのみ変換し、それ以外はnull', () => {
  assert.equal(toNumpadKey('5'), '5');
  assert.equal(toNumpadKey('.'), '.');
  assert.equal(toNumpadKey('+'), '+');
  assert.equal(toNumpadKey('-'), '-');
  assert.equal(toNumpadKey('*'), '×');
  assert.equal(toNumpadKey('/'), '÷');
  assert.equal(toNumpadKey('Backspace'), '⌫');
  assert.equal(toNumpadKey('Enter'), null);
});

test('applyKeyToNumpadValue: 数字入力は先頭の"0"を置き換える', () => {
  assert.equal(applyKeyToNumpadValue('0', '5'), '5');
  assert.equal(applyKeyToNumpadValue('', '5'), '5');
  assert.equal(applyKeyToNumpadValue('12', '3'), '123');
});

test('applyKeyToNumpadValue: 末尾演算子への演算子連打は無視される（値不変を返す）', () => {
  assert.equal(applyKeyToNumpadValue('12+', '-'), '12+');
  assert.equal(applyKeyToNumpadValue('12+', '×'), '12+');
});

test('applyKeyToNumpadValue: Backspaceは末尾1文字を削除し、1文字なら空文字にする', () => {
  assert.equal(applyKeyToNumpadValue('123', '⌫'), '12');
  assert.equal(applyKeyToNumpadValue('1', '⌫'), '');
});

test('applyKeyToNumpadValue: minusReplacesZero=trueは"0"/""への"-"を"-"に置換する（CLMoveInput物理キーボード経路）', () => {
  assert.equal(applyKeyToNumpadValue('0', '-', { minusReplacesZero: true }), '-');
  assert.equal(applyKeyToNumpadValue('', '-', { minusReplacesZero: true }), '-');
  assert.equal(applyKeyToNumpadValue('12', '-', { minusReplacesZero: true }), '12-');
});

test('applyKeyToNumpadValue: オプション省略時（既定）は"0"への"-"を数字と同様に連結する（従来挙動）', () => {
  assert.equal(applyKeyToNumpadValue('0', '-'), '0-');
});
