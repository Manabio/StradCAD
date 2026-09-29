// 昇降機の仕様追加ステップ3（S4・平面のハイライト）: FinishModeLayer.jsx が highlightCellKeys
// を受け取り、選択中の部屋の輪郭線と同じ流儀（cellBoundsList→outlineSegments）で描いている
// ことをソーステキスト検査で固定する（.jsx は node:test から単体 import できないため。
// VoidLayer.wiring.test.js と同じ型。コメントは除外して検査する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'FinishModeLayer.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】FinishModeLayer は highlightCellKeys を props で受け取る', () => {
  assert.ok(/highlightCellKeys\s*=\s*null/.test(codeOnly),
    'highlightCellKeys（既定null）を props で受け取っていない');
});

// QA指摘（ステップ3全体・C）: 部分一致（コメント除去のみ）は「実装を無効化しつつ元の式を
// 同じ行の行末コメントとして残す変異」を検出できない。1行まるごとをmフラグの行頭・行末
// アンカー（^\s*…$）で照合する形へ直す（コメントは除去せず生のsrcに対して照合する——
// 行末コメントが付くと$の前提が崩れて不一致になる）。
test('【配線・強化】FinishModeLayer は highlightCellKeys から cellBoundsList→outlineSegments で輪郭線を組み立てる（選択中の部屋と同じ流儀・1行まるごとの形）', () => {
  assert.match(src, /^\s*const highlightBoundsList = highlightCellKeys && highlightCellKeys\.size > 0\s*$/m,
    'const highlightBoundsList = highlightCellKeys && highlightCellKeys.size > 0 が1行まるごとの形で見つからない');
  assert.match(src, /^\s*\? cellBoundsList\(highlightCellKeys, graph\) : \[\];\s*$/m,
    '? cellBoundsList(highlightCellKeys, graph) : []; が1行まるごとの形で見つからない');
  assert.match(src, /^\s*const highlightSegs = outlineSegments\(highlightBoundsList\)\.map\(seg => \(\s*$/m,
    'const highlightSegs = outlineSegments(highlightBoundsList).map(seg => ( が1行まるごとの形で見つからない');
});

test('【不変条件】FinishModeLayer は組み立てたハイライト線分（highlightSegs）を描画する（<Group> 内に含む）', () => {
  assert.ok(/\{highlightSegs\}/.test(codeOnly), '{highlightSegs} がJSX本体に見つからない');
});
