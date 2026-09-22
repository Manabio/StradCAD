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
// setDocumentCodeTable(null)（codeNormalization.js）・project.setCatalogError(null) を呼ぶ配線。
// 予告どおりソーステキスト検査で固定する（他の不変条件テストと同じ型）。
test('【不変条件・ステップ4】store.js: resetAllの関数本体がclearOverlays・setDocumentCodeTable(null)・project.setCatalogError(null)を呼んでいる', () => {
  const src = readSrc('store.js');
  const m = /export async function resetAll\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'store.js に resetAll 関数が見つからない');
  const body = m[1];
  assert.ok(/\bclearOverlays\(\)/.test(body), 'resetAll が clearOverlays() を呼んでいない');
  assert.ok(/\bsetDocumentCodeTable\(null\)/.test(body), 'resetAll が setDocumentCodeTable(null) を呼んでいない');
  assert.ok(/\bproject\.setCatalogError\(null\)/.test(body), 'resetAll が project.setCatalogError(null) を呼んでいない');
});

test('【不変条件・ステップ4】store.js: saveToIDBはcommitFloorsToDocumentの後に使用材コードを収集・保存している（saveMaterialCatalogDocument呼び出しが後）', () => {
  const src = readSrc('store.js');
  const m = /export async function saveToIDB\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'store.js に saveToIDB 関数が見つからない');
  const body = m[1];
  const commitIdx = body.indexOf('commitFloorsToDocument(');
  const saveCatalogIdx = body.indexOf('saveMaterialCatalogDocument(');
  assert.ok(commitIdx >= 0, 'saveToIDB が commitFloorsToDocument を呼んでいない');
  assert.ok(saveCatalogIdx >= 0, 'saveToIDB が saveMaterialCatalogDocument を呼んでいない');
  assert.ok(saveCatalogIdx > commitIdx, 'saveMaterialCatalogDocument はcommitFloorsToDocumentより後に呼ぶ契約（floors確定後に全階を収集する）');
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
// saveMaterialCatalogDocumentはcatalogOverlayUntrustedが立っている間saveDocumentCatalogを
// 呼ばない（早期return）契約を固定する。catalogErrorは「メッセージ内容」の通知専用フィールド
// であり保存可否の判定には使わない契約（兼用しない）ため、ガードにcatalogErrorが使われて
// いないことも合わせて固定する（ガードをcatalogErrorに戻す退行を検知）。
test('【不変条件・ステップ4・Major-D】store.js: saveMaterialCatalogDocumentはproject.catalogOverlayUntrustedが立っている間、saveDocumentCatalogを呼ばない（catalogErrorはガードに使わない）', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveMaterialCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveMaterialCatalogDocument が見つからない');
  const guardMatch = /if\s*\(\s*project\.catalogOverlayUntrusted\s*\)/.exec(body);
  assert.ok(guardMatch, 'saveMaterialCatalogDocument の先頭に catalogOverlayUntrusted ガード（if (project.catalogOverlayUntrusted)）が無い');
  assert.ok(
    !/if\s*\(\s*project\.catalogError\s*\)/.test(body),
    'saveMaterialCatalogDocument が project.catalogError をガードに使っている（catalogErrorは通知専用・保存可否と兼用しない契約への退行）',
  );
  const saveIdx = body.indexOf('saveDocumentCatalog(');
  assert.ok(saveIdx >= 0, 'saveMaterialCatalogDocument が saveDocumentCatalog を呼んでいない');
  assert.ok(guardMatch.index < saveIdx, 'catalogOverlayUntrusted ガードは saveDocumentCatalog より前になければならない');
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
test('【不変条件・ステップ4・QA指摘A】store.js: saveMaterialCatalogDocumentはunresolvedKeysをrecoverUnresolvedEntriesで既存レコードから回収してから保存している', () => {
  const src = readSrc('store.js');
  const body = extractBalancedBody(src, 'async function saveMaterialCatalogDocument(floorRecords) {');
  assert.ok(body, 'store.js に saveMaterialCatalogDocument が見つからない');
  assert.ok(/\bunresolvedKeys\b/.test(body), 'saveMaterialCatalogDocument が buildDocumentBundle の unresolvedKeys を使っていない');
  const recoverIdx = body.indexOf('recoverUnresolvedEntries(');
  const saveIdx = body.indexOf('saveDocumentCatalog(');
  assert.ok(recoverIdx >= 0, 'saveMaterialCatalogDocument が recoverUnresolvedEntries を呼んでいない');
  assert.ok(recoverIdx < saveIdx, 'recoverUnresolvedEntries は saveDocumentCatalog より前に呼ぶ契約');
});
