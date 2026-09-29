// App.jsx（部屋名ダイアログ・仕上げ表内部タブのカード）の配線不変条件。.jsx は node:test から
// 単体 import できないため、ソーステキスト検査で固定する（finish/RoomNameInput.wiring.test.js と
// 同じ型。ブロックコメント・行コメントを除去してから検査する——team-lessons「ソース文字列を
// 正規表現で検査する配線テストが、コメント文にも一致して変異を見逃す」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'App.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

// ステップ1（部屋編集の導線変更）: 部屋名ダイアログ（新規Room命名専用）と仕上げ表内部タブの
// カード（既存部屋編集）は同じ applyRoomNaming（applyNaming＋階段変換時のsyncUpperFloors）を使う。
test('【不変条件】RoomNameInput の onConfirm と FinishSidebar/FinishHalfModal の onApplyNaming は同じ applyRoomNaming を渡す', () => {
  assert.ok(/onConfirm=\{applyRoomNaming\}/.test(codeOnly),
    'RoomNameInput の onConfirm={applyRoomNaming} が見つからない');
  const onApplyNamingMatches = codeOnly.match(/onApplyNaming=\{applyRoomNaming\}/g) ?? [];
  assert.equal(onApplyNamingMatches.length, 2,
    `onApplyNaming={applyRoomNaming} は FinishSidebar/FinishHalfModal の2箇所のはず（実際: ${onApplyNamingMatches.length}）`);
});

test('【不変条件】RoomNameInput に onDelete を渡していない・deleteFromDialog を呼んでいない（削除ボタン廃止）', () => {
  assert.ok(!/onDelete=/.test(codeOnly), 'onDelete= が残っている');
  assert.ok(!/deleteFromDialog/.test(codeOnly), 'deleteFromDialog の呼び出しが残っている');
});

// T6: applyRoomNaming は floorHeightAbove(project, project.activePlane) を applyNaming の第3引数に
// 渡し、戻り値（convertedStair）が真のときだけ syncUpperFloors を lastNamingUndoEntry 付きで呼ぶ。
test('【不変条件・T6】applyRoomNaming は applyNaming(id, payload, floorHeight) の形でfloorHeightAboveの結果を渡す', () => {
  const startIdx = codeOnly.indexOf('function applyRoomNaming');
  assert.ok(startIdx >= 0, 'function applyRoomNaming が見つからない');
  const endIdx = codeOnly.indexOf('\n  }', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 4);
  assert.ok(/const floorHeight = floorHeightAbove\(project, project\.activePlane\);/.test(block),
    'floorHeight を floorHeightAbove(project, project.activePlane) から求めていない');
  assert.ok(/modeRef\.current\?\.applyNaming\(id, payload, floorHeight\)/.test(block),
    'applyNaming(id, payload, floorHeight) の呼び出しが見つからない');
});

test('【不変条件・T6】applyRoomNaming は convertedStair が真のときだけ syncUpperFloors を lastNamingUndoEntry 付きで呼ぶ', () => {
  const startIdx = codeOnly.indexOf('function applyRoomNaming');
  const endIdx = codeOnly.indexOf('\n  }', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 4);
  assert.ok(/if \(convertedStair\) \{/.test(block),
    'if (convertedStair) { ガードが見つからない');
  const ifIdx = block.indexOf('if (convertedStair) {');
  const afterIf = block.slice(ifIdx);
  assert.ok(/const undoEntry = modeRef\.current\?\.lastNamingUndoEntry \?\? null;/.test(afterIf),
    'if (convertedStair) 内で lastNamingUndoEntry を読んでいない');
  assert.ok(/m\.syncUpperFloors\(project, project\.activeGraph, \{ undoEntry \}\)/.test(afterIf),
    'if (convertedStair) 内で syncUpperFloors(project, project.activeGraph, { undoEntry }) を呼んでいない');
});

// T7: 部屋名ダイアログが開いている間（namingRoomId有り）はFinishSidebar/FinishHalfModal（カード）を
// 描画しない。カード経由のapplyNamingが、開いている新規ダイアログの保留undo・選択順を消費しない前提。
test('【不変条件・T7】FinishSidebar/FinishHalfModal は !mode.namingRoomId のときだけ描画する', () => {
  assert.ok(/\{appMode === 'finish' && mode && !mode\.namingRoomId && \(/.test(codeOnly),
    "仕上げ表パネルの描画条件に appMode === 'finish' && mode && !mode.namingRoomId && ( が見つからない");
});

// ================================================================
// 昇降機の仕様追加 ステップ4・S4（QA指摘W1・W2）: installElevatorFromNaming の onApplied・
// project.equipmentIndex を埋める effect の配線。1行まるごとの形で固定する
// （team-lessons「行末コメントに元の式を残す変異・条件式を定数に差し替える変異」対応）。
// ================================================================

test('【配線・強化・W1】App.jsx: installElevatorFromNaming は onApplied: () => setFloorSyncTick(t => t + 1), を1行まるごとの形で渡す', () => {
  assert.match(src, /^\s*onApplied: \(\) => setFloorSyncTick\(t => t \+ 1\),\s*$/m,
    'onApplied: () => setFloorSyncTick(t => t + 1), が1行まるごとの形で見つからない');
});

test('【配線・強化・W2】App.jsx: project.equipmentIndexを埋めるeffectが project.replaceEquipmentIndex(entries) を1行まるごとの形でrunInActionの中から呼ぶ', () => {
  assert.match(src, /^\s*runInAction\(\(\) => project\.replaceEquipmentIndex\(entries\)\);\s*$/m,
    'runInAction(() => project.replaceEquipmentIndex(entries)); が1行まるごとの形で見つからない');
});

// QA指摘n1-a: aborted で message が無いとき（isStillValid の再確認による中断等）も、ダイアログが
// 無言で開いたままにならないよう既存の類似文言（ERR_ELEVATOR_FLOORS_CHANGED）で代用する。
test('【配線・強化・n1-a】App.jsx: installElevatorFromNaming は aborted のとき r.message ?? ERR_ELEVATOR_FLOORS_CHANGED を1行まるごとの形でトースト表示する', () => {
  assert.match(src, /^\s*setToast\(\{ msg: r\.message \?\? ERR_ELEVATOR_FLOORS_CHANGED, key: Date\.now\(\) \}\);\s*$/m,
    'setToast({ msg: r.message ?? ERR_ELEVATOR_FLOORS_CHANGED, key: Date.now() }); が1行まるごとの形で見つからない');
});

// QA指摘n1-b: commitActive がグラフを変更した後に拒否・例外・undoエントリnullのいずれかに
// なった場合、設置階も確定前のスナップショットへ戻してから例外にする（上階の巻き戻しだけでは
// 設置階の変更済みグラフと食い違うため）。snapshotFinishState/restoreFinishState（finishUndo.jsの
// 既存の復元関数）を使っていることを固定する。
test('【配線・強化・n1-b】App.jsx: commitActive は snapshotFinishState(g) を先頭で採り、3つの失敗経路すべてで restoreFinishState(g, before) を呼んでから例外にする', () => {
  const startIdx = src.indexOf('const commitActive = (equipment) => {');
  assert.ok(startIdx >= 0, 'commitActive が見つからない');
  const endIdx = src.indexOf('\n      };', startIdx);
  const body = src.slice(startIdx, endIdx);
  assert.match(body, /const before = snapshotFinishState\(g\);/, 'before = snapshotFinishState(g) が見つからない');
  const restoreMatches = body.match(/runInAction\(\(\) => restoreFinishState\(g, before\)\);/g) ?? [];
  assert.equal(restoreMatches.length, 3,
    `restoreFinishState(g, before) の呼び出しは3箇所（例外・拒否・undoエントリnull）のはず（実際: ${restoreMatches.length}）`);
});
