// ui/catalogPreview.js（作図プレビュー登録表）の単体テスト。
// 描画コンポーネント（CatalogPreview.jsx）の配線検証は ui/catalogPreviewWiring.test.js を参照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind, KIND_LABELS, kindDef } from '../catalog/catalogKinds.js';
import { findSectionEntry } from '../structural/sectionCatalog.js';
import { OpeningMechanism } from '../openings/openingCatalog.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { FIGURE_FRAME_BY_MAP } from '../structural/memberCatalog.js';
import { buildCatalogPreview, catalogPreviewKinds } from './catalogPreview.js';

// AutoScaledFigure.jsx renderPrimitive の既知type集合（2026-09-23時点。同期コメント: AutoScaledFigure.jsx
// のswitch文のcase一覧が増減したらここも合わせる——本テストが「知らない型を静かに描かない」ことの網）。
const KNOWN_PRIMITIVE_TYPES = new Set([
  'rect', 'circle', 'line', 'polyline', 'hSection', 'text', 'arrow', 'axisV', 'levelLine', 'dim',
]);

function assertKnownTypes(primitives, label) {
  for (const p of primitives) {
    assert.ok(KNOWN_PRIMITIVE_TYPES.has(p.type), `${label}: 未知のprimitive type「${p.type}」`);
  }
}

// ---- 仮定B: ui/catalogPreview.js が node:test から単体importできる ----
test('仮定B: ui/catalogPreview.js を単体importできる（openingElevationFigure.js→core.js等の依存が静的解決できる）', () => {
  assert.equal(typeof buildCatalogPreview, 'function');
  assert.equal(typeof catalogPreviewKinds, 'function');
});

// ---- 1. section ok ----
test('buildCatalogPreview(section): builtinのSTEEL-H300x150相当エントリでok:true、hSection1個・dim2個以上、frame指定でscaleが数値', () => {
  const entry = findSectionEntry('STEEL-H300x150');
  assert.ok(entry, '前提: STEEL-H300x150 がbuiltinに存在する');
  const result = buildCatalogPreview(CatalogKind.SECTION, entry, { frame: { maxWidth: 300, maxHeight: 300 } });
  assert.equal(result.ok, true);
  assertKnownTypes(result.primitives, 'section');
  assert.equal(result.primitives.filter(p => p.type === 'hSection').length, 1);
  assert.ok(result.primitives.filter(p => p.type === 'dim').length >= 2);
  assert.equal(typeof result.scale, 'number');
});

// ---- 2. section ok（overlayに無い未保存ドラフト） ----
test('buildCatalogPreview(section): overlayに登録されていない未保存ドラフトでもok:trueで描ける（resolveSection注入の実需）', () => {
  const draft = { key: 'DRAFT-X', materialType: 'WOOD', shape: 'rect', width: 105, height: 300 };
  const result = buildCatalogPreview(CatalogKind.SECTION, draft, { frame: { maxWidth: 300, maxHeight: 300 } });
  assert.equal(result.ok, true);
  assertKnownTypes(result.primitives, 'section-draft');
  const shapeRect = result.primitives.find(p => p.type === 'rect' && p.w === 105 && p.h === 300);
  assert.ok(shapeRect, '幅105・成300のrectが見つからない');
});

// ---- 3. openingSubType ----
test('buildCatalogPreview(openingSubType): 手製エントリのdefaultHeight(2100)がそのまま外周高さに使われる（既定2000に落ちない）', () => {
  const entry = {
    category: 'fitting', key: 'previewSwingForTest', label: 'テスト用開き戸',
    mechanism: OpeningMechanism.SWING, defaultWidth: 900, defaultHeight: 2100,
  };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { frame: { maxWidth: 280, maxHeight: 220 } });
  assert.equal(result.ok, true);
  assertKnownTypes(result.primitives, 'openingSubType');
  const outerRect = result.primitives.find(p => p.type === 'rect' && p.w === 900);
  assert.ok(outerRect, '幅900のrectが見つからない');
  assert.equal(outerRect.h, 2100);
  // QA指摘Minor-1・2026-09-23: openingElevationFigure.jsはframe/scaleの仕組みを持たない（frameは無視される）ため
  // scaleは常にnull＝AutoScaledFigure側の省略時計算（chooseScale）に委ねる契約（sectionと非対称）。
  assert.equal(result.scale, null);
});

// ---- 最重要（QA指摘Major-1・2026-09-23）: プレビュー枠が狭すぎるとannotatedFigureが最小スケール
// (1/500)へ落ち、builtin断面が軒並み潰れて見えなくなる回帰の検知。実使用の枠
// （structural/memberCatalog.js FIGURE_FRAME_BY_MAP.columnMap。CatalogPreview.jsxが実際に使う枠と
// 同じ定数を参照——ここで独自の枠値を二重定義しない）で、断面成(h)が最低20px描画されることを確認する。
test('buildCatalogPreview(section): パネルのプレビュー枠（FIGURE_FRAME_BY_MAP.columnMap）で builtin 断面を描くと最小スケールへ落ちない', () => {
  const frame = FIGURE_FRAME_BY_MAP.columnMap;
  for (const key of ['STEEL-H300x150', 'WOOD-90x90']) {
    const entry = findSectionEntry(key);
    assert.ok(entry, `前提: ${key} がbuiltinに存在する`);
    const result = buildCatalogPreview(CatalogKind.SECTION, entry, { frame });
    assert.equal(result.ok, true);
    assert.ok(result.scale >= 1 / 20, `${key}: scaleが1/20を下回った（実際: ${result.scale}）`);
    assert.ok(
      entry.height * result.scale >= 20,
      `${key}: 断面成(h=${entry.height}mm)の描画pxが20pxを下回った（実際: ${entry.height * result.scale}px）`,
    );
  }
});

// ---- builtin全件（QA指摘・追加テスト2）: 断面・建具種別のbuiltin一覧を全件走査し、
// 例外なく描け・boundsが有限・primitive typeが既知集合であることを確認する。
test('builtin の断面・建具種別すべてが ok:true で有限の primitives/bounds を返す（FIGURE_FRAME_BY_MAP.columnMap枠）', async () => {
  const frame = FIGURE_FRAME_BY_MAP.columnMap;
  const sections = await kindDef(CatalogKind.SECTION).loadBuiltin();
  const openings = await kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin();
  assert.ok(sections.length > 0, '前提: builtin断面が1件以上ある');
  assert.ok(openings.length > 0, '前提: builtin建具種別が1件以上ある');

  for (const entry of sections) {
    const result = buildCatalogPreview(CatalogKind.SECTION, entry, { frame });
    assert.equal(result.ok, true, `断面 ${entry.key} がok:falseになった: ${result.ok ? '' : result.reason}`);
    assert.ok(result.primitives.length > 0, `断面 ${entry.key} のprimitivesが空`);
    assertKnownTypes(result.primitives, `断面 ${entry.key}`);
    const b = figureBounds(result.primitives);
    for (const v of [b.minX, b.minY, b.maxX, b.maxY]) {
      assert.ok(Number.isFinite(v), `断面 ${entry.key} のboundsが有限でない（${JSON.stringify(b)}）`);
    }
    assert.equal(typeof result.scale, 'number', `断面 ${entry.key} のscaleが数値でない`);
  }

  for (const entry of openings) {
    const label = `${entry.category}:${entry.key}`;
    const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { frame });
    assert.equal(result.ok, true, `建具種別 ${label} がok:falseになった: ${result.ok ? '' : result.reason}`);
    assert.ok(result.primitives.length > 0, `建具種別 ${label} のprimitivesが空`);
    assertKnownTypes(result.primitives, `建具種別 ${label}`);
    const b = figureBounds(result.primitives);
    for (const v of [b.minX, b.minY, b.maxX, b.maxY]) {
      assert.ok(Number.isFinite(v), `建具種別 ${label} のboundsが有限でない（${JSON.stringify(b)}）`);
    }
    assert.equal(result.scale, null, `建具種別 ${label} のscaleがnullでない`);
  }
});

// ---- 4. material/interiorMaster/boundaryMaster は作図プレビューを持たない ----
for (const kind of [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER]) {
  test(`buildCatalogPreview(${kind}): 作図プレビューを持たずok:false・理由に種別ラベルを含む`, () => {
    const result = buildCatalogPreview(kind, {});
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes(KIND_LABELS[kind]), `理由文に種別ラベル「${KIND_LABELS[kind]}」が無い: ${result.reason}`);
  });
}

// ---- 5. 未知kind ----
test('buildCatalogPreview: 未知のkindはkindDefの例外がそのまま伝播する', () => {
  assert.throws(() => buildCatalogPreview('bogus', {}), /未知のカタログ種別です/);
});

// ---- 6. 型集合はテスト1〜3の中で assertKnownTypes 済み ----

// ---- 7. catalogPreviewKinds ----
test('catalogPreviewKinds(): section・openingSubTypeの2種のみ（PREVIEW_BUILDERSの定義順）', () => {
  assert.deepEqual(catalogPreviewKinds(), [CatalogKind.SECTION, CatalogKind.OPENING_SUB_TYPE]);
});

// ---- 8. 失敗系: entryがkeyを持たない／null ----
test('buildCatalogPreview(section): entryがkeyを持たない場合は例外でなくok:falseで理由を返す', () => {
  const result = buildCatalogPreview(CatalogKind.SECTION, { materialType: 'WOOD', shape: 'rect', width: 100, height: 100 });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

test('buildCatalogPreview(section): entryがnullの場合は例外でなくok:falseで理由を返す', () => {
  const result = buildCatalogPreview(CatalogKind.SECTION, null);
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

test('buildCatalogPreview(openingSubType): entryがkey/categoryを持たない場合は例外でなくok:falseで理由を返す', () => {
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, { label: 'x' });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});
