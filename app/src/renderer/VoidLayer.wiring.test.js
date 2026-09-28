// EV（エレベーターシャフト。実装指示書ステップ1・2026-09-28）: renderer/VoidLayer.jsx が
// 直下階ラベル（「上部吹抜け」）の表示条件を finish/voidGeometry.js の showsUpperVoidLabel に
// 委ねていることをソーステキスト検査で固定する（.jsx は node:test から単体 import できないため。
// OpeningsLayer.wiring.test.js と同じ型）。
// コメント（行コメント・ブロックコメント全体）は除外する——コメント文中の言及を実装呼び出しと
// 誤認しないため（team-lessons「ソース文字列を正規表現で検査する配線テストが、コメント文にも
// 一致して変異を見逃す」対応）。
// QA指摘（低3件・1件目）: 行頭判定だけでは行末のブロックコメント（`… /* showsUpperVoidLabel(c) */`）
// が残ってしまい、呼び出しを削除して代わりに残したダミーコメントを実装呼び出しと誤認する
// （変異c2）。ブロックコメントは行の途中にも現れるため、行フィルタの前に
// `/\/\*[\s\S]*?\*\//g` でファイル全体から先に除去する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'VoidLayer.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】VoidLayer.jsx は showsUpperVoidLabel( の呼び出しをコード本体にちょうど1箇所持つ（コメントではない・重複や別箇所への漏れが無い）', () => {
  const matches = codeOnly.match(/showsUpperVoidLabel\(/g) ?? [];
  assert.equal(matches.length, 1,
    `showsUpperVoidLabel( の呼び出しはコード本体にちょうど1箇所のはず（実際: ${matches.length}箇所）`);
});

test('【不変条件】VoidLayer.jsx は上部吹抜けラベルの表示条件を showLabel && showsUpperVoidLabel(c) の形でコード本体に持つ（別の場所への移動・書き換えを検知する）', () => {
  assert.ok(/const label = showLabel && showsUpperVoidLabel\(c\) \?/.test(codeOnly),
    'label算出式が想定の形（const label = showLabel && showsUpperVoidLabel(c) ? …）でコード本体に見つからない');
});

test('【不変条件】VoidLayer.jsx は finish/voidGeometry.js から showsUpperVoidLabel を import している', () => {
  const importLines = src.split(/\r?\n/).filter(l => /^import /.test(l));
  assert.ok(
    importLines.some(l => /\bshowsUpperVoidLabel\b/.test(l) && /voidGeometry\.js/.test(l)),
    'showsUpperVoidLabel を ../finish/voidGeometry.js から import していない',
  );
});
