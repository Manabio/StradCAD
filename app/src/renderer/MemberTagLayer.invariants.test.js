// renderer/MemberTagLayer.jsx のソース走査による不変条件テスト（ステップ4 第2単位C-1「在来では
// 部材タグを描かない」の回帰防止）。MemberTagLayer.jsx は react-konva に依存するため import して
// 実行できず、node:test から直接検証できるのはソーステキストの構造だけ——「主題階（beamMap）の
// 実効主構造から showMemberTags を経由して早期returnしているか」を、実装を1文字戻したら検出できる
// 形でここに固定する（team-lessons「抽出モジュールは呼び出し側もテストで守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource() {
  return fs.readFileSync(path.resolve(import.meta.dirname, 'MemberTagLayer.jsx'), 'utf8');
}

function codeLines(src) {
  return src.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, ''));
}

test('【不変条件】MemberTagLayer.jsx: 主題階（beamMap）の実効主構造を showMemberTags( に渡して早期returnする', () => {
  const src = readSource();
  const figureGraphMatch = /const\s+(\w+)\s*=\s*composition\.graphForCategory\(\s*'beamMap'\s*\)/.exec(src);
  assert.ok(figureGraphMatch, "composition.graphForCategory('beamMap') の代入が見つからない（主題階の取得元がStructuralLayer.jsxと不一致の回帰）");
  const figureGraphVar = figureGraphMatch[1];
  const effRe = new RegExp(`effectiveStructure\\(\\s*${figureGraphVar}\\s*,\\s*project\\s*\\)`);
  assert.ok(effRe.test(src), `effectiveStructure(${figureGraphVar}, project) の呼び出しが見つからない`);
  const guardRe = /if\s*\(\s*!showMemberTags\(.*\)\s*\)\s*return null;/;
  assert.ok(guardRe.test(src), 'showMemberTags(...) の否定を条件にした早期return（`if (!showMemberTags(...)) return null;`）が見つからない');
});

test('【不変条件】MemberTagLayer.jsx: showMemberTagsの早期returnは composition の null ガードより後（無条件の手前2行）にある', () => {
  const lines = codeLines(readSource());
  const compositionGuardIdx = lines.findIndex(l => /if\s*\(\s*!composition\s*\)\s*return null;/.test(l));
  const showTagsGuardIdx = lines.findIndex(l => /if\s*\(\s*!showMemberTags\(/.test(l));
  assert.ok(compositionGuardIdx >= 0, '`if (!composition) return null;` が見つからない');
  assert.ok(showTagsGuardIdx >= 0, 'showMemberTags の早期returnが見つからない');
  assert.ok(showTagsGuardIdx > compositionGuardIdx, 'showMemberTags の早期returnは composition ガードより後になるはず');
});

test('【不変条件・QA2026-09-16】SceneLayers.jsx: <MemberTagLayer ...> に project={project} が渡されている', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'SceneLayers.jsx'), 'utf8');
  const blockMatch = /<MemberTagLayer\b([\s\S]*?)\/>/.exec(src);
  assert.ok(blockMatch, 'SceneLayers.jsx に <MemberTagLayer ... /> の呼び出しが見つからない');
  assert.ok(/project=\{project\}/.test(blockMatch[1]),
    'MemberTagLayer に project={project} が渡されていない（主題階の実効主構造が引けず showMemberTags が常に既定 show 扱いになる回帰）');
});
