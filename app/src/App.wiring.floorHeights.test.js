// 階設定表 S5: App.jsx・FloorSettingsDialog.jsx の配線テスト（ソース文字列を読む方式）。
// App.jsx は react-konva 等を静的に引き node:test から import できないため、uiBusySourceScan.js の共用ヘルパで
// 関数本体を括弧対応で切り出し、コメント行を除いた上で行頭・行末アンカー付きの1行一致で固定する
// （包含は「ブロックを切り出してその中を見る」。単なる順序比較だけで済ませない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines, extractFunctionBody } from './uiBusySourceScan.js';

const dialogCode = () => stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'ui/FloorSettingsDialog.jsx'), 'utf8'));

// ---- withFloorOpUndo: GL（levels）・屋根専用平面の追従・失敗時の巻き戻し ----

test('【配線】withFloorOpUndo: GL を levelsBefore（run の前）・levelsAfter（run の後）で採り、diffFloorOpSnapshot へ渡す', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function withFloorOpUndo');
  assert.match(body, /^\s*const levelsBefore = collectProjectLevels\(project\);\s*$/m, 'levelsBefore の採取行が見つからない');
  assert.match(body, /^\s*const levelsAfter = collectProjectLevels\(project\);\s*$/m, 'levelsAfter の採取行が見つからない');
  assert.match(body, /^\s*before, after, metasBefore, metasAfter, levelsBefore, levelsAfter,\s*$/m,
    'diffFloorOpSnapshot へ levelsBefore/levelsAfter を渡す行が見つからない');
  const b = body.indexOf('const levelsBefore = collectProjectLevels(project);');
  const run = body.indexOf('await run();');
  const a = body.indexOf('const levelsAfter = collectProjectLevels(project);');
  const diff = body.indexOf('before, after, metasBefore, metasAfter, levelsBefore, levelsAfter,');
  assert.ok(b >= 0 && b < run && run < a && a < diff, 'levelsBefore → run() → levelsAfter → diff の順になっていない');
});

test('【配線】withFloorOpUndo: opts（rollbackOnError・afterApply）を受ける', () => {
  assert.match(readAppSrc(), /^\s*async function withFloorOpUndo\(label, run, \{ rollbackOnError = false, afterApply \} = \{\}\) \{\s*$/m,
    'withFloorOpUndo の署名行が1行まるごとの形で見つからない');
});

test('【配線】undoFloorOp: メタの後に GL を戻し、変わった階を戻した後で屋根専用平面を最上階へ追従させ、最後に afterApply を呼ぶ', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function undoFloorOp');
  const lines = [
    'applyPlaneMetas(project, metasBefore);',
    'applyProjectLevels(project, levelsBefore);',
    'for (const rec of changedSiblings) applyFloorBytes(project, rec.planeId, rec.before);',
    'runInAction(() => followRoofPlaneToTop(project));',
    'afterApply?.();',
  ];
  let prev = -1;
  for (const l of lines) {
    assert.match(body, new RegExp(`^\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'), `${l} が1行まるごとの形で見つからない`);
    const i = body.indexOf(l);
    assert.ok(i > prev, `${l} の位置が順序（メタ → GL → 階のバイト列 → 屋根追従 → afterApply）に反する`);
    prev = i;
  }
});

test('【配線】redoFloorOp: メタの後に GL を進め、階のバイト列の後で屋根専用平面を追従させ、階の切替の後に afterApply を呼ぶ', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function redoFloorOp');
  const lines = [
    'applyPlaneMetas(project, metasAfter);',
    'applyProjectLevels(project, levelsAfter);',
    'for (const rec of changedSiblings) applyFloorBytes(project, rec.planeId, rec.after);',
    'runInAction(() => followRoofPlaneToTop(project));',
    'if (activeAfterId !== project.activePlaneId) await handleFloorSwitch(activeAfterId);',
    'afterApply?.();',
  ];
  let prev = -1;
  for (const l of lines) {
    assert.match(body, new RegExp(`^\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'), `${l} が1行まるごとの形で見つからない`);
    const i = body.indexOf(l);
    assert.ok(i > prev, `${l} の位置が順序に反する`);
    prev = i;
  }
});

test('【配線】withFloorOpUndo: run が例外を投げたら rollbackOnError のとき メタ・GL・屋根平面・変わった階のバイト列を戻して例外を投げ直す', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function withFloorOpUndo');
  // 巻き戻しの実体は floorOps.js rollbackFloorOp（floorHeights.rollback.test.js で実行テスト）。ここでは呼び出しの形を固定する。
  for (const re of [
    /^\s*const rollbackIfRequested = \(\) => \(rollbackOnError\s*$/m,
    /^\s*\? rollbackFloorOp\(project, \{\s*$/m,
    /^\s*before, metasBefore, levelsBefore, collectBytes: collectFloorBytes, afterApply,\s*$/m,
    /^\s*followRoof: \(p\) => runInAction\(\(\) => followRoofPlaneToTop\(p\)\),\s*$/m,
  ]) assert.match(body, re, `withFloorOpUndo に ${re} が見つからない`);

  // run() の失敗と、操作後のバイト列採取の失敗の両方が catch ブロックの中で巻き戻される（throw より前）
  const runIdx = body.indexOf('await run();');
  const collectIdx = body.indexOf('after = await collectFloorBytes();');
  assert.ok(runIdx >= 0 && collectIdx > runIdx, 'run() と after の採取が見つからない');
  for (const [from, label] of [[runIdx, 'run()'], [collectIdx, 'after の採取']]) {
    const catchIdx = body.indexOf('} catch (err) {', from);
    const throwIdx = body.indexOf('throw err;', catchIdx);
    const block = body.slice(catchIdx, throwIdx);
    assert.ok(catchIdx >= 0 && throwIdx > catchIdx, `${label} の catch ブロックが切り出せない`);
    assert.match(block, /^\s*await rollbackIfRequested\(\);\s*$/m, `${label} の catch に await rollbackIfRequested(); が無い`);
  }
  assert.equal((body.match(/^\s*await rollbackIfRequested\(\);\s*$/gm) ?? []).length, 2, 'rollbackIfRequested の呼び出しは2か所');
});

// ---- runFloorHeights ----

test('【配線】runFloorHeights: 再検査 → ダイアログを閉じる → 変更なしは抜ける → beginUiTransition → withFloorOpUndo(HEIGHTS) の順', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function runFloorHeights');
  const steps = [
    /^\s*const edit = computeFloorHeightEdit\(project\.planes, draft, resolveTopStoryHeightMm\(project\), project\.glBelow1FlMm\);\s*$/m,
    /^\s*if \(!edit\.ok\) return;\s*$/m,
    /^\s*setFloorSettingsDlg\(null\);\s*$/m,
    /^\s*if \(edit\.updates\.length === 0 && edit\.glBelow1FlMm === null\) return;\s*$/m,
    /^\s*beginUiTransition\(\);\s*$/m,
    /^\s*await withFloorOpUndo\('階高の変更', async \(\) => \{\s*$/m,
    /^\s*if \(edit\.glBelow1FlMm !== null\) project\.setGlBelow1FlMm\(edit\.glBelow1FlMm\);\s*$/m,
    /^\s*kind: FLOOR_ORDER_KIND\.HEIGHTS,\s*$/m,
    /^\s*updates: edit\.updates,\s*$/m,
    /^\s*skipActiveWalls: appMode === 'finish',.*$/m,
    /^\s*ui: floorOrderUi\(\),\s*$/m,
    /^\s*\}, \{ rollbackOnError: true, afterApply: \(\) => \{ markDirty\(\); rebuildFiguresAfterHeights\(\); \} \}\);\s*$/m,
    /^\s*markDirty\(\);\s*$/m,
    /^\s*rebuildFiguresAfterHeights\(\);\s*$/m,
  ];
  let prev = -1;
  for (const re of steps) {
    const m = re.exec(body);
    assert.ok(m, `runFloorHeights に ${re} が1行まるごとの形で見つからない`);
    assert.ok(m.index > prev, `${re} の位置が順序に反する`);
    prev = m.index;
  }
});

test('【配線】rebuildFiguresAfterHeights: 平面の断面（floorSyncTick）は常に、展開・天伏はモード状態を作り直す（実行時のモードを appModeRef で見る）', () => {
  const body = extractFunctionBody(readAppSrc(), 'function rebuildFiguresAfterHeights');
  assert.match(body, /^\s*setFloorSyncTick\(t => t \+ 1\);\s*$/m, 'setFloorSyncTick の行が見つからない');
  assert.match(body, /^\s*const m = appModeRef\.current;\s*$/m, 'appModeRef.current を読む行が見つからない');
  assert.match(body, /^\s*if \(m === 'elevation' \|\| m === 'ceiling'\) setCatalogReloadKey\(k => k \+ 1\);\s*$/m, '展開・天伏の作り直し行が見つからない');
});

test('【配線】App.jsx: appModeRef は毎レンダーで appMode を映す', () => {
  const code = stripCommentLines(readAppSrc());
  assert.match(code, /^\s*const appModeRef = useRef\(appMode\);\s*$/m);
  assert.match(code, /^\s*appModeRef\.current = appMode;\s*$/m);
});

test('【配線】App.jsx: FloorSettingsDialog の onConfirm は guardUi(runFloorHeights) で包まれ、キャンセルは破棄するだけ', () => {
  const code = stripCommentLines(readAppSrc());
  assert.match(code, /<FloorSettingsDialog[\s\S]{0,400}onConfirm=\{guardUi\(runFloorHeights\)\}/, 'onConfirm={guardUi(runFloorHeights)} が見つからない');
  assert.match(code, /<FloorSettingsDialog[\s\S]{0,500}onCancel=\{\(\) => setFloorSettingsDlg\(null\)\}/, 'onCancel が破棄だけでない');
  assert.match(code, /<FloorSettingsDialog[\s\S]{0,300}selectedPlaneId=\{floorSettingsDlg\.planeId\}/, '長押しした階を選択状態にしていない');
});

// ---- ダイアログ（モーダル・キーの塞ぎ） ----

test('【配線】FloorSettingsDialog: 背景の押下は何もしない（編集中の値を捨てない）', () => {
  assert.match(dialogCode(), /^\s*<div className="cl-dialog-backdrop" onPointerDown=\{e => e\.stopPropagation\(\)\} \/>\s*$/m);
});

test('【配線】FloorSettingsDialog: ダイアログ外のキー入力（Ctrl+Z 等）を capture で止める。Escape はキャンセル', () => {
  const code = dialogCode();
  assert.match(code, /^\s*window\.addEventListener\('keydown', guard, true\);\s*$/m, 'capture の keydown 登録行が見つからない');
  assert.match(code, /^\s*return \(\) => window\.removeEventListener\('keydown', guard, true\);\s*$/m, '登録解除の行が見つからない');
  const start = code.indexOf('const guard = (e) => {');
  const end = code.indexOf("window.addEventListener('keydown', guard, true);");
  const block = code.slice(start, end);
  assert.match(block, /^\s*if \(dialogRef\.current\?\.contains\(e\.target\)\) return;.*$/m, 'ダイアログ内は素通しする行が見つからない');
  assert.match(block, /^\s*e\.stopImmediatePropagation\(\);\s*$/m, 'stopImmediatePropagation が無い');
  assert.match(block, /^\s*e\.preventDefault\(\);\s*$/m, '外側のキーの既定動作（Enter/Space で背景のボタンを押す等）を止める preventDefault が無い');
  assert.match(block, /^\s*if \(e\.key === 'Escape'\) \{ cancelRef\.current\(\); return; \}\s*$/m, 'Escape のキャンセル行が見つからない');
  assert.match(block, /^\s*if \(e\.key === 'Tab'\) moveFocus\(e\.shiftKey\);\s*$/m, 'Tab でダイアログ内へ呼び戻す行が見つからない');
  assert.ok(block.indexOf('dialogRef.current?.contains') < block.indexOf('e.stopImmediatePropagation();'), '素通し判定が stopImmediatePropagation より前にない');
  assert.ok(block.indexOf('e.stopImmediatePropagation();') < block.indexOf('e.preventDefault();'), 'preventDefault が stopImmediatePropagation の後にない');
  assert.ok(block.indexOf('e.preventDefault();') < block.indexOf("if (e.key === 'Escape')"), 'preventDefault が Escape/Tab の分岐より前にない');
});

test('【配線】FloorSettingsDialog: ダイアログ内のキー — IME 変換中は何もしない・Tab は循環・Enter 確定はボタン上では起こさない', () => {
  const code = dialogCode();
  const start = code.indexOf('function handleKeyDown(e) {');
  const end = code.indexOf('return (', start);
  assert.ok(start >= 0 && end > start, 'handleKeyDown が切り出せない');
  const block = code.slice(start, end);
  const lines = [
    /^\s*e\.stopPropagation\(\);\s*$/m,
    /^\s*if \(e\.nativeEvent\.isComposing \|\| e\.keyCode === 229\) return;.*$/m,
    /^\s*if \(e\.key === 'Tab'\) \{ e\.preventDefault\(\); moveFocus\(e\.shiftKey\); return; \}.*$/m,
    /^\s*if \(shouldConfirmOnEnter\(\{ key: e\.key, tagName: e\.target\.tagName \}\)\) handleConfirm\(\);\s*$/m,
    /^\s*if \(e\.key === 'Escape'\) onCancel\(\);\s*$/m,
  ];
  let prev = -1;
  for (const re of lines) {
    const m = re.exec(block);
    assert.ok(m, `handleKeyDown に ${re} が見つからない`);
    assert.ok(m.index > prev, `${re} の位置が順序に反する`);
    prev = m.index;
  }
});

test('【配線】FloorSettingsDialog: 不正値があると OK は押せず、Enter でも確定しない', () => {
  const code = dialogCode();
  assert.match(code, /^\s*if \(!view\.ok\) return;\s*$/m, 'handleConfirm の ok ガード行が見つからない');
  assert.match(code, /^\s*disabled=\{!view\.ok\}\s*$/m, 'OK ボタンの disabled 行が見つからない');
  assert.match(code, /^\s*style=\{r\.invalid \? INVALID_STYLE : undefined\}\s*$/m, '不正な階高の赤表示行が見つからない');
  assert.match(code, /^\s*style=\{view\.gl\.invalid \? INVALID_STYLE : undefined\}\s*$/m, '不正な GL の赤表示行が見つからない');
});
