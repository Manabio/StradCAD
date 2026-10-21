// 共通タブの構造行の分岐（commonInfoTabModel.js。S5d）。決定書 §1 の表の5行と、地階の判定・失敗系を固定する。
// 純モジュールは store.js / snap.js / .jsx を静的に引かない（node:test から単体 import できる状態を保つ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  commonTabStructureRow, STRUCTURE_ROW, BASEMENT_UNSET_LABEL,
} from './commonInfoTabModel.js';
import { MAIN_STRUCTURE_OPTIONS, BASEMENT_STRUCTURE_OPTIONS, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

const RAME = 'RC造(ラーメン)';
const WALL = 'RC造(壁式)';
const ground = { startFloor: 0, stories: 1, isRoofPlane: false };
const b1 = { startFloor: -1, stories: 1, isRoofPlane: false };
const info = (mainStructure = 'S造', basementStructure = null) => ({ mainStructure, basementStructure });

test('【S5d】地階でない・上書きなし: 主構造の行（チェックは出す・外れ）', () => {
  const r = commonTabStructureRow(ground, null, info('S造'));
  assert.equal(r.kind, STRUCTURE_ROW.MAIN);
  assert.equal(r.label, '主構造');
  assert.equal(r.value, 'S造');
  assert.deepEqual([...r.options], [...MAIN_STRUCTURE_OPTIONS]);
  assert.equal(r.showOverrideToggle, true);
  assert.equal(r.overrideChecked, false);
  assert.equal(r.focusOnMount, false);
});

test('【S5d】地階でない・上書きあり: 主構造の行は上書き値、チェックは入り', () => {
  const r = commonTabStructureRow(ground, TRADITIONAL_WOOD_STRUCTURE, info('S造'));
  assert.equal(r.kind, STRUCTURE_ROW.MAIN);
  assert.equal(r.value, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(r.showOverrideToggle, true);
  assert.equal(r.overrideChecked, true);
});

test('【S5d】主構造が未定ならマウント時にフォーカス（今までの挙動）', () => {
  assert.equal(commonTabStructureRow(ground, null, info(MAIN_STRUCTURE_OPTIONS[0])).focusOnMount, true);
  assert.equal(commonTabStructureRow(ground, 'S造', info(MAIN_STRUCTURE_OPTIONS[0])).focusOnMount, false, '上書き値で判定する');
});

test('【S5d】地階・上書きなし・地階構造あり: 地階構造の行（ラーメン／壁式のみ・チェックは出さない）', () => {
  for (const basement of [RAME, WALL]) {
    const r = commonTabStructureRow(b1, null, info('S造', basement));
    assert.equal(r.kind, STRUCTURE_ROW.BASEMENT);
    assert.equal(r.label, '地階構造');
    assert.equal(r.value, basement);
    assert.deepEqual([...r.options], [...BASEMENT_STRUCTURE_OPTIONS]);
    assert.equal(r.showOverrideToggle, false, '地階では「この階のみ別構造にする」を出さない');
    assert.equal(r.overrideChecked, false);
    assert.equal(r.focusOnMount, false);
  }
});

test('【S5d】地階・上書きなし・地階構造 null（旧データ）: 未設定の行が先頭に付く', () => {
  const r = commonTabStructureRow(b1, null, info('木造（在来）', null));
  assert.equal(r.kind, STRUCTURE_ROW.BASEMENT);
  assert.equal(r.value, BASEMENT_UNSET_LABEL);
  assert.deepEqual([...r.options], [BASEMENT_UNSET_LABEL, ...BASEMENT_STRUCTURE_OPTIONS]);
  assert.equal(r.showOverrideToggle, false);
});

test('【S5d】地階・上書きあり（旧データ）: 「この階の構造」として主構造の選択肢で出し、チェックは入りで外して解除できる', () => {
  const r = commonTabStructureRow(b1, 'S造', info('木造（在来）', RAME));
  assert.equal(r.kind, STRUCTURE_ROW.BASEMENT_OVERRIDE);
  assert.equal(r.label, 'この階の構造');
  assert.equal(r.value, 'S造');
  assert.deepEqual([...r.options], [...MAIN_STRUCTURE_OPTIONS]);
  assert.equal(r.showOverrideToggle, true);
  assert.equal(r.overrideChecked, true);
  assert.equal(r.focusOnMount, false);
});

test('【S5d】地階の判定: 屋根専用平面（-1 を写す）は主構造の行、検討案（-1）と stories 2・startFloor -2 は地階構造の行、plane 無しは主構造の行', () => {
  assert.equal(commonTabStructureRow({ startFloor: -1, stories: 1, isRoofPlane: true }, null, info('S造', RAME)).kind, STRUCTURE_ROW.MAIN);
  assert.equal(commonTabStructureRow({ startFloor: -1, stories: 1, isRoofPlane: false, isAlternative: true }, null, info('S造', RAME)).kind, STRUCTURE_ROW.BASEMENT);
  assert.equal(commonTabStructureRow({ startFloor: -2, stories: 2, isRoofPlane: false }, null, info('S造', RAME)).kind, STRUCTURE_ROW.BASEMENT);
  assert.equal(commonTabStructureRow(null, null, info('S造', RAME)).kind, STRUCTURE_ROW.MAIN);
  assert.equal(commonTabStructureRow(undefined, null, info('S造', RAME)).kind, STRUCTURE_ROW.MAIN);
});

test('【S5d・失敗系】地階構造に選択肢外の値（S造・空文字）が入っていても未設定の行（保存値を信用しない）', () => {
  for (const bad of ['S造', '', 'RC造', 3]) {
    const r = commonTabStructureRow(b1, null, info('S造', bad));
    assert.equal(r.kind, STRUCTURE_ROW.BASEMENT, String(bad));
    assert.equal(r.value, BASEMENT_UNSET_LABEL, String(bad));
    assert.equal(r.options[0], BASEMENT_UNSET_LABEL, String(bad));
  }
});

test('【不変条件】commonInfoTabModel.js は store.js / snap.js / .jsx を静的に import しない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'commonInfoTabModel.js'), 'utf8');
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./structureRules.js']);
});
