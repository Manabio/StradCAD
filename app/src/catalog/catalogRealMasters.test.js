// 実マスタとの整合テスト（指示書「必須テスト」の追加1本）。
// 本体標準マスタ（finish/materials/materialData.js 等）が catalogKinds.js の登録表の
// validate/dedupeFields をそのまま通るかを確認する。5種別すべて kindDef(kind).loadBuiltin()
// （動的importのthunk）を実際に呼び、node:test から単体で本体マスタへ到達できることも兼ねて確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  kindDef, listKinds, CatalogKind, KNOWN_OPENING_MECHANISMS,
  OPENING_MECHANISM_CONST_NAMES, SECTION_SHAPE_CONST_NAMES,
} from './catalogKinds.js';
import { valuesEqual, matchByContent } from './catalogMatch.js';
import { withEntries, emptyBundle, validateBundle, resolveCatalog } from './catalogBundle.js';
import { composeCatalog } from './catalogRegistry.js';
import { collectUsedKeys, collectUsedMaterialCodes, expandTransitiveMaterials, buildDocumentBundle } from './usedEntries.js';
import { MATERIALS } from '../finish/materials/materialData.js';
import { INTERIOR_MASTERS } from '../finish/materials/interiorMasters.js';
import { OpeningMechanism, IMPLEMENTED_MECHANISMS } from '../openings/openingCatalog.js';
import { SectionShape, SECTION_CATALOG } from '../structural/sectionCatalog.js';
import {
  FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM,
  OPENING_SUB_TYPE_SWING_CHILD_MECHANISM, OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM,
  OPENING_SUB_TYPE_FIRE_FOLD_MECHANISM, OPENING_SUB_TYPE_SLIDE_LAYOUT_MECHANISM,
  formatCatalogSourceLine,
} from './catalogMaintenance.js';

// ステップ3（2026-09-22）で振り直し済み。旧132件のうち廃止・削除2件（アスファルトプライマー・
// 吸音テックス用捨て糊。legacyMaterialCodes.js の REMOVED_MATERIALS）を除いた130件。
test('MATERIALS: 130件（旧132件−廃止・削除2件。振り直し済み・新体系）', () => {
  assert.equal(MATERIALS.length, 130);
});

test('MATERIALS: 全件がmaterial.validateを通る', () => {
  const def = kindDef('material');
  for (const m of MATERIALS) assert.doesNotThrow(() => def.validate(m), `code=${m.code} name=${m.name}`);
});

test('MATERIALS: dedupeFields（name,spec,x,y,thickness）の重複が無い（categoryを跨いでも）', () => {
  const def = kindDef('material');
  const fields = def.dedupeFields;
  for (let i = 0; i < MATERIALS.length; i++) {
    for (let j = i + 1; j < MATERIALS.length; j++) {
      const dup = fields.every(f => valuesEqual(MATERIALS[i][f], MATERIALS[j][f]));
      assert.equal(dup, false, `重複: ${MATERIALS[i].code}(${MATERIALS[i].name}) / ${MATERIALS[j].code}(${MATERIALS[j].name})`);
    }
  }
});

test('material.loadBuiltin(): 動的importでMATERIALSと同じ内容を取得できる', async () => {
  const entries = await kindDef('material').loadBuiltin();
  assert.equal(entries.length, MATERIALS.length);
  assert.equal(entries, MATERIALS); // 同一モジュールを再import（thunk）= 同一配列参照
});

// ---- (d) 他4種別の本体マスタも各validateを通る ----
test('section: SECTION_CATALOG全件がsection.validateを通る', async () => {
  const def = kindDef('section');
  const entries = await def.loadBuiltin();
  assert.ok(entries.length > 0);
  for (const s of entries) assert.doesNotThrow(() => def.validate(s), `key=${s.key}`);
});

test('openingSubType: FITTING_CATALOG/WINDOW_CATALOG全件がopeningSubType.validateを通る', async () => {
  const def = kindDef('openingSubType');
  const entries = await def.loadBuiltin();
  assert.ok(entries.length > 0);
  for (const o of entries) assert.doesNotThrow(() => def.validate(o), `category=${o.category} key=${o.key}`);
});

// ステップ10d: catalogKinds.js は openings/openingCatalog.js を静的importできない
// （catalogImports.test.js の許可リスト）ため、isSupportedフックが参照する既知mechanismの
// 凍結配列（KNOWN_OPENING_MECHANISMS）を独自に複製している。本テストは実マスタ
// （OpeningMechanism）を静的importしてよい立場から、両者の値集合が一致することを固定する
// ——ずれると新設/削除したmechanismがisSupported判定から漏れる（過検出・過剰弾き）。
test('KNOWN_OPENING_MECHANISMS: catalogKinds.jsの複製配列がOpeningMechanismの値集合と一致する', () => {
  assert.deepEqual(new Set(KNOWN_OPENING_MECHANISMS), new Set(Object.values(OpeningMechanism)));
});

// Minor-2（QA指摘・2026-09-23）: KNOWN_OPENING_MECHANISMSがOpeningMechanism全体とだけ一致していても、
// IMPLEMENTED_MECHANISMS（平面記号を実装済みの機構。openingCatalog.js）からずれていれば、
// isSupported=trueなのに描画は未実装のティック（openingElevationFigure.js既定分岐）へ無言で
// 縮退する退行になる——両者が一致することも合わせて固定する（新設enumをKNOWN側にだけ足す漏れを防ぐ）。
test('KNOWN_OPENING_MECHANISMS: IMPLEMENTED_MECHANISMS（平面記号実装済み）とも値集合が一致する', () => {
  assert.deepEqual(new Set(KNOWN_OPENING_MECHANISMS), IMPLEMENTED_MECHANISMS);
});

// Nit-2: KNOWN_OPENING_MECHANISMSの手書き配列に重複が無いこと（コピペミスの検出）。
test('KNOWN_OPENING_MECHANISMS: 配列内に重複が無い', () => {
  assert.equal(KNOWN_OPENING_MECHANISMS.length, new Set(KNOWN_OPENING_MECHANISMS).size);
});

test('openingSubType: FITTING_CATALOG/WINDOW_CATALOG全件がisSupported（既知mechanism）を通る', async () => {
  const def = kindDef('openingSubType');
  const entries = await def.loadBuiltin();
  for (const o of entries) assert.equal(def.isSupported(o), true, `category=${o.category} key=${o.key} mechanism=${o.mechanism}`);
});

test('【失敗系】openingSubType.isSupported: 未知のmechanismはfalse', () => {
  const def = kindDef('openingSubType');
  assert.equal(def.isSupported({ mechanism: 'teleport' }), false);
  assert.equal(def.isSupported({}), false);
  assert.equal(def.isSupported(null), false);
});

// ---- fixtureSymbol（ステップ12d） ----
test('fixtureSymbol: FIXTURE_SYMBOLS全件（10件）がfixtureSymbol.validateを通り、isSupported=trueである', async () => {
  const def = kindDef('fixtureSymbol');
  const entries = await def.loadBuiltin();
  assert.equal(entries.length, 10);
  for (const f of entries) {
    assert.doesNotThrow(() => def.validate(f), `key=${f.key}`);
    assert.equal(def.isSupported(f), true, `key=${f.key} mechanism=${f.mechanism} profile=${f.profile}`);
  }
});

test('【失敗系】fixtureSymbol.isSupported: 未知のmechanism/profileはfalse', () => {
  const def = kindDef('fixtureSymbol');
  assert.equal(def.isSupported({ mechanism: 'swing' }), false);
  assert.equal(def.isSupported({ profile: 'hollow' }), false);
  assert.equal(def.isSupported({}), true); // mechanism/profileとも未設定は既知（スコープ無し記号）
  assert.equal(def.isSupported(null), true); // entry?.mechanism/entry?.profileともnullish → 既知扱い
});

// ---- QA指摘m6（2026-09-24再報告）: catalog/catalogMaintenance.js FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM
// （openings/*.jsを静的importできないため値だけを複製した定数）が実マスタOpeningMechanism.FRAME_ONLY
// と一致することを固定する（コメントの「想定」を実測にする）。 ----
test('FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM: catalog/catalogMaintenance.jsの複製値がOpeningMechanism.FRAME_ONLYと一致する', () => {
  assert.equal(FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM, OpeningMechanism.FRAME_ONLY);
});

// ---- QA指摘m4（2026-09-24再々報告・T2）: ステップ12h（建具種別タブ）で複製した機構定数4つが
// 実マスタOpeningMechanismと一致することを固定する（コメントの「想定」を実測にする）。 ----
test('T2: catalog/catalogMaintenance.jsの建具種別（openingSubType）機構複製定数4つがOpeningMechanismと一致する', () => {
  assert.equal(OPENING_SUB_TYPE_SWING_CHILD_MECHANISM, OpeningMechanism.SWING_CHILD);
  assert.equal(OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM, OpeningMechanism.FIRE_DOOR);
  assert.equal(OPENING_SUB_TYPE_FIRE_FOLD_MECHANISM, OpeningMechanism.FIRE_FOLD);
  assert.equal(OPENING_SUB_TYPE_SLIDE_LAYOUT_MECHANISM, OpeningMechanism.SLIDE_LAYOUT);
});

test('interiorMaster: INTERIOR_MASTERS全件がinteriorMaster.validateを通る', async () => {
  const def = kindDef('interiorMaster');
  const entries = await def.loadBuiltin();
  assert.ok(entries.length > 0);
  for (const im of entries) assert.doesNotThrow(() => def.validate(im), `key=${im.key}`);
});

test('boundaryMaster: BOUNDARY_MASTERS全件がboundaryMaster.validateを通る', async () => {
  const def = kindDef('boundaryMaster');
  const entries = await def.loadBuiltin();
  assert.ok(entries.length > 0);
  for (const bm of entries) assert.doesNotThrow(() => def.validate(bm), `key=${bm.key}`);
});

// ---- 必須テスト T1: 5種別すべて loadBuiltin()→withEntries→validateBundle 無例外・resolveCatalogのsizeが件数と一致 ----
const EXPECTED_SIZE = { openingSubType: 45, fixtureSymbol: 10 };

for (const kind of listKinds()) {
  test(`T1 ${kind}: loadBuiltin()の結果がvalidateBundleを無例外で通り、resolveCatalogのsizeが件数と一致する`, async () => {
    const def = kindDef(kind);
    const entries = await def.loadBuiltin();
    assert.ok(entries.length > 0, `${kind}: loadBuiltin()が空`);

    const bundle = withEntries(emptyBundle(), kind, entries);
    assert.doesNotThrow(() => validateBundle(bundle), `${kind}: validateBundleが例外を投げた`);

    const map = resolveCatalog(kind, { builtin: entries });
    assert.equal(map.size, entries.length, `${kind}: resolveCatalogのsizeが件数と不一致（keyOfの衝突を示唆）`);

    if (EXPECTED_SIZE[kind] !== undefined) {
      assert.equal(entries.length, EXPECTED_SIZE[kind], `${kind}: 件数が期待値と不一致`);
    }
  });
}

// ---- QA記録-1（欠落テスト・ステップ7c）: 実データでの collect→expand→build 固定 ----
// templateKeyを持つ部屋がある文書を保存すると、その内装マスター（INTERIOR_MASTERS.LIVING_ROOM）
// が参照する材コード（wallMaterial/wallFinish）が推移的に同梱束（material）へ含まれることを、
// saveCatalogDocument（store.js。node:testからimport不可）ではなく、その純ロジック部分
// （collectUsedKeys → expandTransitiveMaterials → buildDocumentBundle。いずれもusedEntries.js
// の既存export）を実データ（本体標準マスタ）で通す形で固定する。
test('QA記録-1: templateKeyを持つ部屋の内装マスターが参照する材コード（wallMaterial/wallFinish）が推移的にmaterial束へ含まれる', async () => {
  const snapshot = { rooms: [{ id: 'r1', templateKey: 'LIVING_ROOM' }], edges: [] };

  const directMaterialCodes = collectUsedMaterialCodes(snapshot);
  assert.equal(directMaterialCodes.size, 0, 'このスナップショットには材コードへの直接参照が無い（推移的展開だけで入るはず）');

  const { interiorMaster: interiorMasterKeys } = collectUsedKeys(snapshot);
  assert.deepEqual([...interiorMasterKeys], ['LIVING_ROOM']);

  const interiorBuiltin = await kindDef(CatalogKind.INTERIOR_MASTER).loadBuiltin();
  const interiorMasterMap = composeCatalog(CatalogKind.INTERIOR_MASTER, interiorBuiltin);
  const usedInteriorMasters = [...interiorMasterKeys].map(k => interiorMasterMap.get(k)).filter(Boolean);
  assert.equal(usedInteriorMasters.length, 1, 'LIVING_ROOMがinteriorMasterMapで解決できない');

  const expandedMaterialCodes = expandTransitiveMaterials(directMaterialCodes, { interiorMasters: usedInteriorMasters });
  assert.ok(expandedMaterialCodes.has(INTERIOR_MASTERS.LIVING_ROOM.wallMaterial), 'wallMaterialが推移的に展開されていない');
  assert.ok(expandedMaterialCodes.has(INTERIOR_MASTERS.LIVING_ROOM.wallFinish), 'wallFinishが推移的に展開されていない');

  const materialMap = composeCatalog(CatalogKind.MATERIAL, MATERIALS);
  const { bundle, unresolvedKeys } = buildDocumentBundle({
    usedKeysByKind: new Map([[CatalogKind.MATERIAL, expandedMaterialCodes]]),
    resolvedByKind: new Map([[CatalogKind.MATERIAL, materialMap]]),
  });
  assert.equal(unresolvedKeys.size, 0, '実データのためwallMaterial/wallFinishとも本体マスタで解決できるはず');
  const codesInBundle = bundle.catalogs.material.map(e => e.code);
  assert.ok(codesInBundle.includes(INTERIOR_MASTERS.LIVING_ROOM.wallMaterial), '同梱束にwallMaterialが含まれていない');
  assert.ok(codesInBundle.includes(INTERIOR_MASTERS.LIVING_ROOM.wallFinish), '同梱束にwallFinishが含まれていない');
});

// ---- 必須テスト T2: 各種別で全件×全件、自分以外に対しmatchByContentのexactヒットが0件（誤alias防止） ----
for (const kind of listKinds()) {
  test(`T2 ${kind}: 全件×全件で自分以外とmatchByContentのexactヒットが無い（内容の完全重複が無い＝誤alias防止）`, async () => {
    const def = kindDef(kind);
    const entries = await def.loadBuiltin();
    for (let i = 0; i < entries.length; i++) {
      const rest = entries.filter((_, j) => j !== i);
      const result = matchByContent(kind, entries[i], rest);
      assert.equal(
        result.exact, false,
        `${kind}: エントリ[${i}](${def.keyOf(entries[i])}) が他のエントリと内容完全一致している`,
      );
    }
  });
}

// ================================================================
// ステップ12i（開発者向けエクスポート）: catalog/catalogKinds.js が複製している「値→定数名」
// 逆引き表（OPENING_MECHANISM_CONST_NAMES・SECTION_SHAPE_CONST_NAMES）が実マスタの定数と
// 一致すること、および catalog/catalogMaintenance.js formatCatalogSourceLine が本体ソース
// （finish/materials/materialData.js・finish/materials/interiorMasters.js・
// structural/sectionCatalog.js・openings/openingCatalog.js）の該当行と一致することを固定する。
// ================================================================

test('OPENING_MECHANISM_CONST_NAMES: catalogKinds.jsの複製表がOpeningMechanismの全キーと一致する（値→定数名の逆引き）', () => {
  for (const [name, value] of Object.entries(OpeningMechanism)) {
    assert.equal(OPENING_MECHANISM_CONST_NAMES[value], name, `mechanism=${value}`);
  }
  assert.equal(Object.keys(OPENING_MECHANISM_CONST_NAMES).length, Object.keys(OpeningMechanism).length);
});

test('SECTION_SHAPE_CONST_NAMES: catalogKinds.jsの複製表がSectionShapeの全キーと一致する（値→定数名の逆引き）', () => {
  for (const [name, value] of Object.entries(SectionShape)) {
    assert.equal(SECTION_SHAPE_CONST_NAMES[value], name, `shape=${value}`);
  }
  assert.equal(Object.keys(SECTION_SHAPE_CONST_NAMES).length, Object.keys(SectionShape).length);
});

// 本体ソースの1行を正規化する（桁揃えの空白・カンマ直後の空白欠落・行末インラインコメントは
// 見た目の整形であってデータではないため比較対象から外す。app/src配下のこの4ファイルの
// クォート済み文字列に連続空白を含むものが無いこと・"//"を含むものが無いことは確認済み
// ——note等のデータ内容が誤って正規化で書き換わる心配はない）。
function normalizeSourceLine(line) {
  return line.replace(/\/\/.*$/, '').replace(/,(?=\S)/g, ', ').replace(/\s+/g, ' ').trim();
}

function readCatalogSource(relPath) {
  return fs.readFileSync(path.join(import.meta.dirname, '..', relPath), 'utf8').split(/\r?\n/);
}

test('formatCatalogSourceLine(material): symbolic参照（WOOD_STUD_CODE_BY_SIZE 4件・RC_WALL_BACKING_CODES 3件）を除く123件が materialData.js の該当行と一致する', () => {
  const lines = readCatalogSource('finish/materials/materialData.js');
  let matched = 0;
  let symbolic = 0;
  for (const m of MATERIALS) {
    const line = lines.find(l => l.includes(`code: '${m.code}'`));
    if (!line) { symbolic++; continue; } // code欄が定数参照（例: WOOD_STUD_CODE_BY_SIZE['120x45']）の行
    matched++;
    assert.equal(
      formatCatalogSourceLine(CatalogKind.MATERIAL, m), normalizeSourceLine(line),
      `code=${m.code} name=${m.name}`,
    );
  }
  assert.equal(symbolic, 7, 'symbolic参照の件数が想定（4+3）と異なる（materialData.jsの構成が変わった可能性）');
  assert.equal(matched, MATERIALS.length - 7);
});

test('formatCatalogSourceLine(interiorMaster): INTERIOR_MASTERS全件（2件）が interiorMasters.js の該当ブロックと一致する', () => {
  const lines = readCatalogSource('finish/materials/interiorMasters.js');
  for (const [key, v] of Object.entries(INTERIOR_MASTERS)) {
    const entry = { key, ...v };
    const startIdx = lines.findIndex(l => l.includes(`${key}: Object.freeze({`));
    assert.ok(startIdx !== -1, `${key}: 開始行が見つからない`);
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === '}),');
    assert.ok(endIdx !== -1, `${key}: 終了行（}),）が見つからない`);
    const want = lines.slice(startIdx, endIdx + 1).map(normalizeSourceLine).join(' ');
    const got = formatCatalogSourceLine(CatalogKind.INTERIOR_MASTER, entry).split('\n').map(normalizeSourceLine).join(' ');
    assert.equal(got, want, `key=${key}`);
  }
});

// 断面はkeyBoundFields（catalogKinds.js SECTION登録表）で寸法系が全て固定＝上書き分は
// 「本体と全く同じ寸法・labelだけ違う」行にしかならない。SECTION_CATALOGのうち個別の
// リテラル行として本体ソースに存在するのはSTEEL-PIPE150・RC-300x300・RC-ROUND350の3件のみ
// （他はbuildHSections/buildSquarePipes/buildWoodRectsが規格文字列表・幅×成の直積から生成する
// ため、本体ソースに個別の行が存在しない——formatSectionLineのコメント「断面の出力形についての
// 決定」参照）。この3件のみを対象に一致を確認する。
test('formatCatalogSourceLine(section): 個別リテラル行を持つ3件（STEEL-PIPE150・RC-300x300・RC-ROUND350）が sectionCatalog.js の該当行と一致する', () => {
  const lines = readCatalogSource('structural/sectionCatalog.js');
  for (const key of ['STEEL-PIPE150', 'RC-300x300', 'RC-ROUND350']) {
    const entry = SECTION_CATALOG.find(e => e.key === key);
    assert.ok(entry, `${key}: SECTION_CATALOGに見つからない`);
    const line = lines.find(l => l.includes(`key: '${key}'`));
    assert.ok(line, `${key}: 該当行が見つからない`);
    assert.equal(formatCatalogSourceLine(CatalogKind.SECTION, entry), normalizeSourceLine(line), `key=${key}`);
  }
});

test('formatCatalogSourceLine(openingSubType): FITTING_CATALOG/WINDOW_CATALOG全45件が openingCatalog.js の該当行と一致する', async () => {
  const lines = readCatalogSource('openings/openingCatalog.js');
  const entries = await kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin();
  assert.equal(entries.length, 45);
  for (const entry of entries) {
    const line = lines.find(l => l.includes(`key: '${entry.key}'`) && l.includes(`label: '${entry.label}'`));
    assert.ok(line, `category=${entry.category} key=${entry.key}: 該当行が見つからない`);
    assert.equal(
      formatCatalogSourceLine(CatalogKind.OPENING_SUB_TYPE, entry), normalizeSourceLine(line),
      `category=${entry.category} key=${entry.key}`,
    );
  }
});

test('formatCatalogSourceLine(fixtureSymbol): FIXTURE_SYMBOLS全10件が openingCatalog.js の該当行（FIXTURE_SYMBOLS要素＋DEFAULT_MATERIALSの行）と一致する', async () => {
  const lines = readCatalogSource('openings/openingCatalog.js');
  const entries = await kindDef(CatalogKind.FIXTURE_SYMBOL).loadBuiltin();
  assert.equal(entries.length, 10);
  for (const entry of entries) {
    const symbolLine = lines.find(l => l.includes(`key: '${entry.key}'`) && l.includes(`label: '${entry.label}'`));
    assert.ok(symbolLine, `key=${entry.key}: FIXTURE_SYMBOLSの該当行が見つからない`);
    const got = formatCatalogSourceLine(CatalogKind.FIXTURE_SYMBOL, entry).split('\n');
    assert.equal(got[0], normalizeSourceLine(symbolLine), `key=${entry.key}（FIXTURE_SYMBOLS行）`);
    if (entry.defaultMaterialGlass != null) {
      const glassLine = lines.find(l => l.trim().startsWith(`${entry.key}: '`));
      assert.ok(glassLine, `key=${entry.key}: DEFAULT_MATERIALSの該当行が見つからない`);
      assert.equal(got[1], normalizeSourceLine(glassLine), `key=${entry.key}（DEFAULT_MATERIALS行）`);
      assert.equal(got.length, 2);
    } else {
      assert.equal(got.length, 1);
    }
  }
});

test('【失敗系】formatCatalogSourceLine: boundaryMasterは開発者向けエクスポートの対象外（例外）', () => {
  assert.throws(() => formatCatalogSourceLine(CatalogKind.BOUNDARY_MASTER, { key: 'X', label: 'X', kind: 'meta' }));
});
