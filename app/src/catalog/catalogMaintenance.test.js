import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKindTabs, buildMaterialRows, buildCatalogRows, collectKnownMaterialCodes, nextMaterialCode,
  buildMaterialEntry, duplicateMaterialEntry, validateMaterialEntry,
  upsertUserMaterialEntry, removeUserMaterialEntry, buildUserMaterialBundle, commitUserEntries,
  isEditableMaterialCategory, MATERIAL_CATEGORY, parseThicknessInput,
  planRealign, realignTargets, planBulkSectionImport, formatReadonlyValue, formatCategoryLabel,
  rowEditState, lockedFieldsFor, planSaveEntry, planRevertToBuiltin, planRemoveUserEntry, applyCatalogEditPlan,
  materialExtraLockedFields, materialSaveMessage, catalogSaveMessage, lockedFieldReason,
  materialRowDisabledReason, removeMessageFor, backingClassDisplayFor,
  buildFixtureSymbolEntry, validateFixtureSymbolForm, fixtureSymbolFormFieldsFor,
  fixtureSymbolRowDisabledReason, collectKnownCatalogKeys, FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM,
  FIXTURE_SYMBOL_KEY_PATTERN, fixtureSymbolFormFromEntry, fixtureSymbolPreviewEntry, categoryOptionsFor,
  nextInteriorMasterKey, interiorMasterFormFromEntry, buildInteriorMasterEntry,
  validateInteriorMasterForm, interiorMasterRowDisabledReason,
  sectionFormFromEntry, buildSectionEntry, validateSectionForm, sectionRowDisabledReason,
} from './catalogMaintenance.js';
import { setOverlay, clearOverlays, overlayFor, docDiffMap, composeCatalog } from './catalogRegistry.js';
import { valuesEqual } from './catalogMatch.js';
import { CatalogKind, FIXTURE_SYMBOL_PROFILES, interiorMasterBuiltinList } from './catalogKinds.js';
import { parseSectionSpecList } from '../structural/sectionCatalog.js';
import { openingSubTypeBuiltinList, fixtureSymbolBuiltinList } from '../openings/openingCatalog.js';
import { INTERIOR_MASTERS } from '../finish/materials/interiorMasters.js';

test.afterEach(() => clearOverlays());

function material(overrides) {
  return {
    code: '301000000001', name: 'せっこうボード t=9.5', spec: 'JIS A 6901',
    x: 0, y: 0, thickness: 9.5, note: '', category: 'panel',
    ...overrides,
  };
}

// ---- buildKindTabs ----
test('buildKindTabs: listKinds()から導出し、全種別（material・interiorMaster・boundaryMaster・section・openingSubType・fixtureSymbol）がenabled:true（閲覧のみ。ステップ7d・8h・10f・12d）', () => {
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
  const openingSubTypeTab = tabs.find(t => t.kind === CatalogKind.OPENING_SUB_TYPE);
  assert.equal(openingSubTypeTab.enabled, true);
  assert.equal(openingSubTypeTab.label, '建具種別');
  const fixtureSymbolTab = tabs.find(t => t.kind === CatalogKind.FIXTURE_SYMBOL);
  assert.equal(fixtureSymbolTab.enabled, true);
  assert.equal(fixtureSymbolTab.label, '建具記号');
  assert.equal(tabs.length, 6, '登録表の全種別ぶん（6種別）タブが出る');
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
test('【失敗系】validateMaterialEntry: 未知のcategoryは追加不可（日本語メッセージ）', () => {
  const entry = buildMaterialEntry({ code: '201000000099', name: 'テスト', category: 'unknown' });
  const result = validateMaterialEntry(entry, []);
  assert.equal(result.ok, false);
  assert.match(result.message, /面材・仕上げ材・下地材のみ/);
});

// ---- buildMaterialEntry: category:backingはx/yをそのまま持たせる。backingClassは値がある時だけ ----
test('buildMaterialEntry: category:panel/finishはx/y=0固定でbackingClassを持たない', () => {
  const entry = buildMaterialEntry({ code: '301000000099', name: 'A', category: 'panel', x: 999, y: 999, backingClass: 'wood' });
  assert.equal(entry.x, 0);
  assert.equal(entry.y, 0);
  assert.equal(entry.backingClass, undefined);
});

test('buildMaterialEntry: category:backingはx/y/backingClassをそのまま持たせる', () => {
  const entry = buildMaterialEntry({ code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36, backingClass: 'wood' });
  assert.equal(entry.x, 105);
  assert.equal(entry.y, 36);
  assert.equal(entry.backingClass, 'wood');
});

// ---- ステップ12c QA指摘M1（2026-09-24再報告）: backingClassがnull/undefinedならキー自体を
// 持たせない（本体の下地材はbackingClassフィールドを持たないため、null固定にするとkindDef.validate
// が「backingClassが不正です」で拒否し、本体の下地材が一切編集保存できなくなる事故を防ぐ）----
test('【失敗系・ステップ12c QA指摘M1】buildMaterialEntry: category:backingでbackingClassが未指定（null）ならentryにbackingClassキー自体を持たせない', () => {
  const entry = buildMaterialEntry({ code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36 });
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'backingClass'), false);
});

test('ステップ12c: UI相当の経路（formFromEntry→buildMaterialEntry→planSaveEntry）で本体RC下地材・間柱・90×90のnote編集がok:true・noop:falseになる（QA指摘M1回帰）', () => {
  // materialData.js実データと同型（backingClassフィールドを持たない）の3種のbuiltin下地材。
  const rc = { code: '501000000001', name: 'RC壁 t=150', spec: '鉄筋コンクリート', x: 0, y: 0, thickness: 150, note: '旧', category: 'backing' };
  const stud = { code: '101400000005', name: '□-90×45', spec: '杉・松等', x: 90, y: 45, thickness: null, note: '旧', category: 'backing' };
  const square = { code: '101000000001', name: '□-90×90', spec: '杉・桧等', x: 90, y: 90, thickness: null, note: '旧', category: 'backing' };
  for (const prevEntry of [rc, stud, square]) {
    // formFromEntry相当: name/spec/thickness/note/category/x/yを引き継ぎ、backingClassは
    // entry.backingClass ?? '' → '' になる（本体行はbackingClassを持たないため）。
    const form = {
      name: prevEntry.name, spec: prevEntry.spec,
      thickness: prevEntry.thickness == null ? '' : String(prevEntry.thickness),
      note: '新備考', category: prevEntry.category, x: prevEntry.x, y: prevEntry.y, backingClass: '',
    };
    const entry = buildMaterialEntry({
      code: prevEntry.code, name: form.name, spec: form.spec,
      thickness: form.thickness === '' ? null : Number(form.thickness), note: form.note, category: form.category,
      x: Number(form.x), y: Number(form.y), backingClass: form.backingClass || undefined,
    });
    const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
    assert.equal(plan.ok, true, `${prevEntry.code}: ${plan.message}`);
    assert.equal(plan.noop, false, `${prevEntry.code}: noteを変えたのでnoopではないはず`);
  }
});

// ---- ステップ12c QA指摘M3（2026-09-24再報告・リード裁定Q-1=案(a)）: 下地材の必須検査は
// planSaveEntry に一本化——新規追加・既存編集の両方に掛かる。ただし本体の上書き行
// （builtinKeys.has(key)）では掛からない（RC3件のx=y=0・全builtin下地材のbackingClass欠落対策）----
test('planSaveEntry: 下地材の新規追加（builtinに同キー無し）はx/y>0・backingClass必須を満たせば通る', () => {
  const entry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36, backingClass: 'wood',
  });
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: null });
  assert.equal(plan.ok, true);
});

test('【失敗系】planSaveEntry: ユーザー下地材の新規追加でbackingClassが\'rc\'は拒否（RCは固定集合判定のみ選択不可）', () => {
  const entry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36, backingClass: 'rc',
  });
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: null });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /木／その他/);
});

test('【失敗系】planSaveEntry: ユーザー下地材の新規追加でbackingClass未指定は拒否', () => {
  const entry = buildMaterialEntry({ code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36 });
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: null });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /木／その他/);
});

test('【失敗系】planSaveEntry: ユーザー下地材の新規追加でx=0は拒否（Xは0より大きい数値）', () => {
  const entry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 0, y: 36, backingClass: 'wood',
  });
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: null });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /Xは0より大きい数値/);
});

test('【失敗系】planSaveEntry: ユーザー下地材の新規追加でy=0は拒否（Yは0より大きい数値）', () => {
  const entry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 0, backingClass: 'wood',
  });
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: null });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /Yは0より大きい数値/);
});

test('【失敗系】planSaveEntry: ユーザー下地材（origin:user・builtinに同キー無し）の編集でx<0は拒否', () => {
  const prevEntry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36, backingClass: 'wood',
  });
  const entry = { ...prevEntry, x: -5 };
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /Xは0より大きい数値/);
});

test('【失敗系】planSaveEntry: ユーザー下地材の編集でbackingClassを空にすると拒否', () => {
  const prevEntry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36, backingClass: 'wood',
  });
  const entry = { ...prevEntry, backingClass: undefined, note: '変更' };
  delete entry.backingClass;
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /木／その他/);
});

test('ステップ12c: 本体の上書き行（builtinKeys.has(key)）はx=0・backingClass欠落でも下地材の必須検査を素通りする（RC3件対策。一般則）', () => {
  const prevEntry = { code: '501000000001', name: 'RC壁 t=150', spec: '', x: 0, y: 0, thickness: 150, note: '旧', category: 'backing' };
  const entry = { ...prevEntry, note: '新' };
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, false);
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
test('isEditableMaterialCategory: panel/finish/backingはtrue（ステップ12c: 下地材も開放）、未知categoryはfalse', () => {
  assert.equal(isEditableMaterialCategory(MATERIAL_CATEGORY.PANEL), true);
  assert.equal(isEditableMaterialCategory(MATERIAL_CATEGORY.FINISH), true);
  assert.equal(isEditableMaterialCategory(MATERIAL_CATEGORY.BACKING), true);
  assert.equal(isEditableMaterialCategory(undefined), false);
  assert.equal(isEditableMaterialCategory('unknown'), false);
});

// ---- canEditMaterialRow はステップ12b でrowEditState（1.1）+isEditableMaterialCategoryへ置換され
// 削除した（仕様変更。置換後の判定は下のrowEditStateテスト群・isEditableMaterialCategoryテストで
// 検証済み）。----

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

// ---- ステップ10f: 建具種別（openingSubType）の閲覧タブ ----
// buildCatalogRows(kind:openingSubType)のkeyOfは`${category}:${key}`の複合キー（catalogKinds.js）。
// 8h同様、searchはlabel（呼称）にもkeyOf（複合キー）にも一致すること。
test('buildCatalogRows: kind:openingSubTypeでsearchはlabel（呼称）にも複合キー（category:key）にも一致する', () => {
  const builtin = [
    { category: 'fitting', key: 'singleSwing', label: '片開き戸', mechanism: 'swing', wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 },
    { category: 'window', key: 'doubleSliding', label: '引き違い窓', mechanism: 'slideDouble', defaultWidth: 1690, defaultHeight: 1170 },
  ];
  // labelに含まれない語だが複合キー（fitting:singleSwing）には含まれる。
  const byKey = buildCatalogRows({ kind: CatalogKind.OPENING_SUB_TYPE, builtinList: builtin, search: 'fitting:single' });
  assert.deepEqual(byKey.map(r => r.entry.key), ['singleSwing']);

  const byLabel = buildCatalogRows({ kind: CatalogKind.OPENING_SUB_TYPE, builtinList: builtin, search: '引き違い窓' });
  assert.deepEqual(byLabel.map(r => r.entry.key), ['doubleSliding']);
});

// ---- formatReadonlyValue（ステップ10f: ReadonlyKindTabの詳細欄の汎用整形） ----
test('formatReadonlyValue: 未設定（null/undefined/空文字）は「（未設定）」', () => {
  assert.equal(formatReadonlyValue(null), '（未設定）');
  assert.equal(formatReadonlyValue(undefined), '（未設定）');
  assert.equal(formatReadonlyValue(''), '（未設定）');
});

test('formatReadonlyValue: プリミティブはString()化する', () => {
  assert.equal(formatReadonlyValue('interior'), 'interior');
  assert.equal(formatReadonlyValue(800), '800');
});

test('formatReadonlyValue: 配列（wallKinds相当）は要素を「・」で連結する。空配列は「（なし）」', () => {
  assert.equal(formatReadonlyValue(['interior', 'exterior']), 'interior・exterior');
  assert.equal(formatReadonlyValue([]), '（なし）');
});

test('formatReadonlyValue: plainオブジェクトは「key:value」を「・」で連結する。空オブジェクトは「（なし）」', () => {
  assert.equal(formatReadonlyValue({ tracks: 2 }), 'tracks:2');
  assert.equal(formatReadonlyValue({}), '（なし）');
});

// ---- QA指摘Minor-3（2026-09-23）: オブジェクト要素を含む配列は「〔…〕／」区切りで要素境界を示す ----
test('formatReadonlyValue: オブジェクト要素を含む配列は各要素を「〔…〕」で包み「／」で連結する（プリミティブ配列の「・」と衝突させない）', () => {
  assert.equal(formatReadonlyValue([{ arrow: 'neg' }, { fix: true }]), '〔arrow:neg〕／〔fix:true〕');
});

test('formatReadonlyValue: slideLayout相当（オブジェクトの中に、オブジェクト要素を含む配列）を再帰的に整形する。要素境界が「〔…〕／」で読み取れる', () => {
  const slideLayout = { tracks: 2, panels: [{ fix: true }, { arrow: 'neg' }, { arrow: 'pos' }, { fix: true }] };
  assert.equal(formatReadonlyValue(slideLayout), 'tracks:2・panels:〔fix:true〕／〔arrow:neg〕／〔arrow:pos〕／〔fix:true〕');
});

// ---- formatCategoryLabel（QA指摘Minor-2: category値の表示名はkindごとの対応表から引く） ----
test('formatCategoryLabel: openingSubTypeはfitting→建具・window→窓', () => {
  assert.equal(formatCategoryLabel(CatalogKind.OPENING_SUB_TYPE, 'fitting'), '建具');
  assert.equal(formatCategoryLabel(CatalogKind.OPENING_SUB_TYPE, 'window'), '窓');
});

test('formatCategoryLabel: materialはpanel→面材・finish→仕上げ材・backing→下地材', () => {
  assert.equal(formatCategoryLabel(CatalogKind.MATERIAL, 'panel'), '面材');
  assert.equal(formatCategoryLabel(CatalogKind.MATERIAL, 'finish'), '仕上げ材');
  assert.equal(formatCategoryLabel(CatalogKind.MATERIAL, 'backing'), '下地材');
});

test('formatCategoryLabel: 対応表に無い種別・値でも投げずformatReadonlyValueへフォールバックする（未知値・null）', () => {
  assert.equal(formatCategoryLabel(CatalogKind.OPENING_SUB_TYPE, 'sash'), 'sash');
  assert.equal(formatCategoryLabel(CatalogKind.MATERIAL, 'sash'), 'sash');
  assert.equal(formatCategoryLabel(CatalogKind.OPENING_SUB_TYPE, null), '（未設定）');
  assert.equal(formatCategoryLabel(CatalogKind.INTERIOR_MASTER, 'anything'), 'anything');
});

// ================================================================
// ステップ12a: 本体編集（builtinの上書き）の共通純ロジック
// ================================================================

// ---- buildCatalogRows: overridesBuiltin/builtinEntry ----
test('buildCatalogRows: 各行にoverridesBuiltin（userのoverridesBuiltin印）とbuiltinEntry（builtin同キーか無ければnull）が付く', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const overrideEntry = { ...builtinEntry, name: 'A（編集）', overridesBuiltin: true };
  const plainUserEntry = material({ code: '301000000099', name: 'B' });
  setOverlay(CatalogKind.MATERIAL, { user: [overrideEntry, plainUserEntry] });
  const rows = buildCatalogRows({ kind: CatalogKind.MATERIAL, builtinList: [builtinEntry] });
  const byCode = new Map(rows.map(r => [r.entry.code, r]));
  assert.equal(byCode.get('301000000001').overridesBuiltin, true);
  assert.equal(byCode.get('301000000001').builtinEntry, builtinEntry);
  assert.equal(byCode.get('301000000099').overridesBuiltin, false);
  assert.equal(byCode.get('301000000099').builtinEntry, null);
});

// ---- QA指摘M2（2026-09-24再報告）: 標準を上書きしたuserが文書に同梱されるとoverridesBuiltin
// バッジが消える不具合の修正確認（doc起源の行でも、相手userのoverridesBuiltinを見る） ----
test('【QA指摘M2】buildCatalogRows: doc起源の行でも、同キーのuserエントリがoverridesBuiltinなら行のoverridesBuiltinはtrue（バッジが消えない）', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const overrideUserEntry = { ...builtinEntry, name: 'A（編集）', overridesBuiltin: true };
  const docEntrySameAsUser = { ...overrideUserEntry }; // 文書同梱＝userと同内容（差分なし）
  setOverlay(CatalogKind.MATERIAL, { user: [overrideUserEntry], doc: [docEntrySameAsUser] });
  const rows = buildCatalogRows({ kind: CatalogKind.MATERIAL, builtinList: [builtinEntry] });
  const row = rows.find(r => r.entry.code === '301000000001');
  assert.equal(row.origin, 'doc');
  assert.equal(row.overridesBuiltin, true, 'doc起源でも標準を編集した行はバッジtrueのまま');
});

test('buildCatalogRows: 標準に一致するがuser上書きが無い行（同キーがbuiltinに存在するだけ）はoverridesBuiltin:false', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const docEntrySameAsBuiltin = { ...builtinEntry }; // userなし・docがbuiltinと同内容
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntrySameAsBuiltin] });
  const rows = buildCatalogRows({ kind: CatalogKind.MATERIAL, builtinList: [builtinEntry] });
  const row = rows.find(r => r.entry.code === '301000000001');
  assert.equal(row.overridesBuiltin, false, 'userの上書きが無いのでバッジは出さない');
});

// ---- rowEditState（1.1: 6状態の判定） ----
test('rowEditState: origin===builtinはstate:builtin（編集=上書き・複製可。削除/戻す不可）', () => {
  const row = { entry: material({ code: '301000000001' }), origin: 'builtin', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.deepEqual(result, { state: 'builtin', canEdit: true, canRevert: false, canDelete: false, canDuplicate: true, reason: null });
});

test('rowEditState: origin===userでbuiltinKeysに同キーがあればstate:override（編集・標準に戻す・複製）', () => {
  const row = { entry: material({ code: '301000000001', overridesBuiltin: true }), origin: 'user', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.deepEqual(result, { state: 'override', canEdit: true, canRevert: true, canDelete: false, canDuplicate: true, reason: null });
});

test('rowEditState: origin===userでbuiltinKeysに無ければstate:user（編集・削除・複製。戻すは不可）', () => {
  const row = { entry: material({ code: '301000000099' }), origin: 'user', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.deepEqual(result, { state: 'user', canEdit: true, canRevert: false, canDelete: true, canDuplicate: true, reason: null });
});

test('rowEditState: origin===docでdiffMapに差分があればstate:doc-diff（編集不可・複製のみ）', () => {
  const row = { entry: material({ code: '301000000001' }), origin: 'doc', diff: null };
  const diffMap = new Map([['301000000001', { diffFields: ['name'] }]]);
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']), diffMap });
  assert.equal(result.state, 'doc-diff');
  assert.equal(result.canEdit, false);
  assert.equal(result.canDuplicate, true);
  assert.match(result.reason, /合わせ直すか複製/);
});

test('rowEditState: diffMap省略時はrow.diffで代用する（doc-diff）', () => {
  const row = { entry: material({ code: '301000000001' }), origin: 'doc', diff: { diffFields: ['name'] } };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.equal(result.state, 'doc-diff');
});

test('rowEditState: origin===docで差分無し・builtinが相手ならstate:doc-same（編集可・複製のみ他は不可）', () => {
  const row = { entry: material({ code: '301000000001' }), origin: 'doc', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.deepEqual(result, { state: 'doc-same', canEdit: true, canRevert: false, canDelete: false, canDuplicate: true, reason: null });
});

test('rowEditState: origin===docで差分無し・user（builtinには無いキー）が相手でもstate:doc-same（「相手＝userかbuiltin」の両方を見る）', () => {
  setOverlay(CatalogKind.MATERIAL, { user: [material({ code: '301000000099' })] });
  const row = { entry: material({ code: '301000000099' }), origin: 'doc', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set() });
  assert.equal(result.state, 'doc-same');
});

// ---- QA指摘M2（2026-09-24再報告）: doc-override（標準を上書きしたuserが文書にも同梱されている
// doc-sameの特殊形。編集・標準に戻す・複製を維持する） ----
test('【QA指摘M2】rowEditState: origin===docで差分無し・相手userがoverridesBuiltin:trueならstate:doc-override（canRevert:true）', () => {
  const overrideUserEntry = material({ code: '301000000001', name: 'A（編集）', overridesBuiltin: true });
  setOverlay(CatalogKind.MATERIAL, { user: [overrideUserEntry] });
  const row = { entry: material({ code: '301000000001', name: 'A（編集）' }), origin: 'doc', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.deepEqual(result, { state: 'doc-override', canEdit: true, canRevert: true, canDelete: false, canDuplicate: true, reason: null });
});

test('【QA指摘M2】rowEditState: 相手userのoverridesBuiltinフラグが無くてもkeyがbuiltinKeysに含まれればdoc-override（フラグ欠落への耐性）', () => {
  const userEntryWithoutFlag = material({ code: '301000000001', name: 'A（編集）' }); // overridesBuiltinフラグ無し
  setOverlay(CatalogKind.MATERIAL, { user: [userEntryWithoutFlag] });
  const row = { entry: material({ code: '301000000001', name: 'A（編集）' }), origin: 'doc', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.equal(result.state, 'doc-override');
});

test('rowEditState: origin===docで差分無し・builtinKeysにはあるがuserエントリ自体が無ければdoc-same（上書きの実体が無いのでdoc-overrideにしない）', () => {
  const row = { entry: material({ code: '301000000001' }), origin: 'doc', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.equal(result.state, 'doc-same', '相手userが無い場合はbuiltinKeys一致だけでdoc-overrideにはしない');
});

test('【失敗系】rowEditState: origin===docで相手（userもbuiltinも）が無ければstate:doc-only（編集不可・複製のみ）', () => {
  const row = { entry: material({ code: '301000000099' }), origin: 'doc', diff: null };
  const result = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set() });
  assert.equal(result.state, 'doc-only');
  assert.equal(result.canEdit, false);
  assert.equal(result.canDuplicate, true);
  assert.match(result.reason, /複製/);
});

test('【失敗系】rowEditState: 未知のoriginは例外', () => {
  const row = { entry: material({ code: 'x' }), origin: 'bogus', diff: null };
  assert.throws(() => rowEditState(CatalogKind.MATERIAL, row, {}), /出所が不正/);
});

// ---- lockedFieldsFor（1.2: 固定項目） ----
test('lockedFieldsFor: builtinキーはkeyBound∪overrideLocked∪extraLockedを固定する', () => {
  const locked = lockedFieldsFor(CatalogKind.MATERIAL, '301000000001', {
    builtinKeys: new Set(['301000000001']), extraLocked: ['x', 'y'],
  });
  assert.deepEqual([...locked].sort(), ['backingClass', 'category', 'code', 'x', 'y']);
});

test('lockedFieldsFor: userキー（builtinKeysに無い）はkeyBound∪extraLockedのみ（overrideLockedは掛からない）', () => {
  const locked = lockedFieldsFor(CatalogKind.MATERIAL, '301000000099', {
    builtinKeys: new Set(['301000000001']), extraLocked: ['x'],
  });
  assert.deepEqual([...locked].sort(), ['code', 'x']);
});

test('lockedFieldsFor: 省略時はkeyBoundFieldsのみ（section）', () => {
  const locked = lockedFieldsFor(CatalogKind.SECTION, 'STEEL-H200x100');
  assert.deepEqual([...locked].sort(), [
    'key', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness',
  ].sort());
});

// ---- QA指摘m4（2026-09-24再報告・jsxLockedCat）: lockedFieldReason（固定項目の拒否文言の唯一の
// 定義箇所。planSaveEntryの内部拒否メッセージと.jsx側のツールチップが同じ式を参照する） ----
test('lockedFieldReason: 「${ラベル}は変更できません（複製してください）」を返す', () => {
  assert.equal(lockedFieldReason(CatalogKind.MATERIAL, 'category'), '区分は変更できません（複製してください）');
});

test('lockedFieldReason: planSaveEntryの拒否メッセージと同じ文言になる（文言源が同一であることの確認）', () => {
  const prevEntry = material({ code: '301000000001', name: 'A', category: 'panel' });
  const entry = { ...prevEntry, category: 'finish' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [prevEntry], rowState: 'override', prevEntry });
  assert.equal(result.message, lockedFieldReason(CatalogKind.MATERIAL, 'category'));
});

// ---- planSaveEntry（1.3: 本体編集の保存プラン） ----
test('【失敗系】planSaveEntry: keyBoundFields（code）を変えると拒否（日本語項目名を含む）', () => {
  const prevEntry = material({ code: '301000000001', name: 'A' });
  const entry = { ...prevEntry, code: '301000000002' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [prevEntry], rowState: 'user', prevEntry });
  assert.equal(result.ok, false);
  assert.match(result.message, /コードは変更できません（複製してください）/);
});

test('【失敗系】planSaveEntry: overrideLockedFields（材のcategory）はbuiltin同キーのときだけ固定される', () => {
  const prevEntry = material({ code: '301000000001', name: 'A', category: 'panel' });
  const entry = { ...prevEntry, category: 'finish' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [prevEntry], rowState: 'override', prevEntry });
  assert.equal(result.ok, false);
  assert.match(result.message, /区分は変更できません（複製してください）/);
});

test('planSaveEntry: overrideLockedFieldsはuserエントリ（builtinに同キー無し）には掛からない', () => {
  const prevEntry = material({ code: '301000000099', name: 'A', category: 'panel' });
  const entry = { ...prevEntry, category: 'finish' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.ok, true);
});

test('planSaveEntry: 新規追加（prevEntry省略）は固定項目検査の対象外', () => {
  const entry = buildMaterialEntry({ code: '301000000099', name: '新規', category: 'panel' });
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [] });
  assert.equal(result.ok, true);
});

test('【失敗系】planSaveEntry: kindDef.validate失敗（name欠落）はメッセージをそのまま返す', () => {
  const entry = buildMaterialEntry({ code: '301000000099', name: '', category: 'panel' });
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /nameが不正/);
});

test('【失敗系】planSaveEntry: R17（dedupeFields完全一致）の重複は拒否する', () => {
  const builtin = [material({ code: '301000000001', name: '同名材', spec: 'S', thickness: 10 })];
  const entry = buildMaterialEntry({ code: '301000000002', name: '同名材', spec: 'S', thickness: 10, category: 'panel' });
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: builtin });
  assert.equal(result.ok, false);
  assert.match(result.message, /既に登録されています/);
});

test('planSaveEntry: dedupeFieldsを持たない種別（interiorMaster）はR17検査をしない（内容重複でも通る）', () => {
  const builtin = [{ key: 'LIVING_ROOM', label: 'リビング', wallMaterial: 'クロス', wallFinish: 'AEP', ceilingHeight: 2400 }];
  const entry = { key: 'BEDROOM', label: '寝室', wallMaterial: 'クロス', wallFinish: 'AEP', ceilingHeight: 2400 };
  const result = planSaveEntry(CatalogKind.INTERIOR_MASTER, entry, { builtinList: builtin });
  assert.equal(result.ok, true);
});

test('planSaveEntry: builtin同キーはnextUserの該当エントリにoverridesBuiltin:trueが付く', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const entry = { ...builtinEntry, name: 'A（編集）' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [builtinEntry], rowState: 'builtin', prevEntry: builtinEntry,
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextUser.length, 1);
  assert.equal(result.nextUser[0].overridesBuiltin, true);
  assert.equal(result.nextUser[0].name, 'A（編集）');
  assert.equal(result.removeDocKey, null);
});

test('planSaveEntry: user新規追加（builtinに同キー無し）はoverridesBuiltin項目自体を持たない', () => {
  const entry = buildMaterialEntry({ code: '301000000099', name: '新規', category: 'panel' });
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [] });
  assert.equal(result.ok, true);
  assert.equal('overridesBuiltin' in result.nextUser[0], false, 'overridesBuiltinを持ってはいけない');
});

test('planSaveEntry: rowState===doc-sameならremoveDocKeyとconfirmPairs（from=doc現在値・to=編集後）を返す', () => {
  const prevEntry = material({ code: '301000000001', name: 'A', thickness: 10 });
  const entry = { ...prevEntry, thickness: 15 };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [material({ code: '301000000001', name: 'A', thickness: 10 })],
    rowState: 'doc-same', prevEntry,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removeDocKey, '301000000001');
  assert.deepEqual(result.confirmPairs, [{ field: 'thickness', label: '厚', from: 10, to: 15 }]);
});

test('planSaveEntry: rowStateがdoc-same以外ならremoveDocKey=null・confirmPairs=[]', () => {
  const prevEntry = buildMaterialEntry({ code: '301000000099', name: '既存', category: 'panel' });
  const entry = { ...prevEntry, name: '既存（編集後）' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.ok, true);
  assert.equal(result.removeDocKey, null);
  assert.deepEqual(result.confirmPairs, []);
});

// ---- QA指摘M2（2026-09-24再報告）: rowState===doc-overrideもdoc-sameと同じくremoveDocKey/confirmPairsを返す ----
test('【QA指摘M2】planSaveEntry: rowState===doc-overrideもdoc-sameと同じくremoveDocKeyとconfirmPairsを返す', () => {
  const prevEntry = material({ code: '301000000001', name: 'A', thickness: 10 });
  const entry = { ...prevEntry, thickness: 15 };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [material({ code: '301000000001', name: 'A', thickness: 10 })],
    rowState: 'doc-override', prevEntry,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removeDocKey, '301000000001');
  assert.deepEqual(result.confirmPairs, [{ field: 'thickness', label: '厚', from: 10, to: 15 }]);
  assert.equal(result.needsConfirm, true);
});

// ---- QA指摘m1（2026-09-24再報告）: 変更が無ければno-op（{ok:true, noop:true}のみ返し、以降の
// 検証・書込みを一切しない） ----
test('【QA指摘m1】planSaveEntry: builtin行を変更せず保存するとnoop:true（同内容のuser上書きを作らない）', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const entry = { ...builtinEntry }; // 変更なし
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [builtinEntry], rowState: 'builtin', prevEntry: builtinEntry,
  });
  assert.deepEqual(result, { ok: true, noop: true });
});

test('【QA指摘m1】planSaveEntry: doc-same行を変更せず保存するとnoop:true（確認なしに同梱を外さない）', () => {
  const prevEntry = material({ code: '301000000001', name: 'A', thickness: 10 });
  const entry = { ...prevEntry }; // 変更なし
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [material({ code: '301000000001', name: 'A', thickness: 10 })],
    rowState: 'doc-same', prevEntry,
  });
  assert.deepEqual(result, { ok: true, noop: true });
});

test('【QA指摘m1】planSaveEntry: 1項目でも変わっていればnoopにならない（ok:true, noop:false）', () => {
  const prevEntry = material({ code: '301000000099', name: 'A' });
  const entry = { ...prevEntry, name: 'A（変更）' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.ok, true);
  assert.equal(result.noop, false);
});

// ---- ステップ12c QA指摘M2（2026-09-24再報告）: backingClassをcompareFieldsに含めたため、
// 下地区分だけの変更はnoopにならない ----
test('【QA指摘M2】planSaveEntry: ユーザー下地材のbackingClass変更（wood→other）だけでもnoopにならない', () => {
  const prevEntry = buildMaterialEntry({
    code: '101400000099', name: '□-105×36', category: 'backing', x: 105, y: 36, backingClass: 'wood',
  });
  const entry = { ...prevEntry, backingClass: 'other' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.ok, true);
  assert.equal(result.noop, false);
});

// ---- QA指摘m4（2026-09-24再報告）: planSaveEntryの戻り値にoverridesBuiltin/thicknessChanged/
// needsConfirmを含める（.jsx側で再計算しない） ----
test('【QA指摘m4】planSaveEntry: overridesBuiltinはbuiltinKeys.has(key)をそのまま返す（builtin/override行はtrue）', () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const entry = { ...builtinEntry, name: 'A（編集）' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [builtinEntry], rowState: 'builtin', prevEntry: builtinEntry,
  });
  assert.equal(result.overridesBuiltin, true);
});

test('【QA指摘m4】planSaveEntry: overridesBuiltinはuser行（builtinに同キー無し）はfalse', () => {
  const prevEntry = material({ code: '301000000099', name: 'A' });
  const entry = { ...prevEntry, name: 'A（編集）' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.overridesBuiltin, false);
});

test('【QA指摘m4】planSaveEntry: thicknessChangedはprevEntry.thicknessとentry.thicknessが違えばtrue', () => {
  const prevEntry = material({ code: '301000000099', name: 'A', thickness: 10 });
  const entry = { ...prevEntry, thickness: 15 };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.thicknessChanged, true);
});

test('【QA指摘m4】planSaveEntry: thicknessChangedは厚さが同じならfalse（名称だけ変えた場合）', () => {
  const prevEntry = material({ code: '301000000099', name: 'A', thickness: 10 });
  const entry = { ...prevEntry, name: 'A（編集）' };
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(result.thicknessChanged, false);
});

test('【QA指摘m4】planSaveEntry: needsConfirmはdoc-same/doc-overrideかつconfirmPairsが非空のときだけtrue', () => {
  const prevEntry = material({ code: '301000000099', name: 'A' });
  const entry = { ...prevEntry, name: 'A（編集）' };
  const userState = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: 'user', prevEntry });
  assert.equal(userState.needsConfirm, false, 'doc-same/doc-override以外はneedsConfirm:false');

  const docSameEntry = material({ code: '301000000001', name: 'A', thickness: 10 });
  const docSameEdited = { ...docSameEntry, thickness: 12 };
  const docSameState = planSaveEntry(CatalogKind.MATERIAL, docSameEdited, {
    builtinList: [material({ code: '301000000001', name: 'A', thickness: 10 })],
    rowState: 'doc-same', prevEntry: docSameEntry,
  });
  assert.equal(docSameState.needsConfirm, true);
});

// ---- QA指摘Minor-2（2026-09-24再報告）: rowStateが既存行なのにprevEntry省略は拒否 ----
test('【失敗系・QA指摘Minor-2】planSaveEntry: rowState===doc-sameなのにprevEntryを省略するとok:false（固定項目検査の素通り防止）', () => {
  const entry = material({ code: '301000000001', name: '編集後' });
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [entry], rowState: 'doc-same' });
  assert.equal(result.ok, false);
  assert.match(result.message, /編集元の項目が指定されていません/);
});

test('【失敗系・QA指摘Minor-2】planSaveEntry: rowState===override/user/builtinもprevEntry省略はok:false', () => {
  const entry = material({ code: '301000000001', name: '編集後' });
  for (const rowState of ['override', 'user', 'builtin']) {
    const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [entry], rowState });
    assert.equal(result.ok, false, `rowState:${rowState}`);
    assert.match(result.message, /編集元の項目が指定されていません/, `rowState:${rowState}`);
  }
});

test('planSaveEntry: rowStateが既存行の状態に含まれない（新規追加。null等）ならprevEntry省略でもok:true', () => {
  const entry = buildMaterialEntry({ code: '301000000099', name: '新規', category: 'panel' });
  const result = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList: [], rowState: null });
  assert.equal(result.ok, true);
});

// ---- QA指摘Nit-2（2026-09-24再報告）: keyBoundFieldsの前後空白だけの差はvaluesEqual（trim比較）
// では素通りしうるため、keyOf自体（生の文字列）の一致を保険として確認する ----
test('【失敗系・QA指摘Nit-2】planSaveEntry: keyBoundFields（section.key）が前後空白だけ変わった場合、valuesEqualはtrim比較で素通りするがkeyOf比較で拒否する', () => {
  const prevEntry = sectionEntry({ key: 'STEEL-H200x100' });
  const entry = { ...prevEntry, key: 'STEEL-H200x100 ' }; // 末尾に半角空白（trimすればprevEntryと同じ）
  // 素通りしないことの前提確認: valuesEqual自体はtrim比較で等しいと判定する
  assert.equal(valuesEqual(prevEntry.key, entry.key), true, '前提: valuesEqualはtrim比較で等しいと判定するはず');
  const result = planSaveEntry(CatalogKind.SECTION, entry, { builtinList: [prevEntry], rowState: 'user', prevEntry });
  assert.equal(result.ok, false);
  assert.match(result.message, /識別項目（キー）は変更できません（複製してください）/);
});

// ---- planRevertToBuiltin（1.3: 標準に戻す） ----
test('planRevertToBuiltin: userから外し、alsoRealignDoc（既定true）かつdocに同キーがあればremoveDocKeyを添える', () => {
  const userEntry = material({ code: '301000000001', name: 'A（編集）', overridesBuiltin: true });
  const docEntry = material({ code: '301000000001', name: 'A（編集）' });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry], doc: [docEntry] });
  const plan = planRevertToBuiltin(CatalogKind.MATERIAL, '301000000001');
  assert.deepEqual(plan.nextUser, []);
  assert.equal(plan.removeDocKey, '301000000001');
});

test('planRevertToBuiltin: alsoRealignDoc:falseならdocに同キーがあってもremoveDocKeyはnull', () => {
  const userEntry = material({ code: '301000000001', overridesBuiltin: true });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry], doc: [material({ code: '301000000001' })] });
  const plan = planRevertToBuiltin(CatalogKind.MATERIAL, '301000000001', { alsoRealignDoc: false });
  assert.equal(plan.removeDocKey, null);
});

test('planRevertToBuiltin: docに同キーが無ければalsoRealignDoc:trueでもremoveDocKeyはnull', () => {
  const userEntry = material({ code: '301000000001', overridesBuiltin: true });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry] });
  const plan = planRevertToBuiltin(CatalogKind.MATERIAL, '301000000001');
  assert.equal(plan.removeDocKey, null);
});

test('planRevertToBuiltin→applyCatalogEditPlan: 適用後はcomposeCatalogの解決結果がbuiltinエントリと===で一致する', async () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const userEntry = { ...builtinEntry, name: 'A（編集）', overridesBuiltin: true };
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry] });
  const plan = planRevertToBuiltin(CatalogKind.MATERIAL, '301000000001');
  await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn: async () => {}, prevUser: [userEntry] });
  const resolved = composeCatalog(CatalogKind.MATERIAL, [builtinEntry]);
  assert.equal(resolved.get('301000000001'), builtinEntry, '解決結果がbuiltinエントリそのもの（===）に戻っている');
});

// ---- QA指摘M2（2026-09-24再報告）: doc-override行の「標準に戻す」は doc も user も消え、
// 解決結果が builtin と === 一致する（既存のplanRevertToBuiltinをそのまま使える契約の確認） ----
test('【QA指摘M2】doc-override行: planRevertToBuiltin(alsoRealignDoc:true)→applyCatalogEditPlanで doc・user が両方消え、解決結果がbuiltinと===一致する', async () => {
  const builtinEntry = material({ code: '301000000001', name: 'A' });
  const overrideUserEntry = { ...builtinEntry, name: 'A（編集）', overridesBuiltin: true };
  const docEntrySameAsUser = { ...overrideUserEntry }; // 文書同梱＝userと同内容（doc-override状態）
  setOverlay(CatalogKind.MATERIAL, { user: [overrideUserEntry], doc: [docEntrySameAsUser] });

  // 前提: この行が doc-override であること
  const rows = buildCatalogRows({ kind: CatalogKind.MATERIAL, builtinList: [builtinEntry] });
  const row = rows.find(r => r.entry.code === '301000000001');
  const editState = rowEditState(CatalogKind.MATERIAL, row, { builtinKeys: new Set(['301000000001']) });
  assert.equal(editState.state, 'doc-override', '前提: doc-override状態であること');
  assert.equal(editState.canRevert, true);

  const plan = planRevertToBuiltin(CatalogKind.MATERIAL, '301000000001', { alsoRealignDoc: true });
  assert.equal(plan.removeDocKey, '301000000001', 'docにも同キーがあるのでremoveDocKeyが立つ');
  await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn: async () => {}, prevUser: [overrideUserEntry] });

  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).user, [], 'userから消えている');
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [], 'docからも消えている');
  const resolved = composeCatalog(CatalogKind.MATERIAL, [builtinEntry]);
  assert.equal(resolved.get('301000000001'), builtinEntry, '解決結果がbuiltinエントリそのもの（===）に戻っている');
});

// ---- planRemoveUserEntry（1.3: 使用中userの削除。Q9を未保存文書でも守る） ----
test('planRemoveUserEntry: 使用中でdocに無ければdocAppendにuserエントリを添える', () => {
  const userEntry = material({ code: '301000000099', name: 'ユーザー材' });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry] });
  const plan = planRemoveUserEntry(CatalogKind.MATERIAL, '301000000099', { usedKeys: new Set(['301000000099']) });
  assert.deepEqual(plan.nextUser, []);
  assert.deepEqual(plan.docAppend, userEntry);
});

test('planRemoveUserEntry: 使用中でもdocに既にあればdocAppend=null（二重に書き写さない）', () => {
  const userEntry = material({ code: '301000000099' });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry], doc: [userEntry] });
  const plan = planRemoveUserEntry(CatalogKind.MATERIAL, '301000000099', { usedKeys: new Set(['301000000099']) });
  assert.equal(plan.docAppend, null);
});

test('planRemoveUserEntry: 未使用ならdocAppend=null', () => {
  const userEntry = material({ code: '301000000099' });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry] });
  const plan = planRemoveUserEntry(CatalogKind.MATERIAL, '301000000099', { usedKeys: new Set() });
  assert.equal(plan.docAppend, null);
});

test('【失敗系】planRemoveUserEntry: ユーザーライブラリに無いキーは例外', () => {
  setOverlay(CatalogKind.MATERIAL, { user: [] });
  assert.throws(() => planRemoveUserEntry(CatalogKind.MATERIAL, '999999999999', {}), /ユーザーライブラリに無いキーです/);
});

// ---- QA指摘Minor-1（2026-09-24再報告）: docAppendはoverridesBuiltinを持ち込まない ----
test('【QA指摘Minor-1】planRemoveUserEntry: overridesBuiltin付きuserを使用中として削除→docAppendに印が無く、overlay内の元userエントリは印を保持する', () => {
  const overrideEntry = material({ code: '301000000001', name: 'A（編集）', overridesBuiltin: true });
  setOverlay(CatalogKind.MATERIAL, { user: [overrideEntry] });
  const plan = planRemoveUserEntry(CatalogKind.MATERIAL, '301000000001', { usedKeys: new Set(['301000000001']) });
  assert.ok(plan.docAppend, 'docAppendが立つ前提（使用中・docに無い）');
  assert.equal('overridesBuiltin' in plan.docAppend, false, 'docAppendにoverridesBuiltinが残ってはいけない');
  const expectedWithoutFlag = { ...overrideEntry };
  delete expectedWithoutFlag.overridesBuiltin;
  assert.deepEqual(plan.docAppend, expectedWithoutFlag, 'overridesBuiltin以外の内容はそのまま');
  // overlay側のuserエントリ自体（plan適用前）は変更されていない＝印を保持する
  assert.equal(overlayFor(CatalogKind.MATERIAL).user[0].overridesBuiltin, true);
  assert.equal(overlayFor(CatalogKind.MATERIAL).user[0], overrideEntry, 'overlayのuserエントリは同一参照のまま（strip対象外）');
});

// ---- applyCatalogEditPlan（1.3: プラン適用） ----
test('applyCatalogEditPlan: removeDocKeyがあればdocから外し、markDirtyが呼ばれる', async () => {
  const prevUser = [];
  const docEntry = material({ code: '301000000001' });
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry], user: prevUser });
  const nextUser = [material({ code: '301000000001', name: '編集後', overridesBuiltin: true })];
  const plan = { nextUser, removeDocKey: '301000000001' };
  let dirtyCalls = 0;
  await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, {
    saveFn: async () => {}, markDirty: () => { dirtyCalls++; }, prevUser,
  });
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).user, nextUser);
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, []);
  assert.equal(dirtyCalls, 1);
});

test('applyCatalogEditPlan: docAppendがあればdocへ追記し、markDirtyが呼ばれる', async () => {
  const prevUser = [material({ code: '301000000099' })];
  setOverlay(CatalogKind.MATERIAL, { user: prevUser });
  const entry = material({ code: '301000000099' });
  const plan = { nextUser: [], docAppend: entry };
  let dirtyCalls = 0;
  await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, {
    saveFn: async () => {}, markDirty: () => { dirtyCalls++; }, prevUser,
  });
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [entry]);
  assert.equal(dirtyCalls, 1);
});

test('applyCatalogEditPlan: removeDocKeyもdocAppendも無ければmarkDirtyは呼ばれない', async () => {
  const prevUser = [];
  const plan = { nextUser: [material({ code: '301000000099' })] };
  let dirtyCalls = 0;
  await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, {
    saveFn: async () => {}, markDirty: () => { dirtyCalls++; }, prevUser,
  });
  assert.equal(dirtyCalls, 0);
});

test('【失敗系】applyCatalogEditPlan: saveFnが失敗するとoverlay(user)はprevUserへ戻り、doc操作は実行されない（markDirtyも呼ばれない）', async () => {
  const prevUser = [material({ code: '301000000001' })];
  const docEntry = material({ code: '301000000001' });
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry], user: prevUser });
  const plan = { nextUser: [material({ code: '301000000001', name: '編集後' })], removeDocKey: '301000000001' };
  let dirtyCalls = 0;
  const saveFn = async () => { throw new Error('保存失敗'); };
  await assert.rejects(
    () => applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn, markDirty: () => { dirtyCalls++; }, prevUser }),
    /保存失敗/,
  );
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).user, prevUser);
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [docEntry], 'docは触られていない');
  assert.equal(dirtyCalls, 0);
});

// ---- QA指摘Nit-1（2026-09-24再報告） ----
test('【QA指摘Nit-1】applyCatalogEditPlan: prevUser省略時は呼び出し時点のoverlayFor(kind).userを既定にする（失敗時にuserが空へ戻る事故を防ぐ）', async () => {
  const existingUser = [material({ code: '301000000001' })];
  setOverlay(CatalogKind.MATERIAL, { user: existingUser });
  const plan = { nextUser: [...existingUser, material({ code: '301000000002', name: '新規' })] };
  const saveFn = async () => { throw new Error('保存失敗'); };
  await assert.rejects(() => applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn }), /保存失敗/);
  assert.deepEqual(
    overlayFor(CatalogKind.MATERIAL).user, existingUser,
    'prevUser省略時、呼び出し時点の既存userへロールバックされる（[]にならない）',
  );
});

// ---- QAスクリプトの正式化（2026-09-24再報告・項目6）: Q-Cの一連（doc-same行の編集）を通しで確認 ----
test('【QC通し】doc-same行の編集: planSaveEntry→applyCatalogEditPlanの後、composeCatalogは編集後の内容・docは空・markDirtyは1回', async () => {
  const builtinEntry = material({ code: '301000000001', name: 'A', thickness: 10 });
  const docEntry = material({ code: '301000000001', name: 'A', thickness: 10 }); // builtinと同内容＝doc-sameの相手
  setOverlay(CatalogKind.MATERIAL, { doc: [docEntry] });
  const editedEntry = { ...docEntry, thickness: 15 };

  const plan = planSaveEntry(CatalogKind.MATERIAL, editedEntry, {
    builtinList: [builtinEntry], rowState: 'doc-same', prevEntry: docEntry,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.removeDocKey, '301000000001');

  let dirtyCalls = 0;
  await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, {
    saveFn: async () => {}, markDirty: () => { dirtyCalls++; }, prevUser: [],
  });

  const resolved = composeCatalog(CatalogKind.MATERIAL, [builtinEntry]);
  assert.equal(resolved.get('301000000001').thickness, 15, '解決結果が編集後の内容になっている');
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [], 'docは空になっている（同梱を外した）');
  assert.equal(dirtyCalls, 1, 'markDirtyは1回だけ');
});

test('【失敗系・QC通し】使用中userの削除（docAppend経路）でsaveFnが失敗すると、user・docともに元へ復元されmarkDirtyは呼ばれない', async () => {
  const userEntry = material({ code: '301000000099', name: 'ユーザー材' });
  setOverlay(CatalogKind.MATERIAL, { user: [userEntry] });
  const plan = planRemoveUserEntry(CatalogKind.MATERIAL, '301000000099', { usedKeys: new Set(['301000000099']) });
  assert.ok(plan.docAppend, '使用中でdocに無いのでdocAppendが立つ前提');

  let dirtyCalls = 0;
  const saveFn = async () => { throw new Error('保存失敗'); };
  await assert.rejects(
    () => applyCatalogEditPlan(CatalogKind.MATERIAL, plan, {
      saveFn, markDirty: () => { dirtyCalls++; }, prevUser: [userEntry],
    }),
    /保存失敗/,
  );
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).user, [userEntry], 'userはprevUserへ復元されている');
  assert.deepEqual(overlayFor(CatalogKind.MATERIAL).doc, [], 'docAppendは実行されていない（saveFn失敗でcommit前に止まる）');
  assert.equal(dirtyCalls, 0, 'markDirtyは呼ばれない');
});

// ---- ステップ12b: materialExtraLockedFields（間柱6コードはx/y/thicknessも固定。Q-B確定）----
test('materialExtraLockedFields: keyがstudCodesに含まれればx/y/thicknessを返す', () => {
  const studCodes = new Set(['101400000001', '101400000002']);
  assert.deepEqual(materialExtraLockedFields('101400000001', studCodes), ['x', 'y', 'thickness']);
});

test('materialExtraLockedFields: keyがstudCodesに含まれなければ空配列', () => {
  const studCodes = new Set(['101400000001']);
  assert.deepEqual(materialExtraLockedFields('301000000001', studCodes), []);
});

test('materialExtraLockedFields: studCodes省略時は常に空配列', () => {
  assert.deepEqual(materialExtraLockedFields('101400000001'), []);
});

// ---- ステップ12c: 下地材開放により間柱6コードのextraLocked（x/y/thickness）が実効化する
// （lockedFieldsFor→planSaveEntry の通し。12bまではbacking行が編集不可だったため到達しなかった経路） ----
test('【失敗系・ステップ12c】planSaveEntry: 間柱コード（studCodes）の下地材行はx/yを変更すると拒否される（materialExtraLockedFields経由）', () => {
  const studCodes = new Set(['101400000005']); // □-90×45（WOOD_STUD_CODE_BY_SIZE['90x45']）
  const prevEntry = buildMaterialEntry({
    code: '101400000005', name: '□-90×45', category: 'backing', x: 90, y: 45, backingClass: 'wood',
  });
  const entry = { ...prevEntry, x: 100 }; // xだけ変更
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [prevEntry], rowState: 'builtin', prevEntry,
    extraLocked: materialExtraLockedFields(prevEntry.code, studCodes),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /Xは変更できません/);
});

test('【失敗系・ステップ12c】planSaveEntry: 間柱コードの下地材行はthicknessを変更しても拒否される', () => {
  const studCodes = new Set(['101400000005']);
  const prevEntry = buildMaterialEntry({
    code: '101400000005', name: '□-90×45', category: 'backing', x: 90, y: 45, thickness: null, backingClass: 'wood',
  });
  const entry = { ...prevEntry, thickness: 30 };
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [prevEntry], rowState: 'builtin', prevEntry,
    extraLocked: materialExtraLockedFields(prevEntry.code, studCodes),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /厚.*変更できません/);
});

test('ステップ12c: 間柱コードの下地材行でもnote（固定対象外の項目）は変更でき、保存できる', () => {
  const studCodes = new Set(['101400000005']);
  const prevEntry = buildMaterialEntry({
    code: '101400000005', name: '□-90×45', category: 'backing', x: 90, y: 45, note: '旧備考', backingClass: 'wood',
  });
  const entry = { ...prevEntry, note: '新備考' };
  const plan = planSaveEntry(CatalogKind.MATERIAL, entry, {
    builtinList: [prevEntry], rowState: 'builtin', prevEntry,
    extraLocked: materialExtraLockedFields(prevEntry.code, studCodes),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, false);
});

// ---- ステップ12b: materialSaveMessage（保存後メッセージの文言選択。Q-C/Q-E確定）----
test('materialSaveMessage: どちらの注記も不要なら「保存しました」のみ', () => {
  assert.equal(materialSaveMessage({}), '保存しました');
  assert.equal(materialSaveMessage(), '保存しました');
});

test('materialSaveMessage: overridesBuiltin:trueは「他の文書は合わせ直すまで変わりません」を括弧書きで添える（Q-C/R3）', () => {
  assert.equal(materialSaveMessage({ overridesBuiltin: true }), '保存しました（他の文書は合わせ直すまで変わりません）');
});

test('materialSaveMessage: thicknessChanged:trueは「壁は次に仕上げモードを出るまで旧い厚みのままです」を括弧書きで添える（Q-E）', () => {
  assert.equal(
    materialSaveMessage({ thicknessChanged: true }),
    '保存しました（壁は次に仕上げモードを出るまで旧い厚みのままです）',
  );
});

test('materialSaveMessage: 両方trueなら「／」で連結する', () => {
  assert.equal(
    materialSaveMessage({ overridesBuiltin: true, thicknessChanged: true }),
    '保存しました（他の文書は合わせ直すまで変わりません／壁は次に仕上げモードを出るまで旧い厚みのままです）',
  );
});

// ---- QA指摘m4（2026-09-24再報告）: materialRowDisabledReason（材料タブのフォーム無効化理由の
// 唯一の判定式。.jsx側で再実装しない） ----
test('materialRowDisabledReason: ステップ12c: categoryが下地材でもeditState.canEditがtrueならnull（下地材の編集開放）', () => {
  const reason = materialRowDisabledReason({ isAdding: false, category: MATERIAL_CATEGORY.BACKING, editState: { canEdit: true, reason: null } });
  assert.equal(reason, null);
});

test('【失敗系】materialRowDisabledReason: 未知のcategoryは最優先で編集不可の理由を返す（origin/editStateに関わらず）', () => {
  const reason = materialRowDisabledReason({ isAdding: false, category: 'unknown', editState: { canEdit: true, reason: null } });
  assert.match(reason, /このカテゴリの材料はここでは編集できません/);
});

test('materialRowDisabledReason: 新規追加（isAdding:true）はcategoryが編集可能ならnull', () => {
  assert.equal(materialRowDisabledReason({ isAdding: true, category: MATERIAL_CATEGORY.PANEL, editState: null }), null);
});

test('materialRowDisabledReason: 既存行はeditState.canEditがtrueならnull', () => {
  const reason = materialRowDisabledReason({
    isAdding: false, category: MATERIAL_CATEGORY.FINISH, editState: { canEdit: true, reason: null },
  });
  assert.equal(reason, null);
});

test('materialRowDisabledReason: 既存行はeditState.canEditがfalseならeditState.reasonを返す', () => {
  const reason = materialRowDisabledReason({
    isAdding: false, category: MATERIAL_CATEGORY.PANEL,
    editState: { canEdit: false, reason: '文書にのみ存在します（複製してください）' },
  });
  assert.equal(reason, '文書にのみ存在します（複製してください）');
});

test('【失敗系】materialRowDisabledReason: editState省略・isAdding:falseはnull（新規追加でも編集でもない想定外を編集不可扱いにする）', () => {
  const reason = materialRowDisabledReason({ isAdding: false, category: MATERIAL_CATEGORY.PANEL });
  assert.equal(reason, null, 'editState省略時はeditState?.canEditがundefinedでeditState?.reasonもundefined→nullへフォールバック');
});

// ---- QA指摘m4（2026-09-24再報告）: removeMessageFor（削除完了メッセージの唯一の判定式） ----
test('removeMessageFor: plan.docAppendがあれば「使用中のため、この文書には同梱として残しました」を含む', () => {
  const msg = removeMessageFor({ docAppend: material({ code: '301000000099' }) });
  assert.equal(msg, '削除しました（使用中のため、この文書には同梱として残しました）');
});

test('removeMessageFor: plan.docAppendが無ければ「削除しました」のみ', () => {
  assert.equal(removeMessageFor({ docAppend: null }), '削除しました');
  assert.equal(removeMessageFor({}), '削除しました');
  assert.equal(removeMessageFor(null), '削除しました');
});

// ---- ステップ10f QA指摘: builtin全件を汎用整形に通しても壊れない（実データ網羅） ----
test('formatReadonlyValue: openingSubTypeBuiltinList()の全件×READONLY項目を通してもクラッシュせず、文字列化できる（[object Object]・undefinedを含まない）', () => {
  const builtin = openingSubTypeBuiltinList();
  assert.ok(builtin.length > 0, 'openingSubTypeBuiltinList()が空');
  const fields = [
    'label', 'category', 'mechanism', 'wallKinds', 'defaultWidth', 'defaultHeight',
    'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout',
  ];
  for (const entry of builtin) {
    for (const field of fields) {
      let text;
      assert.doesNotThrow(() => { text = formatReadonlyValue(entry[field]); }, `${entry.category}:${entry.key} の ${field} でthrowした`);
      assert.equal(typeof text, 'string', `${entry.category}:${entry.key} の ${field} が文字列化されていない`);
      assert.ok(!/\[object/.test(text), `${entry.category}:${entry.key} の ${field} が[object ...]のままになっている: ${text}`);
      assert.ok(!/undefined/.test(text), `${entry.category}:${entry.key} の ${field} にundefinedが出ている: ${text}`);
    }
  }
});

// ---- ステップ12c QA指摘m2（2026-09-24再報告）: backingClassDisplayFor（下地区分selectの表示値） ----
test('backingClassDisplayFor: entryがnullなら空文字', () => {
  assert.equal(backingClassDisplayFor(null, () => 'wood'), '');
});

test('backingClassDisplayFor: entry.backingClassが\'wood\'|\'other\'ならそのまま返す（backingClassOfFnは呼ばれない）', () => {
  let called = false;
  const fn = () => { called = true; return 'other'; };
  assert.equal(backingClassDisplayFor({ code: 'x', backingClass: 'wood' }, fn), 'wood');
  assert.equal(called, false, '明示backingClassがあるときはbackingClassOfFnを呼ばないはず');
});

test('backingClassDisplayFor: entry.backingClassが未設定（本体の下地材）ならbackingClassOfFn(entry.code)の結果を返す（RCも表示できる）', () => {
  const fn = code => (code === '501000000001' ? 'rc' : 'other');
  assert.equal(backingClassDisplayFor({ code: '501000000001' }, fn), 'rc');
});

test('backingClassDisplayFor: entry.backingClassが空文字（未選択）でもbackingClassOfFn経由の値を返す', () => {
  assert.equal(backingClassDisplayFor({ code: 'x', backingClass: '' }, () => 'wood'), 'wood');
});

test('backingClassDisplayFor: backingClassOfFn省略時は空文字', () => {
  assert.equal(backingClassDisplayFor({ code: 'x' }, undefined), '');
});

// ================================================================
// ステップ12f（保守パネル「建具記号」タブ）: 建具記号タブ専用のフォーム純関数。
// ================================================================

function fixtureSymbol(overrides) {
  return { key: 'ZZ', label: 'テスト記号', category: 'fitting', ...overrides };
}

// ---- FIXTURE_SYMBOL_KEY_PATTERN（Q-D確定: 英大文字2〜4文字） ----
test('FIXTURE_SYMBOL_KEY_PATTERN: 英大文字2〜4文字のみ一致する', () => {
  for (const ok of ['AW', 'WD', 'SSF', 'WXYZ']) {
    assert.ok(FIXTURE_SYMBOL_KEY_PATTERN.test(ok), `${ok} は一致するはず`);
  }
  for (const ng of ['A', 'ABCDE', 'aw', 'A1', '', 'AW ', ' AW']) {
    assert.ok(!FIXTURE_SYMBOL_KEY_PATTERN.test(ng), `${JSON.stringify(ng)} は一致しないはず`);
  }
});

// ---- buildFixtureSymbolEntry ----
test('buildFixtureSymbolEntry: 前後の空白をkey/labelから除く', () => {
  const entry = buildFixtureSymbolEntry({ key: ' AW ', label: ' アルミ製窓 ', category: 'window' });
  assert.deepEqual(entry, { key: 'AW', label: 'アルミ製窓', category: 'window' });
});

test('buildFixtureSymbolEntry: frameOnly:falseのときmechanism/profileを持たない（profileを渡しても保存値に持たない）', () => {
  const entry = buildFixtureSymbolEntry({ key: 'AD', label: 'AD', category: 'fitting', frameOnly: false, profile: 'bent' });
  assert.equal('mechanism' in entry, false);
  assert.equal('profile' in entry, false);
});

test('buildFixtureSymbolEntry: frameOnly:trueかつprofile:bentならmechanism:frameOnly・profile:bentを持つ', () => {
  const entry = buildFixtureSymbolEntry({ key: 'TF', label: 'TF', category: 'fitting', frameOnly: true, profile: 'bent' });
  assert.equal(entry.mechanism, FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM);
  assert.equal(entry.profile, 'bent');
});

test('buildFixtureSymbolEntry: frameOnly:trueでもprofileが未指定・不正な値ならprofileを持たない', () => {
  const noProfile = buildFixtureSymbolEntry({ key: 'TF', label: 'TF', category: 'fitting', frameOnly: true });
  assert.equal('profile' in noProfile, false);
  const badProfile = buildFixtureSymbolEntry({ key: 'TF', label: 'TF', category: 'fitting', frameOnly: true, profile: 'bogus' });
  assert.equal('profile' in badProfile, false);
});

test('buildFixtureSymbolEntry: defaultMaterialGlassは空文字ならキー自体を持たない、値があれば前後の空白を除いて持つ', () => {
  const empty = buildFixtureSymbolEntry({ key: 'AW', label: 'AW', category: 'window', defaultMaterialGlass: '  ' });
  assert.equal('defaultMaterialGlass' in empty, false);
  const withGlass = buildFixtureSymbolEntry({ key: 'AW', label: 'AW', category: 'window', defaultMaterialGlass: ' 樹脂 ' });
  assert.equal(withGlass.defaultMaterialGlass, '樹脂');
});

// ---- validateFixtureSymbolForm ----
test('validateFixtureSymbolForm: 追加時は書式（英大文字2〜4文字）を検査し、\'A\'・\'ABCDE\'・\'aw\'・\'A1\'を拒否する', () => {
  for (const key of ['A', 'ABCDE', 'aw', 'A1']) {
    const result = validateFixtureSymbolForm({ key, label: 'x', category: 'fitting' }, { isAdding: true });
    assert.equal(result.ok, false, `key=${key} は拒否されるはず`);
    assert.match(result.message, /英大文字2〜4文字/);
  }
});

test('validateFixtureSymbolForm: 追加時に書式が正しく、allKeys/builtinKeysと重ならなければok:true', () => {
  const result = validateFixtureSymbolForm(
    { key: 'ZZ', label: 'テスト', category: 'fitting' },
    { isAdding: true, allKeys: new Set(['AW', 'WD']), builtinKeys: new Set(['AW', 'WD']) },
  );
  assert.equal(result.ok, true);
});

test('validateFixtureSymbolForm: 追加時にbuiltinKeysと同じキーは「標準を編集してください」', () => {
  const result = validateFixtureSymbolForm(
    { key: 'AW', label: 'x', category: 'window' },
    { isAdding: true, allKeys: new Set(['AW']), builtinKeys: new Set(['AW']) },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /標準を編集してください/);
});

test('validateFixtureSymbolForm: 追加時にallKeysと同じキー（builtinKeysには無い）は重複エラー', () => {
  const result = validateFixtureSymbolForm(
    { key: 'PW', label: 'x', category: 'window' },
    { isAdding: true, allKeys: new Set(['PW']), builtinKeys: new Set() },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /既に使われている記号です/);
});

test('validateFixtureSymbolForm: labelが空なら拒否（追加・編集とも）', () => {
  assert.equal(validateFixtureSymbolForm({ key: 'AW', label: '  ', category: 'window' }, { isAdding: true }).ok, false);
  assert.equal(validateFixtureSymbolForm({ key: 'AW', label: '  ', category: 'window' }, { isAdding: false }).ok, false);
});

test('validateFixtureSymbolForm: categoryがfitting/window以外なら拒否', () => {
  const result = validateFixtureSymbolForm({ key: 'AW', label: 'x', category: 'other' }, { isAdding: true, allKeys: new Set() });
  assert.equal(result.ok, false);
  assert.match(result.message, /区分/);
});

test('validateFixtureSymbolForm: 編集時（isAdding:false）は書式・重複を検査しない（既存キーの小文字化も拒否しない）', () => {
  const result = validateFixtureSymbolForm({ key: 'aw', label: 'x', category: 'window' }, { isAdding: false });
  assert.equal(result.ok, true, '編集時はkeyの書式検査対象外（固定項目検査はplanSaveEntry側の責務）');
});

// ---- fixtureSymbolFormFieldsFor（QA指摘M1・2026-09-24再報告で修正: 引数はパネルのフォームが
// 実際に持つ形{frameOnly:boolean}——mechanism（エントリの形）ではない） ----
test('fixtureSymbolFormFieldsFor: パネルのフォーム形{frameOnly:true}のときだけshowProfile:true', () => {
  assert.equal(fixtureSymbolFormFieldsFor({ frameOnly: true }).showProfile, true);
  assert.equal(fixtureSymbolFormFieldsFor({ frameOnly: false }).showProfile, false);
  assert.equal(fixtureSymbolFormFieldsFor({}).showProfile, false);
  assert.equal(fixtureSymbolFormFieldsFor(null).showProfile, false);
});

test('【失敗系】fixtureSymbolFormFieldsFor: エントリの形（mechanism:FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM）を渡してもshowProfile:false（フォーム形専用であることの固定）', () => {
  assert.equal(fixtureSymbolFormFieldsFor({ mechanism: FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM }).showProfile, false);
});

// ---- catalogSaveMessage（materialSaveMessageの一般化）----
test('catalogSaveMessage: kind=FIXTURE_SYMBOLはoverridesBuiltin:trueのときだけ注記が付く（thicknessChangedはmaterial専用なので無視される）', () => {
  assert.equal(catalogSaveMessage(CatalogKind.FIXTURE_SYMBOL, {}), '保存しました');
  assert.equal(
    catalogSaveMessage(CatalogKind.FIXTURE_SYMBOL, { overridesBuiltin: true }),
    '保存しました（他の文書は合わせ直すまで変わりません）',
  );
  assert.equal(
    catalogSaveMessage(CatalogKind.FIXTURE_SYMBOL, { overridesBuiltin: true, thicknessChanged: true }),
    '保存しました（他の文書は合わせ直すまで変わりません）',
    'FIXTURE_SYMBOLはthicknessを持たないためthicknessChangedは無視されるはず',
  );
});

test('catalogSaveMessage: materialSaveMessageはcatalogSaveMessage(CatalogKind.MATERIAL, …)と同じ結果になる（委譲の確認）', () => {
  for (const args of [{}, { overridesBuiltin: true }, { thicknessChanged: true }, { overridesBuiltin: true, thicknessChanged: true }]) {
    assert.equal(materialSaveMessage(args), catalogSaveMessage(CatalogKind.MATERIAL, args));
  }
});

// ---- fixtureSymbolRowDisabledReason ----
test('fixtureSymbolRowDisabledReason: 新規追加（isAdding:true）は常にnull', () => {
  assert.equal(fixtureSymbolRowDisabledReason({ isAdding: true, editState: { canEdit: false, reason: 'x' } }), null);
});

test('fixtureSymbolRowDisabledReason: editState.canEdit:trueはnull、falseはeditState.reasonを返す', () => {
  assert.equal(fixtureSymbolRowDisabledReason({ isAdding: false, editState: { canEdit: true, reason: null } }), null);
  assert.equal(
    fixtureSymbolRowDisabledReason({ isAdding: false, editState: { canEdit: false, reason: '文書にのみ存在します（複製してください）' } }),
    '文書にのみ存在します（複製してください）',
  );
});

test('【失敗系】fixtureSymbolRowDisabledReason: editState省略・isAdding:falseはnull', () => {
  assert.equal(fixtureSymbolRowDisabledReason({ isAdding: false }), null);
  assert.equal(fixtureSymbolRowDisabledReason(), null);
});

// ---- collectKnownCatalogKeys ----
test('collectKnownCatalogKeys: builtin・user・docの全キーを合成して返す（重複は1件に畳む）', () => {
  const builtin = [fixtureSymbol({ key: 'AW' }), fixtureSymbol({ key: 'WD' })];
  try {
    setOverlay(CatalogKind.FIXTURE_SYMBOL, {
      user: [fixtureSymbol({ key: 'PW' })],
      doc: [fixtureSymbol({ key: 'QX' }), fixtureSymbol({ key: 'AW' })], // AWはbuiltinと重複
    });
    const keys = collectKnownCatalogKeys(CatalogKind.FIXTURE_SYMBOL, builtin);
    assert.deepEqual([...keys].sort(), ['AW', 'PW', 'QX', 'WD']);
  } finally {
    clearOverlays();
  }
});

test('collectKnownCatalogKeys: overlayが空ならbuiltinのキーのみ', () => {
  const builtin = [fixtureSymbol({ key: 'AW' }), fixtureSymbol({ key: 'WD' })];
  assert.deepEqual([...collectKnownCatalogKeys(CatalogKind.FIXTURE_SYMBOL, builtin)].sort(), ['AW', 'WD']);
});

// ---- rowEditState(FIXTURE_SYMBOL, …): builtin行は上書き可・user行は削除可（設計「5. 検証」） ----
test('rowEditState(FIXTURE_SYMBOL): builtin行はcanEdit:true・canRevert:false・canDelete:false（上書きは編集経由）', () => {
  const builtin = [fixtureSymbol({ key: 'AW' })];
  const row = { entry: fixtureSymbol({ key: 'AW' }), origin: 'builtin', diff: null };
  const state = rowEditState(CatalogKind.FIXTURE_SYMBOL, row, { builtinKeys: new Set(builtin.map(e => e.key)) });
  assert.equal(state.state, 'builtin');
  assert.equal(state.canEdit, true);
  assert.equal(state.canRevert, false);
  assert.equal(state.canDelete, false);
});

test('rowEditState(FIXTURE_SYMBOL): builtinに無いuser行はcanDelete:true（標準の上書きではない新規追加行）', () => {
  const row = { entry: fixtureSymbol({ key: 'PW' }), origin: 'user', diff: null };
  const state = rowEditState(CatalogKind.FIXTURE_SYMBOL, row, { builtinKeys: new Set(['AW', 'WD']) });
  assert.equal(state.state, 'user');
  assert.equal(state.canDelete, true);
  assert.equal(state.canRevert, false);
});

test('rowEditState(FIXTURE_SYMBOL): builtinと同キーのuser行（標準の上書き）はoverride状態でcanRevert:true・canDelete:false', () => {
  const row = { entry: fixtureSymbol({ key: 'AW', overridesBuiltin: true }), origin: 'user', diff: null };
  const state = rowEditState(CatalogKind.FIXTURE_SYMBOL, row, { builtinKeys: new Set(['AW']) });
  assert.equal(state.state, 'override');
  assert.equal(state.canRevert, true);
  assert.equal(state.canDelete, false);
});

// ---- planSaveEntry(FIXTURE_SYMBOL, …): key/category/mechanismが固定 ----
test('planSaveEntry(FIXTURE_SYMBOL): 既存行のcategoryを変えると拒否される（固定項目）', () => {
  const prevEntry = fixtureSymbol({ key: 'AW', category: 'window' });
  const entry = { ...prevEntry, category: 'fitting' };
  const result = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
  assert.equal(result.ok, false);
  assert.equal(result.message, lockedFieldReason(CatalogKind.FIXTURE_SYMBOL, 'category'));
});

test('planSaveEntry(FIXTURE_SYMBOL): 既存行のmechanism（三方枠専用の有無）を変えると拒否される（固定項目）', () => {
  const prevEntry = fixtureSymbol({ key: 'WF', category: 'fitting', mechanism: FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM, profile: 'solid' });
  const entry = { key: 'WF', label: prevEntry.label, category: 'fitting' }; // mechanismを外す
  const result = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
  assert.equal(result.ok, false);
  assert.equal(result.message, lockedFieldReason(CatalogKind.FIXTURE_SYMBOL, 'mechanism'));
});

test('planSaveEntry(FIXTURE_SYMBOL): 既存行のkeyを変えると拒否される（複製してください）', () => {
  const prevEntry = fixtureSymbol({ key: 'AW', category: 'window' });
  const entry = { ...prevEntry, key: 'BW' };
  const result = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
  assert.equal(result.ok, false);
  assert.match(result.message, /複製してください/);
});

test('planSaveEntry(FIXTURE_SYMBOL): label・profile・defaultMaterialGlassの変更はbuiltin行でも通り、overridesBuiltin:trueが付く', () => {
  const prevEntry = fixtureSymbol({ key: 'AW', category: 'window', label: 'AW（アルミ製窓）' });
  const entry = { ...prevEntry, label: 'AW（変更後）', defaultMaterialGlass: 'アルミ（変更）' };
  const result = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
  assert.equal(result.ok, true);
  assert.equal(result.overridesBuiltin, true);
  assert.equal(result.nextUser[0].overridesBuiltin, true);
  assert.equal(result.nextUser[0].label, 'AW（変更後）');
});

test('planSaveEntry(FIXTURE_SYMBOL): 三方枠でない記号にprofileを付けて保存しても、builtinList照合には影響しない（三方枠でない記号のprofileは意味を持たない）', () => {
  const prevEntry = fixtureSymbol({ key: 'AD', category: 'fitting', label: 'AD' });
  const entry = { ...prevEntry, label: 'AD（変更）' };
  const result = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, { builtinList: [prevEntry], rowState: 'builtin', prevEntry });
  assert.equal(result.ok, true);
  assert.equal('profile' in result.nextUser[0], false);
});

// ---- QA指摘m3（2026-09-24再報告）: fixtureSymbolFormFromEntry ⇄ buildFixtureSymbolEntry往復 ----
test('fixtureSymbolFormFromEntry ⇄ buildFixtureSymbolEntry: WF・SF・AW（builtin）とuser TFで往復してもエントリが一致する', () => {
  const builtin = fixtureSymbolBuiltinList();
  const wf = builtin.find(e => e.key === 'WF');
  const sf = builtin.find(e => e.key === 'SF');
  const aw = builtin.find(e => e.key === 'AW');
  assert.ok(wf && sf && aw, '前提: builtinにWF/SF/AWが存在する');
  const userTf = {
    key: 'TF', label: 'TF（試験用三方枠）', category: 'fitting',
    mechanism: FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM, profile: 'bent',
  };
  for (const entry of [wf, sf, aw, userTf]) {
    const roundTripped = buildFixtureSymbolEntry(fixtureSymbolFormFromEntry(entry));
    assert.deepEqual(roundTripped, entry, `${entry.key} が往復で元のエントリと一致しない`);
  }
});

test('fixtureSymbolFormFromEntry: entryのmechanism/profile/defaultMaterialGlassが未設定ならフォームでは空文字・frameOnly:falseになる', () => {
  const form = fixtureSymbolFormFromEntry({ key: 'AD', label: 'AD', category: 'fitting' });
  assert.deepEqual(form, { key: 'AD', label: 'AD', category: 'fitting', frameOnly: false, profile: '', defaultMaterialGlass: '' });
});

// ---- QA指摘m4（2026-09-24再報告）: fixtureSymbolPreviewEntry ----
test('fixtureSymbolPreviewEntry: keyが空（追加時未入力）なら\'?\'へ置き換える', () => {
  const entry = fixtureSymbolPreviewEntry({ key: '  ', label: 'x', category: 'fitting' });
  assert.equal(entry.key, '?');
});

test('fixtureSymbolPreviewEntry: keyがあればbuildFixtureSymbolEntryの結果そのまま（\'?\'へ置き換えない）', () => {
  const entry = fixtureSymbolPreviewEntry({ key: 'ZZ', label: 'x', category: 'fitting', frameOnly: true, profile: 'bent' });
  assert.deepEqual(entry, { key: 'ZZ', label: 'x', category: 'fitting', mechanism: FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM, profile: 'bent' });
});

// ---- QA指摘n8（2026-09-24再報告）: categoryOptionsFor・FIXTURE_SYMBOL_PROFILES ----
test('categoryOptionsFor(FIXTURE_SYMBOL): {value,label}[]でfitting/windowの2件（formatCategoryLabelと同じ表から導出）', () => {
  const options = categoryOptionsFor(CatalogKind.FIXTURE_SYMBOL);
  assert.deepEqual(options, [{ value: 'fitting', label: '建具' }, { value: 'window', label: '窓' }]);
  for (const opt of options) {
    assert.equal(formatCategoryLabel(CatalogKind.FIXTURE_SYMBOL, opt.value), opt.label, `${opt.value}: formatCategoryLabelと一致しない`);
  }
});

test('categoryOptionsFor: 対応表を持たないkind（例: SECTION）は空配列', () => {
  assert.deepEqual(categoryOptionsFor(CatalogKind.SECTION), []);
});

test('FIXTURE_SYMBOL_PROFILES: buildFixtureSymbolEntryが受け付けるprofile値と同じ集合（solid・bent）', () => {
  assert.deepEqual([...FIXTURE_SYMBOL_PROFILES], ['solid', 'bent']);
  for (const profile of FIXTURE_SYMBOL_PROFILES) {
    const entry = buildFixtureSymbolEntry({ key: 'ZZ', label: 'x', category: 'fitting', frameOnly: true, profile });
    assert.equal(entry.profile, profile, `profile=${profile}がbuildFixtureSymbolEntryへ通らない`);
  }
  const rejected = buildFixtureSymbolEntry({ key: 'ZZ', label: 'x', category: 'fitting', frameOnly: true, profile: 'bogus' });
  assert.equal('profile' in rejected, false, 'FIXTURE_SYMBOL_PROFILESに無い値は保存されないはず');
});

// ================================================================
// ステップ12g（内装マスター（全操作＋標準の上書き）と断面（呼称の編集・標準の上書き・
// userの削除）を編集タブにする）: InteriorMasterTab・SectionTab専用のフォーム純関数。
// ================================================================

// ---- nextInteriorMasterKey（設計「keyはUSER_1…から未使用の最小番号を自動採番」） ----
test('nextInteriorMasterKey: allKeysが空なら\'USER_1\'', () => {
  assert.equal(nextInteriorMasterKey(new Set()), 'USER_1');
});

test('nextInteriorMasterKey: USER_1が使用済みなら\'USER_2\'', () => {
  assert.equal(nextInteriorMasterKey(new Set(['USER_1'])), 'USER_2');
});

test('nextInteriorMasterKey: 欠番（USER_1・USER_3使用済み）は最小の空きUSER_2を返す', () => {
  assert.equal(nextInteriorMasterKey(new Set(['USER_1', 'USER_3'])), 'USER_2');
});

test('nextInteriorMasterKey: builtinのキー（USER_連番の書式に一致しないもの）は無視される', () => {
  assert.equal(nextInteriorMasterKey(new Set(['LIVING_ROOM', 'RESTROOM'])), 'USER_1');
});

test('【失敗系】nextInteriorMasterKey: USER_連番の書式に一致しない紛らわしいキー（USER_2x等）は無視され採番に影響しない', () => {
  assert.equal(nextInteriorMasterKey(new Set(['USER_2x', 'USER_1'])), 'USER_2');
});

// ---- interiorMasterFormFromEntry ⇄ buildInteriorMasterEntry ----
test('interiorMasterFormFromEntry ⇄ buildInteriorMasterEntry: 本体の内装マスター全件で往復してもエントリが一致する', () => {
  const builtin = interiorMasterBuiltinList({ INTERIOR_MASTERS });
  assert.ok(builtin.length > 0, '前提: INTERIOR_MASTERSは1件以上あるはず');
  for (const entry of builtin) {
    const roundTripped = buildInteriorMasterEntry(interiorMasterFormFromEntry(entry));
    assert.deepEqual(roundTripped, entry, `key=${entry.key}の往復が一致しない`);
  }
});

test('interiorMasterFormFromEntry: ceilingHeightが未設定（null/undefined）ならフォームでは空文字になる', () => {
  assert.equal(interiorMasterFormFromEntry({ key: 'X', label: 'x', wallMaterial: '', wallFinish: '' }).ceilingHeight, '');
  assert.equal(interiorMasterFormFromEntry({ key: 'X', label: 'x', ceilingHeight: null }).ceilingHeight, '');
});

test('buildInteriorMasterEntry: key/label/wallMaterial/wallFinishの前後の空白を除く', () => {
  const entry = buildInteriorMasterEntry({
    key: ' USER_1 ', label: ' 予備室 ', wallMaterial: ' 301000000002 ', wallFinish: ' 302000000001 ', ceilingHeight: '2400',
  });
  assert.deepEqual(entry, {
    key: 'USER_1', label: '予備室', wallMaterial: '301000000002', wallFinish: '302000000001', ceilingHeight: 2400,
  });
});

test('【失敗系】buildInteriorMasterEntry: ceilingHeightが空文字（トリム後）ならNaN（validateInteriorMasterForm側で拒否する）', () => {
  const entry = buildInteriorMasterEntry({ key: 'USER_1', label: 'x', wallMaterial: 'a', wallFinish: 'b', ceilingHeight: '  ' });
  assert.ok(Number.isNaN(entry.ceilingHeight));
});

// ---- validateInteriorMasterForm ----
function interiorMasterForm(overrides) {
  return {
    key: 'USER_1', label: '予備室', wallMaterial: '301000000002', wallFinish: '302000000001', ceilingHeight: '2400',
    ...overrides,
  };
}

// QA指摘M1（12g再報告）: interiorMasterForm()の既定wallMaterial/wallFinishが材料カタログに
// 実在する体でmaterialKeysを組み立てる（他のテストが意図した検査（キー重複・ceilingHeight等）へ
// 到達できるように——materialKeys省略時は「材料カタログ未読込み」で必ず拒否されるため）。
const INTERIOR_MASTER_MATERIAL_KEYS = new Set(['301000000002', '302000000001']);

test('validateInteriorMasterForm: 呼称が空なら拒否（追加・編集とも）', () => {
  assert.equal(validateInteriorMasterForm(interiorMasterForm({ label: '  ' }), { isAdding: true }).ok, false);
  assert.equal(validateInteriorMasterForm(interiorMasterForm({ label: '  ' }), { isAdding: false }).ok, false);
});

test('【失敗系】validateInteriorMasterForm: wallMaterialが12桁数字でなければ拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ wallMaterial: 'クロス' }), { isAdding: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /壁材は材料コード（12桁数字）/);
});

test('【失敗系】validateInteriorMasterForm: wallFinishが12桁数字でなければ拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ wallFinish: '123' }), { isAdding: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /壁仕上げは材料コード（12桁数字）/);
});

test('【失敗系】validateInteriorMasterForm: ceilingHeightが0以下・NaNなら拒否', () => {
  for (const ceilingHeight of ['0', '-100', 'abc', '']) {
    const result = validateInteriorMasterForm(interiorMasterForm({ ceilingHeight }), { isAdding: false });
    assert.equal(result.ok, false, `ceilingHeight=${ceilingHeight}`);
    assert.match(result.message, /天井高は0より大きい数値/, `ceilingHeight=${ceilingHeight}`);
  }
});

test('validateInteriorMasterForm: 有効な入力（編集時）はok:true', () => {
  assert.equal(
    validateInteriorMasterForm(interiorMasterForm(), { isAdding: false, materialKeys: INTERIOR_MASTER_MATERIAL_KEYS }).ok,
    true,
  );
});

test('【失敗系】validateInteriorMasterForm: 追加時にbuiltinKeysと同じキーは拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ key: 'LIVING_ROOM' }), {
    isAdding: true, builtinKeys: new Set(['LIVING_ROOM']), allKeys: new Set(['LIVING_ROOM']),
    materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /既に使われているキーです/);
});

test('【失敗系】validateInteriorMasterForm: 追加時にallKeysと同じキー（builtinKeysには無い＝ユーザー追加分と衝突）は拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ key: 'USER_1' }), {
    isAdding: true, builtinKeys: new Set(), allKeys: new Set(['USER_1']), materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /既に使われているキーです: USER_1/);
});

test('validateInteriorMasterForm: 追加時に未使用キーならok:true', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ key: 'USER_2' }), {
    isAdding: true, builtinKeys: new Set(['LIVING_ROOM']), allKeys: new Set(['LIVING_ROOM', 'USER_1']),
    materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, true);
});

test('【失敗系】validateInteriorMasterForm: 追加時にキーが空（割り当て漏れ）なら拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ key: '  ' }), {
    isAdding: true, materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /キーが割り当てられていません/);
});

test('validateInteriorMasterForm: 編集時（isAdding:false）はキーの重複検査をしない', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ key: 'LIVING_ROOM' }), {
    isAdding: false, builtinKeys: new Set(['LIVING_ROOM']), allKeys: new Set(['LIVING_ROOM']),
    materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, true);
});

// ---- QA指摘M1（12g再報告・リード裁定「拒否」）: materialKeys（材料カタログの実在検査） ----
test('【失敗系・QA指摘M1】validateInteriorMasterForm: 12桁だがmaterialKeysに無いwallFinishは拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ wallFinish: '999999999999' }), {
    isAdding: false, materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /壁仕上げは材料カタログに無いコードです/);
});

test('【失敗系・QA指摘M1】validateInteriorMasterForm: 12桁だがmaterialKeysに無いwallMaterialは拒否', () => {
  const result = validateInteriorMasterForm(interiorMasterForm({ wallMaterial: '999999999999' }), {
    isAdding: false, materialKeys: INTERIOR_MASTER_MATERIAL_KEYS,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /壁材は材料カタログに無いコードです/);
});

test('【失敗系・QA指摘M1】validateInteriorMasterForm: materialKeys未指定（null）は保存不可の理由を返す', () => {
  const result = validateInteriorMasterForm(interiorMasterForm(), { isAdding: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /材料カタログが読み込まれていません/);
});

test('【失敗系・QA指摘M1】validateInteriorMasterForm: materialKeysを省略した既定呼び出し（isAddingのみ指定）も保存不可になる', () => {
  // 前提確認: interiorMasterForm()自体は他の検査（呼称・書式・天井高）をすべて満たす有効な入力
  // ——materialKeys省略が「他の検査に埋もれず」単独で拒否理由になることを固定する。
  const result = validateInteriorMasterForm(interiorMasterForm(), { isAdding: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /材料カタログが読み込まれていません/);
});

// ---- interiorMasterRowDisabledReason ----
test('interiorMasterRowDisabledReason: 新規追加（isAdding:true）は常にnull', () => {
  assert.equal(interiorMasterRowDisabledReason({ isAdding: true, editState: { canEdit: false, reason: 'x' } }), null);
});

test('interiorMasterRowDisabledReason: editState.canEdit:trueはnull、falseはeditState.reasonを返す', () => {
  assert.equal(interiorMasterRowDisabledReason({ isAdding: false, editState: { canEdit: true, reason: null } }), null);
  assert.equal(
    interiorMasterRowDisabledReason({ isAdding: false, editState: { canEdit: false, reason: '文書にのみ存在します（複製してください）' } }),
    '文書にのみ存在します（複製してください）',
  );
});

test('【失敗系】interiorMasterRowDisabledReason: editState省略・isAdding:falseはnull', () => {
  assert.equal(interiorMasterRowDisabledReason({ isAdding: false }), null);
  assert.equal(interiorMasterRowDisabledReason(), null);
});

// ---- QA指摘M1（12g再報告）: materialListLoaded（材料カタログの読込み状態）----
test('【失敗系・QA指摘M1】interiorMasterRowDisabledReason: materialListLoaded:falseはisAdding:true・editState.canEdit:trueでも保存不可の理由を返す', () => {
  assert.match(
    interiorMasterRowDisabledReason({ isAdding: true, materialListLoaded: false }),
    /材料カタログを読み込んでいます/,
  );
  assert.match(
    interiorMasterRowDisabledReason({ isAdding: false, editState: { canEdit: true, reason: null }, materialListLoaded: false }),
    /材料カタログを読み込んでいます/,
  );
});

test('interiorMasterRowDisabledReason: materialListLoaded省略時は既定true（従来どおりisAdding/editStateだけで判定する）', () => {
  assert.equal(interiorMasterRowDisabledReason({ isAdding: true }), null);
  assert.equal(interiorMasterRowDisabledReason({ isAdding: false, editState: { canEdit: true, reason: null } }), null);
});

// ---- rowEditState(INTERIOR_MASTER): keyBoundFieldsはkeyのみ（他項目は全て編集可） ----
test('rowEditState(INTERIOR_MASTER)/lockedFieldsFor: keyのみ固定（label/wallMaterial/wallFinish/ceilingHeightは編集可）', () => {
  const builtin = [{ key: 'LIVING_ROOM', label: '居室', wallMaterial: 'a', wallFinish: 'b', ceilingHeight: 2700 }];
  const row = { entry: builtin[0], origin: 'builtin', diff: null };
  const state = rowEditState(CatalogKind.INTERIOR_MASTER, row, { builtinKeys: new Set(['LIVING_ROOM']) });
  assert.equal(state.state, 'builtin');
  assert.equal(state.canEdit, true);
  const locked = lockedFieldsFor(CatalogKind.INTERIOR_MASTER, 'LIVING_ROOM', { builtinKeys: new Set(['LIVING_ROOM']) });
  assert.deepEqual([...locked], ['key']);
});

// ---- sectionFormFromEntry ⇄ buildSectionEntry（設計「断面は元entryをそのままlabel以外」）----
test('sectionFormFromEntry: {key,label}のみを持つ', () => {
  const entry = sectionEntry({ label: 'H-200×100×5.5×8' });
  assert.deepEqual(sectionFormFromEntry(entry), { key: 'STEEL-H200x100', label: 'H-200×100×5.5×8' });
});

test('buildSectionEntry: prevEntryをそのまま複製し、labelだけフォーム値へ差し替える', () => {
  const prevEntry = sectionEntry();
  const entry = buildSectionEntry(prevEntry, { label: '新しい呼称' });
  assert.deepEqual(entry, { ...prevEntry, label: '新しい呼称' });
});

test('buildSectionEntry: labelの前後の空白を除く', () => {
  const prevEntry = sectionEntry();
  const entry = buildSectionEntry(prevEntry, { label: '  新しい呼称  ' });
  assert.equal(entry.label, '新しい呼称');
});

test('sectionFormFromEntry ⇄ buildSectionEntry: 呼称を変えずに往復するとprevEntryと完全一致する', () => {
  const prevEntry = sectionEntry();
  const roundTripped = buildSectionEntry(prevEntry, sectionFormFromEntry(prevEntry));
  assert.deepEqual(roundTripped, prevEntry);
});

test('【失敗系】buildSectionEntry: フォームに寸法系（width等）を混ぜても保存値には反映されない（prevEntryの値のまま）', () => {
  const prevEntry = sectionEntry({ width: 100 });
  const entry = buildSectionEntry(prevEntry, { label: prevEntry.label, width: 9999 });
  assert.equal(entry.width, 100, 'buildSectionEntryはlabel以外をフォームから受け取らない設計のはず');
});

// ---- validateSectionForm ----
test('validateSectionForm: 呼称が空なら拒否', () => {
  const result = validateSectionForm({ label: '  ' });
  assert.equal(result.ok, false);
  assert.match(result.message, /呼称を入力してください/);
});

test('validateSectionForm: 呼称があればok:true', () => {
  assert.equal(validateSectionForm({ label: 'H-200×100×5.5×8' }).ok, true);
});

// ---- sectionRowDisabledReason ----
test('sectionRowDisabledReason: editState.canEdit:trueはnull、falseはeditState.reasonを返す', () => {
  assert.equal(sectionRowDisabledReason({ isAdding: false, editState: { canEdit: true, reason: null } }), null);
  assert.equal(
    sectionRowDisabledReason({ isAdding: false, editState: { canEdit: false, reason: '文書の内容が本体と異なります。合わせ直すか複製してください' } }),
    '文書の内容が本体と異なります。合わせ直すか複製してください',
  );
});

test('【失敗系】sectionRowDisabledReason: editState省略・isAdding:falseはnull', () => {
  assert.equal(sectionRowDisabledReason({ isAdding: false }), null);
  assert.equal(sectionRowDisabledReason(), null);
});

// ---- QA指摘M2（12g再報告）: doc-only/doc-diffは断面タブ専用の文言（複製・合わせ直しの案内をしない） ----
test('【失敗系・QA指摘M2】sectionRowDisabledReason: editState.state===\'doc-only\'は断面専用文言（rowEditStateの既定reasonではない）', () => {
  const result = sectionRowDisabledReason({
    isAdding: false, editState: { canEdit: false, state: 'doc-only', reason: '文書にのみ存在します（複製してください）' },
  });
  assert.equal(result, '文書にのみ存在する断面です。呼称は変更できません');
  assert.notEqual(result, '文書にのみ存在します（複製してください）', '断面タブに無い「複製してください」の案内を出してはいけない');
});

test('【失敗系・QA指摘M2】sectionRowDisabledReason: editState.state===\'doc-diff\'は断面専用文言（rowEditStateの既定reasonではない）', () => {
  const result = sectionRowDisabledReason({
    isAdding: false,
    editState: { canEdit: false, state: 'doc-diff', reason: '文書の内容が本体と異なります。合わせ直すか複製してください' },
  });
  assert.equal(result, '文書の内容が本体と異なる断面です。呼称は変更できません');
  assert.notEqual(
    result, '文書の内容が本体と異なります。合わせ直すか複製してください',
    '断面タブに無い「合わせ直すか複製」の案内を出してはいけない',
  );
});

// ---- planSaveEntry(SECTION)経由の統合確認: 断面はlabelの上書き・編集が通り、builtin同キーは
// overridesBuiltin:trueが付く（fixtureSymbolの同種テストと同型）----
test('planSaveEntry(SECTION): labelの変更はbuiltin行でも通り、overridesBuiltin:trueが付く', () => {
  const prevEntry = sectionEntry();
  const entry = buildSectionEntry(prevEntry, { label: '新しい呼称' });
  const result = planSaveEntry(CatalogKind.SECTION, entry, {
    builtinList: [prevEntry], rowState: 'builtin', prevEntry,
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextUser[0].overridesBuiltin, true);
  assert.equal(result.nextUser[0].label, '新しい呼称');
});
