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

// 小梁（role==='secondary'）の断面変更は locked にしない（ユーザー裁定 2026-10-28 Q2 案1。スラブ小梁の割付けが梁幅を入力にするため。範囲は小梁だけ）。
// 大梁など secondary 以外の梁と、柱など beamMap 以外は従来どおり locked。handleSectionChange の本体だけを切り出して判定する。
test('【配線】handleSectionChange: locked は beamMap の secondary 以外の梁用（role 条件つき）と beamMap 以外用の計2件', () => {
  const start = stripped.indexOf('function handleSectionChange(newId) {');
  assert.ok(start >= 0, 'handleSectionChange が見つからない');
  const body = stripped.slice(start, stripped.indexOf('<select', start));
  const branchStart = body.indexOf("if (group.mapName === 'beamMap') {");
  const branchEnd = body.indexOf('continue;', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'beamMap 分岐が見つからない');
  const beamBranch = body.slice(branchStart, branchEnd);
  const rest = body.slice(branchEnd);
  // 1行まるごと一致（行末コメントに元の式を残す変異を見逃さない。上の countWholeLines の注記）。
  assert.equal(countWholeLines(beamBranch, "if (m.role !== 'secondary') m.setDimensionStatus('locked');"), 1,
    'beamMap 分岐の locked は secondary 以外の梁用の1件で、role の条件と同じ行にある');
  assert.equal(countOccurrences(beamBranch, "setDimensionStatus('locked')"), 1, 'beamMap 分岐に他の locked 書込みは無い');
  assert.equal(countWholeLines(rest, "m.setDimensionStatus('locked');"), 1, 'beamMap 以外では locked を1回書く');
  assert.equal(countOccurrences(body, 'setDimensionStatus('), 2, 'handleSectionChange 全体で setDimensionStatus は2箇所');
});

// 梁カードの断面変更（S造の階）は onStructureChanged（構造再計算・undo 1 エントリ）に乗せる（ユーザー裁定 2026-10-28 Q3）。
// S造でない階の梁・柱・番号分割（scope≠all）は従来の commitScopedEdit。いずれも1行まるごと一致で固定する。
test('【配線】commitSectionEdit: S造の梁だけ onStructureChanged、他は commitScopedEdit。断面フィールドだけがこれを使う', () => {
  const start = stripped.indexOf('function commitSectionEdit(mutateFn) {');
  assert.ok(start >= 0, 'commitSectionEdit が見つからない');
  const body = stripped.slice(start, stripped.indexOf('\n  }\n', start));
  assert.equal(countWholeLines(body, "const slabBeamSection = group.mapName === 'beamMap' && rulesFor(structure).slabSecondaryBeams != null;"), 1,
    '対象条件（beamMap かつ slabSecondaryBeams あり）の行');
  assert.equal(countWholeLines(body, "if (slabBeamSection && (woodColumnCard || scope === 'all')) {"), 1,
    '再計算へ乗せる条件の行（commitScopedEdit が即時ミューテートする条件と同じ）');
  assert.equal(countWholeLines(body, 'onStructureChanged(() => mutateFn(members));'), 1, '再計算経路の行');
  assert.equal(countWholeLines(body, 'commitScopedEdit(mutateFn);'), 1, '従来経路の行');
  assert.equal(countOccurrences(body, 'onStructureChanged('), 1, 'onStructureChanged は1回だけ');
  assert.equal(countWholeLines(stripped, 'onCommit={commitSectionEdit}'), 1, '断面フィールドの onCommit');
  assert.equal(countWholeLines(stripped, 'onCommit={commitScopedEdit}'), 1, '他フィールドの onCommit は従来どおり');
});
