// S造スラブカード（S6）の配線テスト。.jsx は node:test から import できないため、ソースを走査して固定する
// （前例: steelSlabPickWiring.test.js）。コメントを除いてから照合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const read = rel => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));

test('【S6・配線】MemberListTab: setSteelSpec( は onStructureChanged の閉包の中の1か所だけ', () => {
  const code = read('MemberListTab.jsx');
  assert.equal([...code.matchAll(/setSteelSpec\(/g)].length, 1, '書込み箇所は1つ');
  assert.ok(/onStructureChanged\(\(\) => \{ for \(const m of members\) m\.setSteelSpec\(nextSpec\); \}\)/.test(code),
    '再計算＋undo 1 件の経路（onStructureChanged）で全 members へ書く');
});

test('【S6・配線】MemberListTab: 検証・畳み込みはモデル（planSteelSlabCardEdit）経由、変化なし（undefined）は書かない、RC 欄は slabCardFields で外す', () => {
  const code = read('MemberListTab.jsx');
  assert.ok(/planSteelSlabCardEdit\(\{ slab: representative, common: steelSlabCommon,/.test(code));
  assert.ok(/if \(nextSpec === undefined\) return;/.test(code));
  assert.ok(/const fields = slabCardFields\(representative, /.test(code), 'RC のフィールド定義は SteelSlab で空にする');
  assert.ok(/planSteelSlabRevert\(representative, members\)/.test(code), '「共通に戻す」はモデル経由');
  assert.ok(/\{slabView && \(/.test(code) && /slabView\.showRevert && !readOnly/.test(code), '戻すボタンは個別かつ編集可のときだけ');
});

test('【S6・配線】カードの readOnly では SlabRow を無効化し、書込みは全員が同値なら行わない', () => {
  const code = read('MemberListTab.jsx');
  assert.ok(/disabled=\{readOnly\}/.test(code.slice(code.indexOf('<SlabRow'))), 'カードの SlabRow に disabled={readOnly}');
  const row = read('CommonInfoTab.jsx');
  assert.ok(/<select value=\{row\.value\} disabled=\{disabled\}/.test(row) && /<input type="number" min=\{row\.min\} disabled=\{disabled\}/.test(row));
  assert.ok(/if \(slabWriteIsNoop\(members, nextSpec\)\) return;/.test(code));
  assert.ok(!/'#2563eb'|'#93c5fd'|'#64748b'/.test(code.slice(code.indexOf('{slabView && ('), code.indexOf('{fields.map'))), '仕様ブロックに色リテラルを直書きしない');
});

test('【S7・配線】ブレースのカードは展開中だけ設置高さの解決結果を計算して view へ渡し、SlabRow は読取専用以外でも note を出す', () => {
  const code = read('MemberListTab.jsx');
  assert.ok(/steelSlabBraceHeightInfo\(graph, project, representative\)/.test(code), '計算は steelSlabBays の純関数');
  assert.ok(/isExpanded && steelSlabCard && resolveSteelSlabSpec\(representative\.steelSpec, steelSlabCommon\)\.kind === SteelSlabKind\.BRACE/.test(code),
    '展開中のブレースのカードだけ（折りたたみ全カードでベイ計算しない）');
  assert.ok(/materials: slabMaterials, members, braceInfo \}/.test(code));
  const row = read('CommonInfoTab.jsx');
  assert.ok(/row\.kind !== SLAB_ROW_KIND\.READONLY && row\.note/.test(row));
});

test('【S7・配線】steelSlabBraceHeightInfo は buildBays 1 回の bayBraceInfos で全 cells を解決する（cells ごとの再構築をしない）', () => {
  const code = read('steelSlabBays.js');
  assert.ok(/bayBraceInfos\(graph, project, slab\.cells\)/.test(code));
  assert.ok(!/bayChildDepthMm\(/.test(code));
});

test('【S6・配線】材料の読込みは共有フックを一覧の1か所（MemberListTab）で呼び、カードへ props で渡す', () => {
  const code = read('MemberListTab.jsx');
  assert.equal([...code.matchAll(/useSteelSlabMaterials\(\)/g)].length, 1, 'カードごとに読まない');
  assert.equal([...code.matchAll(/slabMaterials=\{slabMaterials\}/g)].length, 2, '一覧→セクション→カード');
  assert.ok(/const slabCatalog = useSteelSlabMaterials\(\);/.test(read('CommonInfoTab.jsx')));
});
