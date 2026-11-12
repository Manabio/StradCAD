// 構造リストの「開いているカード」を部材の id で覚える配線（裁定2026-11-12 案A・S2）のソース走査テスト。
// MemberListTab.jsx は.jsxのためnode:testから直接importできない。本体からブロックコメント・行頭コメント・
// 行末コメントを除いてから検査し、1 行まるごと一致を基本にする（呼び出しを行末コメント・ブロックコメント・
// 文字列リテラルへ移す変異で赤になる。前例: manualMemberAddWiring.test.js）。
// 置き換え元: memberCatalog.test.js の旧 pendingFocusId 2 テスト（pendingFocusId の state・effect／
// onPendingFocus={setPendingFocusId} の橋渡し）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines } from '../uiBusySourceScan.js';

const srcPath = path.resolve(import.meta.dirname, 'MemberListTab.jsx');
const stripped = stripCommentLines(
  fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ''),
).replace(/[ \t]+\/\/.*$/gm, '');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countOccurrences = (text, needle) => (text.match(new RegExp(escapeRe(needle), 'g')) || []).length;
const countWholeLines = (text, line) => (text.match(new RegExp(`^\\s*${escapeRe(line)}\\s*$`, 'gm')) || []).length;

// 関数本体（開始の needle から、次のインデント 2 の閉じ括弧行まで）。
function bodyFrom(needle) {
  const start = stripped.indexOf(needle);
  assert.ok(start >= 0, `${needle} が見つからない`);
  const end = stripped.indexOf('\n  }\n', start);
  assert.ok(end > start, `${needle} の本体の終わりが見つからない`);
  return stripped.slice(start, end);
}

// startNeedle から、その後ろで最初に現れる endNeedle の手前まで。
function bodyBetween(startNeedle, endNeedle) {
  const start = stripped.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つからない`);
  const end = stripped.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の後ろに ${endNeedle} が見つからない`);
  return stripped.slice(start, end);
}

test('【配線】expandedMemberCard.js の 6 関数を 1 行で import する', () => {
  assert.equal(countWholeLines(stripped,
    "import { anchorForCard, anchorForFocus, withPrimaryMember, resolveExpandedCard, reconcileAnchor, cardListing } from './expandedMemberCard.js';"), 1);
});

test('【配線】開いているカードの解決と取り直し（openCard・reconciledAnchor・effect）は各 1 行', () => {
  assert.equal(countWholeLines(stripped, 'const openCard = resolveExpandedCard(expandedKey, cardListing(sections));'), 1, 'openCard の行');
  assert.equal(countWholeLines(stripped,
    'const reconciledAnchor = reconcileAnchor(expandedKey, expandedKey, openCard, composition != null);'), 1, 'reconciledAnchor の行');
  assert.equal(countWholeLines(stripped,
    'if (reconciledAnchor !== expandedKey) setExpandedKey(a => reconcileAnchor(a, expandedKey, openCard, composition != null));'), 1, '取り直しの行');
  // openCard は描画ごとに新しい参照＝毎描画後に走る。依存を絞ると、番号だけが変わった描画で取り直しが走らなくなる。
  assert.equal(countWholeLines(stripped, '}, [reconciledAnchor, expandedKey, openCard, composition]);'), 1, '取り直し effect の依存配列');
});

test('【配線】描くセクションは一覧（sections）から引く（解決・非表示の判定を JSX 側で二重に持たない）', () => {
  assert.equal(countWholeLines(stripped, 'const section = sections.find(s => s.group === group);'), 1, 'sections から引く行');
  assert.equal(countWholeLines(stripped, 'if (!section) return null;'), 1, '一覧に無い分類は描かない');
  assert.equal(countWholeLines(stripped, 'const { graph: g, structure: gStructure, readOnly, tagGroups } = section;'), 1, '描画に使う値は一覧のもの');
  assert.equal(countOccurrences(stripped, 'composition?.resolveCategory(categoryFor(group))'), 1, 'カテゴリの解決は sections の組み立ての 1 回だけ');
});

test('【配線】番号でキーを作る書き方が残っていない', () => {
  assert.equal(countOccurrences(stripped, 'setExpandedKey(`'), 0, 'setExpandedKey(`…`) の番号キー');
  assert.equal(countOccurrences(stripped, 'onExpandKey'), 0, 'onExpandKey が残っている（onExpandMembers へ改名済み）');
  assert.equal(countOccurrences(stripped, 'pendingFocusId'), 0, 'pendingFocusId');
  assert.equal(countOccurrences(stripped, 'PendingFocusId'), 0, 'setPendingFocusId');
  assert.equal(countOccurrences(stripped, 'pendingFocusMemberNo'), 0, 'pendingFocusMemberNo');
  assert.equal(countOccurrences(stripped, '=== expandedKey'), 0, 'expandedKey との番号キー比較');
});

test('【配線】カードごとの cardKey（先頭部材の id）と isExpanded（sectionKey＋tag 一致）', () => {
  assert.equal(countWholeLines(stripped, 'const cardKey = `${group.mapName}:${members[0].id}`;'), 1, 'cardKey');
  assert.equal(countWholeLines(stripped,
    'const isExpanded = openCard != null && openCard.sectionKey === group.key && openCard.tag === tag;'), 1, 'isExpanded');
  assert.equal(countWholeLines(stripped, 'key={cardKey}'), 1, 'React の key');
  assert.equal(countWholeLines(stripped, 'isExpanded={isExpanded}'), 1, 'MemberCard への isExpanded');
});

test('【配線】トグル・分割・柱の主指定・伏図タップの各行', () => {
  assert.equal(countWholeLines(stripped,
    'onToggleCard={(mapName, ids, isOpen) => setExpandedKey(isOpen ? null : anchorForCard(mapName, ids))}'), 1, '親のトグル');
  assert.equal(countWholeLines(stripped,
    'onToggle={() => onToggleCard(group.mapName, members.map(m => m.id), isExpanded)}'), 1, 'セクションのトグル');
  assert.equal(countWholeLines(stripped, 'onExpandMembers?.(group.mapName, targetMembers.map(m => m.id));'), 1, '分割の確定');
  assert.equal(countWholeLines(stripped,
    'onExpandMembers={(mapName, ids) => setExpandedKey(anchorForCard(mapName, ids, ids[0]))}'), 1, '親の分割追従');
  assert.equal(countWholeLines(stripped,
    "const focusColumnMember = id => setExpandedKey(a => withPrimaryMember(a, 'columnMap', id));"), 1, '柱の主指定');
  assert.equal(countOccurrences(stripped, 'onPendingFocus={focusColumnMember}'), 1, 'onPendingFocus の橋渡し');
  // 素通しは従来どおり 4 つ（MemberGroupSection→MemberCard・ColumnWidthScopeSelect・ColumnOffsetAxisSelect の x と y）。
  assert.equal(countOccurrences(stripped, 'onPendingFocus={onPendingFocus}'), 4, 'onPendingFocus の素通し');
  assert.equal(countWholeLines(stripped, 'const next = anchorForFocus(focusRequest);'), 1, '伏図タップのアンカー');
  assert.equal(countWholeLines(stripped, 'if (next) setExpandedKey(next);'), 1, '伏図タップの設定');
});

// 1 行まるごと一致だけでは、前の行に足したガード（if (false) など）を見逃す。effect は本体ごと固定する。
test('【配線】伏図タップ・取り直しの effect はガードなしの本体', () => {
  assert.ok(/useEffect\(\(\) => \{\n\s*const next = anchorForFocus\(focusRequest\);\n\s*if \(next\) setExpandedKey\(next\);\n\s*\}, \[focusRequest\]\);/.test(stripped),
    '伏図タップの effect の形が違う');
  assert.ok(/useEffect\(\(\) => \{\n\s*if \(reconciledAnchor !== expandedKey\) setExpandedKey\(a => reconcileAnchor\(a, expandedKey, openCard, composition != null\)\);\n\s*\}, \[reconciledAnchor, expandedKey, openCard, composition\]\);/.test(stripped),
    '取り直しの effect の形が違う');
});

test('【配線】sections の 1 件の形と、組み立ての取捨（continue）', () => {
  assert.equal(countWholeLines(stripped, 'sectionKey: group.key, mapName: group.mapName, group, graph: g, structure: gStructure, readOnly,'), 1, 'sections の要素');
  assert.equal(countWholeLines(stripped, 'tagGroups: computeTagGroups(group, g, project, gStructure, figureType),'), 1, 'tagGroups の引数');
  assert.equal(countWholeLines(stripped, 'for (const group of MEMBER_GROUPS) {'), 1, 'MEMBER_GROUPS の順に組む');
  assert.equal(countWholeLines(stripped, 'if (!resolved) continue;'), 1, '解決できない分類は飛ばす（打ち切らない）');
  assert.equal(countOccurrences(bodyBetween('for (const group of MEMBER_GROUPS) {', 'const openCard = '), 'break;'), 0, '組み立てを途中で打ち切っている');
  assert.equal(countOccurrences(bodyBetween('for (const group of MEMBER_GROUPS) {', 'const openCard = '), 'continue;'), 2, '飛ばす条件は 2 つ（解決できない・構造種別が持たない）');
});

test('【配線】MemberGroupSection・MemberCard への橋渡し', () => {
  assert.equal(countWholeLines(stripped, 'key={group.key}'), 1, 'セクションの key');
  assert.equal(countWholeLines(stripped, 'tagGroups={tagGroups}'), 1, 'tagGroups');
  assert.equal(countWholeLines(stripped, 'openCard={openCard}'), 1, 'openCard');
  assert.equal(countWholeLines(stripped, 'onExpandMembers={onExpandMembers}'), 1, 'onExpandMembers の素通し');
});

// 分割後のカードは新しいグループ＝適用範囲は「全体」から。React の key が先頭部材の id なので、分割した部材が
// 先頭だと同じインスタンスが分割後のカードを引き継ぎ、展開の変化で既定へ戻す effect が走らない（QA 指摘 2026-11-12）。
test('【配線】分割の確定: setScope(\'all\') → onExpandMembers の順で、どちらも条件なしに呼ぶ', () => {
  const body = bodyBetween('splitGroup(project, group.mapName, targetMembers, { splitFromSignature });', 'onCancel: () => {');
  assert.ok(/\n\s*setScope\('all'\);\n\s*onExpandMembers\?\.\(group\.mapName, targetMembers\.map\(m => m\.id\)\);\n\s*onToast\?\.\(/.test(body),
    "setScope('all'); の直後に onExpandMembers?.(…); が続いていない");
  assert.equal(countOccurrences(body, 'if ('), 0, '分割の確定の中に条件分岐がある');
});

// 共通⇔個別を同じインスタンスが引き継ぐ場合（その柱がカードの先頭のとき）に既定へ戻す。
test('【配線】柱カードの既定 effect（columnScope・柱寸アップ）は isIndividualColumn でも戻す', () => {
  assert.equal(countWholeLines(stripped, '}, [isExpanded, focusRequest, isIndividualColumn]);'), 2, '依存に isIndividualColumn を持つ effect は 2 つ');
  assert.ok(/if \(isExpanded\) setColumnScope\(woodColumnCard && columnEntityTarget \? 'entity' : 'all'\);\n\s*\}, \[isExpanded, focusRequest, isIndividualColumn\]\);/.test(stripped),
    'columnScope の既定 effect');
  assert.ok(/if \(isExpanded\) setUpChecked\(false\);\n\s*\}, \[isExpanded, focusRequest, isIndividualColumn\]\);/.test(stripped), '柱寸アップの既定 effect');
});

// 柱のオフセットは触った柱を主にする（受理の前に呼ぶ。旧 pendingFocusId の頃からの順序）。
test('【配線】ColumnOffsetAxisSelect: onPendingFocus(target.id) → onStructureChanged の順', () => {
  const body = bodyBetween('const ColumnOffsetAxisSelect = observer(', 'return (');
  assert.ok(/\n\s*onPendingFocus\?\.\(target\.id\);\n\s*onStructureChanged\(\(\) => target\.setField\('woodOffsetSide', next\)\);/.test(body),
    'onPendingFocus?.(target.id); の直後に onStructureChanged(…) が続いていない');
});

// ラチェット: 開いているカードを変える経路はここに列挙した 7 本だけ（判断は expandedMemberCard.js の 1 か所）。
// 内訳: ①deselectRequest で閉じる ②伏図タップ（focusRequest）③composition 切替で閉じる ④描画後の取り直し
// ⑤カードのトグル ⑥分割の確定 ⑦柱の個別指定・オフセットの主指定。
// 新しい経路（例: 追加・削除の成功時）で setExpandedKey を足すとここが赤になる。削除の後に閉じる処理は
// 取り直し（④）へ吸収した（裁定 R5・R6。以前は削除確認 OK で閉じる 8 本目があった）。
test('【配線・ラチェット】setExpandedKey( の出現は 7 つだけ', () => {
  assert.equal(countOccurrences(stripped, 'setExpandedKey('), 7);
});

test('【配線】computeTagGroups( は定義・MergeBar・openMergeDialog・sections の 4 つだけで、MemberGroupSection は props で受ける', () => {
  assert.equal(countOccurrences(stripped, 'computeTagGroups('), 4);
  const secStart = stripped.indexOf('const MemberGroupSection = observer(({');
  const cardStart = stripped.indexOf('const MemberCard = observer(({');
  assert.ok(secStart >= 0 && cardStart > secStart, 'MemberGroupSection の範囲が取れない');
  const section = stripped.slice(secStart, cardStart);
  assert.equal(countOccurrences(section, 'computeTagGroups('), 0, 'MemberGroupSection が自分で computeTagGroups を呼んでいる');
  const props = section.slice(0, section.indexOf('}) => {'));
  assert.ok(/\btagGroups\b/.test(props), 'MemberGroupSection の props に tagGroups が無い');
  assert.ok(/\bopenCard\b/.test(props), 'MemberGroupSection の props に openCard が無い');
  assert.ok(!/\bexpandedKey\b/.test(props), 'MemberGroupSection の props に expandedKey が残っている');
});

test('【配線】追加の入口（柱の交点追加・梁の追加）は直後に展開を触らない', () => {
  const column = bodyFrom('async function handleAdd() {');
  assert.equal(countOccurrences(column, 'commitManualColumnAdd(graph, project, { vCL, hCL });'), 1, '柱の追加の本体を取れていない');
  const beamStart = stripped.indexOf('addManualBeam(graph, project, { axisCL, isVertical, clStart, clEnd });');
  assert.ok(beamStart >= 0, 'addManualBeam の呼び出しが無い');
  const beamFnStart = stripped.lastIndexOf('function handleAdd() {', beamStart);
  assert.ok(beamFnStart >= 0, '梁の追加の関数が取れない');
  const beam = stripped.slice(beamFnStart, stripped.indexOf('\n  }\n', beamStart));
  for (const [name, body] of [['柱の追加', column], ['梁の追加', beam]]) {
    assert.equal(countOccurrences(body, 'setExpandedKey'), 0, `${name}に setExpandedKey`);
    assert.equal(countOccurrences(body, 'onExpandMembers'), 0, `${name}に onExpandMembers`);
    assert.equal(countOccurrences(body, 'onPendingFocus'), 0, `${name}に onPendingFocus`);
  }
});
