// StructuralInfo の構造の選択（主構造・地階構造・基礎種別）の採取と復元（S5d。共通タブの変更の undo が使う）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuralInfo, structureChoiceEquals } from './structuralInfo.js';
import { UNSPECIFIED_STRUCTURE, MAT_FOUNDATION } from '../structural/structureRules.js';

test('【不変条件・S5d】captureStructureChoice のキー集合は mainStructure / basementStructure / foundationType の3つ（項目を足したら復元・比較にも足す）', () => {
  const snap = new StructuralInfo().captureStructureChoice();
  assert.deepEqual(Object.keys(snap).sort(), ['basementStructure', 'foundationType', 'mainStructure']);
  assert.deepEqual(snap, { mainStructure: UNSPECIFIED_STRUCTURE, basementStructure: null, foundationType: MAT_FOUNDATION });
});

test('【S5d】全項目を既定以外にして capture → 別インスタンスへ restore → capture が一致する（復元側が全項目を戻す）', () => {
  const src = new StructuralInfo();
  src.setField('mainStructure', '木造（在来）');
  src.setBasementStructure('RC造(壁式)');
  src.setField('foundationType', '独立基礎');
  const snap = src.captureStructureChoice();

  const dst = new StructuralInfo();
  dst.restoreStructureChoice(snap);
  assert.deepEqual(dst.captureStructureChoice(), snap);
  assert.deepEqual(snap, { mainStructure: '木造（在来）', basementStructure: 'RC造(壁式)', foundationType: '独立基礎' });
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
