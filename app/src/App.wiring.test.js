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
