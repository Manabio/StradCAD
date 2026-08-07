import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSashDetail, resolveSashDetailForGraph, woodBackingDepth,
  SASH_DETAIL_CATALOG, SashPositioning, SashFinishFamily,
} from './sashDetailCatalog.js';
import { isWoodWallBacking, WOOD_WALL_BACKING_CODES } from '../finish/materials/backingClass.js';
import { MATERIALS, MATERIAL_CATEGORY } from '../finish/materials/materialData.js';

// edgeComposition.test.js / wallBeamAxes.test.js と同じ方針: 材データは実 materialData.js の
// コードで引く（ダミー値の捏造はしない）。
function findMaterial(code) {
  return MATERIALS.find(m => m.code === code);
}

function materialMapOf(...codes) {
  return new Map(codes.map(c => [c, findMaterial(c)]));
}

// ---- resolveSashDetail（純関数）----

test('resolveSashDetail: 木造(isWoodStructure=true) → フィン下地直付け(positioning=fin)', () => {
  const d = resolveSashDetail({ isWoodStructure: true, backingDepth: 45 });
  assert.equal(d.positioning, SashPositioning.FIN);
  assert.equal(d.key, 'woodSiding'); // finishKey未指定は既定（サイディング乾式）
});

test('resolveSashDetail: 下地材の断面寸法が90mm以上 → フィン下地直付け(positioning=fin)（isWoodStructure=falseでも）', () => {
  const d = resolveSashDetail({ isWoodStructure: false, backingDepth: 90 });
  assert.equal(d.positioning, SashPositioning.FIN);
});

test('resolveSashDetail: 非木造・下地90mm未満 → 仕上げ納まり基準(positioning=finish)', () => {
  const d = resolveSashDetail({ isWoodStructure: false, backingDepth: 45 });
  assert.equal(d.positioning, SashPositioning.FINISH);
});

test('resolveSashDetail: 非木造・下地90mm未満・打ち放し指定 → フィンなし（RC抱き納まり）', () => {
  const d = resolveSashDetail({ isWoodStructure: false, backingDepth: 45, finishKey: SashFinishFamily.EXPOSED_CONCRETE });
  assert.equal(d.positioning, SashPositioning.FINISH);
  assert.equal(d.fin, null);
});

test('resolveSashDetail: finishKey該当なしは既定にフォールバック（木造→サイディング乾式／非木造→S造サイディング半外）', () => {
  const wood = resolveSashDetail({ isWoodStructure: true, backingDepth: 45, finishKey: 'no-such-family' });
  assert.equal(wood.key, 'woodSiding');

  const nonWood = resolveSashDetail({ isWoodStructure: false, backingDepth: 45, finishKey: 'no-such-family' });
  assert.equal(nonWood.key, 'steelSidingHalfExposed');
});

test('resolveSashDetail: finishKeyが一致する場合はそのエントリを返す（例: 木造×湿式）', () => {
  const d = resolveSashDetail({ isWoodStructure: true, backingDepth: 45, finishKey: SashFinishFamily.WET });
  assert.equal(d.key, 'woodWet');
});

test('resolveSashDetail: 引数省略時（{}）でも例外にならず既定（非木造フォールバック）を返す', () => {
  const d = resolveSashDetail();
  assert.equal(d.positioning, SashPositioning.FINISH);
  assert.equal(d.key, 'steelSidingHalfExposed');
});

test('SASH_DETAIL_CATALOG: 全10件がkey重複なく、必須フィールドを持つ', () => {
  assert.equal(SASH_DETAIL_CATALOG.length, 10);
  const keys = SASH_DETAIL_CATALOG.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length, 'keyの重複がない');
  for (const e of SASH_DETAIL_CATALOG) {
    assert.ok(e.plan, `${e.key}: plan必須`);
    assert.ok(e.section, `${e.key}: section必須`);
    assert.ok(e.source, `${e.key}: source必須`);
  }
});

// ---- isWoodWallBacking / woodBackingDepth（backingClass.js のコード集合ベース判定）----

test('isWoodWallBacking: WOOD_WALL_BACKING_CODES はtrue、鋼・RCの材コードはfalse', () => {
  for (const code of WOOD_WALL_BACKING_CODES) assert.equal(isWoodWallBacking(code), true, code);
  assert.equal(isWoodWallBacking('111111111138'), false); // スタッド-90×45（溶融亜鉛めっき鋼板＝鋼）
  assert.equal(isWoodWallBacking('111111111236'), false); // RC壁 t=150
  assert.equal(isWoodWallBacking(undefined), false);
});

test('woodBackingDepth: 木質下地は thickness/x,y から見込み寸法を返す', () => {
  const m = findMaterial('111111111155'); // □-90×45 杉・松等（間柱/大壁用）
  assert.equal(woodBackingDepth(m), 90); // Math.max(90,45)
});

test('woodBackingDepth: 非木質下地（LGSスタッド・RC）は spec に関わらず 0（「木造下地材の断面寸法」条件を誤爆させない）', () => {
  const stud = findMaterial('111111111138'); // スタッド-90×45（鋼、90mm）
  assert.equal(woodBackingDepth(stud), 0);
  const rc = findMaterial('111111111236'); // RC壁 t=150
  assert.equal(woodBackingDepth(rc), 0);
});

test('woodBackingDepth: backingMaterialがnullでも例外にならず0を返す', () => {
  assert.equal(woodBackingDepth(null), 0);
});

// ---- 材コード整合テスト: WOOD_WALL_BACKING_CODES と materialData.js の木質下地エントリの二重管理防止 ----

test('WOOD_WALL_BACKING_CODES: materialData.js の下地材（category=backing）のうち spec が木質のエントリと過不足なく一致する', () => {
  const WOOD_SPEC_PATTERN = /杉|桧|檜|松|栂|欅|集成材|製材/;
  const woodBackingCodesInMaterialData = MATERIALS
    .filter(m => m.category === MATERIAL_CATEGORY.BACKING && WOOD_SPEC_PATTERN.test(m.spec ?? ''))
    .map(m => m.code);

  const fromMaterialData = new Set(woodBackingCodesInMaterialData);
  const fromBackingClass = new Set(WOOD_WALL_BACKING_CODES);

  const missingInBackingClass = [...fromMaterialData].filter(c => !fromBackingClass.has(c));
  const extraInBackingClass   = [...fromBackingClass].filter(c => !fromMaterialData.has(c));

  assert.deepEqual(missingInBackingClass, [], 'materialData.jsにある木質下地がWOOD_WALL_BACKING_CODESに未登録');
  assert.deepEqual(extraInBackingClass,   [], 'WOOD_WALL_BACKING_CODESにmaterialData.js側で木質と判定されないコードが混入');
});

// ---- resolveSashDetailForGraph（graph/project/materialMap経由。主要構造は effectiveStructure 由来）----

test('QA1回帰: 主要構造が木造（在来）なら下地がLGS（スタッド-90×45）でもフィン直付け(fin)になる', () => {
  const graph = { exteriorWallBacking: '111111111138', structureOverride: null };
  const project = { structuralInfo: { mainStructure: '木造（在来）' } };
  const materialMap = materialMapOf('111111111138');
  const d = resolveSashDetailForGraph(graph, project, materialMap);
  assert.equal(d.positioning, SashPositioning.FIN);
});

test('QA2: S造＋木胴縁 □-45×45（見込み45mm）は下地90mm未満のためフィンにならない(finish)', () => {
  const graph = { exteriorWallBacking: '111111111158', structureOverride: null };
  const project = { structuralInfo: { mainStructure: 'S造' } };
  const materialMap = materialMapOf('111111111158');
  const d = resolveSashDetailForGraph(graph, project, materialMap);
  assert.equal(d.positioning, SashPositioning.FINISH);
});

test('QA3回帰止め: S造＋木下地 □-90×45（見込み90mm）はgraph経路でも backingDepth>=90 節が生き、フィンになる(fin)', () => {
  const graph = { exteriorWallBacking: '111111111155', structureOverride: null };
  const project = { structuralInfo: { mainStructure: 'S造' } };
  const materialMap = materialMapOf('111111111155');
  const d = resolveSashDetailForGraph(graph, project, materialMap);
  assert.equal(d.positioning, SashPositioning.FIN);
});

test('resolveSashDetailForGraph: S造＋LGSスタッド-90×45（鋼90mm）はfinish（鋼下地90mmが≥90節を誤爆させない）', () => {
  const graph = { exteriorWallBacking: '111111111138', structureOverride: null }; // スタッド-90×45（溶融亜鉛めっき鋼板）
  const project = { structuralInfo: { mainStructure: 'S造' } };
  const materialMap = materialMapOf('111111111138');
  const d = resolveSashDetailForGraph(graph, project, materialMap);
  assert.equal(d.positioning, SashPositioning.FINISH);
});

test('resolveSashDetailForGraph: 階のstructureOverrideが建物全体値より優先される', () => {
  const graph = { exteriorWallBacking: '111111111138', structureOverride: '木造（在来）' };
  const project = { structuralInfo: { mainStructure: 'RC造(ラーメン)' } };
  const materialMap = materialMapOf('111111111138');
  const d = resolveSashDetailForGraph(graph, project, materialMap);
  assert.equal(d.positioning, SashPositioning.FIN, 'structureOverride=木造が優先されfinになる');
});

test('resolveSashDetailForGraph: materialMapに該当なし（未ロード・コード不一致）でも例外にならず既定（finish側）を返す', () => {
  const graph = { exteriorWallBacking: 'unknown-code', structureOverride: null };
  const project = { structuralInfo: { mainStructure: 'S造' } };
  const d = resolveSashDetailForGraph(graph, project, new Map());
  assert.equal(d.positioning, SashPositioning.FINISH);
});

test('resolveSashDetailForGraph: materialMap自体がnull（未ロード）でも例外にならない', () => {
  const graph = { exteriorWallBacking: '111111111155', structureOverride: null };
  const project = { structuralInfo: { mainStructure: 'S造' } };
  const d = resolveSashDetailForGraph(graph, project, null);
  assert.equal(d.positioning, SashPositioning.FINISH);
});
