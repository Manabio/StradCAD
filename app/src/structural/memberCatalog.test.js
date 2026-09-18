// memberCatalog.js（WP-B1: 踊り場受け梁 role:'landing' の受け入れ）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  memberSymbol, MEMBER_GROUPS, NUMBERED_MAPS, FIELD_DEFS_BY_CATEGORY, SIGNATURE_FIELDS_BY_MAP, MEMBER_CATEGORY,
  noJoinSignatureFor, joinSignatureFor, memberSignature, isIndividuallyNumbered, memberGroupKey, memberOrderKey,
} from './memberCatalog.js';
import { makeBeam, makeColumn } from './memberTestFixtures.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';

test('【WP-B1】memberSymbol: beamMapのrole:landingは記号LGを返す', () => {
  const landing = makeBeam('b1', 'STEEL-H200x100', { role: 'landing' });
  assert.equal(memberSymbol(landing, 'beamMap'), 'LG');
});

test('【WP-B1】MEMBER_GROUPS: 「梁」グループのfilterはrole:secondary/landingの両方を除外する', () => {
  const beamGroup = MEMBER_GROUPS.find(g => g.key === 'beam');
  const primary = makeBeam('b1', 'STEEL-H200x100', { role: 'primary' });
  const secondary = makeBeam('b2', 'STEEL-H200x100', { role: 'secondary' });
  const landing = makeBeam('b3', 'STEEL-H200x100', { role: 'landing' });
  assert.equal(beamGroup.filter(primary), true);
  assert.equal(beamGroup.filter(secondary), false);
  assert.equal(beamGroup.filter(landing), false);
});

test('【WP-B1】MEMBER_GROUPS: 「踊り場梁」グループはrole:landingのみを対象にし、手動追加不可・0件時は非表示', () => {
  const landingGroup = MEMBER_GROUPS.find(g => g.key === 'beamLanding');
  assert.ok(landingGroup);
  assert.equal(landingGroup.mapName, 'beamMap');
  assert.equal(landingGroup.category, MEMBER_CATEGORY.ROD);
  assert.equal(landingGroup.allowManualAdd, false);
  assert.equal(landingGroup.hideWhenEmpty, true);
  const landing = makeBeam('b1', 'STEEL-H200x100', { role: 'landing' });
  const primary = makeBeam('b2', 'STEEL-H200x100', { role: 'primary' });
  const secondary = makeBeam('b3', 'STEEL-H200x100', { role: 'secondary' });
  assert.equal(landingGroup.filter(landing), true);
  assert.equal(landingGroup.filter(primary), false);
  assert.equal(landingGroup.filter(secondary), false);
});

test('【失敗系・WP-B1】MEMBER_GROUPS: 「小梁」グループのfilterはrole:landingの梁を対象に含めない', () => {
  const beamSubGroup = MEMBER_GROUPS.find(g => g.key === 'beamSub');
  const landing = makeBeam('b1', 'STEEL-H200x100', { role: 'landing' });
  assert.equal(beamSubGroup.filter(landing), false);
});

test('【WP-B1】FIELD_DEFS_BY_CATEGORY[ROD]: levelOffsetのラベルは「天端レベル（FL基準）」', () => {
  const field = FIELD_DEFS_BY_CATEGORY[MEMBER_CATEGORY.ROD].find(f => f.key === 'levelOffset');
  assert.ok(field);
  assert.equal(field.label, '天端レベル（FL基準）');
});

test('【WP-B1】SIGNATURE_FIELDS_BY_MAP.beamMapはlevelOffsetを含まない（材寸署名は不変）', () => {
  assert.ok(!SIGNATURE_FIELDS_BY_MAP.beamMap.includes('levelOffset'));
});

// ---- ステップ4 C-2b: 柱・梁の断面欄（sectionDefId）は在来木造（columnSizing:'fixed'）で読み取り専用 ----
test('【ステップ4 C-2b】FIELD_DEFS_BY_CATEGORY[COLUMN_LIKE].sectionDefId: disabledWhenはctx.woodFixedSection===trueかつrole!=="foundation"のときだけtrue', () => {
  const field = FIELD_DEFS_BY_CATEGORY[MEMBER_CATEGORY.COLUMN_LIKE].find(f => f.key === 'sectionDefId');
  assert.ok(field);
  const column = makeColumn('c1', 'WOOD-120x120', { role: 'standard' });
  assert.equal(field.disabledWhen(column, { woodFixedSection: true }), true);
  assert.equal(field.disabledWhen(column, { woodFixedSection: false }), false, '非在来（columnSizing!=="fixed"）は編集可');
  assert.equal(field.disabledWhen(column, {}), false, 'ctx省略時は編集可（既定はfalse相当）');
  const pile = makeColumn('c2', 'WOOD-120x120', { role: 'foundation' });
  assert.equal(field.disabledWhen(pile, { woodFixedSection: true }), false, '杭（role:foundation）は柱寸法欄の対象外なので編集可のまま');
});

test('【ステップ4 C-2b】FIELD_DEFS_BY_CATEGORY[ROD].sectionDefId: disabledWhenはctx.woodFixedSection===trueかつrole!=="foundation"のときだけtrue', () => {
  const field = FIELD_DEFS_BY_CATEGORY[MEMBER_CATEGORY.ROD].find(f => f.key === 'sectionDefId');
  assert.ok(field);
  const beam = makeBeam('b1', 'WOOD-120x330', { materialType: 'WOOD', role: 'primary' });
  assert.equal(field.disabledWhen(beam, { woodFixedSection: true }), true);
  assert.equal(field.disabledWhen(beam, { woodFixedSection: false }), false);
  const foundationBeam = makeBeam('b2', 'RC-300x300', { materialType: 'RC', role: 'foundation' });
  assert.equal(field.disabledWhen(foundationBeam, { woodFixedSection: true }), false, '基礎梁は柱寸法欄と無関係（RC・別算定）なので編集可のまま');
});

test('【伏図の柱記号】columnMapSelf（自階柱・描画専用の参照レイヤ）はNUMBERED_MAPS/MEMBER_GROUPSに現れない', () => {
  assert.ok(!NUMBERED_MAPS.includes('columnMapSelf'), 'NUMBERED_MAPSは採番対象のmapNameだけを持つ');
  assert.ok(!MEMBER_GROUPS.some(g => g.mapName === 'columnMapSelf'), 'MEMBER_GROUPSは構造リスト（編集系）のグループだけを持つ');
});

// ---- ステップ3e-2（床梁 role:'floor'、記号FB）----

test('【3e-2】memberSymbol: beamMapのrole:floorは記号FBを返す', () => {
  const floor = makeBeam('b1', 'WOOD-120x120', { role: 'floor' });
  assert.equal(memberSymbol(floor, 'beamMap'), 'FB');
});

test('土台（role:sill）: memberSymbolは記号SLを返し、「梁」グループのfilterはfoundationと同じく除外しない（土台基礎見出しにFGと並ぶ）', () => {
  const sill = makeBeam('b1', 'WOOD-120x120', { role: 'sill' });
  assert.equal(memberSymbol(sill, 'beamMap'), 'SL');
  const beamGroup = MEMBER_GROUPS.find(g => g.key === 'beam');
  assert.equal(beamGroup.filter(sill), true, 'role:sillは「梁」グループのfilterで除外されない');
});

test('【3e-2】MEMBER_GROUPS: 「梁」グループのfilterはrole:floorも除外する', () => {
  const beamGroup = MEMBER_GROUPS.find(g => g.key === 'beam');
  const primary = makeBeam('b1', 'WOOD-120x120', { role: 'primary' });
  const floor = makeBeam('b2', 'WOOD-120x120', { role: 'floor' });
  assert.equal(beamGroup.filter(primary), true);
  assert.equal(beamGroup.filter(floor), false);
});

test('【3e-2】MEMBER_GROUPS: 「床梁」グループはrole:floorのみを対象にし、手動追加不可・0件時は非表示（踊り場梁と同型）', () => {
  const floorGroup = MEMBER_GROUPS.find(g => g.key === 'beamFloor');
  assert.ok(floorGroup);
  assert.equal(floorGroup.mapName, 'beamMap');
  assert.equal(floorGroup.category, MEMBER_CATEGORY.ROD);
  assert.equal(floorGroup.allowManualAdd, false);
  assert.equal(floorGroup.hideWhenEmpty, true);
  const floor = makeBeam('b1', 'WOOD-120x120', { role: 'floor' });
  const primary = makeBeam('b2', 'WOOD-120x120', { role: 'primary' });
  const secondary = makeBeam('b3', 'WOOD-120x120', { role: 'secondary' });
  assert.equal(floorGroup.filter(floor), true);
  assert.equal(floorGroup.filter(primary), false);
  assert.equal(floorGroup.filter(secondary), false);
});

test('【失敗系・3e-2】MEMBER_GROUPS: 「小梁」グループのfilterはrole:floorの梁を対象に含めない', () => {
  const beamSubGroup = MEMBER_GROUPS.find(g => g.key === 'beamSub');
  const floor = makeBeam('b1', 'WOOD-120x120', { role: 'floor' });
  assert.equal(beamSubGroup.filter(floor), false);
});

// ---- ステップ3（2026-09-17裁定）: 在来木造の柱の個別採番（isIndividuallyNumbered/memberGroupKey/memberOrderKey） ----
test('【ステップ3】isIndividuallyNumbered: columnMapは在来木造(numbering.individualColumns==="widthOverride")かつ杭でない木造柱にwoodColumnWidthMmがあるときだけtrue', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const common = makeColumn('c1', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null });
  const individual = makeColumn('c2', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105 });
  const pile = makeColumn('c3', 'WOOD-105x105', { materialType: 'WOOD', role: 'foundation', woodColumnWidthMm: 105 });
  const steel = makeColumn('c4', 'STEEL-SQ200x200x9.0', { materialType: 'STEEL', role: 'standard', woodColumnWidthMm: 105 });
  assert.equal(isIndividuallyNumbered(common, 'columnMap', rules), false, '個別指定の無い柱（共通）はfalse');
  assert.equal(isIndividuallyNumbered(individual, 'columnMap', rules), true, '個別指定した木造柱はtrue');
  assert.equal(isIndividuallyNumbered(pile, 'columnMap', rules), false, '杭（role:foundation）は柱寸法欄の対象外なのでfalse');
  assert.equal(isIndividuallyNumbered(steel, 'columnMap', rules), false, '主構造の材種と違えばfalse');
});

test('【失敗系・QA裁定10・ステップ3】isIndividuallyNumbered: woodColumnWidthMmがカタログ外（正角90/105/120以外。例100）の柱は個別採番の対象にしない（採番は個別・寸法解決は共通というねじれの防止）', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const outOfCatalog = makeColumn('c1', 'WOOD-100x100', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 100 });
  assert.equal(isIndividuallyNumbered(outOfCatalog, 'columnMap', rules), false, 'カタログ外の個別値(100)は個別採番の対象にならない');
});

test('【失敗系・ステップ3】isIndividuallyNumbered: 非在来（individualColumns:null）の主構造は柱にwoodColumnWidthMmがあっても常にfalse', () => {
  for (const structure of ['木造（2"×4"）', 'S造', 'RC造(ラーメン)', UNSPECIFIED_STRUCTURE]) {
    const rules = rulesFor(structure);
    const column = makeColumn('c1', rules.defaultSections.column, { materialType: rules.baseMaterial, role: 'standard', woodColumnWidthMm: 105 });
    assert.equal(isIndividuallyNumbered(column, 'columnMap', rules), false, structure);
  }
});

test('【ステップ3】memberGroupKey: 個別柱は signature#id（部材ごとに一意）、共通柱は signature を共有する', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const commonA = makeColumn('c1', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null });
  const commonB = makeColumn('c2', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null });
  const individualA = makeColumn('c3', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105 });
  const individualB = makeColumn('c4', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105 });
  assert.equal(memberGroupKey(commonA, 'columnMap', rules), memberGroupKey(commonB, 'columnMap', rules), '共通柱は同一署名を共有する');
  assert.notEqual(memberGroupKey(individualA, 'columnMap', rules), memberGroupKey(individualB, 'columnMap', rules), '個別柱は断面が同じでも部材ごとに別グループ');
  assert.equal(memberGroupKey(individualA, 'columnMap', rules), `${memberSignature(individualA, 'columnMap')}#${individualA.id}`);
});

test('【ステップ3】memberOrderKey: columnMapの個別柱はAXIS座標(axisX,axisY。偏心を含まない)を返し、共通柱は空配列', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  // x/y（ACTUAL）はAXISと差をつけて仕込む——memberOrderKeyがAXISを読んでいることを固定する
  // （.claude/structural-model.md「AXISで一致・ACTUALで止める」。B-1・個別柱の偏心）。
  const common = makeColumn('c1', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null, axisX: 100, axisY: 200, x: 999, y: 999 });
  const individual = makeColumn('c2', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105, axisX: 100, axisY: 200, x: 999, y: 999 });
  assert.deepEqual(memberOrderKey(common, 'columnMap', rules), []);
  assert.deepEqual(memberOrderKey(individual, 'columnMap', rules), [100, 200]);
});

test('【失敗系・ステップ3】memberOrderKey: columnMapの個別柱でaxisX/axisY未定義でも例外を投げず[0,0]にフォールバックする', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const individual = makeColumn('c1', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105 });
  assert.doesNotThrow(() => memberOrderKey(individual, 'columnMap', rules));
  assert.deepEqual(memberOrderKey(individual, 'columnMap', rules), [0, 0]);
});

test('【不変条件・ステップ3】MemberListTab.jsx: 柱グループの一覧ソースは columnListCategory(rulesFor(selfStructure).drawing) から解決する（在来木造だけ自階柱□へ切替え）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const categoryFor = group => \(group\.mapName === 'columnMap' \? columnListCategory\(rulesFor\(selfStructure\)\.drawing\) : group\.mapName\);/.test(src),
    'categoryFor が columnListCategory(rulesFor(selfStructure).drawing) から解決していない（一覧ソースを columnMap に戻す回帰）');
  assert.ok(/const resolved = composition\?\.resolveCategory\(categoryFor\(group\)\);/.test(src),
    '柱グループの graph 解決が composition.resolveCategory(categoryFor(group)) を経由していない');
});

test('【不変条件・ステップ4（ユーザー裁定2026-09-17「柱の全体／この部材ボタンを復活」）】MemberListTab.jsx: ColumnWidthScopeSelectのhandleChangeはresolveColumnWidthEditの判定に従いonStructureChangedだけを呼び、setDimensionStatusを呼ばない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const compMatch = /const ColumnWidthScopeSelect = observer\(\(\{ scope, focusedMember, graph, project, readOnly, allowUpsize = false, onStructureChanged, onPendingFocus \}\) => \{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(compMatch, 'ColumnWidthScopeSelect コンポーネント本体が見つからない');
  const fnMatch = /function handleChange\(width\) \{([\s\S]*?)\n {2}\}/.exec(compMatch[1]);
  assert.ok(fnMatch, 'ColumnWidthScopeSelectのhandleChange関数本体が見つからない');
  assert.ok(/const \{ target, value: next \} = resolveColumnWidthEdit\(\{ scope, focusedMember, floorWidth, width \}\);/.test(fnMatch[1]),
    'handleChangeがresolveColumnWidthEdit（structural/columnWidthScope.js）へ委譲していない（書き込み先判定の二重実装回帰）');
  assert.ok(/onStructureChanged\(\(\) => \{\s*graph\.setWoodColumnWidthMm\(next\);\s*normalizeColumnOverridesToFloor\(graph, next\);\s*\}\);/.test(fnMatch[1]),
    'handleChangeが全体（target===\'floor\'）でonStructureChanged経由のgraph.setWoodColumnWidthMm＋normalizeColumnOverridesToFloorを書いていない（QA指摘2026-09-17: 個別＝階の値の禁止状態が復活する回帰）');
  assert.ok(/onStructureChanged\(\(\) => \{ focusedMember\.setField\('woodColumnWidthMm', next\); \}\);/.test(fnMatch[1]),
    'handleChangeがこの部材（target===\'member\'）でonStructureChanged経由のfocusedMember.setFieldを書いていない');
  assert.ok(!fnMatch[1].includes('setDimensionStatus'),
    '個別化時にdimensionStatusを書き換えている（裁定: dimensionStatusは使わない。自動撤去ループ・手動固定の意味と衝突する）');
});

test('【QA指摘2026-09-17・失敗系】MemberListTab.jsx: ColumnWidthScopeSelectのhandleChangeはtarget===nullなら早期returnし、onPendingFocus/onStructureChangedのどちらも呼ばない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const compMatch = /const ColumnWidthScopeSelect = observer\(\(\{ scope, focusedMember, graph, project, readOnly, allowUpsize = false, onStructureChanged, onPendingFocus \}\) => \{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(compMatch, 'ColumnWidthScopeSelect コンポーネント本体が見つからない');
  const fnMatch = /function handleChange\(width\) \{([\s\S]*?)\n {2}\}/.exec(compMatch[1]);
  assert.ok(fnMatch, 'ColumnWidthScopeSelectのhandleChange関数本体が見つからない');
  const lines = fnMatch[1].trim().split('\n').map(l => l.trim());
  assert.ok(/^const \{ target, value: next \} = resolveColumnWidthEdit\(/.test(lines[0]), 'resolveColumnWidthEditの呼び出しが先頭にない');
  assert.equal(lines[1], "if (target === null) return; // 書き込み先が無い（focusedMember不在・未知のscope）→何もしない",
    'target===nullの早期returnが見つからない（このコメント文言込みで固定。onPendingFocus/onStructureChangedを一切呼ばないことを保証する分岐）');
});

test('【不変条件・ステップ4】MemberListTab.jsx: ColumnWidthScopeSelectのthis部材（target==="member"）書き込みはonPendingFocus(focusedMember.id)を先に呼んでから本来のonStructureChangedを呼ぶ（タップした柱の新しいカードへ追従するため。選んだ幅でC1/C2が反転してもここで決め打ちしない）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const compMatch = /const ColumnWidthScopeSelect = observer\(\(\{ scope, focusedMember, graph, project, readOnly, allowUpsize = false, onStructureChanged, onPendingFocus \}\) => \{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(compMatch, 'ColumnWidthScopeSelect コンポーネント本体が見つからない');
  const fnMatch = /function handleChange\(width\) \{([\s\S]*?)\n {2}\}/.exec(compMatch[1]);
  assert.ok(fnMatch, 'ColumnWidthScopeSelectのhandleChange関数本体が見つからない');
  const memberBranchMatch = /\} else if \(target === 'member'\) \{([\s\S]*?)\n {4}\}/.exec(fnMatch[1]);
  assert.ok(memberBranchMatch, "target==='member' の分岐が見つからない");
  const lines = memberBranchMatch[1].trim().split('\n').map(l => l.trim());
  assert.ok(lines[0].startsWith("onPendingFocus?.(focusedMember.id);"), 'onPendingFocusがonStructureChangedより先に呼ばれていない');
});

test('【不変条件・ステップ4】MemberListTab.jsx: ColumnWidthScopeSelectのselectはreadOnlyまたはscope=entityかつfocusedMember不在でdisabledになる', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const disabled = readOnly \|\| \(scope === 'entity' && !focusedMember\);/.test(src),
    'disabled の判定（readOnly または scope=entityかつfocusedMember不在）が見つからない');
  assert.ok(/<select value=\{value\} onChange=\{e => handleChange\(Number\(e\.target\.value\)\)\} disabled=\{disabled\}/.test(src),
    'ColumnWidthScopeSelectのselectがdisabled変数でdisabledされていない');
});

// ---- ステップ4第3単位②（非標準梁の個別採番）: groupKey導出の唯一の入口の不変条件 ----

// structureRules.test.js の scanOffenders と同じ簡易パターン（行コメント落とし・ブロックコメント行頭除外）
// をこのファイル専用に持つ（共有ヘルパへの抽出は本タスクの範囲外）。
function listSourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listSourceFiles(p, out);
    else if (/\.(js|jsx)$/.test(ent.name) && !/\.test\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}
function scanOffenders(pattern, allowed) {
  const srcRoot = path.resolve(import.meta.dirname, '..');
  const offenders = [];
  for (const file of listSourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file).replace(/\\/g, '/');
    if (allowed.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = line.replace(/\/\/.*$/, '');
      if (pattern.test(code)) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
    });
  }
  return offenders;
}

test('【不変条件・QA指摘F7】`numberGroupId ?? memberSignature(` の直書きはどこにも無い（memberCatalog.js自身のmemberGroupKeyの実装もif文でありこのパターンを含まない＝allow-listは空でよい）', () => {
  const offenders = scanOffenders(/numberGroupId\s*\?\?\s*memberSignature\(/, new Set());
  assert.deepEqual(offenders, [], `groupKey導出の直書きが残っている（memberGroupKeyに一本化されていない）:\n${offenders.join('\n')}`);
});

// ---- ステップ4 C-2b QA修正: 新UI配線（WoodColumnWidthSelect・断面欄readOnly）のソース走査不変条件 ----
// QA判定FAIL: 表示条件を消す／ハンドラからconformWoodSectionsを外す／readOnlyからdisabledWhenを外す、
// のいずれも既存テストが全緑のまま通っていた（無防備）。F1/F12と同じ流儀でMemberListTab.jsxのソースを
// 直接検査し、変異させれば必ず落ちるようにする。

test('【不変条件・裁定2026-09-17】MemberListTab.jsx: 在来木造（woodFixedSection）の梁カード（beamMap 全カード）は「適用範囲」と「統合…」を出さず、「削除」は残す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  // ステップ3（2026-09-17）: 柱寸を個別指定できる在来木造の柱カード（woodColumnCard）も梁カードと
  // 同じ理由（適用範囲・統合に意味が無い）でゲートに加わる。
  assert.ok(/const hideScopeAndMerge = \(group\.mapName === 'beamMap' \|\| woodColumnCard\) && fieldCtx\.woodFixedSection;/.test(src),
    'hideScopeAndMerge（beamMap または woodColumnCard かつ在来）の判定が無い');
  assert.ok(/\{!readOnly && !hideScopeAndMerge && \(/.test(src), '「適用範囲」ブロックが hideScopeAndMerge でゲートされていない');
  assert.ok(/\{!mergeModeActiveAnywhere && !hideScopeAndMerge && \(/.test(src), '「統合…」ボタンが hideScopeAndMerge でゲートされていない');
  // 「削除」ボタンは梁カードでは在来でもそのまま出る（hideScopeAndMerge でゲートしない）。
  // 柱カードは共通/個別で表示が分かれるため（下の専用テストで検証）、ここは梁側の不変条件だけを見る。
  assert.ok(/削除\{isIndividualColumn \? '' : `（\$\{members\.length\}件）`\}/.test(src), '「削除」ボタンのラベルが見つからない');
  const delBlock = /\{!\(woodColumnCard && !isIndividualColumn\) && \([\s\S]{0,200}?<button[\s\S]{0,80}?onClick=\{isIndividualColumn \? \(\) => setColumnRevertConfirm\(true\) : onDelete\}/.test(src);
  assert.ok(delBlock, '「削除」ボタンが柱の共通/個別カードでハンドラを分岐していない');
  assert.ok(!/hideScopeAndMerge[\s\S]{0,80}<button[\s\S]{0,80}onDelete/.test(src), '「削除」が hideScopeAndMerge で直接ゲートされている（裁定は梁カードの削除を残す）');
});

test('【不変条件・ステップ3】MemberListTab.jsx: 在来木造の柱カードは共通（woodColumnCard&&!isIndividualColumn）で削除ボタン自体を出さず、個別（isIndividualColumn）は「削除」で共通へ戻す（onRequestDeleteは呼ばない）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const woodColumnCard = group\.mapName === 'columnMap' && fieldCtx\.woodFixedSection && representative\.role !== 'foundation';/.test(src),
    'woodColumnCard の判定が見つからない');
  assert.ok(/const isIndividualColumn = woodColumnCard && isIndividuallyNumbered\(representative, 'columnMap', rulesFor\(structure\)\);/.test(src),
    'isIndividualColumn の判定が見つからない');
  assert.ok(/setColumnRevertConfirm\(true\)/.test(src), '個別柱カードの削除が確認ダイアログ（共通へ戻す）を開いていない');
  const revertMatch = /\{columnRevertConfirm && \([\s\S]{0,600}?onSelect=\{value => \{([\s\S]{0,300}?)\}\}/.exec(src);
  assert.ok(revertMatch, 'columnRevertConfirm の ConfirmDialog が見つからない');
  assert.ok(/onStructureChanged\(\(\) => \{ for \(const m of members\) m\.setField\('woodColumnWidthMm', null\); \}\);/.test(revertMatch[1]),
    '共通へ戻す処理が onStructureChanged 経由で woodColumnWidthMm=null を書いていない');
  assert.ok(!revertMatch[1].includes('onRequestDelete'), '個別柱の「共通に戻す」が onRequestDelete（部材削除）を呼んでいる（裁定: 柱は消えない）');
});

test('【不変条件・ステップ3 QA】MemberListTab.jsx: 削除確認は setDeleteConfirm 時点の graph を保持し、確定時に mapName から再解決しない（柱一覧が自階へ切り替わった後に別階を掴む回帰の防止）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/onRequestDelete=\{\(ids, label\) => setDeleteConfirm\(\{ graph: g, mapName: group\.mapName, ids, label \}\)\}/.test(src),
    'onRequestDelete が setDeleteConfirm へ graph: g を渡していない（旧の mapName だけの保持へ戻す回帰）');
  const confirmBlock = /\{deleteConfirm && \(([\s\S]*?)\n {6}\)\}/.exec(src);
  assert.ok(confirmBlock, 'deleteConfirm の ConfirmDialog ブロックが見つからない');
  assert.ok(/const g = deleteConfirm\.graph;/.test(confirmBlock[1]),
    '削除確定処理が deleteConfirm.graph を使っていない（mapName からの再解決への回帰）');
  assert.ok(!confirmBlock[1].includes('graphForCategory(') && !confirmBlock[1].includes('resolveCategory('),
    '削除確定ブロックが graph を mapName から再解決している（一覧が自階へ切り替わった後は別階を掴む回帰）');
});

test('【不変条件・ステップ3 QA】MemberListTab.jsx: 柱一覧が自階柱□（columnMapSelf）へ切替わった在来木造は、供給階＝主題階なら readOnly にしない（旧のroleForCategoryだけの判定へ戻すと在来の柱一覧全体が閲覧専用になる）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const readOnly = resolved\.spec\.role === LayerRole\.REFERENCE && resolved\.graph\.plane\.id !== composition\.subjectPlane\.id;/.test(src),
    'readOnly が resolved.spec.role/resolved.graph.plane.id から判定されていない（旧のcomposition.roleForCategory(group.mapName)だけの判定への回帰）');
  assert.ok(!/const readOnly = composition\.roleForCategory\(/.test(src),
    '旧の composition.roleForCategory(group.mapName) だけの readOnly 判定が残っている（在来の柱一覧が無言で編集不可になる回帰）');
});

test('【不変条件・ステップ4 C-2b／裁定2026-09-16】MemberListTab.jsx: 「各階柱寸法」欄は一覧の先頭（柱グループの外）に、自階柱□の graph（columnMapSelf）を対象に、在来（columnSizing:"fixed"）かつ非R階のときだけ出て、onStructureChangedが配線されている', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  // 欄の対象は当該階（自階柱□）の graph＝composition.graphForCategory('columnMapSelf')（ユーザー裁定
  // 2026-09-16「柱寸の変更は当該階の柱（□）のみ」）——一覧側の graph（下階柱×）を渡す旧配線への回帰を検出する。
  assert.ok(/const selfColumnGraph = composition\?\.graphForCategory\('columnMapSelf'\) \?\? null;/.test(src),
    'selfColumnGraph が columnMapSelf（自階柱□の供給階）から解決されていない');
  assert.ok(/const woodColumnWidthGraph = \(!isRoofFigure && selfColumnGraph && rulesFor\(selfStructure\)\.columnSizing === 'fixed'\) \? selfColumnGraph : null;/.test(src),
    'woodColumnWidthGraph の表示条件（非R階 && 自階柱graphあり && columnSizing===\'fixed\'）が見つからない');
  assert.ok(/\{woodColumnWidthGraph\s*&&\s*\(/.test(src), '{woodColumnWidthGraph && (...)} の分岐が見つからない');
  assert.ok(/<WoodColumnWidthSelect\s+graph=\{woodColumnWidthGraph\}\s+project=\{project\}\s+onStructureChanged=\{onStructureChanged\}\s*\/>/.test(src),
    '<WoodColumnWidthSelect graph={woodColumnWidthGraph} project={project} onStructureChanged={onStructureChanged} /> の配線が見つからない（実機裁定ステップ4 C-2 QA2: 主構造変更と同じ経路に統一／裁定2026-09-16: 対象は自階）');
  assert.ok(!/<WoodColumnWidthSelect\s+graph=\{graph\}/.test(src), '欄が一覧側の graph（下階柱）を書き換える旧配線が残っている');
  // 欄は柱グループ（MEMBER_GROUPS.map の中＝下階の無い基礎伏図では丸ごと非表示）の外＝一覧の先頭に置く
  // （QA指摘2026-09-16: 柱グループ見出しに置くと最下階の柱寸を変える手段が無くなる）。
  const fieldPos = src.indexOf('<WoodColumnWidthSelect');
  const groupsPos = src.indexOf('{MEMBER_GROUPS.map(group => {');
  assert.ok(fieldPos > 0 && groupsPos > 0 && fieldPos < groupsPos, '「各階柱寸法」欄が MEMBER_GROUPS.map（柱グループ）より前（一覧の先頭）に無い');
  // MemberGroupSection は onStructureChanged を素直に受け取り MemberCard へ引き回す（ステップ3で
  // 個別柱寸セレクトの配線に使うため）が、「各階柱寸法」欄（WoodColumnWidthSelect・graph.setWoodColumnWidthMm）
  // 自体は柱グループ見出しへ戻っていないことを直接検査する（欄はMemberListTab側の一覧の先頭のみに残る）。
  const groupSectionMatch = /const MemberGroupSection = observer\(\(\{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(groupSectionMatch, 'MemberGroupSection コンポーネント本体が見つからない');
  assert.ok(!groupSectionMatch[1].includes('WoodColumnWidthSelect'),
    'MemberGroupSection が WoodColumnWidthSelect を描画している（欄を柱グループ見出しへ戻す回帰）');
  assert.ok(!groupSectionMatch[1].includes('setWoodColumnWidthMm'),
    'MemberGroupSection が graph.setWoodColumnWidthMm を書いている（欄を柱グループ見出しへ戻す回帰）');
  // onStructureChanged が MemberListTab（トップレベル props）→ WoodColumnWidthSelect へ引き回されていること。
  assert.ok(/export const MemberListTab = observer\(\(\{[^}]*\bonStructureChanged\b[^}]*\}\)/.test(src),
    'MemberListTab が onStructureChanged を props として受け取っていない');
});

test('【不変条件・ステップ4 C-2b QA修正／QA指摘2026-09-17】MemberListTab.jsx: WoodColumnWidthSelectの変更ハンドラはonStructureChanged（主構造変更と同じ経路）内でgraph.setWoodColumnWidthMm＋normalizeColumnOverridesToFloorだけを呼び、自前のconformWoodSections/renumberMembers/pushGraphUndoを持たない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const compMatch = /const WoodColumnWidthSelect = observer\(\(\{ graph, project, onStructureChanged \}\) => \{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(compMatch, 'WoodColumnWidthSelect コンポーネント本体（onStructureChangedを受け取る形）が見つからない');
  const fnMatch = /function handleChange\(width\) \{([\s\S]*?)\n {2}\}/.exec(compMatch[1]);
  assert.ok(fnMatch, 'handleChange関数本体が見つからない');
  const body = fnMatch[1];
  // QA指摘2026-09-17: 全体（階の値）を変えたとき、既存の個別指定と偶然同値になった柱を放置すると
  // 「個別＝階の値」の禁止状態が復活する——normalizeColumnOverridesToFloorで正規化する（旧アサーション
  // はgraph.setWoodColumnWidthMm(width)単独呼び出しを固定していたが、この追加呼び出しへ更新した）。
  assert.ok(/onStructureChanged\(\(\) => \{\s*graph\.setWoodColumnWidthMm\(width\);\s*normalizeColumnOverridesToFloor\(graph, width\);\s*\}\);/.test(body),
    'handleChangeがonStructureChanged(() => { graph.setWoodColumnWidthMm(width); normalizeColumnOverridesToFloor(graph, width); })を呼んでいない（QA指摘: 個別＝階の値の禁止状態が復活する回帰）');
  for (const forbidden of ['serializeGraph(', 'conformWoodSections(', 'renumberMembers(', 'pushGraphUndo(']) {
    assert.ok(!body.includes(forbidden),
      `handleChangeに${forbidden}...が残っている（QA指摘: 採番・undoの仕組みをonStructureChanged経由に一本化し、二重に持たない）`);
  }
});

test('【不変条件・ステップ4 C-2b】MemberListTab.jsx: 断面欄（sectionField）のreadOnlyはdisabledWhenを見ており、fieldCtxはwoodFixedSectionを解決して渡す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/readOnly=\{readOnly \|\| !!sectionField\.disabledWhen\?\.\(representative, fieldCtx\)\}/.test(src),
    'sectionField の readOnly が disabledWhen を見ていない（QA指摘: 断面欄が在来木造でも編集可能なまま）');
  assert.ok(/woodFixedSection:\s*rulesFor\(structure\)\.columnSizing\s*===\s*'fixed'/.test(src),
    'fieldCtx.woodFixedSection の解決（rulesFor(structure).columnSizing===\'fixed\'）が見つからない');
});

// ---- ステップ4 C-2b QA修正: standardBeamSectionFor の重複排除（memberNumbering.jsが唯一の実装）----
test('【不変条件・ステップ4 C-2b】woodColumnSectionId(...) ?? ...defaultSections.beam の式は memberNumbering.js 以外に現れない（standardBeamSectionForの複製禁止）', () => {
  const offenders = scanOffenders(/woodColumnSectionId\([^)]*\)\s*\?\?\s*.*defaultSections\.beam/, new Set(['structural/memberNumbering.js']));
  assert.deepEqual(offenders, [], `standardBeamSectionForと同一ロジックの複製が残っている:\n${offenders.join('\n')}`);
});

test('【不変条件・ステップ4 C-2b】MemberListTab.jsxはstandardBeamSectionForをmemberNumbering.jsからimportし、ローカル定義を持たない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/import\s*\{[^}]*\bstandardBeamSectionFor\b[^}]*\}\s*from\s*'\.\/memberNumbering\.js'/.test(src),
    'MemberListTab.jsx が standardBeamSectionFor を memberNumbering.js から import していない');
  assert.ok(!/function\s+standardBeamSection\w*\s*\(/.test(src),
    'MemberListTab.jsx にローカルな standardBeamSection(...) 関数定義が残っている（複製）');
});

test('【不変条件・QA指摘F7】memberGroupKey( の呼び出しが memberNumbering.js と MemberListTab.jsx の両方に存在する（groupKey導出の一本化が実際に配線されている）', () => {
  const numberingSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'memberNumbering.js'), 'utf8');
  const tabSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/memberGroupKey\(/.test(numberingSrc), 'memberNumbering.js に memberGroupKey( の呼び出しが見つからない');
  assert.ok(/memberGroupKey\(/.test(tabSrc), 'MemberListTab.jsx に memberGroupKey( の呼び出しが見つからない');
});

// ---- QA指摘F1（手動タグが個別採番を壊す）: noJoinSignatureFor の純粋部分 ----

test('【QA指摘F1】noJoinSignatureFor: 個別採番対象は「今の署名」を返す（splitGroupのjoinを強制的に抑止するため）', () => {
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const beam = makeBeam('b1', 'WOOD-120x330', { materialType: 'WOOD', role: 'primary' });
  const sig = noJoinSignatureFor(beam, 'beamMap', rules);
  assert.equal(sig, memberSignature(beam, 'beamMap'));
});

test('【不変条件・QA指摘F1】MemberListTab.jsx: 手動タグのmaterialize（commitManualNumber）はsplitGroupへnoJoinSignatureForの戻り値をsplitFromSignatureとして渡す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const fnMatch = /function commitManualNumber\(\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(fnMatch, 'commitManualNumber関数本体が見つからない');
  const body = fnMatch[1];
  assert.ok(/splitGroup\(project, group\.mapName, members, \{/.test(body),
    'splitGroup(project, group.mapName, members, { ... }) の呼び出しが見つからない');
  assert.ok(/splitFromSignature:\s*noJoinSignatureFor\(representative, group\.mapName, rulesFor\(structure\), standardBeamSectionFor\(graph, project, rulesFor\(structure\)\)\)/.test(body),
    'splitFromSignature: noJoinSignatureFor(representative, group.mapName, rulesFor(structure), standardBeamSectionFor(...)) が渡されていない（QA指摘F1の回帰。ステップ4 C-2で標準材が階の柱寸解決子経由になった）');
});

test('【不変条件・QA指摘F12】MemberListTab.jsx: 統合の確定（handleConfirmMerge）はmergeGroupsへnoJoinSignatureForの戻り値をsplitFromSignatureとして渡す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const fnMatch = /function handleConfirmMerge\(chosenIndex\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(fnMatch, 'handleConfirmMerge関数本体が見つからない');
  const body = fnMatch[1];
  assert.ok(/noJoinSignatureFor\(chosenRep, group\.mapName, rulesFor\(structure\), standardBeamSectionFor\(graph, project, rulesFor\(structure\)\)\)/.test(body),
    'noJoinSignatureFor(chosenRep, group.mapName, rulesFor(structure), standardBeamSectionFor(...)) の呼び出しが見つからない（QA指摘F12の回帰。ステップ4 C-2で標準材が階の柱寸解決子経由になった）');
  assert.ok(/mergeGroups\(project, group\.mapName, groups, chosenIndex, \{\s*splitFromSignature\s*\}\)/.test(body),
    'mergeGroups(project, group.mapName, groups, chosenIndex, { splitFromSignature }) の呼び出しが見つからない');
});

test('【不変条件・QA指摘F4\'再発防止】MemberListTab.jsx: composition変更のリセットeffectは「前回見たcomposition」との同一参照比較でガードする（真偽値の初回フラグではない＝StrictModeの二重実行でも安全）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const effectMatch = /useEffect\(\(\) => \{([\s\S]*?)\}, \[composition\]\);/.exec(src);
  assert.ok(effectMatch, "useEffect(() => { ... }, [composition]); が見つからない");
  const body = effectMatch[1];
  // 初回（ref未設定）ガード: if (ref.current === null) { ref.current = composition; return; }
  const initMatch = /if\s*\(\s*(\w+)\.current\s*===\s*null\s*\)\s*\{\s*\1\.current\s*=\s*composition;\s*return;\s*\}/.exec(body);
  assert.ok(initMatch, '初回（ref.current===null）ガードが見つからない（QA指摘F4\'再発の回帰: 真偽値フラグ方式に戻っている）');
  const refVar = initMatch[1];
  // 同一参照ガード: if (composition === ref.current) return;（StrictModeの2回目の実行を吸収する）
  const sameRefRe = new RegExp(`if\\s*\\(\\s*composition\\s*===\\s*${refVar}\\.current\\s*\\)\\s*return;`);
  assert.ok(sameRefRe.test(body), `if (composition === ${refVar}.current) return; が見つからない（同一composition参照での二重実行を弾いていない＝StrictModeで再発する回帰）`);
  // ガードを通過した後（実際に変わったとき）だけ ref を更新してリセットする。
  const updateRe = new RegExp(`${refVar}\\.current\\s*=\\s*composition;\\s*\\n\\s*setMergeState\\(null\\)`);
  assert.ok(updateRe.test(body), `${refVar}.current = composition; の後にsetMergeState(null)が続いていない`);
  assert.ok(/setMergeDialogState\(null\)/.test(body) && /setExpandedKey\(null\)/.test(body),
    'setMergeDialogState/setExpandedKeyのリセットが無い');
  // 「真偽値の初回フラグ」（QA指摘F4'再発の直接原因）が復活していないことも確認する。
  assert.ok(!/if\s*\(\s*!\w+\.current\s*\)\s*\{\s*\w+\.current\s*=\s*true;\s*return;\s*\}/.test(body),
    '真偽値の初回フラグ（if (!ref.current) { ref.current = true; return; }）に戻っている——StrictModeの二重実行で展開が消える回帰');
});

test('【QA指摘F4\'再発防止・純ロジック】composition変更リセットガード: 同一参照での再実行（StrictModeのmount→cleanup→mount相当）はリセットしないが、異なる参照への変化ではリセットする', () => {
  // MemberListTab.jsxのeffect本体と同じ判定ロジックを抽出して検証する（Reactを介さない純ロジック確認）。
  function makeGuardedReset() {
    const ref = { current: null };
    const resets = [];
    return {
      run(composition) {
        if (ref.current === null) { ref.current = composition; return; }
        if (composition === ref.current) return;
        ref.current = composition;
        resets.push(composition);
      },
      resets,
    };
  }
  const compositionA = { id: 'A' };
  const compositionB = { id: 'B' };
  const guarded = makeGuardedReset();

  guarded.run(compositionA); // 初回マウント（1回目）
  guarded.run(compositionA); // StrictModeのmount→cleanup→mountによる2回目の実行（同一参照）
  assert.deepEqual(guarded.resets, [], '初回マウント・StrictModeの二重実行ではリセットが走ってはいけない');

  guarded.run(compositionB); // 実際の階切替・図面合成の組み直し（参照が変わる）
  assert.deepEqual(guarded.resets, [compositionB], 'composition参照が実際に変わったときだけリセットが走るはず');

  guarded.run(compositionB); // 同じcompositionでの再実行（StrictMode相当）はリセットしない
  assert.deepEqual(guarded.resets, [compositionB], '同一参照での再実行は追加でリセットしてはいけない');
});

test('【不変条件・QA指摘F6】MemberListTab.jsx: `\'(未採番)\'` の直書きが残っていない（UNNUMBERED_TAGへ一本化済み）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(!/'\(未採番\)'/.test(src), "'(未採番)' の直書きが残っている（UNNUMBERED_TAGを使っていない箇所がある）");
});

// ---- ユーザー裁定2026-09-17「柱の『全体』『この部材』ボタンを復活」: 柱カードの適用範囲2択・柱寸行の統合 ----

test('【不変条件・ユーザー裁定2026-09-17／QA指摘2026-09-17】MemberListTab.jsx: 在来木造の柱カード（共通・個別とも＝woodColumnCard）は適用範囲「全体」「この部材」の2ボタンだけを出し、「この階」「統合」は出さない。2ボタンは柱専用state（columnScope）を読み書きし、分割UI専用の`scope`は触らない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const blockMatch = /\{!readOnly && woodColumnCard && \(([\s\S]{0,900}?)\n {10}\)\}/.exec(src);
  assert.ok(blockMatch, '柱カードの適用範囲2択ブロック（!readOnly && woodColumnCard でゲート）が見つからない');
  const body = blockMatch[1];
  assert.ok(/<ScopeButton active=\{columnScope === 'all'\} disabled=\{isIndividualColumn\} onClick=\{\(\) => setColumnScope\('all'\)\}>全体<\/ScopeButton>/.test(body),
    '「全体」ボタンがcolumnScope/setColumnScopeを読み書き・isIndividualColumnでdisabledしていない（QA指摘・回帰: 分割UI専用の`scope`と共有すると柱の他フィールド編集で分割経路に迷い込む／ユーザー裁定2026-09-17B: 個別カードは全体を押せない）');
  assert.ok(/<ScopeButton active=\{columnScope === 'entity'\} disabled=\{!columnEntityTarget\} onClick=\{\(\) => setColumnScope\('entity'\)\}>この部材<\/ScopeButton>/.test(body),
    '「この部材」ボタン（columnEntityTarget不在でdisabled）がcolumnScope/setColumnScopeを読み書きしていない');
  assert.ok(!body.includes("この階") && !body.includes('統合'),
    '柱カードの適用範囲ブロックに「この階」または「統合」が残っている（柱では出さない裁定への回帰）');
  // 分割UI専用の`scope`/`setScope`をこのブロックが直接読み書きしていないこと（QA指摘・回帰の再発防止）。
  assert.ok(!/\bsetScope\(/.test(body) && !/\bscope ===/.test(body),
    '柱カードの適用範囲2択が分割UI専用のscope/setScopeを直接読み書きしている（columnScopeへ分離した意味が無くなる回帰）');
});

test('【不変条件・ユーザー裁定2026-09-17】MemberListTab.jsx: 柱寸行は共通・個別で1つに統合され（woodColumnCardでゲート）、ColumnWidthScopeSelectへcolumnScope（scope引数として）/columnEntityTargetを渡す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  // B-1（ユーザー裁定2026-09-17）で柱寸アップcheckbox・偏心方向selectが同じブロックに追加され本文が
  // 伸びたため上限を3000へ拡大（実測約2560文字。従来の900は柱寸行単体のみの時代の値）。
  const rowMatch = /\{woodColumnCard && \(([\s\S]{0,3000}?)\n {10}\)\}/.exec(src);
  assert.ok(rowMatch, '柱寸行（woodColumnCard でゲート）が見つからない');
  const body = rowMatch[1];
  assert.ok(/<ColumnWidthScopeSelect\s*\n\s*scope=\{columnScope\}\s*\n\s*focusedMember=\{columnEntityTarget\}\s*\n\s*graph=\{graph\}\s*\n\s*project=\{project\}\s*\n\s*readOnly=\{readOnly\}\s*\n\s*allowUpsize=\{allowUpsize\}\s*\n\s*onStructureChanged=\{onStructureChanged\}\s*\n\s*onPendingFocus=\{onPendingFocus\}\s*\n\s*\/>/.test(body),
    'ColumnWidthScopeSelect scope={columnScope} focusedMember={columnEntityTarget} ... の配線が見つからない（分割UI専用のscopeを渡す旧配線への回帰）');
  // 旧の個別柱寸専用コンポーネント（共通/個別で別実装を持っていた）が復活していないこと。
  assert.ok(!src.includes('MemberColumnWidthSelect'),
    '旧のMemberColumnWidthSelect（共通/個別で別実装）が残っている（柱寸行の統合が崩れている回帰）');
});

// ---- QA指摘2026-09-17: 柱カードの適用範囲2択が分割UI（commitScopedEdit/splitPreview）の`scope`と
// 混線して番号分割の経路へ迷い込む回帰の修正 ----

test('【不変条件・QA指摘2026-09-17】MemberListTab.jsx: commitScopedEditはwoodColumnCardなら常にmembers全員へ直接適用し、分割経路（resolveSplitTargets等）へ入らない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const fnMatch = /function commitScopedEdit\(mutateFn\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(fnMatch, 'commitScopedEdit関数本体が見つからない');
  assert.ok(/if \(woodColumnCard \|\| scope === 'all'\) \{ mutateFn\(members\); return; \}/.test(fnMatch[1]),
    'commitScopedEditの入口にwoodColumnCardガード（woodColumnCard || scope===\'all\'）が無い（柱カードで上端/下端レベル等を編集すると分割経路に迷い込む回帰）');
});

test('【不変条件・QA指摘2026-09-17】MemberListTab.jsx: splitPreviewはwoodColumnCardなら常にnull（分割プレビューを計算しない）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const splitPreview = \(!readOnly && !woodColumnCard && scope !== 'all'\) \? computeSplitPreview\(resolveSplitTargets\(\)\) : null;/.test(src),
    'splitPreviewの計算条件に!woodColumnCardガードが無い');
});

// ---- コーディネーター指示2026-09-17: 個別カードを一覧から開いても自身の柱寸を編集できる（ステップ3退行の修正） ----

test('【不変条件・コーディネーター指示2026-09-17】MemberListTab.jsx: columnEntityTargetは個別カード（isIndividualColumn）でfocusedMemberが無ければrepresentative（自分自身）にフォールバックし、共通カードはfocusedMemberのみを対象にする', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const columnEntityTarget = isIndividualColumn \? \(focusedMember \?\? representative\) : focusedMember;/.test(src),
    'columnEntityTarget が isIndividualColumn ? (focusedMember ?? representative) : focusedMember で解決されていない（個別カードのrepresentativeフォールバックが無い＝ステップ3退行）');
});

test('【不変条件・コーディネーター指示2026-09-17／QA指摘2026-09-17】MemberListTab.jsx: 柱カードの既定columnScopeはcolumnEntityTargetの有無で決める（columnEntityTargetでない生のfocusedMemberへ戻すと個別カードの既定entity化が壊れる）。分割UI専用のscopeは常に既定"all"のまま', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/if \(isExpanded\) setColumnScope\(woodColumnCard && columnEntityTarget \? 'entity' : 'all'\);/.test(src),
    '既定columnScopeのeffectがwoodColumnCard && columnEntityTargetで判定していない');
  // 分割UI専用のscopeは柱カードの都合で分岐させない（常に'all'固定。QA指摘・回帰の修正2026-09-17）。
  assert.ok(/if \(isExpanded\) setScope\('all'\);/.test(src),
    '分割UI専用のscopeが常に\'all\'固定の既定effectへ戻っていない（柱カード用の分岐が紛れ込む回帰）');
});

// ---- QA裁定・ステップ4: 個別指定直後のカード追従（setPendingFocusId → memberNo確定を待って展開） ----

test('【不変条件・QA裁定】MemberListTab.jsx: pendingFocusIdはselfColumnGraph.columnMap.get(id)?.memberNoの確定（non-null）を観測してcolumnMap:<memberNo>を展開し、pendingを消す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const \[pendingFocusId, setPendingFocusId\] = useState\(null\);/.test(src),
    'pendingFocusId のstate定義が見つからない');
  assert.ok(/const pendingFocusMemberNo = pendingFocusId \? \(selfColumnGraph\?\.columnMap\?\.get\(pendingFocusId\)\?\.memberNo \?\? null\) : null;/.test(src),
    'pendingFocusMemberNo が selfColumnGraph.columnMap.get(pendingFocusId)?.memberNo から解決されていない（下階柱×側や別graphを見る回帰）');
  const effectMatch = /useEffect\(\(\) => \{\s*\n\s*if \(pendingFocusId == null \|\| pendingFocusMemberNo == null\) return;\s*\n\s*setExpandedKey\(`columnMap:\$\{pendingFocusMemberNo\}`\);\s*\n\s*setPendingFocusId\(null\);\s*\n\s*\}, \[pendingFocusId, pendingFocusMemberNo\]\);/.exec(src);
  assert.ok(effectMatch, 'pendingFocus effect（依存配列[pendingFocusId, pendingFocusMemberNo]でsetExpandedKeyしpendingを消す）が見つからない');
});

test('【不変条件・QA裁定】MemberListTab.jsx: onPendingFocus（setPendingFocusId）はMemberGroupSection・MemberCardへそのまま橋渡しされる（新しいpropsを増やしただけで別経路を作らない）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/onPendingFocus=\{setPendingFocusId\}/.test(src), 'MemberListTab→MemberGroupSectionへonPendingFocus={setPendingFocusId}が渡されていない');
  assert.ok(/onPendingFocus=\{onPendingFocus\}/.test(src), 'MemberGroupSection→MemberCardへonPendingFocus={onPendingFocus}が素通しされていない');
});

test('【不変条件・ユーザー裁定2026-09-17】MemberListTab.jsx: ColumnWidthScopeSelectのvalueはscope=entityかつfocusedMemberがあるときだけその柱の解決値（個別??階）、それ以外は階の値', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(/const value = scope === 'entity' && focusedMember \? \(focusedMember\.woodColumnWidthMm \?\? floorWidth\) : floorWidth;/.test(src),
    'ColumnWidthScopeSelectのvalueがscope=entity時に個別値（無ければ階の値）へフォールバックしていない（旧のmembers[0]参照への回帰）');
});

test('【失敗系・QA指摘F1】noJoinSignatureFor: 個別採番対象でなければnull（在来の標準梁・非在来6種＋未定は常に既定のjoin=trueを維持する）', () => {
  const woodRules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const standardBeam = makeBeam('b1', 'WOOD-120x120', { materialType: 'WOOD', role: 'primary' }); // 標準材
  assert.equal(noJoinSignatureFor(standardBeam, 'beamMap', woodRules), null);
  const unspecifiedRules = rulesFor(UNSPECIFIED_STRUCTURE);
  const nonStdOnUnspecified = makeBeam('b2', 'WOOD-120x330', { materialType: 'WOOD', role: 'primary' });
  assert.equal(noJoinSignatureFor(nonStdOnUnspecified, 'beamMap', unspecifiedRules), null, '非在来（未定）は個別採番自体が無い');
  const column = { id: 'c1', materialType: 'RC', sectionDefId: 'RC-300x300', role: 'standard' };
  assert.equal(noJoinSignatureFor(column, 'columnMap', unspecifiedRules), null, '非在来（columnGroupScope="building"）の柱はbeamMap以外なので対象外＝既定のjoin=trueを維持する');
});

// ---- ステップA（2026-09-17裁定）: 在来木造は柱の採番グループを階ごとに分ける（columnGroupScope） ----
// QA裁定（同日・joinは階スコープで残す）: noJoinSignatureForでの在来columnMapの全面抑止（共通柱も
// join=false）は撤回した——在来木造の柱は壁交点から毎回自動生成されるため、手動タグ後に合流自体を
// 止めると実害がある（同じ階の後発同寸柱が別グループのまま残る）。共通柱のjoin可否判定は非在来と
// 同じ（常にjoin=true）に戻し、他階への波及だけをjoinSignatureFor（@planeId付き）で遮断する。
test('【ステップA・QA裁定2026-09-17】noJoinSignatureFor: 在来木造（columnGroupScope==="floor"）でも共通柱はnullを返す（join=trueのまま。全面抑止の撤回）。個別柱は従来どおり「今の署名」でjoin=falseを強制する', () => {
  const woodRules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const common = makeColumn('c1', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null });
  const individual = makeColumn('c2', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105 });
  assert.equal(noJoinSignatureFor(common, 'columnMap', woodRules), null,
    '共通柱はjoin=trueのまま（在来木造は壁交点から毎回自動生成されるため、合流自体を止めてはいけない）');
  assert.equal(noJoinSignatureFor(individual, 'columnMap', woodRules), memberSignature(individual, 'columnMap'),
    '個別採番対象（1本1タグ）は従来どおりjoin=falseを強制する');
});

test('【ステップA・QA裁定2026-09-17】joinSignatureFor: 在来木造のcolumnMapは共通・個別いずれもsignatureに`@<planeId>`を付ける（他階への波及を遮断）。それ以外（非在来・非columnMap・planeId省略）はsignatureのまま', () => {
  const woodRules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const common = makeColumn('c1', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null });
  const individual = makeColumn('c2', 'WOOD-105x105', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: 105 });
  const sigCommon = memberSignature(common, 'columnMap');
  const sigIndividual = memberSignature(individual, 'columnMap');
  assert.equal(joinSignatureFor(common, 'columnMap', woodRules, 'p1'), `${sigCommon}@p1`);
  assert.equal(joinSignatureFor(individual, 'columnMap', woodRules, 'p1'), `${sigIndividual}@p1`);
  assert.equal(joinSignatureFor(common, 'columnMap', woodRules), sigCommon, 'planeId省略時はsignatureのまま（後方互換）');
  const unspecifiedRules = rulesFor(UNSPECIFIED_STRUCTURE);
  assert.equal(joinSignatureFor(common, 'columnMap', unspecifiedRules, 'p1'), sigCommon, '非在来（columnGroupScope="building"）はplaneId指定時もsignatureのまま');
  const beam = makeBeam('b1', 'WOOD-120x120', { materialType: 'WOOD', role: 'primary' });
  assert.equal(joinSignatureFor(beam, 'beamMap', woodRules, 'p1'), memberSignature(beam, 'beamMap'), 'beamMapはcolumnGroupScopeの対象外＝planeIdを付与しない');
});

test('【失敗系・ステップA】memberGroupKey: columnMapはrules.numbering.columnGroupScope==="floor"かつplaneId指定時だけ`@<planeId>`を付ける（省略時・非在来・非columnMapは付けない＝signature自体は不変）', () => {
  const woodRules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const common = makeColumn('c1', 'WOOD-120x120', { materialType: 'WOOD', role: 'standard', woodColumnWidthMm: null });
  const sig = memberSignature(common, 'columnMap');
  assert.equal(memberGroupKey(common, 'columnMap', woodRules), sig, 'planeId省略時は従来どおりsignatureのまま（後方互換）');
  assert.equal(memberGroupKey(common, 'columnMap', woodRules, undefined, 'p1'), `${sig}@p1`, 'planeId指定時は@planeIdを付与する');
  const unspecifiedRules = rulesFor(UNSPECIFIED_STRUCTURE);
  assert.equal(memberGroupKey(common, 'columnMap', unspecifiedRules, undefined, 'p1'), sig, '非在来（columnGroupScope="building"）はplaneId指定時も付与しない');
  const beam = makeBeam('b1', 'WOOD-120x120', { materialType: 'WOOD', role: 'primary' });
  assert.equal(memberGroupKey(beam, 'beamMap', woodRules, undefined, 'p1'), memberSignature(beam, 'beamMap'), 'beamMapはcolumnGroupScopeの対象外＝planeIdを付与しない');
});
