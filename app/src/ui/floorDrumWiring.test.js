// FloorDrum.jsx・App.jsx guardUi の配線テスト（ソース文字列を読む方式）。
// .jsx は node:test から import できないため、uiBusyGate.test.js と同じ作法で
// コメント行を除いた実装本体に、1行まるごと一致（m フラグ・行頭行末アンカー）で検査する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appSrcPath, stripCommentLines, extractFunctionBody } from '../uiBusySourceScan.js';

const drumSrcPath = path.resolve(import.meta.dirname, 'FloorDrum.jsx');

test('【配線】FloorDrum.jsx: 表示基準の階を floorDrumLogic の resolveDisplayId で決める', () => {
  const code = stripCommentLines(fs.readFileSync(drumSrcPath, 'utf8'));
  assert.match(code, /^\s*const displayId = resolveDisplayId\(floors, activeFloorId, pendingId\);\s*$/m,
    'const displayId = resolveDisplayId(floors, activeFloorId, pendingId); が1行まるごとの形で見つからない');
});

test('【配線】FloorDrum.jsx: 切替の要求は canRequestSwitch → requestFloorSwitch を経由する', () => {
  const code = stripCommentLines(fs.readFileSync(drumSrcPath, 'utf8'));
  assert.match(code, /^\s*if \(!canRequestSwitch\(pendingRef\.current, displayId, id\)\) return;\s*$/m,
    'canRequestSwitch の判定行が1行まるごとの形で見つからない');
  assert.match(code, /^\s*requestFloorSwitch\(id, onSwitch, setPending\);\s*$/m,
    'requestFloorSwitch(id, onSwitch, setPending); が1行まるごとの形で見つからない');
});

test('【配線】FloorDrum.jsx: 横長ドラムの中心は表示基準（displayId）から求める', () => {
  const code = stripCommentLines(fs.readFileSync(drumSrcPath, 'utf8'));
  const lines = [
    [/^\s*const displayIndex = ordered\.findIndex\(f => f\.id === displayId\);\s*$/m, 'displayIndex の行'],
    [/^\s*const translateY = centerTop - displayIndex \* ITEM_H \+ drag;\s*$/m, 'translateY の行'],
    [/^\s*const centerIndex = clampIndex\(Math\.round\(displayIndex - drag \/ ITEM_H\), ordered\.length\);\s*$/m, 'centerIndex の行'],
    [/^\s*const next = nextIndexFromDrag\(displayIndex, drag, ordered\.length\);\s*$/m, 'nextIndexFromDrag の行'],
    [/^\s*const next = nextIndexFromWheel\(displayIndex, e\.deltaY, ordered\.length\);\s*$/m, 'nextIndexFromWheel の行'],
  ];
  for (const [re, name] of lines) assert.match(code, re, `${name}が1行まるごとの形で見つからない`);
});

test('【配線】FloorDrum.jsx: 縦長ピルの現在表示は displayId 基準', () => {
  const code = stripCommentLines(fs.readFileSync(drumSrcPath, 'utf8'));
  const lines = [
    [/^\s*aria-current=\{f\.id === displayId \? 'true' : undefined\}\s*$/m, 'aria-current の行'],
    [/^\s*style=\{pillStyle\(f\.id === displayId, false\)\}\s*$/m, 'pillStyle の行'],
    [/^\s*\{display\?\.name \?\? '階'\}\s*$/m, '折りたたみ時の表示名の行'],
    [/^\s*onClick=\{\(\) => \{ requestSwitch\(f\.id\); setExpanded\(false\); \}\}\s*$/m, 'onClick の行'],
  ];
  for (const [re, name] of lines) assert.match(code, re, `${name}が1行まるごとの形で見つからない`);
  const stale = code.match(/=== activeFloorId/g) ?? [];
  assert.equal(stale.length, 0, '実装本体に === activeFloorId が残っている（表示基準は displayId）');
});

test('【配線】FloorWheel: pending 中はドラッグを始めない', () => {
  const code = stripCommentLines(fs.readFileSync(drumSrcPath, 'utf8'));
  assert.match(code, /^\s*if \(pendingId != null\) return;(\s*\/\/.*)?\s*$/m,
    'if (pendingId != null) return; の行が見つからない');
});

test('【配線】App.jsx: guardUi は fn の Promise を return する（busy のときは何も返さない）', () => {
  const body = extractFunctionBody(fs.readFileSync(appSrcPath, 'utf8'), 'function guardUi(fn)');
  assert.match(body, /^\s*if \(isUiBusy\(\)\) return;\s*$/m, 'busy の無視（if (isUiBusy()) return;）が1行まるごとの形で見つからない');
  assert.match(body, /^\s*return Promise\.resolve\(fn\(\.\.\.args\)\)\.catch\(reportFloorTransitionError\);\s*$/m,
    'return Promise.resolve(fn(...args)).catch(reportFloorTransitionError); が1行まるごとの形で見つからない');
});
