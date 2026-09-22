import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUsedMaterialCodes, collectUsedKeys, expandTransitiveMaterials, buildDocumentBundle,
  recoverUnresolvedEntries,
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
