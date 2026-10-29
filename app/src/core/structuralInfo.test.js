// StructuralInfo の構造の選択（主構造・地階構造・基礎種別）の採取と復元（S5d。共通タブの変更の undo が使う）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuralInfo, structureChoiceEquals } from './structuralInfo.js';
import { UNSPECIFIED_STRUCTURE, MAT_FOUNDATION } from '../structural/structureRules.js';
import { defaultSteelSlabSpec } from '../structural/steelSlabSpec.js';

test('【不変条件・S5d】captureStructureChoice のキー集合は mainStructure / basementStructure / foundationType / steelSlabSpec の4つ（項目を足したら復元・比較にも足す）', () => {
  const snap = new StructuralInfo().captureStructureChoice();
  assert.deepEqual(Object.keys(snap).sort(), ['basementStructure', 'foundationType', 'mainStructure', 'steelSlabSpec']);
  assert.deepEqual(snap, {
    mainStructure: UNSPECIFIED_STRUCTURE, basementStructure: null, foundationType: MAT_FOUNDATION,
    steelSlabSpec: defaultSteelSlabSpec(),
  });
});

test('S造スラブの共通仕様: 既定は defaultSteelSlabSpec・setSteelSlabSpec は正規化を通す（不正値は既定）', () => {
  const info = new StructuralInfo();
  assert.deepEqual(info.steelSlabSpec, defaultSteelSlabSpec());
  info.setSteelSlabSpec({ ...defaultSteelSlabSpec(), kind: 'alc', alcTopBelowFlMm: '30' });
  assert.equal(info.steelSlabSpec.kind, 'alc');
  assert.equal(info.steelSlabSpec.alcTopBelowFlMm, 30);
  info.setSteelSlabSpec({ kind: 'zzz', concreteThicknessMm: -1 });
  assert.deepEqual(info.steelSlabSpec, defaultSteelSlabSpec(), '不正は既定へ（落ちない）');
});

test('S造スラブの共通仕様: 採取は複製（後の変更が採取済みに及ばない）・restore で戻る・他種別の項目だけの違いも比較で検出', () => {
  const info = new StructuralInfo();
  const before = info.captureStructureChoice();
  info.setSteelSlabSpec({ ...defaultSteelSlabSpec(), flatDeckPlateCode: '201700000002' }); // 選択中でない種別の項目
  const after = info.captureStructureChoice();
  assert.equal(before.steelSlabSpec.flatDeckPlateCode, '201700000001', '採取済みは変わらない');
  assert.equal(structureChoiceEquals(before, after), false, '他種別の項目の違いも undo 対象');
  info.restoreStructureChoice(before);
  assert.deepEqual(info.steelSlabSpec, defaultSteelSlabSpec());
});

test('【S5d】全項目を既定以外にして capture → 別インスタンスへ restore → capture が一致する（復元側が全項目を戻す）', () => {
  const src = new StructuralInfo();
  src.setField('mainStructure', '木造（在来）');
  src.setBasementStructure('RC造(壁式)');
  src.setField('foundationType', '独立基礎');
  src.setSteelSlabSpec({ ...defaultSteelSlabSpec(), kind: 'brace', braceHeightMm: 120 });
  const snap = src.captureStructureChoice();

  const dst = new StructuralInfo();
  dst.restoreStructureChoice(snap);
  assert.deepEqual(dst.captureStructureChoice(), snap);
  assert.deepEqual(snap, {
    mainStructure: '木造（在来）', basementStructure: 'RC造(壁式)', foundationType: '独立基礎',
    steelSlabSpec: { ...defaultSteelSlabSpec(), kind: 'brace', braceHeightMm: 120 },
  });
});

test('【S5d】restore は null の地階構造も戻す（設定済み → 未設定）', () => {
  const info = new StructuralInfo();
  info.setBasementStructure('RC造(ラーメン)');
  info.restoreStructureChoice({ mainStructure: 'S造', basementStructure: null, foundationType: MAT_FOUNDATION });
  assert.equal(info.basementStructure, null);
  assert.equal(info.mainStructure, 'S造');
});

test('【S5d・失敗系】restoreStructureChoice は選択肢外の地階構造で throw し、他の項目を書き換えない', () => {
  const info = new StructuralInfo();
  info.setField('mainStructure', 'RC造(ラーメン)');
  const before = info.captureStructureChoice();
  assert.throws(
    () => info.restoreStructureChoice({ mainStructure: 'S造', basementStructure: 'S造', foundationType: '独立基礎' }),
    /地階構造に使えない値/,
  );
  assert.deepEqual(info.captureStructureChoice(), before, '部分的に書き換わっていない');
});

test('【S5d】structureChoiceEquals: 3項目のどれが違っても false、全て同じなら true', () => {
  const base = { mainStructure: 'S造', basementStructure: 'RC造(壁式)', foundationType: '布基礎' };
  assert.equal(structureChoiceEquals(base, { ...base }), true);
  assert.equal(structureChoiceEquals(base, { ...base, mainStructure: '木造（在来）' }), false);
  assert.equal(structureChoiceEquals(base, { ...base, basementStructure: null }), false);
  assert.equal(structureChoiceEquals(base, { ...base, foundationType: 'ベタ基礎' }), false);
});
