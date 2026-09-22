// catalogOverlayLoader.js の単体テスト（2026-09-22 QA指摘B）。store.js を import せず、
// loadDocumentCatalogs/loadUserCatalogs/onError（＋防御用の setOverlayFn 等）を注入して検証する。
// node:test はファイル単位で別プロセスのため、catalogRegistry.js の overlay 状態は
// このファイル内で共有される（test.afterEach で毎回 clearOverlays）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogOverlaysFromIDB } from './catalogOverlayLoader.js';
import { setOverlay, clearOverlays, overlayFor, composeCatalog } from './catalogRegistry.js';
import { encodeCatalogBundle } from './catalogCodec.js';
import { emptyBundle, withEntries, withAlias } from './catalogBundle.js';
import { currentCodeTable, setDocumentCodeTable } from './codeNormalization.js';
import { CatalogKind } from './catalogKinds.js';

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

function section(overrides) {
  return { key: 'S1', materialType: 'STEEL', shape: 'H', width: 200, height: 100, label: 'H-200x100', ...overrides };
}

test.afterEach(() => {
  clearOverlays();
  setDocumentCodeTable(null);
});

function makeDeps(overrides) {
  const calls = { errors: [] };
  return {
    calls,
    deps: {
      loadDocumentCatalogs: async () => [],
      loadUserCatalogs: async () => [],
      onError: (msg) => calls.errors.push(msg),
      ...overrides,
    },
  };
}

// ---- 正常系 ----
test('正常: 文書同梱・ユーザーライブラリのレコードがoverlayとして設定され、onErrorは呼ばれない', async () => {
  const docEntry = material({ code: '301000000010', name: '文書同梱材' });
  const userEntry = material({ code: '301000000011', name: 'ユーザー材' });
  const docBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [docEntry]);
  const userBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [userEntry]);

  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(docBundle) }],
    loadUserCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(userBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.deepEqual(calls.errors, []);
  const overlay = overlayFor(CatalogKind.MATERIAL);
  assert.deepEqual(overlay.doc, [docEntry]);
  assert.deepEqual(overlay.user, [userEntry]);
  assert.deepEqual(composeCatalog(CatalogKind.MATERIAL, []).get('301000000010'), docEntry);
});

test('正常: 束のaliases.materialがsetDocumentCodeTableへ渡る', async () => {
  const docBundle = withAlias(
    withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]),
    CatalogKind.MATERIAL, '111111111150', '301000000001',
  );
  const { deps } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(docBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  const table = currentCodeTable();
  assert.equal(table.get('111111111150'), '301000000001');
});

// ---- 壊れたレコード ----
test('【失敗系】壊れたレコード（decodeCatalogBundle失敗＝不正なJSON）→ overlayは立たずonErrorが呼ばれる', async () => {
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1);
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL), { doc: [], user: [] });
});

test('【失敗系】壊れたレコード（decode自体は通るがvalidateBundle失敗＝キー重複）→ overlayは立たずonErrorが呼ばれる', async () => {
  const dupBundle = {
    version: 1,
    catalogs: { material: [material({ code: '301000000001' }), material({ code: '301000000001', name: '別名' })] },
    encodings: { material: 'json' }, aliases: {},
  };
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(dupBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1, 'validateBundleのキー重複検出でonErrorが呼ばれる（validateBundleが実際に通っている証跡）');
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL), { doc: [], user: [] });
});

// 2026-09-22 再QA指摘Minor-A: 外側のcatch（decode/validate失敗。setOverlayへ到達する前）でも
// clearOverlaysFn/setDocumentCodeTableFnが呼ばれることを確認する（内側catchと同じ後始末）。
test('【失敗系・Minor-A】壊れたレコード（decode失敗。setOverlayへ到達する前）でも外側catchでclearOverlaysFn/setDocumentCodeTableFnが呼ばれる', async () => {
  let clearCalls = 0;
  const setTableCalls = [];
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') }],
    clearOverlaysFn: () => { clearCalls++; clearOverlays(); },
    setDocumentCodeTableFn: (v) => { setTableCalls.push(v); setDocumentCodeTable(v); },
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1);
  assert.equal(clearCalls, 1, '外側catch（decode失敗）でclearOverlaysFnが呼ばれていない');
  assert.deepEqual(setTableCalls, [null], '外側catch（decode失敗）でsetDocumentCodeTableFn(null)が呼ばれていない');
});

test('【失敗系】文書同梱レコードが壊れていれば、他の（正常な）ユーザーライブラリのレコードもoverlayに立たない（部分適用しない）', async () => {
  const userBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [section()]);
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') }],
    loadUserCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(userBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1);
  assert.deepEqual(overlayFor(CatalogKind.SECTION), { doc: [], user: [] }, '正常なsectionレコードも含めてoverlayが一切立っていない');
});

// ---- 未知種別 ----
test('未知種別を含む: 既知種別（material）はoverlayが立ち、未知種別レコードは触らずエラーも出ない', async () => {
  const materialBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]);
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [
      { kind: '将来の種別', bytes: new TextEncoder().encode('{completely invalid, not even json') },
      { kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(materialBundle) },
    ],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.deepEqual(calls.errors, [], '未知種別の壊れたバイト列はdecodeすら試みないのでエラーにならない');
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [material()]);
});

// ---- setOverlayが投げる（防御。通常は起きない）----
test('【失敗系・防御】setOverlayが例外を投げたら、他種別の既存overlayも含め全clearされ、onErrorが呼ばれる', async () => {
  // 呼び出し前に別種別(section)へ既存overlayを立てておく——clearOverlays()が本当に「全種別」を
  // 消すことを確認するため（対象のmaterialだけをdeleteする実装への退行を検知する）。
  setOverlay(CatalogKind.SECTION, { user: [section()] });
  assert.deepEqual(overlayFor(CatalogKind.SECTION).user, [section()]); // 前提

  const materialBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]);
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(materialBundle) }],
    setOverlayFn: () => { throw new Error('setOverlay防御テスト用の強制例外'); },
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /強制例外/);
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL), { doc: [], user: [] }, 'materialにoverlayが残っていない');
  assert.deepEqual(overlayFor(CatalogKind.SECTION), { doc: [], user: [] }, '呼び出し前から立っていたsectionのoverlayも消えている（全clearの証跡）');
});
