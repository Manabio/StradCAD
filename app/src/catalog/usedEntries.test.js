import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUsedMaterialCodes, collectUsedKeys, collectUsedKeysByKind, expandTransitiveMaterials,
  buildDocumentBundle, recoverUnresolvedEntries, reexpandTransitiveMaterials, stripOverridesBuiltin,
  expandUsedMaterialsTransitively,
} from './usedEntries.js';
import { emptyBundle, withEntries } from './catalogBundle.js';
import { CatalogKind } from './catalogKinds.js';

function baseSnapshot(overrides) {
  return {
    exteriorWallBacking: '101000000001',
    interiorWallBacking: '101000000002',
    ceilingBacking: '101000000003',
    floorBacking: null, // null は含めない
    rooms: [
      {
        id: 'r1',
        templateKey: 'LIVING_ROOM',
        overrides: [
          { key: 'wallMaterial', value: '101000000004' },
          { key: 'wallFinish', value: '101000000007' },
          { key: 'other', value: 'x' }, // 対象外キー
        ],
      },
      { id: 'r2', templateKey: null }, // templateKeyなしは含めない
    ],
    edges: [
      { key: 'e1', masterType: 'EXTERIOR_WALL', overrides: [{ key: 'k', value: '101000000005' }, { key: 'k2', value: 'not-a-code' }] },
      { key: 'e2', masterType: null }, // masterTypeなしは含めない
    ],
    clEccentricities: [{ clId: 'cl1', backing: '101000000006' }, { clId: 'cl2', backing: '' }],
    columns: [{ id: 'c1', sectionDefId: 'SEC_A' }],
    beams: [{ id: 'b1', sectionDefId: 'SEC_B' }, { id: 'b2', sectionDefId: null }],
    structuralWalls: [{ id: 'sw1', sectionDefId: 'SEC_A' }], // 重複キーはSetで畳まれる
    slabs: [], footings: [],
    openings: [
      { id: 'o1', category: 'fitting', subType: 'singleSwing' },
      { id: 'o2', category: 'window', subType: null }, // subTypeなしは含めない
    ],
    ...overrides,
  };
}

// ---- collectUsedMaterialCodes: 4フィールドの収集（codeNormalizationと同じ走査器）----
test('collectUsedMaterialCodes: 4系統（backing4フィールド・room override(wallMaterial/wallFinish)・edge override・clEccentricity）を収集する', () => {
  const codes = collectUsedMaterialCodes(baseSnapshot());
  assert.deepEqual(
    [...codes].sort(),
    [
      '101000000001', '101000000002', '101000000003', '101000000004',
      '101000000005', '101000000006', '101000000007',
    ],
  );
});

test('collectUsedMaterialCodes: 12桁数字として不正な値（room overrideのnot-a-code等）は含めない', () => {
  const snapshot = baseSnapshot({
    rooms: [{ id: 'r1', overrides: [{ key: 'wallMaterial', value: 'not-a-code' }] }],
  });
  const codes = collectUsedMaterialCodes(snapshot);
  assert.equal(codes.has('not-a-code'), false);
});

test('collectUsedMaterialCodes: null/空文字は含めない（floorBacking=null・clEccentricity backing=""）', () => {
  const codes = collectUsedMaterialCodes(baseSnapshot());
  assert.equal(codes.has(null), false);
  assert.equal(codes.has(''), false);
});

test('collectUsedMaterialCodes: snapshotがnull/undefinedなら空Set', () => {
  assert.deepEqual(collectUsedMaterialCodes(null), new Set());
  assert.deepEqual(collectUsedMaterialCodes(undefined), new Set());
});

// ---- collectUsedKeys: interiorMaster/boundaryMaster/section/openingSubType ----
test('collectUsedKeys: rooms[].templateKeyをinteriorMasterとして収集する（null・省略は除く）', () => {
  const { interiorMaster } = collectUsedKeys(baseSnapshot());
  assert.deepEqual([...interiorMaster], ['LIVING_ROOM']);
});

test('collectUsedKeys: edges[].masterTypeをboundaryMasterとして収集する（null・省略は除く）', () => {
  const { boundaryMaster } = collectUsedKeys(baseSnapshot());
  assert.deepEqual([...boundaryMaster], ['EXTERIOR_WALL']);
});

test('collectUsedKeys: columns/beams/structuralWalls/slabs/footingsのsectionDefIdを収集し重複はSetで畳む', () => {
  const { section } = collectUsedKeys(baseSnapshot());
  assert.deepEqual([...section].sort(), ['SEC_A', 'SEC_B']);
});

test('collectUsedKeys: openings[]のcategory:subTypeをopeningSubTypeとして収集する（catalogKinds.jsのkeyOfと同型）', () => {
  const { openingSubType } = collectUsedKeys(baseSnapshot());
  assert.deepEqual([...openingSubType], ['fitting:singleSwing']);
});

test('collectUsedKeys: snapshotがnullなら全種別が空Set', () => {
  const used = collectUsedKeys(null);
  assert.deepEqual(used.interiorMaster, new Set());
  assert.deepEqual(used.boundaryMaster, new Set());
  assert.deepEqual(used.section, new Set());
  assert.deepEqual(used.openingSubType, new Set());
});

// ---- collectUsedKeysByKind: 純ロジック（store.jsから抽出。ステップ7c QA指摘Major-1）----
test('collectUsedKeysByKind: rooms・edgesが空のスナップショット1件でも戻り値は指定した全種別を空Setで持つ', () => {
  const emptySnapshot = { rooms: [], edges: [] };
  const kinds = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER];
  const result = collectUsedKeysByKind([emptySnapshot], kinds);
  assert.equal(result.size, 3, '渡した種別ぶんのキーがMapに無い');
  for (const kind of kinds) {
    assert.ok(result.has(kind), `${kind}がMapに無い（使用0件の種別も空Setで持つ契約に反する）`);
    assert.deepEqual(result.get(kind), new Set(), `${kind}が空Setでない`);
  }
});

test('collectUsedKeysByKind: snapshotsが空配列（floorRecordsが1件も無い）でも指定した全種別を空Setで持つ', () => {
  const kinds = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER];
  const result = collectUsedKeysByKind([], kinds);
  assert.equal(result.size, 3);
  for (const kind of kinds) assert.deepEqual(result.get(kind), new Set());
});

test('collectUsedKeysByKind: 複数階のsnapshotから種別ごとに使用キー・材コードを集める（baseSnapshotで検証）', () => {
  const kinds = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER];
  const result = collectUsedKeysByKind([baseSnapshot()], kinds);
  assert.ok(result.get(CatalogKind.MATERIAL).size > 0, 'materialが収集されていない');
  assert.deepEqual([...result.get(CatalogKind.INTERIOR_MASTER)], ['LIVING_ROOM']);
  assert.deepEqual([...result.get(CatalogKind.BOUNDARY_MASTER)], ['EXTERIOR_WALL']);
});

test('collectUsedKeysByKind: kindsに含めなかった種別は戻り値に現れない', () => {
  const result = collectUsedKeysByKind([baseSnapshot()], [CatalogKind.MATERIAL]);
  assert.equal(result.size, 1);
  assert.ok(!result.has(CatalogKind.INTERIOR_MASTER));
  assert.ok(!result.has(CatalogKind.BOUNDARY_MASTER));
});

test('【失敗系】collectUsedKeysByKind: 収集に未対応の種別を渡すと空Setを返さず日本語例外（黙って空配列で同梱し前回レコードを消す退行を防ぐ）', () => {
  assert.throws(
    () => collectUsedKeysByKind([baseSnapshot()], ['someNewKind']),
    /使用キーの収集に未対応の種別です: someNewKind/,
  );
});

// ---- expandTransitiveMaterials: 内装マスター・境界マスターの推移的展開 ----
test('expandTransitiveMaterials: 内装マスターのwallMaterial/wallFinishを追加する', () => {
  const expanded = expandTransitiveMaterials(new Set(['101000000001']), {
    interiorMasters: [{ wallMaterial: '301000000002', wallFinish: '302000000001' }],
  });
  assert.deepEqual(
    [...expanded].sort(),
    ['101000000001', '301000000002', '302000000001'],
  );
});

test('expandTransitiveMaterials: 境界マスターの固定層code（layer.code）を追加する', () => {
  const expanded = expandTransitiveMaterials(new Set(), {
    boundaryMasters: [{ layers: [{ role: '外壁材', code: '301600000001' }, { role: '未指定', code: null }] }],
  });
  assert.deepEqual([...expanded], ['301600000001']);
});

test('expandTransitiveMaterials: LAYER_SOURCE（layer.src）の層は辿らない（layer.codeが無いので追加されない）', () => {
  const expanded = expandTransitiveMaterials(new Set(), {
    boundaryMasters: [{ layers: [{ role: '外壁下地', src: 'floorExteriorBacking' }] }],
  });
  assert.deepEqual([...expanded], []);
});

test('expandTransitiveMaterials: 引数省略時は元のcodesをそのまま返す（コピー）', () => {
  const original = new Set(['101000000001']);
  const expanded = expandTransitiveMaterials(original);
  assert.deepEqual([...expanded], ['101000000001']);
  assert.notEqual(expanded, original);
});

// ---- expandUsedMaterialsTransitively（ステップ12b QA指摘M1/m3）: collectUsedKeysByKindの戻り値
// に対しexpandTransitiveMaterialsを一括適用する（store.js saveCatalogDocument/
// collectCurrentCatalogUsageが共有する唯一の判定式） ----
test('expandUsedMaterialsTransitively: 使用中interiorMasterのwallMaterial/wallFinishをmaterialへ追加する', () => {
  const usedKeysByKind = new Map([
    [CatalogKind.MATERIAL, new Set(['101000000001'])],
    [CatalogKind.INTERIOR_MASTER, new Set(['LIVING_ROOM'])],
    [CatalogKind.BOUNDARY_MASTER, new Set()],
  ]);
  const resolvedByKind = new Map([
    [CatalogKind.INTERIOR_MASTER, new Map([['LIVING_ROOM', { wallMaterial: '301000000002', wallFinish: '302000000001' }]])],
    [CatalogKind.BOUNDARY_MASTER, new Map()],
  ]);
  const result = expandUsedMaterialsTransitively(usedKeysByKind, resolvedByKind);
  assert.deepEqual(
    [...result.get(CatalogKind.MATERIAL)].sort(),
    ['101000000001', '301000000002', '302000000001'],
  );
});

test('expandUsedMaterialsTransitively: 使用中boundaryMasterの固定層codeもmaterialへ追加する', () => {
  const usedKeysByKind = new Map([
    [CatalogKind.MATERIAL, new Set()],
    [CatalogKind.INTERIOR_MASTER, new Set()],
    [CatalogKind.BOUNDARY_MASTER, new Set(['EXT_WALL'])],
  ]);
  const resolvedByKind = new Map([
    [CatalogKind.INTERIOR_MASTER, new Map()],
    [CatalogKind.BOUNDARY_MASTER, new Map([['EXT_WALL', { layers: [{ role: '外壁材', code: '301600000001' }] }]])],
  ]);
  const result = expandUsedMaterialsTransitively(usedKeysByKind, resolvedByKind);
  assert.deepEqual([...result.get(CatalogKind.MATERIAL)], ['301600000001']);
});

test('【QA指摘m3】expandUsedMaterialsTransitively: 未保存階の使用（未解決含む）を表すusedKeysByKindでも、解決できたぶんは正しく展開される', () => {
  // 「未保存の作業中の使用キー」は本関数の視点では単なる入力Setの一部——collectUsedKeysByKind
  // が未保存階を含むsnapshots群から集めたSetをそのまま渡す契約（store.js側の責務）。ここでは
  // resolvedByKindに存在しないキー（=まだoverlayに無いユーザー材等）が混ざっても、
  // 解決できるキーの展開は正しく行われ、解決できないキーは無視されることを確認する。
  const usedKeysByKind = new Map([
    [CatalogKind.MATERIAL, new Set(['101000000001'])],
    [CatalogKind.INTERIOR_MASTER, new Set(['LIVING_ROOM', 'UNRESOLVED_ROOM'])],
    [CatalogKind.BOUNDARY_MASTER, new Set()],
  ]);
  const resolvedByKind = new Map([
    [CatalogKind.INTERIOR_MASTER, new Map([['LIVING_ROOM', { wallMaterial: '301000000002' }]])], // UNRESOLVED_ROOMは無い
    [CatalogKind.BOUNDARY_MASTER, new Map()],
  ]);
  const result = expandUsedMaterialsTransitively(usedKeysByKind, resolvedByKind);
  assert.deepEqual([...result.get(CatalogKind.MATERIAL)].sort(), ['101000000001', '301000000002']);
});

test('expandUsedMaterialsTransitively: usedKeysByKindがCatalogKind.MATERIALを含まなければ何もせずそのまま返す', () => {
  const usedKeysByKind = new Map([[CatalogKind.SECTION, new Set(['STEEL-H200x100'])]]);
  const result = expandUsedMaterialsTransitively(usedKeysByKind, new Map());
  assert.equal(result, usedKeysByKind);
});

test('expandUsedMaterialsTransitively: 新しいMapを返す（引数のusedKeysByKindを書き換えない）', () => {
  const usedKeysByKind = new Map([
    [CatalogKind.MATERIAL, new Set(['101000000001'])],
    [CatalogKind.INTERIOR_MASTER, new Set()],
    [CatalogKind.BOUNDARY_MASTER, new Set()],
  ]);
  const originalMaterialSet = usedKeysByKind.get(CatalogKind.MATERIAL);
  const result = expandUsedMaterialsTransitively(usedKeysByKind, new Map());
  assert.notEqual(result, usedKeysByKind, '新しいMapを返す');
  assert.equal(usedKeysByKind.get(CatalogKind.MATERIAL), originalMaterialSet, '引数のMaterial Setは書き換えられていない');
});

// ---- buildDocumentBundle: 解決済み実体を同梱・参照されなくなったエントリは含めない ----
test('buildDocumentBundle: 使用キーに対応する解決済みエントリを同梱する', () => {
  const materialMap = new Map([
    ['101000000001', { code: '101000000001', name: 'A', spec: '', x: 0, y: 0, thickness: null }],
    ['101000000002', { code: '101000000002', name: 'B', spec: '', x: 0, y: 0, thickness: null }],
  ]);
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['101000000001'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.deepEqual(bundle.catalogs.material, [materialMap.get('101000000001')]);
  assert.equal(bundle.encodings.material, 'json');
  assert.deepEqual(bundle.aliases, {});
  assert.deepEqual(unresolvedKeys, new Map(), '全解決なのでunresolvedKeysは空');
});

test('buildDocumentBundle: 参照されなくなったエントリ（usedKeysに無いキー）は含めない', () => {
  const materialMap = new Map([
    ['101000000001', { code: '101000000001', name: 'A', spec: '', x: 0, y: 0, thickness: null }],
    ['101000000099', { code: '101000000099', name: '不使用', spec: '', x: 0, y: 0, thickness: null }],
  ]);
  const { bundle } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['101000000001'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.deepEqual(bundle.catalogs.material.map(e => e.code), ['101000000001']);
});

// 2026-09-22 QA指摘A: 解決できないキーは同梱から黙って落とすのではなく unresolvedKeys で返す
// （呼び出し側が recoverUnresolvedEntries で既存レコードから回収するか、通知に使う）。
test('buildDocumentBundle: 使用キーがresolvedByKindに実体を持たない（解決できない）場合は同梱せずunresolvedKeysに積む', () => {
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['999999999999'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, new Map()]]),
  });
  assert.deepEqual(bundle.catalogs.material, []);
  assert.deepEqual(unresolvedKeys.get(CatalogKind.MATERIAL), new Set(['999999999999']));
});

test('buildDocumentBundle: resolvedByKindに種別自体が無い（Map未登録）場合も全キーがunresolvedKeysに積まれる', () => {
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['999999999999'])]]),
    resolvedByKind: new Map(),
  });
  assert.deepEqual(bundle.catalogs.material, []);
  assert.deepEqual(unresolvedKeys.get(CatalogKind.MATERIAL), new Set(['999999999999']));
});

test('buildDocumentBundle: aliasesをそのまま束へ持たせる', () => {
  const { bundle } = buildDocumentBundle({
    usedKeysByKind: new Map(),
    resolvedByKind: new Map(),
    aliases: { material: { '111111111150': '102000000001' } },
  });
  assert.deepEqual(bundle.aliases, { material: { '111111111150': '102000000001' } });
});

test('buildDocumentBundle: 束のversionは1（catalogBundle.jsのemptyBundleと一致）', () => {
  const { bundle } = buildDocumentBundle({ usedKeysByKind: new Map(), resolvedByKind: new Map() });
  assert.equal(bundle.version, 1);
});

// ステップ7c: 使用0件の種別も usedKeysByKind に空Setとして渡せば bundle.catalogs[kind] = [] と
// して必ず現れる（4.3「参照されなくなったエントリは次回保存時に外す」の一般化。呼び出し側
// （store.js collectCatalogUsageAcrossFloors）が使用0件の種別を Map から省略すると、この種別は
// bundle.catalogs に一切現れず、splitBundleByKind で保存対象から漏れて前回レコードが残ってしまう
// ——そのため呼び出し側は必ず空Setで渡す契約になっている。ここではbuildDocumentBundle自身の
// 挙動として「渡された種別は使用数0でも空配列で書かれる」ことを固定する）。
test('buildDocumentBundle: 使用0件の種別（空Set）を渡すと同梱に空配列として現れる', () => {
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([
      [CatalogKind.MATERIAL, new Set(['101000000001'])],
      [CatalogKind.INTERIOR_MASTER, new Set()], // 使用0件
      [CatalogKind.BOUNDARY_MASTER, new Set()], // 使用0件
    ]),
    resolvedByKind: new Map([
      [CatalogKind.MATERIAL, new Map([['101000000001', { code: '101000000001', name: 'A', spec: '', x: 0, y: 0, thickness: null }]])],
      [CatalogKind.INTERIOR_MASTER, new Map()],
      [CatalogKind.BOUNDARY_MASTER, new Map()],
    ]),
  });
  assert.deepEqual(bundle.catalogs.interiorMaster, []);
  assert.deepEqual(bundle.catalogs.boundaryMaster, []);
  assert.equal(bundle.encodings.interiorMaster, 'json');
  assert.equal(bundle.encodings.boundaryMaster, 'json');
  assert.equal(unresolvedKeys.size, 0, '使用0件なので未解決キーは無い');
});

// ---- buildDocumentBundle: overridesBuiltin除去（ステップ12a）----
test('buildDocumentBundle: 同梱エントリからoverridesBuiltinを除去する（本体上書き印はuserライブラリ側の状態であり同梱すべきでない）', () => {
  const materialMap = new Map([
    ['301000000001', { code: '301000000001', name: 'A（編集）', spec: '', x: 0, y: 0, thickness: null, overridesBuiltin: true }],
  ]);
  const { bundle } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['301000000001'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.equal('overridesBuiltin' in bundle.catalogs.material[0], false);
  assert.deepEqual(bundle.catalogs.material[0], {
    code: '301000000001', name: 'A（編集）', spec: '', x: 0, y: 0, thickness: null,
  });
});

test('buildDocumentBundle: overridesBuiltinを持たないエントリはそのまま同梱される（余計なキーを増やさない）', () => {
  const materialMap = new Map([
    ['301000000001', { code: '301000000001', name: 'A', spec: '', x: 0, y: 0, thickness: null }],
  ]);
  const { bundle } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['301000000001'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.deepEqual(
    Object.keys(bundle.catalogs.material[0]).sort(),
    ['code', 'name', 'spec', 'thickness', 'x', 'y'].sort(),
  );
});

// ---- recoverUnresolvedEntries: 未解決キーを既存の同梱束から回収する（2026-09-22 QA指摘A）----
test('recoverUnresolvedEntries: 既存の同梱束に実体が残っていれば回収してbundleへ追記する', () => {
  const recoveredEntry = { code: '301000000020', name: 'ユーザー材', spec: '', x: 0, y: 0, thickness: 15 };
  const existingBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [recoveredEntry]);

  const { bundle: draft, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['301000000020'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, new Map()]]), // builtin側では解決できない（ユーザー材のため）
  });
  assert.deepEqual(unresolvedKeys.get(CatalogKind.MATERIAL), new Set(['301000000020']));

  const { bundle: recovered, stillUnresolvedByKind } = recoverUnresolvedEntries(
    draft, unresolvedKeys, new Map([[CatalogKind.MATERIAL, existingBundle]]),
  );
  assert.deepEqual(recovered.catalogs.material, [recoveredEntry]);
  assert.deepEqual(stillUnresolvedByKind, new Map(), '既存束から回収できたので残留なし');
});

test('recoverUnresolvedEntries: 既存の同梱束にも無いキーはstillUnresolvedByKindに残る（回収されない）', () => {
  const { bundle: draft, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['999999999999'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, new Map()]]),
  });
  const existingBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, []); // 既存も空
  const { bundle: recovered, stillUnresolvedByKind } = recoverUnresolvedEntries(
    draft, unresolvedKeys, new Map([[CatalogKind.MATERIAL, existingBundle]]),
  );
  assert.deepEqual(recovered.catalogs.material, []);
  assert.deepEqual(stillUnresolvedByKind.get(CatalogKind.MATERIAL), new Set(['999999999999']));
});

// ---- QA指摘Minor-1（2026-09-24再報告）: 回収元（旧保存の同梱束）にoverridesBuiltinが残っていても除去する ----
test('【QA指摘Minor-1】recoverUnresolvedEntries: 既存の同梱束のエントリにoverridesBuiltinが残っていても、回収時に除去してbundleへ追記する', () => {
  const taintedEntry = { code: '301000000020', name: 'ユーザー材', spec: '', x: 0, y: 0, thickness: 15, overridesBuiltin: true };
  const existingBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [taintedEntry]);

  const { bundle: draft, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['301000000020'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, new Map()]]),
  });

  const { bundle: recovered } = recoverUnresolvedEntries(
    draft, unresolvedKeys, new Map([[CatalogKind.MATERIAL, existingBundle]]),
  );
  assert.equal('overridesBuiltin' in recovered.catalogs.material[0], false);
  assert.deepEqual(recovered.catalogs.material, [
    { code: '301000000020', name: 'ユーザー材', spec: '', x: 0, y: 0, thickness: 15 },
  ]);
});

test('stripOverridesBuiltin: overridesBuiltinを持たないエントリは同じ参照をそのまま返す（新しいオブジェクトを作らない）', () => {
  const entry = { code: '301000000001', name: 'A' };
  assert.equal(stripOverridesBuiltin(entry), entry);
});

test('stripOverridesBuiltin: overridesBuiltinを持つエントリは除去した新しいオブジェクトを返す（元のオブジェクトは変更しない）', () => {
  const entry = { code: '301000000001', name: 'A', overridesBuiltin: true };
  const stripped = stripOverridesBuiltin(entry);
  assert.notEqual(stripped, entry);
  assert.deepEqual(stripped, { code: '301000000001', name: 'A' });
  assert.equal(entry.overridesBuiltin, true, '元のオブジェクトは書き換えない');
});

test('recoverUnresolvedEntries: 既存レコード自体が無い（Map未登録）場合もstillUnresolvedByKindへ積む', () => {
  const { bundle: draft, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['999999999999'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, new Map()]]),
  });
  const { bundle: recovered, stillUnresolvedByKind } = recoverUnresolvedEntries(draft, unresolvedKeys, new Map());
  assert.deepEqual(recovered.catalogs.material, []);
  assert.deepEqual(stillUnresolvedByKind.get(CatalogKind.MATERIAL), new Set(['999999999999']));
});

test('recoverUnresolvedEntries: unresolvedKeysが空なら何もせずbundleを素通しする（同一内容）', () => {
  const { bundle: draft, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, new Set(['101000000001'])]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, new Map([['101000000001', { code: '101000000001', name: 'A', spec: '', x: 0, y: 0, thickness: null }]])]]),
  });
  assert.equal(unresolvedKeys.size, 0);
  const { bundle: recovered, stillUnresolvedByKind } = recoverUnresolvedEntries(draft, unresolvedKeys, new Map());
  assert.deepEqual(recovered, draft);
  assert.deepEqual(stillUnresolvedByKind, new Map());
});

// ---- reexpandTransitiveMaterials: 回収分（recoverUnresolvedEntries後）の推移展開のやり直し
// （QA指摘Minor-2） ----
test('reexpandTransitiveMaterials: 回収されたinteriorMasterのwallMaterial/wallFinishをmaterial束へ追記する', () => {
  const recoveredMaster = {
    key: 'USER_ROOM', label: 'ユーザー部屋', wallMaterial: '301000000002', wallFinish: '302000000001', ceilingHeight: 2600,
  };
  let bundle = withEntries(emptyBundle(), CatalogKind.INTERIOR_MASTER, [recoveredMaster]);
  bundle = withEntries(bundle, CatalogKind.MATERIAL, []); // 回収時点ではまだmaterial束に無い

  const materialEntryA = { code: '301000000002', name: 'せっこうボード', spec: '', x: 0, y: 0, thickness: 12.5 };
  const materialEntryB = { code: '302000000001', name: 'ビニールクロス', spec: '', x: 0, y: 0, thickness: null };
  const materialMap = new Map([[materialEntryA.code, materialEntryA], [materialEntryB.code, materialEntryB]]);

  const { bundle: result, unresolvedMaterialKeys } = reexpandTransitiveMaterials(bundle, materialMap);
  assert.deepEqual(
    result.catalogs.material.map(e => e.code).sort(),
    ['301000000002', '302000000001'],
  );
  assert.equal(unresolvedMaterialKeys.size, 0);
});

test('reexpandTransitiveMaterials: 回収されたboundaryMasterの固定層codeもmaterial束へ追記する', () => {
  const recoveredMaster = { key: 'USER_BOUNDARY', label: 'ユーザー境界', kind: 'layered', layers: [{ role: '外壁材', code: '301600000001' }] };
  let bundle = withEntries(emptyBundle(), CatalogKind.BOUNDARY_MASTER, [recoveredMaster]);
  bundle = withEntries(bundle, CatalogKind.MATERIAL, []);

  const entry = { code: '301600000001', name: 'サイディング', spec: '', x: 0, y: 0, thickness: 16 };
  const materialMap = new Map([[entry.code, entry]]);

  const { bundle: result, unresolvedMaterialKeys } = reexpandTransitiveMaterials(bundle, materialMap);
  assert.deepEqual(result.catalogs.material.map(e => e.code), ['301600000001']);
  assert.equal(unresolvedMaterialKeys.size, 0);
});

test('reexpandTransitiveMaterials: materialMapに無い（解決できない）材コードはunresolvedMaterialKeysに積み、material束には追記しない', () => {
  const recoveredMaster = {
    key: 'USER_ROOM', label: 'ユーザー部屋', wallMaterial: '999999999999', wallFinish: '302000000001', ceilingHeight: 2600,
  };
  let bundle = withEntries(emptyBundle(), CatalogKind.INTERIOR_MASTER, [recoveredMaster]);
  bundle = withEntries(bundle, CatalogKind.MATERIAL, []);
  const entry = { code: '302000000001', name: 'ビニールクロス', spec: '', x: 0, y: 0, thickness: null };
  const materialMap = new Map([[entry.code, entry]]);

  const { bundle: result, unresolvedMaterialKeys } = reexpandTransitiveMaterials(bundle, materialMap);
  assert.deepEqual(result.catalogs.material.map(e => e.code), ['302000000001']);
  assert.deepEqual(unresolvedMaterialKeys, new Set(['999999999999']));
});

test('reexpandTransitiveMaterials: 追加で展開される材が無ければbundleをそのまま返す（同一参照）', () => {
  let bundle = withEntries(emptyBundle(), CatalogKind.INTERIOR_MASTER, []);
  bundle = withEntries(bundle, CatalogKind.MATERIAL, [{ code: '101000000001', name: 'A', spec: '', x: 0, y: 0, thickness: null }]);
  const { bundle: result, unresolvedMaterialKeys } = reexpandTransitiveMaterials(bundle, new Map());
  assert.equal(result, bundle, '展開すべき材が無いのに新しいbundleオブジェクトを作っている');
  assert.equal(unresolvedMaterialKeys.size, 0);
});

test('reexpandTransitiveMaterials: 既にmaterial束にあるコードは重複追加しない', () => {
  const recoveredMaster = { key: 'USER_ROOM', label: '部屋', wallMaterial: '301000000002', wallFinish: null, ceilingHeight: 2600 };
  let bundle = withEntries(emptyBundle(), CatalogKind.INTERIOR_MASTER, [recoveredMaster]);
  const existingEntry = { code: '301000000002', name: 'せっこうボード', spec: '', x: 0, y: 0, thickness: 12.5 };
  bundle = withEntries(bundle, CatalogKind.MATERIAL, [existingEntry]);
  const materialMap = new Map([[existingEntry.code, existingEntry]]);

  const { bundle: result } = reexpandTransitiveMaterials(bundle, materialMap);
  assert.deepEqual(result.catalogs.material, [existingEntry]);
});
