// ui/catalogPreview.js（作図プレビュー登録表）の単体テスト。
// 描画コンポーネント（CatalogPreview.jsx）の配線検証は ui/catalogPreviewWiring.test.js を参照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind, KIND_LABELS, kindDef } from '../catalog/catalogKinds.js';
import { findSectionEntry, parseSectionSpec, parseSectionSpecList } from '../structural/sectionCatalog.js';
import { planBulkSectionImport } from '../catalog/catalogMaintenance.js';
import { OpeningMechanism } from '../openings/openingCatalog.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { FIGURE_FRAME_BY_MAP } from '../structural/memberCatalog.js';
import { buildCatalogPreview, catalogPreviewKinds, catalogPreviewViews } from './catalogPreview.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { LINE_WEIGHT_MM, DEFAULT_WALL_MATERIAL } from '../core.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from '../finish/wallGeneration.js';

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

// ---- 9. ステップ9c: 一括入力（planBulkSectionImport）の解析結果を1件分プレビューへ渡す縦の1本 ----
test('ステップ9c: planBulkSectionImportのtoAdd[0]をbuildCatalogPreviewへそのまま渡すとhSectionで描け、builtinと衝突する行はtoAddに入らずskippedへ回る', () => {
  // builtinに既にあるキー相当（'H300×150×6.5×9' → STEEL-H300x150）をbuiltinListへ入れておく。
  const builtin = [parseSectionSpec('H300×150×6.5×9')];
  // QA指摘Nit-1（9c）: 実 builtin にも同寸で存在する H400×200×8×13 では注入経路を守れない（findSectionEntry でも同じ図が
  // 出る）ため、builtin に無い H401×200×8×13 を使う。
  const plan = planBulkSectionImport('H401×200×8×13 / H300×150×6.5×9', {
    builtinList: builtin, parseSpecList: parseSectionSpecList,
  });
  assert.deepEqual(plan.toAdd.map(e => e.key), ['STEEL-H401x200']);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /既にあります（標準）/);

  const frame = FIGURE_FRAME_BY_MAP.columnMap;
  const result = buildCatalogPreview(CatalogKind.SECTION, plan.toAdd[0], { frame });
  assert.equal(result.ok, true);
  assertKnownTypes(result.primitives, 'bulk-import-draft');
  const hSection = result.primitives.find(p => p.type === 'hSection');
  assert.ok(hSection, 'hSectionのprimitiveが見つからない');
  assert.deepEqual(
    { w: hSection.w, h: hSection.h, web: hSection.web, flange: hSection.flange },
    { w: 200, h: 401, web: 8, flange: 13 },
  );
  assert.ok(result.scale >= 1 / 20, `scaleが1/20を下回った（実際: ${result.scale}）`);
});

// ================================================================
// ステップ11f: 建具種別（OPENING_SUB_TYPE）の平面記号プレビュー（view:'plan'）。
// ================================================================

// テスト用の材料エントリ（finish/materials/materialData.js MATERIALSと同じ形。category文字列は
// 同ファイルのMATERIAL_CATEGORY値と同じ——動的importせずに手製する）。
function mat(code, category, extra) {
  return { code, category, name: 'テスト材', spec: 'test', x: 0, y: 0, thickness: null, ...extra };
}

// ---- 10. view:'plan' builtin全件 ----
test('buildCatalogPreview(openingSubType, view:plan): builtin45件がok:true・既知type（polylineのみ。rectはpolylineへ変換済み）・boundsが有限', async () => {
  const openings = await kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin();
  assert.ok(openings.length > 0, '前提: builtin建具種別が1件以上ある');
  for (const entry of openings) {
    const label = `${entry.category}:${entry.key}`;
    const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'plan' });
    assert.equal(result.ok, true, `${label} がok:falseになった: ${result.ok ? '' : result.reason}`);
    assert.ok(result.primitives.length > 0, `${label} のprimitivesが空`);
    assertKnownTypes(result.primitives, label);
    for (const p of result.primitives) {
      // QA指摘・2026-09-23裁定C: rectもpolylineへ変換するため、平面プレビューはpolylineのみになる。
      assert.equal(p.type, 'polyline', `${label}: 未知のprimitive type「${p.type}」（polylineのみの想定）`);
    }
    const b = figureBounds(result.primitives);
    for (const v of [b.minX, b.minY, b.maxX, b.maxY]) {
      assert.ok(Number.isFinite(v), `${label} のboundsが有限でない（${JSON.stringify(b)}）`);
    }
    assert.equal(result.scale, null, `${label} のscaleがnullでない`);
  }
});

// ---- 11. 開き戸の弧は室内側（y>0） ----
test('buildCatalogPreview(openingSubType, view:plan): 片開き戸(singleSwing)の記号は壁の切れ端2本を除き室内側(y>=0)だけに描かれる', () => {
  const entry = {
    category: 'fitting', key: 'singleSwing', label: '片開き戸',
    mechanism: OpeningMechanism.SWING, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000,
  };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'plan' });
  assert.equal(result.ok, true);
  // 壁の切れ端2本（左右300mmの面線）を除いた記号本体（扉leaf・動作弧）。
  const symbolPrims = result.primitives.slice(2);
  assert.ok(symbolPrims.length > 0, '扉の記号プリミティブが見つからない');
  const b = figureBounds(symbolPrims);
  assert.ok(b.minY >= -1e-6, `扉の記号が室内側(y>=0)からはみ出た（minY=${b.minY}）`);
  assert.ok(b.maxY > 0, '扉の記号が室内側(y>0)へ描かれていない');
});

// ---- 11a. arc→polylineアダプタは5°刻みでサンプリングする（直線1本に間引かれない） ----
test('buildCatalogPreview(openingSubType, view:plan): 片開き戸(singleSwing)の動作弧(90°)は5°刻みの折れ線（18区間・19点）に変換される', () => {
  const entry = {
    category: 'fitting', key: 'singleSwing', mechanism: OpeningMechanism.SWING,
    wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000,
  };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'plan' });
  const arcPoly = result.primitives.reduce((a, b) => (b.points && b.points.length > (a?.points.length ?? 0) ? b : a), null);
  assert.ok(arcPoly, '動作弧のプリミティブが見つからない');
  assert.equal(arcPoly.points.length, 19, `90°の動作弧が5°刻み(18区間・19点)に変換されていない（実際: ${arcPoly.points.length}点）`);
});

// ---- 11b. OVERHEAD/EMERGENCYはexteriorDirOf（設計裁定Q3で()=>-1固定＝外部は上/y<0側）を参照し、
// 記号は室内側（y>=0）へ描かれる ----
test('buildCatalogPreview(openingSubType, view:plan): オーバーヘッドドア(overheadDoor)の跳ね上げ投影矩形は室内側(y>=0)', () => {
  const entry = {
    category: 'fitting', key: 'overheadDoor', mechanism: OpeningMechanism.OVERHEAD,
    wallKinds: ['exterior'], defaultWidth: 2600, defaultHeight: 2200,
  };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'plan' });
  assert.equal(result.ok, true);
  const symbolPrims = result.primitives.slice(2);
  const b = figureBounds(symbolPrims);
  assert.ok(b.minY >= -1e-6, `オーバーヘッドドアの記号が室内側(y>=0)からはみ出た（minY=${b.minY}）`);
  assert.ok(b.maxY > 0, 'オーバーヘッドドアの跳ね上げ投影が室内側(y>0)へ描かれていない');
});

test('buildCatalogPreview(openingSubType, view:plan): 非常用進入口(emergencyEntry)の逆三角形の頂点は室内側(y>0)', () => {
  const entry = {
    category: 'fitting', key: 'emergencyEntry', mechanism: OpeningMechanism.EMERGENCY,
    wallKinds: ['exterior'], defaultWidth: 750, defaultHeight: 1200,
  };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'plan' });
  assert.equal(result.ok, true);
  const symbolPrims = result.primitives.slice(2);
  const triangle = symbolPrims.find(p => p.closed);
  assert.ok(triangle, '逆三角形のプリミティブが見つからない');
  const apexY = Math.max(...triangle.points.map(([, y]) => y));
  assert.ok(apexY > 0, `逆三角形の頂点が室内側(y>0)にない（実際: ${apexY}）`);
});

// 壁の切れ端2本（primitives[0..1]）のY方向の幅＝壁厚(mm)を取り出す。
function stubThicknessMm(result) {
  const b = figureBounds(result.primitives.slice(0, 2));
  return b.maxY - b.minY;
}

// ---- 12. 壁厚の導出元（本番の平面と同じ式: 下地材の厚み+面材の厚み×2。QA指摘・2026-09-23裁定A） ----
test('buildCatalogPreview(openingSubType, view:plan): 本物のMATERIALSで外壁・内壁とも壁厚が本番の式（下地材+面材×2）と一致する（door・foldingとも115）', async () => {
  // materialData.js（本体マスタ）を動的importで読む——合成データだけでは検出できない回帰
  // （QA指摘テスト1・2026-09-23: DEFAULT_EXTERIOR_WALL_BACKING/DEFAULT_INTERIOR_WALL_BACKING/
  // DEFAULT_WALL_MATERIALの実コードが実データに存在することも同時に検証する）。
  const materialList = await kindDef(CatalogKind.MATERIAL).loadBuiltin();

  const exteriorEntry = { category: 'fitting', key: 'door', mechanism: OpeningMechanism.SWING, wallKinds: ['exterior'], defaultWidth: 900, defaultHeight: 2000 };
  const rExt = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, exteriorEntry, { view: 'plan', materialList });
  assert.equal(rExt.ok, true);
  assert.equal(stubThicknessMm(rExt), 115, `外壁厚が本番の式と一致しない（実際: ${stubThicknessMm(rExt)}）`);

  const interiorEntry = { category: 'fitting', key: 'folding', mechanism: OpeningMechanism.FOLD, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
  const rInt = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, interiorEntry, { view: 'plan', materialList });
  assert.equal(rInt.ok, true);
  assert.equal(stubThicknessMm(rInt), 115, `内壁厚が本番の式と一致しない（実際: ${stubThicknessMm(rInt)}）`);
});

// ---- 13. overlay: 面材(DEFAULT_WALL_MATERIAL)の厚みを変えると外壁・内壁の両方に反映される ----
test('buildCatalogPreview(openingSubType, view:plan): 材料ライブラリでDEFAULT_WALL_MATERIALの厚みを変えるとoverlay込みで外壁・内壁の両方に反映される', async () => {
  const materialList = await kindDef(CatalogKind.MATERIAL).loadBuiltin();
  try {
    setOverlay(CatalogKind.MATERIAL, {
      user: [mat(DEFAULT_WALL_MATERIAL, 'panel', { name: 'テスト用面材', thickness: 20 })],
    });
    const exteriorEntry = { category: 'fitting', key: 'door', mechanism: OpeningMechanism.SWING, wallKinds: ['exterior'], defaultWidth: 900, defaultHeight: 2000 };
    const interiorEntry = { category: 'fitting', key: 'folding', mechanism: OpeningMechanism.FOLD, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
    const rExt = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, exteriorEntry, { view: 'plan', materialList });
    const rInt = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, interiorEntry, { view: 'plan', materialList });
    // 下地90 + 面材(overlayで20へ変更)×2 = 130（Minor-1の非対称回帰防止: 外壁・内壁の両方に効く）。
    assert.equal(stubThicknessMm(rExt), 130, `overlay後の外壁厚が反映されていない（実際: ${stubThicknessMm(rExt)}）`);
    assert.equal(stubThicknessMm(rInt), 130, `overlay後の内壁厚が反映されていない（実際: ${stubThicknessMm(rInt)}）`);
  } finally {
    clearOverlays();
  }
});

// ---- 14. 失敗系: materialListが無い→既定厚(115)でok:true ----
test('buildCatalogPreview(openingSubType, view:plan): materialList省略時は既定壁厚(DEFAULT_WALL_BASE+DEFAULT_WALL_FINISH*2)でok:true', () => {
  const entry = { category: 'fitting', key: 'folding', mechanism: OpeningMechanism.FOLD, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'plan' });
  assert.equal(result.ok, true);
  assert.equal(stubThicknessMm(result), DEFAULT_WALL_BASE + DEFAULT_WALL_FINISH * 2);
});

// ---- 15. 失敗系: 未知view ----
test("buildCatalogPreview: view:'bogus'は例外でなくok:falseで理由を返す", () => {
  const entry = { category: 'fitting', key: 'singleSwing', mechanism: OpeningMechanism.SWING, defaultWidth: 800, defaultHeight: 2000 };
  const result = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { view: 'bogus' });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

// ---- 16. 失敗系: openingSubType以外にview:'plan' ----
test("buildCatalogPreview(section, view:plan): 平面記号プレビューを持たずok:false・理由に種別ラベルを含む", () => {
  const entry = findSectionEntry('STEEL-H300x150');
  const result = buildCatalogPreview(CatalogKind.SECTION, entry, { view: 'plan' });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes(KIND_LABELS[CatalogKind.SECTION]), `理由文に種別ラベルが無い: ${result.reason}`);
});

// ---- 17. catalogPreviewViews ----
test('catalogPreviewViews: openingSubTypeは[elevation, plan]、sectionは[elevation]、material/interiorMaster/boundaryMasterは空配列', () => {
  assert.deepEqual(catalogPreviewViews(CatalogKind.OPENING_SUB_TYPE), ['elevation', 'plan']);
  assert.deepEqual(catalogPreviewViews(CatalogKind.SECTION), ['elevation']);
  assert.deepEqual(catalogPreviewViews(CatalogKind.MATERIAL), []);
  assert.deepEqual(catalogPreviewViews(CatalogKind.INTERIOR_MASTER), []);
  assert.deepEqual(catalogPreviewViews(CatalogKind.BOUNDARY_MASTER), []);
});

test('catalogPreviewViews: 未知のkindはkindDefの例外がそのまま伝播する', () => {
  assert.throws(() => catalogPreviewViews('bogus'), /未知のカタログ種別です/);
});

// ---- 18. 後方互換: view省略は従来の姿図とdeepEqual ----
test('buildCatalogPreview(openingSubType): view省略時はview:"elevation"指定時とdeepEqual（後方互換）', () => {
  const entry = { category: 'fitting', key: 'singleSwing', mechanism: OpeningMechanism.SWING, defaultWidth: 900, defaultHeight: 2100 };
  const frame = { maxWidth: 280, maxHeight: 220 };
  const omitted = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { frame });
  const explicit = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, entry, { frame, view: 'elevation' });
  assert.deepEqual(omitted, explicit);
  assert.equal(omitted.ok, true);
  assertKnownTypes(omitted.primitives, 'view省略');
});

// ---- 19. width正規化（QA指摘テスト4・2026-09-23裁定C）: weightMm/LINE_WEIGHT_MM.medium ----
test('buildCatalogPreview(openingSubType, view:plan): widthはweightMm/LINE_WEIGHT_MM.mediumに正規化される（symbol=1・arc≈0.52）。rectもpolylineでwidthを持つ', () => {
  // shutter: symbol役割の破線1本（壁軸の一点鎖線）＋frame役割は無し。dashed(symbol)のwidthは
  // LINE_WEIGHT_MM.medium/LINE_WEIGHT_MM.medium=1になるはず。
  const shutter = { category: 'fitting', key: 'shutter', mechanism: OpeningMechanism.SHUTTER, wallKinds: ['exterior'], defaultWidth: 2000, defaultHeight: 2200 };
  const rShutter = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, shutter, { view: 'plan' });
  assert.equal(rShutter.ok, true);
  const dashed = rShutter.primitives.find(p => p.dash === 'dashed');
  assert.ok(dashed, 'シャッターの破線プリミティブが見つからない');
  assert.equal(dashed.width, 1, `symbol役割のwidthが1(medium/medium)でない（実際: ${dashed.width}）`);

  // singleSwing: 動作弧(arc役割・thin)のwidthはLINE_WEIGHT_MM.thin/LINE_WEIGHT_MM.medium≈0.52。
  // sashOpen枠（frame役割）を持つslidingでframe役割のrectがpolyline化されwidthを持つことも確認する。
  const singleSwing = { category: 'fitting', key: 'singleSwing', mechanism: OpeningMechanism.SWING, wallKinds: ['interior'], defaultWidth: 800, defaultHeight: 2000 };
  const rSwing = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, singleSwing, { view: 'plan' });
  const arcPoly = rSwing.primitives.reduce((a, b) => (b.points && b.points.length > (a?.points.length ?? 0) ? b : a), null);
  assert.ok(arcPoly, '動作弧のプリミティブが見つからない');
  assert.ok(Math.abs(arcPoly.width - LINE_WEIGHT_MM.thin / LINE_WEIGHT_MM.medium) < 1e-9, `arc役割のwidthが正規化比と一致しない（実際: ${arcPoly.width}）`);

  const sliding = { category: 'fitting', key: 'sliding', mechanism: OpeningMechanism.SLIDE_SINGLE, wallKinds: ['interior', 'exterior'], defaultWidth: 800, defaultHeight: 2000 };
  const rSliding = buildCatalogPreview(CatalogKind.OPENING_SUB_TYPE, sliding, { view: 'plan' });
  const frameRect = rSliding.primitives.slice(2).find(p => p.closed && p.points.length === 4);
  assert.ok(frameRect, 'frame役割の枠（旧rect）が見つからない');
  assert.equal(frameRect.type, 'polyline', 'rectがpolylineへ変換されていない（AutoScaledFigureのrect型は太さ1px固定のため）');
  assert.equal(frameRect.width, 1, `frame役割のwidthが1(medium/medium)でない（実際: ${frameRect.width}）`);
});
