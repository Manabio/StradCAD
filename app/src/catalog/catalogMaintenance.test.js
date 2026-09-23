import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKindTabs, buildMaterialRows, buildCatalogRows, collectKnownMaterialCodes, nextMaterialCode,
  buildMaterialEntry, duplicateMaterialEntry, validateMaterialEntry,
  upsertUserMaterialEntry, removeUserMaterialEntry, buildUserMaterialBundle, commitUserEntries,
  isEditableMaterialCategory, MATERIAL_CATEGORY, canEditMaterialRow, parseThicknessInput,
  planRealign, realignTargets, planBulkSectionImport,
} from './catalogMaintenance.js';
import { setOverlay, clearOverlays, overlayFor, docDiffMap } from './catalogRegistry.js';
import { CatalogKind } from './catalogKinds.js';
import { parseSectionSpecList } from '../structural/sectionCatalog.js';

test.afterEach(() => clearOverlays());

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901',
    x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- buildKindTabs ----
test('buildKindTabs: listKinds()から導出し、material・interiorMaster・boundaryMaster・sectionはenabled:true（閲覧のみ。ステップ7d・8h）、openingSubTypeはenabled:false', () => {
  const tabs = buildKindTabs();
  const materialTab = tabs.find(t => t.kind === CatalogKind.MATERIAL);
  assert.equal(materialTab.enabled, true);
  assert.equal(materialTab.label, '材料');
  const interiorTab = tabs.find(t => t.kind === CatalogKind.INTERIOR_MASTER);
  assert.equal(interiorTab.enabled, true);
  assert.equal(interiorTab.label, '内装マスター');
  const boundaryTab = tabs.find(t => t.kind === CatalogKind.BOUNDARY_MASTER);
  assert.equal(boundaryTab.enabled, true);
  assert.equal(boundaryTab.label, '境界マスター');
  const sectionTab = tabs.find(t => t.kind === CatalogKind.SECTION);
  assert.equal(sectionTab.enabled, true);
  assert.equal(sectionTab.label, '断面');
  const notYet = tabs.filter(t => t.kind === CatalogKind.OPENING_SUB_TYPE);
  assert.ok(notYet.length > 0);
  assert.ok(notYet.every(t => t.enabled === false));
});

// ---- buildCatalogRows（ステップ7d: buildMaterialRowsの一般化。3種別）----
test('buildCatalogRows: kind:interiorMasterでも出所・searchが効く', () => {
  const builtin = [
    { key: 'LIVING_ROOM', label: 'リビング', wallMaterial: 'クロス', wallFinish: 'AEP', ceilingHeight: 2400 },
    { key: 'BEDROOM', label: '寝室', wallMaterial: 'クロス', wallFinish: 'AEP', ceilingHeight: 2400 },
  ];
  setOverlay(CatalogKind.INTERIOR_MASTER, {
    user: [{ key: 'USER_ROOM', label: 'ユーザー部屋', wallMaterial: 'クロス', wallFinish: 'AEP', ceilingHeight: 2400 }],
  });
  const rows = buildCatalogRows({ kind: CatalogKind.INTERIOR_MASTER, builtinList: builtin });
  const byKey = new Map(rows.map(r => [r.entry.key, r.origin]));
  assert.equal(byKey.get('LIVING_ROOM'), 'builtin');
  assert.equal(byKey.get('USER_ROOM'), 'user');

  const filtered = buildCatalogRows({ kind: CatalogKind.INTERIOR_MASTER, builtinList: builtin, search: 'リビング' });
  assert.deepEqual(filtered.map(r => r.entry.key), ['LIVING_ROOM']);
});

// ---- buildCatalogRows: search（ステップ8h・断面のkey検索）----
test('buildCatalogRows: kind:sectionでsearchはlabel（呼称）にもkey（識別子）にも一致する', () => {
  const builtin = [
    { key: 'STEEL-H200x100', materialType: 'STEEL', shape: 'hSection', width: 100, height: 200, webThickness: 5.5, flangeThickness: 8, label: 'H-200×100×5.5×8' },
    { key: 'STEEL-SQ150x150x6.0', materialType: 'STEEL', shape: 'squarePipe', width: 150, height: 150, wallThickness: 6, label: '□-150×150×6.0' },
  ];
  // labelには含まれない語（"H-200"のハイフンを含まない"H200"）でも、keyに含まれていれば当たる。
  const byKey = buildCatalogRows({ kind: CatalogKind.SECTION, builtinList: builtin, search: 'H200' });
  assert.deepEqual(byKey.map(r => r.entry.key), ['STEEL-H200x100']);

  const byLabel = buildCatalogRows({ kind: CatalogKind.SECTION, builtinList: builtin, search: '150×150' });
  assert.deepEqual(byLabel.map(r => r.entry.key), ['STEEL-SQ150x150x6.0']);
});

test('buildCatalogRows: kind:boundaryMasterでdiffMapを渡すと差分情報が付く', () => {
  const builtin = [{ key: 'EXTERIOR_WALL', label: '外壁', kind: 'layered', layers: [] }];
  setOverlay(CatalogKind.BOUNDARY_MASTER, {
    // compareFields=['kind','layers','derivedFrom','fields']（labelは含まない）— layersを変えて差分を作る
    doc: [{ key: 'EXTERIOR_WALL', label: '外壁', kind: 'layered', layers: [{ role: '外壁材', code: null }] }],
  });
  const diffMap = docDiffMap(CatalogKind.BOUNDARY_MASTER, builtin);
  const rows = buildCatalogRows({ kind: CatalogKind.BOUNDARY_MASTER, builtinList: builtin, diffMap });
  assert.ok(rows[0].diff, '差分のある行はdiffが付く');
});

// ---- buildMaterialRows: buildCatalogRows(kind:material)の薄いラッパ。一覧の合成（出所付き）----
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

// ---- buildMaterialRows: R13 diffMap（ステップ6-2） ----
test('buildMaterialRows: diffMapを渡すと各行に差分情報(diff)が付く。無ければnull', () => {
  const builtin = [
    material({ code: '301000000001', name: 'A' }),
    material({ code: '301000000002', name: 'B' }),
  ];
  setOverlay('material', { doc: [material({ code: '301000000002', name: 'B(doc)' })] });
  const diffMap = docDiffMap('material', builtin);
  const rows = buildMaterialRows({ builtinList: builtin, diffMap });
  const byCode = new Map(rows.map(r => [r.entry.code, r.diff]));
  assert.equal(byCode.get('301000000001'), null, '差分の無い行はnull');
  assert.ok(byCode.get('301000000002'), '差分のある行はdiffが付く');
  assert.deepEqual(byCode.get('301000000002').diffFields, ['name']);
});

test('buildMaterialRows: diffMapを渡さなければ全行diff:null（省略時の既定）', () => {
  const builtin = [material({ code: '301000000001', name: 'A' })];
  const rows = buildMaterialRows({ builtinList: builtin });
  assert.equal(rows[0].diff, null);
});

// ---- realignTargets（ステップ6b Minor-1: 一括「合わせ直す」対象の絞り込みを切り出し）----
test('realignTargets: diffが付いている行だけを返す（変異=filter除去/条件反転で赤）', () => {
  const rows = [
    { entry: { code: 'A' }, origin: 'doc', diff: { diffFields: ['name'] } },
    { entry: { code: 'B' }, origin: 'user', diff: null },
    { entry: { code: 'C' }, origin: 'doc', diff: { diffFields: ['thickness'] } },
  ];
  assert.deepEqual(realignTargets(rows).map(r => r.entry.code), ['A', 'C']);
});

test('realignTargets: diffの行が1つも無ければ空配列', () => {
  const rows = [
    { entry: { code: 'A' }, origin: 'builtin', diff: null },
    { entry: { code: 'B' }, origin: 'user', diff: null },
  ];
  assert.deepEqual(realignTargets(rows), []);
});

test('realignTargets: 空配列を渡せば空配列', () => {
  assert.deepEqual(realignTargets([]), []);
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
  await commitUserEntries(CatalogKind.MATERIAL, nextUser, prevUser, { saveFn });

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
  await assert.rejects(() => commitUserEntries(CatalogKind.MATERIAL, nextUser, prevUser, { saveFn }), /IDB書込み失敗/);

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

// ---- planRealign（ステップ6b: 4.7 文書同梱を本体の内容に合わせ直す差分プラン）----
test('planRealign: 差分があればok:true・diffPairs（from=doc現在値, to=本体値）・baseOrigin・baseEntryを返す', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A', thickness: 12.5 });
  const docEntry = material({ code: '301000000001', name: 'A', thickness: 15 });
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry] });
  const plan = planRealign(CatalogKind.MATERIAL, '301000000001', { builtinList: [builtinEntry] });
  assert.equal(plan.ok, true);
  assert.equal(plan.baseOrigin, 'builtin');
  assert.equal(plan.baseEntry, builtinEntry);
  assert.deepEqual(plan.diffPairs, [{ field: 'thickness', label: '厚', from: 15, to: 12.5 }]);
});

test('planRealign: baseがuser（doc>userの上書き）なら baseOrigin=\'user\'・diffPairsはuserとの差', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A', note: 'builtin' });
  const userEntry = material({ code: '301000000001', name: 'A', note: 'user' });
  const docEntry = material({ code: '301000000001', name: 'A', note: 'doc' });
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry], user: [userEntry] });
  const plan = planRealign(CatalogKind.MATERIAL, '301000000001', { builtinList: [builtinEntry] });
  assert.equal(plan.ok, true);
  assert.equal(plan.baseOrigin, 'user');
  assert.equal(plan.baseEntry, userEntry);
  assert.deepEqual(plan.diffPairs, [{ field: 'note', label: '備考', from: 'doc', to: 'user' }]);
});

test('【失敗系・変異=差分なし判定を外すと赤】planRealign: docがbuiltinと完全一致なら ok:false・reason:\'本体と同じ内容です\'', () => {
  const builtinEntry = material({ code: '301000000001' });
  const docEntry = material({ code: '301000000001' }); // 全項目同じ
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry] });
  const plan = planRealign(CatalogKind.MATERIAL, '301000000001', { builtinList: [builtinEntry] });
  assert.deepEqual(plan, { ok: false, reason: '本体と同じ内容です' });
});

test('【失敗系・変異=差分なし判定を外すと赤】planRealign: docがuserと完全一致（builtinには無い）なら ok:false・reason:\'本体と同じ内容です\'', () => {
  const userEntry = material({ code: '301000000001' });
  const docEntry = material({ code: '301000000001' }); // 全項目同じ
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry], user: [userEntry] });
  const plan = planRealign(CatalogKind.MATERIAL, '301000000001', { builtinList: [] });
  assert.deepEqual(plan, { ok: false, reason: '本体と同じ内容です' });
});

// ---- QA指摘Minor-3（2026-09-23）: 「相手なし」と「同内容」を同キーのuser/builtinの有無で分ける ----
test('【QA指摘Minor-3】planRealign: 同キーのuser/builtinが無い（新規追加材）なら ok:false・reason:\'相手なし（合わせ直す先の本体エントリがありません）\'', () => {
  const docEntry = material({ code: '999999999999', name: '新規同梱材' }); // builtin/userどちらにも無いキー
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry] });
  const plan = planRealign(CatalogKind.MATERIAL, '999999999999', { builtinList: [material({ code: '301000000001' })] });
  assert.deepEqual(plan, { ok: false, reason: '相手なし（合わせ直す先の本体エントリがありません）' });
});

test('【QA指摘Minor-3】planRealign: 同キーのbuiltinが有り内容も一致なら reason:\'本体と同じ内容です\'（相手なしと混同しない）', () => {
  const builtinEntry = material({ code: '301000000001' });
  const docEntry = material({ code: '301000000001' }); // 全項目同じ
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry] });
  const plan = planRealign(CatalogKind.MATERIAL, '301000000001', { builtinList: [builtinEntry] });
  assert.deepEqual(plan, { ok: false, reason: '本体と同じ内容です' });
});

test('【失敗系】planRealign: 文書同梱(doc)に無いキーは例外', () => {
  setOverlay(CatalogKind.MATERIAL, { doc: [material({ code: '301000000001' })] });
  assert.throws(
    () => planRealign(CatalogKind.MATERIAL, '999999999999', { builtinList: [] }),
    /文書同梱に無いキーです/,
  );
});

// ---- planBulkSectionImport（ステップ8i: 断面の規格文字列一括入力）----
function sectionEntry(overrides) {
  return {
    key: 'STEEL-H200x100', materialType: 'STEEL', shape: 'hSection',
    width: 100, height: 200, webThickness: 5.5, flangeThickness: 8, label: 'H-200×100×5.5×8',
    ...overrides,
  };
}

test('planBulkSectionImport: 解析できた行はtoAddへ（builtin・overlayどちらにも無いキー）', () => {
  const builtin = [sectionEntry()]; // STEEL-H200x100のみ
  const result = planBulkSectionImport('H400×200×8×13 / □250×250×9', { builtinList: builtin, parseSpecList: parseSectionSpecList });
  assert.deepEqual(result.toAdd.map(e => e.key), ['STEEL-H400x200', 'STEEL-SQ250x250x9']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.errors, []);
});

test('【失敗系】planBulkSectionImport: builtinと衝突する行は「既にあります（標準）」でskippedへ、toAddに含めない', () => {
  const builtin = [sectionEntry()]; // STEEL-H200x100
  const result = planBulkSectionImport('H200×100×5.5×8', { builtinList: builtin, parseSpecList: parseSectionSpecList });
  assert.deepEqual(result.toAdd, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].line, 'H-200×100×5.5×8');
  assert.match(result.skipped[0].reason, /既にあります（標準）/);
});

test('【失敗系】planBulkSectionImport: 同じ入力内で同一キーになる2行は2件目をskippedへ回す（H形鋼はキーに板厚を含まない）', () => {
  const builtin = [sectionEntry()]; // STEEL-H200x100
  // 別内容・同キー（板厚違い）と、完全に同じ行の繰り返し
  const result = planBulkSectionImport('H401×200×8×13 / H401×200×9×14 / H401×200×8×13', { builtinList: builtin, parseSpecList: parseSectionSpecList });
  assert.deepEqual(result.toAdd.map(e => e.key), ['STEEL-H401x200']);
  assert.equal(result.toAdd[0].webThickness, 8, '先頭の行が採用される');
  assert.equal(result.skipped.length, 2);
  for (const s of result.skipped) assert.match(s.reason, /同じ入力内で重複しています/);
  assert.deepEqual(result.errors, []);
});

test('【失敗系】planBulkSectionImport: 同じ入力内でキー違い・内容同一（角形鋼管の板厚表記ゆれ）は2件目をskippedへ回す', () => {
  const result = planBulkSectionImport('□201×201×9.0 / □201×201×9', { builtinList: [], parseSpecList: parseSectionSpecList });
  assert.deepEqual(result.toAdd.map(e => e.key), ['STEEL-SQ201x201x9.0']);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /同じ入力内で重複しています/);
});

test('【失敗系】planBulkSectionImport: userライブラリと衝突する行は「既にあります（ライブラリ）」でskippedへ', () => {
  const builtin = [];
  setOverlay(CatalogKind.SECTION, { user: [sectionEntry()] });
  const result = planBulkSectionImport('H200×100×5.5×8', { builtinList: builtin, parseSpecList: parseSectionSpecList });
  assert.deepEqual(result.toAdd, []);
  assert.match(result.skipped[0].reason, /既にあります（ライブラリ）/);
});

test('【失敗系】planBulkSectionImport: 文書同梱(doc)と衝突する行は「既にあります（同梱）」でskippedへ', () => {
  const builtin = [];
  setOverlay(CatalogKind.SECTION, { doc: [sectionEntry()] });
  const result = planBulkSectionImport('H200×100×5.5×8', { builtinList: builtin, parseSpecList: parseSectionSpecList });
  assert.deepEqual(result.toAdd, []);
  assert.match(result.skipped[0].reason, /既にあります（同梱）/);
});

// ---- QA指摘Minor-B1（2026-09-23）: キーが違っても内容（matchFields）完全一致なら重複として除外する ----
// 角形鋼管はキーに板厚の文字列表現をそのまま使うため、'□250×250×9'（parseSectionSpec由来のキーは
// 'STEEL-SQ250x250x9'）と builtin の 'STEEL-SQ250x250x9.0' はキーが別だが内容は同一。
function squarePipeEntry(overrides) {
  return {
    key: 'STEEL-SQ250x250x9.0', materialType: 'STEEL', shape: 'squarePipe',
    width: 250, height: 250, wallThickness: 9, label: '□-250×250×9.0',
    ...overrides,
  };
}

test('【QA指摘Minor-B1】planBulkSectionImport: キーが違っても内容が完全一致すれば「既にあります（出所）」でskippedへ、内容が違えばtoAdd', () => {
  const builtin = [squarePipeEntry()]; // STEEL-SQ250x250x9.0（板厚9）
  const result = planBulkSectionImport('□250×250×9 / □250×250×9.0 / □250×250×12', {
    builtinList: builtin, parseSpecList: parseSectionSpecList,
  });
  // □250×250×9（キーはSTEEL-SQ250x250x9で別キーだが内容は同一）→ 内容一致でskipped
  // □250×250×9.0（キーも内容も同一）→ 既存キー一致でskipped
  assert.equal(result.skipped.length, 2, `skipped=${JSON.stringify(result.skipped)}`);
  assert.ok(result.skipped.every(s => /既にあります（標準）/.test(s.reason)), 'skippedの理由が「既にあります（標準）」でない行がある');
  assert.deepEqual(result.skipped.map(s => s.line), ['□-250×250×9', '□-250×250×9.0']);
  // □250×250×12（板厚12。builtinに同内容の断面が無い）→ toAdd
  assert.deepEqual(result.toAdd.map(e => e.key), ['STEEL-SQ250x250x12']);
  assert.deepEqual(result.errors, []);
});

test('【QA指摘Minor-B1】planBulkSectionImport: 内容一致の出所はuser/docでも同様に判定される（ライブラリ/同梱）', () => {
  setOverlay(CatalogKind.SECTION, { user: [squarePipeEntry({ key: 'STEEL-SQ250x250x9.0' })] });
  const result = planBulkSectionImport('□250×250×9', { builtinList: [], parseSpecList: parseSectionSpecList });
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /既にあります（ライブラリ）/);
});

// ---- QA指摘Minor-B2（2026-09-23）: parseSpecListが返すエントリの形が壊れていてもvalidateで捕まり、
// 他行の処理は継続する（key不正／width・height不正の2種） ----
test('【QA指摘Minor-B2】planBulkSectionImport: parseSpecListが不正な形のエントリを返してもvalidateでerrorsへ回り、正常な行は続行する', () => {
  const badKey = { key: '', materialType: 'STEEL', shape: 'hSection', width: 100, height: 100, label: 'key不正' };
  const badWidth = { key: 'STEEL-BADWIDTH', materialType: 'STEEL', shape: 'hSection', width: 'x', height: 100, label: 'width不正' };
  const ok = { key: 'STEEL-H400x200', materialType: 'STEEL', shape: 'hSection', width: 200, height: 400, webThickness: 8, flangeThickness: 13, label: 'H-400×200×8×13' };
  const fakeParseSpecList = () => ({ entries: [badKey, badWidth, ok], errors: [] });

  const result = planBulkSectionImport('（テスト用ダミー文字列。fakeParseSpecListは中身を見ない）', {
    builtinList: [], parseSpecList: fakeParseSpecList,
  });

  assert.equal(result.errors.length, 2, `errors=${JSON.stringify(result.errors)}`);
  assert.match(result.errors[0].reason, /keyが不正です/);
  assert.match(result.errors[1].reason, /width\/heightが不正です/);
  assert.deepEqual(result.toAdd.map(e => e.key), ['STEEL-H400x200']);
  assert.deepEqual(result.skipped, []);
});

test('【失敗系】planBulkSectionImport: 解析できない行はerrorsへ回り、他行のtoAdd判定は続行する（変異=エラー行で全体が壊れると赤）', () => {
  const builtin = [sectionEntry()];
  const result = planBulkSectionImport('H400×200×8×13 / bogus / H200×100×5.5×8', {
    builtinList: builtin, parseSpecList: parseSectionSpecList,
  });
  assert.deepEqual(result.toAdd.map(e => e.key), ['STEEL-H400x200']);
  assert.equal(result.skipped.length, 1, 'builtinと衝突するH200x100はskipped');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 'bogus');
  assert.match(result.errors[0].reason, /未対応の断面記号/);
});

test('planBulkSectionImport: 空文字は toAdd/skipped/errors すべて空', () => {
  const result = planBulkSectionImport('', { builtinList: [], parseSpecList: parseSectionSpecList });
  assert.deepEqual(result, { toAdd: [], skipped: [], errors: [] });
});
