// 部分詳細図ヘルパー（ハンバーガー「部分詳細」→ 全画面パネル）の配線を固定する不変条件テスト
// （catalog/catalogMaintenanceWiring.test.js と同型——コメントを除いたソース本体の正規表現検査）。
// 純ロジックは ui/detailHelperForm.test.js、関門の分類は uiBusyClassification.test.js が検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');

// 文字列リテラルは保持し、// と /* */ のコメントだけを取り除く（コメント中の言及で「配線されている」と誤検知しない）。
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// signature は関数本体開始の '{' で終わる完全な文字列。波かっこの深さで本体を切り出す。
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

// ---- 判定（本体文字列 → 真偽。検出力テストにも同じ関数を渡す）----
const hasMenuItem = src => /id:\s*'detail-helper'\s*,\s*label:\s*'部分詳細'/.test(src);
const opensViaRunBusy = body => {
  if (!body) return false;
  const busyAt = body.search(/runBusy\('部分詳細'/);
  const importAt = body.search(/await import\(['"]\.\/ui\/DetailHelperPanel\.jsx['"]\)/);
  return busyAt >= 0 && importAt > busyAt;
};
const savesThroughSharedPath = body => !!body
  && /runBusy\('カタログ適用',\s*\(\)\s*=>\s*applyCatalogEditPlan\(/.test(body)
  && !/\b(upsertUserCatalogEntry|commitUserEntries)\(/.test(body);
const confirmsBeforeClose = (src, guardBody) => !!guardBody
  && /setConfirm\(/.test(guardBody) && /guardDiscard\(onClose\)/.test(src);
// guardDiscard は dirty のときだけ確認し、dirty は isDraftDirty で束縛される。
const guardsOnDirty = (src, guardBody) => !!guardBody
  && /if \(!dirty\)/.test(guardBody) && /const dirty = isDraftDirty\(/.test(src);
// 閉じる経路が 2 つとも guardDiscard を通る（Escape と閉じるボタン。別々に判定する）。
const escapeGuarded = (src, keyBody) => !!keyBody && /guardDiscard\(onClose\)/.test(keyBody);
const closeButtonGuarded = src => /onClick=\{\(\) => guardDiscard\(onClose\)\}>\{DETAIL_HELPER_TEXT\.close\}/.test(src);
// busy 中（保存・削除・使用状況の収集中）は Escape もボタンも閉じない。
const escapeIgnoresBusy = keyBody => !!keyBody && /\|\| busy\) return;/.test(keyBody);
const closeButtonIgnoresBusy = src => /disabled=\{busy\} onClick=\{\(\) => guardDiscard\(onClose\)\}>\{DETAIL_HELPER_TEXT\.close\}/.test(src);
// 削除は使用状況を集める await の前に busy で塞ぎ、確認を出す前に戻す。
const deleteBlocksDuringAwait = body => !!body
  && body.indexOf('setBusy(true)') >= 0 && body.indexOf('setBusy(true)') < body.indexOf('await collectCurrentCatalogUsage()')
  && /finally\s*\{\s*setBusy\(false\);/.test(body);
// 削除は使用状況を集め、その結果を performDelete へ渡す。
const deleteUsesUsage = body => !!body
  && /await collectCurrentCatalogUsage\(\)/.test(body) && /performDelete\(prevEntry\.key,\s*used\)/.test(body);

test('【配線】ui/HamburgerMenu.jsx: 「部分詳細」項目（id: detail-helper）を持つ', () => {
  assert.ok(hasMenuItem(stripComments(readSrc('ui/HamburgerMenu.jsx'))));
});

test('【配線】App.jsx: handleHamburgerSelect が detail-helper で openDetailHelperPanel を呼び、静的 import していない', () => {
  const src = stripComments(readSrc('App.jsx'));
  const m = /function handleHamburgerSelect\(id\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(m, 'handleHamburgerSelect が見つからない');
  assert.ok(/id === 'detail-helper'\) \{\s*return openDetailHelperPanel\(\);/.test(m[1]));
  assert.ok(!/^\s*import\s+\{[^}]*DetailHelperPanel[^}]*\}\s+from/m.test(src), '全画面パネルは動的 import する契約');
});

test('【配線】App.jsx: openDetailHelperPanel は beginUiTransition の後、runBusy(\'部分詳細\' の中で DetailHelperPanel.jsx を動的 import し、失敗はトースト', () => {
  const body = extractBalancedBody(stripComments(readSrc('App.jsx')), 'async function openDetailHelperPanel() {');
  assert.ok(body, 'openDetailHelperPanel が見つからない');
  assert.ok(opensViaRunBusy(body));
  assert.ok(body.indexOf('beginUiTransition()') >= 0 && body.indexOf('beginUiTransition()') < body.indexOf('runBusy('));
  assert.ok(/setToast\(\{\s*msg:\s*ERR_DETAIL_HELPER_LOAD_FAILED/.test(body));
});

test('【配線】DetailHelperPanel.jsx: 保存・削除は共通経路（planSaveEntry／planRemoveUserEntry → applyCatalogEditPlan）を runBusy(\'カタログ適用\' の中で呼ぶ', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const handle = extractBalancedBody(src, 'async function handleSave() {');
  const save = extractBalancedBody(src, 'async function performSave(plan, entry, savedForm, decision) {');
  const del = extractBalancedBody(src, 'async function performDelete(key, usedKeys) {');
  assert.ok(handle && save && del);
  assert.ok(savesThroughSharedPath(save), '保存が共通経路を runBusy の中で呼んでいない');
  assert.ok(savesThroughSharedPath(del), '削除が共通経路を runBusy の中で呼んでいない');
  assert.ok(/planSave\(entry, prevEntry, docContextFor\(KIND, \{ overlayFor, docDiffMap \}\)\)/.test(handle), '行状態つきの planSave を通していない');
  assert.ok(!/planSaveEntry\(/.test(src), 'planSaveEntry を行状態なしで直接呼んでいる');
  assert.ok(/planRemoveUserEntry\(/.test(del));
  assert.ok(!/\b(upsertUserCatalogEntry|commitUserEntries)\b/.test(src), 'ライブラリ書込みの下位関数を直接呼んでいる');
  assert.ok(/saveFn:\s*saveUserCatalog/.test(src));
});

test('【配線】DetailHelperPanel.jsx: 閉じる・新規・ライブラリ選択は未保存なら ConfirmDialog を挟み、グラフ／undo に触れない', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const guard = extractBalancedBody(src, 'function guardDiscard(action) {');
  assert.ok(confirmsBeforeClose(src, guard));
  assert.ok(/<ConfirmDialog\b/.test(src));
  assert.ok(/guardDiscard\(\(\) => replaceDoc\(freshDoc\(\)\)\)/.test(src) && /guardDiscard\(\(\) => replaceDoc\(docFromEntry\(entry\)\)\)/.test(src));
  assert.ok(!/undoManager|planGraph|graphReadScope|floorOps/.test(src), 'グラフ・undo を引いている');
});

test('【配線】DetailHelperPanel.jsx: guardDiscard は dirty のときだけ確認し、Escape と閉じるボタンの両方が通る', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(guardsOnDirty(src, extractBalancedBody(src, 'function guardDiscard(action) {')));
  assert.ok(escapeGuarded(src, extractBalancedBody(src, 'function handleKeyDown(e) {')), 'Escape が guardDiscard を通っていない');
  assert.ok(closeButtonGuarded(src), '閉じるボタンが guardDiscard を通っていない');
  assert.ok(escapeIgnoresBusy(extractBalancedBody(src, 'function handleKeyDown(e) {')), 'Escape が busy 中も効く');
  assert.ok(closeButtonIgnoresBusy(src), '閉じるボタンが busy 中も効く');
});

test('【配線】DetailHelperPanel.jsx: 削除は collectCurrentCatalogUsage の結果を performDelete へ渡す', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const del = extractBalancedBody(src, 'async function handleDeleteClick() {');
  assert.ok(deleteUsesUsage(del));
  assert.ok(deleteBlocksDuringAwait(del), '使用状況を集める await の間が塞がれていない');
});

test('【検出力】dirty の束縛・Escape・閉じるボタン・使用状況の受け渡しを壊すと判定が落ちる', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const guard = extractBalancedBody(src, 'function guardDiscard(action) {');
  assert.ok(!guardsOnDirty(src, guard.replace('if (!dirty)', 'if (false)')));
  assert.ok(!guardsOnDirty(src.replace('const dirty = isDraftDirty(', 'const dirty = Boolean('), guard));
  const key = extractBalancedBody(src, 'function handleKeyDown(e) {');
  assert.ok(!escapeGuarded(src, key.replace('guardDiscard(onClose)', 'onClose()')));
  assert.ok(!closeButtonGuarded(src.replace('onClick={() => guardDiscard(onClose)}>{DETAIL_HELPER_TEXT.close}', 'onClick={onClose}>{DETAIL_HELPER_TEXT.close}')));
  const del = extractBalancedBody(src, 'async function handleDeleteClick() {');
  assert.ok(!escapeIgnoresBusy(key.replace('|| busy', '')));
  assert.ok(!closeButtonIgnoresBusy(src.replace('disabled={busy} onClick={() => guardDiscard(onClose)}', 'onClick={() => guardDiscard(onClose)}')));
  assert.ok(!deleteBlocksDuringAwait(del.replace('setBusy(true);', '')));
  assert.ok(!deleteBlocksDuringAwait(del.replace('finally {\n      setBusy(false);', 'finally {\n      noop();')));
  assert.ok(!deleteUsesUsage(del.replace('await collectCurrentCatalogUsage()', 'new Map()')));
  assert.ok(!deleteUsesUsage(del.replace('performDelete(prevEntry.key, used)', 'performDelete(prevEntry.key, new Set())')));
});

test('【検出力】本体を壊すと判定が落ちる（関門の外で呼ぶ・直接書込み・確認の削除・import の位置）', () => {
  const save = extractBalancedBody(stripComments(readSrc('ui/DetailHelperPanel.jsx')), 'async function performSave(plan, entry, savedForm, decision) {');
  assert.ok(savesThroughSharedPath(save));
  assert.ok(!savesThroughSharedPath(save.replace(/runBusy\('カタログ適用',\s*\(\)\s*=>\s*/, '')), 'runBusy の外で呼んでも通ってしまう');
  assert.ok(!savesThroughSharedPath(`${save} commitUserEntries(KIND, plan.nextUser, []);`), '直接書込みを検出できない');
  const open = extractBalancedBody(stripComments(readSrc('App.jsx')), 'async function openDetailHelperPanel() {');
  assert.ok(!opensViaRunBusy(open.replace("runBusy('部分詳細'", "runBusy('別'")), 'ラベルを変えても通ってしまう');
  assert.ok(!opensViaRunBusy(open.replace(/await import\(/, 'await load(')), '動的 import を外しても通ってしまう');
  const panel = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const guard = extractBalancedBody(panel, 'function guardDiscard(action) {');
  assert.ok(!confirmsBeforeClose(panel, guard.replaceAll('setConfirm(', 'noop(')), '確認を外しても通ってしまう');
  assert.ok(!confirmsBeforeClose(panel.replaceAll('guardDiscard(onClose)', 'onClose()'), guard), '閉じる経路の確認を外しても通ってしまう');
});

test('【検出力】コメントだけに書いた配線は判定を満たさない', () => {
  const commentOnly = [
    "// runBusy('カタログ適用', () => applyCatalogEditPlan(KIND, plan, {}));",
    "/* id: 'detail-helper', label: '部分詳細' */",
    "// await import('./ui/DetailHelperPanel.jsx')",
  ].join('\n');
  const stripped = stripComments(commentOnly);
  assert.ok(!savesThroughSharedPath(stripped));
  assert.ok(!hasMenuItem(stripped));
  assert.ok(!opensViaRunBusy(stripped));
  // 本体が壊れていてコメントにだけ正しい形が残っていても、コメント除去後は通らない
  const broken = "async function handleSave() {\n  // runBusy('カタログ適用', () => applyCatalogEditPlan(KIND, plan, {}));\n  await applyCatalogEditPlan(KIND, plan, {});\n}";
  assert.ok(!savesThroughSharedPath(extractBalancedBody(stripComments(broken), 'async function handleSave() {')));
});
