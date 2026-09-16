// memberCatalog.js（WP-B1: 踊り場受け梁 role:'landing' の受け入れ）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  memberSymbol, MEMBER_GROUPS, NUMBERED_MAPS, FIELD_DEFS_BY_CATEGORY, SIGNATURE_FIELDS_BY_MAP, MEMBER_CATEGORY,
  noJoinSignatureFor, memberSignature,
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
  assert.ok(/const hideScopeAndMerge = group\.mapName === 'beamMap' && fieldCtx\.woodFixedSection;/.test(src),
    'hideScopeAndMerge（beamMap かつ在来）の判定が無い');
  assert.ok(/\{!readOnly && !hideScopeAndMerge && \(/.test(src), '「適用範囲」ブロックが hideScopeAndMerge でゲートされていない');
  assert.ok(/\{!mergeModeActiveAnywhere && !hideScopeAndMerge && \(/.test(src), '「統合…」ボタンが hideScopeAndMerge でゲートされていない');
  // 「削除」ボタンは在来でもそのまま（hideScopeAndMerge でゲートしない）。
  assert.ok(/<button onClick=\{onDelete\} style=\{deleteButtonStyle\}>削除/.test(src), '「削除」ボタンが見つからない');
  const delLine = src.split('\n').find(l => /onClick=\{onDelete\}/.test(l)) ?? '';
  assert.ok(!/hideScopeAndMerge/.test(delLine), '「削除」が hideScopeAndMerge でゲートされている（裁定は削除を残す）');
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
  assert.ok(!/const MemberGroupSection = observer\(\(\{[\s\S]{0,600}?\bonStructureChanged\b/.test(src),
    'MemberGroupSection が onStructureChanged を受け取っている（欄を柱グループ見出しへ戻す回帰の兆候）');
  // onStructureChanged が MemberListTab（トップレベル props）→ WoodColumnWidthSelect へ引き回されていること。
  assert.ok(/export const MemberListTab = observer\(\(\{[^}]*\bonStructureChanged\b[^}]*\}\)/.test(src),
    'MemberListTab が onStructureChanged を props として受け取っていない');
});

test('【不変条件・ステップ4 C-2b QA修正】MemberListTab.jsx: WoodColumnWidthSelectの変更ハンドラはonStructureChanged（主構造変更と同じ経路）だけを呼び、自前のconformWoodSections/renumberMembers/pushGraphUndoを持たない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const compMatch = /const WoodColumnWidthSelect = observer\(\(\{ graph, project, onStructureChanged \}\) => \{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(compMatch, 'WoodColumnWidthSelect コンポーネント本体（onStructureChangedを受け取る形）が見つからない');
  const fnMatch = /function handleChange\(width\) \{([\s\S]*?)\n {2}\}/.exec(compMatch[1]);
  assert.ok(fnMatch, 'handleChange関数本体が見つからない');
  const body = fnMatch[1];
  assert.ok(/onStructureChanged\(\(\) => \{\s*graph\.setWoodColumnWidthMm\(width\);\s*\}\);/.test(body),
    'handleChangeがonStructureChanged(() => { graph.setWoodColumnWidthMm(width); })を呼んでいない（QA指摘: 主構造変更と同じ経路に統一）');
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

test('【失敗系・QA指摘F1】noJoinSignatureFor: 個別採番対象でなければnull（在来の標準材・非在来6種＋未定・柱等は常に既定のjoin=trueを維持する）', () => {
  const woodRules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const standardBeam = makeBeam('b1', 'WOOD-120x120', { materialType: 'WOOD', role: 'primary' }); // 標準材
  assert.equal(noJoinSignatureFor(standardBeam, 'beamMap', woodRules), null);
  const unspecifiedRules = rulesFor(UNSPECIFIED_STRUCTURE);
  const nonStdOnUnspecified = makeBeam('b2', 'WOOD-120x330', { materialType: 'WOOD', role: 'primary' });
  assert.equal(noJoinSignatureFor(nonStdOnUnspecified, 'beamMap', unspecifiedRules), null, '非在来（未定）は個別採番自体が無い');
  const column = { id: 'c1', materialType: 'RC', sectionDefId: 'RC-300x300', role: 'standard' };
  assert.equal(noJoinSignatureFor(column, 'columnMap', woodRules), null, '柱（beamMap以外）は対象外');
});
