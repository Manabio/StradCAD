// S造スラブ仕様のプレート材料コード参照（slabs[].extra の 'steelSpec.*'・structuralInfo.steelSlabKeys/Vals）が
// 材コード走査器（enumerateMaterialCodeRefs／normalizeSnapshotCodes）に載ること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateMaterialCodeRefs, normalizeSnapshotCodes, applyDocumentCodeNormalization,
  setDocumentAliases, clearDocumentAliases, takeUnresolvedCodes,
} from './codeNormalization.js';
import { collectUsedMaterialCodes } from './usedEntries.js';
import { CatalogKind } from './catalogKinds.js';
import { STEEL_SLAB_PLATE_CODE_KEYS } from '../structural/steelSlabSpec.js';

const OLD_ALC = '990000000001';
const OLD_DECK = '990000000002';
const OLD_FLAT = '990000000003';
const NEW_ALC = '301200000009';
const NEW_DECK = '201600000002';
const NEW_FLAT = '201700000002';

function snapshot() {
  return {
    slabs: [
      { id: 's1', extraKeys: ['steelSpec.kind', 'steelSpec.alcCode', 'slabKind'], extraVals: ['alc', OLD_ALC, OLD_ALC] },
      { id: 's2', extraKeys: [], extraVals: [] },
    ],
    structuralInfo: {
      steelSlabKeys: ['kind', 'deckPlateCode', 'flatDeckPlateCode'],
      steelSlabVals: ['deck', OLD_DECK, OLD_FLAT],
    },
  };
}

test('直書きの項目名は steelSlabSpec.js のプレート材料コード項目と一致する', () => {
  assert.deepEqual([...STEEL_SLAB_PLATE_CODE_KEYS].sort(), ['alcCode', 'deckPlateCode', 'flatDeckPlateCode']);
});

test('enumerateMaterialCodeRefs: スラブの個別仕様と共通仕様のプレートコードを列挙する（kind・無関係なキーは対象外）', () => {
  const refs = enumerateMaterialCodeRefs(snapshot());
  assert.deepEqual(refs.map(r => r.code).sort(), [OLD_ALC, OLD_DECK, OLD_FLAT].sort());
  assert.equal(refs.find(r => r.code === OLD_ALC).location, 'slabSteelSpec');
  assert.equal(refs.find(r => r.code === OLD_DECK).location, 'steelSlabCommon');
});

test('collectUsedMaterialCodes（使用中コード＝同梱の対象）に両系統の3コードが現れる', () => {
  assert.deepEqual([...collectUsedMaterialCodes(snapshot())].sort(), [OLD_ALC, OLD_DECK, OLD_FLAT].sort());
});

test('applyDocumentCodeNormalization: 旧→新の読み替えが steelSpec と共通仕様の両方に効く（元の snapshot は非破壊）', () => {
  setDocumentAliases(CatalogKind.MATERIAL, { [OLD_ALC]: NEW_ALC, [OLD_DECK]: NEW_DECK, [OLD_FLAT]: NEW_FLAT });
  try {
    const src = snapshot();
    const out = applyDocumentCodeNormalization(src);
    assert.equal(out.slabs[0].extraVals[1], NEW_ALC, 'スラブの steelSpec.alcCode');
    assert.equal(out.slabs[0].extraVals[2], OLD_ALC, '別キー（slabKind）の値は触らない');
    assert.deepEqual(out.structuralInfo.steelSlabVals, ['deck', NEW_DECK, NEW_FLAT]);
    assert.equal(out.slabs[1], src.slabs[1], '変化の無いスラブは同一参照');
    assert.equal(src.slabs[0].extraVals[1], OLD_ALC, '非破壊');
    assert.deepEqual(src.structuralInfo.steelSlabVals, ['deck', OLD_DECK, OLD_FLAT]);
  } finally {
    clearDocumentAliases(CatalogKind.MATERIAL);
  }
});

test('【失敗系】読み替え先が null（廃止）のコードは据え置き、unresolved に積む。キーの無い snapshot は同一参照', () => {
  takeUnresolvedCodes();
  const table = new Map([[OLD_ALC, null], [OLD_DECK, NEW_DECK]]);
  const { snapshot: out, unresolved } = normalizeSnapshotCodes(snapshot(), table);
  assert.equal(out.slabs[0].extraVals[1], OLD_ALC, '据え置き');
  assert.equal(out.structuralInfo.steelSlabVals[1], NEW_DECK);
  assert.deepEqual(unresolved.map(u => [u.code, u.location]), [[OLD_ALC, 'slabSteelSpec']]);

  const bare = { rooms: [] };
  assert.equal(normalizeSnapshotCodes(bare, table).snapshot, bare);
  assert.deepEqual(enumerateMaterialCodeRefs({ slabs: [{ id: 'x' }], structuralInfo: {} }), []);
});
