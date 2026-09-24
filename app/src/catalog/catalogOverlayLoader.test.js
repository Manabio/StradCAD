// catalogOverlayLoader.js の単体テスト（2026-09-22 QA指摘B）。store.js を import せず、
// loadDocumentCatalogs/loadUserCatalogs/onError（＋防御用の setOverlayFn 等）を注入して検証する。
// node:test はファイル単位で別プロセスのため、catalogRegistry.js の overlay 状態は
// このファイル内で共有される（test.afterEach で毎回 clearOverlays）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogOverlaysFromIDB } from './catalogOverlayLoader.js';
import { setOverlay, clearOverlays, overlayFor, composeCatalog, isOverlayUntrusted, markOverlayUntrusted } from './catalogRegistry.js';
import { encodeCatalogBundle } from './catalogCodec.js';
import { emptyBundle, withEntries, withAlias } from './catalogBundle.js';
import { currentCodeTable, clearDocumentAliases, setDocumentAliases, applyDocumentCodeNormalization } from './codeNormalization.js';
import { CatalogKind } from './catalogKinds.js';
// ステップ14-S QA指摘Major-1: 移行後のsectionDefId参照がfindSectionEntryで実際に引けることを
// 確認するため（テストファイルはstructural/sectionCatalog.jsを静的importしてよい——
// catalogImports.test.jsの許可リストはcatalog/*.js本体のみが対象で、*.test.jsは対象外）。
import { findSectionEntry } from '../structural/sectionCatalog.js';

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901', x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

function section(overrides) {
  return { key: 'S1', materialType: 'STEEL', shape: 'H', width: 200, height: 100, label: 'H-200x100', ...overrides };
}

function interiorMaster(overrides) {
  return { key: 'LIVING', label: 'LDK', wallMaterial: '301000000001', wallFinish: '301000000001', ceilingHeight: 2400, ...overrides };
}

test.afterEach(() => {
  clearOverlays();
  clearDocumentAliases();
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

test('正常: 束のaliases.materialがsetDocumentAliases経由でcurrentCodeTableへ渡る', async () => {
  const docBundle = withAlias(
    withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]),
    CatalogKind.MATERIAL, '111111111150', '301000000001',
  );
  const { deps } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(docBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  const table = currentCodeTable(CatalogKind.MATERIAL);
  assert.equal(table.get('111111111150'), '301000000001');
});

// ---- ステップ7a Minor: 全種別ぶんsetDocumentAliasesFnが呼ばれる（material限定への退行を検知）----
test('正常: doc束がmaterialとinteriorMasterの両方にaliasesを持つとき、setDocumentAliasesFnが両kindで呼ばれる', async () => {
  const materialDoc = withAlias(
    withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]),
    CatalogKind.MATERIAL, '111111111150', '301000000001',
  );
  const interiorDoc = withAlias(
    withEntries(emptyBundle(), CatalogKind.INTERIOR_MASTER, [interiorMaster()]),
    CatalogKind.INTERIOR_MASTER, 'OLD_LIVING', 'LIVING',
  );
  const setAliasesCalls = [];
  const { deps } = makeDeps({
    loadDocumentCatalogs: async () => [
      { kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(materialDoc) },
      { kind: CatalogKind.INTERIOR_MASTER, bytes: encodeCatalogBundle(interiorDoc) },
    ],
    setDocumentAliasesFn: (kind, aliases) => { setAliasesCalls.push({ kind, aliases }); setDocumentAliases(kind, aliases); },
  });
  await loadCatalogOverlaysFromIDB(deps);

  const byKind = new Map(setAliasesCalls.map(c => [c.kind, c.aliases]));
  assert.deepEqual(byKind.get(CatalogKind.MATERIAL), { '111111111150': '301000000001' });
  assert.deepEqual(byKind.get(CatalogKind.INTERIOR_MASTER), { OLD_LIVING: 'LIVING' });
  assert.equal(currentCodeTable(CatalogKind.MATERIAL).get('111111111150'), '301000000001');
  assert.equal(currentCodeTable(CatalogKind.INTERIOR_MASTER).get('OLD_LIVING'), 'LIVING');
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
// clearOverlaysFn/clearDocumentAliasesFnが呼ばれることを確認する（内側catchと同じ後始末）。
test('【失敗系・Minor-A】壊れたレコード（decode失敗。setOverlayへ到達する前）でも外側catchでclearOverlaysFn/clearDocumentAliasesFnが呼ばれる', async () => {
  let clearCalls = 0;
  let clearAliasesCalls = 0;
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') }],
    clearOverlaysFn: () => { clearCalls++; clearOverlays(); },
    clearDocumentAliasesFn: () => { clearAliasesCalls++; clearDocumentAliases(); },
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1);
  assert.equal(clearCalls, 1, '外側catch（decode失敗）でclearOverlaysFnが呼ばれていない');
  assert.equal(clearAliasesCalls, 1, '外側catch（decode失敗）でclearDocumentAliasesFnが呼ばれていない');
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

// ================================================================
// ステップ14-S 裁定2: isOverlayUntrusted（catalogMaintenance.js commitUserEntries の
// 書込みガードが見る単一の関門）が loadCatalogOverlaysFromIDB の成否で立つ／降りる。
// ================================================================

test('正常: 読込みが成功すればisOverlayUntrusted()はfalseに戻る（前回の失敗を引きずらない）', async () => {
  markOverlayUntrusted(true); // 前回の読込みが失敗していた状態を模す
  const materialBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]);
  const { deps } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(materialBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(isOverlayUntrusted(), false);
});

test('【失敗系】壊れたレコードでoverlayが丸ごと諦められたら、isOverlayUntrusted()はtrueになる', async () => {
  assert.equal(isOverlayUntrusted(), false); // 前提
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1);
  assert.equal(isOverlayUntrusted(), true);
});

// ================================================================
// ステップ14-S 裁定1: 修正前parseSectionSpecのバグで作られた負の断面（doc/user束とも）を
// 読込み時に正しい内容へ移行してからoverlayに立てる。
// ================================================================

function buggyHSection(overrides) {
  return {
    key: 'STEEL-H-250x125', materialType: 'STEEL', shape: 'hSection',
    width: 125, height: -250, webThickness: 6, flangeThickness: 9,
    label: 'H--250×125×6×9',
    ...overrides,
  };
}

test('移行: 修正前の断面データ（user束）を読ませても例外にならず、overlayのsection.userに正のキー（STEEL-H250x125）で立つ', async () => {
  const userBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggyHSection()]);
  const { deps, calls } = makeDeps({
    loadUserCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(userBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.deepEqual(calls.errors, [], '移行後は正のエントリになるためvalidateBundleを通り、onErrorは呼ばれない');
  const overlay = overlayFor(CatalogKind.SECTION);
  assert.equal(overlay.user.length, 1);
  assert.equal(overlay.user[0].key, 'STEEL-H250x125');
  assert.equal(overlay.user[0].height, 250);
  assert.equal(isOverlayUntrusted(), false);
});

function buggySquarePipe(overrides) {
  return {
    key: 'STEEL-SQ-200x200x9', materialType: 'STEEL', shape: 'squarePipe',
    width: -200, height: 200, wallThickness: 9,
    label: '□--200×200×9',
    ...overrides,
  };
}

test('移行: 修正前の断面データ（doc束）を読ませても同様に正のキーへ移行される', async () => {
  const docBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggySquarePipe()]);
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(docBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.deepEqual(calls.errors, []);
  const overlay = overlayFor(CatalogKind.SECTION);
  assert.equal(overlay.doc.length, 1);
  assert.equal(overlay.doc[0].key, 'STEEL-SQ200x200x9');
  assert.equal(overlay.doc[0].width, 200);
});

// ================================================================
// QA指摘Major-1（ステップ14-S再指摘）: 移行でキーが変わったらaliasが積まれ、
// codeNormalization.js の rewriteSectionRefs（applyDocumentCodeNormalization経由）で
// sectionDefId参照が新キーへ書き換わり、findSectionEntryが引けるようになる。
// ================================================================

test('【QA指摘Major-1】doc束の移行: 読込み後、columns[].sectionDefId（旧キー参照）がapplyDocumentCodeNormalizationで新キーへ書き換わり、findSectionEntryが非nullになる', async () => {
  const docBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggyHSection()]);
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(docBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.deepEqual(calls.errors, []);

  // 移行前（=修正前parseSectionSpecの出力そのもの）のキーで部材が参照している状況を模す。
  const snapshot = { columns: [{ id: 'c1', sectionDefId: 'STEEL-H-250x125' }] };
  const normalized = applyDocumentCodeNormalization(snapshot);
  assert.equal(normalized.columns[0].sectionDefId, 'STEEL-H250x125', 'sectionDefIdが新キーへ書き換わっていない');
  assert.notEqual(findSectionEntry('STEEL-H250x125'), null, '新キーでfindSectionEntryが引けない（overlayに正しく載っていない）');
});

// ================================================================
// QA指摘Major-2（ステップ14-S再指摘）: 移行後のキーが同じ束に既にある場合、既存の正常な
// エントリを優先し、移行した方は捨てる（alias は捨てても積む）。
// ================================================================

function goodHSection(overrides) {
  return {
    key: 'STEEL-H250x125', materialType: 'STEEL', shape: 'hSection',
    width: 125, height: 250, webThickness: 6, flangeThickness: 9,
    label: 'H-250×125×6×9',
    ...overrides,
  };
}

test('【QA指摘Major-2】user束[bad, good]: onErrorが呼ばれず、untrusted=false・section.userが1件（good）・aliasが積まれる', async () => {
  const userBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggyHSection(), goodHSection()]);
  const { deps, calls } = makeDeps({
    loadUserCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(userBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.deepEqual(calls.errors, [], 'onErrorが呼ばれた＝重複キーでvalidateBundleが落ちている（既存優先で回避できていない）');
  assert.equal(isOverlayUntrusted(), false);
  const overlay = overlayFor(CatalogKind.SECTION);
  assert.equal(overlay.user.length, 1, 'section.userが1件になっていない（既存goodを残して重複を解消できていない）');
  assert.equal(overlay.user[0].key, 'STEEL-H250x125');
  assert.equal(currentCodeTable(CatalogKind.SECTION)?.get('STEEL-H-250x125'), 'STEEL-H250x125', '捨てた場合もaliasが積まれていない');
});

test('【QA指摘Major-2】doc束[bad, good]でも同様: onErrorが呼ばれず、section.docが1件（good）・aliasが積まれる', async () => {
  const docBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggyHSection(), goodHSection()]);
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(docBundle) }],
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.deepEqual(calls.errors, []);
  assert.equal(isOverlayUntrusted(), false);
  const overlay = overlayFor(CatalogKind.SECTION);
  assert.equal(overlay.doc.length, 1);
  assert.equal(overlay.doc[0].key, 'STEEL-H250x125');
  assert.equal(currentCodeTable(CatalogKind.SECTION)?.get('STEEL-H-250x125'), 'STEEL-H250x125');
});

// ================================================================
// QA指摘Minor-2（ステップ14-S再指摘）: 移行があれば利用者向けの通知（onNotice）を1回呼ぶ
// （console.warnだけでは利用者に見えないため）。
// ================================================================

test('【QA指摘Minor-2】移行があるとonNoticeが1回呼ばれ、文言に旧キーと新キーを含む', async () => {
  const docBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggyHSection()]);
  const noticeCalls = [];
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(docBundle) }],
    onNotice: (msg) => noticeCalls.push(msg),
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.deepEqual(calls.errors, []);
  assert.equal(noticeCalls.length, 1, 'onNoticeが1回呼ばれていない');
  assert.match(noticeCalls[0], /STEEL-H-250x125/, '通知文に旧キーが含まれていない');
  assert.match(noticeCalls[0], /STEEL-H250x125/, '通知文に新キーが含まれていない');
});

test('【QA指摘Minor-2】移行が無ければonNoticeは呼ばれない', async () => {
  const materialBundle = withEntries(emptyBundle(), CatalogKind.MATERIAL, [material()]);
  const noticeCalls = [];
  const { deps } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: encodeCatalogBundle(materialBundle) }],
    onNotice: (msg) => noticeCalls.push(msg),
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.deepEqual(noticeCalls, []);
});

test('【QA指摘Minor-2】読込みが最終的に失敗したらonNoticeは呼ばれない（overlayが結局立たないため）', async () => {
  const noticeCalls = [];
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [{ kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') }],
    onNotice: (msg) => noticeCalls.push(msg),
  });
  await loadCatalogOverlaysFromIDB(deps);
  assert.equal(calls.errors.length, 1);
  assert.deepEqual(noticeCalls, []);
});

// QA再々指摘Minor-4: 移行対象（section）と壊れたレコード（material）を同じ読込みに混ぜても、
// 移行が「途中まで進んだから」onNoticeが漏れ出さないことを固定する——decodeAndValidateは
// .map()で全レコードを先に処理するため、section側の移行でmigratedNoticesへ積んだ直後に
// material側の decodeCatalogBundle が例外を投げると、.map() 自体が例外で中断し外側catchへ
// 落ちる。この経路でonNoticeが（部分的にでも）呼ばれてはいけない。
test('【QA指摘Minor-4】loader: 移行対象のsection束と壊れたmaterialレコードを一緒に読ませると、onErrorが1回・onNoticeは0回・untrustedはtrueになる', async () => {
  const sectionBundle = withEntries(emptyBundle(), CatalogKind.SECTION, [buggyHSection()]);
  const noticeCalls = [];
  const { deps, calls } = makeDeps({
    loadDocumentCatalogs: async () => [
      { kind: CatalogKind.SECTION, bytes: encodeCatalogBundle(sectionBundle) },
      { kind: CatalogKind.MATERIAL, bytes: new TextEncoder().encode('{not-json') },
    ],
    onNotice: (msg) => noticeCalls.push(msg),
  });
  await loadCatalogOverlaysFromIDB(deps);

  assert.equal(calls.errors.length, 1, 'onErrorが1回呼ばれていない');
  assert.deepEqual(noticeCalls, [], 'onNoticeが呼ばれてはいけない（読込みが最終的に失敗しているため）');
  assert.equal(isOverlayUntrusted(), true, 'untrustedがtrueになっていない');
  assert.deepEqual(overlayFor(CatalogKind.SECTION), { doc: [], user: [] }, '正常だったsection側もoverlayに立っていない（部分適用しない契約）');
});
