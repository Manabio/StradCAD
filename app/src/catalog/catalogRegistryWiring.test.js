// 本番の読み出し口（finish/wallRegeneration.js・modes/FinishModeState.js・
// modes/ElevationModeState.js・ui/EccentricityDialog.jsx）が catalogRegistry.js の
// composeCatalog/composeList を経由してMATERIALSを読んでいることを固定する不変条件テスト
// （finish/wallFreshnessKey.test.js:192-207 と同じ型——ソーステキストの正規表現検査）。
// `new Map(MATERIALS.map(...))` へ手で戻す退行（overlayを無視する退行）を検知する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(appSrc, rel), 'utf8');
}

const CONSUMERS = [
  { rel: 'finish/wallRegeneration.js', label: 'loadMaterialMap' },
  { rel: 'modes/FinishModeState.js', label: 'init（materials/materialMap）' },
  { rel: 'modes/ElevationModeState.js', label: 'init（materialMap）' },
  { rel: 'ui/EccentricityDialog.jsx', label: 'materialMapロード' },
];

for (const { rel, label } of CONSUMERS) {
  test(`【不変条件】${rel}: ${label}はcatalogRegistry.jsのcompose経由でMATERIALSを読む（new Map(MATERIALS.map(...))への退行を検知）`, () => {
    const src = readSrc(rel);
    assert.ok(
      /from ['"][^'"]*catalog\/catalogRegistry\.js['"]/.test(src),
      `${rel} が catalog/catalogRegistry.js を import していない`,
    );
    assert.ok(
      /\bcompose(Catalog|List)\(/.test(src),
      `${rel} が composeCatalog/composeList を呼んでいない`,
    );
    assert.ok(
      !/new Map\(\s*(matMod\.)?MATERIALS\.map/.test(src),
      `${rel} が composeCatalog/composeList を経由せず直接 new Map(MATERIALS.map(...)) を組んでいる（退行）`,
    );
  });
}

// 設計書（catalog-design.md）どおり、EccentricityDialog.jsxはsetMaterials/setMaterialMapの
// 両方がcompose経由であることを固定する（coordinator指摘・2026-09-22: setMaterialsが
// matMod.MATERIALSの直読みに戻る退行を検知）。
test('【不変条件】ui/EccentricityDialog.jsx: setMaterialsもcomposeList経由でMATERIALSを読む（setMaterials(matMod.MATERIALS)への退行を検知）', () => {
  const src = readSrc('ui/EccentricityDialog.jsx');
  assert.ok(
    /setMaterials\(\s*composeList\(/.test(src),
    'EccentricityDialog.jsx の setMaterials が composeList(...) を経由していない',
  );
  assert.ok(
    !/setMaterials\(\s*matMod\.MATERIALS\s*\)/.test(src),
    'EccentricityDialog.jsx の setMaterials が matMod.MATERIALS を直接渡している（composeList未経由への退行）',
  );
});

test('【不変条件】modes/FinishModeState.js: 材コード判定はcatalog/materialCode.jsのisMaterialCodeを使う（正規表現の重複定義への退行を検知）', () => {
  const src = readSrc('modes/FinishModeState.js');
  assert.ok(
    /from ['"][^'"]*catalog\/materialCode\.js['"]/.test(src),
    'FinishModeState.js が catalog/materialCode.js を import していない',
  );
  assert.ok(/\bisMaterialCode\(/.test(src), 'FinishModeState.js が isMaterialCode を呼んでいない');
  assert.ok(!/\/\^\\d\{12\}\$\//.test(src), 'FinishModeState.js に12桁コードの正規表現がまだ直書きされている');
});

// ステップ4: 「新規（全消去）」= store.js の resetAll が clearOverlays（catalogRegistry.js）・
// clearDocumentAliases（codeNormalization.js）・project.setCatalogError(null) を呼ぶ配線。
// 予告どおりソーステキスト検査で固定する（他の不変条件テストと同じ型）。
test('【不変条件・ステップ4→7a改訂】store.js: resetAllの関数本体がclearOverlays・takeUnresolvedCodes・clearDocumentAliases・project.setCatalogError(null)を呼んでいる', () => {
  const src = readSrc('store.js');
  const m = /export async function resetAll\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'store.js に resetAll 関数が見つからない');
  const body = m[1];
  assert.ok(/\bclearOverlays\(\)/.test(body), 'resetAll が clearOverlays() を呼んでいない');
  assert.ok(/\btakeUnresolvedCodes\(\)/.test(body), 'resetAll が takeUnresolvedCodes() を呼んでいない（未解決コードの蓄積を捨てる契約）');
  assert.ok(/\bclearDocumentAliases\(\)/.test(body), 'resetAll が clearDocumentAliases() を呼んでいない（ステップ7aでsetDocumentAliases(null)から移行。全種別解除の契約）');
  assert.ok(/\bproject\.setCatalogError\(null\)/.test(body), 'resetAll が project.setCatalogError(null) を呼んでいない');
});

test('【不変条件・ステップ4→7c改名】store.js: saveToIDBはcommitFloorsToDocumentの後に使用キーを収集・保存している（saveCatalogDocument呼び出しが後）', () => {
  const src = readSrc('store.js');
  const m = /export async function saveToIDB\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'store.js に saveToIDB 関数が見つからない');
  const body = m[1];
  const commitIdx = body.indexOf('commitFloorsToDocument(');
  const saveCatalogIdx = body.indexOf('saveCatalogDocument(');
  assert.ok(commitIdx >= 0, 'saveToIDB が commitFloorsToDocument を呼んでいない');
  assert.ok(saveCatalogIdx >= 0, 'saveToIDB が saveCatalogDocument を呼んでいない');
  assert.ok(saveCatalogIdx > commitIdx, 'saveCatalogDocument はcommitFloorsToDocumentより後に呼ぶ契約（floors確定後に全階を収集する）');
});

test('【不変条件・ステップ4】store.js: exportDocumentはIDBから読み戻したdocCatalogRecords（loadDocumentCatalogs）をcatalogsへ載せる（二重走査しない）', () => {
  const src = readSrc('store.js');
  const m = /export async function exportDocument\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'store.js に exportDocument 関数が見つからない');
  const body = m[1];
  assert.ok(/\bloadDocumentCatalogs\(/.test(body), 'exportDocument が loadDocumentCatalogs を呼んでいない（IDBからの読み戻し）');
  assert.ok(
    !/collectUsedMaterialCodes|collectUsedKeys|buildDocumentBundle/.test(body),
    'exportDocument が使用エントリの再収集（collectUsedMaterialCodes等）を行っている（saveToIDBとの二重走査への退行）',
  );
});

// ---- 波括弧の対応を数えて関数本体を取り出す（wallRefresh.test.js の bootReady 抽出と同型。
// ネストしたブロック（if/for等）を含む本体を非貪欲正規表現で誤って途中打ち切りしないため）----
// 通常の関数（isArrowIife:false）は、まず引数リストの丸括弧を対応させて閉じ位置を求めてから
// その後の最初の { を本体開始とする——分割代入引数（`({ a, b } = {}) {`）を持つ関数で、
// 引数側のオブジェクトパターンの { を本体開始と誤認しないため（2026-09-22 再QA対応で追加した
// loadCatalogOverlaysFromIDB({ ... } = {}) のような形を正しく扱うために必要）。
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

// 2026-09-22 QA指摘C: bootReadyがloadCatalogOverlaysFromIDBを呼び、setupStructGraph（最初の
// restoreGraph=floorSwapManager.activateより前）より前であることを固定する。
// 呼び出し削除・後ろへの移動のどちらの変異でも赤くなる（indexOf(-1) < idx は数学的にtrueに
// なってしまうため、両方が存在すること自体も個別に assert する）。
test('【不変条件・ステップ4】store.js: bootReadyがloadCatalogOverlaysFromIDBをsetupStructGraphより前に呼んでいる', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export const bootReady', { isArrowIife: true });
  assert.ok(body, 'store.js に bootReady のIIFE本体が見つからない');
  const overlayIdx = body.indexOf('loadCatalogOverlaysFromIDB(');
  const structIdx  = body.indexOf('setupStructGraph(');
  assert.ok(overlayIdx >= 0, 'bootReady が loadCatalogOverlaysFromIDB を呼んでいない（呼び出し削除への退行）');
  assert.ok(structIdx >= 0, 'bootReady が setupStructGraph を呼んでいない');
  assert.ok(
    overlayIdx < structIdx,
    'loadCatalogOverlaysFromIDB は setupStructGraph より前に呼ぶ契約（overlayが立ってから壁生成・材照合が走る。後ろへの移動への退行）',
  );
});

// ステップ6-1: bootReadyがreconcileIncomingCatalogsをloadCatalogOverlaysFromIDBの直後・
// setupStructGraphより前に呼んでいることを固定する（順序不変条件。overlayが立ってから照合し、
// 構造復元より前に文書同梱・ユーザーライブラリの整合を取る）。
test('【不変条件・ステップ6-1】store.js: bootReadyがreconcileIncomingCatalogsをloadCatalogOverlaysFromIDBの直後・setupStructGraphより前に呼んでいる', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export const bootReady', { isArrowIife: true });
  assert.ok(body, 'store.js に bootReady のIIFE本体が見つからない');
  const overlayIdx = body.indexOf('loadCatalogOverlaysFromIDB(');
  const reconcileIdx = body.indexOf('reconcileIncomingCatalogs(');
  const structIdx  = body.indexOf('setupStructGraph(');
  assert.ok(overlayIdx >= 0, 'bootReady が loadCatalogOverlaysFromIDB を呼んでいない');
  assert.ok(reconcileIdx >= 0, 'bootReady が reconcileIncomingCatalogs を呼んでいない（呼び出し削除への退行）');
  assert.ok(structIdx >= 0, 'bootReady が setupStructGraph を呼んでいない');
  assert.ok(
    overlayIdx < reconcileIdx,
    'reconcileIncomingCatalogs は loadCatalogOverlaysFromIDB より後に呼ぶ契約（overlayが立ってから照合する）',
  );
  assert.ok(
    reconcileIdx < structIdx,
    'reconcileIncomingCatalogs は setupStructGraph より前に呼ぶ契約（後ろへの移動への退行）',
  );
});

// ステップ6-1・QA Minor1 → ステップ6-3改訂（コーディネーターQA指摘・退行修正）: 場面(a)
// library-conflictの検出（detectLibraryConflicts）はdocが無くてもuserがあれば必要——しかし
// doc・userが両方空（同梱もライブラリも無い新規文書）なら照合・検出とも対象が無いため、
// materialData.jsを読まずに即returnする契約（設計3.1）。guardは
// `if (doc.length === 0 && user.length === 0) return;` で、doc固有処理（planIncomingReconcile/
// applyReconcilePlan/通知）はさらに `if (doc.length > 0)` で条件分岐し、
// materialData.jsの動的import自体とlibraryConflicts検出はguardを通過すれば常に行う。
test('【不変条件・ステップ6-3・QA指摘修正】store.js: reconcileIncomingCatalogsはdoc・user両方空ならmaterialData.jsを読まず即returnし、userだけあれば読む（場面(a)のため）', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function reconcileIncomingCatalogs() {');
  assert.ok(body, 'store.js に reconcileIncomingCatalogs が見つからない');

  const guardMatch = /if\s*\(\s*doc\.length\s*===\s*0\s*&&\s*user\.length\s*===\s*0\s*\)\s*return;/.exec(body);
  assert.ok(guardMatch, 'reconcileIncomingCatalogs にdoc・user両方空のearly returnガードが無い（新規文書起動でmaterialData.jsを読んでしまう退行）');
  assert.ok(
    !/if\s*\(\s*doc\.length\s*===\s*0\s*\)\s*return;/.test(body),
    'docだけを見るearly returnが残っている（userだけあれば場面(a)検出のため読む契約に反する）',
  );

  const importIdx = body.indexOf("import('./finish/materials/materialData.js')");
  assert.ok(importIdx >= 0, 'reconcileIncomingCatalogs が materialData.js を動的importしていない');
  assert.ok(
    guardMatch.index < importIdx,
    'doc・user両方空のearly returnガードは materialData.js の動的importより前になければならない（不変条件7-1）',
  );

  const docGuardMatch = /if\s*\(\s*doc\.length\s*>\s*0\s*\)\s*\{/.exec(body);
  assert.ok(docGuardMatch, 'doc固有処理（planIncomingReconcile等）を if (doc.length > 0) で分岐していない');
  assert.ok(
    importIdx < docGuardMatch.index,
    'materialData.jsの動的importはdoc固有分岐より前（＝docが空でもuserがあれば読む）でなければならない',
  );
  const docBlock = extractBalancedBody(body, 'if (doc.length > 0) {');
  assert.ok(docBlock, 'if (doc.length > 0) { ... } ブロックの中身を取得できない');
  assert.ok(!/detectLibraryConflicts\(/.test(docBlock), 'detectLibraryConflicts がif (doc.length > 0)ブロックの中にある（docが空だと呼ばれない退行）');
  const afterDocBlock = body.slice(body.indexOf(docBlock) + docBlock.length);
  assert.ok(/detectLibraryConflicts\(/.test(afterDocBlock), 'detectLibraryConflicts の呼び出しがif (doc.length > 0)ブロックの外に見つからない');
});

// ステップ6-1: reconcileIncomingCatalogsは失敗（builtinロード失敗・commitUserFnのreject等）を
// try/catchで握りproject.setCatalogError(e.message)だけを立てる（bootReady自体を落とさない）。
test('【不変条件・ステップ6-1】store.js: reconcileIncomingCatalogsはtry/catchで失敗を握りproject.setCatalogError(e.message)を立てる', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function reconcileIncomingCatalogs() {');
  assert.ok(body, 'store.js に reconcileIncomingCatalogs が見つからない');
  assert.ok(/\btry\s*\{/.test(body), 'reconcileIncomingCatalogs が try を持っていない');
  const catchMatch = /catch\s*\(\s*e\s*\)\s*\{([\s\S]*?)\n {2}\}/.exec(body);
  assert.ok(catchMatch, 'reconcileIncomingCatalogs が catch(e) を持っていない');
  assert.ok(
    /project\.setCatalogError\(e\.message\)/.test(catchMatch[1]),
    'reconcileIncomingCatalogs の catch が project.setCatalogError(e.message) を呼んでいない',
  );
});

// ステップ6-1: formatReconcileNoticeの結果がnullでなければproject.setCatalogErrorを1回だけ
// 呼ぶ（2回呼ぶと2本目が潰す既存の規約と同じ）。tryブロック内でsetCatalogErrorの呼び出しが
// 1箇所（notice用の1回）だけであることを固定する。
test('【不変条件・ステップ6-1】store.js: reconcileIncomingCatalogsはtry内でproject.setCatalogErrorを通知用に1回だけ呼ぶ', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function reconcileIncomingCatalogs() {');
  assert.ok(body, 'store.js に reconcileIncomingCatalogs が見つからない');
  const tryMatch = /try\s*\{([\s\S]*?)\n {2}\} catch/.exec(body);
  assert.ok(tryMatch, 'reconcileIncomingCatalogs の try ブロックが見つからない');
  const setCalls = tryMatch[1].match(/project\.setCatalogError\(/g) ?? [];
  assert.equal(setCalls.length, 1, `try内のproject.setCatalogError呼び出しは1回のみの契約（実際: ${setCalls.length}回）`);
  assert.ok(/if\s*\(\s*notice\s*\)\s*project\.setCatalogError\(notice\)/.test(tryMatch[1]), 'notice が null なら setCatalogError を呼ばないガードが無い');
});

// コーディネーターQA指摘2（ステップ6-1）: formatReconcileNoticeへ渡すaddedCount/skippedCountは
// plan.adds.lengthではなくapplyReconcilePlanの実際の結果（result.addedKeys.length/
// result.skipped.length）を使う契約を固定する（R17で弾かれた追加を「追加されました」と
// 誤って報告しないため）。
test('【不変条件・ステップ6-1・QA指摘2】store.js: reconcileIncomingCatalogsはformatReconcileNoticeにresult.addedKeys.length/result.skipped.lengthを渡している', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function reconcileIncomingCatalogs() {');
  assert.ok(body, 'store.js に reconcileIncomingCatalogs が見つからない');
  const noticeCallMatch = /formatReconcileNotice\(plan,\s*\{([\s\S]*?)\}\)/.exec(body);
  assert.ok(noticeCallMatch, 'formatReconcileNotice(plan, {...}) 呼び出しが見つからない（第2引数省略への退行）');
  const args = noticeCallMatch[1];
  assert.ok(
    /addedCount\s*:\s*result\.addedKeys\.length/.test(args),
    'formatReconcileNoticeにaddedCount: result.addedKeys.lengthを渡していない',
  );
  assert.ok(
    /skippedCount\s*:\s*result\.skipped\.length/.test(args),
    'formatReconcileNoticeにskippedCount: result.skipped.lengthを渡していない',
  );
});

// 2026-09-22 QA指摘C: catalogOverlayLoader.js が validateBundle を setOverlayFn（適用）より
// 前に通してから適用していることを固定する（validate削除への退行を検知）。
test('【不変条件・ステップ4】catalog/catalogOverlayLoader.js: validateBundleをsetOverlayFn（適用）より前に通している', () => {
  const src = readSrc('catalog/catalogOverlayLoader.js');
  const validateIdx = src.indexOf('validateBundle(');
  const applyIdx = src.indexOf('setOverlayFn(');
  assert.ok(validateIdx >= 0, 'catalogOverlayLoader.js が validateBundle を呼んでいない（validate削除への退行）');
  assert.ok(applyIdx >= 0, 'catalogOverlayLoader.js が setOverlayFn を呼んでいない');
  assert.ok(
    validateIdx < applyIdx,
    'validateBundle は setOverlayFn（適用）より前に通す契約（decode/validateを全レコードぶん済ませてから適用する）',
  );
});

// 2026-09-22 QA指摘A→再QA指摘Major-D: overlay未読込み（project.catalogOverlayUntrustedが
// 立っている）状態で保存すると既存の同梱レコードを上書きしてしまうため、
// saveCatalogDocument（旧saveMaterialCatalogDocument。ステップ7cで改名）はcatalogOverlayUntrusted
// が立っている間saveDocumentCatalogを呼ばない（早期return）契約を固定する。catalogErrorは
// 「メッセージ内容」の通知専用フィールドであり保存可否の判定には使わない契約（兼用しない）ため、
// ガードにcatalogErrorが使われていないことも合わせて固定する（ガードをcatalogErrorに戻す退行を検知）。
test('【不変条件・ステップ4・Major-D→7c改名・Major-1】store.js: saveCatalogDocumentはproject.catalogOverlayUntrustedが立っている間、saveDocumentCatalogsを呼ばない（catalogErrorはガードに使わない）', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  const guardMatch = /if\s*\(\s*project\.catalogOverlayUntrusted\s*\)/.exec(body);
  assert.ok(guardMatch, 'saveCatalogDocument の先頭に catalogOverlayUntrusted ガード（if (project.catalogOverlayUntrusted)）が無い');
  assert.ok(
    !/if\s*\(\s*project\.catalogError\s*\)/.test(body),
    'saveCatalogDocument が project.catalogError をガードに使っている（catalogErrorは通知専用・保存可否と兼用しない契約への退行）',
  );
  const saveIdx = body.indexOf('saveDocumentCatalogs(');
  assert.ok(saveIdx >= 0, 'saveCatalogDocument が saveDocumentCatalogs を呼んでいない（QA指摘Major-1: 種別ごとのループ保存への退行）');
  assert.ok(guardMatch.index < saveIdx, 'catalogOverlayUntrusted ガードは saveDocumentCatalogs より前になければならない');
});

// 2026-09-22 再QA指摘Major-D: catalogOverlayLoaderのonError（store.jsのラッパー側）が
// catalogOverlayUntrustedとcatalogErrorの両方を立てることを固定する。
test('【不変条件・ステップ4・Major-D】store.js: loadCatalogOverlaysFromIDBのonErrorはcatalogOverlayUntrustedとcatalogErrorの両方を立てる', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'export async function loadCatalogOverlaysFromIDB(');
  assert.ok(body, 'store.js に loadCatalogOverlaysFromIDB が見つからない');
  const onErrorMatch = /onError:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\},?\s*\}\);/.exec(body);
  assert.ok(onErrorMatch, 'loadCatalogOverlaysFromIDB の onError コールバックが見つからない');
  const onErrorBody = onErrorMatch[1];
  assert.ok(
    /project\.setCatalogOverlayUntrusted\(\s*true\s*\)/.test(onErrorBody),
    'onError が project.setCatalogOverlayUntrusted(true) を呼んでいない',
  );
  assert.ok(
    /project\.setCatalogError\(/.test(onErrorBody),
    'onError が project.setCatalogError(...) を呼んでいない',
  );
});

// 2026-09-22 再QA指摘Major-D: App.jsxがproject.catalogError（catalogErrorSeq）をreactionで
// 観測してトースト表示していることを固定する。旧「起動時1回だけのif文チェック」（二重表示の
// 原因になっていた）は削除済みであることも合わせて固定する。
test('【不変条件・ステップ4・Major-D】App.jsx: project.catalogErrorをreactionで観測してトースト表示している（起動時1回のみのif文チェックへの退行を検知）', () => {
  const src = readSrc('App.jsx');
  assert.ok(
    /reaction\(\s*\(\)\s*=>\s*project\.catalogErrorSeq/.test(src),
    'App.jsx が project.catalogErrorSeq を observe する reaction(...) を持っていない',
  );
  assert.ok(
    /if\s*\(project\.catalogError\)\s*setToast\(/.test(src),
    'App.jsx の中に project.catalogError を見てsetToastする処理自体が無い（reaction内のコールバックのはず）',
  );
  // bootReady.then(...) のコールバック本体「だけ」を波括弧の対応で切り出して検査する——
  // 素朴な非貪欲正規表現（[\s\S]*?）だとコールバックの閉じ括弧を越えて後続の reaction
  // コールバックまで拾ってしまい、削除済みの旧チェックが「無い」ことを正しく検出できない。
  const thenBody = extractBalancedBody(src, 'bootReady.then(', { isArrowIife: true });
  assert.ok(thenBody, 'App.jsx に bootReady.then(...) が見つからない');
  assert.ok(
    !/if \(project\.catalogError\) setToast/.test(thenBody),
    'bootReady.then(...) のコールバック内に旧・起動時1回だけのcatalogErrorチェックが残っている（reactionと二重表示になる退行）',
  );
  // reaction の dispose が cleanup に入っていないと StrictMode の mount→unmount→mount で購読が
  // 二重化し、エラーのたびにトーストが2回出る。fireImmediately が無いと effect 購読前に
  // 立ったエラー（bootReady が先に終わった場合）を取りこぼす。
  assert.ok(
    /return \(\) => \{[^}]*disposeCatalogErrorReaction\(\)/.test(src),
    'reaction の dispose が useEffect の cleanup に入っていない（購読リーク・二重登録への退行）',
  );
  assert.ok(
    /fireImmediately:\s*true/.test(src),
    'fireImmediately が外れている（effect マウント前に立ったエラーを取りこぼす）',
  );
});

// 2026-09-22 QA指摘A: unresolvedKeysが非空のとき、既存の同梱レコードから回収
// （recoverUnresolvedEntries）してから保存していることを固定する（黙って落とす退行を検知）。
test('【不変条件・ステップ4・QA指摘A→7c改名】store.js: saveCatalogDocumentはunresolvedKeysをrecoverUnresolvedEntriesで既存レコードから回収してから保存している', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  assert.ok(/\bunresolvedKeys\b/.test(body), 'saveCatalogDocument が buildDocumentBundle の unresolvedKeys を使っていない');
  const recoverIdx = body.indexOf('recoverUnresolvedEntries(');
  const saveIdx = body.indexOf('saveDocumentCatalogs(');
  assert.ok(recoverIdx >= 0, 'saveCatalogDocument が recoverUnresolvedEntries を呼んでいない');
  assert.ok(recoverIdx < saveIdx, 'recoverUnresolvedEntries は saveDocumentCatalogs より前に呼ぶ契約');
});

// QA指摘Minor-2: 回収された interiorMaster/boundaryMaster が参照する材コードは、最初の
// expandTransitiveMaterials の時点ではまだ material 束に無い——reexpandTransitiveMaterials で
// 推移展開をやり直し、不足分を解決して追記していることを固定する（回収分の材が漏れる退行を検知）。
test('【不変条件・ステップ7c・Minor-2】store.js: saveCatalogDocumentはrecoverUnresolvedEntriesの後にreexpandTransitiveMaterialsで回収分の推移展開をやり直している', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  const recoverIdx = body.indexOf('recoverUnresolvedEntries(');
  const reexpandIdx = body.indexOf('reexpandTransitiveMaterials(');
  assert.ok(reexpandIdx >= 0, 'saveCatalogDocument が reexpandTransitiveMaterials を呼んでいない（回収分の推移展開が欠落）');
  assert.ok(recoverIdx < reexpandIdx, 'reexpandTransitiveMaterials は recoverUnresolvedEntries（1回目）より後に呼ぶ契約');
  // 2回目の recoverUnresolvedEntries（再展開後に足りない材を既存束から回収する1回だけの追試行）が
  // reexpandTransitiveMaterials より後にあること。
  const secondRecoverIdx = body.indexOf('recoverUnresolvedEntries(', reexpandIdx);
  assert.ok(secondRecoverIdx >= 0, 'reexpandTransitiveMaterials後にrecoverUnresolvedEntriesの再試行が無い（回収分から生じた未解決材の救済が欠落）');
});

// ステップ6-1・既存バグ修正 → ステップ7a → ステップ7c → QA指摘Minor-4改訂: saveCatalogDocumentの
// buildDocumentBundle 呼び出しに aliases（BUNDLED_KINDSの各種別ぶんcurrentDocumentAliases(kind)を
// 集めたオブジェクト）を渡していないと、保存のたびに文書aliasesが空で上書きされる
// （読み替え表が消える）。空の種別を手元でふるい落とす個別フィルタは持たない
// （splitBundleByKind側の「非空のときだけ添える」判定に一本化する。QA指摘Minor-4=P5）。
test('【不変条件・ステップ7c・Minor-4/P5】store.js: saveCatalogDocumentはBUNDLED_KINDSの各種別ぶんcurrentDocumentAliases(kind)を集めてbuildDocumentBundleへ渡し、空の種別を個別にはふるい落とさない', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  assert.ok(
    /const aliases = Object\.fromEntries\(BUNDLED_KINDS\.map\(kind => \[kind, currentDocumentAliases\(kind\)\]\)\);/.test(body),
    'saveCatalogDocument が BUNDLED_KINDS の各種別ぶん currentDocumentAliases(kind) を集めていない（種別ごとのalias収集への退行）',
  );
  // 空の種別を個別にふるい落とすフィルタ（Object.keys(table).length > 0 のような判定）を
  // このオブジェクト組み立てに再導入していないことを固定する——判定はsplitBundleByKind側に一本化する。
  assert.ok(
    !/Object\.keys\([^)]*\)\.length > 0\)\s*aliases\[/.test(body),
    'aliases 組み立てに空チェックのフィルタが再導入されている（splitBundleByKindへの一本化から後退）',
  );
  const callMatch = /buildDocumentBundle\(\{([\s\S]*?)\}\);/.exec(body);
  assert.ok(callMatch, 'store.js に buildDocumentBundle(...) 呼び出しが見つからない');
  assert.ok(
    /\busedKeysByKind\b.*\bresolvedByKind\b.*\baliases\b/.test(callMatch[1]),
    'buildDocumentBundle の呼び出しに usedKeysByKind/resolvedByKind/aliases が渡されていない',
  );
});

// ステップ7c: 同梱の一般化。BUNDLED_KINDS（material・interiorMaster・boundaryMaster）を
// 定義し、saveCatalogDocumentがそれをbuiltinのloadBuiltin経由の解決・保存の両方で回している
// ことを固定する（material固定への退行・splitBundleByKind未使用への退行を検知）。
test('【不変条件・ステップ7c】store.js: BUNDLED_KINDSはmaterial・interiorMaster・boundaryMasterの3種別で、saveCatalogDocumentがkindDef(kind).loadBuiltin()とsplitBundleByKindを使っている', () => {
  const src = readSrc('store.js');
  assert.ok(
    /const BUNDLED_KINDS = \[CatalogKind\.MATERIAL, CatalogKind\.INTERIOR_MASTER, CatalogKind\.BOUNDARY_MASTER\];/.test(src),
    'store.js に BUNDLED_KINDS = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER] が見つからない',
  );
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  assert.ok(
    /kindDef\(\s*kind\s*\)\.loadBuiltin\(\)/.test(body),
    'saveCatalogDocument が kindDef(kind).loadBuiltin() を呼んでいない（本体マスタを直接importする退行）',
  );
  assert.ok(
    !/import\(\s*['"]\.\/finish\/materials\//.test(body),
    'saveCatalogDocument が本体標準マスタを直接動的importしている（kindDef(kind).loadBuiltin()未経由への退行）',
  );
  assert.ok(/splitBundleByKind\(/.test(body), 'saveCatalogDocument が splitBundleByKind を使っていない（種別ごとの保存への一般化が欠落）');
  const splitIdx = body.indexOf('splitBundleByKind(');
  const saveIdx = body.indexOf('saveDocumentCatalogs(');
  assert.ok(saveIdx >= 0, 'saveCatalogDocument が saveDocumentCatalogs を呼んでいない（QA指摘Major-1）');
  assert.ok(splitIdx < saveIdx, 'splitBundleByKind は saveDocumentCatalogs より前に呼ぶ契約');
});

// ステップ7c: collectCatalogUsageAcrossFloors（旧collectMaterialUsageAcrossFloors）が
// floorRecordsをdecodeし、純ロジック（catalog/usedEntries.js collectUsedKeysByKind。
// BUNDLED_KINDSの3種別ぶんの使用キーを空Setで立ててから埋める）へ委譲していることを固定する
// （QA指摘Major-1: 収集ロジック自体はusedEntries.test.js側の単体テストで検証する）。
test('【不変条件・ステップ7c・Major-1】store.js: collectCatalogUsageAcrossFloorsはdecodeFloorSnapshotしてcollectUsedKeysByKind(snapshots, BUNDLED_KINDS)へ委譲し、saveCatalogDocumentから呼ばれている', () => {
  const src = readSrc('store.js');
  const collectBody = extractBalancedBody(src, 'async function collectCatalogUsageAcrossFloors(floorRecords) {');
  assert.ok(collectBody, 'store.js に collectCatalogUsageAcrossFloors が見つからない');
  assert.ok(/decodeFloorSnapshot\(/.test(collectBody), 'collectCatalogUsageAcrossFloors が decodeFloorSnapshot を呼んでいない');
  assert.ok(
    /collectUsedKeysByKind\(\s*snapshots,\s*BUNDLED_KINDS\s*\)/.test(collectBody),
    'collectCatalogUsageAcrossFloors が collectUsedKeysByKind(snapshots, BUNDLED_KINDS) へ委譲していない（純ロジックの二重実装への退行）',
  );

  const saveBody = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(saveBody, 'store.js に saveCatalogDocument が見つからない');
  assert.ok(
    /collectCatalogUsageAcrossFloors\(/.test(saveBody),
    'saveCatalogDocument が collectCatalogUsageAcrossFloors を呼んでいない',
  );
});

// ステップ7c: 内装マスター・境界マスターが参照する材コードを推移的にmaterial側へ含める経路
// （expandTransitiveMaterialsへ両方の使用済みマスターを渡す）を固定する。片方だけ外す退行を検知。
test('【不変条件・ステップ7c】store.js: saveCatalogDocumentはexpandTransitiveMaterialsにusedInteriorMasters・usedBoundaryMastersの両方を渡している', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  const callMatch = /expandTransitiveMaterials\(([\s\S]*?)\)\)/.exec(body);
  assert.ok(callMatch, 'saveCatalogDocument が expandTransitiveMaterials を呼んでいない');
  const args = callMatch[1];
  assert.ok(/interiorMasters\s*:\s*usedInteriorMasters/.test(args), 'expandTransitiveMaterials に interiorMasters: usedInteriorMasters が渡されていない（内装マスター経路が外れる退行）');
  assert.ok(/boundaryMasters\s*:\s*usedBoundaryMasters/.test(args), 'expandTransitiveMaterials に boundaryMasters: usedBoundaryMasters が渡されていない（境界マスター経路が外れる退行）');
});

// ステップ7c→QA指摘Major-1改訂: 使用0件の種別も空配列で必ず書く（4.3「参照されなくなった
// エントリは次回保存時に外す」の一般化）——splitBundleByKindの結果を無条件に（配列長で
// フィルタせず）全種別ぶん bytesByKind へ写し、単一の saveDocumentCatalogs 呼び出しに渡す
// ことを固定する（0件をスキップする退行・種別ごとにsaveDocumentCatalogをループして部分保存の
// リスクを持ち込む退行の両方を検知）。
test('【不変条件・ステップ7c・Major-1】store.js: saveCatalogDocumentはsplitBundleByKindの結果を無条件にbytesByKindへ写し、単一のsaveDocumentCatalogs呼び出しで保存する（種別ごとの個別saveDocumentCatalogループへの退行を検知）', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveCatalogDocument が見つからない');
  assert.ok(
    /const bytesByKind = new Map\(\s*\[\.\.\.splitBundleByKind\(finalBundle\)\]\.map\(\(\[kind, subBundle\]\) => \[kind, encodeCatalogBundle\(subBundle\)\]\),?\s*\);/.test(body),
    'saveCatalogDocument が splitBundleByKind の結果を無条件に bytesByKind へ写していない（.filter等での0件スキップ、またはbytesByKind自体の欠落）',
  );
  assert.ok(
    !/for\s*\(\s*const \[kind, subBundle\] of splitBundleByKind/.test(body),
    'saveCatalogDocument が splitBundleByKind の結果を種別ごとにループしてsaveDocumentCatalogを呼んでいる（QA指摘Major-1: 部分保存を許すループへの退行。saveDocumentCatalogsへの一本化から後退）',
  );
  const saveCallMatch = /await saveDocumentCatalogs\(savedProjectId, bytesByKind\);/.exec(body);
  assert.ok(saveCallMatch, 'saveCatalogDocument が saveDocumentCatalogs(savedProjectId, bytesByKind) を1回だけ呼んでいない');
  assert.equal(
    (body.match(/saveDocumentCatalogs\(/g) ?? []).length, 1,
    'saveDocumentCatalogs の呼び出しが複数ある（単一トランザクションに一本化する契約に反する）',
  );
});
