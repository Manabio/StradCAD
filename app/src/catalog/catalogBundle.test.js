import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBundle, validateBundle, bundleEntries, withEntries, bundleAliases, withAlias,
  resolveCatalog, resolveOrigins, detectLibraryConflicts, mergeBundles, splitBundleByKind,
  migrateBundle, formatMigrationNotice,
} from './catalogBundle.js';
import { CatalogKind } from './catalogKinds.js';

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
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
  const bundle = withEntries(emptyBundle(), 'material', [{ code: '301000000001' }]);
  assert.throws(() => validateBundle(bundle), /必須項目が欠落/);
});

test('【失敗系】validateBundle: キー重複は例外', () => {
  const bundle = withEntries(emptyBundle(), 'material', [material(), material({ name: '別の名前' })]);
  assert.throws(() => validateBundle(bundle), /キーが重複/);
});

test('【失敗系】validateBundle: dedupeFields重複（重複禁止・category違いも不可）は例外', () => {
  const a = material({ code: '301000000001', category: 'panel' });
  const b = material({ code: '301000000002', category: 'backing' }); // 5項目同一・categoryだけ違う
  const bundle = withEntries(emptyBundle(), 'material', [a, b]);
  assert.throws(() => validateBundle(bundle), /内容が重複/);
});

test('【失敗系】validateBundle: aliasesの値が文字列/null以外なら例外', () => {
  const bundle = { ...emptyBundle(), aliases: { material: { a: 123 } } };
  assert.throws(() => validateBundle(bundle), /aliases\.material\.a/);
});

// ---- 積み残し2026-09-22: aliasesのfrom/toは当該種別のkeyOf形式であること ----
test('validateBundle: openingSubTypeのaliasesはfitting:/window:形式なら例外を投げない', () => {
  const bundle = { ...emptyBundle(), aliases: { openingSubType: { 'fitting:oldKey': 'fitting:singleSwing' } } };
  assert.equal(validateBundle(bundle), true);
});

test('【失敗系・積み残し2026-09-22】validateBundle: openingSubTypeのaliasesがfitting:/window:形式でなければ例外', () => {
  const bundleFrom = { ...emptyBundle(), aliases: { openingSubType: { oldKey: 'fitting:singleSwing' } } };
  assert.throws(() => validateBundle(bundleFrom), /fitting:\.\.\.またはwindow:/);
  const bundleTo = { ...emptyBundle(), aliases: { openingSubType: { 'fitting:oldKey': 'singleSwing' } } };
  assert.throws(() => validateBundle(bundleTo), /fitting:\.\.\.またはwindow:/);
});

test('【失敗系・積み残し2026-09-22】validateBundle: materialのaliasesが12桁コード形式でなければ例外', () => {
  const bundle = { ...emptyBundle(), aliases: { material: { 'not-a-code': '301000000001' } } };
  assert.throws(() => validateBundle(bundle), /キー（コード）が不正/);
});

test('積み残し2026-09-22: validateBundle: aliasesのtoがnull（廃止）ならfromのキー形式だけ検査する', () => {
  const bundle = { ...emptyBundle(), aliases: { material: { '301000000001': null } } };
  assert.equal(validateBundle(bundle), true);
});

test('積み残し2026-09-22: validateBundle: 未知の種別のaliasesはキー形式の検証をスキップする', () => {
  const bundle = { ...emptyBundle(), aliases: { 将来の種別: { 何でも: 'ok' } } };
  assert.equal(validateBundle(bundle), true);
});

test('bundleEntries/withEntries: 非破壊（元の束は変わらない）', () => {
  const base = emptyBundle();
  const next = withEntries(base, 'material', [material()]);
  assert.deepEqual(bundleEntries(base, 'material'), []);
  assert.equal(bundleEntries(next, 'material').length, 1);
});

test('bundleAliases/withAlias: 非破壊で1件追記できる', () => {
  const base = emptyBundle();
  const next = withAlias(base, 'material', '999999999999', '301000000001');
  assert.deepEqual(bundleAliases(base, 'material'), {});
  assert.deepEqual(bundleAliases(next, 'material'), { '999999999999': '301000000001' });
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

// ---- ライブラリ衝突検出（overridesBuiltin印の有無）----
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

// ---- mergeBundles / splitBundleByKind（IDB種別ごとの束 ⇔ .stq単一catalogsの変換。ステップ4）----
test('splitBundleByKind→mergeBundles: 単一の束から分割→統合するとラウンドトリップする', () => {
  const bundle = withAlias(
    withEntries(withEntries(emptyBundle(), 'material', [material()]), 'section', []),
    'material', '111111111150', '102000000001',
  );
  const split = splitBundleByKind(bundle);
  assert.deepEqual([...split.keys()].sort(), ['material', 'section']);
  const merged = mergeBundles([...split.values()]);
  assert.deepEqual(bundleEntries(merged, 'material'), [material()]);
  assert.deepEqual(bundleEntries(merged, 'section'), []);
  assert.deepEqual(bundleAliases(merged, 'material'), { '111111111150': '102000000001' });
});

test('splitBundleByKind: 種別ごとに1種別だけを含む束を返す（他種別のcatalogsキーを持たない）', () => {
  const bundle = withEntries(withEntries(emptyBundle(), 'material', [material()]), 'section', [{ key: 'S1' }]);
  const split = splitBundleByKind(bundle);
  assert.deepEqual(Object.keys(split.get('material').catalogs), ['material']);
  assert.deepEqual(Object.keys(split.get('section').catalogs), ['section']);
});

// ---- ステップ14-S 裁定1付随: validateBundle は def.validate の例外に種別・キーを前置する ----
test('【失敗系・ステップ14-S】validateBundle: 不正エントリの例外メッセージに種別とキーが前置される', () => {
  const bundle = withEntries(emptyBundle(), 'material', [material({ x: '10' })]);
  assert.throws(
    () => validateBundle(bundle),
    err => err.message === 'material 301000000001: 材エントリのxが不正です',
    'validateBundleの例外メッセージが「種別 キー: 元メッセージ」の形になっていない',
  );
});

test('【失敗系・ステップ14-S】validateBundle: keyOf自体が例外を投げるエントリ（key欠落）は「(キー不明)」で前置される', () => {
  // section.keyOfはkeyが非空文字列でなければ例外——validateもkeyより前にrequireFieldsで
  // 必須項目欠落として弾くため、keyOfへ到達する前にvalidateが例外を投げるのが通常の流れだが、
  // ここでは「keyOf自体が例外を投げた場合にtry/catchが安全に(キー不明)へ落ちる」ことを確認する。
  const bundle = withEntries(emptyBundle(), 'section', [{ materialType: 'WOOD', shape: 'rect', width: 90, height: 90, label: 'x' }]);
  assert.throws(
    () => validateBundle(bundle),
    err => err.message === 'section (キー不明): 断面エントリに必須項目が欠落しています: key',
  );
});

// ================================================================
// migrateBundle / formatMigrationNotice（ステップ14-S 裁定1: 修正前の不正データを
// validateBundle の前に正しい内容へ書き換える）
// ================================================================

function buggySection(overrides) {
  return {
    key: 'STEEL-H-250x125', materialType: 'STEEL', shape: 'hSection',
    width: 125, height: -250, webThickness: 6, flangeThickness: 9,
    label: 'H--250×125×6×9',
    ...overrides,
  };
}

test('migrateBundle: section.migrateを持つ種別のエントリを移行し、migratedへ{kind,from,to}を積む', () => {
  const from = buggySection();
  const bundle = withEntries(emptyBundle(), CatalogKind.SECTION, [from]);
  const { bundle: migrated, migrated: migratedList } = migrateBundle(bundle);
  assert.equal(migratedList.length, 1);
  assert.equal(migratedList[0].kind, CatalogKind.SECTION);
  assert.equal(migratedList[0].from, from, 'fromは元のオブジェクト参照');
  assert.equal(migratedList[0].to.key, 'STEEL-H250x125');
  assert.equal(migratedList[0].to.height, 250);
  assert.deepEqual(bundleEntries(migrated, CatalogKind.SECTION), [migratedList[0].to]);
});

test('migrateBundle: migrateを持たない種別（material）・正のエントリ（section）はmigratedに積まず、束も変わらない（===同一参照）', () => {
  const okSection = { key: 'STEEL-H250x125', materialType: 'STEEL', shape: 'hSection', width: 125, height: 250, webThickness: 6, flangeThickness: 9, label: 'H-250×125×6×9' };
  const bundle = withEntries(withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]), CatalogKind.SECTION, [okSection]);
  const { bundle: migrated, migrated: migratedList } = migrateBundle(bundle);
  assert.deepEqual(migratedList, []);
  assert.equal(migrated, bundle, '変更が無ければ束自体も同一参照を返す');
});

test('migrateBundle: 1つの束にdoc・user両方が読む同じ形（catalogs.section配列）で複数件あっても全件移行する', () => {
  // migrateBundleは束の形しか見ない（呼び出し側がdoc束/user束として別々に渡す）ため、
  // 複数の不正エントリを含む単一束でも全件migratedに積まれることを確認する。
  const from1 = buggySection({ key: 'STEEL-H-250x125', height: -250, width: 125 });
  const from2 = buggySection({
    key: 'STEEL-SQ-200x200x9', shape: 'squarePipe', width: -200, height: 200,
    webThickness: undefined, flangeThickness: undefined, wallThickness: 9, label: '□--200×200×9',
  });
  const bundle = withEntries(emptyBundle(), CatalogKind.SECTION, [from1, from2]);
  const { migrated: migratedList } = migrateBundle(bundle);
  assert.equal(migratedList.length, 2);
  assert.deepEqual(migratedList.map(m => m.to.key), ['STEEL-H250x125', 'STEEL-SQ200x200x9']);
});

test('migrateBundle: 未知種別・catalogsが配列でない項目は素通しする（例外にしない）', () => {
  const bundle = { ...emptyBundle(), catalogs: { 将来の種別: [{ 何でも: true }], material: 'not-array' } };
  assert.doesNotThrow(() => migrateBundle(bundle));
  const { migrated: migratedList } = migrateBundle(bundle);
  assert.deepEqual(migratedList, []);
});

test('formatMigrationNotice: 「種別ラベル 旧キー を 新キー へ移行しました」の日本語文を返す', () => {
  const from = buggySection();
  const to = { ...from, key: 'STEEL-H250x125', height: 250, label: 'H-250×125×6×9' };
  assert.equal(
    formatMigrationNotice({ kind: CatalogKind.SECTION, from, to }),
    '断面 STEEL-H-250x125 を STEEL-H250x125 へ移行しました',
  );
});

test('formatMigrationNotice: dropped:trueは末尾に「既存を優先」を付記する', () => {
  const from = buggySection();
  const to = { ...from, key: 'STEEL-H250x125', height: 250, label: 'H-250×125×6×9' };
  assert.equal(
    formatMigrationNotice({ kind: CatalogKind.SECTION, from, to, dropped: true }),
    '断面 STEEL-H-250x125 を STEEL-H250x125 へ移行しました（既存を優先し、移行結果は破棄）',
  );
});

// ================================================================
// migrateBundle: QA指摘Major-1（キーが変わる移行はaliasを積む）・Major-2（既存優先で衝突回避）
// ================================================================

test('【QA指摘Major-1】migrateBundle: キーが変わる移行はwithAliasで束のaliases[kind]へ{旧キー:新キー}を積む', () => {
  const from = buggySection(); // key: 'STEEL-H-250x125'
  const bundle = withEntries(emptyBundle(), CatalogKind.SECTION, [from]);
  const { bundle: migrated } = migrateBundle(bundle);
  assert.deepEqual(bundleAliases(migrated, CatalogKind.SECTION), { 'STEEL-H-250x125': 'STEEL-H250x125' });
});

test('【QA指摘Major-2】migrateBundle: 移行後のキーが束に既にある（[bad, good]）なら既存(good)を優先し、bad側の移行結果は束から落とす', () => {
  const bad = buggySection({ key: 'STEEL-H-250x125', height: -250, width: 125 }); // 移行先: STEEL-H250x125
  const good = {
    key: 'STEEL-H250x125', materialType: 'STEEL', shape: 'hSection',
    width: 125, height: 250, webThickness: 6, flangeThickness: 9, label: 'H-250×125×6×9',
  };
  const bundle = withEntries(emptyBundle(), CatalogKind.SECTION, [bad, good]);
  const { bundle: migrated, migrated: migratedList } = migrateBundle(bundle);

  // 束には既存(good)の1件だけが残る——重複キーにならない。
  assert.deepEqual(bundleEntries(migrated, CatalogKind.SECTION), [good]);
  // migratedにはdropped:trueで記録される（通知・監査のため捨てたことが分かる）。
  assert.equal(migratedList.length, 1);
  assert.equal(migratedList[0].dropped, true);
  assert.equal(migratedList[0].from, bad);
  assert.equal(migratedList[0].to.key, 'STEEL-H250x125');
  // 捨てた場合もaliasは積む（参照は生き残ったgoodへ向く）。
  assert.deepEqual(bundleAliases(migrated, CatalogKind.SECTION), { 'STEEL-H-250x125': 'STEEL-H250x125' });
});

test('【QA指摘Major-2】migrateBundle: 束の並び順が[good, bad]でも既存(good)を優先する（並び順に依存しない）', () => {
  const bad = buggySection({ key: 'STEEL-H-250x125', height: -250, width: 125 });
  const good = {
    key: 'STEEL-H250x125', materialType: 'STEEL', shape: 'hSection',
    width: 125, height: 250, webThickness: 6, flangeThickness: 9, label: 'H-250×125×6×9',
  };
  const bundle = withEntries(emptyBundle(), CatalogKind.SECTION, [good, bad]);
  const { bundle: migrated, migrated: migratedList } = migrateBundle(bundle);
  assert.deepEqual(bundleEntries(migrated, CatalogKind.SECTION), [good]);
  assert.equal(migratedList[0].dropped, true);
});

// QA再々指摘Minor-3: 既存の正常なエントリが無くても、移行が必要な2件が同じ移行先キーへ
// 向かう場合（[bad1, bad2]）に2件目が捨てられることを固定する（Major-2の既存テストは
// 「既存の未変更エントリ」との衝突しか確認していなかった——1st passでreservedKeysに積むのが
// 「未変更エントリ」だけでなく「2nd passで先に採用した移行結果」自体にも効くことの検証）。
test('【QA指摘Minor-3】migrateBundle: 移行が必要な2件が同じ移行先キーへ向かう場合（[bad1, bad2]）は先着(bad1)を残し、2件目(bad2)はdropped:trueで捨てる。aliasは2件とも積む', () => {
  // bad1/bad2は同一キー（'STEEL-H-250x125'）から移行する重複データを想定
  // （web/flangeThicknessだけ違う——キーは成×幅のみで決まるため、この2件は移行前から
  // 同一キーの重複データになっている）。
  const bad1 = buggySection({ key: 'STEEL-H-250x125', height: -250, width: 125, webThickness: 6, flangeThickness: 9, label: 'H--250×125×6×9' });
  const bad2 = buggySection({ key: 'STEEL-H-250x125', height: -250, width: 125, webThickness: 8, flangeThickness: 12, label: 'H--250×125×8×12' });
  const bundle = withEntries(emptyBundle(), CatalogKind.SECTION, [bad1, bad2]);
  const { bundle: migrated, migrated: migratedList } = migrateBundle(bundle);

  // 1件だけ残る（先着のbad1由来）。
  const remaining = bundleEntries(migrated, CatalogKind.SECTION);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].key, 'STEEL-H250x125');
  assert.equal(remaining[0].webThickness, 6, '先着(bad1)が残っている（bad2のwebThickness=8ではない）');

  // migratedにはbad1・bad2の両方が記録される。bad1はdroppedなし、bad2はdropped:true。
  assert.equal(migratedList.length, 2);
  assert.equal(migratedList[0].from, bad1);
  assert.equal(migratedList[0].dropped, undefined, 'bad1（先着）はdroppedが付かない');
  assert.equal(migratedList[1].from, bad2);
  assert.equal(migratedList[1].dropped, true, 'bad2（2件目）はdropped:trueで捨てられる');

  // aliasは2件（bad1・bad2）ともwithAliasを通る——同じfromKey→同じtoKeyのため結果は1エントリに
  // なるが、bad2（捨てられた側）の参照もalias経由で生き残ったbad1由来のエントリへ向く。
  assert.deepEqual(bundleAliases(migrated, CatalogKind.SECTION), { 'STEEL-H-250x125': 'STEEL-H250x125' });
});

test('mergeBundles: 複数の束のcatalogs/aliases/encodingsを統合する（種別ごとに1つの束しか持たない前提）', () => {
  const materialBundle = { ...emptyBundle(), catalogs: { material: [material()] }, encodings: { material: 'json' } };
  const sectionBundle = { ...emptyBundle(), catalogs: { section: [{ key: 'S1' }] }, aliases: { section: { OLD: 'S1' } } };
  const merged = mergeBundles([materialBundle, sectionBundle]);
  assert.deepEqual(bundleEntries(merged, 'material'), [material()]);
  assert.deepEqual(bundleEntries(merged, 'section'), [{ key: 'S1' }]);
  assert.deepEqual(bundleAliases(merged, 'section'), { OLD: 'S1' });
  assert.equal(merged.encodings.material, 'json');
});

test('mergeBundles: null/undefinedの束は無視する', () => {
  const bundle = withEntries(emptyBundle(), 'material', [material()]);
  const merged = mergeBundles([null, bundle, undefined]);
  assert.deepEqual(bundleEntries(merged, 'material'), [material()]);
});

test('mergeBundles: 空配列はemptyBundleと同値', () => {
  assert.deepEqual(mergeBundles([]), emptyBundle());
});
