// 手動追加材サイレント撤去回避（dev直下 260929_手動追加材サイレント撤去回避.md）ステップ1・配線テスト。
// MemberListTab.jsx は.jsxのためnode:testから直接importできない。ソーステキストを走査して、
// 柱・基礎/柱脚・梁の「＋追加」がgraph.addColumn/addFooting/addBeamを直接呼ばず、
// structural/manualMemberAdd.jsのaddManualColumn/addManualFooting/addManualBeam経由であることを固定する
// （前例: uiBusySourceScan.jsを使うstructural/structuralSync.test.js・uiBusyGate.test.js）。
// 耐力壁（addBearingWall）は対象外のため従来どおり1回のまま。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines } from '../uiBusySourceScan.js';

const srcPath = path.resolve(import.meta.dirname, 'MemberListTab.jsx');
const stripped = stripCommentLines(fs.readFileSync(srcPath, 'utf8'));

/** リテラル文字列needleの出現回数を数える（正規表現の特殊文字はエスケープする）。 */
function countOccurrences(text, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(escaped, 'g')) || []).length;
}

test('【配線】MemberListTabの手動追加はgraph.addColumn/addFooting/addBeamを直接呼ばない', () => {
  assert.equal(countOccurrences(stripped, 'graph.addColumn('), 0, 'graph.addColumn(を直接呼んではいけない（addManualColumn経由にする）');
  assert.equal(countOccurrences(stripped, 'graph.addFooting('), 0, 'graph.addFooting(を直接呼んではいけない（addManualFooting経由にする）');
  assert.equal(countOccurrences(stripped, 'graph.addBeam('), 0, 'graph.addBeam(を直接呼んではいけない（addManualBeam経由にする）');
});

// 呼び出しは1行まるごと（行頭〜行末）で一致させる。stripCommentLines は行コメント1行しか落とさないため、
// 「呼び出しを消して行末コメントに元の式を残す」変異を部分一致では見逃す（team-lessons 2026-09-29）。
function countWholeLines(text, line) {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`^\\s*${escaped}$`, 'gm')) || []).length;
}

test('【配線】MemberListTabはaddManualColumn/addManualFooting/addManualBeamを各1回だけ、引数まで固定した形で呼ぶ', () => {
  assert.equal(countWholeLines(stripped, 'addManualColumn(graph, project, { vCL, hCL });'), 1, 'addManualColumn(graph, project, { vCL, hCL }); の行は1つのはず');
  assert.equal(countWholeLines(stripped, 'addManualFooting(graph, project, { kind: footingKind, vCL, hCL });'), 1, 'addManualFooting(graph, project, { kind: footingKind, vCL, hCL }); の行は1つのはず');
  assert.equal(countWholeLines(stripped, 'addManualBeam(graph, project, { axisCL, isVertical, clStart, clEnd });'), 1, 'addManualBeam(graph, project, { axisCL, isVertical, clStart, clEnd }); の行は1つのはず');
});

test('【配線】耐力壁（addBearingWall）は対象外のまま1回残る', () => {
  assert.equal(countOccurrences(stripped, 'graph.addBearingWall('), 1, '耐力壁は本課題の対象外なので従来どおり直接addBearingWallを呼ぶ');
});
