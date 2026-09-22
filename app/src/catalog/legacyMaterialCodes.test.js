import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_MATERIAL_CODE_ALIASES, REMOVED_MATERIALS, normalizeMaterialCode } from './legacyMaterialCodes.js';
import { classOf } from './catalogKinds.js';
import { isLegacyCode } from './materialCode.js';
import { MATERIALS } from '../finish/materials/materialData.js';

test('LEGACY_MATERIAL_CODE_ALIASES: 旧132件すべてに対応（新コードまたはnull）。凍結されている', () => {
  const entries = Object.entries(LEGACY_MATERIAL_CODE_ALIASES);
  assert.equal(entries.length, 132);
  assert.ok(Object.isFrozen(LEGACY_MATERIAL_CODE_ALIASES));
  for (const [oldCode, newCode] of entries) {
    assert.match(oldCode, /^1111\d{8}$/, `旧コードの形式が不正: ${oldCode}`);
    assert.ok(newCode === null || /^\d{12}$/.test(newCode), `新コードの形式が不正: ${oldCode} -> ${newCode}`);
  }
});

test('LEGACY_MATERIAL_CODE_ALIASES: 新コードに重複が無い', () => {
  const newCodes = Object.values(LEGACY_MATERIAL_CODE_ALIASES).filter(v => v !== null);
  assert.equal(newCodes.length, 130);
  assert.equal(new Set(newCodes).size, newCodes.length);
});

test('LEGACY_MATERIAL_CODE_ALIASES: 新コードの分類（上4桁）がMATERIAL_CLASSESに存在する', () => {
  for (const [oldCode, newCode] of Object.entries(LEGACY_MATERIAL_CODE_ALIASES)) {
    if (newCode === null) continue;
    const major = Number(newCode.slice(0, 2));
    const minor = Number(newCode.slice(2, 4));
    assert.ok(classOf(major, minor) != null, `${oldCode} -> ${newCode} の分類が未登録`);
  }
});

test('LEGACY_MATERIAL_CODE_ALIASES: 新コード全件がmaterialData.jsのMATERIALSに存在する（null除く）', () => {
  const materialCodes = new Set(MATERIALS.map(m => m.code));
  for (const [oldCode, newCode] of Object.entries(LEGACY_MATERIAL_CODE_ALIASES)) {
    if (newCode === null) continue;
    assert.ok(materialCodes.has(newCode), `${oldCode} -> ${newCode} がMATERIALSに存在しない`);
  }
});

// 【コーディネーターへの報告事項】対応表(code-remap.md)は「廃止・削除2件→null」（新コード無し）と
// 明記し、REMOVED_MATERIALSの記録形にも新コード欄が無い＝2件は本体カタログから除外される設計と
// 判断した。旧MATERIALS件数132から2件を除いた130件を固定する（132のままという別の記述との食い違いは
// 報告書で明示する）。
test('MATERIALS: 全件が新体系（isLegacyCodeがfalse）。130件（132−廃止・削除2件）', () => {
  assert.equal(MATERIALS.length, 130);
  for (const m of MATERIALS) assert.equal(isLegacyCode(m.code), false, `${m.code}(${m.name})が旧体系のまま`);
});

test('REMOVED_MATERIALS: 廃止・削除の2件（reasonつき）', () => {
  assert.equal(REMOVED_MATERIALS.length, 2);
  assert.ok(Object.isFrozen(REMOVED_MATERIALS));
  assert.deepEqual(REMOVED_MATERIALS.map(m => m.code).sort(), ['111111111211', '111111111212']);
  const byCode = Object.fromEntries(REMOVED_MATERIALS.map(m => [m.code, m]));
  assert.equal(byCode['111111111211'].reason, '廃止');
  assert.equal(byCode['111111111212'].reason, '削除');
  for (const m of REMOVED_MATERIALS) assert.ok(Object.isFrozen(m));
});

test('normalizeMaterialCode: 旧コードは新コードへ、null対応の旧コードはnullを返す', () => {
  assert.equal(normalizeMaterialCode('111111111165'), '301000000001'); // せっこうボード t=9.5
  assert.equal(normalizeMaterialCode('111111111211'), null); // 廃止
});

test('normalizeMaterialCode: 表に無いコード（新体系・未知）はそのまま返す', () => {
  assert.equal(normalizeMaterialCode('301000000001'), '301000000001');
  assert.equal(normalizeMaterialCode('999999999999'), '999999999999');
});

test('【失敗系】normalizeMaterialCode: 文字列でない値はそのまま返す', () => {
  assert.equal(normalizeMaterialCode(null), null);
  assert.equal(normalizeMaterialCode(undefined), undefined);
});
