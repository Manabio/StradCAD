// 構造リストの基礎伏図／1階伏図の見せ分け（App → StructuralPanel → MemberListTab の slotView）の配線テスト。
// .jsx は node:test から単体 import できないためソース走査で固定する。コメントは stripCommentsKeepStrings で
// 落としてから照合する（コメント文・行末コメントに残した元の式への誤マッチで変異を見逃さない）。
// 取捨は structuralClassification.js C 節の述語だけ（リストは sharedPlaneListsMember。Draws ではない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentsKeepStrings } from '../uiBusySourceScan.js';

const code = (rel) => stripCommentsKeepStrings(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));
const count = (text, needle) => text.split(needle).length - 1;

const app = stripCommentsKeepStrings(readAppSrc());
const panel = code('StructuralPanel.jsx');
const list = code('MemberListTab.jsx');

test('【配線】App.jsx: StructuralPanel へ slotView={structSlotView} を渡す（StructuralPanel の要素の内側）', () => {
  const start = app.indexOf('<StructuralPanel');
  assert.ok(start >= 0, 'StructuralPanel が実在する');
  const el = app.slice(start, app.indexOf('/>', start));
  assert.ok(el.includes('slotView={structSlotView}'), 'StructuralPanel 要素内');
  assert.equal(count(app, '<StructuralPanel'), 1);
});

test('【配線】StructuralPanel.jsx: slotView を受けて MemberListTab だけへ渡す', () => {
  assert.match(panel, /structureMode = null, slotView = null \}\) \{/);
  assert.equal(count(panel, 'slotView={slotView}'), 1);
  assert.match(panel, /<MemberListTab [^>]*slotView=\{slotView\} \/>/);
});

test('【配線】MemberListTab.jsx: slotView を props で受ける', () => {
  assert.match(list, /structureMode = null, slotView = null \}\) => \{/);
});

test('【配線】MemberListTab.jsx: computeTagGroups の呼び出しは 3 か所で、すべて slotView を渡す', () => {
  assert.equal(count(list, 'computeTagGroups('), 4, '定義 1＋呼び出し 3');
  assert.match(list, /function computeTagGroups\(group, graph, project, structure, figureType, slotView\) \{/);
  assert.match(list, /const tagGroups = computeTagGroups\(group, graph, project, structure, figureType, slotView\);/, 'MergeBar 内');
  assert.match(list, /const tagGroups = computeTagGroups\(group, g, project, gStructure, figureType, slotView\);/, 'sections の組み立て');
  assert.match(list, /computeTagGroups\(mergeState\.group, mergeState\.graph, project, mergeState\.structure, mergeState\.figureType, mergeState\.slotView\);/, 'openMergeDialog');
});

test('【配線】MemberListTab.jsx: computeTagGroups は自分の平面にだけ sharedPlaneListsMember（Lists）で絞る', () => {
  assert.match(list, /const view = sharedPlaneViewFor\(slotView, graph\.plane\.id\);/);
  assert.match(list, /const entities = byStructure\.filter\(e => sharedPlaneListsMember\(view, group\.mapName, e\)\);/);
  assert.match(list, /for \(const e of entities\) \{/, 'タグにまとめるのは絞り込み後の entities');
  assert.equal(count(list, 'of byStructure'), 0, '絞り込み前の列をまとめに使わない');
  assert.equal(count(list, 'sharedPlaneListsMember('), 1);
  assert.equal(count(list, 'sharedPlaneDrawsMember'), 0, 'リストは Draws を使わない');
  assert.equal(count(list, 'sharedPlaneDrawsKind'), 0);
});

test('【配線】MemberListTab.jsx: sections の組み立てで sharedPlaneSectionVisible が false なら continue', () => {
  assert.match(list, /if \(!sharedPlaneSectionVisible\(sharedPlaneViewFor\(slotView, g\.plane\.id\), groupMemberKinds\(group\.mapName, g, project\), tagGroups\.length > 0\)\) continue;/);
  assert.equal(count(list, 'sharedPlaneSectionVisible('), 1);
  assert.match(list, /sections\.push\(\{[^}]*tagGroups,\s*\}\);/, '絞り込み済みの tagGroups を sections へ入れる');
  // 順序: 絞り込み → 可否の判定（continue）→ push。continue が push の後ろへ回ると何も隠さない。
  const start = list.indexOf('for (const group of MEMBER_GROUPS) {');
  const body = list.slice(start, list.indexOf('const openCard = ', start));
  const iGroups = body.indexOf('const tagGroups = computeTagGroups(group, g,');
  const iVisible = body.indexOf('if (!sharedPlaneSectionVisible(');
  const iPush = body.indexOf('sections.push({');
  assert.equal(start >= 0 && iGroups >= 0 && iVisible >= 0 && iPush >= 0, true, 'ループ本体に 3 つとも在る');
  assert.equal(iGroups < iVisible, true, '絞り込みが可否の判定より前');
  assert.equal(iVisible < iPush, true, '可否の判定（continue）が push より前');
});

test('【配線】MemberListTab.jsx: [統合…] は slotView を mergeState に握り、MergeBar へ渡す', () => {
  assert.match(list, /setMergeState\(\{ group, graph: g, structure: gStructure, figureType, slotView, anchorTag: tag,/);
  assert.match(list, /<MergeBar[^>]*slotView=\{mergeState\.slotView\}/);
  assert.match(list, /const MergeBar = observer\(\(\{ group, graph, project, structure, figureType, slotView, /);
});

test('【配線】MemberListTab.jsx: リセットの effect は composition と slotKey の両方を比べ、依存配列にも入れる', () => {
  assert.match(list, /const slotKey = slotView\?\.slotKey \?\? null;/);
  assert.match(list, /if \(composition === lastCompositionRef\.current && slotKey === lastSlotKeyRef\.current\) return;/);
  assert.match(list, /lastSlotKeyRef\.current = slotKey;\s*setMergeState\(null\);\s*setMergeDialogState\(null\);\s*setExpandedKey\(null\);\s*\}, \[composition, slotKey\]\);/);
  assert.match(list, /if \(lastCompositionRef\.current === null\) \{ lastCompositionRef\.current = composition; lastSlotKeyRef\.current = slotKey; return; \}/);
});

test('【配線】MemberListTab.jsx: 「各階柱寸法」欄の条件式は slotView を読まない（両伏図に残す）', () => {
  const m = list.match(/const woodColumnWidthGraph = [^\n]*\n/);
  assert.ok(m, 'woodColumnWidthGraph の定義が読める');
  assert.ok(!/slotView|sharedPlane/.test(m[0]), 'woodColumnWidthGraph の式');
  assert.match(list, /\{woodColumnWidthGraph && \(/);
  assert.ok(!/slotView|sharedPlane/.test(list.slice(list.indexOf('{woodColumnWidthGraph && ('), list.indexOf('{MEMBER_GROUPS.map('))), '欄の JSX');
});
