import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMaterialCode, parseMaterialCode, formatMaterialCode, nextSerial, isLegacyCode } from './materialCode.js';

test('isMaterialCode: 12桁数字文字列のみtrue', () => {
  assert.equal(isMaterialCode('111111111165'), true);
  assert.equal(isMaterialCode('11111111116'), false); // 11桁
  assert.equal(isMaterialCode('1111111111655'), false); // 13桁
  assert.equal(isMaterialCode('11111111116a'), false); // 数字以外
  assert.equal(isMaterialCode(111111111165), false); // 数値型は対象外
  assert.equal(isMaterialCode(null), false);
  assert.equal(isMaterialCode(undefined), false);
});

test('parseMaterialCode→formatMaterialCode: ラウンドトリップする', () => {
  const parsed = parseMaterialCode('102000000037');
  assert.deepEqual(parsed, { major: 10, minor: 20, serial: 37 });
  assert.equal(formatMaterialCode(parsed.major, parsed.minor, parsed.serial), '102000000037');
});

test('【失敗系】parseMaterialCode: 不正なコードはnull', () => {
  assert.equal(parseMaterialCode('abc'), null);
  assert.equal(parseMaterialCode(''), null);
});

test('formatMaterialCode: 各桁をゼロ詰めする', () => {
  assert.equal(formatMaterialCode(1, 2, 3), '010200000003');
});

// ---- 空き番の自動採番（builtin・ライブラリ・同梱のどれとも重ならない）----
test('nextSerial: 使用中コードの帯の中で最小の空き番を返す', () => {
  const used = ['102000000001', '102000000002', '102000000004']; // 3番が空き
  assert.equal(nextSerial(10, 20, used), '00000003');
});

test('nextSerial: 他の大分類・中分類の帯は無視する', () => {
  const used = ['101000000001', '103000000001', '202000000001']; // 全て10-20帯とは別
  assert.equal(nextSerial(10, 20, used), '00000001');
});

test('nextSerial: builtin・ユーザーライブラリ・同梱を合成したusedCodesのどれとも重ならない', () => {
  const builtin = ['102000000001'];
  const user = ['102000000002'];
  const doc = ['102000000003'];
  assert.equal(nextSerial(10, 20, [...builtin, ...user, ...doc]), '00000004');
});

test('nextSerial: 使用が無ければ00000001', () => {
  assert.equal(nextSerial(10, 20, []), '00000001');
  assert.equal(nextSerial(10, 20, undefined), '00000001');
});

test('isLegacyCode: 先頭4桁が1111なら旧体系', () => {
  assert.equal(isLegacyCode('111111111165'), true);
  assert.equal(isLegacyCode('102000000001'), false);
  assert.equal(isLegacyCode('abc'), false);
});
