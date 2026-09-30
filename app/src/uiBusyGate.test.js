// 階/モード切替の関門（uiBusy.js runBusy）の配線に関する不変条件テスト。
// App.jsxはreact-konva等を静的に引くためnode:testから直接importできず、structuralSync.test.jsの
// 「App.jsx: switchHistoryContext…」系と同じ作法（ソーステキストを波括弧の対応数で関数本体を
// 抽出し、行コメントを落としてから正規表現/indexOfで判定する）で固定する。
// ソース走査の共用ヘルパーはuiBusySourceScan.js（uiBusyClassification.test.jsと共用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

// ================================================================
// 入力規制ステップ3: CL操作の入口（削除・入替え・偏芯確定・出幅編集確定）を関門へ移すのに伴い、
// 遮断点C（メニュー・ダイアログのonSelect/onConfirm）もguardUi()で包む。
// ================================================================

test('【不変条件・入力規制ステップ3】App.jsx: RadialMenuのonSelect・CL偏芯ダイアログ/出幅編集のonConfirmはguardUi()で包まれている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /<RadialMenu[\s\S]{0,200}onSelect=\{guardUi\(handleMenuSelect\)\}/,
    'RadialMenuのonSelectがguardUi()で包まれていない');
  assert.match(code, /<EccentricityDialog[\s\S]{0,200}onConfirm=\{guardUi\(handleEccConfirm\)\}/,
    'EccentricityDialogのonConfirmがguardUi()で包まれていない');
  assert.match(code, /<AxisFaceInput[\s\S]{0,300}onConfirm=\{guardUi\(/,
    'AxisFaceInputのonConfirmがguardUi()で包まれていない');
});

// structuralSync.whenIdle()を待つ入口（handleDeleteCenterLine・handleConvertCenterLine・
// handleEccConfirm・ステップ5で加わったhandleSaveConfirm）はいずれも関門の中でwhenIdleを待つ
// 必要がある（.claude/undo-redo.md「落とし穴」参照）——本体のテキスト上でrunBusy(より後
// （＝runBusyのコールバックの中）にwhenIdleが現れることを固定する（関門の外にwhenIdleが
// 漏れ出す変異を検知）。
test('【不変条件・入力規制ステップ3/5】App.jsx: whenIdle()を使う入口はいずれもGATED（関門の中で待つ）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');

  const GATED_WITH_WHEN_IDLE = ['handleDeleteCenterLine', 'handleConvertCenterLine', 'handleEccConfirm', 'handleSaveConfirm', 'withFloorAddUndo'];
  for (const name of GATED_WITH_WHEN_IDLE) {
    const body = extractFunctionBody(appSrc, `async function ${name}`);
    const idleIdx = body.indexOf('structuralSync.whenIdle()');
    assert.ok(idleIdx >= 0, `${name} の本体に structuralSync.whenIdle() が無い`);
    const runBusyIdx = body.indexOf('runBusy(');
    assert.ok(runBusyIdx >= 0 && runBusyIdx < idleIdx,
      `${name} では structuralSync.whenIdle() が runBusy( より後（関門の中）で呼ばれる必要がある`);
  }
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

test('【不変条件・F1】App.jsx: runDeleteFloor（階削除の本体）はtrySwitchFloor→blocksFloorRemoval再判定→removeFloorの順で、切替失敗時にアクティブ階を削除しない', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function runDeleteFloor');

  const trySwitchIdx = body.indexOf('trySwitchFloor(');
  assert.ok(trySwitchIdx >= 0, 'trySwitchFloor経由でhandleFloorSwitchを呼んでいない');
  const firstBlocksIdx = body.indexOf('blocksFloorRemoval(');
  assert.ok(firstBlocksIdx >= 0, 'blocksFloorRemovalによる事前判定が無い');
  const secondBlocksIdx = body.indexOf('blocksFloorRemoval(', firstBlocksIdx + 1);
  assert.ok(secondBlocksIdx >= 0, '切替後にblocksFloorRemovalを再判定していない（切替失敗を検知できない）');
  const removeIdx = body.indexOf('await removeFloor(planeId)');
  assert.ok(removeIdx >= 0, 'removeFloorの呼び出しが見つからない');
  assert.ok(trySwitchIdx < secondBlocksIdx && secondBlocksIdx < removeIdx,
    'trySwitchFloor→blocksFloorRemoval再判定→removeFloorの順である必要がある');
});

// 削除可否の判定の後・removeFloorの前にreadFloorEquipmentIdsで消す階の器具行idを読み、
// removeFloorの後は既存の後始末（直下階の階段削除・右側の採用階の階番号振り直し）をすべて終えてから
// renumberEquipmentAfterFloorRemovalで番号を詰め直す——再採番が失敗しても階削除自体の後始末は
// 完了済みにするため。
test('【不変条件】App.jsx: runDeleteFloor は 削除可否の判定 < readFloorEquipmentIds < removeFloor < 既存の後始末（階段削除・階番号振り直し） < renumberEquipmentAfterFloorRemoval の順で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function runDeleteFloor');

  assert.match(body, /^\s*const removedEquipmentIds = await readFloorEquipmentIds\(project, project\.planeMap\.get\(planeId\)\);\s*$/m,
    'readFloorEquipmentIdsの呼び出し行が1行まるごとの形で見つからない');
  assert.match(body, /^\s*const renumbered = await renumberEquipmentAfterFloorRemoval\(\{ project, activeGraph: project\.activeGraph, removedIds: removedEquipmentIds \}\);\s*$/m,
    'renumberEquipmentAfterFloorRemovalの呼び出し行が1行まるごとの形で見つからない');
  assert.match(body, /^\s*if \(renumbered\.status === 'renumbered'\) setFloorSyncTick\(t => t \+ 1\);\s*$/m,
    'renumbered.status===\'renumbered\'のときだけsetFloorSyncTickする行が1行まるごとの形で見つからない');

  const secondBlocksIdx = body.indexOf('blocksFloorRemoval(', body.indexOf('blocksFloorRemoval(') + 1);
  const readIdx = body.indexOf('const removedEquipmentIds = await readFloorEquipmentIds(project, project.planeMap.get(planeId));');
  const removeIdx = body.indexOf('await removeFloor(planeId)');
  const stairsIdx = body.indexOf('await removeStairsOnFloor(below);');
  const renameLoopIdx = body.indexOf('const newAdopted = project.planes;');
  const renumberIdx = body.indexOf('const renumbered = await renumberEquipmentAfterFloorRemoval({ project, activeGraph: project.activeGraph, removedIds: removedEquipmentIds });');
  assert.ok(secondBlocksIdx >= 0 && readIdx >= 0 && removeIdx >= 0 && stairsIdx >= 0 && renameLoopIdx >= 0 && renumberIdx >= 0
    && secondBlocksIdx < readIdx && readIdx < removeIdx && removeIdx < stairsIdx && stairsIdx < renameLoopIdx && renameLoopIdx < renumberIdx,
    '削除可否の判定 < readFloorEquipmentIds < removeFloor < 既存の後始末（階段削除・階番号振り直し） < renumberEquipmentAfterFloorRemoval の順になっていない');
});

// ================================================================
// 入力規制ステップ5: 保存（G4）・読込み（G5）・カタログ保守を開く（G8）の入口を関門へ移すのに伴い、
// SaveFileDialogのonConfirm・HamburgerMenuのonSelectはguardUi()で包む。ファイル選択inputの
// onChangeはguardUiでは包まない——busy中に丸ごと落とすと直前のe.target.value=''も走らず、
// 同じファイルの再選択でonChangeが発火しなくなる（QA指摘・再報告）ため、handleFileOpen自身の
// 冒頭でisUiBusy()を見る（valueのリセットの後）。
// ================================================================

test('【不変条件・入力規制ステップ5】App.jsx: SaveFileDialogのonConfirm・HamburgerMenuのonSelectはguardUi()で包まれている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /<SaveFileDialog[\s\S]{0,200}onConfirm=\{guardUi\(handleSaveConfirm\)\}/,
    'SaveFileDialogのonConfirmがguardUi()で包まれていない');
  assert.match(code, /<HamburgerMenu\s+onSelect=\{guardUi\(handleHamburgerSelect\)\}/,
    'HamburgerMenuのonSelectがguardUi()で包まれていない');
});

test('【不変条件・入力規制ステップ5・QA指摘再報告】App.jsx: ファイル選択inputのonChangeはguardUiではなくhandleFileOpen内のisUiBusy()ガードで守られている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /type="file"[\s\S]{0,150}onChange=\{handleFileOpen\}/,
    'ファイル選択inputのonChangeがhandleFileOpenそのものでない（guardUiで包むと再選択が効かなくなる退行）');

  const body = extractFunctionBody(appSrc, 'function handleFileOpen(e)');
  assert.ok(body.includes('isUiBusy()'), 'handleFileOpenの本体にisUiBusy()ガードが無い');
});

// ================================================================
// 入力規制ステップ6: 階操作（階追加・複製・検討案コピー・削除・検討案削除）の入口を関門へ移すのに伴い、
// AltChipのonTapAdd/onManage・AddFloorDialogのonConfirm・[+]ボタンのonClick（executeAddUpperの
// 直接呼び出し経路）をguardUi()で包む。
// ================================================================

test('【不変条件・入力規制ステップ6】App.jsx: AltChipのonTapAdd/onManage・AddFloorDialogのonConfirmはguardUi()で包まれている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /<AltChip[\s\S]{0,400}onTapAdd=\{guardUi\(/, 'AltChipのonTapAddがguardUi()で包まれていない');
  assert.match(code, /<AltChip[\s\S]{0,400}onManage=\{guardUi\(/, 'AltChipのonManageがguardUi()で包まれていない');
  assert.match(code, /<AddFloorDialog[\s\S]{0,200}onConfirm=\{guardUi\(handleAddFloorConfirm\)\}/,
    'AddFloorDialogのonConfirmがguardUi()で包まれていない');
});

test('【不変条件・入力規制ステップ6】App.jsx: [+]ボタンのonClick（executeAddUpperの直接呼び出し経路）はguardUi()で包まれている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /onClick=\{canAddFloor \? guardUi\(handleAddFloor\) : undefined\}/,
    '[+]ボタンのonClickがguardUi()で包まれていない');
});

// handleFloorMenuAction自体は非asyncのままgraph/IDBを直接書かず、GATEDなrunXxxへ委譲することを固定する
// （変異: delete分岐へremoveFloor(を直接書き戻す→このテストのみ赤）。
test('【不変条件・入力規制ステップ6】App.jsx: handleFloorMenuAction の各分岐はrunXxx（GATED）へ委譲し、自らgraph/IDBを書かない', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  assert.ok(!appSrc.includes('async function handleFloorMenuAction'),
    'handleFloorMenuActionはasync functionであってはいけない（関門はrunXxx側で開く）');
  const body = extractFunctionBody(appSrc, 'function handleFloorMenuAction');

  assert.ok(body.includes('await runDeleteFloor(planeId)'), 'delete分岐がrunDeleteFloorへ委譲していない');
  assert.ok(body.includes('await runDeleteAlternative(planeId, plane)'), 'delete-alt分岐がrunDeleteAlternativeへ委譲していない');
  assert.ok(body.includes('await runAddAlternative('), 'add-alt分岐がrunAddAlternativeへ委譲していない');
  assert.ok(body.includes('return runCopyAlternative('), 'copy-alt分岐がrunCopyAlternativeへ委譲していない');
  assert.ok(!body.includes('removeFloor('), 'handleFloorMenuActionの本体が直接removeFloorを呼んではいけない（runXxxへ委譲する）');
  assert.ok(!body.includes('restoreGraph('), 'handleFloorMenuActionの本体が直接restoreGraphを呼んではいけない（runXxxへ委譲する）');
});

test('【不変条件・F1】App.jsx: runDeleteAlternative（検討案削除の本体）はtrySwitchFloor→activePlaneId再判定→removeFloorの順で、切替失敗時にアクティブ階を削除しない', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function runDeleteAlternative');

  const trySwitchIdx = body.indexOf('trySwitchFloor(');
  assert.ok(trySwitchIdx >= 0, 'trySwitchFloor経由でhandleFloorSwitchを呼んでいない');
  const firstActiveIdx = body.indexOf('project.activePlaneId === planeId');
  assert.ok(firstActiveIdx >= 0, 'project.activePlaneId === planeId による事前判定が無い');
  const secondActiveIdx = body.indexOf('project.activePlaneId === planeId', firstActiveIdx + 1);
  assert.ok(secondActiveIdx >= 0, '切替後にproject.activePlaneId === planeIdを再判定していない（切替失敗を検知できない）');
  const removeIdx = body.indexOf('await removeFloor(planeId)');
  assert.ok(removeIdx >= 0, 'removeFloorの呼び出しが見つからない');
  assert.ok(trySwitchIdx < secondActiveIdx && secondActiveIdx < removeIdx,
    'trySwitchFloor→activePlaneId再判定→removeFloorの順である必要がある');
});

// ================================================================
// P1（2026-09-28）: FloorSwapManager.swapは同じrunInAction内で切替前階（graph）にclearFloorData()を
// 済ませるため、切替後にserializeGraph(graph)すると階固有データが空の内容をコピーしてしまう。
// runAddAlternative・runCopyAlternativeとも、コピー元の直列化はtrySwitchFloor（＝階切替）より前で
// 行う必要がある。
// ================================================================

test('【不変条件・P1】App.jsx: runAddAlternative と runCopyAlternative はserializeGraph(graph)をtrySwitchFloor(より前で呼ぶ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');

  const addBody = extractFunctionBody(appSrc, 'async function runAddAlternative');
  const addSerializeIdx = addBody.indexOf('serializeGraph(graph)');
  assert.ok(addSerializeIdx >= 0, 'runAddAlternativeの本体にserializeGraph(graph)が無い');
  const addTrySwitchIdx = addBody.indexOf('trySwitchFloor(');
  assert.ok(addTrySwitchIdx >= 0, 'runAddAlternativeの本体にtrySwitchFloor(が無い');
  assert.ok(addSerializeIdx < addTrySwitchIdx,
    'runAddAlternativeではserializeGraph(graph)がtrySwitchFloor(より前である必要がある（切替後は旧graphがclearFloorData済み）');

  const copyBody = extractFunctionBody(appSrc, 'async function runCopyAlternative');
  const copySerializeIdx = copyBody.indexOf('serializeGraph(graph)');
  assert.ok(copySerializeIdx >= 0, 'runCopyAlternativeの本体にserializeGraph(graph)が無い');
  const copyTrySwitchIdx = copyBody.indexOf('trySwitchFloor(');
  assert.ok(copyTrySwitchIdx >= 0, 'runCopyAlternativeの本体にtrySwitchFloor(が無い');
  assert.ok(copySerializeIdx < copyTrySwitchIdx,
    'runCopyAlternativeではserializeGraph(graph)がtrySwitchFloor(より前である必要がある（切替後は旧graphがclearFloorData済み）');
});

// ================================================================
// 入力規制ステップ7（仕上げ）: historyNavRefは連打・多重実行の防止としてguardUiとcapture keydown
// （関門）に対して冗長なため撤去する。多重実行はその2つが入口で落とす。
// ================================================================

test('【不変条件・入力規制ステップ7】App.jsx: historyNavRefが無い（多重実行防止はguardUiとcapture keydownに一本化）', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  assert.ok(!appSrc.includes('historyNavRef'), 'App.jsxにhistoryNavRefが残っている');
});

test('【不変条件・入力規制ステップ7】App.jsx: Ctrl+Z/Yのkeydownハンドラ（onKey）はcapture無しで登録され、captureガードの登録は1つだけ', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  const captureMatches = code.match(/window\.addEventListener\('keydown',\s*\w+,\s*true\)/g) || [];
  assert.equal(captureMatches.length, 1,
    'captureガード（第3引数true）のkeydown登録は関門用の1つだけである必要がある');
  assert.match(code, /window\.addEventListener\('keydown',\s*onKey\)/,
    'Ctrl+Z/Yのkeydownハンドラ（onKey）がcapture無しで登録されていない');
});

// ================================================================
// 入力規制ステップ7（仕上げ）: 全画面オーバーレイをApp.jsxのインラインdivからui/BusyOverlay.jsxへ
// 切り出す。App.jsx側は<BusyOverlay />を描画するだけで、zIndex: 5000のインラインdivは残さない。
// ================================================================

test('【不変条件・入力規制ステップ7】App.jsx: <BusyOverlay />を描画し、zIndex: 5000のインラインdivを持たない', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /<BusyOverlay\s*\/>/, 'App.jsxが<BusyOverlay />を描画していない');
  assert.ok(!code.includes("zIndex: 5000"),
    'App.jsxにzIndex: 5000のインラインdivが残っている（BusyOverlay.jsxへ移す必要がある）');
});

test('【不変条件・入力規制ステップ7】ui/BusyOverlay.jsx: observer()で包まれ、isUiBusy()・uiBusyLabel()・LABEL_DELAY_MS・WARN_AFTER_MSを参照する', () => {
  const busyOverlayPath = path.resolve(import.meta.dirname, 'ui', 'BusyOverlay.jsx');
  const src = fs.readFileSync(busyOverlayPath, 'utf8');
  const code = stripCommentLines(src);

  assert.match(code, /export const BusyOverlay = observer\(/, 'BusyOverlayがobserver()で包まれていない');
  assert.match(code, /isUiBusy\(\)/, 'isUiBusy()を参照していない');
  assert.match(code, /uiBusyLabel\(\)/, 'uiBusyLabel()を参照していない');
  assert.match(code, /LABEL_DELAY_MS/, 'LABEL_DELAY_MSを参照していない');
  assert.match(code, /WARN_AFTER_MS/, 'WARN_AFTER_MSを参照していない');
});

// QA指摘F2（2026-09-28）: busy中のみ全画面を塞ぎ（busy外はnullで何も塞がない）、オーバーレイの
// zIndexは既存のMemberLayoutStudy(4000)より上、遅延ラベルはpointerEvents:'none'でクリックを
// 素通しすることを固定する（変異: `if (!busy) return null;`の行を消す→このテストのみ赤）。
test('【不変条件・QA指摘F2】ui/BusyOverlay.jsx: busy外はnullを返し、zIndex: 5000・pointerEvents: \'none\'を持つ', () => {
  const busyOverlayPath = path.resolve(import.meta.dirname, 'ui', 'BusyOverlay.jsx');
  const src = fs.readFileSync(busyOverlayPath, 'utf8');
  const code = stripCommentLines(src);

  assert.match(code, /if\s*\(!busy\)\s*return null;/, 'busy外でnullを返すガードが無い');
  assert.match(code, /zIndex:\s*5000/, 'zIndex: 5000のオーバーレイが無い');
  assert.match(code, /pointerEvents:\s*'none'/, "pointerEvents: 'none'の遅延ラベルが無い");
});

// QA指摘F4（2026-09-28）: usePointerInteractionへ渡すonUndo/onRedo（2本指/3本指タップ経由の
// undo/redo）もHistoryButtonsと同じguardUiで包む——historyNavRef撤去後の再入防止をguardUiに
// 一本化する（漏らすとタップ経由だけbusy中の連打を弾けない）。
test('【不変条件・QA指摘F4】App.jsx: usePointerInteractionのonUndo/onRedoはguardUi()で包まれている', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const code = stripCommentLines(appSrc);

  assert.match(code, /onUndo:\s*guardUi\(performUndo\)/, 'usePointerInteractionのonUndoがguardUi()で包まれていない');
  assert.match(code, /onRedo:\s*guardUi\(performRedo\)/, 'usePointerInteractionのonRedoがguardUi()で包まれていない');
});

// ================================================================
// 手動追加材サイレント撤去回避 指示書§5ステップ3: handleDeleteCenterLineが固定材の事前確認を
// 挟む2段runBusy構成になったことを固定する。
//   1段目のrunBusy: collectFixedMembersByFloor(で固定材を列挙 → 空ならrunDeleteCenterLine(まで
//                    完了する（従来どおり1回の関門内で終わる）。
//   関門の外:        固定材が見つかったときだけconfirmFixedMemberDeletion(で確認する
//                    （確認の表示中は関門を開けておく必要があるため。§5ステップ3）。
//   中止分岐:        if (!ok) return; は2段目のrunBusy(より前で中断する。
//   2段目のrunBusy: 了承後だけrunDeleteCenterLine(を呼ぶ。
// 変異での検出力確認（手動）: (a) collectFixedMembersByFloorの呼び出し行を1段目runBusyの外へ
// 出す→本テスト赤、(b) confirmFixedMemberDeletionの呼び出しを1段目runBusyの中へ入れる→
// 本テスト赤（関門内で入力待ちすることになるため禁止したい構成）、(c) `if (!ok) return;`を
// 削る→本テスト赤。
// ================================================================
test('【不変条件・手動追加材サイレント撤去回避ステップ3】App.jsx: handleDeleteCenterLineはcollectFixedMembersByFloor→（関門の外で）confirmFixedMemberDeletion→if(!ok)return→2段目のrunBusyの順で固定材の確認を挟む', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleDeleteCenterLine');

  const runBusy1Idx    = body.indexOf('runBusy(');
  assert.ok(runBusy1Idx >= 0, 'handleDeleteCenterLineの本体にrunBusy(の呼び出しが無い');
  const collectIdx     = body.indexOf('collectFixedMembersByFloor(');
  assert.ok(collectIdx >= 0, 'collectFixedMembersByFloor(の呼び出しが無い');
  const ifByFloorIdx   = body.indexOf('if (!byFloor) return;');
  assert.ok(ifByFloorIdx >= 0, '固定材が無いときにそのまま抜ける if (!byFloor) return; が無い');
  const confirmIdx     = body.indexOf('confirmFixedMemberDeletion(');
  assert.ok(confirmIdx >= 0, 'confirmFixedMemberDeletion(の呼び出しが無い');
  const ifNotOkIdx     = body.indexOf('if (!ok) return;');
  assert.ok(ifNotOkIdx >= 0, '中止分岐 if (!ok) return; が無い');
  const runBusy2Idx    = body.indexOf('runBusy(', runBusy1Idx + 1);
  assert.ok(runBusy2Idx >= 0, '2段目のrunBusy(の呼び出しが無い（確認了承後の削除本体）');

  assert.ok(
    runBusy1Idx < collectIdx && collectIdx < ifByFloorIdx && ifByFloorIdx < confirmIdx
      && confirmIdx < ifNotOkIdx && ifNotOkIdx < runBusy2Idx,
    'collectFixedMembersByFloor(→if(!byFloor)return;→confirmFixedMemberDeletion(→if(!ok)return;→2段目のrunBusy(の順になっていない'
    + `（実際の位置: runBusy1=${runBusy1Idx}, collect=${collectIdx}, ifByFloor=${ifByFloorIdx}, confirm=${confirmIdx}, ifNotOk=${ifNotOkIdx}, runBusy2=${runBusy2Idx}）`,
  );
});

// ================================================================
// QAブロッカー是正（手動追加材サイレント撤去回避 指示書§5ステップ3）: 固定材の確認ダイアログ表示中は
// 関門（runBusy）を開けておくため、その間にCtrl+Z/Y（undo/redo）や階切替が割り込みうる——2段目の
// runBusy内で、whenIdle()の後・runDeleteCenterLine(呼び出しの前にisCenterLineStillDeletable(で
// 再検証していることを固定する。再検証をしない・順序を誤ると、graph（ハンドラのクロージャに閉じ込めた
// 描画時点のactiveGraph）が既に差し替わっている、またはclが所有グラフのshapeMapから消えている状態で
// runDeleteCenterLineを呼びうる。
// 変異での検出力確認（手動）: (a) isCenterLineStillDeletable(の呼び出し行そのものを削る→本テスト赤、
// (b) `if (false)`化して素通りさせる（呼び出し自体は残すが判定を無効化する）→本テスト赤
// （呼び出し行の1行まるごと一致を崩すため）。
// ================================================================
test('【不変条件・QAブロッカー是正】App.jsx: handleDeleteCenterLineの2段目runBusyはwhenIdle()の後・runDeleteCenterLine(の前にisCenterLineStillDeletableで再検証する', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleDeleteCenterLine');

  const runBusy1Idx = body.indexOf('runBusy(');
  const runBusy2Idx = body.indexOf('runBusy(', runBusy1Idx + 1);
  assert.ok(runBusy2Idx >= 0, '2段目のrunBusy(の呼び出しが無い');
  const body2 = body.slice(runBusy2Idx); // 2段目のrunBusy(以降だけを見る（1段目に同名呼び出しが紛れ込んでも誤検出しない）

  const idleIdx = body2.indexOf('structuralSync.whenIdle()');
  assert.ok(idleIdx >= 0, '2段目のrunBusy内にstructuralSync.whenIdle()が無い');

  assert.match(body2, /^\s*if \(!isCenterLineStillDeletable\(project, graph, cl\)\) \{$/m,
    'isCenterLineStillDeletable(project, graph, cl)の再検証呼び出し行が1行まるごとの形で見つからない');
  const checkIdx = body2.indexOf('if (!isCenterLineStillDeletable(project, graph, cl)) {');

  const deleteIdx = body2.indexOf('await runDeleteCenterLine(cl);');
  assert.ok(deleteIdx >= 0, '2段目のrunBusy内にawait runDeleteCenterLine(cl);が無い');

  assert.ok(idleIdx < checkIdx && checkIdx < deleteIdx,
    `whenIdle() < isCenterLineStillDeletable( < runDeleteCenterLine(の順になっていない（実際の位置: idle=${idleIdx}, check=${checkIdx}, delete=${deleteIdx}）`);
});

// ================================================================
// 手動追加材サイレント撤去回避 指示書§5ステップ4: handleConvertCenterLine（降格側）にも
// handleDeleteCenterLineと同じ2段runBusy構成の固定材確認を入れたことを固定する。
//   1段目のrunBusy: itemId==='cl-to-center'のときだけcollectFixedMembersByFloor(で列挙 →
//                    空ならrunConvertCenterLine(まで完了する（従来どおり1回の関門内で終わる）。
//                    昇格（cl-to-grid）は列挙しない（裁定4は降格のみ対象）。
//   関門の外:        固定材が見つかったときだけconfirmFixedMemberDeletion(で確認する。
//   中止分岐:        if (!ok) return; は2段目のrunBusy(より前で中断する。
//   2段目のrunBusy: 了承後だけrunConvertCenterLine(itemId, cl, { removeFixedMembers: true })を呼ぶ。
// 変異での検出力確認（手動）: (a) `if (itemId === 'cl-to-center') {`を外して常に列挙する→本テスト赤、
// (b) collectFixedMembersByFloorの呼び出し行を1段目runBusyの外へ出す→本テスト赤、
// (c) confirmFixedMemberDeletionの呼び出しを1段目runBusyの中へ入れる→本テスト赤、
// (d) `if (!ok) return;`を削る→本テスト赤。
// ================================================================
test('【不変条件・手動追加材サイレント撤去回避ステップ4】App.jsx: handleConvertCenterLineはcl-to-centerのときだけcollectFixedMembersByFloor→（関門の外で）confirmFixedMemberDeletion→if(!ok)return→2段目のrunBusyの順で固定材の確認を挟む', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleConvertCenterLine');

  const runBusy1Idx  = body.indexOf('runBusy(');
  assert.ok(runBusy1Idx >= 0, 'handleConvertCenterLineの本体にrunBusy(の呼び出しが無い');
  const ifCenterIdx  = body.indexOf("if (itemId === 'cl-to-center') {");
  assert.ok(ifCenterIdx >= 0, "cl-to-centerだけ列挙する if (itemId === 'cl-to-center') { が無い");
  const collectIdx   = body.indexOf('collectFixedMembersByFloor(');
  assert.ok(collectIdx >= 0, 'collectFixedMembersByFloor(の呼び出しが無い');
  const runConvert1Idx = body.indexOf('await runConvertCenterLine(itemId, cl);');
  assert.ok(runConvert1Idx >= 0, '1段目のawait runConvertCenterLine(itemId, cl);が無い（固定材が無いときにそのまま変換まで完了する経路）');
  const ifByFloorIdx = body.indexOf('if (!byFloor) return;');
  assert.ok(ifByFloorIdx >= 0, '固定材が無いときにそのまま抜ける if (!byFloor) return; が無い');
  const confirmIdx   = body.indexOf('confirmFixedMemberDeletion(');
  assert.ok(confirmIdx >= 0, 'confirmFixedMemberDeletion(の呼び出しが無い');
  const ifNotOkIdx   = body.indexOf('if (!ok) return;');
  assert.ok(ifNotOkIdx >= 0, '中止分岐 if (!ok) return; が無い');
  const runBusy2Idx  = body.indexOf('runBusy(', runBusy1Idx + 1);
  assert.ok(runBusy2Idx >= 0, '2段目のrunBusy(の呼び出しが無い（確認了承後の変換本体）');
  const runConvert2Idx = body.indexOf('await runConvertCenterLine(itemId, cl, { removeFixedMembers: true });', runBusy2Idx);
  assert.ok(runConvert2Idx >= 0, '2段目のrunBusy内にawait runConvertCenterLine(itemId, cl, { removeFixedMembers: true });が無い');

  assert.ok(
    runBusy1Idx < ifCenterIdx && ifCenterIdx < collectIdx && collectIdx < runConvert1Idx
      && runConvert1Idx < ifByFloorIdx && ifByFloorIdx < confirmIdx
      && confirmIdx < ifNotOkIdx && ifNotOkIdx < runBusy2Idx && runBusy2Idx < runConvert2Idx,
    "if (itemId === 'cl-to-center') {→collectFixedMembersByFloor(→runConvertCenterLine(itemId, cl);→"
    + 'if(!byFloor)return;→confirmFixedMemberDeletion(→if(!ok)return;→2段目のrunBusy(→'
    + 'runConvertCenterLine(itemId, cl, { removeFixedMembers: true });の順になっていない'
    + `（実際の位置: runBusy1=${runBusy1Idx}, ifCenter=${ifCenterIdx}, collect=${collectIdx}, `
    + `runConvert1=${runConvert1Idx}, ifByFloor=${ifByFloorIdx}, confirm=${confirmIdx}, `
    + `ifNotOk=${ifNotOkIdx}, runBusy2=${runBusy2Idx}, runConvert2=${runConvert2Idx}）`,
  );
});

// ================================================================
// 固定材確認の表示中は関門（runBusy）を開けておくため、その間にCtrl+Z/Y（undo/redo）や階切替が
// 割り込みうる——handleDeleteCenterLineと同じ理由で、2段目のrunBusy内でwhenIdle()の後・
// runConvertCenterLine(呼び出しの前にisCenterLineStillDeletable(で再検証していることを固定する。
// 変異での検出力確認（手動）: (a) isCenterLineStillDeletable(の呼び出し行そのものを削る→本テスト赤、
// (b) `if (false)`化して素通りさせる→本テスト赤（呼び出し行の1行まるごと一致を崩すため）。
// ================================================================
test('【不変条件・手動追加材サイレント撤去回避ステップ4】App.jsx: handleConvertCenterLineの2段目runBusyはwhenIdle()の後・runConvertCenterLine(の前にisCenterLineStillDeletableで再検証する', () => {
  const appSrc = fs.readFileSync(appSrcPath, 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleConvertCenterLine');

  const runBusy1Idx = body.indexOf('runBusy(');
  const runBusy2Idx = body.indexOf('runBusy(', runBusy1Idx + 1);
  assert.ok(runBusy2Idx >= 0, '2段目のrunBusy(の呼び出しが無い');
  const body2 = body.slice(runBusy2Idx); // 2段目のrunBusy(以降だけを見る（1段目に同名呼び出しが紛れ込んでも誤検出しない）

  const idleIdx = body2.indexOf('structuralSync.whenIdle()');
  assert.ok(idleIdx >= 0, '2段目のrunBusy内にstructuralSync.whenIdle()が無い');

  assert.match(body2, /^\s*if \(!isCenterLineStillDeletable\(project, graph, cl\)\) \{$/m,
    'isCenterLineStillDeletable(project, graph, cl)の再検証呼び出し行が1行まるごとの形で見つからない');
  const checkIdx = body2.indexOf('if (!isCenterLineStillDeletable(project, graph, cl)) {');

  const convertIdx = body2.indexOf('await runConvertCenterLine(itemId, cl, { removeFixedMembers: true });');
  assert.ok(convertIdx >= 0, '2段目のrunBusy内にawait runConvertCenterLine(itemId, cl, { removeFixedMembers: true });が無い');

  assert.ok(idleIdx < checkIdx && checkIdx < convertIdx,
    `whenIdle() < isCenterLineStillDeletable( < runConvertCenterLine(の順になっていない（実際の位置: idle=${idleIdx}, check=${checkIdx}, convert=${convertIdx}）`);
});
