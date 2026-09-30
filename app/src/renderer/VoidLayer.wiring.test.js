// 昇降機（実装指示書ステップ1・2026-09-28）: renderer/VoidLayer.jsx が
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

// 2026-10-01裁定（QA指摘M1・M2でセル境界CL値・和集合判定に改訂）: 直下階の破線は自階に
// 同位置の吹抜け・昇降路が無いときだけ描く（visibleUpperVoidCrosses・ownVoidCellRects）。
// 以下のテストは行まるごと一致（`m`フラグ・`^…$`）で固定する——行末コメントに元の式を残す
// 変異・条件式を定数に差し替える変異のどちらでも赤化することを確認済み。

test('【不変条件】VoidLayer.jsx は finish/voidGeometry.js から ownVoidCellRects・visibleUpperVoidCrosses を import している', () => {
  const importLines = src.split(/\r?\n/).filter(l => /^import /.test(l));
  assert.ok(
    importLines.some(l => /\bownVoidCellRects\b/.test(l) && /voidGeometry\.js/.test(l)),
    'ownVoidCellRects を ../finish/voidGeometry.js から import していない',
  );
  assert.ok(
    importLines.some(l => /\bvisibleUpperVoidCrosses\b/.test(l) && /voidGeometry\.js/.test(l)),
    'visibleUpperVoidCrosses を ../finish/voidGeometry.js から import していない',
  );
});

test('【不変条件】VoidLayer.jsx は ownCellRects を ownVoidCellRects(graph) で算出する行をコード本体に持つ', () => {
  assert.ok(
    /^\s*const ownCellRects = ownVoidCellRects\(graph\);\s*$/m.test(codeOnly),
    'ownCellRects の算出行が想定の形でコード本体に見つからない',
  );
});

test('【不変条件】VoidLayer.jsx は visibleUpperCrosses を visibleUpperVoidCrosses(upperCrosses, ownCellRects) で算出する行をコード本体に持つ', () => {
  assert.ok(
    /^\s*const visibleUpperCrosses = visibleUpperVoidCrosses\(upperCrosses, ownCellRects\);\s*$/m.test(codeOnly),
    'visibleUpperCrosses の算出行が想定の形でコード本体に見つからない',
  );
});

test('【不変条件】VoidLayer.jsx は上階破線の描画に visibleUpperCrosses.map( を使う（生の upperCrosses.map( ではない）', () => {
  assert.ok(
    /^\s*\{visibleUpperCrosses\.map\(c => \{\s*$/m.test(codeOnly),
    '上階破線の描画箇所が visibleUpperCrosses.map(c => { の形でコード本体に見つからない',
  );
  const rawUpperMapMatches = codeOnly.match(/\bupperCrosses\.map\(/g) ?? [];
  assert.equal(rawUpperMapMatches.length, 0,
    '生の upperCrosses.map( がコード本体に残っている（visibleUpperCrosses 経由に置き換わっていないはず）');
});
