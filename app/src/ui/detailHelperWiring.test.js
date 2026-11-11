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
// guardDiscard は dirty のときだけ確認し、dirty は isDocDirty（単一図は isDraftDirty、一式は書き戻し後のエントリの比較）で束縛される。
const guardsOnDirty = (src, guardBody) => !!guardBody
  && /if \(!dirty\)/.test(guardBody) && /const dirty = isDocDirty\(/.test(src);
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
  assert.ok(/planSave\(entry, prevEntry, docContextFor\(KIND, \{ overlayFor, docDiffMap, builtinList: detailBuiltinFigures \}\)\)/.test(handle), '行状態つきの planSave を通していない');
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
  assert.ok(/guardDiscard\(\(\) => replaceDoc\(freshDoc\(\)\)\)/.test(src) && /guardDiscard\(\(\) => replaceDoc\(docOfLibraryEntry\(entry, origin\)\)\)/.test(src));
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

test('【配線】DetailHelperPanel.jsx(S8d): 組込みに戻すは planRevert → applyCatalogEditPlan を runBusy(\'カタログ適用\' の中で呼び、失敗は握って画面に出す', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const rev = extractBalancedBody(src, 'async function performRevert() {');
  assert.ok(rev, 'performRevert が見つからない');
  assert.ok(savesThroughSharedPath(rev), '組込みに戻すが共通経路を runBusy の中で呼んでいない');
  assert.ok(/planRevert\(key,/.test(rev) && /revertFailed/.test(rev));
  assert.ok(!savesThroughSharedPath(rev.replace(/runBusy\('カタログ適用',\s*\(\)\s*=>\s*/, '')), 'runBusy の外でも通ってしまう');
  // 削除は組込み・上書きでは動かない（上書きは戻すに置き換え）
  const del = extractBalancedBody(src, 'async function handleDeleteClick() {');
  assert.ok(/rowActions\?\.canDelete/.test(del));
  // 一覧は組込み層込み
  assert.ok(/helperLibraryRows\(\{\s*userEntries: overlayFor\(KIND\)\.user, builtinList: detailBuiltinFigures,\s*docContext: docContextFor\(/.test(src), '一覧が同梱の文脈（doc-diff の印）を渡していない');
  // 読み取り専用の組込みは edit が弾く
  assert.ok(/if \(d\.readOnly \|\| isPartlessFittingDoc\(d\)\) return d;/.test(extractBalancedBody(src, 'function edit(fn, { track = true } = {}) {')));
});

// 組込みに戻す: クリックも確定も guardDiscard を通り、確認中に別の操作（複製・編集解錠）をしたら確認は消える。
const revertGuarded = (src, clickBody, confirmedBody) => !!clickBody && !!confirmedBody
  && /guardDiscard\(\(\) => setRevertConfirm\(/.test(clickBody) && /guardDiscard\(performRevert\)/.test(confirmedBody)
  && /\bperformRevert\b/.test(src);
const clearsRevertConfirm = body => !!body && /setRevertConfirm\(null\)/.test(body);
// 読み取り専用（組込みの図）で編集の入口が全部塞がっている。
const readOnlyHandlersGuarded = src => {
  const pen = extractBalancedBody(src, 'function handlePen(dir) {');
  const undo = extractBalancedBody(src, 'function handleUndo() {');
  return !!pen && !!undo && /d\.readOnly \|\| isPartlessFittingDoc\(d\) \? d : penStep\(/.test(pen) && /d\.readOnly \? null : undoDraft\(/.test(undo)
    && /const canSave = \(fitting \? result\.ok && blockers\.length === 0 : saveEnabled\(form, result\)\) && !busy && !readOnly;/.test(src)
    && /const inertWhenNoPart = readOnly \|\| partless \|\| undefined;/.test(src)
    && /onEditDim=\{showDxf \|\| fitOn \|\| readOnly \? undefined :/.test(src);
};
// 編集の入口の inert（ペン・手の一覧・基準の 3 つは一式で部品なしのときも塞ぐ inertWhenNoPart、右の呼称・分類は inertWhenReadOnly）。別々に数える。
const inertNoPartCount = src => (src.match(/inert=\{inertWhenNoPart\}/g) ?? []).length;
const inertReadOnlyCount = src => (src.match(/inert=\{inertWhenReadOnly\}/g) ?? []).length;

test('【配線】DetailHelperPanel.jsx(S8d): 組込みに戻すのクリックと確定は guardDiscard を通り、複製・編集解錠で確認は消える', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const click = extractBalancedBody(src, 'function handleRevertClick() {');
  const confirmed = extractBalancedBody(src, 'function handleRevertConfirmed() {');
  assert.ok(revertGuarded(src, click, confirmed), '戻すのクリックか確定が guardDiscard を通っていない');
  assert.ok(clearsRevertConfirm(extractBalancedBody(src, 'function handleDuplicate() {')), '複製で確認が残る');
  assert.ok(clearsRevertConfirm(extractBalancedBody(src, 'function handleEditOverride() {')), '編集解錠で確認が残る');
  assert.ok(clearsRevertConfirm(extractBalancedBody(src, 'function replaceDoc(next) {')), 'replaceDoc で確認が残る');
});

test('【配線】DetailHelperPanel.jsx(S8d): 読み取り専用は handlePen・handleUndo・保存・寸法編集・ペン／手の一覧・右の 2 ブロックで塞がる', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(readOnlyHandlersGuarded(src));
  assert.equal(inertNoPartCount(src), 3, 'inertWhenNoPart の入口数（ペン・手の一覧・基準）');
  assert.equal(inertReadOnlyCount(src), 1, 'inertWhenReadOnly の入口数（右の呼称・分類）');
});

test('【検出力】組込みに戻す・読み取り専用の配線を壊すと判定が落ちる', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  const click = extractBalancedBody(src, 'function handleRevertClick() {');
  const confirmed = extractBalancedBody(src, 'function handleRevertConfirmed() {');
  assert.ok(!revertGuarded(src, click, confirmed.replace('guardDiscard(performRevert)', 'performRevert()')));
  assert.ok(!revertGuarded(src, click.replace('guardDiscard(() => setRevertConfirm(', '(() => setRevertConfirm('), confirmed));
  assert.ok(!clearsRevertConfirm(extractBalancedBody(src, 'function handleDuplicate() {').replace('setRevertConfirm(null)', '')));
  assert.ok(!readOnlyHandlersGuarded(src.replace('d.readOnly || isPartlessFittingDoc(d) ? d : penStep(', 'penStep(')));
  assert.ok(!readOnlyHandlersGuarded(src.replace('d.readOnly ? null : undoDraft(', 'undoDraft(')));
  assert.ok(!readOnlyHandlersGuarded(src.replace('!busy && !readOnly;', '!busy;')));
  assert.ok(!readOnlyHandlersGuarded(src.replace('fitOn || readOnly ?', 'fitOn ?')));
  assert.equal(inertReadOnlyCount(src.replace('inert={inertWhenReadOnly}', '')), 0);
  assert.notEqual(inertNoPartCount(src.replace('inert={inertWhenNoPart}', '')), 3);
  // 入れ替え（ペンの入口を inertWhenReadOnly にする）は別々の数で落ちる
  assert.notEqual(inertNoPartCount(src.replace('inert={inertWhenNoPart}', 'inert={inertWhenReadOnly}')), 3);
  assert.notEqual(inertReadOnlyCount(src.replace('inert={inertWhenNoPart}', 'inert={inertWhenReadOnly}')), 1);
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
  assert.ok(!guardsOnDirty(src.replace('const dirty = isDocDirty(', 'const dirty = Boolean('), guard));
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

// T2-2: ストロークの線の役割 select。選択肢は DETAIL_DASH_LABELS 由来・変更は setDashRole を edit 経由で・読み取り専用は disabled。式の末尾（/>）まで照合する。
const dashRoleSelectWired = src =>
  /const DASH_OPTIONS = labelOptions\(DETAIL_DASH_LABELS\);/.test(src)
  && /<Select value=\{r\.dashRole\} options=\{DASH_OPTIONS\} disabled=\{readOnly\} title=\{DETAIL_HELPER_TEXT\.lineRole\} onChange=\{dashRole => edit\(f => setDashRole\(f, r\.strokeId, dashRole\)\)\} \/>/.test(src);

test('【配線】DetailHelperPanel.jsx(T2-2): ストローク見出しの線の役割 select が setDashRole を edit 経由で呼び、読み取り専用で disabled', () => {
  assert.ok(dashRoleSelectWired(stripComments(readSrc('ui/DetailHelperPanel.jsx'))));
});

test('【検出力】線の役割 select の配線を壊すと判定が落ちる（setDashRole を外す・disabled を外す・edit を介さない・選択肢の供給元）', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(!dashRoleSelectWired(src.replace('setDashRole(f, r.strokeId, dashRole)', 'setClosed(f, r.strokeId, dashRole)')));
  assert.ok(!dashRoleSelectWired(src.replace('disabled={readOnly} title={DETAIL_HELPER_TEXT.lineRole}', 'title={DETAIL_HELPER_TEXT.lineRole}')));
  assert.ok(!dashRoleSelectWired(src.replace('edit(f => setDashRole(f, r.strokeId, dashRole))', 'setDashRole(form, r.strokeId, dashRole)')));
  assert.ok(!dashRoleSelectWired(src.replace('labelOptions(DETAIL_DASH_LABELS)', 'labelOptions(DETAIL_MODE_LABELS)')));
  assert.ok(!dashRoleSelectWired(src.replace('value={r.dashRole}', 'value={r.closed}')));
});

// P2-3: 図の束の 5 select。配置図（canHaveDetailViews）のときだけ出し、候補は placementViewOptions・変更は setPlacementView を edit 経由で・読み取り専用は disabled。式の末尾（/>）まで照合する。
const placementViewsWired = src =>
  /const PLACEMENT_VIEW_OPTIONS = labelOptions\(DETAIL_PLACEMENT_VIEW_LABELS\);/.test(src)
  && /\{canHaveDetailViews\(form\) && \(\s*<div>/.test(src)
  && /import \{ detailFigureCatalog \} from '\.\.\/openings\/openingCatalog\.js';/.test(src)
  && /const viewCatalog = canHaveDetailViews\(form\) \? \[\.\.\.detailFigureCatalog\(\)\.values\(\)\] : null;/.test(src)
  && /\{PLACEMENT_VIEW_OPTIONS\.map\(\(\{ value: view, label \}\) => \(/.test(src)
  && /<Select value=\{form\.views\?\.\[view\] \?\? ''\} options=\{placementViewOptions\(form, viewCatalog, view\)\} disabled=\{readOnly\}\s*onChange=\{key => edit\(f => setPlacementView\(f, view, key\)\)\} \/>/.test(src);

test('【配線】DetailHelperPanel.jsx(P2-3): 図の束の select が canHaveDetailViews で出し分けられ、setPlacementView を edit 経由で呼び、読み取り専用で disabled', () => {
  assert.ok(placementViewsWired(stripComments(readSrc('ui/DetailHelperPanel.jsx'))));
});

test('【検出力】図の束 select の配線を壊すと判定が落ちる（出し分け・disabled・edit を介さない・候補の供給元・setter）', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(!placementViewsWired(src.replace('{canHaveDetailViews(form) && (', '{true && (')));
  assert.ok(!placementViewsWired(src.replace("options={placementViewOptions(form, viewCatalog, view)} disabled={readOnly}", 'options={placementViewOptions(form, viewCatalog, view)}')));
  assert.ok(!placementViewsWired(src.replace('edit(f => setPlacementView(f, view, key))', 'setPlacementView(form, view, key)')));
  assert.ok(!placementViewsWired(src.replace('placementViewOptions(form, viewCatalog, view)', 'PLACEMENT_VIEW_OPTIONS')));
  assert.ok(!placementViewsWired(src.replace('setPlacementView(f, view, key)', 'setClosed(f, view, key)')));
  assert.ok(!placementViewsWired(src.replace('labelOptions(DETAIL_PLACEMENT_VIEW_LABELS)', 'labelOptions(DETAIL_DASH_LABELS)')));
  assert.ok(!placementViewsWired(src.replace('[...detailFigureCatalog().values()]', '[...overlayFor(CatalogKind.DETAIL_FIGURE).user.values()]')));
  assert.ok(!placementViewsWired(src.replace("import { detailFigureCatalog } from '../openings/openingCatalog.js';", "import { detailFigureCatalog } from '../catalog/catalogRegistry.js';")));
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

// P2-3: 図の束の文言（view 名・グループ名）の置き場は error.js だけ。非テストの .js/.jsx に直書きしない（コメントは除く）。
const VIEWS_WORDING = /正面図|背面図|左側面図|右側面図|見上げ図|図の束/;
const wordingOutsideErrorJs = () => fs.readdirSync(appSrc, { recursive: true })
  .map(p => p.replaceAll('\\', '/'))
  .filter(p => /\.jsx?$/.test(p) && !/\.test\.jsx?$/.test(p) && p !== 'error.js')
  .filter(p => VIEWS_WORDING.test(stripComments(readSrc(p))));

test('【不変条件】図の束の文言は error.js にだけ直書きされる（他の非テストソースにない）', () => {
  assert.deepEqual(wordingOutsideErrorJs(), []);
  assert.ok(VIEWS_WORDING.test(stripComments(readSrc('error.js'))), 'error.js に文言が無い（検査が空振り）');
});

test('【検出力】図の束の文言の直書き判定は、コード中の文字列に反応しコメントには反応しない', () => {
  assert.ok(VIEWS_WORDING.test(stripComments("const x = '図の束';")));
  assert.ok(!VIEWS_WORDING.test(stripComments("// 図の束\nconst x = 1;")));
});

// ---- 建具一式モード（C5）の配線 ----
// 部品の一覧は一式のときだけ・view/subject の select は一式のとき隠す・保存は一式を書き戻したエントリ・分類の切替は switchToFitting を通る。
const fittingPanelWired = src => /\{fitting && \(\s*<div className="dthlp-block dthlp-parts">/.test(src)
  && /\{!fitting && \(\s*<>\s*<label className="dthlp-row">\{DETAIL_HELPER_TEXT\.fieldView\}/.test(src)
  && /const entry = fitting \? fittingEntryOf\(doc\) : entryFromForm\(form\);/.test(src)
  && /switchToFitting\(doc, \{ idFactory: newKeyPart \}\)/.test(src)
  && /onChange=\{handleCategory\}/.test(src);
// 試し込みは引き戸の部品の分岐を 1 つ持ち、defaultFitDimsFor・fitDimFieldsFor にも同じ判定がある。comboOptions は FITTING を除外しない。
const fittingFormWired = src => /if \(isSlidePartForm\(form\)\) return tryFitSlidePart\(form, dims\);/.test(src)
  && /if \(isSlidePartForm\(form\)\) \{/.test(src) && /: isSlidePartForm\(form\) \? SLIDE_PART_FIT_DIM_FIELDS/.test(src)
  && !/DetailCategory\.FITTING\)/.test(src);

test('【配線】DetailHelperPanel.jsx: 部品の一覧は一式のときだけ・view/subject の select は一式で隠す・保存は fittingEntryOf・分類切替は switchToFitting', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(fittingPanelWired(src));
  assert.equal((src.match(/dthlp-block dthlp-parts/g) ?? []).length, 1, '部品の一覧は 1 か所だけ');
});

test('【配線】detailHelperForm.js: tryFit・defaultFitDimsFor・fitDimFieldsFor が isSlidePartForm で分岐し、comboOptions が FITTING を除外していない', () => {
  assert.ok(fittingFormWired(stripComments(readSrc('ui/detailHelperForm.js'))));
});

test('【配線】DetailHelperPanel.jsx: 一式のとき DXF／PDF の「下書きへ写す」は disabled で文言を出し、handleDxfCopy も弾く', () => {
  const src = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(/const importCopyNotice = fitting \? DETAIL_HELPER_MESSAGES\.fittingNoImportCopy : null;/.test(src));
  assert.ok(/disabled=\{busy \|\| !canCopy \|\| !!copyNotice\} onClick=\{onCopy\}/.test(src));
  assert.equal((src.match(/copyNotice=\{importCopyNotice\}/g) ?? []).length, 2, 'DXF・PDF の両方へ渡す');
  assert.ok(/function handleDxfCopy\(\) \{\s*if \(fitting\) return;/.test(src));
  assert.equal(readSrc('ui/detailHelperForm.js').includes('建具一式の部品へは写せません'), true);
});

test('【検出力】建具一式の配線を壊すと判定が落ちる', () => {
  const panel = stripComments(readSrc('ui/DetailHelperPanel.jsx'));
  assert.ok(!fittingPanelWired(panel.replace('{fitting && (', '{true && (')));
  assert.ok(!fittingPanelWired(panel.replace('{!fitting && (', '{true && (')));
  assert.ok(!fittingPanelWired(panel.replace('fitting ? fittingEntryOf(doc) : entryFromForm(form)', 'entryFromForm(form)')));
  assert.ok(!fittingPanelWired(panel.replace('switchToFitting(doc,', 'Object.assign(doc,')));
  const form = stripComments(readSrc('ui/detailHelperForm.js'));
  assert.ok(!fittingFormWired(form.replace('if (isSlidePartForm(form)) return tryFitSlidePart(form, dims);', '')));
  assert.ok(!fittingFormWired(form.replace('categoryOptionsFor(CatalogKind.DETAIL_FIGURE)', 'categoryOptionsFor(CatalogKind.DETAIL_FIGURE).filter(c => c.value !== DetailCategory.FITTING)')));
});
