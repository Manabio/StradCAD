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

test('【不変条件・ステップ8h・QA指摘Minor-1で更新】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.SECTIONの表示項目（label/materialType/shape/width/height/webThickness/flangeThickness/wallThickness）をfield名で持ち、ReadonlyKindTab（追加・複製・編集・削除・合わせ直しボタン無し）で扱う', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const m = /\[CatalogKind\.SECTION\]: Object\.freeze\(\[([\s\S]*?)\]\),/.exec(src);
  assert.ok(m, 'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.SECTION] が見つからない');
  const body = m[1];
  for (const field of [
    'label', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness',
  ]) {
    assert.ok(
      new RegExp(`'${field}'`).test(body),
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

// ---- ステップ8i: 断面の「規格文字列から追加」（一括入力）はcatalog/catalogMaintenance.jsの
// planBulkSectionImport・commitUserEntries経由。.jsx側にパーサ（×/x/X分割等）を直書きしない ----
test('【不変条件・ステップ8i】ui/CatalogMaintenancePanel.jsx: 断面の一括入力はplanBulkSectionImport・commitUserEntries経由で、パーサをjsxへ直書きしていない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/\bplanBulkSectionImport\(/.test(src), 'CatalogMaintenancePanel.jsx が planBulkSectionImport を呼んでいない');
  assert.ok(
    /commitUserEntries\(\s*CatalogKind\.SECTION/.test(src),
    'CatalogMaintenancePanel.jsx が commitUserEntries(CatalogKind.SECTION, …) を呼んでいない',
  );
  assert.ok(
    /from ['"]\.\.\/structural\/sectionCatalog\.js['"]/.test(src),
    'CatalogMaintenancePanel.jsx が structural/sectionCatalog.js から parseSectionSpecList を import していない',
  );
  assert.ok(
    /\bparseSpecList:\s*parseSectionSpecList\b/.test(src),
    'CatalogMaintenancePanel.jsx が parseSectionSpecList を planBulkSectionImport へ注入していない',
  );
  // パーサの直書き（区切り文字の分割・正規表現でのH/□判定）が.jsx側に無いことを確認する
  // （parseSectionSpecList/parseSectionSpecに一本化する契約。汎用の正規表現使用自体は他機能に
  // あるため、断面規格表記特有の区切り正規表現 /[×xX]/ が無いことだけを見る）。
  assert.ok(!/\[×xX\]/.test(src), 'CatalogMaintenancePanel.jsx に断面規格表記の区切り正規表現が直書きされている（parseSectionSpecList経由への一本化への退行）');
});

test('【不変条件・ステップ8i】ui/CatalogMaintenancePanel.jsx: SectionBulkImportは断面タブ（CatalogKind.SECTION）専用で、他の閲覧タブには出ない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /kind === CatalogKind\.SECTION[\s\S]{0,80}<SectionBulkImport/.test(src),
    'SectionBulkImportがCatalogKind.SECTION条件付きでレンダーされていない',
  );
});

// ---- ステップ10f: 建具種別（openingSubType）の閲覧タブ（内装マスター・境界マスター・断面と
// 同じReadonlyKindTabに相乗り。姿図プレビューはCatalogPreviewへ無条件に配線済みのため追加配線ゼロ） ----
test('【不変条件・ステップ10f】catalog/catalogMaintenance.js: buildKindTabsでopeningSubTypeがenabled:true（閲覧タブ）', () => {
  const src = readSrc('catalog/catalogMaintenance.js');
  const m = /const VIEWABLE_KINDS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, 'catalogMaintenance.js に VIEWABLE_KINDS が見つからない');
  assert.ok(/CatalogKind\.OPENING_SUB_TYPE/.test(m[1]), 'VIEWABLE_KINDS に CatalogKind.OPENING_SUB_TYPE が含まれていない（建具種別タブが閲覧できない）');
});

test('【不変条件・ステップ10f・QA指摘Minor-1で更新】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.OPENING_SUB_TYPEの表示項目（label/category/mechanism/wallKinds/defaultWidth/defaultHeight/childRatio/fireLeaves/fireAngle/slideLayout）をfield名で持ち、ReadonlyKindTab（追加・複製・編集・削除・合わせ直しボタン無し）で扱う', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const m = /\[CatalogKind\.OPENING_SUB_TYPE\]: Object\.freeze\(\[([\s\S]*?)\]\),/.exec(src);
  assert.ok(m, 'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.OPENING_SUB_TYPE] が見つからない');
  const body = m[1];
  for (const field of [
    'label', 'category', 'mechanism', 'wallKinds', 'defaultWidth', 'defaultHeight',
    'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout',
  ]) {
    assert.ok(
      new RegExp(`'${field}'`).test(body),
      `READONLY_KIND_FIELDS[CatalogKind.OPENING_SUB_TYPE] に ${field} が無い`,
    );
  }
  // ReadonlyKindTabはREADONLY_KIND_FIELDSに載る種別を汎用に扱う唯一のコンポーネント——上の
  // ステップ7dテストが既に「追加・複製・削除・保存・合わせ直しの操作系ハンドラを呼んでいない」
  // ことを固定しているため、建具種別用の専用ボタンを別途持たないことはその不変条件がそのまま覆う。
  const fnMatch = /function ReadonlyKindTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に ReadonlyKindTab コンポーネントが見つからない');
});

// ---- ステップ10f: READONLY_KIND_FIELDSの値整形は.jsx側に判断を残さず
// catalog/catalogMaintenance.jsのformatReadonlyValue（汎用の配列/plainオブジェクト整形）に委ねる ----
test('【不変条件・ステップ10f】ui/CatalogMaintenancePanel.jsx: formatReadonlyFieldValueの汎用フォールバックはcatalog/catalogMaintenance.jsのformatReadonlyValue経由（配列/plainオブジェクトの整形を.jsx側で再実装しない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src) && /\bformatReadonlyValue\b/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js の formatReadonlyValue を import・使用していない',
  );
  const fnMatch = /function formatReadonlyFieldValue\([\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に formatReadonlyFieldValue 関数が見つからない');
  // Array.isArray直書きはlayers専用分岐の1箇所だけであること（汎用の配列判定を新設していない証跡）。
  const arrayIsArrayCount = (fnMatch[0].match(/Array\.isArray\(/g) ?? []).length;
  assert.equal(arrayIsArrayCount, 1, 'formatReadonlyFieldValue にArray.isArrayの直書きがlayers専用分岐以外にもある（formatReadonlyValue経由への一本化への退行）');
});

// ---- QA指摘Minor-1（2026-09-23）: 項目ラベルはcatalog/catalogDiffView.jsのFIELD_LABELS
// （「唯一の定義箇所」）に一本化し、READONLY_KIND_FIELDSはfield名の配列だけを持つ
// （ツールチップ(diffTooltip)と詳細欄で別名が同時に出る二重定義への退行を検知する） ----
test('【不変条件・QA指摘Minor-1・2026-09-23】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSはfield名の配列のみを持ち、ラベル文字列を直書きしない（ラベルはcatalog/catalogDiffView.jsのfieldLabel経由）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const m = /const READONLY_KIND_FIELDS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(m, 'CatalogMaintenancePanel.jsx に READONLY_KIND_FIELDS が見つからない');
  assert.ok(
    !/field:\s*'/.test(m[1]),
    'READONLY_KIND_FIELDS が { field: ..., label: ... } 形式のまま残っている（field名の配列への一本化への退行）',
  );
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogDiffView\.js['"]/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogDiffView.js を import していない',
  );
  // コメント中の言及だけでは満たされないよう、ReadonlyKindTab関数本体（実際のJSXレンダー）の
  // 中で fieldLabel(kind, field) を呼んでいることを確認する（whole-source検索だとコメント文中の
  // 「fieldLabel(kind, field)」という言及だけで誤って緑になる——変異テストで実際に検知漏れを確認済み）。
  const fnMatch = /function ReadonlyKindTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に ReadonlyKindTab コンポーネントが見つからない');
  assert.ok(
    /\{fieldLabel\(kind,\s*field\)\}/.test(fnMatch[0]),
    'ReadonlyKindTab が fieldLabel(kind, field) をJSXレンダーで呼んでいない（ラベルの二重定義・直書きへの退行）',
  );
});

// ---- QA指摘Minor-2（2026-09-23）: category値→表示名の対応はcatalog/catalogMaintenance.jsの
// formatCategoryLabel(kind, value)に一本化し、.jsx側にmaterial用・openingSubType用の重複した
// 対応表（CATEGORY_LABELS/OPENING_CATEGORY_LABELS）を持たない ----
test('【不変条件・QA指摘Minor-2・2026-09-23】ui/CatalogMaintenancePanel.jsx: category表示はcatalog/catalogMaintenance.jsのformatCategoryLabel(kind, value)経由で、.jsx側に対応表を直書きしない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src) && /\bformatCategoryLabel\(/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js の formatCategoryLabel を呼んでいない',
  );
  assert.ok(
    !/CATEGORY_LABELS\s*=\s*Object\.freeze/.test(src),
    'CatalogMaintenancePanel.jsx に CATEGORY_LABELS/OPENING_CATEGORY_LABELS 相当の対応表が直書きされている（formatCategoryLabel経由への一本化への退行）',
  );
  // formatReadonlyFieldValue(kind, field, value) が category を kind 付きで判定していること
  // （field名だけの判定はmaterial/openingSubTypeの衝突を招く——上のQA指摘Minor-2本体）。
  assert.ok(
    /function formatReadonlyFieldValue\(kind, field, value\)/.test(src),
    'formatReadonlyFieldValue が kind を引数に取っていない（categoryの種別間衝突への退行）',
  );
  // category分岐がformatCategoryLabel(kind, value)への単純委譲であること（種別ごとの分岐や
  // 対応表をこの分岐内に直書きする退行——例:「materialだけ別の対応表を条件分岐で使う」——を検知する）。
  assert.ok(
    /if \(field === 'category'\) \{\s*return formatCategoryLabel\(kind, value\);\s*\}/.test(src),
    'formatReadonlyFieldValue の category 分岐が formatCategoryLabel(kind, value) への単純委譲になっていない（種別別の対応表・条件分岐の直書きへの退行）',
  );
});
