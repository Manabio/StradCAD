// 屋根区画（snapshot.roofZones[].spec）の材料コード照合。mainRoofSpec（codeNormalization.test.js 【B3】）と同型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeTable, normalizeSnapshotCodes, enumerateMaterialCodeRefs,
  clearDocumentAliases, addDocumentAliases, applyDocumentCodeNormalization, takeUnresolvedCodes,
} from './codeNormalization.js';
import { CatalogKind } from './catalogKinds.js';
import { ROOF_ZONE_SPEC_LOCATION } from '../core/constants.js';

const zone = (id, spec) => ({ id, cells: ['a:b:c:d'], spec });
const LOC = r => r.location === ROOF_ZONE_SPEC_LOCATION;

test('location の値は "roofZoneSpec"', () => {
  assert.equal(ROOF_ZONE_SPEC_LOCATION, 'roofZoneSpec');
});

test('enumerateMaterialCodeRefs: 区画の spec の材料コードを location=roofZoneSpec・zoneId・key 付きで列挙する', () => {
  const refs = enumerateMaterialCodeRefs({
    roofZones: [
      zone('z1', { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009', soffitMaterial: 'S1', soffitBacking: '' }),
      zone('z2', { sheathingMaterial: '301000000024' }),
    ],
  }).filter(LOC);
  assert.deepEqual(refs.map(r => [r.zoneId, r.key, r.code]).sort(), [
    ['z1', 'sheathingMaterial', '301000000023'],
    ['z1', 'soffitMaterial', 'S1'],
    ['z1', 'underlaymentMaterial', '302000000009'],
    ['z2', 'sheathingMaterial', '301000000024'],
  ]);
  assert.ok(refs.every(r => !('roomId' in r)));
});

test('【失敗系】enumerateMaterialCodeRefs: 区画なし・キー無し・spec 無し・空/非文字列のコードは列挙に出ない', () => {
  assert.equal(enumerateMaterialCodeRefs({ roofZones: [] }).filter(LOC).length, 0);
  assert.equal(enumerateMaterialCodeRefs({}).filter(LOC).length, 0);
  assert.equal(enumerateMaterialCodeRefs({ roofZones: [zone('z', null), zone('y', { sheathingMaterial: '', underlaymentMaterial: 3 })] }).filter(LOC).length, 0);
});

test('normalizeSnapshotCodes: 読み替え表が区画の spec にも効く（他の項目は不変・変化なしなら同一参照・元は破壊しない）', () => {
  const spec = { slope: 4, sheathingMaterial: '111111111150', underlaymentMaterial: '302000000003', note: 'メモ' };
  const snap = { roofZones: [zone('z1', spec)] };
  const table = buildCodeTable({ legacy: { '111111111150': '101200000008' } });
  const { snapshot, unresolved } = normalizeSnapshotCodes(snap, table);
  assert.equal(snapshot.roofZones[0].spec.sheathingMaterial, '101200000008');
  assert.equal(snapshot.roofZones[0].spec.underlaymentMaterial, '302000000003');
  assert.equal(snapshot.roofZones[0].spec.note, 'メモ');
  assert.equal(snapshot.roofZones[0].id, 'z1');
  assert.deepEqual(unresolved, []);
  assert.equal(spec.sheathingMaterial, '111111111150', '元の snapshot は破壊されない');

  const unchanged = { roofZones: [zone('z1', { sheathingMaterial: '301000000023' })] };
  assert.equal(normalizeSnapshotCodes(unchanged, buildCodeTable({ legacy: { '999999999999': '101200000008' } })).snapshot, unchanged);
});

test('【失敗系】normalizeSnapshotCodes: roofZones のキーが無い snapshot へはキーを足さない。廃止（null）コードは据え置き＋zoneId 付きで unresolved', () => {
  const table = buildCodeTable({ legacy: { '301000000023': '301000000024', '302000000009': null } });
  const noKey = { exteriorWallBacking: '301000000023' };
  assert.equal('roofZones' in normalizeSnapshotCodes(noKey, table).snapshot, false);

  const { snapshot, unresolved } = normalizeSnapshotCodes(
    { roofZones: [zone('z7', { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009' })] }, table);
  assert.equal(snapshot.roofZones[0].spec.sheathingMaterial, '301000000024');
  assert.equal(snapshot.roofZones[0].spec.underlaymentMaterial, '302000000009', '値は据え置き');
  assert.deepEqual(unresolved.filter(LOC), [
    { code: '302000000009', location: ROOF_ZONE_SPEC_LOCATION, zoneId: 'z7', key: 'underlaymentMaterial' },
  ]);
});

test('applyDocumentCodeNormalization: 文書の読み替えが区画に効き、未解決は location=roofZoneSpec・zoneId で蓄積に積まれる', () => {
  clearDocumentAliases();
  takeUnresolvedCodes();
  addDocumentAliases(CatalogKind.MATERIAL, [{ from: '301000000023', to: '301000000024' }, { from: '302000000009', to: null }]);
  const applied = applyDocumentCodeNormalization(
    { roofZones: [zone('z1', { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009' })] });
  assert.equal(applied.roofZones[0].spec.sheathingMaterial, '301000000024');
  const unresolved = takeUnresolvedCodes().filter(LOC);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].zoneId, 'z1');
  assert.equal(unresolved[0].code, '302000000009');
  assert.equal(unresolved[0].kind, CatalogKind.MATERIAL);
  clearDocumentAliases();
});
