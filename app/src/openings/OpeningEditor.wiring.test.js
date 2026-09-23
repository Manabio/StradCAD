// ステップ12e「未知の建具記号のUI」の仕上げ。OpeningEditor.jsx の記号selectが未知記号を
// 黙って失わないよう、選択肢の組み立て（既知/未知/別スコープの判断）を openingEdit.js
// fixtureSymbolOptions へ一本化し、jsx側が getFixtureSymbols を直接optionに使わないことを
// ソーステキスト検査で固定する（renderer/OpeningsLayer.wiring.test.js と同じ型）。
// コメント（行頭コメント）は除外する——退行の説明コメントに現れる旧関数名を誤検知しないため
// （team-lessons「ソース文字列を正規表現で検査する配線テストが、コメント文にも一致して変異を
// 見逃す」参照）。行頭コメントしか除外しないため、コード行の末尾コメントに禁止語が現れると
// 安全側（誤って赤になる）に倒れる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'OpeningEditor.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  return text.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】OpeningEditor.jsx は openingEdit.js の fixtureSymbolOptions を import している', () => {
  // import文が複数行にまたがる（本ファイルの規約）ため、行単位ではなく './openingEdit.js' への
  // import文全体（{...}部分）を1つの塊として取り出して検査する。
  const m = src.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/openingEdit\.js';/);
  assert.ok(m, "'./openingEdit.js' からのimport文が見つからない");
  assert.ok(/\bfixtureSymbolOptions\b/.test(m[1]), 'fixtureSymbolOptions を openingEdit.js から import していない');
});

test('【不変条件】OpeningEditor.jsx の記号selectは getFixtureSymbols を直接optionに使わない（未知記号の保持判断はfixtureSymbolOptionsに一本化）', () => {
  assert.ok(!codeOnly.includes('getFixtureSymbols('), 'getFixtureSymbols( への直接呼び出しが残っている（未知記号の選択肢が黙って失われる旧経路へ退行）');
});

test('【不変条件】記号selectのoptionsはfixtureSymbolOptionsの呼び出し結果をmapするだけ', () => {
  assert.ok(/fixtureSymbolOptions\([\s\S]*?\)\.map\(/.test(codeOnly), 'fixtureSymbolOptions(...).map( の形が見つからない');
});
