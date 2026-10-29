// S造スラブ仕様の永続化（S2）: 個別仕様 SteelSlab.steelSpec（スラブの extraKeys/extraVals の 'steelSpec.*'）と
// 共通仕様 StructuralInfo.steelSlabSpec（SI テーブルの STEEL_SLAB_KEYS/VALS）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from 'flatbuffers';
import { Plane, PlanGraph, Project, StructuralMaterialType } from './core.js';
import { SteelSlab, RcSlab, isBayKeyedSlab, SLAB_CLASS_BY_MATERIAL } from './core/structuralEntities.js';
import {
  serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs, snapshotStructForCatalogUsage,
} from './graphSnapshot.js';
import { collectUsedKeysByKind } from './catalog/usedEntries.js';
import { encode, decode } from './schema/graphFbs.js';
import { setDocumentAliases, clearDocumentAliases } from './catalog/codeNormalization.js';
import { CatalogKind } from './catalog/catalogKinds.js';
import {
  defaultSteelSlabSpec, normalizeSteelSlabSpec, SteelSlabSpecMode,
} from './structural/steelSlabSpec.js';

const INDIVIDUAL = { mode: SteelSlabSpecMode.INDIVIDUAL };
const CELL = 'a:b:c:d';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
}

// 個別仕様つきの S造スラブを持つグラフを往復して、復元後の最初のスラブを返す。
function roundTripSlab(spec) {
  const graph = makeGraph();
  graph.addSlab(StructuralMaterialType.STEEL, 'SEC', new Set([CELL]), { steelSpec: spec });
  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);
  return { bytes, slab: [...restored.slabMap.values()][0] };
}

// ---- エンティティ ----

test('SteelSlab: 個別仕様の既定は null（共通に従う）。setSteelSlabSpec で置換・null で共通へ戻る', () => {
  const graph = makeGraph();
  const slab = graph.addSlab(StructuralMaterialType.STEEL, 'SEC', new Set([CELL]));
  assert.ok(slab instanceof SteelSlab);
  assert.equal(slab.materialType, StructuralMaterialType.STEEL);
  assert.equal(slab.steelSpec, null);
  const spec = normalizeSteelSlabSpec({ kind: 'alc', alcTopBelowFlMm: 20 }, INDIVIDUAL);
  slab.setSteelSpec(spec);
  assert.equal(slab.steelSpec, spec);
  slab.setSteelSpec(null);
  assert.equal(slab.steelSpec, null);
  slab.setSteelSpec(undefined);
  assert.equal(slab.steelSpec, null, 'undefined も null');
});

test('isBayKeyedSlab: S造スラブだけ true（RC スラブ・別物は false）。表は STEEL を SteelSlab へ解決する', () => {
  const graph = makeGraph();
  const steel = graph.addSlab(StructuralMaterialType.STEEL, 'SEC', new Set([CELL]));
  const rc = graph.addSlab(StructuralMaterialType.RC, 'SEC', new Set([CELL]));
  assert.equal(isBayKeyedSlab(steel), true);
  assert.equal(isBayKeyedSlab(rc), false);
  assert.ok(rc instanceof RcSlab);
  assert.equal(isBayKeyedSlab(null), false);
  assert.equal(SLAB_CLASS_BY_MATERIAL[StructuralMaterialType.STEEL], SteelSlab);
});

// ---- 個別仕様（スラブ）の往復 ----

test('個別仕様つき S造スラブは serializeGraph→restoreGraph で SteelSlab のまま往復し、材料コードは文字列のまま', () => {
  const spec = normalizeSteelSlabSpec({ kind: 'alc', alcCode: '301200000009', alcTopBelowFlMm: 25, raiseChannelSpec: 'C-120×60×25×4.5' }, INDIVIDUAL);
  const { slab } = roundTripSlab(spec);
  assert.ok(slab instanceof SteelSlab);
  assert.deepEqual(slab.steelSpec, spec);
  assert.equal(typeof slab.steelSpec.alcCode, 'string');
  assert.equal(slab.steelSpec.alcCode, '301200000009');
});

test('個別仕様の往復: ブレースの設置高さ 数値は保たれ、null（自動）は null のまま・キーを書かない', () => {
  const fixed = normalizeSteelSlabSpec({ kind: 'brace', braceMemberType: 'angle', braceSpec: 'L-75*75*9', braceHeightMm: 150 }, INDIVIDUAL);
  assert.deepEqual(roundTripSlab(fixed).slab.steelSpec, fixed);
  const auto = normalizeSteelSlabSpec({ kind: 'brace' }, INDIVIDUAL);
  const { bytes, slab } = roundTripSlab(auto);
  assert.equal(slab.steelSpec.braceHeightMm, null);
  assert.ok(!decode(bytes).slabs[0].extraKeys.includes('steelSpec.braceHeightMm'));
});

test('個別仕様 null の S造スラブは steelSpec.* のキーを書かず、null のまま復元される', () => {
  const { bytes, slab } = roundTripSlab(null);
  assert.ok(slab instanceof SteelSlab);
  assert.equal(slab.steelSpec, null);
  assert.deepEqual(decode(bytes).slabs[0].extraKeys.filter(k => k.startsWith('steelSpec')), []);
});

test('個別仕様を持つスラブの snapshot は steelSpec.* を書く（書き出しキーの対照）', () => {
  const spec = normalizeSteelSlabSpec({ kind: 'deck', concreteThicknessMm: 120 }, INDIVIDUAL);
  const { bytes } = roundTripSlab(spec);
  const keys = decode(bytes).slabs[0].extraKeys;
  assert.ok(keys.includes('steelSpec.kind'));
  assert.ok(keys.includes('steelSpec.concreteThicknessMm'));
});

test('【失敗系】壊れた個別仕様（種別不明）は null（共通に従う）・壊れた値は項目の既定へ。落ちない', () => {
  const spec = normalizeSteelSlabSpec({ kind: 'deck', concreteThicknessMm: 120 }, INDIVIDUAL);
  const graph = makeGraph();
  graph.addSlab(StructuralMaterialType.STEEL, 'SEC', new Set([CELL]), { steelSpec: spec });
  const snap = decode(serializeGraph(graph));

  const unknownKind = structuredClone(snap);
  unknownKind.slabs[0].extraVals[unknownKind.slabs[0].extraKeys.indexOf('steelSpec.kind')] = 'zzz';
  const g1 = makeGraph();
  restoreGraph(g1, unknownKind);
  assert.equal([...g1.slabMap.values()][0].steelSpec, null);

  const badValue = structuredClone(snap);
  badValue.slabs[0].extraVals[badValue.slabs[0].extraKeys.indexOf('steelSpec.concreteThicknessMm')] = '-5';
  const g2 = makeGraph();
  restoreGraph(g2, badValue);
  assert.equal([...g2.slabMap.values()][0].steelSpec.concreteThicknessMm, 150);
});

test('RC スラブは steelSpec を持たず、steelSpec.* を書かない（既存データのバイト列は不変）', () => {
  const graph = makeGraph();
  graph.addSlab(StructuralMaterialType.RC, 'SEC', new Set([CELL]));
  const snap = decode(serializeGraph(graph));
  assert.deepEqual(snap.slabs[0].extraKeys.filter(k => k.startsWith('steelSpec')), []);
});

// ---- 共通仕様（StructuralInfo）の往復 ----

// 構造情報の SI テーブル（GS.STRUCTURAL_INFO=20）に、フィールド番号 fieldNo が書かれているか（vtable の有無）を直接読む。
function structuralInfoHasField(bytes, fieldNo) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const o = bb.__offset(root, 4 + 20 * 2);
  assert.ok(o, '前提: SI テーブルがある');
  return bb.__offset(bb.__indirect(root + o), 4 + fieldNo * 2) !== 0;
}

const NON_DEFAULT = {
  ...defaultSteelSlabSpec(), kind: 'flatDeck', flatDeckPlateCode: '201700000005', concreteType: 'lightweight',
  concreteThicknessMm: 130, braceMemberType: 'angle', braceSpec: 'L-90*90*7', braceHeightMm: 200,
  alcCode: '301200000010', raiseChannelSpec: 'C-200×75×25×4.5',
};

function projectWithSpec(spec) {
  const project = new Project('proj', 'test');
  if (spec) project.structuralInfo.setSteelSlabSpec(spec);
  return project;
}
function serializeProject(project) {
  return serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
}

test('共通仕様: 既定以外は serializeStructCLs→restoreStructCLs で全項目が往復する（材料コードは文字列）', () => {
  const src = projectWithSpec(NON_DEFAULT);
  const bytes = serializeProject(src);
  assert.equal(structuralInfoHasField(bytes, 15), true);
  assert.equal(structuralInfoHasField(bytes, 16), true);
  const dst = new Project('proj2', 'test');
  restoreStructCLs(dst.structGraph, dst.structuralInfo, bytes, dst.memberGroupLedger);
  assert.deepEqual(dst.structuralInfo.steelSlabSpec, NON_DEFAULT);
  assert.equal(typeof dst.structuralInfo.steelSlabSpec.deckPlateCode, 'string');
});

test('共通仕様: 他種別の項目だけを既定から変えた場合も保存される（選択中の種別だけ見て既定扱いにしない）', () => {
  const spec = { ...defaultSteelSlabSpec(), alcTopBelowFlMm: 40 }; // kind は deck のまま
  const bytes = serializeProject(projectWithSpec(spec));
  assert.equal(structuralInfoHasField(bytes, 15), true);
  const dst = new Project('proj2', 'test');
  restoreStructCLs(dst.structGraph, dst.structuralInfo, bytes, dst.memberGroupLedger);
  assert.equal(dst.structuralInfo.steelSlabSpec.alcTopBelowFlMm, 40);
});

test('共通仕様: 既定のときはフィールド 15/16 を書かず、キーの無い旧形式の snapshot を encode したバイト列と一致する', () => {
  const bytes = serializeProject(projectWithSpec(null));
  assert.equal(structuralInfoHasField(bytes, 0), true, '対照: mainStructure(0) は書かれる（読み取りヘルパーが効いている）');
  assert.equal(structuralInfoHasField(bytes, 15), false);
  assert.equal(structuralInfoHasField(bytes, 16), false);
  const snap = decode(bytes);
  assert.deepEqual(snap.structuralInfo.steelSlabKeys, []);
  delete snap.structuralInfo.steelSlabKeys;
  delete snap.structuralInfo.steelSlabVals;
  assert.deepEqual([...encode(snap)], [...bytes], '旧形式（フィールド 15/16 なし）と同じバイト列');

  const withSpec = serializeProject(projectWithSpec(NON_DEFAULT));
  assert.ok(withSpec.length > bytes.length, '値があるときだけ長くなる');
});

test('共通仕様: 旧データ（フィールド無し）は既定へ復元され、復元前の値を持ち越さない', () => {
  const bytes = serializeProject(projectWithSpec(null));
  const dst = projectWithSpec(NON_DEFAULT); // 復元前に値がある状態
  restoreStructCLs(dst.structGraph, dst.structuralInfo, bytes, dst.memberGroupLedger);
  assert.deepEqual(dst.structuralInfo.steelSlabSpec, defaultSteelSlabSpec());
});

test('同梱の使用キー収集: 階に何も無くても、共通仕様のプレート材料コードが material の使用コードに現れる（他種別は空で落ちない）', () => {
  const spec = { ...defaultSteelSlabSpec(), deckPlateCode: '201600000002', flatDeckPlateCode: '201700000005', alcCode: '301200000010' };
  const project = projectWithSpec(spec);
  const snap = snapshotStructForCatalogUsage(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const kinds = Object.values(CatalogKind);
  const used = collectUsedKeysByKind([snap], kinds);
  assert.deepEqual([...used.get(CatalogKind.MATERIAL)].sort(), ['201600000002', '201700000005', '301200000010']);
  for (const kind of kinds) {
    if (kind !== CatalogKind.MATERIAL) assert.equal(used.get(kind).size, 0, `${kind} は空`);
  }
});

test('同梱の使用キー収集: 共通仕様が既定のときは構造スナップショットから材料コードを出さない（既定は保存しない規則と同じ）', () => {
  const project = projectWithSpec(null);
  const snap = snapshotStructForCatalogUsage(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  assert.equal(collectUsedKeysByKind([snap], [CatalogKind.MATERIAL]).get(CatalogKind.MATERIAL).size, 0);
});

test('材コードの読み替え（文書の alias）は復元の入口で、スラブの個別仕様と共通仕様の両方に効く', () => {
  const OLD = '990000000001';
  setDocumentAliases(CatalogKind.MATERIAL, { [OLD]: '201700000007' });
  try {
    const common = decode(serializeProject(projectWithSpec({ ...defaultSteelSlabSpec(), kind: 'flatDeck', flatDeckPlateCode: '201700000005' })));
    common.structuralInfo.steelSlabVals[common.structuralInfo.steelSlabKeys.indexOf('flatDeckPlateCode')] = OLD;
    const dst = new Project('proj2', 'test');
    restoreStructCLs(dst.structGraph, dst.structuralInfo, common, dst.memberGroupLedger);
    assert.equal(dst.structuralInfo.steelSlabSpec.flatDeckPlateCode, '201700000007', '共通仕様');

    const graph = makeGraph();
    graph.addSlab(StructuralMaterialType.STEEL, 'SEC', new Set([CELL]), {
      steelSpec: normalizeSteelSlabSpec({ kind: 'flatDeck', flatDeckPlateCode: '201700000005' }, INDIVIDUAL),
    });
    const snap = decode(serializeGraph(graph));
    snap.slabs[0].extraVals[snap.slabs[0].extraKeys.indexOf('steelSpec.flatDeckPlateCode')] = OLD;
    const restored = makeGraph();
    restoreGraph(restored, snap);
    assert.equal([...restored.slabMap.values()][0].steelSpec.flatDeckPlateCode, '201700000007', '個別仕様');
  } finally {
    clearDocumentAliases(CatalogKind.MATERIAL);
  }
});

test('【失敗系】共通仕様: 壊れたペア（種別不明・負の厚・桁違いのコード・値の欠け）は項目の既定へ。落ちない', () => {
  const snap = decode(serializeProject(projectWithSpec(NON_DEFAULT)));
  const corrupt = (keys, vals) => {
    const c = structuredClone(snap);
    c.structuralInfo.steelSlabKeys = keys;
    c.structuralInfo.steelSlabVals = vals;
    const dst = new Project('proj2', 'test');
    restoreStructCLs(dst.structGraph, dst.structuralInfo, c, dst.memberGroupLedger);
    return dst.structuralInfo.steelSlabSpec;
  };
  assert.deepEqual(corrupt(['kind', 'concreteThicknessMm'], ['nope', '-3']), defaultSteelSlabSpec());
  const bad = corrupt(['kind', 'deckPlateCode', 'alcCode'], ['alc', '12', '201600000001']);
  assert.equal(bad.kind, 'alc');
  assert.equal(bad.deckPlateCode, '201600000001');
  assert.equal(bad.alcCode, '301200000008', '帯違いは既定');
  assert.deepEqual(corrupt(['kind', 'concreteThicknessMm'], ['flatDeck']), { ...defaultSteelSlabSpec(), kind: 'flatDeck' }, '値が欠けた対');
  assert.deepEqual(corrupt([], []), defaultSteelSlabSpec());
});
