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

// catalogRegistryWiring.test.js と同じ趣旨の抽出（ステップ12b QA指摘m4対応で追加。コメント文中の
// 言及ではなく実装本体だけを見るため、対象関数の{}を波かっこの深さで正確に切り出す）。
// signatureは末尾が関数本体開始の'{'まで含む完全な文字列で渡すこと（例:
// 'async function performSave(plan, entryCode, { overridesBuiltin, thicknessChanged }) {'）——
// 引数の分割代入に'{'を含む関数でも、パラメータ内の'{'を本体開始と誤認しないため。
function extractBalancedBody(src, signature) {
  const startIdx = src.indexOf(signature);
  if (startIdx < 0) return null;
  const braceStart = startIdx + signature.length - 1;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

// ステップ14-A1: structural/woodFraming.test.js 等と同じ趣旨のコメント除去（コメント文中の
// 言及だけで「本体が呼んでいる」と誤検知しないよう、文字列リテラルは保持しつつ // と /* */ の
// コメントだけを取り除く）。
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        j += src[j] === '\\' ? 2 : 1;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
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

// ---- ステップ14-A1（課題A1: 「合わせ直す」をkind汎用のuseRealignActionsフックへ切り出し、
// 材料タブはそれに載せ替える）: フック本体・材料タブ本体（CatalogMaintenancePanel）をそれぞれ
// 検査する（ファイル全体のwhole-source検査から絞り込む——コメント文中の言及だけで緑になる
// 誤検知を防ぐ。旧・ステップ6b/QA指摘Minor-1/Minor-2の3テストを差し替え） ----
test('【不変条件・ステップ14-A1】ui/CatalogMaintenancePanel.jsx: useRealignActionsフック本体はcatalog/catalogMaintenance.jsのrealignTargets/realignPlansForとcatalog/catalogRegistry.jsのremoveDocEntry(kind, …)・dirtyState.jsのmarkDirty()を呼ぶ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js を import していない');
  assert.ok(/from ['"]\.\.\/catalog\/catalogRegistry\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が catalog/catalogRegistry.js を import していない');
  assert.ok(/from ['"]\.\.\/dirtyState\.js['"]/.test(src), 'CatalogMaintenancePanel.jsx が ../dirtyState.js を import していない');

  const hookBody = extractBalancedBody(src, 'function useRealignActions(kind, { builtinList, allRows, onRealigned, onError } = {}) {');
  assert.ok(hookBody, 'CatalogMaintenancePanel.jsx に useRealignActions フックが見つからない');
  const hookCode = stripComments(hookBody); // コメント文中の言及だけでは緑にならないよう、実装本体だけを見る
  assert.ok(/\brealignTargets\(/.test(hookCode), 'useRealignActions が realignTargets を呼んでいない');
  assert.ok(/\brealignPlansFor\(/.test(hookCode), 'useRealignActions が realignPlansFor を呼んでいない');
  assert.ok(/\bremoveDocEntry\(kind,/.test(hookCode), 'useRealignActions が removeDocEntry(kind, …) を呼んでいない');
  assert.ok(/\bmarkDirty\(\)/.test(hookCode), 'useRealignActions が markDirty() を呼んでいない');

  // 差分判定（diffEntries/valuesEqual）はcatalogMatch.jsの責務——.jsxが直接importして再実装しない
  // （docDiffMap/diffPairs/planRealign/realignPlansForの間接経由に一本化する契約）。
  assert.ok(
    !/from ['"]\.\.\/catalog\/catalogMatch\.js['"]/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMatch.js を直接importしている（差分判定の直書きへの退行）',
  );
});

test('【不変条件・ステップ14-A1】ui/CatalogMaintenancePanel.jsx: 材料タブ本体（CatalogMaintenancePanel）はuseRealignActions(CatalogKind.MATERIAL, …)を呼び、<RealignConfirmBlockを1回だけ描く（一括ボタンのラベルに絞り込み無関係の旨を明記し、r.diffのfilterを直書きしない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'export function CatalogMaintenancePanel({ onClose }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に CatalogMaintenancePanel コンポーネントが見つからない');
  const code = stripComments(body); // コメント文中の言及だけでは緑にならないよう、実装本体だけを見る（QA指摘Major-1）
  assert.ok(
    /useRealignActions\(CatalogKind\.MATERIAL,/.test(code),
    'CatalogMaintenancePanel が useRealignActions(CatalogKind.MATERIAL, …) を呼んでいない',
  );
  const realignBlockCount = (code.match(/<RealignConfirmBlock\b/g) ?? []).length;
  assert.equal(realignBlockCount, 1, 'CatalogMaintenancePanel が <RealignConfirmBlock を1回だけ描いていない');
  assert.ok(
    !/\.filter\(\s*r\s*=>\s*r\.diff\s*\)/.test(code),
    'CatalogMaintenancePanel が r.diff の filter を直書きしている（realignTargets経由への一本化への退行）',
  );
  assert.ok(/絞り込みに関わらず全件/.test(code), '一括ボタンのラベルに「絞り込みに関わらず全件」の文言が無い');
});

// ---- QA指摘Minor-2/Minor-3（2026-09-24再報告・ステップ14-A1）: 通知位置・onError不使用の固定 ----
test('【不変条件・QA指摘Minor-3・ステップ14-A1】ui/CatalogMaintenancePanel.jsx: {realign.notice はフォームの外（{form && ( より前）に描かれる（フォームが開いていなくても完了・失敗通知が見える）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'export function CatalogMaintenancePanel({ onClose }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に CatalogMaintenancePanel コンポーネントが見つからない');
  const code = stripComments(body);
  const noticeIdx = code.indexOf('{realign.notice &&');
  const formIdx = code.indexOf('{form && (');
  assert.ok(noticeIdx >= 0, 'CatalogMaintenancePanel が {realign.notice && を描いていない');
  assert.ok(formIdx >= 0, 'CatalogMaintenancePanel が {form && ( を描いていない');
  assert.ok(noticeIdx < formIdx, 'realign.notice の表示位置が {form && ( より後ろにある（フォーム内へ後退している）');
});

test('【不変条件・QA指摘Minor-3・ステップ14-A1】ui/CatalogMaintenancePanel.jsx: useRealignActionsフック本体・handleMaterialRealigned本体はonLibraryChanged/handleLibraryChanged(を呼ばない（合わせ直しはユーザーライブラリを変えないため）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const hookBody = extractBalancedBody(src, 'function useRealignActions(kind, { builtinList, allRows, onRealigned, onError } = {}) {');
  assert.ok(hookBody, 'CatalogMaintenancePanel.jsx に useRealignActions フックが見つからない');
  const hookCode = stripComments(hookBody);
  assert.ok(!/onLibraryChanged/.test(hookCode), 'useRealignActions が onLibraryChanged を参照している（ユーザーライブラリを変えない操作のため渡さない契約への退行）');
  assert.ok(!/handleLibraryChanged\(/.test(hookCode), 'useRealignActions が handleLibraryChanged( を呼んでいる');

  const realignedBody = extractBalancedBody(src, 'function handleMaterialRealigned(keys) {');
  assert.ok(realignedBody, 'CatalogMaintenancePanel.jsx に handleMaterialRealigned が見つからない');
  const realignedCode = stripComments(realignedBody);
  assert.ok(!/onLibraryChanged/.test(realignedCode), 'handleMaterialRealigned が onLibraryChanged を参照している');
  assert.ok(!/handleLibraryChanged\(/.test(realignedCode), 'handleMaterialRealigned が handleLibraryChanged( を呼んでいる');
});

test('【不変条件・ステップ14-A1】ui/CatalogMaintenancePanel.jsx: handleMaterialRealignedは選択中の行が対象keysに含まれていればsetForm(null)で選択を外す', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function handleMaterialRealigned(keys) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleMaterialRealigned が見つからない');
  const code = stripComments(body);
  assert.ok(/keys\.includes\(selectedCode\)/.test(code), 'handleMaterialRealigned が keys.includes(selectedCode) を検査していない');
  assert.ok(/setForm\(null\)/.test(code), 'handleMaterialRealigned が setForm(null) で選択を外していない');
});

test('【不変条件・QA指摘Minor-2・ステップ14-A1】ui/CatalogMaintenancePanel.jsx: handleSave本体はrealign.clearNotice()を呼ぶ（保存開始時に前回の合わせ直し完了通知を消す）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleSave() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleSave が見つからない');
  const code = stripComments(body);
  assert.ok(/realign\.clearNotice\(\)/.test(code), 'handleSave が realign.clearNotice() を呼んでいない');
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

// ステップ12gでSECTIONはREADONLY_KIND_FIELDS（ReadonlyKindTab）から専用タブ（SectionTab。
// 呼称の編集・標準の上書き・userの削除）へ移行した——12fのfixtureSymbol移行と同型。
test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.SECTIONが無い（閲覧タブから編集タブへ移行済み）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    !/\[CatalogKind\.SECTION\]: Object\.freeze\(\[/.test(src),
    'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.SECTION] がまだ残っている',
  );
});

// 寸法系（常に固定=編集不可）の表示項目は別表を持たず、lockedFieldsFor（catalogKinds.js SECTION
// 登録表のkeyBoundFields）から導出する——固定項目の出所を1本化する（QA指摘M2・2026-09-24再報告の
// 「本体編集の判定は1つの式を共有する」と同じ趣旨）。
test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: activeKind===SECTIONのときSectionTabを描き、寸法系の固定表示項目はlockedFieldsForから導出しfieldLabel経由で表示する（別表を持たない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /activeKind === CatalogKind\.SECTION[\s\S]{0,80}<SectionTab/.test(src),
    'activeKind===CatalogKind.SECTIONの条件付きで<SectionTabが描かれていない',
  );
  assert.ok(
    !/SECTION_FIXED_DISPLAY_FIELDS/.test(src),
    'CatalogMaintenancePanel.jsx に SECTION_FIXED_DISPLAY_FIELDS の手書き表が残っている（lockedFieldsFor経由への一本化への退行）',
  );
  const tabBody = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(tabBody, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(
    /lockedFieldsFor\(CatalogKind\.SECTION,/.test(tabBody) && /\.filter\(f => f !== 'key'\)/.test(tabBody),
    'SectionTab が lockedFieldsFor(CatalogKind.SECTION, …) から\'key\'を除いた固定表示項目を導出していない',
  );
  assert.ok(
    /fieldLabel\(CatalogKind\.SECTION, field\)/.test(tabBody),
    'SectionTab が固定表示項目のラベルを fieldLabel(CatalogKind.SECTION, field) 経由で表示していない',
  );
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

// ステップ12g: SectionBulkImportはSectionTab（断面タブ専用コンポーネント）の内側でだけ描かれる
// （ReadonlyKindTabへ相乗りしていた8i時点の配線から移行）。
test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: SectionBulkImportはSectionTab専用で、ReadonlyKindTabには出ない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const sectionTabBody = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(sectionTabBody, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(/<SectionBulkImport\b/.test(sectionTabBody), 'SectionTab が <SectionBulkImport を描いていない');

  const readonlyTabBody = extractBalancedBody(src, 'function ReadonlyKindTab({ kind, builtinList, search, setSearch, selectedKey, setSelectedKey, materialList }) {');
  assert.ok(readonlyTabBody, 'CatalogMaintenancePanel.jsx に ReadonlyKindTab コンポーネントが見つからない');
  assert.ok(!/<SectionBulkImport\b/.test(readonlyTabBody), 'ReadonlyKindTab が <SectionBulkImport を描いている（SectionTabへの一本化への退行）');
});

// ---- ステップ10f: 建具種別（openingSubType）の閲覧タブ（内装マスター・境界マスター・断面と
// 同じReadonlyKindTabに相乗り。姿図プレビューはCatalogPreviewへ無条件に配線済みのため追加配線ゼロ） ----
test('【不変条件・ステップ10f】catalog/catalogMaintenance.js: buildKindTabsでopeningSubTypeがenabled:true（閲覧タブ）', () => {
  const src = readSrc('catalog/catalogMaintenance.js');
  const m = /const VIEWABLE_KINDS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, 'catalogMaintenance.js に VIEWABLE_KINDS が見つからない');
  assert.ok(/CatalogKind\.OPENING_SUB_TYPE/.test(m[1]), 'VIEWABLE_KINDS に CatalogKind.OPENING_SUB_TYPE が含まれていない（建具種別タブが閲覧できない）');
});

// ステップ12hでOPENING_SUB_TYPEはREADONLY_KIND_FIELDS（ReadonlyKindTab）から専用タブ
// （OpeningSubTypeTab。追加・複製・編集・標準の上書き・標準に戻す・削除）へ移行した——12f/12gの
// fixtureSymbol/interiorMaster/section移行と同型。
test('【不変条件・ステップ12h】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.OPENING_SUB_TYPEが無い（閲覧タブから編集タブへ移行済み）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    !/\[CatalogKind\.OPENING_SUB_TYPE\]: Object\.freeze\(\[/.test(src),
    'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.OPENING_SUB_TYPE] がまだ残っている',
  );
});

test('【不変条件・ステップ12h】ui/CatalogMaintenancePanel.jsx: activeKind===OPENING_SUB_TYPEのときOpeningSubTypeTabをmaterialList付きで描き、12aの共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry）をCatalogKind.OPENING_SUB_TYPE付きで直接呼ぶ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /activeKind === CatalogKind\.OPENING_SUB_TYPE[\s\S]{0,120}<OpeningSubTypeTab materialList=\{builtinList\}/.test(src),
    'activeKind===CatalogKind.OPENING_SUB_TYPEの条件付きで<OpeningSubTypeTab materialList={builtinList}が描かれていない',
  );
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  for (const fn of ['rowEditState', 'lockedFieldsFor', 'planSaveEntry']) {
    assert.ok(
      new RegExp(`${fn}\\(CatalogKind\\.OPENING_SUB_TYPE`).test(body),
      `OpeningSubTypeTab が ${fn}(CatalogKind.OPENING_SUB_TYPE, …) を呼んでいない`,
    );
  }
});

test('【不変条件・ステップ12h】ui/CatalogMaintenancePanel.jsx: OpeningSubTypeTabはuseCatalogEditActions(CatalogKind.OPENING_SUB_TYPE, …)を呼び、削除・標準に戻す・保存の確認ブロックをDeleteConfirmBlock/RevertConfirmBlock/SaveConfirmBlockへ委譲する', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  assert.ok(
    /useCatalogEditActions\(CatalogKind\.OPENING_SUB_TYPE,/.test(body),
    'OpeningSubTypeTab が useCatalogEditActions(CatalogKind.OPENING_SUB_TYPE, …) を呼んでいない',
  );
  for (const component of ['DeleteConfirmBlock', 'RevertConfirmBlock', 'SaveConfirmBlock']) {
    assert.ok(new RegExp(`<${component}\\b`).test(body), `OpeningSubTypeTab が <${component} を描いていない`);
  }
});

test('【不変条件・ステップ12h】ui/CatalogMaintenancePanel.jsx: OpeningSubTypeTabの追加・複製はnextOpeningSubTypeKeyでキーを採番し、追加時だけvalidateOpeningSubTypeFormへisAdding:trueを渡す（ユーザーがキーを直接入力する欄が無い）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  assert.ok(/\bnextOpeningSubTypeKey\(/.test(body), 'OpeningSubTypeTab が nextOpeningSubTypeKey を呼んでいない');
  assert.ok(
    /validateOpeningSubTypeForm\(form, \{ isAdding: true/.test(body),
    'OpeningSubTypeTab の新規追加経路が validateOpeningSubTypeForm(form, { isAdding: true, … }) を呼んでいない',
  );
  // キーの直接入力欄（<input ... form.key ...>）が無いことの確認——内装マスターと同じく、
  // キーは常にnextOpeningSubTypeKeyの採番値をそのまま表示する。
  assert.ok(
    !/<input[\s\S]{0,120}value=\{form\.key\}/.test(body),
    'OpeningSubTypeTab に form.key を直接編集するinputがある（キーは自動採番のみのはず）',
  );
});

test('【不変条件・ステップ12h・QA指摘m3で分離】ui/CatalogMaintenancePanel.jsx: OpeningSubTypeTabは機構別の欄（子扉比率・防火枚数・防火角度・引違い配置）の表示要否をopeningSubTypeFormFieldsFor(form)経由で判定し、mechanism直書きの条件分岐を持たない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  assert.ok(
    /const \{ showChildRatio, showFireLeaves, showFireAngle, showSlideLayout \} = openingSubTypeFormFieldsFor\(form\);/.test(body),
    'OpeningSubTypeTab が openingSubTypeFormFieldsFor(form) の戻り値（showFireLeaves/showFireAngleを含む）を分割代入していない',
  );
  assert.ok(
    !/form\.mechanism === '(swingChild|fireDoor|fireFold|slideLayout)'/.test(body),
    'OpeningSubTypeTab に機構名を直書きした条件分岐がある（openingSubTypeFormFieldsFor経由への一本化から後退）',
  );
});

// ---- QA指摘m4（2026-09-24再々報告）: 機構(mechanism)の表示名はcatalog/catalogMaintenance.jsの
// formatMechanismLabel経由——.jsx側に手書きの対応表（OPENING_SUB_TYPE_MECHANISM_LABELS等）を
// 持たない ----
test('【不変条件・QA指摘m4・2026-09-24再々報告】ui/CatalogMaintenancePanel.jsx: 機構selectの表示名はcatalog/catalogMaintenance.jsのformatMechanismLabel経由で、.jsx側に対応表を直書きしない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src) && /\bformatMechanismLabel\(/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js の formatMechanismLabel を呼んでいない',
  );
  assert.ok(
    !/OPENING_SUB_TYPE_MECHANISM_LABELS\s*=\s*Object\.freeze/.test(src),
    'CatalogMaintenancePanel.jsx に機構ラベルの対応表が直書きされている（formatMechanismLabel経由への一本化への退行）',
  );
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  assert.ok(
    /\{formatMechanismLabel\(m\)\}/.test(body),
    'OpeningSubTypeTab が機構selectのoption文言をformatMechanismLabel(m)経由で描いていない',
  );
});

// ---- QA指摘m1（2026-09-24再々報告・最優先）: wallKinds:[]（どちらにも出ない）の保持 ----
test('【不変条件・QA指摘m1・2026-09-24再々報告・最優先】ui/CatalogMaintenancePanel.jsx: OpeningSubTypeTabのwallInterior/wallExteriorチェックボックスはwallKindsExplicitEmpty:falseも同時にsetForm し、フォームの明示空フラグをcatalog/catalogMaintenance.jsのbuildOpeningSubTypeEntryへ渡す', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  const wallToggleCount = (body.match(/wallKindsExplicitEmpty:\s*false/g) ?? []).length;
  assert.ok(
    wallToggleCount >= 2,
    'OpeningSubTypeTab の対応壁種チェックボックス（内部・外部）の両方がwallKindsExplicitEmpty:falseをsetFormしていない',
  );
});

test('【不変条件・ステップ12h】ui/CatalogMaintenancePanel.jsx: OpeningSubTypeTabはbuildOpeningSubTypeEntry(form)でエントリを組み立て、slideLayoutの文字列⇄オブジェクト変換をcatalog/catalogMaintenance.jsのparseSlideLayout/formatSlideLayout経由に一本化する（jsx側に区切り文字の分割等を直書きしない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に OpeningSubTypeTab コンポーネントが見つからない');
  assert.ok(/\bbuildOpeningSubTypeEntry\(form\)/.test(body), 'OpeningSubTypeTab が buildOpeningSubTypeEntry(form) を呼んでいない');
  assert.ok(
    !/slideLayoutText\.split\(/.test(src),
    'CatalogMaintenancePanel.jsx にslideLayoutTextの分割処理が直書きされている（parseSlideLayout経由への一本化への退行）',
  );
});

// ---- ステップ12d: 建具記号（fixtureSymbol）はenabled:true。ステップ12fで閲覧タブ
// （ReadonlyKindTab）から専用の編集タブ（FixtureSymbolTab）へ差し替えた ----
test('【不変条件・ステップ12d】catalog/catalogMaintenance.js: buildKindTabsでfixtureSymbolがenabled:true', () => {
  const src = readSrc('catalog/catalogMaintenance.js');
  const m = /const VIEWABLE_KINDS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, 'catalogMaintenance.js に VIEWABLE_KINDS が見つからない');
  assert.ok(/CatalogKind\.FIXTURE_SYMBOL/.test(m[1]), 'VIEWABLE_KINDS に CatalogKind.FIXTURE_SYMBOL が含まれていない（建具記号タブが表示できない）');
});

// ---- ステップ12f: 建具記号（fixtureSymbol）タブを追加・複製・編集・標準の上書き・標準に戻す・
// 削除まで開放する（専用コンポーネント FixtureSymbolTab。READONLY_KIND_FIELDSからは外れる） ----
test('【不変条件・ステップ12f】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.FIXTURE_SYMBOLが無い（閲覧タブから編集タブへ移行済み）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    !/\[CatalogKind\.FIXTURE_SYMBOL\]: Object\.freeze\(\[/.test(src),
    'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.FIXTURE_SYMBOL] がまだ残っている',
  );
});

test('【不変条件・ステップ12f】ui/CatalogMaintenancePanel.jsx: activeKind===FIXTURE_SYMBOLのときFixtureSymbolTabを描き、12aの共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry）をCatalogKind.FIXTURE_SYMBOL付きで直接呼ぶ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /activeKind === CatalogKind\.FIXTURE_SYMBOL[\s\S]{0,80}<FixtureSymbolTab/.test(src),
    'activeKind===CatalogKind.FIXTURE_SYMBOLの条件付きで<FixtureSymbolTabが描かれていない',
  );
  const fnMatch = /function FixtureSymbolTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に FixtureSymbolTab コンポーネントが見つからない');
  const body = fnMatch[0];
  for (const fn of ['rowEditState', 'lockedFieldsFor', 'planSaveEntry']) {
    assert.ok(
      new RegExp(`${fn}\\(CatalogKind\\.FIXTURE_SYMBOL`).test(body),
      `FixtureSymbolTab が ${fn}(CatalogKind.FIXTURE_SYMBOL, …) を呼んでいない`,
    );
  }
});

// ---- QA指摘n9（2026-09-24再報告）: 保存・削除・標準に戻すの非同期手順・確認state・busyガードは
// 材料タブとの重複解消のため共通フックuseCatalogEditActions（kind汎用。CatalogMaintenancePanel.jsx
// 内）へ委譲する。FixtureSymbolTabはこのフックへkind:CatalogKind.FIXTURE_SYMBOLを渡して使う——
// planRevertToBuiltin/planRemoveUserEntry/applyCatalogEditPlanの直接呼び出しはフック側へ移った
// （材料タブは本ラウンド未移行。上のuseCatalogEditActions定義直前のコメントに報告済み）。
test('【不変条件・QA指摘n9・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: FixtureSymbolTabはuseCatalogEditActions(CatalogKind.FIXTURE_SYMBOL, …)を呼び、useCatalogEditActions自身がplanRevertToBuiltin/planRemoveUserEntry/applyCatalogEditPlanをkind引数で呼ぶ（材料タブとの重複解消）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const fnMatch = /function FixtureSymbolTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に FixtureSymbolTab コンポーネントが見つからない');
  assert.ok(
    /useCatalogEditActions\(CatalogKind\.FIXTURE_SYMBOL,/.test(fnMatch[0]),
    'FixtureSymbolTab が useCatalogEditActions(CatalogKind.FIXTURE_SYMBOL, …) を呼んでいない',
  );

  const hookMatch = /function useCatalogEditActions\(kind,[\s\S]*?\n\}/.exec(src);
  assert.ok(hookMatch, 'CatalogMaintenancePanel.jsx に useCatalogEditActions フックが見つからない');
  const hookBody = hookMatch[0];
  for (const fn of ['planRevertToBuiltin', 'planRemoveUserEntry', 'applyCatalogEditPlan']) {
    assert.ok(
      new RegExp(`${fn}\\(kind,`).test(hookBody),
      `useCatalogEditActions が ${fn}(kind, …) を呼んでいない`,
    );
  }
});

test('【不変条件・QA指摘n9・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: FixtureSymbolTabは削除・標準に戻す・保存の確認ブロックをDeleteConfirmBlock/RevertConfirmBlock/SaveConfirmBlockへ委譲する（材料タブと共有できる形にする）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const fnMatch = /function FixtureSymbolTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に FixtureSymbolTab コンポーネントが見つからない');
  const body = fnMatch[0];
  for (const component of ['DeleteConfirmBlock', 'RevertConfirmBlock', 'SaveConfirmBlock']) {
    assert.ok(new RegExp(`<${component}\\b`).test(body), `FixtureSymbolTab が <${component} を描いていない`);
  }
  for (const fn of ['DeleteConfirmBlock', 'RevertConfirmBlock', 'SaveConfirmBlock']) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(src), `CatalogMaintenancePanel.jsx に ${fn} コンポーネントが見つからない`);
  }
});

test('【不変条件・ステップ12f】ui/CatalogMaintenancePanel.jsx: FixtureSymbolTabは追加時だけvalidateFixtureSymbolFormへisAdding:trueを渡し、書式・重複検査（FIXTURE_SYMBOL_KEY_PATTERN）はcatalog/catalogMaintenance.js側にある', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const fnMatch = /function FixtureSymbolTab\(\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に FixtureSymbolTab コンポーネントが見つからない');
  const body = fnMatch[0];
  assert.ok(/validateFixtureSymbolForm\(form, \{ isAdding: true/.test(body), 'FixtureSymbolTab の新規追加経路が validateFixtureSymbolForm(form, { isAdding: true, … }) を呼んでいない');
  assert.ok(!/\^\[A-Z\]/.test(src), 'CatalogMaintenancePanel.jsx に記号の書式検査（正規表現）が直書きされている（catalog/catalogMaintenance.js の FIXTURE_SYMBOL_KEY_PATTERN 経由への一本化への退行）');
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

// ---- ステップ12b（材料タブへ12aの共通ロジックを配線。canEditMaterialRowは削除）----
test('【不変条件・ステップ12b】ui/CatalogMaintenancePanel.jsx: 本体編集の共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry/planRevertToBuiltin/planRemoveUserEntry/applyCatalogEditPlan）をcatalog/catalogMaintenance.js経由で呼び、.jsx側で判定を再実装しない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  for (const fn of [
    'rowEditState', 'lockedFieldsFor', 'planSaveEntry', 'planRevertToBuiltin',
    'planRemoveUserEntry', 'applyCatalogEditPlan',
  ]) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(src), `CatalogMaintenancePanel.jsx が ${fn} を呼んでいない`);
  }
});

test('【不変条件・ステップ12b】catalog/catalogMaintenance.js: canEditMaterialRowは削除済み（rowEditState+isEditableMaterialCategoryへ置換）', () => {
  const catalogSrc = readSrc('catalog/catalogMaintenance.js');
  assert.ok(!/canEditMaterialRow/.test(catalogSrc), 'catalog/catalogMaintenance.js に canEditMaterialRow の痕跡が残っている');
  const panelSrc = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(!/canEditMaterialRow/.test(panelSrc), 'ui/CatalogMaintenancePanel.jsx が canEditMaterialRow をまだ参照している');
});

test('【不変条件・ステップ12b】ui/CatalogMaintenancePanel.jsx: 間柱6コード（backingClass.js WOOD_STUD_CODE_BY_SIZE）からextraLockedを組み立て、materialExtraLockedFields/lockedFieldsFor/planSaveEntryへ渡している', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/finish\/materials\/backingClass\.js['"]/.test(src) && /\bWOOD_STUD_CODE_BY_SIZE\b/.test(src),
    'CatalogMaintenancePanel.jsx が finish/materials/backingClass.js の WOOD_STUD_CODE_BY_SIZE を import していない',
  );
  const extraLockedCalls = (src.match(/materialExtraLockedFields\(/g) ?? []).length;
  assert.ok(extraLockedCalls >= 2, 'materialExtraLockedFields の呼び出しがlockedFieldsFor用・planSaveEntry用の両方に見つからない');
  assert.ok(
    /extraLocked:\s*materialExtraLockedFields\(/.test(src),
    'lockedFieldsFor/planSaveEntry へ extraLocked: materialExtraLockedFields(...) の形で渡していない',
  );
});

// QA指摘M1（2026-09-24再報告）: 削除確認の使用中判定はstore.jsのcollectCurrentCatalogUsage
// （未保存の作業中の編集を含む「現在の」使用キー）経由に一本化する——旧
// collectCatalogUsageAcrossFloors+loadAllSavedFloorsは最後に明示保存した内容しか見ず、
// 保存前の削除操作で参照が宙に浮く事故があった。
test('【不変条件・QA指摘M1・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: 使用中キーはstore.jsのcollectCurrentCatalogUsage経由で取得し（loadAllSavedFloorsを直接呼ばない）、削除プランはplanRemoveUserEntryへ渡す', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/from ['"]\.\.\/store\.js['"]/.test(src) && /\bcollectCurrentCatalogUsage\(/.test(src), 'CatalogMaintenancePanel.jsx が store.js の collectCurrentCatalogUsage を呼んでいない');
  assert.ok(
    !/\bloadAllSavedFloors\(/.test(src),
    'CatalogMaintenancePanel.jsx が loadAllSavedFloors を直接呼んでいる（未保存編集を見落とす旧経路への退行）',
  );
  assert.ok(
    !/\bcollectCatalogUsageAcrossFloors\(/.test(src),
    'CatalogMaintenancePanel.jsx が collectCatalogUsageAcrossFloors を直接呼んでいる（未保存編集を見落とす旧経路への退行）',
  );
  assert.ok(
    /planRemoveUserEntry\([^)]*usedKeys:\s*deleteUsage\.usedKeys/.test(src),
    'CatalogMaintenancePanel.jsx が planRemoveUserEntry へ usedKeys: deleteUsage.usedKeys を渡していない',
  );
});

test('【不変条件・QA指摘M1・2026-09-24再報告】store.js: collectCurrentCatalogUsageがexportされている（ui/CatalogMaintenancePanel.jsxから呼べるように）', () => {
  const src = readSrc('store.js');
  assert.ok(
    /export async function collectCurrentCatalogUsage\(\) \{/.test(src),
    'store.js の collectCurrentCatalogUsage が export されていない',
  );
});

test('【不変条件・ステップ12b】ui/CatalogMaintenancePanel.jsx: 保存後メッセージはcatalog/catalogMaintenance.jsのmaterialSaveMessage経由（.jsx側で「保存しました」を直書きで組み立てない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/\bmaterialSaveMessage\(/.test(src), 'CatalogMaintenancePanel.jsx が materialSaveMessage を呼んでいない');
  const fnMatch = /async function performSave\([\s\S]*?\n {2}\}/.exec(src);
  assert.ok(fnMatch, 'CatalogMaintenancePanel.jsx に performSave 関数が見つからない');
  assert.ok(
    /setFormMessage\(materialSaveMessage\(/.test(fnMatch[0]),
    'performSave が setFormMessage(materialSaveMessage(...)) を呼んでいない（保存後メッセージの直書きへの退行）',
  );
});

test('【不変条件・ステップ12b】ui/CatalogMaintenancePanel.jsx: 標準を編集した行（overridesBuiltin）には「標準を編集」バッジを表示する', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/row\.overridesBuiltin/.test(src), 'CatalogMaintenancePanel.jsx が row.overridesBuiltin を参照していない');
  assert.ok(/標準を編集/.test(src), 'CatalogMaintenancePanel.jsx に「標準を編集」バッジの文言が無い');
});

// ---- QA指摘m1（2026-09-24再報告）: 変更が無ければno-op（plan.noop:trueで「変更はありません」を
// 出し、applyCatalogEditPlanを呼ばない） ----
test('【不変条件・QA指摘m1・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: handleSaveはplan.noopがtrueなら「変更はありません」を出し、performSave（applyCatalogEditPlan）を呼ばない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleSave() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleSave 関数が見つからない');
  assert.ok(/if \(plan\.noop\)/.test(body), 'handleSave が plan.noop を分岐していない');
  const noopMatch = /if \(plan\.noop\) \{([\s\S]*?)\}/.exec(body);
  assert.ok(noopMatch, 'handleSave の plan.noop 分岐本体が見つからない');
  assert.ok(/変更はありません/.test(noopMatch[1]), 'plan.noop分岐が「変更はありません」を出していない');
  assert.ok(!/performSave\(/.test(noopMatch[1]), 'plan.noop分岐がperformSave（applyCatalogEditPlan経由の保存）を呼んでいる（no-opなのに永続化してしまう）');
});

// ---- QA指摘m2（2026-09-24再報告）: 承認ボタンの二重押し防止（busy state） ----
test('【不変条件・QA指摘m2・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: busy stateがあり、performSave・handleDeleteConfirmed・handleRevertConfirmedがsetBusy(true)/setBusy(false)で実行中をガードする', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/const \[busy, setBusy\] = useState\(false\);/.test(src), 'CatalogMaintenancePanel.jsx に busy state が見つからない');
  for (const sig of [
    'async function performSave(plan, entryCode, { overridesBuiltin, thicknessChanged }) {',
    'async function handleDeleteConfirmed() {',
    'async function handleRevertConfirmed() {',
  ]) {
    const body = extractBalancedBody(src, sig);
    assert.ok(body, `CatalogMaintenancePanel.jsx に ${sig} が見つからない`);
    assert.ok(/setBusy\(true\)/.test(body), `${sig} が setBusy(true) を呼んでいない`);
    assert.ok(/setBusy\(false\)/.test(body), `${sig} が setBusy(false) を呼んでいない（busyが立ちっぱなしになる）`);
  }
});

test('【不変条件・QA指摘m2・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: 承認する・削除する・標準に戻すの各承認ボタンがbusy中disabledになる', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const approveButtonBlocks = [...src.matchAll(/<button[^>]*onClick=\{(?:handleSaveConfirmed|handleDeleteConfirmed|handleRevertConfirmed)\}[^>]*>/g)];
  assert.ok(approveButtonBlocks.length >= 2, '承認系ボタン（handleSaveConfirmed/handleDeleteConfirmed/handleRevertConfirmed）の<button>が見つからない');
  for (const m of approveButtonBlocks) {
    assert.ok(/disabled=\{[^}]*busy[^}]*\}/.test(m[0]), `承認ボタンがbusyでdisabledになっていない: ${m[0]}`);
  }
});

// ---- QA指摘m4（2026-09-24再報告）: .jsx側でoverridesBuiltin/thicknessChanged/needsConfirmを
// 再計算せず、planSaveEntryの戻り値をそのまま使う（変異jsxThick/jsxOverride/jsxConfirmの対称） ----
test('【不変条件・QA指摘m4・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: handleSaveはoverridesBuiltin/thicknessChanged/needsConfirmを再計算せず、plan（planSaveEntryの戻り値）のものをそのまま使う', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleSave() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleSave 関数が見つからない');
  assert.ok(
    !/builtinKeys\.has\(\s*entry\.code\s*\)/.test(body),
    'handleSave が builtinKeys.has(entry.code) を直書きしている（overridesBuiltinの再計算＝planSaveEntryの戻り値への一本化から後退）',
  );
  assert.ok(
    !/prevEntry\.thickness\s*!==\s*entry\.thickness/.test(body),
    'handleSave が prevEntry.thickness !== entry.thickness を直書きしている（thicknessChangedの再計算＝planSaveEntryの戻り値への一本化から後退）',
  );
  assert.ok(
    !/editState\?\.state === 'doc-same' && plan\.confirmPairs\.length > 0/.test(body),
    'handleSave が確認要否をeditState.stateとconfirmPairsから再計算している（needsConfirmの再計算＝planSaveEntryの戻り値への一本化から後退）',
  );
  assert.ok(/plan\.overridesBuiltin/.test(body), 'handleSave が plan.overridesBuiltin を使っていない');
  assert.ok(/plan\.thicknessChanged/.test(body), 'handleSave が plan.thicknessChanged を使っていない');
  assert.ok(/plan\.needsConfirm/.test(body), 'handleSave が plan.needsConfirm を使っていない');
});

test('【不変条件・QA指摘m4・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: category固定のツールチップはlockedFieldReason(kind, field)経由で、拒否文言を直書きしない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/\blockedFieldReason\(/.test(src), 'CatalogMaintenancePanel.jsx が lockedFieldReason を呼んでいない');
  assert.ok(
    !/は変更できません（複製してください）/.test(src),
    'CatalogMaintenancePanel.jsx に固定項目の拒否文言が直書きされている（lockedFieldReason経由への一本化から後退）',
  );
});

test('【不変条件・QA指摘m4・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: 削除完了メッセージはremoveMessageFor(plan)経由で、plan.docAppendの有無を.jsx側で再判定しない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleDeleteConfirmed() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleDeleteConfirmed 関数が見つからない');
  assert.ok(/setFormMessage\(removeMessageFor\(plan\)\)/.test(body), 'handleDeleteConfirmed が setFormMessage(removeMessageFor(plan)) を呼んでいない');
  assert.ok(!/plan\.docAppend \?/.test(body), 'handleDeleteConfirmed が plan.docAppend の三項演算子で文言を直書きしている（removeMessageFor経由への一本化から後退）');
});

// ---- QA指摘M1（2026-09-24再報告）: 使用状況の取得が失敗（reject）したら削除プランを作らない
// ガード（deleteUsage.status!=='ready'のとき削除できない） ----
test('【不変条件・QA指摘M1・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: handleDeleteConfirmedはdeleteUsage.status!=="ready"（使用状況の取得中・失敗）なら早期returnし、planRemoveUserEntryを呼ばない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleDeleteConfirmed() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleDeleteConfirmed 関数が見つからない');
  const guardMatch = /^\s*if \(([^)]*)\) return;/.exec(body.replace(/^\{/, '').trimStart());
  assert.ok(guardMatch, 'handleDeleteConfirmed の先頭に早期returnガードが見つからない');
  assert.match(guardMatch[1], /deleteUsage\.status !== 'ready'/, 'handleDeleteConfirmed のガードに deleteUsage.status !== \'ready\' が含まれていない');
});

// ---- QA指摘n2（2026-09-24再報告）: 新規追加もplanSaveEntry+applyCatalogEditPlan（performSave）
// へ寄せ、保存経路を1本にする ----
test('【不変条件・QA指摘n2・2026-09-24再報告】ui/CatalogMaintenancePanel.jsx: handleSaveのisAdding分岐はplanSaveEntry→performSave（applyCatalogEditPlan）経由で保存し、upsertUserMaterialEntry/commitUserEntriesを直接呼ばない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleSave() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleSave 関数が見つからない');
  const addingMatch = /if \(isAdding\) \{([\s\S]*?)\n {4}\}/.exec(body);
  assert.ok(addingMatch, 'handleSave の if (isAdding) 分岐本体が見つからない');
  const addingBody = addingMatch[1];
  assert.ok(/validateMaterialEntry\(/.test(addingBody), 'isAdding分岐がvalidateMaterialEntry（下地材カテゴリ拒否ゲート）を呼んでいない');
  assert.ok(/planSaveEntry\(/.test(addingBody), 'isAdding分岐がplanSaveEntryを呼んでいない（新規追加も保存プラン経由への一本化から後退）');
  assert.ok(/performSave\(/.test(addingBody), 'isAdding分岐がperformSave（applyCatalogEditPlan経由）を呼んでいない');
  assert.ok(!/upsertUserMaterialEntry\(/.test(addingBody), 'isAdding分岐がupsertUserMaterialEntryを直接呼んでいる（performSave経由への一本化から後退）');
  assert.ok(!/\bcommitUserEntries\(/.test(addingBody), 'isAdding分岐がcommitUserEntriesを直接呼んでいる（applyCatalogEditPlan経由への一本化から後退）');
});

// ---- QA指摘n1（2026-09-24再報告）: 12c申し送りのコメントがbuildMaterialEntryに残っている ----
test('【不変条件・QA指摘n1・2026-09-24再報告】catalog/catalogMaintenance.js: buildMaterialEntryに12c申し送り（x/y:0固定と間柱extraLockedの衝突）のコメントがある', () => {
  const src = readSrc('catalog/catalogMaintenance.js');
  const fnMatch = /export function buildMaterialEntry\(/.exec(src);
  assert.ok(fnMatch, 'catalog/catalogMaintenance.js に buildMaterialEntry が見つからない');
  const before = src.slice(Math.max(0, fnMatch.index - 1200), fnMatch.index);
  assert.ok(/n1/.test(before) && /12c/.test(before), 'buildMaterialEntry の直前に12c申し送り（n1）のコメントが見つからない');
});

// ---- ステップ12c（2026-09-24）: 下地材（backing）の追加・編集を開放する ----
test('【不変条件・ステップ12c】ui/CatalogMaintenancePanel.jsx: カテゴリ選択に下地材（MATERIAL_CATEGORY.BACKING）を常に選べる選択肢として持つ（選択済みのときだけ出す条件分岐が無い）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    !/form\.category === MATERIAL_CATEGORY\.BACKING &&/.test(src),
    'CatalogMaintenancePanel.jsx のカテゴリ選択が「選択済みのときだけ下地材を出す」条件分岐のままになっている',
  );
});

test('【不変条件・ステップ12c】ui/CatalogMaintenancePanel.jsx: X/Y・下地区分の表示要否はmaterialFormHasDimensions(category)（純関数）で判定し、jsx側にcategory直書き条件を持たない', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/function materialFormHasDimensions\(category\)/.test(src), 'CatalogMaintenancePanel.jsx に materialFormHasDimensions 関数が見つからない');
  const callCount = (src.match(/materialFormHasDimensions\(form\.category\)/g) ?? []).length;
  assert.ok(callCount >= 2, 'materialFormHasDimensions(form.category) がX/Y欄・下地区分欄の両方で呼ばれていない');
});

test('【不変条件・ステップ12c】ui/CatalogMaintenancePanel.jsx: 下地区分（backingClass）の選択肢はcatalog/catalogMaintenance.jsのBACKING_CLASS_OPTIONS経由（.jsx側にwood/otherの対応表を直書きしない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src) && /\bBACKING_CLASS_OPTIONS\b/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js の BACKING_CLASS_OPTIONS を import・使用していない',
  );
  assert.ok(
    /BACKING_CLASS_OPTIONS\.map\(/.test(src),
    'CatalogMaintenancePanel.jsx が BACKING_CLASS_OPTIONS.map(...) で選択肢を描いていない',
  );
});

test('【不変条件・ステップ12c】ui/CatalogMaintenancePanel.jsx: handleSaveがbuildMaterialEntryへx/y/backingClassを渡している（下地材の追加・編集が純関数側で組み立てられる）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'async function handleSave() {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に handleSave 関数が見つからない');
  assert.ok(
    /buildMaterialEntry\(\{[\s\S]*?x:\s*Number\(form\.x\)[\s\S]*?y:\s*Number\(form\.y\)[\s\S]*?backingClass:\s*form\.backingClass/.test(body),
    'handleSave が buildMaterialEntry へ x/y/backingClass を渡していない',
  );
});

test('【不変条件・ステップ12c】catalog/catalogMaintenance.js: EDITABLE_MATERIAL_CATEGORIESに下地材（backing）を含み、isEditableMaterialCategoryがtrueを返す（下地材の編集開放）', () => {
  const src = readSrc('catalog/catalogMaintenance.js');
  const m = /export const EDITABLE_MATERIAL_CATEGORIES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, 'catalog/catalogMaintenance.js に EDITABLE_MATERIAL_CATEGORIES が見つからない');
  assert.ok(/MATERIAL_CATEGORY\.BACKING/.test(m[1]), 'EDITABLE_MATERIAL_CATEGORIES に MATERIAL_CATEGORY.BACKING が含まれていない');
});

// ---- ステップ12c QA指摘m1（2026-09-24再報告）: X/Y/厚さの入力欄がlockedFields.has(...)でも
// disabledになる（間柱6件の入力不可を実効化） ----
test('【不変条件・ステップ12c QA指摘m1】ui/CatalogMaintenancePanel.jsx: X/Y/厚さのinputがlockedFields.has(\'x\'|\'y\'|\'thickness\')でもdisabledになり、lockedFieldReasonをtitleに持つ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  for (const field of ['x', 'y', 'thickness']) {
    assert.ok(
      new RegExp(`disabled=\\{!!disabledReason \\|\\| lockedFields\\.has\\('${field}'\\)\\}`).test(src),
      `CatalogMaintenancePanel.jsx の${field}入力がlockedFields.has('${field}')でdisabledになっていない`,
    );
    assert.ok(
      new RegExp(`lockedFields\\.has\\('${field}'\\) \\? lockedFieldReason\\(CatalogKind\\.MATERIAL, '${field}'\\)`).test(src),
      `CatalogMaintenancePanel.jsx の${field}入力がlockedFieldReasonをtitleに持っていない`,
    );
  }
});

// ---- ステップ12c QA指摘m2（2026-09-24再報告）: 下地区分selectの表示値はbackingClassDisplayFor
// （純関数。catalog/catalogMaintenance.js）経由で、.jsx側に導出ロジックを直書きしない ----
test('【不変条件・ステップ12c QA指摘m2】ui/CatalogMaintenancePanel.jsx: 下地区分selectの表示値はbackingClassDisplayFor(entry, backingClassOf)経由で導出し、finish/materials/backingClass.jsのbackingClassOfをimportしている', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src) && /\bbackingClassDisplayFor\b/.test(src),
    'CatalogMaintenancePanel.jsx が catalog/catalogMaintenance.js の backingClassDisplayFor を import していない',
  );
  assert.ok(
    /from ['"]\.\.\/finish\/materials\/backingClass\.js['"]/.test(src) && /\bbackingClassOf\b/.test(src),
    'CatalogMaintenancePanel.jsx が finish/materials/backingClass.js の backingClassOf を import していない',
  );
  assert.ok(
    /backingClassDisplayFor\(selectedRow\.entry,\s*backingClassOf\)/.test(src),
    'CatalogMaintenancePanel.jsx が backingClassDisplayFor(selectedRow.entry, backingClassOf) を呼んでいない',
  );
  assert.ok(
    /<select[\s\S]{0,40}value=\{backingClassSelectValue\}/.test(src),
    '下地区分のselectがbackingClassSelectValue（backingClassDisplayFor由来）をvalueに使っていない',
  );
});

// ================================================================
// ステップ12g: 内装マスター（InteriorMasterTab）・断面（SectionTab）タブ
// ================================================================

test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: READONLY_KIND_FIELDSにCatalogKind.INTERIOR_MASTER/CatalogKind.SECTIONが無い（閲覧タブから編集タブへ移行済み）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    !/\[CatalogKind\.INTERIOR_MASTER\]: Object\.freeze\(\[/.test(src),
    'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.INTERIOR_MASTER] がまだ残っている',
  );
  assert.ok(
    !/\[CatalogKind\.SECTION\]: Object\.freeze\(\[/.test(src),
    'CatalogMaintenancePanel.jsx の READONLY_KIND_FIELDS に [CatalogKind.SECTION] がまだ残っている',
  );
});

test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: activeKind===INTERIOR_MASTERのときInteriorMasterTabをmaterialList付きで描き、12aの共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry）をCatalogKind.INTERIOR_MASTER付きで直接呼ぶ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /activeKind === CatalogKind\.INTERIOR_MASTER[\s\S]{0,120}<InteriorMasterTab materialList=\{builtinList\}/.test(src),
    'activeKind===CatalogKind.INTERIOR_MASTERの条件付きで<InteriorMasterTab materialList={builtinList}が描かれていない',
  );
  const body = extractBalancedBody(src, 'function InteriorMasterTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に InteriorMasterTab コンポーネントが見つからない');
  for (const fn of ['rowEditState', 'lockedFieldsFor', 'planSaveEntry']) {
    assert.ok(
      new RegExp(`${fn}\\(CatalogKind\\.INTERIOR_MASTER`).test(body),
      `InteriorMasterTab が ${fn}(CatalogKind.INTERIOR_MASTER, …) を呼んでいない`,
    );
  }
});

test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: InteriorMasterTabはuseCatalogEditActions(CatalogKind.INTERIOR_MASTER, …)を呼び、削除・標準に戻す・保存の確認ブロックをDeleteConfirmBlock/RevertConfirmBlock/SaveConfirmBlockへ委譲する', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function InteriorMasterTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に InteriorMasterTab コンポーネントが見つからない');
  assert.ok(
    /useCatalogEditActions\(CatalogKind\.INTERIOR_MASTER,/.test(body),
    'InteriorMasterTab が useCatalogEditActions(CatalogKind.INTERIOR_MASTER, …) を呼んでいない',
  );
  for (const component of ['DeleteConfirmBlock', 'RevertConfirmBlock', 'SaveConfirmBlock']) {
    assert.ok(new RegExp(`<${component}\\b`).test(body), `InteriorMasterTab が <${component} を描いていない`);
  }
});

test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: InteriorMasterTabの追加・複製はnextInteriorMasterKeyでキーを採番し、追加時だけvalidateInteriorMasterFormへisAdding:trueを渡す（ユーザーがキーを直接入力する欄が無い）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function InteriorMasterTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に InteriorMasterTab コンポーネントが見つからない');
  assert.ok(/\bnextInteriorMasterKey\(/.test(body), 'InteriorMasterTab が nextInteriorMasterKey を呼んでいない');
  assert.ok(
    /validateInteriorMasterForm\(form, \{ isAdding: true/.test(body),
    'InteriorMasterTab の新規追加経路が validateInteriorMasterForm(form, { isAdding: true, … }) を呼んでいない',
  );
  // キーの直接入力欄（<input ... form.key ...>）が無いことの確認——記号（fixtureSymbol）の
  // 追加時と違い、キーは常にnextInteriorMasterKeyの採番値をそのまま表示する。
  assert.ok(
    !/<input[\s\S]{0,120}value=\{form\.key\}/.test(body),
    'InteriorMasterTab に form.key を直接編集するinputがある（キーは自動採番のみのはず）',
  );
});

// ---- QA指摘M1（12g再報告）: 壁材・壁仕上げコードの実在検査（materialKeys）の配線 ----
test('【不変条件・QA指摘M1・12g再報告】ui/CatalogMaintenancePanel.jsx: InteriorMasterTabはcollectKnownCatalogKeys(CatalogKind.MATERIAL, materialList)でmaterialKeysを組み立て、追加・編集どちらのvalidateInteriorMasterFormにも渡す', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function InteriorMasterTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に InteriorMasterTab コンポーネントが見つからない');
  assert.ok(
    /collectKnownCatalogKeys\(CatalogKind\.MATERIAL, materialList\)/.test(body),
    'InteriorMasterTab が collectKnownCatalogKeys(CatalogKind.MATERIAL, materialList) でmaterialKeysを組み立てていない',
  );
  assert.ok(
    /validateInteriorMasterForm\(form, \{ isAdding: true, allKeys, builtinKeys, materialKeys \}\)/.test(body),
    'InteriorMasterTab の新規追加経路が validateInteriorMasterForm(…, { …, materialKeys }) へmaterialKeysを渡していない',
  );
  assert.ok(
    /validateInteriorMasterForm\(form, \{ isAdding: false, materialKeys \}\)/.test(body),
    'InteriorMasterTab の編集経路が validateInteriorMasterForm(…, { isAdding: false, materialKeys }) へmaterialKeysを渡していない',
  );
});

test('【不変条件・QA指摘M1・12g再報告】ui/CatalogMaintenancePanel.jsx: InteriorMasterTabはmaterialListLoaded: Boolean(materialList)をinteriorMasterRowDisabledReasonへ渡し、未読込みの間は保存ボタンをdisabledにする', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function InteriorMasterTab({ materialList, onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に InteriorMasterTab コンポーネントが見つからない');
  assert.ok(
    /interiorMasterRowDisabledReason\(\{ isAdding, editState, materialListLoaded: Boolean\(materialList\) \}\)/.test(body),
    'InteriorMasterTab が interiorMasterRowDisabledReason へ materialListLoaded: Boolean(materialList) を渡していない',
  );
});

test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: activeKind===SECTIONのときSectionTabを描き、12aの共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry）をCatalogKind.SECTION付きで直接呼ぶ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /activeKind === CatalogKind\.SECTION[\s\S]{0,80}<SectionTab/.test(src),
    'activeKind===CatalogKind.SECTIONの条件付きで<SectionTabが描かれていない',
  );
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  for (const fn of ['rowEditState', 'lockedFieldsFor', 'planSaveEntry']) {
    assert.ok(
      new RegExp(`${fn}\\(CatalogKind\\.SECTION`).test(body),
      `SectionTab が ${fn}(CatalogKind.SECTION, …) を呼んでいない`,
    );
  }
});

test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: SectionTabはuseCatalogEditActions(CatalogKind.SECTION, …)を呼び、削除・標準に戻す・保存の確認ブロックをDeleteConfirmBlock/RevertConfirmBlock/SaveConfirmBlockへ委譲する', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(
    /useCatalogEditActions\(CatalogKind\.SECTION,/.test(body),
    'SectionTab が useCatalogEditActions(CatalogKind.SECTION, …) を呼んでいない',
  );
  for (const component of ['DeleteConfirmBlock', 'RevertConfirmBlock', 'SaveConfirmBlock']) {
    assert.ok(new RegExp(`<${component}\\b`).test(body), `SectionTab が <${component} を描いていない`);
  }
});

// 設計12g「断面は追加は既存の『規格文字列から追加』のみ」: SectionTabは新規追加フォーム
// （+ 新規追加ボタン・isAdding分岐）を持たない——寸法系を利用者が直接組み立てる経路を増やさない。
test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: SectionTabは「+ 新規追加」ボタン・複製ボタンを持たない（追加は規格文字列の一括入力のみ）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(!/新規追加/.test(body), 'SectionTab に「新規追加」ボタンがある（設計スコープ外）');
  assert.ok(!/複製/.test(body), 'SectionTab に「複製」ボタンがある（設計スコープ外）');
  assert.ok(/<SectionBulkImport\b/.test(body), 'SectionTab が <SectionBulkImport を描いていない（追加は規格文字列の一括入力のみ）');
});

// buildSectionEntryはprevEntry（選択行の元エントリ）を必須で受け取る設計——SectionTabが
// selectedRow.entryを渡していることを固定する（寸法系を勝手に組み立てさせない歯止め）。
test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: SectionTabのhandleSaveはbuildSectionEntry(selectedRow.entry, form)を呼ぶ（寸法系をprevEntryから引き継ぐ）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(
    /buildSectionEntry\(selectedRow\.entry, form\)/.test(body),
    'SectionTab の handleSave が buildSectionEntry(selectedRow.entry, form) を呼んでいない',
  );
});

// QA指摘「足りないテスト」（12g再報告）: SectionTabが選択行の作図プレビューをCatalogPreview経由で
// 描いていること（断面タブでも9b/9cと同じ作図プレビューが見える契約）を固定する。
test('【不変条件・ステップ12g】ui/CatalogMaintenancePanel.jsx: SectionTabは選択行を<CatalogPreview kind={CatalogKind.SECTION} entry={selectedRow.entry}で描く', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(
    /<CatalogPreview kind=\{CatalogKind\.SECTION\} entry=\{selectedRow\.entry\}/.test(body),
    'SectionTab が <CatalogPreview kind={CatalogKind.SECTION} entry={selectedRow.entry} を描いていない',
  );
});

// QA指摘M2（12g再報告）の配線確認: SectionTabがrowEditStateの戻り値（stateを含むeditState）を
// そのままsectionRowDisabledReasonへ渡していること（.state分岐が実際に機能する形で呼ばれている）。
test('【不変条件・QA指摘M2・12g再報告】ui/CatalogMaintenancePanel.jsx: SectionTabはsectionRowDisabledReason({ isAdding: false, editState })を呼ぶ（editStateはrowEditStateの戻り値そのもの＝.stateを含む）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(
    /sectionRowDisabledReason\(\{ isAdding: false, editState \}\)/.test(body),
    'SectionTab が sectionRowDisabledReason({ isAdding: false, editState }) を呼んでいない',
  );
});

// ステップ12i（開発者向けエクスポート）: 保守パネルが<DeveloperExportPanel kind={activeKind} />を
// 描き、その本体が純ロジック（collectExportableEntries/formatBuiltinSource。抽出・整形はどちらも
// catalog/catalogMaintenance.jsの純関数）を呼んでいること——.jsx側で分類・整形を再実装していない
// ことを固定する（描くだけの契約）。
test('【不変条件・ステップ12i】ui/CatalogMaintenancePanel.jsx: <DeveloperExportPanel key={activeKind} kind={activeKind} libraryTick={libraryTick} />を描いている', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(
    /<DeveloperExportPanel key=\{activeKind\} kind=\{activeKind\} libraryTick=\{libraryTick\} \/>/.test(src),
    'CatalogMaintenancePanel.jsx が <DeveloperExportPanel key={activeKind} kind={activeKind} libraryTick={libraryTick} /> を描いていない'
    + '（keyでkind切替え時に再マウント・libraryTickでuserライブラリ変更時に再計算させる契約）',
  );
});

test('【不変条件・ステップ12i】ui/CatalogMaintenancePanel.jsx: DeveloperExportPanelはcollectExportableEntries・formatBuiltinSourceを呼ぶ（分類・整形をここで再実装しない）', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function DeveloperExportPanel({ kind, libraryTick }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に DeveloperExportPanel コンポーネントが見つからない');
  assert.ok(/collectExportableEntries\(kind, \{ builtinList \}\)/.test(body), 'collectExportableEntriesを呼んでいない');
  assert.ok(/formatBuiltinSource\(/.test(body), 'formatBuiltinSourceを呼んでいない');
});

// QA指摘M1（2026-09-24再報告・案(b)）: overlayはReactが追跡しない可変状態のため、
// DeveloperExportPanelはuseMemoの依存にlibraryTickを含めて再計算する契約——親の再レンダーだけに
// 頼ると（builtinList/kindが変わらない限り）再計算されない。
test('【不変条件・QA指摘M1・ステップ12i】ui/CatalogMaintenancePanel.jsx: DeveloperExportPanelのuseMemoはlibraryTickを依存に含む', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function DeveloperExportPanel({ kind, libraryTick }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に DeveloperExportPanel コンポーネントが見つからない');
  assert.ok(
    /\}, \[kind, builtinList, libraryTick\]\)/.test(body),
    'DeveloperExportPanelのuseMemoの依存配列にlibraryTickが含まれていない',
  );
});

// QA指摘M1（2026-09-24再報告・案(b)）: 4つの編集タブ（FixtureSymbolTab・InteriorMasterTab・
// SectionTab・OpeningSubTypeTab）はuseCatalogEditActionsの完了コールバック（onSaved/onDeleted/
// onReverted）でonLibraryChangedを呼び、親（CatalogMaintenancePanel）はhandleLibraryChangedを
// props経由で渡していることを固定する——タブが自身のstateだけで完結し親へ知らせない退行を防ぐ。
// SectionTabだけ4箇所（保存・削除・標準に戻す＋SectionBulkImportのonImported＝規格文字列からの
// 追加。他3タブに「追加」の別経路は無いため3箇所のまま）。
for (const { tabName, signature, expectedCount } of [
  { tabName: 'FixtureSymbolTab', signature: 'function FixtureSymbolTab({ materialList, onLibraryChanged }) {', expectedCount: 3 },
  { tabName: 'InteriorMasterTab', signature: 'function InteriorMasterTab({ materialList, onLibraryChanged }) {', expectedCount: 3 },
  { tabName: 'SectionTab', signature: 'function SectionTab({ onLibraryChanged }) {', expectedCount: 4 },
  { tabName: 'OpeningSubTypeTab', signature: 'function OpeningSubTypeTab({ materialList, onLibraryChanged }) {', expectedCount: 3 },
]) {
  test(`【不変条件・QA指摘M1・ステップ12i】ui/CatalogMaintenancePanel.jsx: ${tabName}はonSaved/onDeleted/onRevertedのすべてでonLibraryChanged?.()を呼ぶ`, () => {
    const src = readSrc('ui/CatalogMaintenancePanel.jsx');
    const body = extractBalancedBody(src, signature);
    assert.ok(body, `CatalogMaintenancePanel.jsx に ${tabName}（onLibraryChanged引数付き）が見つからない`);
    const count = (body.match(/onLibraryChanged\?\.\(\)/g) ?? []).length;
    assert.equal(count, expectedCount, `${tabName} のonLibraryChanged?.()呼び出しが${expectedCount}箇所ではない（実際: ${count}）`);
  });
}

test('【不変条件・QA指摘M1・ステップ12i】ui/CatalogMaintenancePanel.jsx: 親は4タブへonLibraryChanged={handleLibraryChanged}を渡している', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  assert.ok(/<FixtureSymbolTab materialList=\{builtinList\} onLibraryChanged=\{handleLibraryChanged\} \/>/.test(src), 'FixtureSymbolTabへの配線が無い');
  assert.ok(/<InteriorMasterTab materialList=\{builtinList\} onLibraryChanged=\{handleLibraryChanged\} \/>/.test(src), 'InteriorMasterTabへの配線が無い');
  assert.ok(/<SectionTab onLibraryChanged=\{handleLibraryChanged\} \/>/.test(src), 'SectionTabへの配線が無い');
  assert.ok(/<OpeningSubTypeTab materialList=\{builtinList\} onLibraryChanged=\{handleLibraryChanged\} \/>/.test(src), 'OpeningSubTypeTabへの配線が無い');
});

// SectionTabの「規格文字列から追加」（SectionBulkImport）もuserライブラリを変更する唯一の追加
// 経路——onImportedでonLibraryChangedも呼ぶことを固定する（setRefreshTickだけでは親のtickが
// 進まずDeveloperExportPanelが更新されない）。
test('【不変条件・QA指摘M1・ステップ12i】ui/CatalogMaintenancePanel.jsx: SectionTabのSectionBulkImport onImportedはonLibraryChanged?.()も呼ぶ', () => {
  const src = readSrc('ui/CatalogMaintenancePanel.jsx');
  const body = extractBalancedBody(src, 'function SectionTab({ onLibraryChanged }) {');
  assert.ok(body, 'CatalogMaintenancePanel.jsx に SectionTab コンポーネントが見つからない');
  assert.ok(
    /onImported=\{\(\) => \{ setRefreshTick\(t => t \+ 1\); onLibraryChanged\?\.\(\); \}\}/.test(body),
    'SectionBulkImportのonImportedがonLibraryChanged?.()を呼んでいない',
  );
});
