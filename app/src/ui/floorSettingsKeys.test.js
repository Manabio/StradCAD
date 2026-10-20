// 階設定表ダイアログのキー操作の判断（floorSettingsKeys.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapFocusIndex, shouldConfirmOnEnter, resolvePadText } from './floorSettingsKeys.js';

test('trapFocusIndex: Tab は次へ、末尾の次は先頭へ循環する', () => {
  assert.equal(trapFocusIndex(5, 0, false), 1);
  assert.equal(trapFocusIndex(5, 3, false), 4);
  assert.equal(trapFocusIndex(5, 4, false), 0);
});

test('trapFocusIndex: Shift+Tab は前へ、先頭の前は末尾へ循環する', () => {
  assert.equal(trapFocusIndex(5, 3, true), 2);
  assert.equal(trapFocusIndex(5, 0, true), 4);
});

test('【失敗系】trapFocusIndex: ダイアログ外（-1・範囲外）からは先頭（Shift なら末尾）へ呼び戻す。要素が無ければ -1', () => {
  assert.equal(trapFocusIndex(5, -1, false), 0);
  assert.equal(trapFocusIndex(5, -1, true), 4);
  assert.equal(trapFocusIndex(5, 9, false), 0);
  assert.equal(trapFocusIndex(0, -1, false), -1);
  assert.equal(trapFocusIndex(1, 0, false), 0);
});

test('shouldConfirmOnEnter: 入力欄上の Enter は確定する', () => {
  assert.equal(shouldConfirmOnEnter({ key: 'Enter', tagName: 'INPUT' }), true);
});

test('【失敗系】shouldConfirmOnEnter: ボタン上の Enter（キャンセルを含む）は確定しない。Enter 以外も確定しない', () => {
  assert.equal(shouldConfirmOnEnter({ key: 'Enter', tagName: 'BUTTON' }), false);
  assert.equal(shouldConfirmOnEnter({ key: 'a', tagName: 'INPUT' }), false);
  assert.equal(shouldConfirmOnEnter({ key: 'Escape', tagName: 'INPUT' }), false);
});

test('【失敗系】shouldConfirmOnEnter: IME の変換確定の Enter（isComposing・keyCode 229）は確定しない', () => {
  assert.equal(shouldConfirmOnEnter({ key: 'Enter', tagName: 'INPUT', isComposing: true }), false);
  assert.equal(shouldConfirmOnEnter({ key: 'Enter', tagName: 'INPUT', keyCode: 229 }), false);
  assert.equal(shouldConfirmOnEnter({ key: 'Enter', tagName: 'INPUT', isComposing: false, keyCode: 13 }), true);
});

test('resolvePadText: 式が整数に評価できれば置き換える（NumPad の × ÷ は * / で入る）', () => {
  assert.equal(resolvePadText('3000*2'), '6000');
  assert.equal(resolvePadText('3000+100'), '3100');
  assert.equal(resolvePadText('6000/2'), '3000');
});

test('resolvePadText: 非整数・評価不能・整数だけの文字列はそのまま（丸めない。判定は欄の検査＝赤表示）', () => {
  assert.equal(resolvePadText('3000/7'), '3000/7');
  assert.equal(resolvePadText('-300'), '-300');
  assert.equal(resolvePadText('3000+'), '3000+');
  assert.equal(resolvePadText(''), '');
  assert.equal(resolvePadText('abc'), 'abc');
});
