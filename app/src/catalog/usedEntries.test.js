import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUsedMaterialCodes, collectUsedKeys, collectUsedKeysByKind, expandTransitiveMaterials,
  buildDocumentBundle, recoverUnresolvedEntries, reexpandTransitiveMaterials, stripOverridesBuiltin,
  expandUsedMaterialsTransitively, expandUsedDetailFiguresTransitively, reexpandTransitiveDetailFigures,
} from './usedEntries.js';
import { emptyBundle, withEntries, bundleEntries } from './catalogBundle.js';
import { CatalogKind } from './catalogKinds.js';
import { SNAPSHOT_REF_WALKERS } from './codeNormalization.js';
import {
  DETAIL_BUILTIN_BASEBOARD_KEY, DETAIL_BUILTIN_KNEE_CAP_KEY, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY, SWING_LEAF_SUBTYPE,
  DETAIL_BUILTIN_WINDOW_JAMB_KEY, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
  DETAIL_BUILTIN_WINDOW_HEAD_KEY, DETAIL_BUILTIN_WINDOW_SILL_KEY,
  DetailCategory, DetailView, DetailSubject, DetailProvenanceSource,
} from '../core/constants.js';

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
      { id: 'o1', category: 'fitting', subType: 'singleSwing', fixtureType: 'WD' },
      { id: 'o2', category: 'window', subType: null, fixtureType: null }, // subType/fixtureTypeなしは含めない
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

test('collectUsedMaterialCodes【S3】: 天井材・天井仕上げ（ceilingPanel／ceilingFinish）の override も使用中として収集する。未知キーは収集しない', () => {
  const codes = collectUsedMaterialCodes(baseSnapshot({
    rooms: [{ id: 'r1', overrides: [
      { key: 'ceilingPanel', value: '301000000001' },
      { key: 'ceilingFinish', value: '302000000001' },
      { key: 'ceilingFoo', value: '301000000077' },
    ] }],
  }));
  assert.ok(codes.has('301000000001'), '天井材');
  assert.ok(codes.has('302000000001'), '天井仕上げ');
  assert.ok(!codes.has('301000000077'), '未知キーは対象外');
});

test('collectUsedMaterialCodes【QA F2/T4】: shaftWallMaterial（昇降路壁材）も収集対象に含む', () => {
  const codes = collectUsedMaterialCodes(baseSnapshot({ shaftWallMaterial: '301000000020' }));
  assert.ok(codes.has('301000000020'), 'shaftWallMaterialのコードが収集されていない');
});

test('collectUsedMaterialCodes【B2】: 屋根の仕様の野地板・防水シートも収集対象に含む', () => {
  const codes = collectUsedMaterialCodes(baseSnapshot({
    rooms: [{ id: 'roof1', overrides: [], roofSpec: { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009' } }],
  }));
  assert.ok(codes.has('301000000023'), '野地板');
  assert.ok(codes.has('302000000009'), '防水シート');
});

test('【B2】buildDocumentBundle: 使用中の屋根の材料（野地板・防水シート）が同梱束に入る。解決できない屋根の材料は unresolvedKeys へ', () => {
  const snapshot = baseSnapshot({
    rooms: [{ id: 'roof1', overrides: [], roofSpec: { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009' } }],
  });
  const usedKeysByKind = collectUsedKeysByKind([snapshot], [CatalogKind.MATERIAL]);
  const materialMap = new Map([
    ['301000000023', { code: '301000000023', name: '硬質木片セメント板 t=25', spec: '', x: 910, y: 1820, thickness: 25 }],
  ]);
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind, resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.ok(bundle.catalogs.material.some(e => e.code === '301000000023'), '野地板は同梱される');
  assert.ok(unresolvedKeys.get(CatalogKind.MATERIAL).has('302000000009'), '実体が無い防水シートは未解決として返る');
});

test('collectUsedMaterialCodes【B3】: 主屋根の野地板・防水シートも収集対象に含む。既定値のままなら snapshot.mainRoofSpec が null で収集に出ない', () => {
  const codes = collectUsedMaterialCodes(baseSnapshot({
    mainRoofSpec: { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009' },
  }));
  assert.ok(codes.has('301000000023'), '野地板');
  assert.ok(codes.has('302000000009'), '防水シート');
  const none = collectUsedMaterialCodes(baseSnapshot({ mainRoofSpec: null }));
  assert.equal(none.has('302000000009'), false);
  assert.equal(none.has('101200000008'), false, '既定の野地板は主屋根からは出ない');
});

test('【B3】buildDocumentBundle: 使用中の主屋根の材料が同梱束に入り、解決できない主屋根の材料は unresolvedKeys へ', () => {
  const snapshot = baseSnapshot({
    mainRoofSpec: { sheathingMaterial: '301000000023', underlaymentMaterial: '302000000009' },
  });
  const usedKeysByKind = collectUsedKeysByKind([snapshot], [CatalogKind.MATERIAL]);
  const materialMap = new Map([
    ['301000000023', { code: '301000000023', name: '硬質木片セメント板 t=25', spec: '', x: 910, y: 1820, thickness: 25 }],
  ]);
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind, resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.ok(bundle.catalogs.material.some(e => e.code === '301000000023'), '主屋根の野地板は同梱される');
  assert.ok(unresolvedKeys.get(CatalogKind.MATERIAL).has('302000000009'), '実体が無い防水シートは未解決として返る');
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

test('collectUsedKeys: openings[].fixtureTypeをfixtureSymbolとして収集する（空でない文字列のみ）', () => {
  const { fixtureSymbol } = collectUsedKeys(baseSnapshot());
  assert.deepEqual([...fixtureSymbol], ['WD']);
});

test('collectUsedKeys: snapshotがnullなら全種別が空Set', () => {
  const used = collectUsedKeys(null);
  assert.deepEqual(used.interiorMaster, new Set());
  assert.deepEqual(used.boundaryMaster, new Set());
  assert.deepEqual(used.section, new Set());
  assert.deepEqual(used.openingSubType, new Set());
  assert.deepEqual(used.fixtureSymbol, new Set());
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

// ---- ステップ12d: collectUsedKeysByKind(FIXTURE_SYMBOL) → buildDocumentBundle の往復 ----
test('collectUsedKeysByKind: CatalogKind.FIXTURE_SYMBOLを渡すとopenings[].fixtureTypeを収集し、例外を出さない', () => {
  const result = collectUsedKeysByKind([baseSnapshot()], [CatalogKind.FIXTURE_SYMBOL]);
  assert.deepEqual([...result.get(CatalogKind.FIXTURE_SYMBOL)], ['WD']);
});

test('buildDocumentBundle: 使用中の建具記号（fixtureSymbol）が同梱束に入る', () => {
  const usedKeysByKind = collectUsedKeysByKind([baseSnapshot()], [CatalogKind.FIXTURE_SYMBOL]);
  const resolvedByKind = new Map([
    [CatalogKind.FIXTURE_SYMBOL, new Map([['WD', { key: 'WD', label: 'WD（木製建具）', category: 'fitting' }]])],
  ]);
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind, resolvedByKind });
  assert.equal(unresolvedKeys.size, 0);
  assert.deepEqual(bundle.catalogs.fixtureSymbol.map(e => e.key), ['WD']);
});

// ステップ12e QA残件: ステップ12eの未知記号(fixtureType)は建具モードのUIでは保持されるが、
// 保存時にresolvedByKind（overlay込みで解決したMap）に実体が無ければ従来どおり同梱せず
// unresolvedKeysへ積む（他種別と同じ規約。buildDocumentBundleは種別非依存の汎用実装）。
test('【失敗系】buildDocumentBundle: 解決できないfixtureType（QX）はunresolvedKeys.fixtureSymbolに入り同梱束には入らない', () => {
  const usedKeysByKind = collectUsedKeysByKind([baseSnapshot({
    openings: [{ id: 'o1', category: 'fitting', subType: 'singleSwing', fixtureType: 'QX' }],
  })], [CatalogKind.FIXTURE_SYMBOL]);
  const resolvedByKind = new Map([[CatalogKind.FIXTURE_SYMBOL, new Map()]]); // QXはライブラリに無い（未解決）
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind, resolvedByKind });
  assert.deepEqual(bundle.catalogs.fixtureSymbol, []);
  assert.deepEqual(unresolvedKeys.get(CatalogKind.FIXTURE_SYMBOL), new Set(['QX']));
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
// して必ず現れる（「参照されなくなったエントリは次回保存時に外す」の一般化。呼び出し側
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

// ---- 暗黙の既定で使う組込みの詳細図キー（S8d。detailRefs に現れない参照） ----
test('collectUsedKeys: 巾木高さが解析できる部屋が 1 つでもあれば組込みの巾木が detailFigure の使用キーに入る', () => {
  const used = collectUsedKeys({ rooms: [{ id: 'r1', finish: { baseboardHeight: '' } }, { id: 'r2', finish: { baseboardHeight: 'h=60' } }] });
  assert.deepEqual([...used.detailFigure], [DETAIL_BUILTIN_BASEBOARD_KEY]);
});

test('collectUsedKeys: 失敗系＝巾木高さが空・解析不能・部屋なしなら巾木は入らない', () => {
  assert.equal(collectUsedKeys({ rooms: [{ id: 'r1', finish: { baseboardHeight: '' } }, { id: 'r2', finish: { baseboardHeight: '木製' } }, { id: 'r3' }] }).detailFigure.size, 0);
  assert.equal(collectUsedKeys({ rooms: [] }).detailFigure.size, 0);
});

test('collectUsedKeys: 腰壁（hasKnee）の記録があれば組込みの天板が入る。垂れ壁だけ・記録なしなら入らない', () => {
  assert.deepEqual([...collectUsedKeys({ kneeDropWalls: [{ key: 'k', hasKnee: true, hasDrop: false }] }).detailFigure], [DETAIL_BUILTIN_KNEE_CAP_KEY]);
  assert.equal(collectUsedKeys({ kneeDropWalls: [{ key: 'k', hasKnee: false, hasDrop: true }] }).detailFigure.size, 0);
  assert.equal(collectUsedKeys({ kneeDropWalls: [] }).detailFigure.size, 0);
});

test('collectUsedKeys: 片開き戸（subType が SWING_LEAF_SUBTYPE）が 1 つでもあれば組込みの方立・上枠が入る（S8e）。窓だけなら方立・上枠は入らない', () => {
  const used = collectUsedKeys({ openings: [
    { id: 'o2', category: 'fitting', subType: SWING_LEAF_SUBTYPE },
    { id: 'o3', category: 'fitting', subType: 'swingIn' },
  ] });
  assert.deepEqual([...used.detailFigure].sort(), [DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY].sort());
});

test('collectUsedKeys: 窓（category window）が 1 つでもあれば窓の方立 3 つと上枠・下枠 2 つの組込みが入る（S8f-1・S8f-3b）。片開き戸の図は入らない', () => {
  const used = collectUsedKeys({ openings: [
    { id: 'o1', category: 'window', subType: 'fixed' },
    { id: 'o2', category: 'fitting', subType: 'swingIn' },
  ] });
  assert.deepEqual([...used.detailFigure].sort(), [
    DETAIL_BUILTIN_WINDOW_JAMB_KEY, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
    DETAIL_BUILTIN_WINDOW_HEAD_KEY, DETAIL_BUILTIN_WINDOW_SILL_KEY,
  ].sort());
});

test('collectUsedKeys: 失敗系＝片開き戸も窓も無い（他の建具だけ・建具なし・subType／category 欠落）なら組込みの枠の図は入らない', () => {
  assert.equal(collectUsedKeys({ openings: [{ id: 'o1', category: 'fitting', subType: 'swingIn' }] }).detailFigure.size, 0);
  assert.equal(collectUsedKeys({ openings: [] }).detailFigure.size, 0);
  assert.equal(collectUsedKeys({ openings: [{ id: 'o3' }, null] }).detailFigure.size, 0);
});

test('collectUsedKeys: 暗黙の組込みキーは明示の detailRefs と併存し、alias の書換え対象（walker）には現れない', () => {
  const snap = { rooms: [{ id: 'r1', finish: { baseboardHeight: 'h=60' }, detailRefs: { wallCeiling: 'df-x' } }] };
  assert.deepEqual([...collectUsedKeys(snap).detailFigure].sort(), [DETAIL_BUILTIN_BASEBOARD_KEY, 'df-x'].sort());
  assert.deepEqual(SNAPSHOT_REF_WALKERS.detailFigure.enumerate(snap).map(r => r.code), ['df-x']);
});

// ---- 平面の姿図の views の推移展開（P2-1。1 段だけ）----
{
  const DF = CatalogKind.DETAIL_FIGURE;
  const planFig = (key, subject, views, provenance = null) => ({
    key, category: DetailCategory.FIGURE, view: DetailView.PLAN, subject, strokes: [], provenance, ...(views ? { views } : {}),
  });
  const elevFig = (key, views) => ({
    key, category: DetailCategory.FIGURE, view: DetailView.ELEVATION, subject: DetailSubject.SANITARY, strokes: [], provenance: null, ...(views ? { views } : {}),
  });
  const resolvedOf = figs => new Map([[DF, new Map(figs.map(f => [f.key, f]))]]);
  const usedOf = keys => new Map([[DF, new Set(keys)]]);

  test('views: 使用中の平面の姿図 A の views(front=B・right=C) の先 B・C が同梱に入り、B がさらに持つ views の先 D は入らない（1 段だけ）', () => {
    const resolved = resolvedOf([
      planFig('A', DetailSubject.SANITARY, { front: 'B', right: 'C' }),
      elevFig('B', { front: 'D' }), elevFig('C'), elevFig('D'),
    ]);
    const used = expandUsedDetailFiguresTransitively(usedOf(['A']), resolved);
    assert.deepEqual([...used.get(DF)].sort(), ['A', 'B', 'C']);
  });

  test('views: B が平面の姿図で views を持っていても 2 段目は辿らない', () => {
    const resolved = resolvedOf([
      planFig('A', DetailSubject.FURNITURE, { left: 'B' }),
      planFig('B', DetailSubject.FURNITURE, { ceiling: 'D' }), elevFig('D'),
    ]);
    assert.deepEqual([...expandUsedDetailFiguresTransitively(usedOf(['A']), resolved).get(DF)].sort(), ['A', 'B']);
  });

  test('views: views の無い図・配置できない subject(opening)・立面の図が持つ views は従来どおり辿らない', () => {
    const resolved = resolvedOf([
      planFig('A', DetailSubject.HVAC), planFig('O', DetailSubject.OPENING, { front: 'B' }), elevFig('E', { front: 'B' }), elevFig('B'),
    ]);
    assert.deepEqual([...expandUsedDetailFiguresTransitively(usedOf(['A', 'O', 'E']), resolved).get(DF)].sort(), ['A', 'E', 'O']);
  });

  test('views 失敗系: 参照切れの値・壊れた views(null・配列・非文字列)は無視して落ちない。使用中でない図の views は辿らない', () => {
    const resolved = resolvedOf([
      planFig('A', DetailSubject.SANITARY, { front: 'df-none', back: 'B' }), elevFig('B'),
      { ...planFig('N', DetailSubject.SANITARY), views: null }, { ...planFig('R', DetailSubject.SANITARY), views: ['B'] },
      planFig('X', DetailSubject.SANITARY, { front: 5, left: '' }), planFig('Unused', DetailSubject.SANITARY, { front: 'B2' }), elevFig('B2'),
    ]);
    const used = expandUsedDetailFiguresTransitively(usedOf(['A', 'N', 'R', 'X']), resolved);
    assert.deepEqual([...used.get(DF)].sort(), ['A', 'B', 'N', 'R', 'X']);
  });

  test('views 回収経路: reexpandTransitiveDetailFigures は回収した平面の姿図 A の views の先 B を足すが、B の views の先 D は辿らない。参照切れは無視', () => {
    const lib = new Map([
      ['A', planFig('A', DetailSubject.SANITARY, { front: 'B', back: 'df-none' })],
      ['B', planFig('B', DetailSubject.SANITARY, { front: 'D' })], ['D', elevFig('D')],
    ]);
    const recovered = withEntries(emptyBundle(), CatalogKind.FIXTURE_SYMBOL, [
      { key: 'WF', label: 'w', category: 'fitting', detailFigures: { figure: 'A' } },
    ]);
    const r = reexpandTransitiveDetailFigures(recovered, lib);
    assert.deepEqual(bundleEntries(r.bundle, DF).map(e => e.key).sort(), ['A', 'B']);
    assert.equal(r.unresolvedDetailFigureKeys.size, 0);
  });

  test('views 回収経路(viewOrigins): PlacedFigure が直接使う回収済みの姿図 A(割当て由来でない)の views の先 B が入り、B の views の先 D は入らない。viewOrigins 無しでは入らない', () => {
    const lib = new Map([
      ['A', planFig('A', DetailSubject.SANITARY, { front: 'B' })],
      ['B', planFig('B', DetailSubject.SANITARY, { front: 'D' })], ['D', elevFig('D')],
    ]);
    const recovered = withEntries(emptyBundle(), DF, [planFig('A', DetailSubject.SANITARY, { front: 'B' })]);
    const r = reexpandTransitiveDetailFigures(recovered, lib, { viewOrigins: new Set(['A']) });
    assert.deepEqual(bundleEntries(r.bundle, DF).map(e => e.key).sort(), ['A', 'B']);
    assert.equal(r.unresolvedDetailFigureKeys.size, 0);
    const none = reexpandTransitiveDetailFigures(recovered, lib);
    assert.deepEqual(bundleEntries(none.bundle, DF).map(e => e.key), ['A'], '起点を渡さなければ束の図は起点にならない');
  });

  test('views 回収経路(viewOrigins): views の先が DXF 由来なら外し、未解決にも数えない。ライブラリに無い先は未解決として返る', () => {
    const lib = new Map([
      ['B', { ...elevFig('B'), provenance: { source: DetailProvenanceSource.DXF } }], ['C', elevFig('C')],
    ]);
    const recovered = withEntries(emptyBundle(), DF, [planFig('A', DetailSubject.SANITARY, { front: 'B', back: 'C', left: 'ghost' })]);
    const r = reexpandTransitiveDetailFigures(recovered, lib, { viewOrigins: ['A'] });
    assert.deepEqual(bundleEntries(r.bundle, DF).map(e => e.key).sort(), ['A', 'C']);
    assert.equal(r.unresolvedDetailFigureKeys.size, 0, '参照切れ(ghost)は辿らず、DXF 由来は未解決に数えない');
  });

  test('views: excludeImported のときは views の先の外部由来(DXF)の図も外す。既定では入る', () => {
    const resolved = resolvedOf([
      planFig('A', DetailSubject.SANITARY, { front: 'B', back: 'C' }),
      { ...elevFig('B'), provenance: { source: DetailProvenanceSource.DXF } }, elevFig('C'),
    ]);
    assert.deepEqual([...expandUsedDetailFiguresTransitively(usedOf(['A']), resolved, { excludeImported: true }).get(DF)].sort(), ['A', 'C']);
    assert.deepEqual([...expandUsedDetailFiguresTransitively(usedOf(['A']), resolved).get(DF)].sort(), ['A', 'B', 'C']);
  });
}
