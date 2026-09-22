import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_MATERIAL_CODE_ALIASES, REMOVED_MATERIALS, normalizeMaterialCode } from './legacyMaterialCodes.js';

test('ステップ1時点では表は空（振り直しはステップ3）', () => {
  assert.deepEqual(LEGACY_MATERIAL_CODE_ALIASES, {});
  assert.deepEqual(REMOVED_MATERIALS, []);
  assert.ok(Object.isFrozen(LEGACY_MATERIAL_CODE_ALIASES));
  assert.ok(Object.isFrozen(REMOVED_MATERIALS));
});

test('normalizeMaterialCode: 表に無いコードはそのまま返す', () => {
  assert.equal(normalizeMaterialCode('111111111165'), '111111111165');
});

test('normalizeMaterialCode: 文字列でない値はそのまま返す', () => {
  assert.equal(normalizeMaterialCode(null), null);
  assert.equal(normalizeMaterialCode(undefined), undefined);
});
