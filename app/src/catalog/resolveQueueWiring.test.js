// 指示UI（ステップ6-3・R10）の配線を固定する不変条件テスト（catalogMaintenanceWiring.test.js・
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

// ---- store.js: applyCatalogResolutions（決定の反映） ----
test('【不変条件・ステップ6-3】store.js: applyCatalogResolutionsはapplyResolveDecisionsの前にvalidKeys（composeCatalog由来）を組み立てて渡す', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  assert.ok(
    /validKeys\s*=\s*new Set\(\s*composeCatalog\(\s*kind,\s*matMod\.MATERIALS\s*\)\.keys\(\)\s*\)/.test(body),
    'validKeysをcomposeCatalog(kind, matMod.MATERIALS).keys()から組み立てていない（QA指摘Major-1）',
  );
  const applyIdx = body.indexOf('applyResolveDecisions(');
  assert.ok(applyIdx >= 0, 'applyCatalogResolutions が applyResolveDecisions を呼んでいない');
  assert.ok(
    /applyResolveDecisions\(\s*rows,\s*decisions,\s*\{\s*validKeys\s*\}\s*\)/.test(body),
    'applyResolveDecisions に { validKeys } を渡していない（QA指摘Major-1: 未知コード・空白のみのpickを保留に戻せない）',
  );
  assert.ok(body.indexOf('validKeys') < applyIdx, 'validKeysの組み立てはapplyResolveDecisions呼び出しより前でなければならない');
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
    /project\.setCatalogError\(\s*`指定した代替材が見つかりません/.test(guardBody),
    'rejectedの通知メッセージが「指定した代替材が見つかりません」で始まっていない',
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

// ---- store.js: applyCatalogResolutions（ステップ7a Minor: 複数種別混入の防御） ----
test('【不変条件・ステップ7a Minor】store.js: applyCatalogResolutionsのaliasPairsブロックがkind混在（material以外の混入）を例外で止める', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function applyCatalogResolutions(decisions) {');
  assert.ok(body, 'store.js に applyCatalogResolutions が見つからない');
  const aliasGuardMatch = /if\s*\(\s*aliasPairs\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(aliasGuardMatch, 'if (aliasPairs.length > 0) { ... } ブロックが見つからない');
  const aliasBlock = extractBalancedBody(body, aliasGuardMatch[0]);
  assert.ok(aliasBlock, 'aliasPairsブロックの中身を取得できない');
  assert.ok(
    /p\.kind\s*!==\s*kind/.test(aliasBlock),
    'aliasPairsブロックがp.kind !== kind（material以外の混入）を検査していない（7d未対応のまま多種別が来た場合の防御）',
  );
  assert.ok(
    /throw new Error\(\s*`複数種別のaliasPairsは未対応です/.test(aliasBlock),
    'kind混在検出時に「複数種別のaliasPairsは未対応です」で始まる例外を投げていない',
  );
  const mixedGuardIdx = aliasBlock.search(/p\.kind\s*!==\s*kind/);
  const addAliasesIdx = aliasBlock.indexOf('addDocumentAliases(');
  assert.ok(mixedGuardIdx >= 0 && addAliasesIdx > mixedGuardIdx, 'kind混在チェックはaddDocumentAliasesより前でなければならない');
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

// ---- App.jsx: FinishModeState.init()の(b)行をproject側へマージ ----
test('【不変条件・ステップ6-3】App.jsx: モードロード後にs.catalogResolveRowsをreplaceRowsByScenario(...,[\'unresolved-code\'])でマージする', () => {
  const src = readSrc('App.jsx');
  assert.ok(/from ['"]\.\/catalog\/resolveQueue\.js['"]/.test(src), 'App.jsx が catalog/resolveQueue.js を import していない');
  assert.ok(
    /replaceRowsByScenario\(\s*project\.catalogResolveRows,\s*s\.catalogResolveRows,\s*\['unresolved-code'\]\s*\)/.test(src),
    'App.jsx が s.catalogResolveRows を replaceRowsByScenario で場面(unresolved-code)だけ置き換えてマージしていない',
  );
});

// ---- ui/CatalogResolveDialog.jsx: 純ロジックはcatalog/*.js経由、buildMaterialRowsの再利用 ----
test('【不変条件・ステップ6-3】ui/CatalogResolveDialog.jsx: 代替材ピッカーはcatalog/catalogMaintenance.jsのbuildMaterialRowsを再利用する', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogMaintenance\.js['"]/.test(src), 'CatalogResolveDialog.jsx が catalog/catalogMaintenance.js を import していない');
  assert.ok(/\bbuildMaterialRows\(/.test(src), 'CatalogResolveDialog.jsx が buildMaterialRows を呼んでいない');
});

test('【不変条件・ステップ6-3・QA指摘Minor-5】ui/CatalogResolveDialog.jsx: フッターに保存するまで確定しない旨の注記がある', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(
    /読み替えは文書を保存するまで確定しません（保存前に閉じると次回また確認します）。ライブラリへの追加・変更は承認時に保存されます/.test(src),
    'CatalogResolveDialog.jsx のフッターに「読み替えは文書を保存するまで確定しません…ライブラリへの追加・変更は承認時に保存されます」の注記が無い（読み替え＝保存時確定／ライブラリ＝承認時即保存、の区別を利用者に示す）',
  );
});

test('【不変条件・ステップ6-3】ui/CatalogResolveDialog.jsx: R13差分表示はcatalog/catalogDiffView.jsのCATALOG_DIFF_COLOR/diffPairsを使う', () => {
  const src = readSrc('ui/CatalogResolveDialog.jsx');
  assert.ok(/from ['"]\.\.\/catalog\/catalogDiffView\.js['"]/.test(src), 'CatalogResolveDialog.jsx が catalog/catalogDiffView.js を import していない');
  assert.ok(/\bdiffPairs\(/.test(src), 'CatalogResolveDialog.jsx が diffPairs を呼んでいない');
  assert.ok(!/#f97316/.test(src), 'CatalogResolveDialog.jsx に色 #f97316 が直書きされている（CATALOG_DIFF_COLOR経由に一本化する契約への退行）');
});
