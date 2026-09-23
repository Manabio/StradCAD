// カタログ保守パネル（ステップ5・ハンバーガー「カタログ保守」）の配線を固定する不変条件テスト
// （catalogRegistryWiring.test.js と同型——ソーステキストの正規表現検査）。
// 純ロジック（一覧の合成・検索・採番・検証）自体は catalogMaintenance.test.js が検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(appSrc, rel), 'utf8');
}

test('【不変条件・ステップ5】ui/HamburgerMenu.jsx: 「カタログ保守」項目（id: catalog-maintenance）を持つ', () => {
  const src = readSrc('ui/HamburgerMenu.jsx');
  assert.ok(
    /id:\s*'catalog-maintenance'\s*,\s*label:\s*'カタログ保守'/.test(src),
    'HamburgerMenu.jsx に { id: \'catalog-maintenance\', label: \'カタログ保守\' } 項目が無い',
  );
});

test('【不変条件・ステップ5】App.jsx: handleHamburgerSelectがid===\'catalog-maintenance\'を処理している', () => {
  const src = readSrc('App.jsx');
  const m = /function handleHamburgerSelect\(id\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(m, 'App.jsx に handleHamburgerSelect 関数が見つからない');
  assert.ok(
    /id === 'catalog-maintenance'/.test(m[1]),
    'handleHamburgerSelect が catalog-maintenance を分岐していない',
  );
});

// QA指摘Major-B（2026-09-22）: React.lazy+SuspenseはErrorBoundaryが無いとチャンク読込み失敗時に
// root全体が白画面になるため不採用——EccentricityDialog.jsx等と同じ「import().then().catch()」型
// （失敗はtoast通知）に揃える。lazy(が全く現れないことも固定する（Suspense方式への再退行を検知）。
test('【不変条件・ステップ5・QA指摘Major-B】App.jsx: CatalogMaintenancePanelを動的import（import().then().catch()）で開き、失敗時はトースト通知する', () => {
  const src = readSrc('App.jsx');
  assert.ok(
    !/\blazy\(/.test(src),
    'App.jsx に lazy( が残っている（React.lazy+Suspense方式への退行。ErrorBoundary無しで白画面になる）',
  );
  assert.ok(
    !/^\s*import\s+\{[^}]*CatalogMaintenancePanel[^}]*\}\s+from\s+['"]\.\/ui\/CatalogMaintenancePanel\.jsx['"]/m.test(src),
    'App.jsx が CatalogMaintenancePanel.jsx を静的importしている（全画面パネルは動的importする契約への退行）',
  );
  const m = /if \(id === 'catalog-maintenance'\) \{([\s\S]*?)\n {4}\}/.exec(src);
  assert.ok(m, 'App.jsx の handleHamburgerSelect に catalog-maintenance 分岐本体が見つからない');
  const body = m[1];
  assert.ok(
    /import\(['"]\.\/ui\/CatalogMaintenancePanel\.jsx['"]\)/.test(body),
    'catalog-maintenance 分岐が CatalogMaintenancePanel.jsx を動的importしていない',
  );
  assert.ok(/\.then\(/.test(body), 'catalog-maintenance 分岐に .then(...) が無い');
  assert.ok(/\.catch\(/.test(body), 'catalog-maintenance 分岐に .catch(...)（読込み失敗の処理）が無い');
  assert.ok(
    /setToast\(\{\s*msg:\s*'[^']*読み込みに失敗/.test(body),
    'catalog-maintenance 分岐の .catch が setToast で読込み失敗をトースト通知していない',
  );
});

// QA指摘Minor（再指摘）: commitUserEntriesはcatalogMaintenance.js側へ移設し、永続化I/O
// （storage/db.js saveUserCatalog）はsaveFnとして注入する（catalogOverlayLoader.jsと同じDI型）。
// .jsx側はsaveUserCatalogを直接呼ばず、saveFnとして参照を渡すだけ。
test('【不変条件・ステップ5】ui/CatalogMaintenancePanel.jsx: storage/db.jsのsaveUserCatalogをcommitUserEntriesへsaveFnとして注入している', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"][^'"]*storage\/db\.js['"]/.test(src),
    'CatalogMaintenancePanel.jsx が storage/db.js を import していない',
  );
  assert.ok(
    /commitUserEntries\([^)]*saveFn:\s*saveUserCatalog/.test(src),
    'CatalogMaintenancePanel.jsx が commitUserEntries へ saveFn: saveUserCatalog を渡していない',
  );
});

test('【不変条件・ステップ5】ui/CatalogMaintenancePanel.jsx: 純ロジックはcatalog/catalogMaintenance.js経由（一覧合成・採番・検証・永続化の手順を.jsx側で再実装しない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js を import していない',
  );
  for (const fn of ['buildMaterialRows', 'validateMaterialEntry', 'nextMaterialCode', 'commitUserEntries']) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(src), `CatalogMaintenancePanel.jsx が ${fn} を呼んでいない`);
  }
  // QA指摘Minor4: 採番（nextSerial）・重複検査（assertNoDuplicate）はcatalogMaintenance.js側の
  // 責務——.jsx側で直書きして再実装（二重実装）しない。
  assert.ok(!/\bnextSerial\(/.test(src), 'CatalogMaintenancePanel.jsx が nextSerial を直接呼んでいる（catalogMaintenance.js経由に一本化する契約への退行）');
  assert.ok(!/\bassertNoDuplicate\(/.test(src), 'CatalogMaintenancePanel.jsx が assertNoDuplicate を直接呼んでいる（catalogMaintenance.js経由に一本化する契約への退行）');
});

// ---- ステップ6b（4.7 合わせ直し）: 「本体の内容に合わせ直す」はcatalogMaintenance.js/catalogRegistry.js
// 経由（.jsx側で差分判定・overlay操作を再実装しない）----
test('【不変条件・ステップ6b】ui/CatalogMaintenancePanel.jsx: 「本体の内容に合わせ直す」はcatalog/catalogMaintenance.jsのplanRealignとcatalog/catalogRegistry.jsのremoveDocEntry経由', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js を import していない');
  assert.ok(/\bplanRealign\(/.test(src), 'CatalogMaintenancePanel.jsx が planRealign を呼んでいない');
  assert.ok(/from ['"]\.\.\/catalog\/catalogRegistry\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が catalog/catalogRegistry.js を import していない');
  assert.ok(/\bremoveDocEntry\(/.test(src), 'CatalogMaintenancePanel.jsx が removeDocEntry を呼んでいない');
  // 差分判定（diffEntries/valuesEqual）はcatalogMatch.jsの責務——.jsxが直接importして再実装しない
  // （docDiffMap/diffPairs/planRealignの間接経由に一本化する契約）。
  assert.ok(
    !/from ['"]\.\.\/catalog\/catalogMatch\.js['"]/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMatch.js を直接importしている（差分判定の直書きへの退行）',
  );
});

test('【不変条件・ステップ6b】ui/CatalogMaintenancePanel.jsx: 合わせ直し承認でdirtyState.jsのmarkDirtyを呼ぶ（removeDocEntryはoverlayのみ変えるI/O無し操作のため明示的にdirty化する）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/from ['"]\.\.\/dirtyState\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が ../dirtyState.js を import していない');
  assert.ok(/\bmarkDirty\(\)/.test(src), 'CatalogMaintenancePanel.jsx が markDirty() を呼んでいない');
});

// ---- QA指摘Minor（2026-09-23）: 一括対象の絞り込みはcatalogMaintenance.jsのrealignTargets経由 ----
test('【不変条件・QA指摘Minor-1・2026-09-23】ui/CatalogMaintenancePanel.jsx: 一括「合わせ直す」対象はcatalog/catalogMaintenance.jsのrealignTargets経由（.jsx側でr.diffのfilterを直書きしない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/\brealignTargets\(/.test(src), 'CatalogMaintenancePanel.jsx が realignTargets を呼んでいない');
  assert.ok(
    !/\.filter\(\s*r\s*=>\s*r\.diff\s*\)/.test(src),
    'CatalogMaintenancePanel.jsx が r.diff の filter を直書きしている（realignTargets経由への一本化への退行）',
  );
});

// ---- QA指摘Minor-2（2026-09-23）: 一括ボタンのラベルに絞り込み無関係の旨を明記 ----
test('【不変条件・QA指摘Minor-2・2026-09-23】ui/CatalogMaintenancePanel.jsx: 一括「合わせ直す」ボタンのラベルに「絞り込みに関わらず全件」を明記する', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/絞り込みに関わらず全件/.test(src), 'CatalogMaintenancePanel.jsx の一括ボタンラベルに「絞り込みに関わらず全件」の文言が無い');
});

test('【不変条件・ステップ5】materialData.js: CatalogMaintenancePanel.jsxからも動的importのみ（静的import禁止。独立チャンク維持）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const staticImportLines = src.split(/\r?\n/).filter(l => /^\s*import /.test(l));
  assert.ok(
    !staticImportLines.some(l => /materialData\.js/.test(l)),
    'CatalogMaintenancePanel.jsx が materialData.js を静的importしている（独立チャンク維持の退行）',
  );
  assert.ok(
    /import\(['"][^'"]*materialData\.js['"]\)/.test(src),
    'CatalogMaintenancePanel.jsx が materialData.js を動的import(...)していない',
  );
});

// ---- ステップ7d: 内装マスター・境界マスターの閲覧タブ（読み取り専用。追加・複製・編集・削除・
// 合わせ直しの手段を持たない） ----
test('【不変条件・ステップ7d】ui/CatalogMaintenancePanel.jsx: buildKindTabsをbuildCatalogRows経由の閲覧タブ（ReadonlyKindTab）に配線し、追加・削除・合わせ直しの操作系を持たない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js を import していない');
  assert.ok(/\bbuildCatalogRows\(/.test(src), 'CatalogMaintenancePanel.jsx が buildCatalogRows を呼んでいない（閲覧タブの一覧合成が欠落）');
  assert.ok(/\bkindDef\(\s*activeKind\s*\)\.loadBuiltin\(\)/.test(src), 'CatalogMaintenancePanel.jsx が閲覧タブのbuiltin一覧を kindDef(activeKind).loadBuiltin() で読んでいない');

  const fnMatch = /function ReadonlyKindTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に ReadonlyKindTab コンポーネントが見つからない');
  const body = fnMatch[0];
  assert.ok(
    !/handleAddNew|handleDuplicateClick|handleDeleteConfirmed|handleSave|setRealignConfirm|removeDocEntry\(/.test(body),
    'ReadonlyKindTab が追加・複製・削除・保存・合わせ直しの操作系ハンドラを呼んでいる（閲覧専用の契約への退行）',
  );
  assert.ok(/閲覧のみ/.test(body), 'ReadonlyKindTab に閲覧専用である旨の注記が無い');
});

// ---- ステップ8h: 断面の閲覧タブ（内装マスター・境界マスターと同じReadonlyKindTabに相乗り。
// 専用の編集UIは追加しない） ----
test('【不変条件・ステップ8h】catalog/catalogMaintenance.js: buildKindTabsでsectionがenabled:true（閲覧タブ）', () => {
  const src = readSrc('catalog/catalogMaintenance.js');
  const m = /const VIEWABLE_KINDS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, 'catalogMaintenance.js に VIEWABLE_KINDS が見つからない');
  assert.ok(/CatalogKind\.SECTION/.test(m[1]), 'VIEWABLE_KINDS に CatalogKind.SECTION が含まれていない（断面タブが閲覧できない）');
});

test('【不変条件・ステップ8h】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.SECTIONの表示項目（label/materialType/shape/width/height/webThickness/flangeThickness/wallThickness）を持ち、ReadonlyKindTab（追加・複製・編集・削除・合わせ直しボタン無し）で扱う', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const m = /\[CatalogKind\.SECTION\]: Object\.freeze\(\[([\s\S]*?)\]\),/.exec(src);
  assert.ok(m, 'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.SECTION] が見つからない');
  const body = m[1];
  for (const field of [
    'label', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness',
  ]) {
    assert.ok(
      new RegExp(`field:\\s*'${field}'`).test(body),
      `READONLY_KIND_FIELDS[CatalogKind.SECTION] に ${field} が無い`,
    );
  }
  // ReadonlyKindTabはREADONLY_KIND_FIELDSに載る種別（interiorMaster/boundaryMaster/section）を
  // 汎用に扱う唯一のコンポーネント——上のステップ7dテストが既に「追加・複製・削除・保存・
  // 合わせ直しの操作系ハンドラを呼んでいない」ことを固定しているため、断面用の専用ボタンを
  // 別途持たないことはその不変条件がそのまま覆う（同じ関数に相乗りする設計であることの確認）。
  const fnMatch = /function ReadonlyKindTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に ReadonlyKindTab コンポーネントが見つからない');
});
