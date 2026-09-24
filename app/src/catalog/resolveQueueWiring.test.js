// 指示UI（ステップ6-3・自動では置き換えない原則）の配線を固定する不変条件テスト（catalogMaintenanceWiring.test.js・
// catalogDiffViewWiring.test.js と同型——ソーステキストの正規表現検査）。
// 純ロジック（行の組み立て・候補選定・決定の適用）自体は resolveQueue.test.js が検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(appSrc, rel), 'utf8');
}

// catalogRegistryWiring.test.js と同じ方式（バランスの取れた波括弧で関数本体を抜き出す）。
function extractBalancedBody(src, signatureOrConstName, { isArrowIife = false } = {}) {
  const startIdx = src.indexOf(signatureOrConstName);
  if (startIdx < 0) return null;
  let braceStart;
  if (isArrowIife) {
    braceStart = src.indexOf('{', src.indexOf('=> {', startIdx));
  } else {
    const parenStart = src.indexOf('(', startIdx);
    let pdepth = 0, j = parenStart;
    for (; j < src.length; j++) {
      if (src[j] === '(') pdepth++;
      else if (src[j] === ')') { pdepth--; if (pdepth === 0) break; }
    }
    braceStart = src.indexOf('{', j);
  }
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

// ---- store.js: reconcileIncomingCatalogs（(a)/(c)/propose の行組み立て） ----
test('【不変条件・ステップ6-3】store.js: reconcileIncomingCatalogsはbuildResolveRowsの結果をreplaceRowsByScenario経由でproject.setCatalogResolveRowsへ積む', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function reconcileIncomingCatalogs() {');
  assert.ok(body, 'store.js に reconcileIncomingCatalogs が見つからない');
  assert.ok(/\bbuildResolveRows\(/.test(body), 'reconcileIncomingCatalogs が buildResolveRows を呼んでいない');
  assert.ok(
    /project\.setCatalogResolveRows\(\s*replaceRowsByScenario\(/.test(body),
    'reconcileIncomingCatalogs が replaceRowsByScenario 経由で project.setCatalogResolveRows していない（他検出元の行を消す退行）',
  );
  assert.ok(
    /\['library-conflict',\s*'unsupported',\s*'propose'\]/.test(body),
    'replaceRowsByScenario に置き換え対象の場面（library-conflict/unsupported/propose）を渡していない',
  );
});

// ---- store.js: applyCatalogResolutions（決定の反映。ステップ7d: 行が複数種別を持つため
// kindsをrowsから集めてkindDef(kind).loadBuiltin()経由でvalidKeysByKindを種別ごとに組み立てる） ----
test('【不変条件・ステップ7d QA指摘Major-2】store.js: applyCatalogResolutionsはrowsからkindの集合を集め、kindDef(kind).loadBuiltin()経由でcomposeCatalogしたvalidKeysByKind（Map<kind,Set>）をapplyResolveDecisionsの前に組み立てて渡す（単一Setへ合流しない）', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  assert.ok(
    /const kinds = \[\.\.\.new Set\(\s*rows\.map\(r => r\.kind\)\s*\)\]/.test(body),
    'applyCatalogResolutions が rows から kind の集合（kinds）を組み立てていない（複数種別対応への一般化が欠落）',
  );
  assert.ok(
    /const validKeysByKind = new Map\(\)/.test(body),
    'applyCatalogResolutions が validKeysByKind を Map として組み立てていない（単一Setへの合流への退行）',
  );
  const loopMatch = /for\s*\(\s*const kind of kinds\s*\)\s*\{/.exec(body);
  assert.ok(loopMatch, 'applyCatalogResolutions が kinds をforループしていない');
  const loopBody = extractBalancedBody(body, loopMatch[0]);
  assert.ok(loopBody, 'for (const kind of kinds) { ... } の中身を取得できない');
  assert.ok(/kindDef\(\s*kind\s*\)\.loadBuiltin\(\)/.test(loopBody), 'kindごとのbuiltin取得がkindDef(kind).loadBuiltin()経由になっていない（本体標準マスタを直接importする退行）');
  assert.ok(
    /validKeysByKind\.set\(\s*kind,\s*new Set\(\s*composeCatalog\(\s*kind,\s*builtinList\s*\)\.keys\(\)\s*\)\s*\)/.test(loopBody),
    'validKeysByKindの組み立てがkindごとにvalidKeysByKind.set(kind, new Set(composeCatalog(kind, builtinList).keys()))になっていない（種別をまたいだ合流への退行）',
  );
  assert.ok(
    !/import\(\s*['"]\.\/finish\/materials\//.test(body),
    'applyCatalogResolutions が本体標準マスタを直接動的importしている（kindDef(kind).loadBuiltin()未経由への退行）',
  );

  const applyIdx = body.indexOf('applyResolveDecisions(');
  assert.ok(applyIdx >= 0, 'applyCatalogResolutions が applyResolveDecisions を呼んでいない');
  assert.ok(
    /applyResolveDecisions\(\s*rows,\s*decisions,\s*\{\s*validKeysByKind\s*\}\s*\)/.test(body),
    'applyResolveDecisions に { validKeysByKind } を渡していない（QA指摘Major-1/ステップ7d QA指摘Major-2）',
  );
  assert.ok(body.indexOf('validKeysByKind') < applyIdx, 'validKeysByKindの組み立てはapplyResolveDecisions呼び出しより前でなければならない');
});

test('【不変条件・ステップ6-3・QA指摘Major-1】store.js: applyCatalogResolutionsはrejectedが非空ならproject.setCatalogErrorで通知する', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  const guardMatch = /if\s*\(\s*rejected\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(guardMatch, 'applyCatalogResolutions が rejected.length > 0 を分岐していない');
  const guardBody = extractBalancedBody(body, guardMatch[0]);
  assert.ok(guardBody, 'if (rejected.length > 0) { ... } の中身を取得できない');
  assert.ok(
    /project\.setCatalogError\(\s*`指定した代替が見つかりません/.test(guardBody),
    'rejectedの通知メッセージが「指定した代替が見つかりません」（種別非依存の文言）で始まっていない',
  );
});

// ---- QA指摘Minor-2（ステップ10e）: rejectedの通知メッセージはr.reasonも併記する
// （キーだけでは「見つかりません」に見えるが、実際はカテゴリ不一致等キー自体は実在する
// rejectedもあるため、理由を捨てると利用者に嘘の説明になる） ----
test('【不変条件・ステップ10e QA指摘Minor-2】store.js: applyCatalogResolutionsのrejected通知メッセージはr.reasonを併記する', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  const guardMatch = /if\s*\(\s*rejected\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(guardMatch, 'applyCatalogResolutions が rejected.length > 0 を分岐していない');
  const guardBody = extractBalancedBody(body, guardMatch[0]);
  assert.ok(guardBody, 'if (rejected.length > 0) { ... } の中身を取得できない');
  assert.ok(
    /rejected\.map\(\s*r\s*=>\s*`\$\{r\.key\}（\$\{r\.reason\}）`\s*\)/.test(guardBody),
    'rejectedの通知メッセージがr.reasonを併記していない（キーが実在してもカテゴリ不一致等で弾かれた理由が利用者に伝わらない退行）',
  );
});

test('【不変条件・ステップ6-3・QA指摘Minor-2】store.js: applyCatalogResolutionsのアクティブ階往復はaliasPairs.length > 0のときだけ行い、markDirtyはuserOps/aliasPairsそれぞれで独立して立つ', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');

  const userOpsGuardMatch = /if\s*\(\s*userOps\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(userOpsGuardMatch, 'if (userOps.length > 0) { ... } ブロックが見つからない');
  const userOpsBlock = extractBalancedBody(body, userOpsGuardMatch[0]);
  assert.ok(userOpsBlock, 'userOpsブロックの中身を取得できない');
  assert.ok(/commitUserEntries\(/.test(userOpsBlock), 'userOpsブロックがcommitUserEntriesを呼んでいない');
  assert.ok(/markDirty\(\)/.test(userOpsBlock), 'userOpsブロックがmarkDirty()を呼んでいない（ライブラリ変更のdirty化）');
  assert.ok(!/restoreGraph\(/.test(userOpsBlock), 'userOpsブロックの中でrestoreGraphを呼んでいる（往復はaliasPairsのときだけの契約への退行）');

  const aliasGuardMatch = /if\s*\(\s*aliasPairs\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(aliasGuardMatch, 'if (aliasPairs.length > 0) { ... } ブロックが見つからない');
  const aliasBlock = extractBalancedBody(body, aliasGuardMatch[0]);
  assert.ok(aliasBlock, 'aliasPairsブロックの中身を取得できない');
  assert.ok(/addDocumentAliases\(/.test(aliasBlock), 'aliasPairsブロックがaddDocumentAliasesを呼んでいない');
  assert.ok(
    /restoreGraph\(\s*activeGraph\s*,\s*serializeGraph\(\s*activeGraph\s*\)\s*\)/.test(aliasBlock),
    'aliasPairsブロックでrestoreGraph(activeGraph, serializeGraph(activeGraph))という同一グラフの往復を行っていない',
  );
  assert.ok(/markDirty\(\)/.test(aliasBlock), 'aliasPairsブロックがmarkDirty()を呼んでいない');

  assert.ok(
    !/if\s*\(\s*aliasPairs\.length\s*>\s*0\s*\|\|\s*userOps\.length\s*>\s*0\s*\)/.test(body),
    'aliasPairsとuserOpsを1本のif条件に戻している（往復条件を分ける契約への退行）',
  );

  assert.ok(
    /project\.setCatalogResolveRows\(\s*rows\.filter\(/.test(body),
    'applyCatalogResolutions が承認済み行を除去してproject.setCatalogResolveRowsしていない（保留行を残す契約）',
  );
});

// ---- store.js: applyCatalogResolutions（QA指摘Major-1・2026-09-23: alias確定でdocを外す） ----
test('【不変条件・QA指摘Major-1・2026-09-23】store.js: applyCatalogResolutionsのaliasPairsブロックがremoveDocEntryを呼び、docに無いfromは呼ばない（場面(b)対応）', () => {
  const src = readSrc('store.js');
  assert.ok(
    /\{[^}]*\bremoveDocEntry\b[^}]*\}\s*from\s*['"]\.\/catalog\/catalogRegistry\.js['"]/.test(src),
    'store.js が removeDocEntry を catalog/catalogRegistry.js から import していない',
  );
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  const aliasGuardMatch = /if\s*\(\s*aliasPairs\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(aliasGuardMatch, 'if (aliasPairs.length > 0) { ... } ブロックが見つからない');
  const aliasBlock = extractBalancedBody(body, aliasGuardMatch[0]);
  assert.ok(aliasBlock, 'aliasPairsブロックの中身を取得できない');
  assert.ok(/\bremoveDocEntry\(/.test(aliasBlock), 'aliasPairsブロックが removeDocEntry を呼んでいない（QA指摘Major-1）');
  assert.ok(
    /docKeys\.has\(\s*from\s*\)/.test(aliasBlock),
    'aliasPairsブロックが docKeys.has(from) で存在確認してから removeDocEntry を呼んでいない（場面(b)＝docに無いfromでは何もしない契約）',
  );
  // addDocumentAliases（読み替え追記）→ removeDocEntry（doc除去）→ restoreGraph（往復）の順序。
  const aliasesIdx = aliasBlock.indexOf('addDocumentAliases(');
  const removeIdx = aliasBlock.indexOf('removeDocEntry(');
  const restoreIdx = aliasBlock.indexOf('restoreGraph(');
  assert.ok(aliasesIdx >= 0 && removeIdx > aliasesIdx, 'removeDocEntry の呼び出しが addDocumentAliases より後になっていない');
  assert.ok(restoreIdx > removeIdx, 'restoreGraph（往復）が removeDocEntry より後になっていない');
});

// ---- store.js: applyCatalogResolutions（ステップ7d: kind混在は例外にせずkindでグループ化する） ----
test('【不変条件・ステップ7d】store.js: applyCatalogResolutionsのaliasPairsブロックはp.kindでグループ化し、種別ごとにaddDocumentAliases(kind, pairs)・removeDocEntry(kind, from)を呼ぶ（kind混在例外は無い）', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  const aliasGuardMatch = /if\s*\(\s*aliasPairs\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(aliasGuardMatch, 'if (aliasPairs.length > 0) { ... } ブロックが見つからない');
  const aliasBlock = extractBalancedBody(body, aliasGuardMatch[0]);
  assert.ok(aliasBlock, 'aliasPairsブロックの中身を取得できない');
  assert.ok(
    !/複数種別のaliasPairsは未対応です/.test(aliasBlock),
    'kind混在を例外で止める旧ガード（複数種別のaliasPairsは未対応です）が残っている（ステップ7dでkindグループ化へ一般化する契約への退行）',
  );
  const groupMatch = /for\s*\(\s*const \[pKind, pairs\] of pairsByKind\s*\)\s*\{/.exec(aliasBlock);
  assert.ok(groupMatch, 'aliasPairsブロックが pairsByKind を for (const [pKind, pairs] of pairsByKind) でループしていない（kindでのグループ化が欠落）');
  const groupBody = extractBalancedBody(aliasBlock, groupMatch[0]);
  assert.ok(groupBody, 'for (const [pKind, pairs] of pairsByKind) { ... } の中身を取得できない');
  assert.ok(/addDocumentAliases\(\s*pKind,\s*pairs\s*\)/.test(groupBody), 'グループ化ループが addDocumentAliases(pKind, pairs) を呼んでいない');
  assert.ok(/removeDocEntry\(\s*pKind,\s*from\s*\)/.test(groupBody), 'グループ化ループが removeDocEntry(pKind, from) を呼んでいない');
});

test('【不変条件・ステップ7d】store.js: applyCatalogResolutionsのuserOpsブロックはop.kindでグループ化し、種別ごとにcommitUserEntries(opKind, ...)を呼ぶ', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  const userOpsGuardMatch = /if\s*\(\s*userOps\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(userOpsGuardMatch, 'if (userOps.length > 0) { ... } ブロックが見つからない');
  const userOpsBlock = extractBalancedBody(body, userOpsGuardMatch[0]);
  assert.ok(userOpsBlock, 'userOpsブロックの中身を取得できない');
  const groupMatch = /for\s*\(\s*const \[opKind, ops\] of opsByKind\s*\)\s*\{/.exec(userOpsBlock);
  assert.ok(groupMatch, 'userOpsブロックが opsByKind を for (const [opKind, ops] of opsByKind) でループしていない（kindでのグループ化が欠落）');
  const groupBody = extractBalancedBody(userOpsBlock, groupMatch[0]);
  assert.ok(groupBody, 'for (const [opKind, ops] of opsByKind) { ... } の中身を取得できない');
  assert.ok(/commitUserEntries\(\s*opKind,/.test(groupBody), 'グループ化ループが commitUserEntries(opKind, ...) を呼んでいない');
});

// ---- store.js: resetAll ----
test('【不変条件・ステップ6-3】store.js: resetAllがproject.clearCatalogResolveRows()を呼んでいる', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function resetAll() {');
  assert.ok(body, 'store.js に resetAll が見つからない');
  assert.ok(/\bproject\.clearCatalogResolveRows\(\)/.test(body), 'resetAll が project.clearCatalogResolveRows() を呼んでいない');
});

// ---- modes/FinishModeState.js: 場面(b)の行組み立て ----
test('【不変条件・ステップ6-3】modes/FinishModeState.js: initがbuildResolveRows/peekUnresolvedCodesを使いcatalogResolveRowsを組み立てる', () => {
  const src = readSrc('modes/FinishModeState.js');
  assert.ok(/from ['"]\.\.\/catalog\/resolveQueue\.js['"]/.test(src), 'FinishModeState.js が catalog/resolveQueue.js を import していない');
  assert.ok(/\bbuildResolveRows\(/.test(src), 'FinishModeState.js が buildResolveRows を呼んでいない');
  assert.ok(/\bpeekUnresolvedCodes\(\)/.test(src), 'FinishModeState.js が peekUnresolvedCodes() を呼んでいない（非破壊で覗く契約。takeUnresolvedCodesではない）');
  assert.ok(!/\btakeUnresolvedCodes\(\)/.test(src), 'FinishModeState.js がtakeUnresolvedCodesを呼んでいる（他の消費者の蓄積を消してしまう退行。peekUnresolvedCodesを使う契約）');
  const initBody = extractBalancedBody(src, 'async init() {');
  assert.ok(initBody, 'FinishModeState.js に init() が見つからない');
  assert.ok(/catalogResolveRows/.test(initBody), 'init() の戻り値にcatalogResolveRowsが含まれていない');
});

// ---- modes/FinishModeState.js: catalogResolveKinds（ステップ8g。App.jsxの共通マージが
// s.catalogResolveKindsを読むため、StructuralModeStateと同じ場面(unresolved-code)で行を
// 積むFinishModeState側も自分の種別スコープを持たないと、構造モード突入がsection以外の
// scenarioを消さない代わりに、Finish突入時にsection行まで巻き込んで消してしまう） ----
test('【不変条件・ステップ8g】modes/FinishModeState.js: catalogResolveKindsがMATERIAL/INTERIOR_MASTER/BOUNDARY_MASTERの3種別', () => {
  const src = readSrc('modes/FinishModeState.js');
  assert.ok(
    /catalogResolveKinds\s*=\s*\[CatalogKind\.MATERIAL,\s*CatalogKind\.INTERIOR_MASTER,\s*CatalogKind\.BOUNDARY_MASTER\];/.test(src),
    'FinishModeState.js に catalogResolveKinds = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER] が見つからない',
  );
});

test('【不変条件・ステップ8g】modes/StructuralModeState.js: catalogResolveKindsが[CatalogKind.SECTION]', () => {
  const src = readSrc('modes/StructuralModeState.js');
  assert.ok(
    /catalogResolveKinds\s*=\s*\[CatalogKind\.SECTION\];/.test(src),
    'StructuralModeState.js に catalogResolveKinds = [CatalogKind.SECTION] が見つからない',
  );
});

test('【不変条件・ステップ10e→12d】modes/OpeningModeState.js: catalogResolveKindsが[CatalogKind.OPENING_SUB_TYPE, CatalogKind.FIXTURE_SYMBOL]', () => {
  const src = readSrc('modes/OpeningModeState.js');
  assert.ok(
    /catalogResolveKinds\s*=\s*\[CatalogKind\.OPENING_SUB_TYPE,\s*CatalogKind\.FIXTURE_SYMBOL\];/.test(src),
    'OpeningModeState.js に catalogResolveKinds = [CatalogKind.OPENING_SUB_TYPE, CatalogKind.FIXTURE_SYMBOL] が見つからない',
  );
});

// ---- QA指摘（ステップ8g）: modes/*.jsでcatalogResolveRows（場面(b)の行）を持つモードは
// catalogResolveKinds（App.jsxの共通マージ用の種別スコープ）も必ず持つ（片方だけ追加して
// もう片方を忘れる退行——App.jsxの共通replaceRowsByScenario呼び出しがkinds:undefinedになり
// 場面(unresolved-code)の他モード分の行を巻き込んで消してしまう）。 ----
test('【不変条件・ステップ8g QA指摘】modes/*.js: catalogResolveRowsを宣言するモードは必ずcatalogResolveKindsも宣言する', () => {
  const dir = path.resolve(appSrc, 'modes');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const hasRows = /\bcatalogResolveRows\s*=/.test(src);
    const hasKinds = /\bcatalogResolveKinds\s*=/.test(src);
    if (hasRows && !hasKinds) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `catalogResolveRowsはあるがcatalogResolveKindsが無いモードがある: ${offenders.join(', ')}`);
});

// ---- App.jsx: 動的import（連打ガード・lazy不使用）----
test('【不変条件・ステップ6-3】App.jsx: CatalogResolveDialogを動的import（import().then().catch()）で開き、lazy(は使わない', () => {
  const src = readSrc('App.jsx');
  assert.ok(!/\blazy\(/.test(src), 'App.jsx に lazy( が残っている（React.lazy+Suspense方式への退行）');
  assert.ok(
    !/^\s*import\s+\{[^}]*CatalogResolveDialog[^}]*\}\s+from\s+['"]\.\/ui\/CatalogResolveDialog\.jsx['"]/m.test(src),
    'App.jsx が CatalogResolveDialog.jsx を静的importしている（動的import契約への退行）',
  );
  assert.ok(/import\(['"]\.\/ui\/CatalogResolveDialog\.jsx['"]\)/.test(src), 'App.jsx が CatalogResolveDialog.jsx を動的importしていない');
  assert.ok(/catalogResolveLoadingRef/.test(src), 'App.jsx に連打ガード（catalogResolveLoadingRef）が無い');
  assert.ok(/\.catch\(/.test(src) && /確認ダイアログの読み込みに失敗/.test(src), 'App.jsx の動的import失敗時にトースト通知していない');
});

// ---- App.jsx: モード再ロードのトリガー（catalogReloadKey）----
test('【不変条件・ステップ6-3】App.jsx: applyCatalogResolutions適用後にcatalogReloadKeyを増分し、モード切替effectの依存配列に含める', () => {
  const src = readSrc('App.jsx');
  assert.ok(/setCatalogReloadKey\(k => k \+ 1\)/.test(src), 'App.jsx がapplyCatalogResolutions適用後にcatalogReloadKeyを増分していない');
  const m = /\[appMode, activeFloorId, catalogReloadKey\]/.exec(src);
  assert.ok(m, 'モード切替effectの依存配列に catalogReloadKey が含まれていない');
});

// ---- App.jsx: FinishModeState/StructuralModeState.init()の(b)行をproject側へマージ ----
test('【不変条件・ステップ6-3→8g】App.jsx: モードロード後にs.catalogResolveRowsをreplaceRowsByScenario(...,[\'unresolved-code\'], { kinds: s.catalogResolveKinds })でマージする', () => {
  const src = readSrc('App.jsx');
  assert.ok(/from ['"]\.\/catalog\/resolveQueue\.js['"]/.test(src), 'App.jsx が catalog/resolveQueue.js を import していない');
  assert.ok(
    /replaceRowsByScenario\(\s*project\.catalogResolveRows,\s*s\.catalogResolveRows,\s*\['unresolved-code'\],\s*\{\s*kinds:\s*s\.catalogResolveKinds\s*\}\s*\)/.test(src),
    'App.jsx が s.catalogResolveRows を replaceRowsByScenario で場面(unresolved-code)・種別(s.catalogResolveKinds)だけ置き換えてマージしていない（ステップ8g: kindsを渡さないとFinish/Structuralの片方のモード突入がもう片方の行を消す）',
  );
});

// ---- QA指摘（ステップ8g）: モード切替loaderの失敗（動的import・init()の例外）を握りつぶさず
// トースト通知する（他の動的import連打ガード=catalogResolveLoadingRef等と同じ.catch規約） ----
test('【不変条件・ステップ8g QA指摘】App.jsx: モード切替のloaderに.catchがあり、モードの読み込みに失敗しましたをトースト通知する', () => {
  const src = readSrc('App.jsx');
  const loaderThenIdx = src.indexOf('loader.then(');
  assert.ok(loaderThenIdx >= 0, 'App.jsx に loader.then(...) が見つからない');
  // loader.then(...) の閉じ括弧直後に .catch(...) が続くことを、波括弧の対応を数えて確認する
  // （modes/*ModeState.jsのextractBalancedBodyと同型。非貪欲正規表現だと途中のネストした
  // 波括弧で誤って打ち切る恐れがあるため）。
  let depth = 0, i = loaderThenIdx + 'loader.then('.length - 1; // 直前の '(' から数える
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  const afterThen = src.slice(i + 1, i + 20);
  assert.ok(/^\s*\.catch\(/.test(afterThen), `App.jsx の loader.then(...) に .catch(...) が続いていない（読み込み失敗を握りつぶす退行）: "${afterThen}"`);

  const catchIdx = src.indexOf('.catch(', i);
  assert.ok(catchIdx >= 0, 'App.jsx に loader.then(...).catch(...) の .catch が見つからない');
  let cdepth = 0, j = catchIdx + '.catch('.length - 1;
  for (; j < src.length; j++) {
    if (src[j] === '(') cdepth++;
    else if (src[j] === ')') { cdepth--; if (cdepth === 0) break; }
  }
  const catchBody = src.slice(catchIdx, j + 1);
  assert.ok(
    /モードの読み込みに失敗しました/.test(catchBody),
    'App.jsx の loader の catch がユーザー向けメッセージ「〇〇モードの読み込みに失敗しました」を出していない',
  );
  assert.ok(/setToast\(/.test(catchBody), 'App.jsx の loader の catch が setToast(...) を呼んでいない（握りつぶして無反応にする退行）');
});

// ---- App.jsx: 構造モード突入で await s.init() する（ステップ8g）----
test('【不変条件・ステップ8g】App.jsx: 構造モードのローダーがawait s.init()を呼んでいる（断面カタログの未解決検出は構造モード突入時）', () => {
  const src = readSrc('App.jsx');
  const m = /appMode === 'structure'\s*\?\s*import\('\.\/modes\/StructuralModeState\.js'\)\.then\(async m => \{([\s\S]*?)\}\)/.exec(src);
  assert.ok(m, "App.jsx の appMode==='structure' 分岐が async ローダー（.then(async m => {...})）になっていない");
  assert.ok(/await s\.init\(\)/.test(m[1]), '構造モードのローダーが await s.init() を呼んでいない');
});

// ---- App.jsx: 建具モード突入で await s.init() する（ステップ10e）----
test('【不変条件・ステップ10e】App.jsx: 建具モードのローダーがawait s.init()を呼んでいる（建具種別カタログの未解決検出は建具モード突入時）', () => {
  const src = readSrc('App.jsx');
  const m = /appMode === 'opening'\s*\?\s*import\('\.\/modes\/OpeningModeState\.js'\)\.then\(async m => \{([\s\S]*?)\}\)/.exec(src);
  assert.ok(m, "App.jsx の appMode==='opening' 分岐が async ローダー（.then(async m => {...})）になっていない");
  assert.ok(/await s\.init\(\)/.test(m[1]), '建具モードのローダーが await s.init() を呼んでいない');
});

// ---- modes/OpeningModeState.js: 場面(b)の行組み立て（ステップ10e） ----
test('【不変条件・ステップ10e】modes/OpeningModeState.js: initがkindDef(OPENING_SUB_TYPE).loadBuiltin→composeCatalog→buildResolveRows(kind:OPENING_SUB_TYPE)で行を組み立てる', () => {
  const src = readSrc('modes/OpeningModeState.js');
  assert.ok(/from ['"]\.\.\/catalog\/resolveQueue\.js['"]/.test(src), 'OpeningModeState.js が catalog/resolveQueue.js を import していない');
  assert.ok(/from ['"]\.\.\/catalog\/catalogRegistry\.js['"]/.test(src), 'OpeningModeState.js が catalog/catalogRegistry.js を import していない');
  const initBody = extractBalancedBody(src, 'async init() {');
  assert.ok(initBody, 'OpeningModeState.js に init() が見つからない');
  assert.ok(/kindDef\(\s*CatalogKind\.OPENING_SUB_TYPE\s*\)\.loadBuiltin\(\)/.test(initBody), 'init() が kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin() を呼んでいない（本体標準マスタを直接importする退行）');
  assert.ok(/composeCatalog\(\s*CatalogKind\.OPENING_SUB_TYPE,/.test(initBody), 'init() が composeCatalog(CatalogKind.OPENING_SUB_TYPE, ...) を呼んでいない');
  assert.ok(/buildResolveRows\(\s*\{\s*kind:\s*CatalogKind\.OPENING_SUB_TYPE,/.test(initBody), 'init() が buildResolveRows({ kind: CatalogKind.OPENING_SUB_TYPE, ... }) を呼んでいない');
  assert.ok(/catalogResolveRows/.test(initBody), 'init() の戻り値にcatalogResolveRowsが含まれていない');
  assert.ok(/from ['"]\.\.\/catalog\/codeNormalization\.js['"]/.test(src), 'OpeningModeState.js が catalog/codeNormalization.js を import していない');
  assert.ok(/\bpeekUnresolvedCodes\(\)/.test(initBody), 'init() が peekUnresolvedCodes() を呼んでいない（StructuralModeState.init と同型で全階累積の未解決をopeningSubTypeでフィルタして合流する契約）');
  assert.ok(!/\btakeUnresolvedCodes\(\)/.test(src), 'OpeningModeState.js がtakeUnresolvedCodesを呼んでいる（他の消費者の蓄積を消してしまう退行。peekUnresolvedCodesを使う契約）');
});

// ---- modes/OpeningModeState.js: 場面(b)の行組み立て・建具記号（fixtureSymbol。ステップ12d） ----
test('【不変条件・ステップ12d】modes/OpeningModeState.js: initがkindDef(FIXTURE_SYMBOL).loadBuiltin→composeCatalog→buildResolveRows(kind:FIXTURE_SYMBOL)で行を組み立てる', () => {
  const src = readSrc('modes/OpeningModeState.js');
  const initBody = extractBalancedBody(src, 'async init() {');
  assert.ok(initBody, 'OpeningModeState.js に init() が見つからない');
  assert.ok(/kindDef\(\s*CatalogKind\.FIXTURE_SYMBOL\s*\)\.loadBuiltin\(\)/.test(initBody), 'init() が kindDef(CatalogKind.FIXTURE_SYMBOL).loadBuiltin() を呼んでいない（本体標準マスタを直接importする退行）');
  assert.ok(/composeCatalog\(\s*CatalogKind\.FIXTURE_SYMBOL,/.test(initBody), 'init() が composeCatalog(CatalogKind.FIXTURE_SYMBOL, ...) を呼んでいない');
  assert.ok(/buildResolveRows\(\s*\{\s*kind:\s*CatalogKind\.FIXTURE_SYMBOL,/.test(initBody), 'init() が buildResolveRows({ kind: CatalogKind.FIXTURE_SYMBOL, ... }) を呼んでいない');
});

// ---- modes/StructuralModeState.js: 場面(b)の行組み立て（ステップ8g） ----
test('【不変条件・ステップ8g】modes/StructuralModeState.js: initがkindDef(SECTION).loadBuiltin→composeCatalog→buildResolveRows(kind:SECTION)で行を組み立てる', () => {
  const src = readSrc('modes/StructuralModeState.js');
  assert.ok(/from ['"]\.\.\/catalog\/resolveQueue\.js['"]/.test(src), 'StructuralModeState.js が catalog/resolveQueue.js を import していない');
  assert.ok(/from ['"]\.\.\/catalog\/catalogRegistry\.js['"]/.test(src), 'StructuralModeState.js が catalog/catalogRegistry.js を import していない');
  const initBody = extractBalancedBody(src, 'async init() {');
  assert.ok(initBody, 'StructuralModeState.js に init() が見つからない');
  assert.ok(/kindDef\(\s*CatalogKind\.SECTION\s*\)\.loadBuiltin\(\)/.test(initBody), 'init() が kindDef(CatalogKind.SECTION).loadBuiltin() を呼んでいない（本体標準マスタを直接importする退行）');
  assert.ok(/composeCatalog\(\s*CatalogKind\.SECTION,/.test(initBody), 'init() が composeCatalog(CatalogKind.SECTION, ...) を呼んでいない');
  assert.ok(/buildResolveRows\(\s*\{\s*kind:\s*CatalogKind\.SECTION,/.test(initBody), 'init() が buildResolveRows({ kind: CatalogKind.SECTION, ... }) を呼んでいない');
  assert.ok(/catalogResolveRows/.test(initBody), 'init() の戻り値にcatalogResolveRowsが含まれていない');
  assert.ok(/from ['"]\.\.\/catalog\/codeNormalization\.js['"]/.test(src), 'StructuralModeState.js が catalog/codeNormalization.js を import していない');
  assert.ok(/\bpeekUnresolvedCodes\(\)/.test(initBody), 'init() が peekUnresolvedCodes() を呼んでいない（FinishModeState.init と同型で全階累積の未解決をsectionでフィルタして合流する契約）');
  assert.ok(!/\btakeUnresolvedCodes\(\)/.test(src), 'StructuralModeState.js がtakeUnresolvedCodesを呼んでいる（他の消費者の蓄積を消してしまう退行。peekUnresolvedCodesを使う契約）');
});

// ---- QA指摘（ステップ8g）: SECTION_MEMBER_LISTSの唯一の定義はcatalog/codeNormalization.js。
// modes/StructuralModeState.js は自前で再定義せずimportする（片方だけ増やす変異が構造的に
// 不可能になる。二重定義への退行を検知） ----
test('【不変条件・ステップ8g QA指摘】modes/StructuralModeState.js: SECTION_MEMBER_LISTSを自前定義せずcatalog/codeNormalization.jsからimportする', () => {
  const src = readSrc('modes/StructuralModeState.js');
  assert.ok(
    /import\s*\{[^}]*\bSECTION_MEMBER_LISTS\b[^}]*\}\s*from\s*['"]\.\.\/catalog\/codeNormalization\.js['"]/.test(src),
    'StructuralModeState.js が SECTION_MEMBER_LISTS を catalog/codeNormalization.js から import していない',
  );
  assert.ok(
    !/const SECTION_MEMBER_LISTS\s*=/.test(src),
    'StructuralModeState.js が SECTION_MEMBER_LISTS を自前で再定義している（catalog/codeNormalization.js との二重定義への退行）',
  );
});

test('【不変条件・ステップ8g QA指摘】catalog/codeNormalization.js: SECTION_MEMBER_LISTSをexportしている', () => {
  const src = readSrc('catalog/codeNormalization.js');
  assert.ok(
    /export const SECTION_MEMBER_LISTS\s*=/.test(src),
    'catalog/codeNormalization.js が SECTION_MEMBER_LISTS をexportしていない',
  );
});

// ---- QA指摘（コーディネーター裁定・2026-09-23）: 指示UIの既定の決定（propose行は既定defer）は
// catalog/resolveQueue.js defaultResolveDecideの唯一の定義箇所。ui/CatalogResolveDialog.jsx は
// 自前でロジックを再実装せずそれをimportする（二重実装への退行を検知） ----
test('【不変条件・QA指摘】ui/CatalogResolveDialog.jsx: defaultDecisionはcatalog/resolveQueue.jsのdefaultResolveDecisionをimportして使う（自前の再実装を持たない）', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(
    /from ['"]\.\.\/catalog\/resolveQueue\.js['"]/.test(src),
    'CatalogResolveDialog.jsx が catalog/resolveQueue.js を import していない',
  );
  assert.ok(
    /\bdefaultResolveDecision\b/.test(src),
    'CatalogResolveDialog.jsx が defaultResolveDecision を参照していない',
  );
  assert.ok(
    !/function defaultDecision\(row\)/.test(src),
    'CatalogResolveDialog.jsx に defaultDecision のローカル関数実装が残っている（catalog/resolveQueue.jsとの二重実装への退行）',
  );
});

// ---- ui/CatalogResolveDialog.jsx: 純ロジックはcatalog/*.js経由、buildCatalogRowsの再利用 ----
// ステップ7d QA指摘Major-1: 代替ピッカーはMaterialPicker→EntryPickerへ一般化し、
// buildMaterialRows（material専用）ではなくbuildCatalogRows（kind引数を取る汎用版）を使う。
test('【不変条件・ステップ7d QA指摘Major-1】ui/CatalogResolveDialog.jsx: 代替ピッカー（EntryPicker）はcatalog/catalogMaintenance.jsのbuildCatalogRowsをkind付きで再利用し、row.kindでbuiltinListByKindを引く', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src), 'CatalogResolveDialog.jsx が catalog/catalogMaintenance.js を import していない');
  assert.ok(/\bbuildCatalogRows\(/.test(src), 'CatalogResolveDialog.jsx が buildCatalogRows を呼んでいない（material専用buildMaterialRowsへの退行）');
  assert.ok(
    !/\bbuildMaterialRows\(/.test(src),
    'CatalogResolveDialog.jsx が buildMaterialRows を呼んでいる（material専用ピッカーへの退行。非material行のpickが機能しない）',
  );
  assert.ok(
    /decision\.action === 'pick' && builtinListByKind\?\.\[row\.kind\]/.test(src),
    'ResolveRowのピッカー表示条件が row.kind で builtinListByKind を引いていない（material限定条件への退行）',
  );
  assert.ok(/kindDef\(\s*kind\s*\)\.keyOf\(/.test(src), 'EntryPickerがkindDef(kind).keyOf(...)で値を組み立てていない');
});

// ---- ステップ10e QA指摘Minor-4: EntryPickerがopeningSubTypeのときrow.targetKeyのcategoryで
// 一覧を絞る（categoryFilterの受け渡しと実装本体をアンカー。コメント文には当たらない形）----
test('【不変条件・ステップ10e QA指摘Minor-4】ui/CatalogResolveDialog.jsx: EntryPickerはcategoryFilterでrowsを絞り、ResolveRowがopeningCategoryOf(row.targetKey)をopeningSubType行にだけ渡す', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  const pickerBody = extractBalancedBody(src, 'function EntryPicker(');
  assert.ok(pickerBody, 'ui/CatalogResolveDialog.jsx に EntryPicker が見つからない');
  assert.ok(
    /if\s*\(\s*categoryFilter\s*\)\s*rows\s*=\s*rows\.filter\(/.test(pickerBody),
    'EntryPicker が categoryFilter で rows.filter(...) していない（openingSubTypeのカテゴリ跨ぎ選択肢を絞る契約への退行）',
  );
  assert.ok(
    /categoryFilter\s*=\s*\{\s*row\.kind\s*===\s*CatalogKind\.OPENING_SUB_TYPE\s*\?\s*openingCategoryOf\(\s*row\.targetKey\s*\)\s*:\s*null\s*\}/.test(src),
    'ResolveRow が categoryFilter={row.kind === CatalogKind.OPENING_SUB_TYPE ? openingCategoryOf(row.targetKey) : null} でEntryPickerへ渡していない',
  );
});

test('【不変条件・ステップ10e QA指摘Minor-5】ui/CatalogResolveDialog.jsx: category抽出はcatalog/resolveQueue.jsのopeningCategoryOfを使う（自前のsplit(\':\')実装を持たない）', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(/\bopeningCategoryOf\b/.test(src), 'CatalogResolveDialog.jsx が openingCategoryOf を参照していない');
  assert.ok(
    !/split\(\s*['"]:['"]\s*\)/.test(src),
    'CatalogResolveDialog.jsx に split(\':\') の自前実装が残っている（openingCategoryOfへの一本化への退行）',
  );
});

test('【不変条件・ステップ6-3・QA指摘Minor-5】ui/CatalogResolveDialog.jsx: フッターに保存するまで確定しない旨の注記がある', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(
    /読み替えは文書を保存するまで確定しません（保存前に閉じると次回また確認します）。ライブラリへの追加・変更は承認時に保存されます/.test(src),
    'CatalogResolveDialog.jsx のフッターに「読み替えは文書を保存するまで確定しません…ライブラリへの追加・変更は承認時に保存されます」の注記が無い（読み替え＝保存時確定／ライブラリ＝承認時即保存、の区別を利用者に示す）',
  );
});

test('【不変条件・ステップ6-3】ui/CatalogResolveDialog.jsx: 差分表示はcatalog/catalogDiffView.jsのCATALOG_DIFF_COLOR/diffPairsを使う', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogDiffView\.js['"]/.test(src), 'CatalogResolveDialog.jsx が catalog/catalogDiffView.js を import していない');
  assert.ok(/\bdiffPairs\(/.test(src), 'CatalogResolveDialog.jsx が diffPairs を呼んでいない');
  assert.ok(!/#f97316/.test(src), 'CatalogResolveDialog.jsx に色 #f97316 が直書きされている（CATALOG_DIFF_COLOR経由に一本化する契約への退行）');
});
