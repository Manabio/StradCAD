import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBundle, validateBundle, bundleEntries, withEntries, bundleAliases, withAlias,
  resolveCatalog, resolveOrigins, detectLibraryConflicts,
} from './catalogBundle.js';

function material(overrides) {
  return {
    code: '111111111165', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

test('emptyBundle: version1・空のcatalogs/encodings/aliases', () => {
  assert.deepEqual(emptyBundle(), { version: 1, catalogs: {}, encodings: {}, aliases: {} });
});

test('validateBundle: 正常な束は例外を投げない', () => {
  const bundle = withEntries(emptyBundle(), 'material', [material()]);
  assert.equal(validateBundle(bundle), true);
});

test('validateBundle: 未知の種別は検証をスキップして保持する', () => {
  const bundle = withEntries(emptyBundle(), '将来の種別', [{ 何でも: true }]);
  assert.equal(validateBundle(bundle), true);
});

test('【失敗系】validateBundle: versionが1でなければ例外', () => {
  assert.throws(() => validateBundle({ ...emptyBundle(), version: 2 }), /未対応のカタログ束バージョン/);
});

test('【失敗系】validateBundle: catalogsが配列でなければ例外', () => {
  const bundle = { ...emptyBundle(), catalogs: { material: 'not-array' } };
  assert.throws(() => validateBundle(bundle), /配列である必要/);
});

test('【失敗系】validateBundle: 型違い（エントリ内部）は例外', () => {
  const bundle = withEntries(emptyBundle(), 'material', [material({ x: '10' })]);
  assert.throws(() => validateBundle(bundle), /xが不正/);
});

test('【失敗系】validateBundle: 必須欠落は例外', () => {
  const bundle = withEntries(emptyBundle(), 'material', [{ code: '111111111165' }]);
  assert.throws(() => validateBundle(bundle), /必須項目が欠落/);
});

test('【失敗系】validateBundle: キー重複は例外', () => {
  const bundle = withEntries(emptyBundle(), 'material', [material(), material({ name: '別の名前' })]);
  assert.throws(() => validateBundle(bundle), /キーが重複/);
});

test('【失敗系】validateBundle: dedupeFields重複（R17・category違いも不可）は例外', () => {
  const a = material({ code: '111111111165', category: 'panel' });
  const b = material({ code: '111111111166', category: 'backing' }); // 5項目同一・categoryだけ違う
  const bundle = withEntries(emptyBundle(), 'material', [a, b]);
  assert.throws(() => validateBundle(bundle), /内容が重複/);
});

test('【失敗系】validateBundle: aliasesの値が文字列/null以外なら例外', () => {
  const bundle = { ...emptyBundle(), aliases: { material: { a: 123 } } };
  assert.throws(() => validateBundle(bundle), /aliases\.material\.a/);
});

test('bundleEntries/withEntries: 非破壊（元の束は変わらない）', () => {
  const base = emptyBundle();
  const next = withEntries(base, 'material', [material()]);
  assert.deepEqual(bundleEntries(base, 'material'), []);
  assert.equal(bundleEntries(next, 'material').length, 1);
});

test('bundleAliases/withAlias: 非破壊で1件追記できる', () => {
  const base = emptyBundle();
  const next = withAlias(base, 'material', '999999999999', '111111111165');
  assert.deepEqual(bundleAliases(base, 'material'), {});
  assert.deepEqual(bundleAliases(next, 'material'), { '999999999999': '111111111165' });
});

// ---- 解決順（doc>user>builtin）と同一性 ----
test('resolveCatalog: doc > user > builtin の順に勝ち、エントリをコピーしない（===同一性）', () => {
  const builtinEntry = material({ note: 'builtin' });
  const userEntry = material({ note: 'user' });
  const docEntry = material({ note: 'doc' });
  const map = resolveCatalog('material', { doc: [docEntry], user: [userEntry], builtin: [builtinEntry] });
  assert.equal(map.get(docEntry.code), docEntry); // === 同一性
  assert.notEqual(map.get(docEntry.code), userEntry);
});

test('resolveCatalog: docが無ければuserが勝ち、userも無ければbuiltinが残る', () => {
  const builtinEntry = material({ note: 'builtin' });
  const userEntry = material({ note: 'user' });
  const mapUserWins = resolveCatalog('material', { user: [userEntry], builtin: [builtinEntry] });
  assert.equal(mapUserWins.get(builtinEntry.code), userEntry);
  const mapBuiltinOnly = resolveCatalog('material', { builtin: [builtinEntry] });
  assert.equal(mapBuiltinOnly.get(builtinEntry.code), builtinEntry);
});

test('resolveOrigins: resolveCatalogと同じ優先順で出所を返す', () => {
  const builtinEntry = material();
  const docEntry = material({ note: 'doc' });
  const origins = resolveOrigins('material', { doc: [docEntry], builtin: [builtinEntry] });
  assert.equal(origins.get(builtinEntry.code), 'doc');
});

test('resolveOrigins: userはbuiltinに優先する（Minor指摘）', () => {
  const builtinEntry = material();
  const userEntry = material({ note: 'user' });
  const origins = resolveOrigins('material', { user: [userEntry], builtin: [builtinEntry] });
  assert.equal(origins.get(builtinEntry.code), 'user');
});

// ---- QA指摘B1: openingSubTypeの複合キー（category:key）----
function openingSubType(overrides) {
  return {
    category: 'fitting', key: 'doubleSliding', label: '引き違い戸', mechanism: 'slideDouble',
    wallKinds: ['interior', 'exterior'], defaultWidth: 1600, defaultHeight: 2000,
    ...overrides,
  };
}

test('validateBundle: openingSubTypeはcategoryが違えば同じkeyでもキー重複にならない（B1）', () => {
  const fitting = openingSubType({ category: 'fitting', key: 'doubleSliding' });
  const window_ = { category: 'window', key: 'doubleSliding', label: '引き違い窓', mechanism: 'slideDouble', defaultWidth: 1690, defaultHeight: 1170 };
  const bundle = withEntries(emptyBundle(), 'openingSubType', [fitting, window_]);
  assert.equal(validateBundle(bundle), true);
});

test('resolveCatalog: openingSubTypeはcategoryが違えば同じkeyでも両方残る（B1・旧keyField方式なら44件に潰れていたはず）', () => {
  const fitting = openingSubType({ category: 'fitting', key: 'doubleSliding' });
  const window_ = openingSubType({ category: 'window', key: 'doubleSliding', label: '引き違い窓' });
  const map = resolveCatalog('openingSubType', { builtin: [fitting, window_] });
  assert.equal(map.size, 2);
  assert.equal(map.get('fitting:doubleSliding'), fitting);
  assert.equal(map.get('window:doubleSliding'), window_);
});

// ---- ライブラリ衝突検出（4.4・印の有無）----
test('detectLibraryConflicts: overridesBuiltinの印が無いuserエントリとbuiltinの内容不一致を検出する', () => {
  const builtinEntry = material();
  const userEntry = material({ note: '内容が違う' });
  const conflicts = detectLibraryConflicts('material', { user: [userEntry], builtin: [builtinEntry] });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, builtinEntry.code);
  assert.deepEqual(conflicts[0].diffFields, ['note']);
});

test('detectLibraryConflicts: 印(overridesBuiltin)があれば衝突にしない', () => {
  const builtinEntry = material();
  const userEntry = material({ note: '内容が違う', overridesBuiltin: true });
  const conflicts = detectLibraryConflicts('material', { user: [userEntry], builtin: [builtinEntry] });
  assert.equal(conflicts.length, 0);
});

test('detectLibraryConflicts: 内容が完全一致なら衝突にしない', () => {
  const builtinEntry = material();
  const userEntry = material();
  const conflicts = detectLibraryConflicts('material', { user: [userEntry], builtin: [builtinEntry] });
  assert.equal(conflicts.length, 0);
});
