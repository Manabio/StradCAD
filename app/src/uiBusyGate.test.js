// 階/モード切替の関門（uiBusy.js runBusy）の配線に関する不変条件テスト。
// App.jsxはreact-konva等を静的に引くためnode:testから直接importできず、structuralSync.test.jsの
// 「App.jsx: switchHistoryContext…」系と同じ作法（ソーステキストを波括弧の対応数で関数本体を
// 抽出し、行コメントを落としてから正規表現/indexOfで判定する）で固定する。
// ソース走査の共用ヘルパーはuiBusySourceScan.js（uiBusyClassification.test.jsと共用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  appSrcPath,
  stripCommentLines,
  extractFunctionBody,
  assertRunBusyIsFirstAwait,
  assertBeginUiTransitionBeforeRunBusy,
} from './uiBusySourceScan.js';

test('【不変条件】App.jsx: handleFloorSwitch はrunBusy(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleFloorSwitch');
  assertRunBusyIsFirstAwait(body, 'handleFloorSwitch');
});

test('【不変条件】App.jsx: switchFloorKeepingMode はrunBusy(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function switchFloorKeepingMode');
  assertRunBusyIsFirstAwait(body, 'switchFloorKeepingMode');
});

test('【不変条件】App.jsx: handleModeChange はrunBusy(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleModeChange');
  assertRunBusyIsFirstAwait(body, 'handleModeChange');
});

test('【不変条件】App.jsx: performUndo はrunBusy(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performUndo');
  assertRunBusyIsFirstAwait(body, 'performUndo');
});

test('【不変条件】App.jsx: performRedo はrunBusy(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performRedo');
  assertRunBusyIsFirstAwait(body, 'performRedo');
});

test('【不変条件】App.jsx: キーボード入力を捕捉（capture）して関門中は後段へ渡さないガードが登録されている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /window\.addEventListener\('keydown',\s*guard,\s*true\)/,
    'capture指定（第3引数true）のkeydownガード登録が見つからない');

  const idx = code.indexOf("window.addEventListener('keydown', guard, true)");
  const before = code.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /isUiBusy\(\)/, 'guardの中でisUiBusy()を判定していない');
  assert.match(before, /stopImmediatePropagation\(\)/, 'guardの中でstopImmediatePropagation()を呼んでいない');
  assert.match(before, /preventDefault\(\)/, 'guardの中でpreventDefault()を呼んでいない');
});

test('【不変条件】App.jsx: FloorDrum/AltChipのonSwitch・ModeBarのonSelect・HistoryButtonsのonUndo/onRedoはguardUi()で包まれている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /<HistoryButtons\s+onUndo=\{guardUi\(performUndo\)\}\s+onRedo=\{guardUi\(performRedo\)\}/,
    'HistoryButtonsのonUndo/onRedoがguardUi()で包まれていない');
  assert.match(code, /<ModeBar[\s\S]{0,80}onSelect=\{guardUi\(handleModeChange\)\}/,
    'ModeBarのonSelectがguardUi()で包まれていない');
  assert.match(code, /<FloorDrum[\s\S]{0,400}onSwitch=\{guardUi\(/, 'FloorDrumのonSwitchがguardUi()で包まれていない');
  assert.match(code, /<AltChip[\s\S]{0,400}onSwitch=\{guardUi\(/, 'AltChipのonSwitchがguardUi()で包まれていない');
});

// assertBeginUiTransitionBeforeRunBusy はuiBusySourceScan.jsから共用（beginUiTransition()は
// runBusy(より前（同期）に呼ぶ必要がある——入力中フィールドのblur・ESC相当の中断を、関門に入る
// （isUiBusy()が真になる）前ではなく必ず前に済ませておくため。任意項目・QAコメント2026-09-27）。

test('【不変条件・任意】App.jsx: handleFloorSwitch はbeginUiTransition()をrunBusy(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleFloorSwitch');
  assertBeginUiTransitionBeforeRunBusy(body, 'handleFloorSwitch');
});

test('【不変条件・任意】App.jsx: switchFloorKeepingMode はbeginUiTransition()をrunBusy(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function switchFloorKeepingMode');
  assertBeginUiTransitionBeforeRunBusy(body, 'switchFloorKeepingMode');
});

test('【不変条件・任意】App.jsx: handleModeChange はbeginUiTransition()をrunBusy(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleModeChange');
  assertBeginUiTransitionBeforeRunBusy(body, 'handleModeChange');
});

test('【不変条件・任意】App.jsx: performUndo はbeginUiTransition()をrunBusy(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performUndo');
  assertBeginUiTransitionBeforeRunBusy(body, 'performUndo');
});

test('【不変条件・任意】App.jsx: performRedo はbeginUiTransition()をrunBusy(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performRedo');
  assertBeginUiTransitionBeforeRunBusy(body, 'performRedo');
});

// ================================================================
// F1（2026-09-27）: handleFloorSwitch/switchFloorKeepingModeはもはや失敗を自前で握らないため、
// 階削除・検討案削除のように「切替えてから削除する」内部呼び出しは、切替の成否をtrySwitchFloorで
// 判定し、なお削除対象がアクティブなままなら（blocksFloorRemoval/activePlaneId再判定）削除
// （removeFloor）を中断しなければならない。この順序をソース走査で固定する。
// ================================================================

test('【不変条件・F1】App.jsx: 階削除（delete）はtrySwitchFloor→blocksFloorRemoval再判定→removeFloorの順で、切替失敗時にアクティブ階を削除しない', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);
  const startIdx = code.indexOf("if (action === 'delete') {");
  const endIdx = code.indexOf("if (action === 'delete-alt') {", startIdx);
  assert.ok(startIdx >= 0 && endIdx > startIdx, "action === 'delete' ブロックが見つからない");
  const block = code.slice(startIdx, endIdx);

  const trySwitchIdx = block.indexOf('trySwitchFloor(');
  assert.ok(trySwitchIdx >= 0, 'trySwitchFloor経由でhandleFloorSwitchを呼んでいない');
  const firstBlocksIdx = block.indexOf('blocksFloorRemoval(');
  assert.ok(firstBlocksIdx >= 0, 'blocksFloorRemovalによる事前判定が無い');
  const secondBlocksIdx = block.indexOf('blocksFloorRemoval(', firstBlocksIdx + 1);
  assert.ok(secondBlocksIdx >= 0, '切替後にblocksFloorRemovalを再判定していない（切替失敗を検知できない）');
  const removeIdx = block.indexOf('await removeFloor(planeId)');
  assert.ok(removeIdx >= 0, 'removeFloorの呼び出しが見つからない');
  assert.ok(trySwitchIdx < secondBlocksIdx && secondBlocksIdx < removeIdx,
    'trySwitchFloor→blocksFloorRemoval再判定→removeFloorの順である必要がある');
});

test('【不変条件・F1】App.jsx: 検討案削除（delete-alt）はtrySwitchFloor→activePlaneId再判定→removeFloorの順で、切替失敗時にアクティブ階を削除しない', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);
  const startIdx = code.indexOf("if (action === 'delete-alt') {");
  const endIdx = code.indexOf("if (action === 'promote') {", startIdx);
  assert.ok(startIdx >= 0 && endIdx > startIdx, "action === 'delete-alt' ブロックが見つからない");
  const block = code.slice(startIdx, endIdx);

  const trySwitchIdx = block.indexOf('trySwitchFloor(');
  assert.ok(trySwitchIdx >= 0, 'trySwitchFloor経由でhandleFloorSwitchを呼んでいない');
  const firstActiveIdx = block.indexOf('project.activePlaneId === planeId');
  assert.ok(firstActiveIdx >= 0, 'project.activePlaneId === planeId による事前判定が無い');
  const secondActiveIdx = block.indexOf('project.activePlaneId === planeId', firstActiveIdx + 1);
  assert.ok(secondActiveIdx >= 0, '切替後にproject.activePlaneId === planeIdを再判定していない（切替失敗を検知できない）');
  const removeIdx = block.indexOf('await removeFloor(planeId)');
  assert.ok(removeIdx >= 0, 'removeFloorの呼び出しが見つからない');
  assert.ok(trySwitchIdx < secondActiveIdx && secondActiveIdx < removeIdx,
    'trySwitchFloor→activePlaneId再判定→removeFloorの順である必要がある');
});
