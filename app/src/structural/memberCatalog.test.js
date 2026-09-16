// memberCatalog.js（WP-B1: 踊り場受け梁 role:'landing' の受け入れ）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  memberSymbol, MEMBER_GROUPS, NUMBERED_MAPS, FIELD_DEFS_BY_CATEGORY, SIGNATURE_FIELDS_BY_MAP, MEMBER_CATEGORY,
  noJoinSignatureFor, memberSignature,
} from './memberCatalog.js';
import { makeBeam } from './memberTestFixtures.js';
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
  assert.ok(/splitFromSignature:\s*noJoinSignatureFor\(representative, group\.mapName, rulesFor\(structure\)\)/.test(body),
    'splitFromSignature: noJoinSignatureFor(representative, group.mapName, rulesFor(structure)) が渡されていない（QA指摘F1の回帰）');
});

test('【不変条件・QA指摘F12】MemberListTab.jsx: 統合の確定（handleConfirmMerge）はmergeGroupsへnoJoinSignatureForの戻り値をsplitFromSignatureとして渡す', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  const fnMatch = /function handleConfirmMerge\(chosenIndex\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(fnMatch, 'handleConfirmMerge関数本体が見つからない');
  const body = fnMatch[1];
  assert.ok(/noJoinSignatureFor\(chosenRep, group\.mapName, rulesFor\(structure\)\)/.test(body),
    'noJoinSignatureFor(chosenRep, group.mapName, rulesFor(structure)) の呼び出しが見つからない（QA指摘F12の回帰）');
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
