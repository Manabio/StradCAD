import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKindTabs, buildMaterialRows, collectKnownMaterialCodes, nextMaterialCode,
  buildMaterialEntry, duplicateMaterialEntry, validateMaterialEntry,
  upsertUserMaterialEntry, removeUserMaterialEntry, buildUserMaterialBundle, commitUserEntries,
  isEditableMaterialCategory, MATERIAL_CATEGORY, canEditMaterialRow, parseThicknessInput,
} from './catalogMaintenance.js';
import { setOverlay, clearOverlays, overlayFor } from './catalogRegistry.js';
import { CatalogKind } from './catalogKinds.js';

test.afterEach(() => clearOverlays());

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901',
    x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- buildKindTabs ----
test('buildKindTabs: listKinds()から導出し、material以外はenabled:false', () => {
  const tabs = buildKindTabs();
  const materialTab = tabs.find(t => t.kind === CatalogKind.MATERIAL);
  assert.equal(materialTab.enabled, true);
  assert.equal(materialTab.label, '材料');
  const others = tabs.filter(t => t.kind !== CatalogKind.MATERIAL);
  assert.ok(others.length > 0);
  assert.ok(others.every(t => t.enabled === false));
});

// ---- buildMaterialRows: 一覧の合成（出所付き）----
test('buildMaterialRows: builtin・doc・userを合成し出所を付ける', () => {
  const builtin = [material({ code: '301000000001', name: 'A' })];
  setOverlay(CatalogKind.MATERIAL, {
    doc:  [material({ code: '301000000002', name: 'B(doc)' })],
    user: [material({ code: '301000000003', name: 'C(user)' })],
  });
  const rows = buildMaterialRows({ builtinList: builtin });
  const byCode = new Map(rows.map(r => [r.entry.code, r.origin]));
  assert.equal(byCode.get('301000000001'), 'builtin');
  assert.equal(byCode.get('301000000002'), 'doc');
  assert.equal(byCode.get('301000000003'), 'user');
});

test('buildMaterialRows: search（名称部分一致・大小文字区別なし）で絞り込む', () => {
  const builtin = [
    material({ code: '301000000001', name: 'せっこうボード t=9.5' }),
    material({ code: '301000000002', name: 'Plywood Panel' }),
  ];
  const rows = buildMaterialRows({ builtinList: builtin, search: 'plywood' });
  assert.deepEqual(rows.map(r => r.entry.code), ['301000000002']);
});

test('buildMaterialRows: categoryで絞り込む（backingは表示のみ・除外指定可能）', () => {
  const builtin = [
    material({ code: '301000000001', category: 'panel', name: '材A' }),
    material({ code: '301000000002', category: 'finish', name: '材B' }),
    material({ code: '201000000001', category: 'backing', name: '材C' }),
  ];
  const panelOnly = buildMaterialRows({ builtinList: builtin, category: 'panel' });
  assert.deepEqual(panelOnly.map(r => r.entry.code), ['301000000001']);

  const all = buildMaterialRows({ builtinList: builtin });
  assert.equal(all.length, 3); // backingも一覧には出る（編集不可なだけ）
});

// ---- collectKnownMaterialCodes / nextMaterialCode: 採番 ----
test('collectKnownMaterialCodes→nextMaterialCode: builtin・user・docすべてを使用済みとして避ける', () => {
  const known = collectKnownMaterialCodes({
    builtinList: [material({ code: '102000000001' })],
    user:        [material({ code: '102000000002' })],
    doc:         [material({ code: '102000000003' })],
  });
  assert.equal(nextMaterialCode(10, 20, known), '102000000004');
});

test('nextMaterialCode: 使用が無ければ1番から', () => {
  const known = collectKnownMaterialCodes({ builtinList: [] });
  assert.equal(nextMaterialCode(30, 10, known), '301000000001');
});

// ---- validateMaterialEntry: 失敗メッセージ・R17・category制限 ----
test('validateMaterialEntry: panel/finish以外のcategoryは追加不可（日本語メッセージ）', () => {
  const entry = buildMaterialEntry({ code: '201000000099', name: 'テスト', category: 'backing' });
  const result = validateMaterialEntry(entry, []);
  assert.equal(result.ok, false);
  assert.match(result.message, /面材・仕上げ材のみ/);
});

test('validateMaterialEntry: kindDef.validate失敗（name欠落）は日本語メッセージを返す', () => {
  const entry = buildMaterialEntry({ code: '301000000099', name: '', category: 'panel' });
  const result = validateMaterialEntry(entry, []);
  assert.equal(result.ok, false);
  assert.match(result.message, /nameが不正/);
});

test('【失敗系】validateMaterialEntry: R17（dedupeFields完全一致）の重複は拒否する', () => {
  const builtin = [material({ code: '301000000001', name: '同名材', spec: 'S', thickness: 10 })];
  const dup = buildMaterialEntry({ code: '301000000002', name: '同名材', spec: 'S', thickness: 10, category: 'panel' });
  const result = validateMaterialEntry(dup, builtin);
  assert.equal(result.ok, false);
  assert.match(result.message, /既に登録されています/);
});

test('validateMaterialEntry: 内容が違えば重複にならず通る', () => {
  const builtin = [material({ code: '301000000001', name: '材A' })];
  const entry = buildMaterialEntry({ code: '301000000002', name: '材B', spec: 'X', thickness: 5, category: 'finish' });
  const result = validateMaterialEntry(entry, builtin);
  assert.deepEqual(result, { ok: true });
});

// ---- duplicateMaterialEntry: 新コードで同内容→保存前はR17に引っかかる ----
test('duplicateMaterialEntry: 複製元と同じ大分類・中分類の新コードで、内容は同一', () => {
  const source = material({ code: '301000000001', name: '元材' });
  const known = collectKnownMaterialCodes({ builtinList: [source] });
  const copy = duplicateMaterialEntry(source, known);
  assert.notEqual(copy.code, source.code);
  assert.equal(copy.code.slice(0, 4), source.code.slice(0, 4)); // major+minor帯は同じ
  assert.equal(copy.name, source.name);
  assert.equal(copy.spec, source.spec);
  assert.equal(copy.thickness, source.thickness);
});

test('【失敗系】duplicateMaterialEntry: 複製直後は名称等が同一のためvalidateMaterialEntryがR17で拒否する（名称を変えるまで保存不可）', () => {
  const source = material({ code: '301000000001', name: '元材' });
  const known = collectKnownMaterialCodes({ builtinList: [source] });
  const copy = duplicateMaterialEntry(source, known);
  const result = validateMaterialEntry(copy, [source]);
  assert.equal(result.ok, false);
  assert.match(result.message, /既に登録されています/);
});

test('duplicateMaterialEntry: 名称を変えればvalidateMaterialEntryを通る', () => {
  const source = material({ code: '301000000001', name: '元材' });
  const known = collectKnownMaterialCodes({ builtinList: [source] });
  const copy = { ...duplicateMaterialEntry(source, known), name: '元材（複製）' };
  const result = validateMaterialEntry(copy, [source]);
  assert.deepEqual(result, { ok: true });
});

test('【失敗系】duplicateMaterialEntry: 複製元のcodeが不正なら例外', () => {
  assert.throws(() => duplicateMaterialEntry({ code: 'x' }, new Set()), /複製元の材料コードが不正/);
});

// ---- upsertUserMaterialEntry / removeUserMaterialEntry: 削除はuserだけ ----
test('upsertUserMaterialEntry: 新規コードは追加、既存コードは上書き', () => {
  const user = [material({ code: '301000000001', name: '旧' })];
  const added = upsertUserMaterialEntry(user, material({ code: '301000000002', name: '新' }));
  assert.equal(added.length, 2);
  const updated = upsertUserMaterialEntry(user, material({ code: '301000000001', name: '更新後' }));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].name, '更新後');
});

test('removeUserMaterialEntry: origin===\'user\'なら外せる', () => {
  const user = [material({ code: '301000000001' }), material({ code: '301000000002' })];
  const next = removeUserMaterialEntry(user, '301000000001', 'user');
  assert.deepEqual(next.map(e => e.code), ['301000000002']);
});

test('【失敗系】removeUserMaterialEntry: origin===\'builtin\'は削除不可（例外）', () => {
  const user = [material({ code: '301000000001' })];
  assert.throws(() => removeUserMaterialEntry(user, '301000000001', 'builtin'), /削除できません/);
});

test('【失敗系】removeUserMaterialEntry: origin===\'doc\'は削除不可（例外。文書同梱分は参照が無くなるまで残る）', () => {
  const user = [material({ code: '301000000001' })];
  assert.throws(() => removeUserMaterialEntry(user, '301000000001', 'doc'), /削除できません/);
});

// ---- buildUserMaterialBundle: catalogOverlayLoader.jsが読む形と一致 ----
test('buildUserMaterialBundle: {version,catalogs:{material:[...]},encodings:{material:\'json\'},aliases:{}}の形になる', () => {
  const entries = [material({ code: '301000000001' })];
  const bundle = buildUserMaterialBundle(entries);
  assert.deepEqual(bundle, {
    version: 1,
    catalogs: { material: entries },
    encodings: { material: 'json' },
    aliases: {},
  });
});

// ---- commitUserEntries（QA指摘Minor・再指摘: .jsxから移設。saveFnは注入されるDI型）----
test('commitUserEntries: saveFnがresolveすればoverlayはnextUserのまま', async () => {
  const prevUser = [material({ code: '301000000001' })];
  const docEntries = [material({ code: '301000000099', category: 'finish' })];
  setOverlay(CatalogKind.MATERIAL, { doc: docEntries, user: prevUser });
  const nextUser = [material({ code: '301000000001' }), material({ code: '301000000002', name: '新規' })];

  const calls = [];
  const saveFn = async (kind, bytes) => { calls.push({ kind, bytes }); };
  await commitUserEntries(nextUser, prevUser, { saveFn });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, CatalogKind.MATERIAL);
  assert.ok(calls[0].bytes instanceof Uint8Array);
  const overlay = overlayFor(CatalogKind.MATERIAL);
  assert.deepEqual(overlay.user, nextUser);
  assert.deepEqual(overlay.doc, docEntries); // docは触らない
});

test('【失敗系】commitUserEntries: saveFnがrejectしたらoverlayはprevUserへ戻り、rejectが伝播する（変異=ロールバック除去で赤になる）', async () => {
  const prevUser = [material({ code: '301000000001' })];
  setOverlay(CatalogKind.MATERIAL, { doc: [], user: prevUser });
  const nextUser = [material({ code: '301000000001' }), material({ code: '301000000002', name: '新規' })];

  const saveFn = async () => { throw new Error('IDB書込み失敗'); };
  await assert.rejects(() => commitUserEntries(nextUser, prevUser, { saveFn }), /IDB書込み失敗/);

  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).user, prevUser); // ロールバック済み
});

// ---- isEditableMaterialCategory ----
test('isEditableMaterialCategory: panel/finishはtrue、backingはfalse', () => {
  assert.equal(isEditableMaterialCategory(MATERIAL_CATEGORY.PANEL), true);
  assert.equal(isEditableMaterialCategory(MATERIAL_CATEGORY.FINISH), true);
  assert.equal(isEditableMaterialCategory(MATERIAL_CATEGORY.BACKING), false);
  assert.equal(isEditableMaterialCategory(undefined), false);
});

// ---- canEditMaterialRow（QA指摘Major-A）: builtin/doc/backingは不可、userのpanel/finishのみ可 ----
test('canEditMaterialRow: originがuserでcategoryがpanel/finishならok:true', () => {
  assert.deepEqual(canEditMaterialRow('user', MATERIAL_CATEGORY.PANEL), { ok: true, reason: null });
  assert.deepEqual(canEditMaterialRow('user', MATERIAL_CATEGORY.FINISH), { ok: true, reason: null });
});

test('canEditMaterialRow: 新規追加（originがnull/undefined）はcategoryがpanel/finishならok:true', () => {
  assert.equal(canEditMaterialRow(null, MATERIAL_CATEGORY.PANEL).ok, true);
  assert.equal(canEditMaterialRow(undefined, MATERIAL_CATEGORY.FINISH).ok, true);
});

test('【失敗系】canEditMaterialRow: originがbuiltinなら不可', () => {
  const result = canEditMaterialRow('builtin', MATERIAL_CATEGORY.PANEL);
  assert.equal(result.ok, false);
  assert.match(result.reason, /標準材料の編集は未対応/);
});

test('【失敗系・QA指摘Major-A】canEditMaterialRow: originがdocなら不可（複製してから編集する）', () => {
  const result = canEditMaterialRow('doc', MATERIAL_CATEGORY.FINISH);
  assert.equal(result.ok, false);
  assert.match(result.reason, /文書同梱の材料の編集は未対応です。複製してから編集してください/);
});

test('【失敗系】canEditMaterialRow: categoryがbackingならoriginに関わらず不可', () => {
  assert.equal(canEditMaterialRow('user', MATERIAL_CATEGORY.BACKING).ok, false);
  assert.equal(canEditMaterialRow('doc', MATERIAL_CATEGORY.BACKING).ok, false);
  assert.equal(canEditMaterialRow('builtin', MATERIAL_CATEGORY.BACKING).ok, false);
});

// ---- parseThicknessInput（QA指摘Minor1）----
test('parseThicknessInput: 空文字はnull', () => {
  assert.equal(parseThicknessInput(''), null);
});

test('【失敗系・QA指摘Minor1】parseThicknessInput: 空白だけの入力はnull（Number(\'  \')===0への退行を検知）', () => {
  assert.equal(parseThicknessInput('  '), null);
  assert.equal(parseThicknessInput('\t\n'), null);
});

test('parseThicknessInput: 前後の空白を除いた数値文字列は数値になる', () => {
  assert.equal(parseThicknessInput('  9.5  '), 9.5);
  assert.equal(parseThicknessInput('0'), 0);
});

test('【失敗系】parseThicknessInput: 数値でない文字列はNaN', () => {
  assert.ok(Number.isNaN(parseThicknessInput('abc')));
});

// ---- buildMaterialEntry: name/spec/noteをtrimする（QA指摘Minor3。責任を1箇所に寄せる）----
test('buildMaterialEntry: name/spec/noteの前後の空白を除く', () => {
  const entry = buildMaterialEntry({
    code: '301000000001', name: '  材A  ', spec: '  S  ', note: '  備考  ', category: 'panel',
  });
  assert.equal(entry.name, '材A');
  assert.equal(entry.spec, 'S');
  assert.equal(entry.note, '備考');
});
