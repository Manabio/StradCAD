// 仕上げ突入の事前確認（loadFloorFn）の配線テスト。.jsx は node:test から import できないため、
// コメント行を除いた本体に対し、1行まるごと一致（m フラグ・行頭行末アンカー）で検査する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appSrcPath, stripCommentLines } from '../uiBusySourceScan.js';

test('【配線】App.jsx: finish.enter は実 loadFloor を loadFloorFn として渡す', () => {
  const code = stripCommentLines(fs.readFileSync(appSrcPath, 'utf8'));
  assert.match(code, /^\s*enter: \(graph\) => runFinishEntryBoundary\(graph, project, \{ loadFloorFn: loadFloor \}\),\s*$/m,
    'finish.enter が loadFloorFn: loadFloor を渡す1行が見つからない');
});

test('【配線】finishBoundary.js: runFinishEntryBoundary は受け取った loadFloorFn を pull へそのまま渡す', () => {
  const code = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'finishBoundary.js'), 'utf8'));
  assert.match(code, /^\s*await pullCLEccentricities\(project, graph, \{ materialMap: pullMaterialMap, loadFloorFn \}\);\s*$/m,
    'pull へ loadFloorFn を渡す1行が見つからない');
});
