import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSkipZero, subtractSkipZero, makeFloorName, renameFloor, makeFloorLevelPrefix, isGroundFloorEquivalent } from './floorNumber.js';

// ---- isGroundFloorEquivalent ----
const fl = (id, startFloor, elevation, extra = {}) => ({ id, startFloor, elevation, ...extra });

test('isGroundFloorEquivalent: 階番号 1 の階があればそれだけが真（地下・2階は偽）', () => {
  const planes = [fl('b1', -1, -2700), fl('f1', 1, 0), fl('f2', 2, 2700)];
  assert.equal(isGroundFloorEquivalent(planes[1], planes), true);
  assert.equal(isGroundFloorEquivalent(planes[0], planes), false);
  assert.equal(isGroundFloorEquivalent(planes[2], planes), false);
});

test('isGroundFloorEquivalent: 階番号 1 が無ければ GL 以上（elevation ≥ 0）で最も低い階。地下は対象外', () => {
  const planes = [fl('b2', -2, -5400), fl('b1', -1, -2700), fl('f2', 2, 0), fl('f3', 3, 2700)];
  assert.equal(isGroundFloorEquivalent(planes[2], planes), true, 'elevation 0 の 2 階');
  assert.equal(isGroundFloorEquivalent(planes[3], planes), false);
  assert.equal(isGroundFloorEquivalent(planes[1], planes), false);
  const raised = [fl('b1', -1, -2700), fl('f2', 2, 1200), fl('f3', 3, 3900)];
  assert.equal(isGroundFloorEquivalent(raised[1], raised), true, 'GL 以上で最下＝elevation 1200 の階');
});

test('【失敗系】isGroundFloorEquivalent: 地下だけ・屋根専用平面・plane/planes なしは偽。検討案は参照元の採用階で判定', () => {
  const basementOnly = [fl('b2', -2, -5400), fl('b1', -1, -2700)];
  assert.equal(isGroundFloorEquivalent(basementOnly[1], basementOnly), false);
  const planes = [fl('f1', 1, 0), fl('f2', 2, 2700)];
  assert.equal(isGroundFloorEquivalent(fl('roof', 1, 0, { isRoofPlane: true }), planes), false);
  assert.equal(isGroundFloorEquivalent(null, planes), false);
  assert.equal(isGroundFloorEquivalent(planes[0], []), false);
  assert.equal(isGroundFloorEquivalent(planes[0], undefined), false);
  assert.equal(isGroundFloorEquivalent(fl('alt1', 1, 0, { isAlternative: true, referenceId: 'f1' }), planes), true);
  assert.equal(isGroundFloorEquivalent(fl('alt2', 2, 2700, { isAlternative: true, referenceId: 'f2' }), planes), false);
  assert.equal(isGroundFloorEquivalent(fl('alt3', 1, 0, { isAlternative: true, referenceId: 'gone' }), planes), false);
});

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
