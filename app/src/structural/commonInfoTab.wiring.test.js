// 共通タブの配線（S5d）。.jsx は node:test から import できないため、ソースを走査して固定する。
// コメント文に一致して変異を見逃さないよう、行コメント・ブロックコメントを除いてから照合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines, extractFunctionBody } from '../uiBusySourceScan.js';

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const tabSrc = () => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, 'CommonInfoTab.jsx'), 'utf8'));

test('【S5d・配線】CommonInfoTab.jsx は行の分岐を commonTabStructureRow に任せ、チェックは row.showOverrideToggle のときだけ出す', () => {
  const code = tabSrc();
  assert.equal((code.match(/commonTabStructureRow\(graph\.plane, graph\.structureOverride, info\)/g) ?? []).length, 1);
  assert.ok(/\{row\.showOverrideToggle && \(/.test(code), 'チェックが row.showOverrideToggle で出し分けられていない');
  assert.ok(/checked=\{row\.overrideChecked\}/.test(code));
  assert.ok(!/info\.basementStructure/.test(code), 'jsx は info.basementStructure を直接読まない（モデル経由）');
});

test('【S5d・配線】CommonInfoTab.jsx: setBasementStructure( は onStructureChanged( の閉包の中だけ、setField(\'basementStructure\' は無い', () => {
  const code = tabSrc();
  assert.ok(!/setField\(\s*'basementStructure'/.test(code), '汎用 setField で地階構造を書かない（専用 action を通す）');
  const calls = [...code.matchAll(/info\.setBasementStructure\(/g)];
  assert.equal(calls.length, 1, '書き込み箇所は1つ');
  const closure = /onStructureChanged\(\(\) => \{([\s\S]*?)\n {4}\}\);/.exec(code.slice(code.indexOf('function setBasementStructure')));
  assert.ok(closure, 'setBasementStructure が onStructureChanged の閉包になっていない');
  assert.ok(/info\.setBasementStructure\(v\);\s*normalizeFoundationType\(\);/.test(closure[1]),
    '閉包の中で setBasementStructure を先に、続けて基礎種別の正規化を呼ぶ（選択肢外は副作用前に throw）');
  assert.ok(/if \(v === BASEMENT_UNSET_LABEL\) return;/.test(code), '未設定の表示行を選んでも何も書かない');
});

test('【S5d・配線】CommonInfoTab.jsx: 基礎種別の正規化は mutate の中（主構造の変更・地階構造の変更）からだけ呼び、上書きの編集・切替からは呼ばない', () => {
  const code = tabSrc();
  const calls = [...code.matchAll(/normalizeFoundationType\(\)/g)].length;
  assert.equal(calls, 3, '定義1＋主構造の変更1＋地階構造の変更1');
  const toggle = /function toggleOverride[\s\S]*?\n {2}\}/.exec(code);
  assert.ok(toggle && !/normalizeFoundationType/.test(toggle[0]), 'toggleOverride から正規化を呼ばない');
  assert.ok(/foundationStructureFor\(info, hasBasementFloor\(project\.planes\)\)/.test(code));
});

test('【S5・配線】CommonInfoTab.jsx: 書込みは commitSteelSlabSpec( が onStructureChanged の閉包の中に1回だけ（setSteelSlabSpec( は直接呼ばない）。欄は showSteelSlabSection で出し分ける', () => {
  const code = tabSrc();
  assert.equal([...code.matchAll(/setSteelSlabSpec\(/g)].length, 0, 'jsx は setSteelSlabSpec を直接呼ばない（モデルの commitSteelSlabSpec 経由＝カタログ照合なし）');
  assert.equal([...code.matchAll(/commitSteelSlabSpec\(/g)].length, 1, '書き込み箇所は1つ');
  assert.ok(/onStructureChanged\(\(\) => commitSteelSlabSpec\(info, patch\)\)/.test(code), '再計算＋undo 1件の経路（onStructureChanged）に乗せる');
  assert.ok(/const slabCatalog = useSteelSlabMaterials\(\);/.test(code), '材料は共有フック経由（カードと同じ読込み方式）');
  const hook = stripComments(fs.readFileSync(path.resolve(import.meta.dirname, 'useSteelSlabMaterials.js'), 'utf8'));
  assert.ok(/loadBuiltin\(\)\.then\([\s\S]*?\}\)\.catch\(/.test(hook), '材料の読込み失敗を握る（未読込みのまま続ける）');
  assert.ok(/FIELD_ERROR_COLOR/.test(code) && !/#c0392b/.test(code));
  assert.ok(/\{showSlab && \(/.test(code) && /const showSlab = showSteelSlabSection\(graph, project\);/.test(code), '欄は showSteelSlabSection で出し分ける');
  assert.ok(/planSlabEdit\(/.test(code), '検証はモデル（planSlabEdit）経由');
  assert.ok(/materials\.length > 0 \? materials : undefined/.test(hook), '材料の未読込み（空配列）では照合しない');
});

test('【S5d・配線】App.jsx: StructuralPanel の onStructureChanged は guardUi(handleStructureChanged)。本体は握りつぶしの .catch を持たない', () => {
  const app = stripCommentLines(readAppSrc());
  assert.ok(/<StructuralPanel[\s\S]{0,900}onStructureChanged=\{guardUi\(handleStructureChanged\)\}/.test(app),
    'onStructureChanged={guardUi(handleStructureChanged)} が無い');
  const body = extractFunctionBody(readAppSrc(), 'async function handleStructureChanged');
  assert.ok(/recomputeStructuralComposition\(structComposition, project\.activeGraph, project,/.test(body));
  assert.ok(!/\.catch\(/.test(body), '失敗表示は guardUi に一本化（ここで握りつぶさない）');
  assert.ok(/structuralSync\.whenIdle\(\)/.test(body), '構造同期の実行中は待つ');
  const code = stripCommentLines(body);
  assert.ok(/catch \(err\) \{\s*throw tagStructChangeFailure\(err\);\s*\}/.test(code), '【F1】失敗は tagStructChangeFailure を通して投げ直す（階切替の汎用文言に丸めない）');
  assert.ok(code.indexOf('recomputeStructuralComposition(') < code.indexOf('tagStructChangeFailure('), 'tag は再計算の後（catch 側）');
});
