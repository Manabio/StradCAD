import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSkipZero, subtractSkipZero, makeFloorName, renameFloor, makeFloorLevelPrefix } from './floorNumber.js';

// ---- addSkipZero / subtractSkipZero ----
test('addSkipZero: 0をまたぐ加算は0を飛ばす（上方向）', () => {
  assert.equal(addSkipZero(-1, 1), 1);
});

test('addSkipZero: 0をまたぐ加算は0を飛ばす（下方向）', () => {
  assert.equal(addSkipZero(1, -1), -1);
});

test('subtractSkipZero: 0をまたぐ減算は0を飛ばす', () => {
  assert.equal(subtractSkipZero(1, 1), -1);
  assert.equal(subtractSkipZero(-1, -1), 1);
});

// ---- makeFloorName ----
test('makeFloorName: stories=1は地上/地下で書式が変わる', () => {
  assert.equal(makeFloorName(3, 1), '3階');
  assert.equal(makeFloorName(-2, 1), '地下2階');
});

test('makeFloorName: stories>1（整数）は一般階', () => {
  assert.equal(makeFloorName(4, 3), '一般階');
});

// ---- makeFloorLevelPrefix ----
test('makeFloorLevelPrefix: 地上/地下でプレフィックスが変わる', () => {
  assert.equal(makeFloorLevelPrefix(2), '2');
  assert.equal(makeFloorLevelPrefix(-1), 'B1');
});

// ---- renameFloor（既存の書式維持。QA指摘の符号またぎ修正の回帰防止）----
test('renameFloor: 地上の一般書式は数字だけ差し替える（書式維持）', () => {
  assert.equal(renameFloor('2階:事務所', 3), '3階:事務所');
});

test('renameFloor: 地下の一般書式は数字だけ差し替える（書式維持）', () => {
  assert.equal(renameFloor('地下2階', -1), '地下1階');
});

test('renameFloor: B表記は数字だけ差し替える（書式維持）', () => {
  assert.equal(renameFloor('B2', -1), 'B1');
});

test('renameFloor: M表記は数字だけ差し替える（書式維持）', () => {
  assert.equal(renameFloor('M2', 3), 'M3');
});

// ---- renameFloor: 符号またぎ（QA指摘。地下↔地上をまたぐ振り直しで名前が追従しない不良の修正）----
test('renameFloor: 地下→地上（"地下1階"→newStartFloor=1）は"1階"になる（部分一致"\\d+階"に先を越されない）', () => {
  assert.equal(renameFloor('地下1階', 1), '1階');
});

test('renameFloor: 地下→地上のB表記（"B1 駐車場"→newStartFloor=1）は"1 駐車場"になる', () => {
  assert.equal(renameFloor('B1 駐車場', 1), '1 駐車場');
});

test('renameFloor: 地上→地下（"1階"→newStartFloor=-1）は"地下1階"になる', () => {
  assert.equal(renameFloor('1階', -1), '地下1階');
});

test('renameFloor: 地上→地下でも接尾辞を保つ（"1階:事務所"→newStartFloor=-1）は"地下1階:事務所"になる', () => {
  assert.equal(renameFloor('1階:事務所', -1), '地下1階:事務所');
});

// ---- renameFloor: 失敗系（数字が無い名前）----
test('【失敗系】renameFloor: 数字を含まない名前はmakeFloorName(n,1)を先頭に付ける', () => {
  assert.equal(renameFloor('屋根', 2), '2階:屋根');
});
