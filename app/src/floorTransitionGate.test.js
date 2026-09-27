// 階/モード切替の関門（floorTransition.js runFloorTransition）の配線に関する不変条件テスト。
// App.jsxはreact-konva等を静的に引くためnode:testから直接importできず、structuralSync.test.jsの
// 「App.jsx: switchHistoryContext…」系と同じ作法（ソーステキストを波括弧の対応数で関数本体を
// 抽出し、行コメントを落としてから正規表現/indexOfで判定する）で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function extractFunctionBody(src, functionStartNeedle) {
  const startIdx = src.indexOf(functionStartNeedle);
  assert.ok(startIdx >= 0, `${functionStartNeedle} が見つからない`);
  const parenCloseIdx = src.indexOf(') {', startIdx);
  const braceStart = src.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  return stripCommentLines(body);
}

function stripCommentLines(src) {
  return src.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
}

// 本体内で最初に現れる`await`が、`await runFloorTransition(`のそれと一致することを確認する
// ——「関門(runFloorTransition)へ最初のawaitより前に同期で入る」（他のawait可能な処理が
// 関門より先に走らない）を保証する。ガード（if(...) return;等の同期文）は本体の先頭に
// あってよい（awaitを含まないため最初のawait位置には影響しない）。
function assertRunFloorTransitionIsFirstAwait(body, label) {
  const rtCallIdx = body.indexOf('runFloorTransition(');
  assert.ok(rtCallIdx >= 0, `${label} の本体に runFloorTransition( の呼び出しが無い`);
  const rtAwaitIdx = body.lastIndexOf('await', rtCallIdx);
  assert.ok(rtAwaitIdx >= 0 && body.slice(rtAwaitIdx, rtCallIdx).trim() === 'await',
    `${label} の runFloorTransition( はawaitされている必要がある`);
  const firstAwaitIdx = body.indexOf('await');
  assert.equal(firstAwaitIdx, rtAwaitIdx,
    `${label} では runFloorTransition( より前に他のawaitが無い必要がある（実際: 最初のawaitは位置${firstAwaitIdx}、runFloorTransitionのawaitは位置${rtAwaitIdx}）`);
}

const appSrcPath = path.resolve(import.meta.dirname, 'App.jsx');

test('【不変条件】App.jsx: handleFloorSwitch はrunFloorTransition(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleFloorSwitch');
  assertRunFloorTransitionIsFirstAwait(body, 'handleFloorSwitch');
});

test('【不変条件】App.jsx: switchFloorKeepingMode はrunFloorTransition(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function switchFloorKeepingMode');
  assertRunFloorTransitionIsFirstAwait(body, 'switchFloorKeepingMode');
});

test('【不変条件】App.jsx: handleModeChange はrunFloorTransition(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleModeChange');
  assertRunFloorTransitionIsFirstAwait(body, 'handleModeChange');
});

test('【不変条件】App.jsx: performUndo はrunFloorTransition(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performUndo');
  assertRunFloorTransitionIsFirstAwait(body, 'performUndo');
});

test('【不変条件】App.jsx: performRedo はrunFloorTransition(を最初のawaitより前で呼ぶ（同期で関門に入る）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performRedo');
  assertRunFloorTransitionIsFirstAwait(body, 'performRedo');
});

test('【不変条件】App.jsx: キーボード入力を捕捉（capture）して関門中は後段へ渡さないガードが登録されている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /window\.addEventListener\('keydown',\s*guard,\s*true\)/,
    'capture指定（第3引数true）のkeydownガード登録が見つからない');

  const idx = code.indexOf("window.addEventListener('keydown', guard, true)");
  const before = code.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /isFloorTransitioning\(\)/, 'guardの中でisFloorTransitioning()を判定していない');
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

// beginUiTransition()はrunFloorTransition(より前（同期）に呼ぶ必要がある——入力中フィールドの
// blur・ESC相当の中断を、関門に入る（isFloorTransitioning()が真になる）前ではなく必ず前に
// 済ませておくため（任意項目・QAコメント2026-09-27）。
function assertBeginUiTransitionBeforeRunFloorTransition(body, label) {
  const beginIdx = body.indexOf('beginUiTransition()');
  assert.ok(beginIdx >= 0, `${label} の本体に beginUiTransition() の呼び出しが無い`);
  const rtIdx = body.indexOf('runFloorTransition(');
  assert.ok(rtIdx >= 0, `${label} の本体に runFloorTransition( の呼び出しが無い`);
  assert.ok(beginIdx < rtIdx, `${label} では beginUiTransition() が runFloorTransition( より前である必要がある`);
}

test('【不変条件・任意】App.jsx: handleFloorSwitch はbeginUiTransition()をrunFloorTransition(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleFloorSwitch');
  assertBeginUiTransitionBeforeRunFloorTransition(body, 'handleFloorSwitch');
});

test('【不変条件・任意】App.jsx: switchFloorKeepingMode はbeginUiTransition()をrunFloorTransition(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function switchFloorKeepingMode');
  assertBeginUiTransitionBeforeRunFloorTransition(body, 'switchFloorKeepingMode');
});

test('【不変条件・任意】App.jsx: handleModeChange はbeginUiTransition()をrunFloorTransition(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleModeChange');
  assertBeginUiTransitionBeforeRunFloorTransition(body, 'handleModeChange');
});

test('【不変条件・任意】App.jsx: performUndo はbeginUiTransition()をrunFloorTransition(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performUndo');
  assertBeginUiTransitionBeforeRunFloorTransition(body, 'performUndo');
});

test('【不変条件・任意】App.jsx: performRedo はbeginUiTransition()をrunFloorTransition(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function performRedo');
  assertBeginUiTransitionBeforeRunFloorTransition(body, 'performRedo');
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
