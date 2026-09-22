// 実マスタとの整合テスト（指示書「必須テスト」の追加1本）。
// 本体標準マスタ（finish/materials/materialData.js 等）が catalogKinds.js の登録表の
// validate/dedupeFields をそのまま通るかを確認する。5種別すべて kindDef(kind).loadBuiltin()
// （動的importのthunk）を実際に呼び、node:test から単体で本体マスタへ到達できることも兼ねて確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindDef, listKinds } from './catalogKinds.js';
import { valuesEqual, matchByContent } from './catalogMatch.js';
import { withEntries, emptyBundle, validateBundle, resolveCatalog } from './catalogBundle.js';
import { MATERIALS } from '../finish/materials/materialData.js';

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
const EXPECTED_SIZE = { openingSubType: 45 };

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
